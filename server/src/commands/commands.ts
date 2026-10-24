// 命令层：所有写入内核的唯一入口（服务端）。纪律：
// - 只发 spec §4 事件目录内的事件；Task 生命周期迁移一律走 appendStateTransition（内核 guard 判定）；
// - 先做 available_actions 复核（REQ-PJ-1）：不在动作集内 → CommandDeniedError → HTTP 409；
// - client_submit_id 幂等去重（D11 / OQ-07）：命令结果以 `client_id:<id>` 事件落账，
//   同 id 同内容重放返回首次结果（replayed=true），同 id 不同内容 → 409；
// - INV-11：accepted / canceled 的收尾（WaitCondition 取消 + wait_state 归 none）与迁移同事务。
// - 内核不读时间：occurred_at 由注入时钟提供；事件 kind 由上层映射。

import { ulid } from 'ulid';
import type { PgEventStore, PgEventStoreTx } from '../../../src/kernel/event-store-pg.ts';
import { IdempotencyKeyConflictError } from '../../../src/kernel/event-store-pg.ts';
import { asProjectId, type EventEnvelope, type ProjectId } from '../../../src/kernel/events.ts';
import { guardWaitStateChange } from '../../../src/kernel/transition-guard.ts';
import type {
  AcceptanceCriterion,
  CriterionResult,
  DecisionRecord,
  DecisionWakeCondition,
  ProjectionSnapshot,
  ProposalRecord,
  TaskRecord,
} from '../projection/projection.ts';
import { activeHumanRun, computeAvailableActions, COMMAND_TYPES, type CommandType } from '../projection/actions.ts';
import { availableCommands } from '../api/views.ts';
import type { ProjectionService } from '../projection/service.ts';
import type { Proposer } from '../proposers/proposer.ts';

export interface CommandContext {
  store: PgEventStore;
  projection: ProjectionService;
  proposer: Proposer;
  clock: () => Date;
}

export { COMMAND_TYPES, type CommandType };

export class CommandDeniedError extends Error {
  readonly detail: Record<string, unknown>;
  constructor(message: string, detail: Record<string, unknown>) {
    super(message);
    this.name = 'CommandDeniedError';
    this.detail = detail;
  }
}

export class CommandValidationError extends Error {
  readonly detail: Record<string, unknown>;
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CommandValidationError';
    this.detail = detail;
  }
}

/** K1 §3.5：actor 不合规（如裁决命令的非人类 actor）→ HTTP 403。 */
export class CommandForbiddenError extends Error {
  readonly detail: Record<string, unknown>;
  constructor(message: string, detail: Record<string, unknown>) {
    super(message);
    this.name = 'CommandForbiddenError';
    this.detail = detail;
  }
}

/** K1 §3.5：目标实体不存在 → HTTP 404。 */
export class CommandNotFoundError extends Error {
  readonly detail: Record<string, unknown>;
  constructor(message: string, detail: Record<string, unknown>) {
    super(message);
    this.name = 'CommandNotFoundError';
    this.detail = detail;
  }
}

export class IdempotencyConflictError extends Error {
  constructor(client_submit_id: string) {
    super(`client_submit_id=${client_submit_id} 已用于不同内容的命令`);
    this.name = 'IdempotencyConflictError';
  }
}

/** 每个命令都落一条回执事件：类型取封闭目录内的 PlanChangeApplied（payload 带 command + client_submit_id）。 */
const RECEIPT_EVENT_TYPE = 'PlanChangeApplied';

/** 命令回执的机器可读标记（投影据此与真实的 PlanChangeApplied 区分）。 */
export const COMMAND_RECEIPT_TAG = 'command_receipt';

export interface CommandResult {
  command_type: CommandType;
  client_submit_id: string;
  /** true = 幂等重放，未产生新事件 */
  replayed: boolean;
  projection_version: number;
  emitted: Array<{ seq: number; kind: string }>;
  subject: Record<string, unknown>;
  /** 命令体的真实回执事件 id（幂等重放时指向首次回执） */
  receipt_event_id: string;
}

/** 命令执行的内部返回：对外结果 + 本次真正写入的事件信封（供 SSE 广播，免去再读尾部）。 */
export interface CommandExecution {
  result: CommandResult;
  events: EventEnvelope[];
}

export interface CommandActor {
  actor_id: string;
  actor_kind: 'human' | 'agent' | 'system';
}

const UUID_LIKE = /^[A-Za-z0-9:_\-.]{1,128}$/;

function requireClientSubmitId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_LIKE.test(value)) {
    throw new CommandValidationError('client_submit_id 必填，且限 1-128 位 [A-Za-z0-9:_-.]', {
      field: 'client_submit_id',
    });
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CommandValidationError('payload 必须是对象', { field: 'payload' });
  }
  return value as Record<string, unknown>;
}

function requireString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CommandValidationError(`payload.${field} 必填`, { field });
  }
  return value;
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// 命令执行
// ---------------------------------------------------------------------------

export async function runCommand(
  ctx: CommandContext,
  input: { type: string; payload: unknown; client_submit_id: unknown; actor: CommandActor },
): Promise<CommandExecution> {
  const client_submit_id = requireClientSubmitId(input.client_submit_id);
  const payload = asRecord(input.payload);
  const type = input.type as CommandType;

  // 幂等入口：先看该 client_submit_id 是否已有同内容回执（跨进程、跨重启都成立，因为回执在事件流里）
  const existing = await findReceipt(ctx, client_submit_id);
  if (existing !== null) {
    if (existing.command_type !== input.type || existing.fingerprint !== fingerprint(payload)) {
      throw new IdempotencyConflictError(client_submit_id);
    }
    return {
      result: {
        command_type: existing.command_type,
        client_submit_id,
        replayed: true,
        projection_version: ctx.projection.version(),
        emitted: [],
        subject: existing.subject,
        receipt_event_id: existing.event_id,
      },
      events: [],
    };
  }

  switch (type) {
    case 'proposal_accept':
      return acceptProposal(ctx, payload, client_submit_id, input.actor);
    case 'proposal_reject':
      return rejectProposal(ctx, payload, client_submit_id, input.actor);
    case 'task_advance':
      return taskAdvance(ctx, payload, client_submit_id, input.actor);
    case 'feedback_submit':
      return feedbackSubmit(ctx, payload, client_submit_id, input.actor);
    case 'acceptance_record':
      return acceptanceRecord(ctx, payload, client_submit_id, input.actor);
    case 'task_cancel':
      return taskCancel(ctx, payload, client_submit_id, input.actor);
    case 'resolve_decision':
      return resolveDecision(ctx, payload, client_submit_id, input.actor);
    default:
      throw new CommandValidationError(`不支持的命令 type：${String(input.type)}`, {
        field: 'type',
        allowed: ['proposal_accept', 'proposal_reject', 'task_advance', 'feedback_submit', 'acceptance_record', 'task_cancel', 'resolve_decision'],
      });
  }
}

interface Receipt {
  command_type: CommandType;
  fingerprint: string;
  subject: Record<string, unknown>;
  event_id: string;
}

/**
 * 读回执：直接查事件表里的 `client_id:<id>`（事件 store 的 idempotency_key 是 per-stream 的，
 * 跨项目全局去重要靠统一前缀 + 全表查询）。
 * 未见回执但该 id 已被别的写入占用（半提交/别的命令类型）→ 一律 409，绝不重复落第二条命令。
 */
async function findReceipt(ctx: CommandContext, client_submit_id: string): Promise<Receipt | null> {
  const events = await ctx.store
    .replay(0)
    .then((all) => all.filter((e) => e.idempotency_key === `client_id:${client_submit_id}`));
  const receipt = events.find(
    (e) => e.type === RECEIPT_EVENT_TYPE && (e.payload as Record<string, unknown>).command_receipt === COMMAND_RECEIPT_TAG,
  );
  if (!receipt) {
    if (events.length > 0) throw new IdempotencyConflictError(client_submit_id);
    return null;
  }
  const payload = receipt.payload as Record<string, unknown>;
  if (typeof payload.command !== 'string') return null;
  return {
    command_type: payload.command as CommandType,
    fingerprint: typeof payload.request_fingerprint === 'string' ? payload.request_fingerprint : '',
    subject: (payload.subject ?? {}) as Record<string, unknown>,
    event_id: receipt.id,
  };
}

function receiptIdempotencyKey(client_submit_id: string): string {
  return `client_id:${client_submit_id}`;
}

interface EmittedEvent {
  event: EventEnvelope;
}

function addEmitted(list: EmittedEvent[], event: EventEnvelope): void {
  list.push({ event });
}

function newCorrelationId(): string {
  return `corr-${ulid()}`;
}

// ---------------------------------------------------------------------------
// 各命令实现
// ---------------------------------------------------------------------------

type EventBase = {
  stream_id: ProjectId;
  actor_id: string;
  actor_kind: CommandActor['actor_kind'];
  causation_id: string | null;
  correlation_id: string;
};

/**
 * capture_task 型 PlanChange 的应用（任务物化）：TaskCaptured → AssignmentCreated
 * → TaskDefined → captured→defined → PlanChangeApplied。
 * acceptProposal 与 K1-A 的 resolve_decision / deferred 唤起共用同一落图路径，
 * 保证「应用」的事件形态只有一个实现（keyPrefix 区分幂等域）。
 * 返回新建 Task 的 id。
 */
async function materializeCaptureTaskChange(
  tx: PgEventStoreTx,
  base: EventBase,
  proposal: ProposalRecord,
  keyPrefix: string,
  appliedCommand: string,
  now: string,
  emitted: EmittedEvent[],
): Promise<string> {
  const details = proposal.details;
  if (details.kind !== 'capture_task') {
    throw new CommandDeniedError('提议明细不匹配', { reason: 'details_mismatch' });
  }
  const task_id = `task_${ulid()}`;
  const contractRev = 1;

  addEmitted(emitted, await tx.append({
    ...base,
    type: 'TaskCaptured',
    idempotency_key: `${keyPrefix}:captured`,
    payload: {
      task_id,
      title: details.task.title,
      description: details.task.description,
      assignee_kind: details.task.assignee_kind,
      goal_id: null,
      capture_id: proposal.capture_id,
      proposal_id: proposal.proposal_id,
      acceptance_criteria: details.task.acceptance_criteria,
      plan_rev_introduced: proposal.base_plan_rev,
    },
  }));

  // REQ-ASG-1：人类在 UI/API 显式指派（(a) 路径）
  addEmitted(emitted, await tx.append({
    ...base,
    type: 'AssignmentCreated',
    idempotency_key: `${keyPrefix}:assigned`,
    payload: {
      assignment_id: `asg_${ulid()}`,
      task_id,
      actor_id: base.actor_id,
      actor_kind: details.task.assignee_kind,
      role: 'executor',
      scope_note: '',
      assigned_by: base.actor_id,
    },
  }));

  addEmitted(emitted, await tx.append({
    ...base,
    type: 'TaskDefined',
    idempotency_key: `${keyPrefix}:defined`,
    payload: {
      task_id,
      title: details.task.title,
      description: details.task.description,
      contract_rev: contractRev,
      acceptance_criteria: details.task.acceptance_criteria,
      source_proposal_id: proposal.proposal_id,
    },
  }));

  // captured → defined：守卫用 hasTitle / assigneeKind / contractStructured
  addEmitted(emitted, (await tx.appendStateTransition({
    ...base,
    type: 'TaskLifecycleChanged',
    entity: 'task',
    idempotency_key: `${keyPrefix}:lc1`,
    trigger_event_id: `${keyPrefix}:lc1:trigger`,
    from: 'captured',
    to: 'defined',
    facts: {
      hasTitle: details.task.title.trim().length > 0,
      assigneeKind: details.task.assignee_kind,
      contractStructured: details.task.acceptance_criteria.length > 0,
    },
    payload: { task_id },
  })).event);

  addEmitted(emitted, await tx.append({
    ...base,
    type: 'PlanChangeApplied',
    idempotency_key: `${keyPrefix}:applied`,
    payload: {
      change_id: proposal.proposal_id,
      command: appliedCommand,
      task_id,
      base_plan_rev: proposal.base_plan_rev,
      applied_at: now,
    },
  }));

  return task_id;
}

/**
 * 当前计划版本（REQ-PC-1 的 base 复核口径）：服务端没有独立 rev 计数器，
 * 以「1 + 已应用 PlanChange 数」为可判定口径——与种子/捕获流的
 * base_plan_rev=1 起点对齐（首个变更以 rev 1 为 base，应用后 rev 进 2）。
 */
export function currentPlanRev(snapshot: ProjectionSnapshot, project_id: string): number {
  return 1 + snapshot.proposals.filter((p) => p.project_id === project_id && p.status === 'applied').length;
}

async function acceptProposal(
  ctx: CommandContext,
  payload: Record<string, unknown>,
  client_submit_id: string,
  actor: CommandActor,
): Promise<CommandExecution> {
  const now = ctx.clock().toISOString();
  const proposal_id = requireString(payload, 'proposal_id');
  const snapshot = ctx.projection.snapshot();
  const proposal = snapshot.proposals.find((p) => p.proposal_id === proposal_id);
  if (!proposal) throw new CommandDeniedError(`提议 ${proposal_id} 不存在`, { reason: 'proposal_not_found' });
  if (proposal.status !== 'proposed') {
    throw new CommandDeniedError(`提议 ${proposal_id} 当前状态为 ${proposal.status}，不可再接受`, {
      reason: 'proposal_not_proposed',
      status: proposal.status,
    });
  }
  if (proposal.kind !== 'capture_task') {
    throw new CommandDeniedError(`提议 ${proposal_id} 的 kind=${proposal.kind} 不在当前可用动作集，仅 capture_task 可直接接受`, {
      reason: 'not_in_available_actions',
      available: ['accept_proposal:capture_task'],
    });
  }

  // K1-A §3.4 approved_modified 路径：新 Change 以 supersedes_change_id 指向
  // 旧 needs_decision Change 时，同事务把旧 Change 置 rejected
  // （superseded_by_decision）并把其关联 Decision 置 approved_modified。
  const supersedes_change_id = typeof payload.supersedes_change_id === 'string' ? payload.supersedes_change_id : null;
  let superseded: ProposalRecord | null = null;
  let supersededDecision: DecisionRecord | null = null;
  let decisionReason: string | null = null;
  if (supersedes_change_id !== null) {
    superseded = snapshot.proposals.find((p) => p.proposal_id === supersedes_change_id) ?? null;
    if (!superseded || superseded.status !== 'needs_decision') {
      throw new CommandDeniedError(`被取代的变更 ${supersedes_change_id} 不存在或不在 needs_decision 状态`, {
        reason: 'supersede_target_not_needs_decision',
        supersedes_change_id,
        status: superseded?.status ?? null,
      });
    }
    decisionReason = typeof payload.decision_reason === 'string' ? payload.decision_reason : null;
    if (decisionReason === null || decisionReason.trim() === '') {
      throw new CommandValidationError('approved_modified 路径必须带 decision_reason 说明修改点', {
        reason: 'schema_invalid',
        field: 'decision_reason',
      });
    }
    supersededDecision =
      snapshot.decisions.find(
        (d) => d.status === 'pending' && d.subject_ref.kind === 'plan_change' && d.subject_ref.id === supersedes_change_id,
      ) ?? null;
  }

  const emitted: EmittedEvent[] = [];
  const base: EventBase = {
    stream_id: asProjectId(proposal.project_id),
    actor_id: actor.actor_id,
    actor_kind: actor.actor_kind,
    causation_id: null,
    correlation_id: newCorrelationId(),
  };
  const keyPrefix = receiptIdempotencyKey(client_submit_id);
  let task_id = '';

  await ctx.store.withTransaction(async (tx) => {
    task_id = await materializeCaptureTaskChange(tx, base, proposal, keyPrefix, 'proposal_accept', now, emitted);

    if (superseded !== null) {
      addEmitted(emitted, await tx.append({
        ...base,
        type: 'PlanChangeStatusChanged',
        idempotency_key: `${keyPrefix}:superseded`,
        payload: { change_id: superseded.proposal_id, status: 'rejected', reason: 'superseded_by_decision', superseded_by: proposal.proposal_id },
      }));
      if (supersededDecision !== null) {
        addEmitted(emitted, await tx.append({
          ...base,
          type: 'DecisionResolved',
          idempotency_key: `${keyPrefix}:superseded-resolved`,
          payload: {
            decision_id: supersededDecision.decision_id,
            project_id: supersededDecision.project_id,
            verdict: 'approved_modified',
            reason: decisionReason,
            decided_by: actor.actor_id,
            subject_ref: supersededDecision.subject_ref,
            resolved_at: now,
            superseded_by_change_id: proposal.proposal_id,
          },
        }));
      }
    }

    addEmitted(emitted, await tx.append(receipt(base, client_submit_id, 'proposal_accept', payload, { proposal_id, task_id, project_id: proposal.project_id }, now)));
  });

  await ingestProject(ctx, proposal.project_id);
  return finishCommand(ctx, 'proposal_accept', client_submit_id, emitted, { proposal_id, task_id, project_id: proposal.project_id });
}

function receipt(
  base: { stream_id: ProjectId; actor_id: string; actor_kind: 'human' | 'agent' | 'system'; causation_id: string | null; correlation_id: string },
  client_submit_id: string,
  command: CommandType,
  requestPayload: Record<string, unknown>,
  subject: Record<string, unknown>,
  occurred_at: string,
): Parameters<PgEventStoreTx['append']>[0] {
  return {
    ...base,
    type: RECEIPT_EVENT_TYPE,
    idempotency_key: receiptIdempotencyKey(client_submit_id),
    payload: {
      command_receipt: COMMAND_RECEIPT_TAG,
      command,
      client_submit_id,
      request_fingerprint: fingerprint(requestPayload),
      subject,
      applied_at: occurred_at,
    },
  };
}

async function rejectProposal(
  ctx: CommandContext,
  payload: Record<string, unknown>,
  client_submit_id: string,
  actor: CommandActor,
): Promise<CommandExecution> {
  const now = ctx.clock().toISOString();
  const proposal_id = requireString(payload, 'proposal_id');
  const proposal = ctx.projection.snapshot().proposals.find((p) => p.proposal_id === proposal_id);
  if (!proposal) throw new CommandDeniedError(`提议 ${proposal_id} 不存在`, { reason: 'proposal_not_found' });
  if (proposal.status !== 'proposed') {
    throw new CommandDeniedError(`提议 ${proposal_id} 当前状态为 ${proposal.status}，不可拒绝`, {
      reason: 'proposal_not_proposed',
      status: proposal.status,
    });
  }
  const reason = typeof payload.reason === 'string' ? payload.reason : 'user_rejected';
  const emitted: EmittedEvent[] = [];
  const base = {
    stream_id: asProjectId(proposal.project_id),
    actor_id: actor.actor_id,
    actor_kind: actor.actor_kind,
    causation_id: null,
    correlation_id: newCorrelationId(),
  };
  await ctx.store.withTransaction(async (tx) => {
    addEmitted(emitted, await tx.append({
      ...base,
      type: 'PlanChangeRejected',
      idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:rejected`,
      payload: { change_id: proposal_id, reason, rejected_by: actor.actor_id },
    }));
    addEmitted(emitted, await tx.append(receipt(base, client_submit_id, 'proposal_reject', payload, { proposal_id, project_id: proposal.project_id }, now)));
  });
  await ingestProject(ctx, proposal.project_id);
  return finishCommand(ctx, 'proposal_reject', client_submit_id, emitted, { proposal_id, project_id: proposal.project_id });
}

/**
 * task_advance：把任务沿内核矩阵向前推一步（captured→defined→ready→active）。
 * 目标状态必须出现在该 Task 的 available_actions.next 里，否则 409（越权/无前置条件）。
 */
async function taskAdvance(
  ctx: CommandContext,
  payload: Record<string, unknown>,
  client_submit_id: string,
  actor: CommandActor,
): Promise<CommandExecution> {
  const now = ctx.clock().toISOString();
  const task_id = requireString(payload, 'task_id');
  const snapshot = ctx.projection.snapshot();
  const task = snapshot.tasks.find((t) => t.task_id === task_id);
  if (!task) throw new CommandDeniedError(`任务 ${task_id} 不存在`, { reason: 'task_not_found' });

  const actions = computeAvailableActions(task, snapshot, actor.actor_id);
  const advance = actions.find((a) => a.id === 'next_lifecycle');
  if (!advance || !advance.next) {
    throw new CommandDeniedError(`任务 ${task_id} 当前无可用推进动作（lifecycle=${task.lifecycle}，wait_state=${task.wait_state}）`, {
      reason: 'not_in_available_actions',
      task_id,
      lifecycle: task.lifecycle,
      wait_state: task.wait_state,
      available_actions: availableCommands(actions),
    });
  }
  const to = typeof payload.to === 'string' ? payload.to : (advance.next.type === 'task_lifecycle' ? advance.next.to : null);
  if (to === null || to !== advance.next.to) {
    throw new CommandDeniedError(`目标状态 ${String(to)} 不在 available_actions 中（期望 ${advance.next.to}）`, {
      reason: 'not_in_available_actions',
      task_id,
      requested_to: to,
      available_to: advance.next.to,
    });
  }

  const emitted: EmittedEvent[] = [];
  const base: EventBase = {
    stream_id: asProjectId(task.project_id),
    actor_id: actor.actor_id,
    actor_kind: actor.actor_kind,
    causation_id: null,
    correlation_id: newCorrelationId(),
  };
  const from = task.lifecycle;
  const keyPrefix = receiptIdempotencyKey(client_submit_id);
  let dispatchedRunId: string | null = null;
  // K1-B 重新派发：active 的 agent 任务无在飞 Run 时，advance 只新建 Run、不迁移。
  const isRedispatch = from === 'active' && to === 'active';

  await ctx.store.withTransaction(async (tx) => {
    if (isRedispatch) {
      if (task.assignee_kind !== 'agent') {
        throw new CommandDeniedError(`任务 ${task_id} 不是 agent 任务，不可重新派发`, {
          reason: 'not_in_available_actions',
          task_id,
        });
      }
      dispatchedRunId = await createExecutorRun(tx, base, task, snapshot, `${keyPrefix}:run`, payload, actor, emitted);
    }

    if (from === 'defined' && to === 'ready') {
      // ready 判定（REQ-SCH-1 的可判定子集）：wait_state=none ∧ 非疑似重复 ∧ 能力可用（人类在册）
      const liveWait = snapshot.wait_conditions.filter((wc) => wc.task_id === task_id && wc.status === 'active');
      if (liveWait.length > 0 || task.duplicate_suspect) {
        throw new CommandDeniedError(`任务 ${task_id} 不满足 ready 判定`, {
          reason: 'ready_precondition_unmet',
          active_wait_conditions: liveWait.map((wc) => wc.wait_condition_id),
          duplicate_suspect: task.duplicate_suspect,
        });
      }
    }

    if (from === 'ready' && to === 'active' && task.assignee_kind === 'agent') {
      // K1-B 派发：agent 执行者 → executor Run（created → queued），由节点经
      // 长轮询领取（§4）；Task 随迁移进 active，Run 等待节点 ack/started。
      dispatchedRunId = await createExecutorRun(tx, base, task, snapshot, `${keyPrefix}:run`, payload, actor, emitted);
    }

    if (from === 'ready' && to === 'active' && task.assignee_kind !== 'agent') {
      // 派发：人类执行者 → human_light Run（REQ-HUM-1：无租约、无心跳，created → running）
      const run_id = `run_${ulid()}`;
      addEmitted(emitted, await tx.append({
        ...base,
        type: 'RunCreated',
        idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:run-created`,
        payload: {
          run_id,
          task_id,
          run_kind: 'human_light',
          assignment_id: null,
          actor_id: actor.actor_id,
          actor_version: 'k0',
          side_effect_level: 'L0',
          task_rev: 1,
          contract_rev: task.current_contract_rev,
          plan_rev: task.plan_rev_introduced,
          input_snapshot: {
            contract: { rev: task.current_contract_rev, acceptance_criteria: task.acceptance_criteria },
            task: { task_id, title: task.title, description: task.description },
            assembled_by: 'kernel_assembler',
          },
          policy_snapshot: { policy_id: snapshot.projects.find((p) => p.project_id === task.project_id)?.policy_id ?? null },
          idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:run`,
        },
      }));
      addEmitted(emitted, await tx.append({
        ...base,
        type: 'RunStarted',
        idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:run-started`,
        payload: { run_id, started_by: actor.actor_id },
      }));
    }

    // guard facts 与投影动作判定同源：captured→defined 用任务本体事实；
    // defined→ready 补 REQ-SCH-1 全公式（wait/duplicate 已由流派生并在上方复核）；
    // ready→active 的 runDispatched 由本命令先建 Run 满足
    const advanceFacts =
      from === 'captured' && to === 'defined'
        ? {
            hasTitle: task.title.trim().length > 0,
            assigneeKind: task.assignee_kind,
            contractStructured: task.acceptance_criteria.length > 0,
          }
        : from === 'defined' && to === 'ready'
          ? { dependenciesSatisfied: true, dataInputsAvailable: true, capabilityAvailable: true, policyAllows: true }
          : from === 'ready' && to === 'active'
            ? { runDispatched: true }
            : {};
    if (!isRedispatch) {
      addEmitted(emitted, (await tx.appendStateTransition({
        ...base,
        type: 'TaskLifecycleChanged',
        entity: 'task',
        idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:lc`,
        trigger_event_id: `${receiptIdempotencyKey(client_submit_id)}:lc:trigger`,
        from,
        to,
        facts: advanceFacts,
        payload: { task_id },
      })).event);
    }

    addEmitted(emitted, await tx.append(receipt(base, client_submit_id, 'task_advance', payload, {
      task_id,
      from,
      to,
      project_id: task.project_id,
      ...(dispatchedRunId !== null ? { run_id: dispatchedRunId } : {}),
      ...(isRedispatch ? { redispatched: true } : {}),
    }, now)));
  });

  await ingestProject(ctx, task.project_id);
  return finishCommand(ctx, 'task_advance', client_submit_id, emitted, {
    task_id,
    from,
    to,
    project_id: task.project_id,
    ...(dispatchedRunId !== null ? { run_id: dispatchedRunId } : {}),
    ...(isRedispatch ? { redispatched: true } : {}),
  });
}

/**
 * K1-B：新建 executor Run（AssignmentCreated → RunCreated → RunQueued）。
 * executor_kind / side_effect_level 可由命令 payload 覆盖（缺省
 * agent_hands_shell / L1）；input_snapshot 携带任务书与可选 command，
 * 节点据此执行（§4.1 信封由 dispatcher 从 RunCreated 事件组装）。
 */
async function createExecutorRun(
  tx: PgEventStoreTx,
  base: EventBase,
  task: TaskRecord,
  snapshot: ProjectionSnapshot,
  keyPrefix: string,
  payload: Record<string, unknown>,
  actor: CommandActor,
  emitted: EmittedEvent[],
): Promise<string> {
  const run_id = `run_${ulid()}`;
  const assignment_id = `asg_${ulid()}`;
  const executor_kind =
    typeof payload.executor_kind === 'string' && payload.executor_kind.trim() !== ''
      ? payload.executor_kind
      : 'agent_hands_shell';
  const side_effect_level =
    typeof payload.side_effect_level === 'string' && ['L0', 'L1', 'L2', 'L3'].includes(payload.side_effect_level)
      ? payload.side_effect_level
      : 'L1';

  addEmitted(emitted, await tx.append({
    ...base,
    type: 'AssignmentCreated',
    idempotency_key: `${keyPrefix}:assigned`,
    payload: {
      assignment_id,
      task_id: task.task_id,
      actor_id: actor.actor_id,
      actor_kind: 'agent',
      role: 'executor',
      scope_note: '',
      assigned_by: actor.actor_id,
    },
  }));

  addEmitted(emitted, await tx.append({
    ...base,
    type: 'RunCreated',
    idempotency_key: `${keyPrefix}:created`,
    payload: {
      run_id,
      task_id: task.task_id,
      run_kind: 'executor',
      assignment_id,
      actor_id: actor.actor_id,
      actor_version: 'k1',
      executor_kind,
      side_effect_level,
      task_rev: 1,
      contract_rev: task.current_contract_rev,
      plan_rev: task.plan_rev_introduced,
      input_snapshot: {
        contract: { rev: task.current_contract_rev, acceptance_criteria: task.acceptance_criteria },
        task: { task_id: task.task_id, title: task.title, description: task.description },
        command: typeof payload.command === 'string' ? payload.command : null,
        note_side_effect: typeof payload.note_side_effect === 'string' ? payload.note_side_effect : null,
        assembled_by: 'kernel_assembler',
      },
      policy_snapshot: { policy_id: snapshot.projects.find((p) => p.project_id === task.project_id)?.policy_id ?? null },
      idempotency_key: `${keyPrefix}:run`,
    },
  }));

  addEmitted(emitted, await tx.append({
    ...base,
    type: 'RunQueued',
    idempotency_key: `${keyPrefix}:queued`,
    payload: { run_id, executor_kind, side_effect_level },
  }));

  return run_id;
}

/**
 * feedback_submit：人类执行反馈（REQ-HUM-2）。
 * FeedbackReceived（原文先入账，REQ-FB-1）→ FeedbackInterpreted（Outcome Interpreter 提议）
 * → OutcomeRecorded → RunSucceeded → active → awaiting_acceptance。
 * Outcome 只由绑定 human_light Run 的 Feedback 产生（REQ-OC-1 来源限定）。
 */
async function feedbackSubmit(
  ctx: CommandContext,
  payload: Record<string, unknown>,
  client_submit_id: string,
  actor: CommandActor,
): Promise<CommandExecution> {
  const now = ctx.clock().toISOString();
  const task_id = requireString(payload, 'task_id');
  const content = requireString(payload, 'content');
  const snapshot = ctx.projection.snapshot();
  const task = snapshot.tasks.find((t) => t.task_id === task_id);
  if (!task) throw new CommandDeniedError(`任务 ${task_id} 不存在`, { reason: 'task_not_found' });

  const actions = computeAvailableActions(task, snapshot, actor.actor_id);
  const allowed = actions.some((a) => a.id === 'submit_feedback');
  const run = activeHumanRun(snapshot, task_id, actor.actor_id);
  if (!allowed || !run) {
    throw new CommandDeniedError(
      `任务 ${task_id} 当前不接受 ${actor.actor_id} 的执行反馈（lifecycle=${task.lifecycle}，wait_state=${task.wait_state}）`,
      {
        reason: 'not_in_available_actions',
        task_id,
        lifecycle: task.lifecycle,
        wait_state: task.wait_state,
        available_actions: availableCommands(actions),
      },
    );
  }

  // 提议：模型不可用则确定性降级（degraded 透传到事件 + API 响应）
  const { draft, meta } = await ctx.proposer.interpretFeedback({
    taskTitle: task.title,
    feedback: content,
    criteria: task.acceptance_criteria,
  });

  const feedback_id = `fb_${ulid()}`;
  const outcome_id = `out_${ulid()}`;
  const emitted: EmittedEvent[] = [];
  const base = {
    stream_id: asProjectId(task.project_id),
    actor_id: actor.actor_id,
    actor_kind: actor.actor_kind,
    causation_id: null,
    correlation_id: newCorrelationId(),
  };

  await ctx.store.withTransaction(async (tx) => {
    addEmitted(emitted, await tx.append({
      ...base,
      type: 'FeedbackReceived',
      idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:feedback`,
      payload: {
        feedback_id,
        task_id,
        run_id: run.run_id,
        author_id: actor.actor_id,
        raw_content: content,
        raw_attachments: [],
      },
    }));
    addEmitted(emitted, await tx.append({
      ...base,
      type: 'FeedbackInterpreted',
      idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:interpreted`,
      payload: {
        feedback_id,
        run_id: run.run_id,
        interpretation: {
          conclusion_kind: draft.conclusion_kind,
          info_obtained: draft.info_obtained,
          certainty: draft.certainty,
          evidence_sufficiency: draft.evidence_sufficiency,
          blockers: draft.blockers,
          followup_suggestions: draft.followup_suggestions,
          source: draft.source,
          degraded: draft.degraded,
          degraded_reason: draft.degraded_reason,
        },
        interpreted_by: meta.degraded ? 'outcome_interpreter:fallback' : `outcome_interpreter:${meta.model}`,
      },
    }));
    addEmitted(emitted, await tx.append({
      ...base,
      type: 'OutcomeRecorded',
      idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:outcome`,
      payload: {
        outcome_id,
        task_id,
        run_id: run.run_id,
        feedback_id,
        conclusion_kind: draft.conclusion_kind,
        info_obtained: draft.info_obtained,
        certainty: draft.certainty,
        evidence_sufficiency: draft.evidence_sufficiency,
        blockers: draft.blockers,
        followup_suggestions: draft.followup_suggestions,
        interpreted_by: meta.degraded ? 'outcome_interpreter:fallback' : `outcome_interpreter:${meta.model}`,
        proposal_id: `pc_${feedback_id}`,
      },
    }));
    addEmitted(emitted, await tx.append({
      ...base,
      type: 'RunSucceeded',
      idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:run-succeeded`,
      payload: { run_id: run.run_id, outcome_id },
    }));
    addEmitted(emitted, (await tx.appendStateTransition({
      ...base,
      type: 'TaskLifecycleChanged',
      entity: 'task',
      idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:lc`,
      trigger_event_id: `${receiptIdempotencyKey(client_submit_id)}:lc:trigger`,
      from: 'active',
      to: 'awaiting_acceptance',
      payload: { task_id, outcome_id },
    })).event);

    addEmitted(emitted, await tx.append(receipt(base, client_submit_id, 'feedback_submit', payload, {
      task_id,
      feedback_id,
      outcome_id,
      run_id: run.run_id,
      degraded: meta.degraded,
      degraded_reason: meta.degraded_reason,
      project_id: task.project_id,
    }, now)));
  });

  await ingestProject(ctx, task.project_id);
  return finishCommand(ctx, 'feedback_submit', client_submit_id, emitted, {
    task_id,
    feedback_id,
    outcome_id,
    run_id: run.run_id,
    degraded: meta.degraded,
    degraded_reason: meta.degraded_reason,
    project_id: task.project_id,
  });
}

/**
 * acceptance_record：逐判据验收（REQ-ACC-2 入账校验三件套 + REQ-ACC-3 重算）。
 * - 覆盖完整性：契约全部 criterion_ref 必须出现在 criterion_results；
 * - verdict 一致性：全 passed/na → accepted；全 failed → rejected；其余 → partially_accepted；
 * - actor 分离：执行该 Run 的 actor 不得担任 acceptor（K0 单用户下由 self_acceptance 标记诚实记录）。
 */
async function acceptanceRecord(
  ctx: CommandContext,
  payload: Record<string, unknown>,
  client_submit_id: string,
  actor: CommandActor,
): Promise<CommandExecution> {
  const now = ctx.clock().toISOString();
  const task_id = requireString(payload, 'task_id');
  const snapshot = ctx.projection.snapshot();
  const task = snapshot.tasks.find((t) => t.task_id === task_id);
  if (!task) throw new CommandDeniedError(`任务 ${task_id} 不存在`, { reason: 'task_not_found' });

  const actions = computeAvailableActions(task, snapshot, actor.actor_id);
  const acceptanceActions = actions.filter((a) => a.id === 'record_acceptance');
  if (acceptanceActions.length === 0) {
    throw new CommandDeniedError(`任务 ${task_id} 当前不可验收（lifecycle=${task.lifecycle}）`, {
      reason: 'not_in_available_actions',
      task_id,
      lifecycle: task.lifecycle,
    });
  }

  const criteria = task.acceptance_criteria;
  const rawResults = Array.isArray(payload.criterion_results) ? payload.criterion_results : [];
  const results: CriterionResult[] = [];
  const seen = new Set<string>();
  for (const item of rawResults) {
    const entry = asRecord(item);
    const ref = requireString(entry, 'criterion_ref');
    if (seen.has(ref)) throw new CommandValidationError(`criterion_ref ${ref} 重复`, { field: 'criterion_results' });
    seen.add(ref);
    if (!criteria.some((c) => c.criterion_ref === ref)) {
      throw new CommandValidationError(`criterion_ref ${ref} 不在当前契约 rev=${task.current_contract_rev} 中`, {
        field: 'criterion_results',
        allowed: criteria.map((c) => c.criterion_ref),
      });
    }
    const verdict = entry.verdict;
    if (verdict !== 'passed' && verdict !== 'failed' && verdict !== 'not_applicable') {
      throw new CommandValidationError(`criterion_ref ${ref} 的 verdict 非法`, { field: 'criterion_results' });
    }
    results.push({
      criterion_ref: ref,
      verdict,
      evidence_refs: Array.isArray(entry.evidence_refs)
        ? entry.evidence_refs.filter((v): v is string => typeof v === 'string')
        : [],
    });
  }

  // ① 覆盖完整性（新 P1-1①）
  const missing = criteria.map((c) => c.criterion_ref).filter((ref) => !seen.has(ref));
  if (missing.length > 0) {
    throw new CommandValidationError('验收缺少判据（覆盖不完整，内核不入账）', {
      field: 'criterion_results',
      missing_criteria: missing,
    });
  }

  // ② verdict 与逐项结果一致
  const passed = results.filter((r) => r.verdict !== 'failed').length;
  const failed = results.filter((r) => r.verdict === 'failed').length;
  const derived = failed === 0 ? 'accepted' : passed === 0 ? 'rejected' : 'partially_accepted';
  if (payload.verdict !== undefined && payload.verdict !== derived) {
    throw new CommandValidationError(
      `顶层 verdict 与逐判据结果不一致（逐判据推导=${derived}），内核不入账`,
      { field: 'verdict', derived, received: payload.verdict },
    );
  }

  const action = acceptanceActions.find((a) => a.verdict === derived);
  if (!action || !action.next) {
    throw new CommandDeniedError(`逐判据结果推导的 verdict=${derived} 在当前 available_actions 中不可执行`, {
      reason: 'not_in_available_actions',
      derived,
      available: acceptanceActions.map((a) => a.verdict),
    });
  }

  // ③ actor 分离（REQ-ACC-2）：执行该任务的 Run 由本人执行 → 记录 self_acceptance=true（人为验收，非 auto）
  const executedBySelf = snapshot.runs.some((r) => r.task_id === task_id && r.actor_id === actor.actor_id && r.state === 'succeeded');
  const acceptance_id = `acc_${ulid()}`;
  const emitted: EmittedEvent[] = [];
  const base = {
    stream_id: asProjectId(task.project_id),
    actor_id: actor.actor_id,
    actor_kind: actor.actor_kind,
    causation_id: null,
    correlation_id: newCorrelationId(),
  };

  await ctx.store.withTransaction(async (tx) => {
    addEmitted(emitted, await tx.append({
      ...base,
      type: 'AcceptanceRecorded',
      idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:acceptance`,
      payload: {
        acceptance_id,
        task_id,
        contract_rev: task.current_contract_rev,
        subject_outcome_id: task.last_outcome_id,
        acceptor_id: actor.actor_id,
        acceptor_kind: actor.actor_kind,
        verdict: derived,
        criterion_results: results,
        evidence_refs: results.flatMap((r) => r.evidence_refs),
        rationale: typeof payload.rationale === 'string' ? payload.rationale : '',
        self_acceptance: executedBySelf,
        acceptance_mode: 'manual',
      },
    }));

    // INV-11：终态迁移前同事务收尾 active WaitCondition → wait_state=none
    if (derived === 'accepted') {
      for (const wc of snapshot.wait_conditions.filter((w) => w.task_id === task_id && w.status === 'active')) {
        addEmitted(emitted, await tx.append({
          ...base,
          type: 'WaitConditionCanceled',
          idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:wc-${wc.wait_condition_id}`,
          payload: { wait_condition_id: wc.wait_condition_id, task_id, reason: 'task_accepted' },
        }));
      }
      if (task.wait_state !== 'none') {
        addEmitted(emitted, await tx.append({
          ...base,
          type: 'TaskWaitStateChanged',
          idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:ws`,
          payload: { task_id, from: task.wait_state, to: 'none', reason: 'task_accepted (INV-11)' },
        }));
      }
    }

    addEmitted(emitted, (await tx.appendStateTransition({
      ...base,
      type: 'TaskLifecycleChanged',
      entity: 'task',
      idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:lc`,
      trigger_event_id: `${receiptIdempotencyKey(client_submit_id)}:lc:trigger`,
      from: task.lifecycle,
      to: action.next!.to,
      facts: { acceptanceVerdict: derived, needsReexecution: true, allRunsTerminal: true },
      payload: { task_id, acceptance_id },
    })).event);

    addEmitted(emitted, await tx.append(receipt(base, client_submit_id, 'acceptance_record', payload, {
      task_id,
      acceptance_id,
      verdict: derived,
      project_id: task.project_id,
    }, now)));
  });

  await ingestProject(ctx, task.project_id);
  return finishCommand(ctx, 'acceptance_record', client_submit_id, emitted, {
    task_id,
    acceptance_id,
    verdict: derived,
    self_acceptance: executedBySelf,
    project_id: task.project_id,
  });
}

/**
 * task_cancel：REQ-RUN-6。① 记取消意图（TaskCancelRequested）并收尾 active WaitCondition；
 * ② 未启动/人轻量 Run 直接取消；③ 全部 Run 达终态后 lifecycle=canceled。
 */
async function taskCancel(
  ctx: CommandContext,
  payload: Record<string, unknown>,
  client_submit_id: string,
  actor: CommandActor,
): Promise<CommandExecution> {
  const now = ctx.clock().toISOString();
  const task_id = requireString(payload, 'task_id');
  const snapshot = ctx.projection.snapshot();
  const task = snapshot.tasks.find((t) => t.task_id === task_id);
  if (!task) throw new CommandDeniedError(`任务 ${task_id} 不存在`, { reason: 'task_not_found' });

  // 取消命令本身就是 REQ-RUN-6 的第一步（落意图）：新 guard 语义下 cancel_task 动作
  // 要意图已落才出现（见 projection/actions.ts），用动作复核作命令门会自锁；
  // 故此处以终态判定为门，正式迁移仍由内核在落意图后以流派生 facts 复核。
  if (task.lifecycle === 'accepted' || task.lifecycle === 'canceled') {
    throw new CommandDeniedError(`任务 ${task_id} 当前不可取消（lifecycle=${task.lifecycle}）`, {
      reason: 'not_in_available_actions',
      task_id,
      lifecycle: task.lifecycle,
    });
  }

  const liveRuns = snapshot.runs.filter(
    (r) => r.task_id === task_id && ['created', 'queued', 'leased', 'running'].includes(r.state),
  );
  // human_light Run 取消无确认环节，直接置 canceled（REQ-RUN-6②）
  const blocking = liveRuns.filter((r) => r.run_kind !== 'human_light');
  // 对账未结（存在非 human_light 在跑 Run）→ 只记取消意图，不正式置 canceled
  const lifecycleTarget: string | null = blocking.length > 0 ? null : 'canceled';
  const emitted: EmittedEvent[] = [];
  const base = {
    stream_id: asProjectId(task.project_id),
    actor_id: actor.actor_id,
    actor_kind: actor.actor_kind,
    causation_id: null,
    correlation_id: newCorrelationId(),
  };

  await ctx.store.withTransaction(async (tx) => {
    // 重复落意图去重（跨线复审 MINOR-3）：意图已在账时不再重复 append TaskCancelRequested
    // （幂等键随 submit id 变、靠它去重不住）；后续收尾/等待逻辑照常按当前快照推进。
    if (task.cancel_requested_by === null) {
      addEmitted(emitted, await tx.append({
        ...base,
        type: 'TaskCancelRequested',
        idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:cancel-requested`,
        payload: { task_id, requested_by: actor.actor_id, reason: typeof payload.reason === 'string' ? payload.reason : 'user_canceled' },
      }));
    }

    for (const run of liveRuns.filter((r) => r.run_kind === 'human_light')) {
      addEmitted(emitted, await tx.append({
        ...base,
        type: 'RunCanceled',
        idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:run-${run.run_id}`,
        payload: { run_id: run.run_id, reason: 'task_canceled' },
      }));
    }

    if (lifecycleTarget !== null) {
      for (const wc of snapshot.wait_conditions.filter((w) => w.task_id === task_id && w.status === 'active')) {
        addEmitted(emitted, await tx.append({
          ...base,
          type: 'WaitConditionCanceled',
          idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:wc-${wc.wait_condition_id}`,
          payload: { wait_condition_id: wc.wait_condition_id, task_id, reason: 'task_canceled' },
        }));
      }
      if (task.wait_state !== 'none') {
        addEmitted(emitted, await tx.append({
          ...base,
          type: 'TaskWaitStateChanged',
          idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:ws`,
          payload: { task_id, from: task.wait_state, to: 'none', reason: 'task_canceled (INV-11)' },
        }));
      }
      const transition = await tx.appendStateTransition({
        ...base,
        type: 'TaskLifecycleChanged',
        entity: 'task',
        idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:lc`,
        trigger_event_id: `${receiptIdempotencyKey(client_submit_id)}:lc:trigger`,
        from: task.lifecycle,
        to: 'canceled',
        facts: { allRunsTerminal: true },
        payload: { task_id },
      });
      addEmitted(emitted, transition.event);
      // MAJOR-1（跨线复审）：迁入 canceled 时内核已在同事务落 TaskCanceled（F2 收尾），
      // 命令层不得再手动补发（否则流内重复 2 条）；把内核收尾事件并入 emitted，响应口径不变。
      const taskCanceledEventId = transition.closure?.task_canceled_event_id ?? null;
      if (taskCanceledEventId !== null) {
        const stream = await tx.readStream(asProjectId(task.project_id), 1);
        const taskCanceled = stream.find((e) => e.id === taskCanceledEventId);
        if (taskCanceled) addEmitted(emitted, taskCanceled);
      }
    }

    addEmitted(emitted, await tx.append(receipt(base, client_submit_id, 'task_cancel', payload, {
      task_id,
      lifecycle: lifecycleTarget ?? task.lifecycle,
      cancel_requested: true,
      awaiting_run_termination: blocking.map((r) => r.run_id),
      project_id: task.project_id,
    }, now)));
  });

  await ingestProject(ctx, task.project_id);
  return finishCommand(ctx, 'task_cancel', client_submit_id, emitted, {
    task_id,
    lifecycle: lifecycleTarget ?? task.lifecycle,
    cancel_requested: true,
    awaiting_run_termination: blocking.map((r) => r.run_id),
    project_id: task.project_id,
  });
}

/**
 * resolve_decision（K1-A §3.2）：人类裁决一条 pending Decision。
 * 处理顺序固定：actor（非 human → 403）→ 存在性（404）→ 状态（expired →
 * 409 decision_expired；已裁决 → 409 terminal_state 带当前状态）→ 入参
 * （400 schema_invalid 字段级）→ 落盘。落盘 = DecisionResolved（唯一审计
 * 记录）+ §3.4 效果，同事务。幂等由 runCommand 的回执层先行处理（重放
 * 返回首次结果、零新事件），故本函数只处理首次执行。
 */
async function resolveDecision(
  ctx: CommandContext,
  payload: Record<string, unknown>,
  client_submit_id: string,
  actor: CommandActor,
): Promise<CommandExecution> {
  const now = ctx.clock().toISOString();
  if (actor.actor_kind !== 'human') {
    throw new CommandForbiddenError('裁决是人类-only 动作', {
      reason: 'actor_not_human',
      actor_kind: actor.actor_kind,
    });
  }
  const decision_id = requireString(payload, 'decision_id');
  const snapshot = ctx.projection.snapshot();
  const decision = snapshot.decisions.find((d) => d.decision_id === decision_id);
  if (!decision) {
    throw new CommandNotFoundError(`Decision ${decision_id} 不存在`, { reason: 'not_found', decision_id });
  }
  if (decision.status === 'expired') {
    throw new CommandDeniedError(`Decision ${decision_id} 已过期，裁决不产生任何效果`, {
      reason: 'decision_expired',
      decision_id,
      status: decision.status,
      decided_by: decision.decided_by,
      decided_at: decision.decided_at,
    });
  }
  if (decision.status !== 'pending') {
    throw new CommandDeniedError(`Decision ${decision_id} 已裁决（status=${decision.status}）`, {
      reason: 'terminal_state',
      decision_id,
      status: decision.status,
      decided_by: decision.decided_by,
      decided_at: decision.decided_at,
    });
  }

  const verdict = payload.verdict;
  if (verdict !== 'approved' && verdict !== 'rejected' && verdict !== 'deferred') {
    throw new CommandValidationError('verdict 必须是 approved / rejected / deferred（approved_modified 不走本命令）', {
      reason: 'schema_invalid',
      field: 'verdict',
    });
  }
  const reason = typeof payload.reason === 'string' ? payload.reason : null;
  if (verdict === 'rejected' && (reason === null || reason.trim() === '')) {
    throw new CommandValidationError('verdict=rejected 时 reason 必填非空', { reason: 'schema_invalid', field: 'reason' });
  }
  const wake = verdict === 'deferred' ? parseWakeCondition(payload.wake_condition) : null;

  const subjectKind = decision.subject_ref.kind;
  if (!['plan_change', 'run_reconciliation', 'duplicate_suspect'].includes(subjectKind)) {
    throw new CommandDeniedError(`subject 类型 ${subjectKind} 在 K1 无已写明的裁决出路`, {
      reason: 'subject_not_resolvable_in_k1',
      decision_id,
      subject_kind: subjectKind,
    });
  }

  // subject 前置校验（效果落盘前完成，失败零事件）
  let change: ProposalRecord | null = null;
  let runTask: TaskRecord | null = null;
  let runState: string | null = null;
  let suspectTask: TaskRecord | null = null;
  if (subjectKind === 'plan_change') {
    change = snapshot.proposals.find((p) => p.proposal_id === decision.subject_ref.id) ?? null;
    if (!change) {
      throw new CommandDeniedError(`Decision ${decision_id} 指向的 PlanChange ${decision.subject_ref.id} 不存在`, {
        reason: 'subject_not_resolvable_in_k1',
        decision_id,
        subject_kind: subjectKind,
      });
    }
  }
  if (subjectKind === 'run_reconciliation') {
    const run = snapshot.runs.find((r) => r.run_id === decision.subject_ref.id);
    if (!run) {
      throw new CommandDeniedError(`Decision ${decision_id} 指向的 Run ${decision.subject_ref.id} 不存在`, {
        reason: 'subject_not_resolvable_in_k1',
        decision_id,
        subject_kind: subjectKind,
      });
    }
    runState = run.state;
    runTask = snapshot.tasks.find((t) => t.task_id === run.task_id) ?? null;
    if (verdict === 'approved' && run.state !== 'indeterminate') {
      throw new CommandDeniedError(`Run ${run.run_id} 当前状态为 ${run.state}，不处于待对账（indeterminate）`, {
        reason: 'precondition_unmet',
        decision_id,
        run_id: run.run_id,
        run_state: run.state,
      });
    }
  }
  let disposition: 'executed' | 'not_executed' | 'cancel_run' | null = null;
  if (subjectKind === 'run_reconciliation' && verdict === 'approved') {
    const d = payload.disposition;
    if (d !== 'executed' && d !== 'not_executed' && d !== 'cancel_run') {
      throw new CommandValidationError('Run 对账 verdict=approved 时 disposition 必填且必须是 executed / not_executed / cancel_run', {
        reason: 'schema_invalid',
        field: 'disposition',
      });
    }
    disposition = d;
  }
  if (subjectKind === 'duplicate_suspect') {
    suspectTask = snapshot.tasks.find((t) => t.task_id === decision.subject_ref.id) ?? null;
    if (!suspectTask) {
      throw new CommandDeniedError(`Decision ${decision_id} 指向的 Task ${decision.subject_ref.id} 不存在`, {
        reason: 'subject_not_resolvable_in_k1',
        decision_id,
        subject_kind: subjectKind,
      });
    }
    if (verdict !== 'deferred' && !suspectTask.duplicate_suspect) {
      throw new CommandDeniedError(`Task ${suspectTask.task_id} 已不在疑似重复状态`, {
        reason: 'precondition_unmet',
        decision_id,
        task_id: suspectTask.task_id,
      });
    }
  }

  // executed 处置需先经 Outcome Interpreter 提议（事务外，网络调用不进事务）
  let outcomeDraft: Awaited<ReturnType<Proposer['interpretFeedback']>> | null = null;
  if (subjectKind === 'run_reconciliation' && disposition === 'executed' && runTask !== null) {
    outcomeDraft = await ctx.proposer.interpretFeedback({
      taskTitle: runTask.title,
      feedback: decision.question,
      criteria: runTask.acceptance_criteria,
    });
  }

  const emitted: EmittedEvent[] = [];
  const base: EventBase = {
    stream_id: asProjectId(decision.project_id),
    actor_id: actor.actor_id,
    actor_kind: actor.actor_kind,
    causation_id: null,
    correlation_id: newCorrelationId(),
  };
  const keyPrefix = receiptIdempotencyKey(client_submit_id);
  const subject: Record<string, unknown> = {
    decision_id,
    project_id: decision.project_id,
    verdict,
    subject_ref: decision.subject_ref,
  };

  await ctx.store.withTransaction(async (tx) => {
    // §3.3：DecisionResolved 是裁决事实的唯一审计记录，先行落盘。
    const resolved = await tx.append({
      ...base,
      type: 'DecisionResolved',
      idempotency_key: `${keyPrefix}:resolved`,
      payload: {
        decision_id,
        project_id: decision.project_id,
        verdict,
        reason,
        decided_by: actor.actor_id,
        subject_ref: decision.subject_ref,
        resolved_at: now,
        ...(wake !== null ? { wake_condition: wake } : {}),
        ...(disposition !== null ? { disposition } : {}),
      },
    });
    addEmitted(emitted, resolved);

    if (subjectKind === 'plan_change' && change !== null) {
      await applyDecisionToPlanChange(tx, base, keyPrefix, decision, change, verdict, snapshot, now, emitted, subject);
    }
    if (subjectKind === 'run_reconciliation' && disposition !== null && runTask !== null) {
      await applyDecisionToRunReconciliation(
        tx, base, keyPrefix, decision, runTask, verdict, disposition, outcomeDraft, resolved.id, snapshot, now, emitted, subject,
      );
    }
    if (subjectKind === 'duplicate_suspect' && suspectTask !== null) {
      await applyDecisionToDuplicate(tx, base, keyPrefix, decision, suspectTask, verdict, snapshot, actor, emitted, subject);
    }

    addEmitted(emitted, await tx.append(receipt(base, client_submit_id, 'resolve_decision', payload, subject, now)));
  });

  await ingestProject(ctx, decision.project_id);
  return finishCommand(ctx, 'resolve_decision', client_submit_id, emitted, subject);
}

/** deferred 的唤起条件校验（§3.2：必填；at_time 须带 at，on_event 须带 event_type）。 */
function parseWakeCondition(value: unknown): DecisionWakeCondition {
  const invalid = (): CommandValidationError =>
    new CommandValidationError('verdict=deferred 时 wake_condition 必填：{kind:"at_time", at} 或 {kind:"on_event", event_type}', {
      reason: 'schema_invalid',
      field: 'wake_condition',
    });
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  if (record.kind === 'at_time') {
    if (typeof record.at !== 'string' || Number.isNaN(Date.parse(record.at))) throw invalid();
    return { kind: 'at_time', at: record.at, event_type: null };
  }
  if (record.kind === 'on_event') {
    if (typeof record.event_type !== 'string' || record.event_type.trim() === '') throw invalid();
    return { kind: 'on_event', at: null, event_type: record.event_type };
  }
  throw invalid();
}

/** PlanChange 应用（§3.4 approved）：capture_task 走任务物化，其余 kind 走通用应用；均补 PlanRevisionCreated。 */
export async function applyPlanChangeForDecision(
  tx: PgEventStoreTx,
  base: EventBase,
  keyPrefix: string,
  change: ProposalRecord,
  appliedCommand: string,
  currentRev: number,
  now: string,
  emitted: EmittedEvent[],
): Promise<string | null> {
  let taskId: string | null = null;
  if (change.kind === 'capture_task' && change.details.kind === 'capture_task') {
    taskId = await materializeCaptureTaskChange(tx, base, change, keyPrefix, appliedCommand, now, emitted);
  } else {
    addEmitted(emitted, await tx.append({
      ...base,
      type: 'PlanChangeApplied',
      idempotency_key: `${keyPrefix}:applied`,
      payload: { change_id: change.proposal_id, command: appliedCommand, applied_at: now },
    }));
  }
  addEmitted(emitted, await tx.append({
    ...base,
    type: 'PlanRevisionCreated',
    idempotency_key: `${keyPrefix}:revision`,
    payload: { change_id: change.proposal_id, plan_rev: currentRev + 1, base_plan_rev: change.base_plan_rev, ops: change.ops },
  }));
  return taskId;
}

/** §3.4 PlanChange 行：approved 重走 REQ-PC-1 base 复核；rejected 置 decision_rejected；deferred 无即时效果。 */
async function applyDecisionToPlanChange(
  tx: PgEventStoreTx,
  base: EventBase,
  keyPrefix: string,
  decision: DecisionRecord,
  change: ProposalRecord,
  verdict: 'approved' | 'rejected' | 'deferred',
  snapshot: ProjectionSnapshot,
  now: string,
  emitted: EmittedEvent[],
  subject: Record<string, unknown>,
): Promise<void> {
  if (verdict === 'rejected') {
    addEmitted(emitted, await tx.append({
      ...base,
      type: 'PlanChangeStatusChanged',
      idempotency_key: `${keyPrefix}:change-rejected`,
      payload: { change_id: change.proposal_id, status: 'rejected', reason: 'decision_rejected' },
    }));
    return;
  }
  if (verdict !== 'approved') return;

  const currentRev = currentPlanRev(snapshot, decision.project_id);
  if (change.base_plan_rev !== currentRev) {
    // base_rev_conflict 不是命令失败：生成新 pending Decision，原样维持 needs_decision（§3.5）。
    const followUpId = `dec_${ulid()}`;
    addEmitted(emitted, await tx.append({
      ...base,
      type: 'DecisionCreated',
      idempotency_key: `${keyPrefix}:follow-up`,
      payload: {
        decision_id: followUpId,
        subject_ref: { kind: 'plan_change', id: change.proposal_id },
        question: `计划变更 ${change.proposal_id} 的基线版本已变化（base_rev_conflict：申报 base=${change.base_plan_rev}，当前=${currentRev}），请基于当前版本重新裁决`,
        recommendation: '基于当前计划版本重新审阅该变更后再次裁决',
        alternatives: [],
        evidence_refs: [`base_rev:${change.base_plan_rev}`, `current_rev:${currentRev}`],
        follow_up_of: decision.decision_id,
        created_by: 'system',
      },
    }));
    subject.follow_up_decision_id = followUpId;
    return;
  }

  const taskId = await applyPlanChangeForDecision(tx, base, keyPrefix, change, 'resolve_decision', currentRev, now, emitted);
  subject.applied_task_id = taskId;
  subject.plan_rev = currentRev + 1;
}

/** §3.4 Run 对账行：按 disposition 补录 Outcome 流 / 置 failed / 置 canceled 并推进挂起取消。 */
async function applyDecisionToRunReconciliation(
  tx: PgEventStoreTx,
  base: EventBase,
  keyPrefix: string,
  decision: DecisionRecord,
  task: TaskRecord,
  verdict: 'approved' | 'rejected' | 'deferred',
  disposition: 'executed' | 'not_executed' | 'cancel_run' | null,
  outcomeDraft: Awaited<ReturnType<Proposer['interpretFeedback']>> | null,
  resolvedEventId: string,
  snapshot: ProjectionSnapshot,
  now: string,
  emitted: EmittedEvent[],
  subject: Record<string, unknown>,
): Promise<void> {
  if (verdict !== 'approved' || disposition === null) return; // rejected/deferred：维持 indeterminate，无效果事件
  const run_id = decision.subject_ref.id;

  if (disposition === 'executed') {
    if (outcomeDraft === null) throw new Error('executed 处置缺少 Outcome 提议（内部错误）');
    const { draft, meta } = outcomeDraft;
    const outcome_id = `out_${ulid()}`;
    addEmitted(emitted, await tx.append({
      ...base,
      type: 'OutcomeRecorded',
      idempotency_key: `${keyPrefix}:outcome`,
      payload: {
        outcome_id,
        task_id: task.task_id,
        run_id,
        feedback_id: null,
        conclusion_kind: draft.conclusion_kind,
        info_obtained: draft.info_obtained,
        certainty: draft.certainty,
        evidence_sufficiency: draft.evidence_sufficiency,
        blockers: draft.blockers,
        followup_suggestions: draft.followup_suggestions,
        interpreted_by: meta.degraded ? 'outcome_interpreter:fallback' : `outcome_interpreter:${meta.model}`,
        proposal_id: `pc_dec_${decision.decision_id}`,
        reconciled_decision_id: decision.decision_id,
      },
    }));
    addEmitted(emitted, (await tx.appendStateTransition({
      ...base,
      type: 'RunSucceeded',
      entity: 'run',
      idempotency_key: `${keyPrefix}:run-succeeded`,
      trigger_event_id: resolvedEventId,
      from: 'indeterminate',
      to: 'succeeded',
      facts: { reconciliation: 'completed' },
      payload: { run_id, outcome_id },
    })).event);
    if (task.lifecycle === 'active') {
      addEmitted(emitted, (await tx.appendStateTransition({
        ...base,
        type: 'TaskLifecycleChanged',
        entity: 'task',
        idempotency_key: `${keyPrefix}:lc`,
        trigger_event_id: resolvedEventId,
        from: 'active',
        to: 'awaiting_acceptance',
        facts: { runOutcomeRecorded: true },
        payload: { task_id: task.task_id, outcome_id },
      })).event);
    }
    subject.outcome_id = outcome_id;
    return;
  }

  if (disposition === 'not_executed') {
    addEmitted(emitted, (await tx.appendStateTransition({
      ...base,
      type: 'RunFailed',
      entity: 'run',
      idempotency_key: `${keyPrefix}:run-failed`,
      trigger_event_id: resolvedEventId,
      from: 'indeterminate',
      to: 'failed',
      facts: { reconciliation: 'not_executed' },
      payload: { run_id, reason: 'reconciled_not_executed' },
    })).event);
    return;
  }

  // cancel_run：Run 置 canceled；若该 Task 有挂起的取消意图且其余 Run 全终态，推进 REQ-RUN-6 第③步。
  addEmitted(emitted, (await tx.appendStateTransition({
    ...base,
    type: 'RunCanceled',
    entity: 'run',
    idempotency_key: `${keyPrefix}:run-canceled`,
    trigger_event_id: resolvedEventId,
    from: 'indeterminate',
    to: 'canceled',
    facts: { reconciliationConcluded: true },
    payload: { run_id, reason: 'reconciled_cancel_run' },
  })).event);
  if (task.cancel_requested_by !== null && task.lifecycle !== 'accepted' && task.lifecycle !== 'canceled') {
    const othersLive = snapshot.runs.some(
      (r) =>
        r.task_id === task.task_id &&
        r.run_id !== run_id &&
        ['created', 'queued', 'leased', 'running', 'indeterminate'].includes(r.state),
    );
    if (!othersLive) {
      for (const wc of snapshot.wait_conditions.filter((w) => w.task_id === task.task_id && w.status === 'active')) {
        addEmitted(emitted, await tx.append({
          ...base,
          type: 'WaitConditionCanceled',
          idempotency_key: `${keyPrefix}:wc-${wc.wait_condition_id}`,
          payload: { wait_condition_id: wc.wait_condition_id, task_id: task.task_id, reason: 'task_canceled' },
        }));
      }
      if (task.wait_state !== 'none') {
        addEmitted(emitted, await tx.append({
          ...base,
          type: 'TaskWaitStateChanged',
          idempotency_key: `${keyPrefix}:ws`,
          payload: { task_id: task.task_id, from: task.wait_state, to: 'none', reason: 'task_canceled (INV-11)' },
        }));
      }
      const transition = await tx.appendStateTransition({
        ...base,
        type: 'TaskLifecycleChanged',
        entity: 'task',
        idempotency_key: `${keyPrefix}:lc`,
        trigger_event_id: resolvedEventId,
        from: task.lifecycle,
        to: 'canceled',
        facts: { allRunsTerminal: true },
        payload: { task_id: task.task_id },
      });
      addEmitted(emitted, transition.event);
      const taskCanceledEventId = transition.closure?.task_canceled_event_id ?? null;
      if (taskCanceledEventId !== null) {
        const stream = await tx.readStream(asProjectId(task.project_id), 1);
        const taskCanceled = stream.find((e) => e.id === taskCanceledEventId);
        if (taskCanceled) addEmitted(emitted, taskCanceled);
      }
      subject.task_canceled = true;
    }
  }
}

/** §3.4 疑似重复行：approved 级联取消（REQ-RUN-6，原因 duplicate_merged）；rejected 放行恢复。 */
async function applyDecisionToDuplicate(
  tx: PgEventStoreTx,
  base: EventBase,
  keyPrefix: string,
  decision: DecisionRecord,
  task: TaskRecord,
  verdict: 'approved' | 'rejected' | 'deferred',
  snapshot: ProjectionSnapshot,
  actor: CommandActor,
  emitted: EmittedEvent[],
  subject: Record<string, unknown>,
): Promise<void> {
  if (verdict === 'deferred') return; // 维持挂起 + 唤起条件（已在 DecisionResolved 落账）
  if (verdict === 'rejected') {
    addEmitted(emitted, await tx.append({
      ...base,
      type: 'TaskDuplicateResolved',
      idempotency_key: `${keyPrefix}:duplicate-resolved`,
      payload: { task_id: task.task_id, duplicate_of: decision.duplicate_of, resolved_by: actor.actor_id },
    }));
    return;
  }

  // approved = 确认重复并合并
  const liveRuns = snapshot.runs.filter(
    (r) => r.task_id === task.task_id && ['created', 'queued', 'leased', 'running'].includes(r.state),
  );
  const blocking = liveRuns.filter((r) => r.run_kind !== 'human_light');
  if (task.cancel_requested_by === null) {
    addEmitted(emitted, await tx.append({
      ...base,
      type: 'TaskCancelRequested',
      idempotency_key: `${keyPrefix}:cancel-requested`,
      payload: { task_id: task.task_id, requested_by: actor.actor_id, reason: 'duplicate_merged', duplicate_of: decision.duplicate_of },
    }));
  }
  for (const run of liveRuns.filter((r) => r.run_kind === 'human_light')) {
    addEmitted(emitted, await tx.append({
      ...base,
      type: 'RunCanceled',
      idempotency_key: `${keyPrefix}:run-${run.run_id}`,
      payload: { run_id: run.run_id, reason: 'duplicate_merged' },
    }));
  }
  if (blocking.length > 0) {
    // executor Run 在飞：只落取消意图，正式取消等 Run 终态后由取消链推进（如实标注，不假装已合并）。
    subject.cascade = 'awaiting_run_termination';
    subject.awaiting_run_termination = blocking.map((r) => r.run_id);
    return;
  }
  for (const wc of snapshot.wait_conditions.filter((w) => w.task_id === task.task_id && w.status === 'active')) {
    addEmitted(emitted, await tx.append({
      ...base,
      type: 'WaitConditionCanceled',
      idempotency_key: `${keyPrefix}:wc-${wc.wait_condition_id}`,
      payload: { wait_condition_id: wc.wait_condition_id, task_id: task.task_id, reason: 'duplicate_merged' },
    }));
  }
  if (task.wait_state !== 'none') {
    addEmitted(emitted, await tx.append({
      ...base,
      type: 'TaskWaitStateChanged',
      idempotency_key: `${keyPrefix}:ws`,
      payload: { task_id: task.task_id, from: task.wait_state, to: 'none', reason: 'duplicate_merged' },
    }));
  }
  const transition = await tx.appendStateTransition({
    ...base,
    type: 'TaskLifecycleChanged',
    entity: 'task',
    idempotency_key: `${keyPrefix}:lc`,
    trigger_event_id: `${keyPrefix}:lc:trigger`,
    from: task.lifecycle,
    to: 'canceled',
    facts: { allRunsTerminal: true },
    payload: { task_id: task.task_id, reason: 'duplicate_merged', duplicate_of: decision.duplicate_of },
  });
  addEmitted(emitted, transition.event);
  const taskCanceledEventId = transition.closure?.task_canceled_event_id ?? null;
  if (taskCanceledEventId !== null) {
    const stream = await tx.readStream(asProjectId(task.project_id), 1);
    const taskCanceled = stream.find((e) => e.id === taskCanceledEventId);
    if (taskCanceled) addEmitted(emitted, taskCanceled);
  }
  subject.cascade = 'completed';
  subject.merged_into = decision.duplicate_of;
}

// ---------------------------------------------------------------------------
// 写入后并把事件并入投影。
//
// 不能只 readStream(project_id)：global_seq 是全局序号，其它 project 流先提交时会留洞，
// 而投影水位必须连续推进（否则 apply 会判乱序）。这里读全局尾部再按 global_seq 排序并入。
// ---------------------------------------------------------------------------

async function ingestAll(ctx: CommandContext): Promise<EventEnvelope[]> {
  const current = ctx.projection.version();
  const events = (await ctx.store.replay(current)).filter((event) => event.global_seq > current);
  ctx.projection.ingest(events);
  return events;
}

async function ingestProject(ctx: CommandContext, _project_id: string): Promise<void> {
  await ingestAll(ctx);
}

function finishCommand(
  ctx: CommandContext,
  command_type: CommandType,
  client_submit_id: string,
  emitted: EmittedEvent[],
  subject: Record<string, unknown>,
): CommandExecution {
  return {
    result: {
      command_type,
      client_submit_id,
      replayed: false,
      projection_version: ctx.projection.version(),
      emitted: emitted.map(({ event }) => ({ seq: event.global_seq, kind: event.type })),
      subject,
      receipt_event_id: emitted[emitted.length - 1]!.event.id,
    },
    events: emitted.map(({ event }) => event),
  };
}

/** 供种子脚本与测试复用的 Task 查找。 */
export function findTask(snapshot: ProjectionSnapshot, task_id: string): TaskRecord | undefined {
  return snapshot.tasks.find((task) => task.task_id === task_id);
}

export type { AcceptanceCriterion, IdempotencyKeyConflictError };
