// 事件投影（CQRS 读模型）—— 状态一律由事件派生（任务书红线：界面/投影状态一律由事件投影派生）。
//
// 设计约束：
// - 纯函数式：apply(event) 只吃事件信封，不读库、不读时钟、不读随机源；
//   replay(0) 全量重演即可重建同一份快照（与内核 C5 口径一致）；
// - 只消费 spec §4 事件目录内的事件类型，未知类型一律 panic（不静默忽略）；
// - 引用缺失（Task/Run/Proposal 不存在）立即抛错，绝不静默跳过；
// - available_actions 只由本模块按 lifecycle / wait_state / 内核 guard 计算（REQ-PJ-1），
//   HTTP 层与前端只渲染不自算。
//
// 事件形态说明：内核事件目录（spec §4）为封闭集，其中"提议"的自然承载是
// PlanChangeProposed / PlanChangeApplied / PlanChangeRejected（spec §2.7 / §5.1）。
// 捕获（Capture）的提议即以这类事件入账，提议的 kind 再细分为
// capture_task / human_light_run / wait_condition（见 proposal.ts）。

import type { EventEnvelope, EventType } from '../../../src/kernel/events.ts';
import { canonicalJson } from '../../../src/kernel/event-store-pg.ts';

export type TaskLifecycle = 'captured' | 'defined' | 'ready' | 'active' | 'awaiting_acceptance' | 'accepted' | 'canceled';
export type TaskWaitState = 'none' | 'waiting_on_person' | 'waiting_until' | 'waiting_on_dependency' | 'blocked' | 'on_hold';

export interface TaskRecord {
  task_id: string;
  project_id: string;
  goal_id: string | null;
  title: string;
  description: string;
  lifecycle: TaskLifecycle;
  wait_state: TaskWaitState;
  assignee_kind: 'human' | 'agent';
  assigned_by: string | null;
  current_contract_rev: number;
  plan_rev_introduced: number;
  duplicate_suspect: boolean;
  acceptance_criteria: AcceptanceCriterion[];
  capture_id: string | null;
  proposal_id: string | null;
  cancel_requested_by: string | null;
  last_outcome_id: string | null;
  feedback_count: number;
  updated_global_seq: number;
}

export interface AcceptanceCriterion {
  criterion_ref: string;
  text: string;
  auto: boolean;
}

export interface CriterionResult {
  criterion_ref: string;
  verdict: 'passed' | 'failed' | 'not_applicable';
  evidence_refs: string[];
}

export interface EvidenceRecord {
  evidence_id: string;
  project_id: string;
  task_id: string | null;
  source_kind: string;
  content_ref: string;
  content_hash: string;
  verification_status: string;
  /** 写入通道：direct（通用写路径）/ tool_gateway（INV-6 网关，含 gateway_id 审计）。 */
  recorded_via: string;
  gateway_id: string | null;
  actor_id: string;
  actor_kind: string;
  created_at: string;
  updated_global_seq: number;
}

export interface AcceptanceRecord {
  acceptance_id: string;
  task_id: string;
  contract_rev: number;
  subject_outcome_id: string | null;
  acceptor_id: string;
  acceptor_kind: string;
  verdict: 'accepted' | 'rejected' | 'partially_accepted';
  criterion_results: CriterionResult[];
  rationale: string;
  created_at: string;
  superseded_by: string | null;
  updated_global_seq: number;
}

export interface RunRecord {
  run_id: string;
  task_id: string;
  assignment_id: string | null;
  run_kind: 'executor' | 'human_light';
  state: 'created' | 'queued' | 'leased' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'timed_out' | 'indeterminate';
  actor_id: string;
  side_effect_level: string;
  updated_global_seq: number;
}

export interface WaitConditionRecord {
  wait_condition_id: string;
  task_id: string;
  kind: 'person' | 'until' | 'dependency' | 'device';
  target_ref: string;
  followup_task_id: string | null;
  status: 'active' | 'satisfied' | 'expired' | 'canceled';
  updated_global_seq: number;
}

export interface FeedbackRecord {
  feedback_id: string;
  task_id: string | null;
  run_id: string | null;
  author_id: string;
  raw_content: string;
  interpretation_status: 'pending' | 'interpreted' | 'failed';
  interpretation: OutcomeDraft | null;
  created_at: string;
  updated_global_seq: number;
}

export interface OutcomeRecord {
  outcome_id: string;
  task_id: string;
  feedback_id: string | null;
  run_id: string | null;
  conclusion_kind: string;
  info_obtained: boolean;
  certainty: string;
  evidence_sufficiency: string;
  blockers: string[];
  followup_suggestions: string[];
  interpreted_by: string;
  proposal_id: string;
  updated_global_seq: number;
}

export interface GoalRecord {
  goal_id: string;
  project_id: string;
  statement: string;
  success_criteria: string;
  stop_conditions: string;
  status: 'active' | 'achieved' | 'abandoned';
  updated_global_seq: number;
}

export interface ProjectRecord {
  project_id: string;
  name: string;
  policy_id: string;
  created_by: string;
  created_at: string;
  updated_global_seq: number;
}

/** 提议对象的领域细分（承载于 PlanChangeProposed.payload.kind）。 */
export type ProposalKind = 'capture_task' | 'human_light_run' | 'wait_condition';

export interface ProposalRecord {
  proposal_id: string;
  project_id: string;
  kind: ProposalKind;
  status: 'proposed' | 'applied' | 'rejected' | 'needs_decision';
  capture_id: string | null;
  task_id: string | null;
  run_id: string | null;
  base_plan_rev: number;
  ops: unknown[];
  rationale: string;
  assumptions: string[];
  risk_level: 'L0' | 'L1' | 'L2' | 'L3';
  /** 提议来源：模型（magpie）或确定性降级占位 */
  proposer: {
    source: 'model' | 'fallback';
    model: string | null;
    /** 模型不可用/输出不合规时为 true —— 必须一路透传到 API 响应 */
    degraded: boolean;
    degraded_reason: string | null;
    latency_ms: number | null;
  };
  /** 提议明细：任务草稿 / 人类执行建议 / 等待条件建议 */
  details: ProposalDetails;
  status_reason: string | null;
  created_at: string;
  updated_global_seq: number;
}

export type ProposalDetails =
  | { kind: 'capture_task'; task: { title: string; description: string; assignee_kind: 'human' | 'agent'; acceptance_criteria: AcceptanceCriterion[] } }
  | { kind: 'human_light_run'; task_id: string; suggested_run_kind: 'human_light'; next_action: string }
  | { kind: 'wait_condition'; task_id: string; wait: { kind: WaitConditionRecord['kind']; target_ref: string; reason: string } };

export interface OutcomeDraft {
  conclusion_kind: 'achieved' | 'partial' | 'infeasible' | 'no_response' | 'unknown';
  info_obtained: boolean;
  certainty: 'low' | 'med' | 'high';
  evidence_sufficiency: 'sufficient' | 'insufficient' | 'none';
  blockers: string[];
  followup_suggestions: string[];
  /** 解释器来源：model / fallback（degraded） */
  source: 'model' | 'fallback';
  degraded: boolean;
  degraded_reason: string | null;
}

export interface EventSummary {
  seq: number;
  kind: EventType;
  stream_id: string;
  task_id: string | null;
  proposal_id: string | null;
  occurred_at: string;
}

export interface ProjectionSnapshot {
  /** 已并入的最大 global_seq（0 = 空库）。 */
  projection_version: number;
  projects: ProjectRecord[];
  goals: GoalRecord[];
  tasks: TaskRecord[];
  runs: RunRecord[];
  wait_conditions: WaitConditionRecord[];
  acceptances: AcceptanceRecord[];
  feedbacks: FeedbackRecord[];
  outcomes: OutcomeRecord[];
  proposals: ProposalRecord[];
  evidences: EvidenceRecord[];
  /** 最近的全局事件摘要（新到旧，最多 retention 条），供 Home 最近活动使用。 */
  recent_events: EventSummary[];
}

const RECENT_EVENT_RETENTION = 200;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function payloadOf(event: EventEnvelope): Record<string, unknown> {
  const payload = event.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${event.type}@${event.global_seq} 的 payload 不是对象`);
  }
  return payload as Record<string, unknown>;
}

function str(payload: Record<string, unknown>, field: string, event: EventEnvelope): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${event.type}@${event.global_seq} 缺少 ${field}`);
  }
  return value;
}

function optStr(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function fingerprint(value: unknown): string {
  return canonicalJson(value);
}

// ---------------------------------------------------------------------------
// 投影器
// ---------------------------------------------------------------------------

export class XuxingProjection {
  private projection_version = 0;
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly goals = new Map<string, GoalRecord>();
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly waitConditions = new Map<string, WaitConditionRecord>();
  private readonly acceptances = new Map<string, AcceptanceRecord>();
  private readonly feedbacks = new Map<string, FeedbackRecord>();
  private readonly outcomes = new Map<string, OutcomeRecord>();
  private readonly proposals = new Map<string, ProposalRecord>();
  private readonly evidences = new Map<string, EvidenceRecord>();
  private recent: EventSummary[] = [];

  apply(event: EventEnvelope): void {
    if (event.global_seq <= this.projection_version) {
      // 同一事件重复并入（cursor 补发/重连）必须是幂等的：静默忽略早期水位
      if (event.global_seq === this.projection_version) return;
      throw new Error(
        `事件乱序并入：global_seq=${event.global_seq} 早于水位 ${this.projection_version}`,
      );
    }
    this.applyPayload(event);
    this.projection_version = event.global_seq;

    const summary = summarise(event);
    this.recent.unshift(summary);
    if (this.recent.length > RECENT_EVENT_RETENTION) this.recent.length = RECENT_EVENT_RETENTION;
  }

  applyAll(events: EventEnvelope[]): this {
    for (const event of events) this.apply(event);
    return this;
  }

  private applyPayload(event: EventEnvelope): void {
    const p = payloadOf(event);
    const project_id = event.stream_id;

    switch (event.type) {
      case 'ProjectCreated': {
        this.projects.set(project_id, {
          project_id,
          name: str(p, 'name', event),
          policy_id: optStr(p, 'policy_id') ?? `policy-${project_id}`,
          created_by: str(p, 'created_by', event),
          created_at: event.occurred_at,
          updated_global_seq: event.global_seq,
        });
        return;
      }
      case 'GoalCreated': {
        const goal_id = str(p, 'goal_id', event);
        this.goals.set(goal_id, {
          goal_id,
          project_id,
          statement: str(p, 'statement', event),
          success_criteria: optStr(p, 'success_criteria') ?? '',
          stop_conditions: optStr(p, 'stop_conditions') ?? '',
          status: 'active',
          updated_global_seq: event.global_seq,
        });
        return;
      }
      case 'GoalStatusChanged': {
        const goal = this.mustGoal(str(p, 'goal_id', event), event);
        goal.status = expectEnum(p, 'to', ['active', 'achieved', 'abandoned'], event);
        goal.updated_global_seq = event.global_seq;
        return;
      }
      case 'TaskCaptured': {
        const task_id = str(p, 'task_id', event);
        if (this.tasks.has(task_id)) {
          throw new Error(`TaskCaptured@${event.global_seq} 重复创建 Task ${task_id}`);
        }
        this.tasks.set(task_id, {
          task_id,
          project_id,
          goal_id: optStr(p, 'goal_id'),
          title: str(p, 'title', event),
          description: optStr(p, 'description') ?? '',
          lifecycle: 'captured',
          wait_state: 'none',
          assignee_kind: expectEnum(p, 'assignee_kind', ['human', 'agent'], event),
          assigned_by: null,
          current_contract_rev: 0,
          plan_rev_introduced: numberOr(p, 'plan_rev_introduced', 0),
          duplicate_suspect: p.duplicate_suspect === true,
          acceptance_criteria: criteriaOf(p.acceptance_criteria, event),
          capture_id: optStr(p, 'capture_id'),
          proposal_id: optStr(p, 'proposal_id'),
          cancel_requested_by: null,
          last_outcome_id: null,
          feedback_count: 0,
          updated_global_seq: event.global_seq,
        });
        return;
      }
      case 'TaskLifecycleChanged': {
        const task = this.mustTask(str(p, 'task_id', event), event);
        const from = str(p, 'from', event);
        const to = str(p, 'to', event);
        if (task.lifecycle !== from) {
          throw new Error(
            `TaskLifecycleChanged@${event.global_seq} 投影态不一致：${task.task_id} 期望 ${from}，实际 ${task.lifecycle}`,
          );
        }
        task.lifecycle = expectEnum(p, 'to', ['captured', 'defined', 'ready', 'active', 'awaiting_acceptance', 'accepted', 'canceled'], event);
        task.updated_global_seq = event.global_seq;
        return;
      }
      case 'TaskWaitStateChanged': {
        const task = this.mustTask(str(p, 'task_id', event), event);
        const from = str(p, 'from', event);
        const to = str(p, 'to', event);
        if (task.wait_state !== from) {
          throw new Error(
            `TaskWaitStateChanged@${event.global_seq} 投影态不一致：${task.task_id} 期望 ${from}，实际 ${task.wait_state}`,
          );
        }
        task.wait_state = expectEnum(p, 'to', ['none', 'waiting_on_person', 'waiting_until', 'waiting_on_dependency', 'blocked', 'on_hold'], event);
        task.updated_global_seq = event.global_seq;
        return;
      }
      case 'TaskDefined': {
        const task = this.mustTask(str(p, 'task_id', event), event);
        task.title = optStr(p, 'title') ?? task.title;
        task.description = optStr(p, 'description') ?? task.description;
        task.current_contract_rev = numberOr(p, 'contract_rev', task.current_contract_rev + 1);
        task.acceptance_criteria = p.acceptance_criteria === undefined
          ? task.acceptance_criteria
          : criteriaOf(p.acceptance_criteria, event);
        task.updated_global_seq = event.global_seq;
        return;
      }
      case 'ContractUpdated': {
        const task = this.mustTask(str(p, 'task_id', event), event);
        task.current_contract_rev = numberOr(p, 'rev', task.current_contract_rev + 1);
        task.acceptance_criteria = criteriaOf(p.acceptance_criteria, event);
        task.updated_global_seq = event.global_seq;
        return;
      }
      case 'AssignmentCreated': {
        const task = this.mustTask(str(p, 'task_id', event), event);
        task.assignee_kind = expectEnum(p, 'actor_kind', ['human', 'agent'], event);
        task.assigned_by = optStr(p, 'assigned_by') ?? event.actor_id;
        task.updated_global_seq = event.global_seq;
        return;
      }
      case 'AssignmentEnded': {
        const task = this.mustTask(str(p, 'task_id', event), event);
        task.assigned_by = null;
        task.updated_global_seq = event.global_seq;
        return;
      }
      case 'RunCreated': {
        const run_id = str(p, 'run_id', event);
        if (this.runs.has(run_id)) throw new Error(`RunCreated@${event.global_seq} 重复创建 Run ${run_id}`);
        const task = this.mustTask(str(p, 'task_id', event), event);
        this.runs.set(run_id, {
          run_id,
          task_id: task.task_id,
          assignment_id: optStr(p, 'assignment_id'),
          run_kind: expectEnum(p, 'run_kind', ['executor', 'human_light'], event),
          state: 'created',
          actor_id: str(p, 'actor_id', event),
          side_effect_level: optStr(p, 'side_effect_level') ?? 'L0',
          updated_global_seq: event.global_seq,
        });
        return;
      }
      case 'RunQueued':
      case 'RunLeased':
      case 'RunStarted':
      case 'RunSucceeded':
      case 'RunFailed':
      case 'RunCanceled':
      case 'RunTimedOut':
      case 'RunIndeterminate': {
        const run = this.mustRun(str(p, 'run_id', event), event);
        run.state = RUN_STATE_BY_EVENT[event.type]!;
        run.updated_global_seq = event.global_seq;
        return;
      }
      case 'RunRawResultReceived': {
        const run = this.mustRun(str(p, 'run_id', event), event);
        run.updated_global_seq = event.global_seq;
        return;
      }
      case 'WaitConditionCreated': {
        const id = str(p, 'wait_condition_id', event);
        const task = this.mustTask(str(p, 'task_id', event), event);
        this.waitConditions.set(id, {
          wait_condition_id: id,
          task_id: task.task_id,
          kind: expectEnum(p, 'kind', ['person', 'until', 'dependency', 'device'], event),
          target_ref: str(p, 'target_ref', event),
          followup_task_id: optStr(p, 'followup_task_id'),
          status: 'active',
          updated_global_seq: event.global_seq,
        });
        return;
      }
      case 'WaitConditionSatisfied':
      case 'WaitConditionExpired':
      case 'WaitConditionCanceled': {
        const wc = this.waitConditions.get(str(p, 'wait_condition_id', event));
        if (!wc) throw new Error(`${event.type}@${event.global_seq} 引用不存在的 WaitCondition`);
        wc.status = event.type === 'WaitConditionSatisfied' ? 'satisfied' : event.type === 'WaitConditionExpired' ? 'expired' : 'canceled';
        wc.updated_global_seq = event.global_seq;
        return;
      }
      case 'FeedbackReceived': {
        const feedback_id = str(p, 'feedback_id', event);
        const task_id = optStr(p, 'task_id');
        if (task_id !== null) this.mustTask(task_id, event);
        this.feedbacks.set(feedback_id, {
          feedback_id,
          task_id,
          run_id: optStr(p, 'run_id'),
          author_id: str(p, 'author_id', event),
          raw_content: str(p, 'raw_content', event),
          interpretation_status: 'pending',
          interpretation: null,
          created_at: event.occurred_at,
          updated_global_seq: event.global_seq,
        });
        if (task_id) this.mustTask(task_id, event).feedback_count += 1;
        return;
      }
      case 'FeedbackInterpreted': {
        const fb = this.mustFeedback(str(p, 'feedback_id', event), event);
        fb.interpretation_status = 'interpreted';
        fb.interpretation = interpretationOf(p.interpretation, event);
        fb.run_id = optStr(p, 'run_id') ?? fb.run_id;
        fb.updated_global_seq = event.global_seq;
        return;
      }
      case 'FeedbackInterpretationFailed': {
        const fb = this.mustFeedback(str(p, 'feedback_id', event), event);
        fb.interpretation_status = 'failed';
        fb.updated_global_seq = event.global_seq;
        return;
      }
      case 'OutcomeRecorded': {
        const outcome_id = str(p, 'outcome_id', event);
        const _task = this.mustTask(str(p, 'task_id', event), event);
        this.outcomes.set(outcome_id, {
          outcome_id,
          task_id: _task.task_id,
          feedback_id: optStr(p, 'feedback_id'),
          run_id: optStr(p, 'run_id'),
          conclusion_kind: str(p, 'conclusion_kind', event),
          info_obtained: p.info_obtained === true,
          certainty: optStr(p, 'certainty') ?? 'low',
          evidence_sufficiency: optStr(p, 'evidence_sufficiency') ?? 'none',
          blockers: strArray(p.blockers),
          followup_suggestions: strArray(p.followup_suggestions),
          interpreted_by: optStr(p, 'interpreted_by') ?? 'system',
          proposal_id: optStr(p, 'proposal_id') ?? '',
          updated_global_seq: event.global_seq,
        });
        // REQ-ACC-3：无有效 Acceptance 且已有 Outcome → awaiting_acceptance（迁移事件随后由命令层发出）
        const task = this.mustTask(str(p, 'task_id', event), event);
        task.last_outcome_id = outcome_id;
        task.updated_global_seq = event.global_seq;
        return;
      }
      case 'AcceptanceRecorded': {
        const id = str(p, 'acceptance_id', event);
        const task = this.mustTask(str(p, 'task_id', event), event);
        const verdict = expectEnum(p, 'verdict', ['accepted', 'rejected', 'partially_accepted'], event);
        this.acceptances.set(id, {
          acceptance_id: id,
          task_id: task.task_id,
          contract_rev: numberOr(p, 'contract_rev', task.current_contract_rev),
          subject_outcome_id: optStr(p, 'subject_outcome_id'),
          acceptor_id: str(p, 'acceptor_id', event),
          acceptor_kind: optStr(p, 'acceptor_kind') ?? event.actor_kind,
          verdict,
          criterion_results: criterionResultsOf(p.criterion_results, event),
          rationale: optStr(p, 'rationale') ?? '',
          created_at: event.occurred_at,
          superseded_by: null,
          updated_global_seq: event.global_seq,
        });
        return;
      }
      case 'EvidenceAdded': {
        const id = optStr(p, 'evidence_id') ?? optStr(p, 'id') ?? `ev_${event.id}`;
        this.evidences.set(id, {
          evidence_id: id,
          project_id: event.stream_id,
          task_id: optStr(p, 'task_id'),
          source_kind: optStr(p, 'source_kind') ?? 'external_doc',
          content_ref: optStr(p, 'content_ref') ?? '',
          content_hash: optStr(p, 'content_hash') ?? '',
          verification_status: optStr(p, 'verification_status') ?? 'unverified',
          recorded_via: optStr(p, 'recorded_via') ?? 'direct',
          gateway_id: optStr(p, 'gateway_id'),
          actor_id: event.actor_id,
          actor_kind: event.actor_kind,
          created_at: event.occurred_at,
          updated_global_seq: event.global_seq,
        });
        return;
      }
      case 'AcceptanceSuperseded': {
        const id = str(p, 'acceptance_id', event);
        const acceptance = this.acceptances.get(id);
        if (!acceptance) throw new Error(`AcceptanceSuperseded@${event.global_seq} 引用不存在的 Acceptance ${id}`);
        acceptance.superseded_by = optStr(p, 'superseded_by') ?? optStr(p, 'new_acceptance_id') ?? 'superseded';
        acceptance.updated_global_seq = event.global_seq;
        return;
      }
      case 'PolicyUpdated':
        return;
      case 'PlanChangeProposed': {
        const id = str(p, 'change_id', event);
        if (this.proposals.has(id)) throw new Error(`PlanChangeProposed@${event.global_seq} 重复提议 ${id}`);
        const details = detailsOf(p.details, event);
        this.proposals.set(id, {
          proposal_id: id,
          project_id,
          kind: expectEnum(p, 'kind', ['capture_task', 'human_light_run', 'wait_condition'], event),
          status: 'proposed',
          capture_id: optStr(p, 'capture_id'),
          task_id: optStr(p, 'task_id'),
          run_id: null,
          base_plan_rev: numberOr(p, 'base_plan_rev', 0),
          ops: Array.isArray(p.ops) ? p.ops : [],
          rationale: optStr(p, 'rationale') ?? '',
          assumptions: strArray(p.assumptions),
          risk_level: expectEnum(p, 'risk_level', ['L0', 'L1', 'L2', 'L3'], event),
          proposer: proposerOf(p.proposer, event),
          details,
          status_reason: null,
          created_at: event.occurred_at,
          updated_global_seq: event.global_seq,
        });
        return;
      }
      case 'PlanChangeApplied': {
        // 命令回执（服务端命令层的幂等账）：不是提议状态流转，不参与提议投影
        if (p.command_receipt === 'command_receipt') return;
        const id = str(p, 'change_id', event);
        const proposal = this.proposals.get(id);
        if (!proposal) throw new Error(`PlanChangeApplied@${event.global_seq} 引用不存在的提议 ${id}`);
        proposal.status = 'applied';
        proposal.status_reason = optStr(p, 'reason');
        proposal.task_id = optStr(p, 'task_id') ?? proposal.task_id;
        proposal.updated_global_seq = event.global_seq;
        return;
      }
      case 'PlanChangeRejected':
      case 'PlanChangeStatusChanged': {
        const id = str(p, 'change_id', event);
        const proposal = this.proposals.get(id);
        if (!proposal) throw new Error(`${event.type}@${event.global_seq} 引用不存在的提议 ${id}`);
        if (event.type === 'PlanChangeRejected') proposal.status = 'rejected';
        else proposal.status = expectEnum(p, 'status', ['proposed', 'applied', 'rejected', 'needs_decision'], event);
        proposal.status_reason = optStr(p, 'reason');
        proposal.updated_global_seq = event.global_seq;
        return;
      }
      case 'TaskCancelRequested': {
        const task = this.mustTask(str(p, 'task_id', event), event);
        task.cancel_requested_by = optStr(p, 'requested_by') ?? event.actor_id;
        task.updated_global_seq = event.global_seq;
        return;
      }
      case 'TaskCanceled':
      case 'TaskDuplicateSuspected':
      case 'TaskDuplicateResolved':
      case 'EdgeAdded':
      case 'EdgeRemoved':
      case 'EvidenceSuperseded':
      case 'DecisionCreated':
      case 'DecisionResolved':
      case 'DecisionExpired':
      case 'PlanRevisionCreated':
      case 'ReleaseOverrideSet':
      case 'ReleaseOverrideInvalidated':
      case 'RunReconciled':
      case 'TimerFired':
      case 'ProjectionRebuilt':
      case 'LatestAcceptedPointerMoved':
        return;
      default: {
        const exhaustive: never = event.type;
        throw new Error(`投影未覆盖的事件类型：${String(exhaustive)}`);
      }
    }
  }

  // ---- 引用校验 ----
  private mustTask(task_id: string, event: EventEnvelope): TaskRecord {
    const task = this.tasks.get(task_id);
    if (!task) throw new Error(`${event.type}@${event.global_seq} 引用不存在的 Task ${task_id}`);
    return task;
  }

  private mustRun(run_id: string, event: EventEnvelope): RunRecord {
    const run = this.runs.get(run_id);
    if (!run) throw new Error(`${event.type}@${event.global_seq} 引用不存在的 Run ${run_id}`);
    return run;
  }

  private mustFeedback(feedback_id: string, event: EventEnvelope): FeedbackRecord {
    const fb = this.feedbacks.get(feedback_id);
    if (!fb) throw new Error(`${event.type}@${event.global_seq} 引用不存在的 Feedback ${feedback_id}`);
    return fb;
  }

  private mustGoal(goal_id: string, event: EventEnvelope): GoalRecord {
    const goal = this.goals.get(goal_id);
    if (!goal) throw new Error(`${event.type}@${event.global_seq} 引用不存在的 Goal ${goal_id}`);
    return goal;
  }

  // ---- 读模型访问 ----
  /** 已并入的最大 global_seq（0 = 空投影）。 */
  version(): number {
    return this.projection_version;
  }

  snapshot(): ProjectionSnapshot {
    const byKey = <T>(rows: T[], key: (row: T) => string): T[] =>
      [...rows].sort((a, b) => key(a).localeCompare(key(b)));
    return {
      projection_version: this.projection_version,
      projects: byKey([...this.projects.values()], (r) => r.project_id),
      goals: byKey([...this.goals.values()], (r) => r.goal_id),
      tasks: byKey([...this.tasks.values()], (r) => `${r.project_id}/${r.capture_id ?? ''}/${r.task_id}`),
      runs: byKey([...this.runs.values()], (r) => r.run_id),
      wait_conditions: byKey([...this.waitConditions.values()], (r) => r.wait_condition_id),
      acceptances: byKey([...this.acceptances.values()], (r) => r.acceptance_id),
      feedbacks: byKey([...this.feedbacks.values()], (r) => r.feedback_id),
      outcomes: byKey([...this.outcomes.values()], (r) => r.outcome_id),
      proposals: byKey([...this.proposals.values()], (r) => r.proposal_id),
      evidences: byKey([...this.evidences.values()], (r) => r.evidence_id),
      recent_events: [...this.recent],
    };
  }

  getTask(task_id: string): TaskRecord | undefined {
    return this.tasks.get(task_id);
  }

  getProposal(proposal_id: string): ProposalRecord | undefined {
    return this.proposals.get(proposal_id);
  }

  getProject(project_id: string): ProjectRecord | undefined {
    return this.projects.get(project_id);
  }
}

const RUN_STATE_BY_EVENT: Partial<Record<EventType, RunRecord['state']>> = {
  RunQueued: 'queued',
  RunLeased: 'leased',
  RunStarted: 'running',
  RunSucceeded: 'succeeded',
  RunFailed: 'failed',
  RunCanceled: 'canceled',
  RunTimedOut: 'timed_out',
  RunIndeterminate: 'indeterminate',
};

function expectEnum<T extends string>(p: Record<string, unknown>, field: string, allowed: readonly T[], event: EventEnvelope): T {
  const value = p[field];
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${event.type}@${event.global_seq} 的 ${field} 不合法：${JSON.stringify(value)}`);
  }
  return value as T;
}

function numberOr(p: Record<string, unknown>, field: string, fallback: number): number {
  const value = p[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function criteriaOf(value: unknown, event: EventEnvelope): AcceptanceCriterion[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${event.type}@${event.global_seq} 的 acceptance_criteria 不是数组`);
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object') {
      throw new Error(`${event.type}@${event.global_seq} 的 acceptance_criteria[${index}] 不是对象`);
    }
    const record = item as Record<string, unknown>;
    const ref = record.criterion_ref;
    const text = record.text;
    if (typeof ref !== 'string' || ref.length === 0) {
      throw new Error(`${event.type}@${event.global_seq} 的 acceptance_criteria[${index}] 缺 criterion_ref`);
    }
    return { criterion_ref: ref, text: typeof text === 'string' ? text : ref, auto: record.auto === true };
  });
}

function criterionResultsOf(value: unknown, event: EventEnvelope): CriterionResult[] {
  if (!Array.isArray(value)) throw new Error(`${event.type}@${event.global_seq} 的 criterion_results 不是数组`);
  return value.map((item, index) => {
    const record = (item ?? {}) as Record<string, unknown>;
    const ref = record.criterion_ref;
    if (typeof ref !== 'string') throw new Error(`${event.type}@${event.global_seq} criterion_results[${index}] 缺 criterion_ref`);
    return {
      criterion_ref: ref,
      verdict: expectEnum(record, 'verdict', ['passed', 'failed', 'not_applicable'], event),
      evidence_refs: strArray(record.evidence_refs),
    };
  });
}

function proposerOf(value: unknown, event: EventEnvelope): ProposalRecord['proposer'] {
  const record = (value ?? {}) as Record<string, unknown>;
  const source = record.source === 'model' ? 'model' : 'fallback';
  return {
    source,
    model: typeof record.model === 'string' ? record.model : null,
    degraded: record.degraded === true || source === 'fallback',
    degraded_reason: typeof record.degraded_reason === 'string' ? record.degraded_reason : null,
    latency_ms: typeof record.latency_ms === 'number' ? record.latency_ms : null,
  };
}

function interpretationOf(value: unknown, event: EventEnvelope): OutcomeDraft {
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    conclusion_kind: expectEnum(record, 'conclusion_kind', ['achieved', 'partial', 'infeasible', 'no_response', 'unknown'], event),
    info_obtained: record.info_obtained === true,
    certainty: expectEnum(record, 'certainty', ['low', 'med', 'high'], event),
    evidence_sufficiency: expectEnum(record, 'evidence_sufficiency', ['sufficient', 'insufficient', 'none'], event),
    blockers: strArray(record.blockers),
    followup_suggestions: strArray(record.followup_suggestions),
    source: record.source === 'model' ? 'model' : 'fallback',
    degraded: record.degraded === true || record.source !== 'model',
    degraded_reason: typeof record.degraded_reason === 'string' ? record.degraded_reason : null,
  };
}

function detailsOf(value: unknown, event: EventEnvelope): ProposalDetails {
  const record = (value ?? {}) as Record<string, unknown>;
  switch (event.type === 'PlanChangeProposed' ? expectEnum(payloadOf(event), 'kind', ['capture_task', 'human_light_run', 'wait_condition'], event) : 'capture_task') {
    case 'capture_task': {
      const task = (record.task ?? {}) as Record<string, unknown>;
      return {
        kind: 'capture_task',
        task: {
          title: typeof task.title === 'string' ? task.title : '',
          description: typeof task.description === 'string' ? task.description : '',
          assignee_kind: task.assignee_kind === 'agent' ? 'agent' : 'human',
          acceptance_criteria: criteriaOf(task.acceptance_criteria, event),
        },
      };
    }
    case 'human_light_run':
      return {
        kind: 'human_light_run',
        task_id: typeof record.task_id === 'string' ? record.task_id : '',
        suggested_run_kind: 'human_light',
        next_action: typeof record.next_action === 'string' ? record.next_action : '',
      };
    case 'wait_condition': {
      const wait = (record.wait ?? {}) as Record<string, unknown>;
      return {
        kind: 'wait_condition',
        task_id: typeof record.task_id === 'string' ? record.task_id : '',
        wait: {
          kind: expectEnum(wait, 'kind', ['person', 'until', 'dependency', 'device'], event),
          target_ref: typeof wait.target_ref === 'string' ? wait.target_ref : '',
          reason: typeof wait.reason === 'string' ? wait.reason : '',
        },
      };
    }
  }
}

function summarise(event: EventEnvelope): EventSummary {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  return {
    seq: event.global_seq,
    kind: event.type,
    stream_id: event.stream_id,
    task_id: typeof p.task_id === 'string' ? p.task_id : null,
    proposal_id: typeof p.change_id === 'string' ? p.change_id : typeof p.proposal_id === 'string' ? p.proposal_id : null,
    occurred_at: event.occurred_at,
  };
}

