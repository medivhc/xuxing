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
import type { EventEnvelope } from '../../../src/kernel/events.ts';
import { guardWaitStateChange } from '../../../src/kernel/transition-guard.ts';
import type { AcceptanceCriterion, CriterionResult, ProjectionSnapshot, TaskRecord } from '../projection/projection.ts';
import { activeHumanRun, computeAvailableActions } from '../projection/actions.ts';
import type { ProjectionService } from '../projection/service.ts';
import type { Proposer } from '../proposers/proposer.ts';

export interface CommandContext {
  store: PgEventStore;
  projection: ProjectionService;
  proposer: Proposer;
  clock: () => Date;
}

export type CommandType =
  | 'proposal_accept'
  | 'proposal_reject'
  | 'task_advance'
  | 'feedback_submit'
  | 'acceptance_record'
  | 'task_cancel';

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
    default:
      throw new CommandValidationError(`不支持的命令 type：${String(input.type)}`, {
        field: 'type',
        allowed: ['proposal_accept', 'proposal_reject', 'task_advance', 'feedback_submit', 'acceptance_record', 'task_cancel'],
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

  const task_id = `task_${ulid()}`;
  const emitted: EmittedEvent[] = [];
  const correlation_id = newCorrelationId();
  const base = {
    stream_id: proposal.project_id,
    actor_id: actor.actor_id,
    actor_kind: actor.actor_kind,
    causation_id: null,
    correlation_id,
  };
  const details = proposal.details;
  if (details.kind !== 'capture_task') throw new CommandDeniedError('提议明细不匹配', { reason: 'details_mismatch' });
  const contractRev = 1;

  await ctx.store.withTransaction(async (tx) => {
    addEmitted(emitted, await tx.append({
      ...base,
      type: 'TaskCaptured',
      idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:captured`,
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
      idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:assigned`,
      payload: {
        assignment_id: `asg_${ulid()}`,
        task_id,
        actor_id: actor.actor_id,
        actor_kind: details.task.assignee_kind,
        role: 'executor',
        scope_note: '',
        assigned_by: actor.actor_id,
      },
    }));

    addEmitted(emitted, await tx.append({
      ...base,
      type: 'TaskDefined',
      idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:defined`,
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
      idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:lc1`,
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
      idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:applied`,
      payload: {
        change_id: proposal.proposal_id,
        command: 'proposal_accept',
        task_id,
        base_plan_rev: proposal.base_plan_rev,
        applied_at: ctx.clock().toISOString(),
      },
    }));

    addEmitted(emitted, await tx.append(receipt(base, client_submit_id, 'proposal_accept', payload, { proposal_id, task_id, project_id: proposal.project_id }, now)));
  });

  await ingestProject(ctx, proposal.project_id);
  return finishCommand(ctx, 'proposal_accept', client_submit_id, emitted, { proposal_id, task_id, project_id: proposal.project_id });
}

function receipt(
  base: { stream_id: string; actor_id: string; actor_kind: 'human' | 'agent' | 'system'; causation_id: string | null; correlation_id: string },
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
    stream_id: proposal.project_id,
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
      available_actions: actions.map((a) => a.id),
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
  const base = {
    stream_id: task.project_id,
    actor_id: actor.actor_id,
    actor_kind: actor.actor_kind,
    causation_id: null,
    correlation_id: newCorrelationId(),
  };
  const from = task.lifecycle;

  await ctx.store.withTransaction(async (tx) => {
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

    if (from === 'ready' && to === 'active') {
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

    addEmitted(emitted, (await tx.appendStateTransition({
      ...base,
      type: 'TaskLifecycleChanged',
      entity: 'task',
      idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:lc`,
      from,
      to,
      payload: { task_id },
    })).event);

    addEmitted(emitted, await tx.append(receipt(base, client_submit_id, 'task_advance', payload, { task_id, from, to, project_id: task.project_id }, now)));
  });

  await ingestProject(ctx, task.project_id);
  return finishCommand(ctx, 'task_advance', client_submit_id, emitted, { task_id, from, to, project_id: task.project_id });
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
        available_actions: actions.map((a) => a.id),
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
    stream_id: task.project_id,
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
    stream_id: task.project_id,
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

  const actions = computeAvailableActions(task, snapshot, actor.actor_id);
  const cancel = actions.find((a) => a.id === 'cancel_task');
  if (!cancel || !cancel.next) {
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
  const lifecycleTarget: string | null = blocking.length > 0 ? null : cancel.next.to;
  const emitted: EmittedEvent[] = [];
  const base = {
    stream_id: task.project_id,
    actor_id: actor.actor_id,
    actor_kind: actor.actor_kind,
    causation_id: null,
    correlation_id: newCorrelationId(),
  };

  await ctx.store.withTransaction(async (tx) => {
    addEmitted(emitted, await tx.append({
      ...base,
      type: 'TaskCancelRequested',
      idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:cancel-requested`,
      payload: { task_id, requested_by: actor.actor_id, reason: typeof payload.reason === 'string' ? payload.reason : 'user_canceled' },
    }));

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
      addEmitted(emitted, (await tx.appendStateTransition({
        ...base,
        type: 'TaskLifecycleChanged',
        entity: 'task',
        idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:lc`,
        from: task.lifecycle,
        to: 'canceled',
        facts: { allRunsTerminal: true },
        payload: { task_id },
      })).event);
      addEmitted(emitted, await tx.append({
        ...base,
        type: 'TaskCanceled',
        idempotency_key: `${receiptIdempotencyKey(client_submit_id)}:canceled`,
        payload: { task_id, reason: 'task_canceled' },
      }));
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
