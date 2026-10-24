// D9 旅程即测试 —— 事件派生投影（tests/journey 专用夹具，非生产投影）。
//
// 与 tests/support/minimal-projection.ts 的关系：那个夹具只求 C5 的最小闭环（tasks/runs 两张表）；
// 本夹具把 D8 完整旅程涉及的脊柱对象（Project/Goal/Task/Contract/Edge/PlanChange/PlanRevision/
// Assignment/Run/Feedback/Evidence/Outcome/Acceptance/WaitCondition/Decision/Pointer）全部
// **只从事件流派生**，用于断言「状态只从事件派生」这条 D9 纪律。
//
// 纪律：
// - 引用不存在的实体 → 立即抛错（不静默跳过），否则「状态来自事件」的断言毫无意义；
// - 违反 INV-8（rev 单调）/ INV-11（终态收尾）/ INV-14（单 active Assignment）→ 抛错；
// - 不消费的事件类型必须显式登记在 NON_STATE_EVENT_TYPES，否则视为「有状态变更却没登记」；
// - 本夹具不读任何实体表：唯一输入是 EventEnvelope[]。

import type { EventEnvelope, EventType } from '../../../src/kernel/events.js';
import type { SideEffectLevel } from '../../../src/domain/types.js';
import { TASK_STATES, TASK_WAIT_STATES } from '../../../src/kernel/transition-guard.js';

// ---------------------------------------------------------------------------
// 派生行形状
// ---------------------------------------------------------------------------

export interface JProject {
  project_id: string;
  name: string;
  policy_id: string;
  auto_apply_ceiling: SideEffectLevel;
  allowed_proposers: string[];
  require_decision_for: string[];
}

export interface JGoal {
  goal_id: string;
  status: string;
  statement: string;
}

export interface JTask {
  task_id: string;
  goal_id: string | null;
  lifecycle: string;
  wait_state: string;
  current_contract_rev: number;
  plan_rev_introduced: number;
  duplicate_suspect: boolean;
  last_outcome_id: string | null;
  title: string;
  introduced_by_change_id: string | null;
  /** REQ-TC-1：由计划 op 的 assignee 决定的预期执行者类型（agent 须结构化契约）。 */
  intended_assignee_kind: 'human' | 'agent' | null;
}

export interface JContract {
  task_id: string;
  rev: number;
  criterion_refs: string[];
  auto_criterion_refs: string[];
  expected_outputs: string[];
  side_effect_ceiling: SideEffectLevel;
  required_capabilities: string[];
  declares_revalidation: boolean;
  run_timeout: string;
}

export interface JEdge {
  edge_id: string;
  from_task: string;
  to_task: string;
  kind: string;
  data_mode: string | null;
  pinned_version: unknown;
  removed: boolean;
}

export interface JPlanChange {
  change_id: string;
  client_proposal_id: string;
  proposer_id: string;
  base_plan_rev: number;
  risk_level: SideEffectLevel;
  estimated_budget: number;
  status: string;
  ops: JOp[];
  reason_code: string | null;
  decision_id: string | null;
  /** REQ-PC-5：approved_modified 时新 Change 对旧 Change 的取代链接（payload 未带则为 null）。 */
  supersedes_change_id: string | null;
}

export interface JOp {
  op: string;
  task_id?: string;
  edge_id?: string;
  from_task?: string;
  to_task?: string;
  kind?: string;
  data_mode?: string;
  pinned_version?: unknown;
  contract?: {
    rev: number;
    acceptance_criteria?: { criterion_ref?: string; check?: string; text?: string }[];
    expected_outputs?: string[];
    side_effect_ceiling?: SideEffectLevel;
    required_capabilities?: string[];
    declares_revalidation?: boolean;
    run_timeout?: string;
  };
  wait_condition_id?: string;
  wait_kind?: string;
  target_ref?: string;
  due_at?: string;
  assignee?: { actor_id?: string; actor_kind?: string };
  [key: string]: unknown;
}

export interface JAssignment {
  assignment_id: string;
  task_id: string;
  actor_id: string;
  actor_kind: string;
  ended_at: string | null;
  created_via: string;
}

export interface JRun {
  run_id: string;
  task_id: string;
  assignment_id: string;
  run_kind: string;
  state: string;
  contract_rev: number;
  plan_rev: number;
  task_rev: number;
  side_effect_level: SideEffectLevel;
  actor_id: string;
  idempotency_key: string;
  input_snapshot: unknown;
  policy_snapshot: unknown;
  raw_result_ref: string | null;
}

export interface JFeedback {
  feedback_id: string;
  task_id: string | null;
  run_id: string | null;
  author_id: string;
  interpretation_status: string;
  client_submit_id: string;
}

export interface JOutcome {
  outcome_id: string;
  task_id: string;
  run_id: string | null;
  feedback_id: string | null;
  proposal_id: string;
  supersedes_id: string | null;
  dimensions: Record<string, unknown>;
  evidence_refs: string[];
}

export interface JEvidence {
  evidence_id: string;
  task_id: string;
  source_kind: string;
  content_hash: string;
  supersedes_id: string | null;
  superseded: boolean;
}

export interface JAcceptance {
  acceptance_id: string;
  task_id: string;
  contract_rev: number;
  subject_outcome_id: string;
  acceptor_id: string;
  acceptor_kind: string;
  verdict: string;
  criterion_results: { criterion_ref: string; verdict: string; evidence_refs: string[] }[];
  supersedes_id: string | null;
  superseded: boolean;
  /** REQ-ACC-4：显式取代事件（AcceptanceSuperseded）带来的反向指针与原因；未取代为 null。 */
  superseded_by_id: string | null;
  supersede_reason: string | null;
}

export interface JWaitCondition {
  wait_condition_id: string;
  task_id: string;
  kind: string;
  target_ref: string;
  followup_task_id: string | null;
  status: string;
}

export interface JDecision {
  decision_id: string;
  subject_ref: string;
  question: string;
  status: string;
  decided_by: string | null;
  resolution: string | null;
}

export interface JPointer {
  from_task: string;
  to_task: string;
  from_outcome_id: string | null;
  to_outcome_id: string | null;
  moved_at_seq: number;
}

export interface JBudgetEntry {
  kind: 'run' | 'change';
  ref_id: string;
  estimated: number;
  actual: number | null;
  unit: string | null;
}

export interface JourneySnapshot {
  projects: JProject[];
  goals: JGoal[];
  tasks: JTask[];
  contracts: JContract[];
  edges: JEdge[];
  changes: JPlanChange[];
  assignments: JAssignment[];
  runs: JRun[];
  feedbacks: JFeedback[];
  outcomes: JOutcome[];
  evidences: JEvidence[];
  acceptances: JAcceptance[];
  wait_conditions: JWaitCondition[];
  decisions: JDecision[];
  pointers: JPointer[];
  budget_ledger: JBudgetEntry[];
  plan_rev: number;
  non_state_events: Record<string, number>;
}

/** 本夹具不消费、且不携带投影状态的事件类型（spec §4 派生规则声明中属于「留痕/回执」类）。
 * 例外说明：TaskCanceled 并非纯回执 —— 它承载取消级联的终态语义（§3.2 REQ-RUN-6）；
 * 归入本列仅因 Task.lifecycle 另由 TaskLifecycleChanged 派生、不从 TaskCanceled
 * 读状态。本旅程未发射 TaskCancelRequested/TaskCanceled，该前提一旦变化须重估本登记。 */
export const NON_STATE_EVENT_TYPES: readonly EventType[] = [
  // 注意：ProjectCreated 不在此列 —— 它会建立 project 行并写入 policy/ceiling，是状态携带者。
  'EvidenceSuperseded',
  'ReleaseOverrideSet',
  'ReleaseOverrideInvalidated',
  'TimerFired',
  'ProjectionRebuilt',
  'DecisionExpired',
  'TaskCancelRequested',
  'TaskCanceled',
];

const SIDE_EFFECT_ORDER: Record<SideEffectLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };

export function sideEffectRank(level: SideEffectLevel): number {
  return SIDE_EFFECT_ORDER[level];
}

// ---------------------------------------------------------------------------
// payload 取字段（缺失即抛错：状态必须有名有姓地来自事件）
// ---------------------------------------------------------------------------

function field<T>(event: EventEnvelope, name: string): T {
  const payload = event.payload as Record<string, unknown> | null;
  if (payload === null || typeof payload !== 'object') {
    throw new Error(`${event.type}@seq=${event.seq} payload 不是对象`);
  }
  if (!Object.hasOwn(payload, name) || payload[name] === undefined) {
    throw new Error(`${event.type}@seq=${event.seq} payload 缺少字段 ${name}`);
  }
  return payload[name] as T;
}

function optField<T>(event: EventEnvelope, name: string): T | null {
  const payload = event.payload as Record<string, unknown>;
  return (payload[name] as T) ?? null;
}

function str(event: EventEnvelope, name: string): string {
  const value = field<unknown>(event, name);
  if (typeof value !== 'string') {
    throw new Error(`${event.type}@seq=${event.seq} 字段 ${name} 期望 string，实际 ${typeof value}`);
  }
  return value;
}

function num(event: EventEnvelope, name: string): number {
  const value = field<unknown>(event, name);
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${event.type}@seq=${event.seq} 字段 ${name} 期望安全整数`);
  }
  return value;
}

function arr<T>(event: EventEnvelope, name: string): T[] {
  const value = field<unknown>(event, name);
  if (!Array.isArray(value)) {
    throw new Error(`${event.type}@seq=${event.seq} 字段 ${name} 期望数组`);
  }
  return value as T[];
}

const RUN_STATE_BY_EVENT: Partial<Record<EventType, string>> = {
  RunQueued: 'queued',
  RunLeased: 'leased',
  RunStarted: 'running',
  RunSucceeded: 'succeeded',
  RunFailed: 'failed',
  RunCanceled: 'canceled',
  RunTimedOut: 'timed_out',
  RunIndeterminate: 'indeterminate',
};

// ---------------------------------------------------------------------------
// 投影
// ---------------------------------------------------------------------------

export class JourneyProjection {
  readonly projects = new Map<string, JProject>();
  readonly goals = new Map<string, JGoal>();
  readonly tasks = new Map<string, JTask>();
  readonly contracts = new Map<string, JContract>();
  readonly edges = new Map<string, JEdge>();
  readonly changes = new Map<string, JPlanChange>();
  readonly assignments = new Map<string, JAssignment>();
  readonly runs = new Map<string, JRun>();
  readonly feedbacks = new Map<string, JFeedback>();
  readonly outcomes = new Map<string, JOutcome>();
  readonly evidences = new Map<string, JEvidence>();
  readonly acceptances = new Map<string, JAcceptance>();
  readonly waitConditions = new Map<string, JWaitCondition>();
  readonly decisions = new Map<string, JDecision>();
  readonly pointers: JPointer[] = [];
  readonly budget: JBudgetEntry[] = [];
  readonly nonStateCounts = new Map<string, number>();

  planRev = 0;

  apply(event: EventEnvelope): void {
    const project_id = event.stream_id;

    switch (event.type) {
      case 'ProjectCreated': {
        this.projects.set(project_id, {
          project_id,
          name: str(event, 'name'),
          policy_id: str(event, 'policy_id'),
          auto_apply_ceiling: field<SideEffectLevel>(event, 'auto_apply_ceiling'),
          allowed_proposers: arr<string>(event, 'allowed_proposers'),
          require_decision_for: arr<string>(event, 'require_decision_for'),
        });
        return;
      }
      case 'PolicyUpdated': {
        const p = this.mustProject(project_id, event);
        p.auto_apply_ceiling = field<SideEffectLevel>(event, 'auto_apply_ceiling');
        p.allowed_proposers = arr<string>(event, 'allowed_proposers');
        p.require_decision_for = arr<string>(event, 'require_decision_for');
        return;
      }
      case 'GoalCreated': {
        this.goals.set(str(event, 'goal_id'), {
          goal_id: str(event, 'goal_id'),
          status: str(event, 'status'),
          statement: str(event, 'statement'),
        });
        return;
      }
      case 'GoalStatusChanged': {
        const goal = this.goals.get(str(event, 'goal_id'));
        if (!goal) throw new Error(`GoalStatusChanged@${event.seq} 引用不存在的 Goal`);
        goal.status = str(event, 'to');
        return;
      }
      case 'TaskCaptured': {
        const task_id = str(event, 'task_id');
        if (this.tasks.has(task_id)) {
          throw new Error(`TaskCaptured@${event.seq} Task ${task_id} 已存在（INV-13 之外不重复入账）`);
        }
        this.tasks.set(task_id, {
          task_id,
          goal_id: optField<string>(event, 'goal_id'),
          lifecycle: 'captured',
          wait_state: 'none',
          current_contract_rev: 0,
          plan_rev_introduced: this.planRev,
          duplicate_suspect: false,
          last_outcome_id: null,
          title: str(event, 'title'),
          introduced_by_change_id: optField<string>(event, 'change_id'),
          intended_assignee_kind: null,
        });
        return;
      }
      case 'TaskLifecycleChanged': {
        const task = this.mustTask(str(event, 'task_id'), event);
        const from = str(event, 'from');
        const to = str(event, 'to');
        if (!TASK_STATES.includes(from as never) || !TASK_STATES.includes(to as never)) {
          throw new Error(`TaskLifecycleChanged@${event.seq} 状态不在 §3.1 枚举内：${from}→${to}`);
        }
        if (task.lifecycle !== from) {
          throw new Error(
            `TaskLifecycleChanged@${event.seq} 派生态 ${task.lifecycle} ≠ 事件 from ${from}（状态不只来自事件？）`,
          );
        }
        task.lifecycle = to;
        // INV-11：迁入 accepted/canceled 时收尾必须已在同事务内落为事件
        if (to === 'accepted' || to === 'canceled') {
          if (task.wait_state !== 'none') {
            throw new Error(
              `INV-11 违约：${task.task_id} 迁入 ${to} 时 wait_state=${task.wait_state}（须先归 none）`,
            );
          }
          const stillActive = [...this.waitConditions.values()].filter(
            (wc) => wc.task_id === task.task_id && wc.status === 'active',
          );
          if (stillActive.length > 0) {
            throw new Error(
              `INV-11 违约：${task.task_id} 迁入 ${to} 后仍有 active WaitCondition ${stillActive[0].wait_condition_id}`,
            );
          }
        }
        return;
      }
      case 'TaskWaitStateChanged': {
        const task = this.mustTask(str(event, 'task_id'), event);
        const from = str(event, 'from');
        const to = str(event, 'to');
        if (!TASK_WAIT_STATES.includes(from as never) || !TASK_WAIT_STATES.includes(to as never)) {
          throw new Error(`TaskWaitStateChanged@${event.seq} wait_state 不在 §3.1 枚举内`);
        }
        if (task.wait_state !== from) {
          throw new Error(
            `TaskWaitStateChanged@${event.seq} 派生态 ${task.wait_state} ≠ 事件 from ${from}`,
          );
        }
        task.wait_state = to;
        return;
      }
      case 'TaskDuplicateSuspected':
      case 'TaskDuplicateResolved': {
        const task = this.mustTask(str(event, 'task_id'), event);
        task.duplicate_suspect = event.type === 'TaskDuplicateSuspected';
        return;
      }
      case 'ContractUpdated': {
        const task = this.mustTask(str(event, 'task_id'), event);
        const rev = num(event, 'rev');
        if (rev !== task.current_contract_rev + 1) {
          throw new Error(
            `ContractUpdated@${event.seq} rev=${rev} 非单调（当前 ${task.current_contract_rev}，INV-5）`,
          );
        }
        const criteria = arr<{ criterion_ref: string; check?: string }>(event, 'acceptance_criteria');
        this.contracts.set(`${task.task_id}:${rev}`, {
          task_id: task.task_id,
          rev,
          criterion_refs: criteria.map((c) => c.criterion_ref),
          auto_criterion_refs: criteria.filter((c) => c.check === 'auto').map((c) => c.criterion_ref),
          expected_outputs: optField<string[]>(event, 'expected_outputs') ?? [],
          side_effect_ceiling: field<SideEffectLevel>(event, 'side_effect_ceiling'),
          required_capabilities: arr<string>(event, 'required_capabilities'),
          declares_revalidation: optField<boolean>(event, 'declares_revalidation') ?? false,
          run_timeout: str(event, 'run_timeout'),
        });
        task.current_contract_rev = rev;
        return;
      }
      case 'EdgeAdded': {
        this.edges.set(str(event, 'edge_id'), {
          edge_id: str(event, 'edge_id'),
          from_task: str(event, 'from_task'),
          to_task: str(event, 'to_task'),
          kind: str(event, 'kind'),
          data_mode: optField<string>(event, 'data_mode'),
          pinned_version: optField<unknown>(event, 'pinned_version'),
          removed: false,
        });
        return;
      }
      case 'EdgeRemoved': {
        const edge = this.edges.get(str(event, 'edge_id'));
        if (!edge) throw new Error(`EdgeRemoved@${event.seq} 引用不存在的边`);
        edge.removed = true;
        return;
      }
      case 'PlanChangeProposed': {
        this.changes.set(str(event, 'change_id'), {
          change_id: str(event, 'change_id'),
          client_proposal_id: str(event, 'client_proposal_id'),
          proposer_id: str(event, 'proposer_id'),
          base_plan_rev: num(event, 'base_plan_rev'),
          risk_level: field<SideEffectLevel>(event, 'risk_level'),
          estimated_budget: num(event, 'estimated_budget'),
          status: 'proposed',
          ops: arr<JOp>(event, 'ops'),
          supersedes_change_id: optField<string>(event, 'supersedes_change_id'),
          reason_code: null,
          decision_id: null,
        });
        return;
      }
      case 'PlanChangeStatusChanged': {
        const change = this.mustChange(str(event, 'change_id'), event);
        change.status = str(event, 'to');
        if (optField<string>(event, 'decision_id')) {
          change.decision_id = optField<string>(event, 'decision_id');
        }
        return;
      }
      case 'PlanChangeApplied': {
        const change = this.mustChange(str(event, 'change_id'), event);
        change.status = 'applied';
        change.reason_code = null;
        // op 里的 assignee 决定该 Task 的预期执行者类型（REQ-TC-1 的判定输入）
        for (const op of change.ops) {
          if (op.op !== 'add_task' && op.op !== 'reassign') continue;
          const task_id = op.task_id ?? op.to_task;
          const kind = op.assignee?.actor_kind;
          if (typeof task_id !== 'string' || (kind !== 'human' && kind !== 'agent')) continue;
          const task = this.tasks.get(task_id);
          if (task) task.intended_assignee_kind = kind;
        }
        return;
      }
      case 'PlanChangeRejected': {
        const change = this.mustChange(str(event, 'change_id'), event);
        change.status = 'rejected';
        change.reason_code = str(event, 'reason_code');
        return;
      }
      case 'PlanRevisionCreated': {
        const rev = num(event, 'rev');
        if (rev !== this.planRev + 1) {
          throw new Error(`INV-8 违约：PlanRevision rev=${rev}，当前 ${this.planRev}（须单调递增 +1）`);
        }
        this.planRev = rev;
        const change = this.mustChange(str(event, 'change_id'), event);
        if (change.status !== 'applied') {
          throw new Error(`PlanRevisionCreated@${event.seq} 的 Change ${change.change_id} 未 applied`);
        }
        // REQ-PC-6：预算关口 K0 恒通过、只记账（每个已应用的 PlanChange 落一条）
        this.budget.push({
          kind: 'change',
          ref_id: change.change_id,
          estimated: change.estimated_budget,
          actual: null,
          unit: 'token',
        });
        return;
      }
      case 'AssignmentCreated': {
        const assignment_id = str(event, 'assignment_id');
        const task = this.mustTask(str(event, 'task_id'), event);
        // INV-14：同一 Task 同时至多一个 active Assignment
        const active = [...this.assignments.values()].filter(
          (a) => a.task_id === task.task_id && a.ended_at === null,
        );
        if (active.length > 0) {
          throw new Error(
            `INV-14 违约：Task ${task.task_id} 已有 active Assignment ${active[0].assignment_id}`,
          );
        }
        this.assignments.set(assignment_id, {
          assignment_id,
          task_id: task.task_id,
          actor_id: str(event, 'actor_id'),
          actor_kind: str(event, 'actor_kind'),
          ended_at: null,
          created_via: str(event, 'created_via'),
        });
        return;
      }
      case 'AssignmentEnded': {
        const assignment = this.assignments.get(str(event, 'assignment_id'));
        if (!assignment) throw new Error(`AssignmentEnded@${event.seq} 引用不存在的 Assignment`);
        assignment.ended_at = str(event, 'ended_at');
        return;
      }
      case 'RunCreated': {
        const run_id = str(event, 'run_id');
        const task = this.mustTask(str(event, 'task_id'), event);
        this.runs.set(run_id, {
          run_id,
          task_id: task.task_id,
          assignment_id: str(event, 'assignment_id'),
          run_kind: str(event, 'run_kind'),
          state: 'created',
          contract_rev: num(event, 'contract_rev'),
          plan_rev: num(event, 'plan_rev'),
          task_rev: num(event, 'task_rev'),
          side_effect_level: field<SideEffectLevel>(event, 'side_effect_level'),
          actor_id: str(event, 'actor_id'),
          idempotency_key: str(event, 'idempotency_key'),
          input_snapshot: field<unknown>(event, 'input_snapshot'),
          policy_snapshot: field<unknown>(event, 'policy_snapshot'),
          raw_result_ref: null,
        });
        return;
      }
      case 'RunRawResultReceived': {
        const run = this.mustRun(str(event, 'run_id'), event);
        run.raw_result_ref = str(event, 'raw_result_ref');
        return;
      }
      case 'OutcomeRecorded': {
        const outcome_id = str(event, 'outcome_id');
        const task = this.mustTask(str(event, 'task_id'), event);
        const run_id = optField<string>(event, 'run_id');
        if (run_id !== null) this.mustRun(run_id, event);
        const dims = field<Record<string, unknown>>(event, 'dimensions');
        this.outcomes.set(outcome_id, {
          outcome_id,
          task_id: task.task_id,
          run_id,
          feedback_id: optField<string>(event, 'feedback_id'),
          proposal_id: str(event, 'proposal_id'),
          supersedes_id: optField<string>(event, 'supersedes_id'),
          dimensions: dims,
          evidence_refs: arr<string>(event, 'evidence_refs'),
        });
        task.last_outcome_id = outcome_id;
        // REQ-PC-6：Run 达终态记账由 Acceptance/终态事件触发，这里只记 Outcome 不留预算
        return;
      }
      case 'FeedbackReceived': {
        this.feedbacks.set(str(event, 'feedback_id'), {
          feedback_id: str(event, 'feedback_id'),
          task_id: optField<string>(event, 'task_id'),
          run_id: optField<string>(event, 'run_id'),
          author_id: str(event, 'author_id'),
          interpretation_status: str(event, 'interpretation_status'),
          client_submit_id: str(event, 'client_submit_id'),
        });
        return;
      }
      case 'FeedbackInterpreted': {
        const fb = this.mustFeedback(str(event, 'feedback_id'), event);
        fb.interpretation_status = str(event, 'interpretation_status');
        return;
      }
      case 'FeedbackInterpretationFailed': {
        const fb = this.mustFeedback(str(event, 'feedback_id'), event);
        fb.interpretation_status = 'failed';
        return;
      }
      case 'EvidenceAdded': {
        const evidence_id = str(event, 'evidence_id');
        this.mustTask(str(event, 'task_id'), event);
        this.evidences.set(evidence_id, {
          evidence_id,
          task_id: str(event, 'task_id'),
          source_kind: str(event, 'source_kind'),
          content_hash: str(event, 'content_hash'),
          supersedes_id: optField<string>(event, 'supersedes_id'),
          superseded: false,
        });
        return;
      }
      case 'AcceptanceRecorded': {
        const task = this.mustTask(str(event, 'task_id'), event);
        const subject = this.outcomes.get(str(event, 'subject_outcome_id'));
        if (!subject) throw new Error(`AcceptanceRecorded@${event.seq} subject_outcome_id 指向不存在的 Outcome`);
        if (subject.task_id !== task.task_id && this.dataFromUpstream(task.task_id, subject.task_id).length === 0) {
          throw new Error(
            `AcceptanceRecorded@${event.seq} subject Outcome 既不属于本 Task，也不是其 data_from 上游产物（§8.1 G1 构造唯一性）`,
          );
        }
        const acceptance: JAcceptance = {
          acceptance_id: str(event, 'acceptance_id'),
          task_id: task.task_id,
          contract_rev: num(event, 'contract_rev'),
          subject_outcome_id: str(event, 'subject_outcome_id'),
          acceptor_id: str(event, 'acceptor_id'),
          acceptor_kind: str(event, 'acceptor_kind'),
          verdict: str(event, 'verdict'),
          criterion_results:
            arr<{ criterion_ref: string; verdict: string; evidence_refs: string[] }>(
              event, 'criterion_results'),
          supersedes_id: optField<string>(event, 'supersedes_id'),
          superseded: false,
          superseded_by_id: null,
          supersede_reason: null,
        };
        // REQ-ACC-4：新 Acceptance 取代旧的只能显式 supersedes
        if (acceptance.supersedes_id !== null) {
          const old = this.acceptances.get(acceptance.supersedes_id);
          if (!old) throw new Error(`AcceptanceRecorded@${event.seq} supersedes_id 指向不存在的 Acceptance`);
          old.superseded = true;
        }
        this.acceptances.set(acceptance.acceptance_id, acceptance);
        return;
      }
      case 'AcceptanceSuperseded': {
        const target = this.acceptances.get(str(event, 'superseded_id'));
        if (!target) throw new Error(`AcceptanceSuperseded@${event.seq} 引用不存在的 Acceptance`);
        const by = str(event, 'superseded_by_id');
        if (!this.acceptances.has(by)) {
          throw new Error(`AcceptanceSuperseded@${event.seq} superseded_by_id 指向不存在的 Acceptance ${by}`);
        }
        if (target.superseded_by_id !== null && target.superseded_by_id !== by) {
          throw new Error(
            `AcceptanceSuperseded@${event.seq} 已取代到 ${target.superseded_by_id}，不得改写（INV-7：只追加）`,
          );
        }
        target.superseded = true;
        target.superseded_by_id = by;
        target.supersede_reason = str(event, 'reason');
        return;
      }
      case 'LatestAcceptedPointerMoved': {
        this.pointers.push({
          from_task: str(event, 'from_task'),
          to_task: str(event, 'to_task'),
          from_outcome_id: optField<string>(event, 'from_outcome_id'),
          to_outcome_id: optField<string>(event, 'to_outcome_id'),
          moved_at_seq: event.seq,
        });
        return;
      }
      case 'WaitConditionCreated': {
        const task = this.mustTask(str(event, 'task_id'), event);
        const wc: JWaitCondition = {
          wait_condition_id: str(event, 'wait_condition_id'),
          task_id: task.task_id,
          kind: str(event, 'kind'),
          target_ref: str(event, 'target_ref'),
          followup_task_id: optField<string>(event, 'followup_task_id'),
          status: 'active',
        };
        // INV-10：同 (task_id, kind, target_ref) 同时至多一个 active
        const dup = [...this.waitConditions.values()].find(
          (w) => w.task_id === wc.task_id && w.kind === wc.kind && w.target_ref === wc.target_ref && w.status === 'active',
        );
        if (dup) {
          throw new Error(`INV-10 违约：${wc.task_id} 已有 active WaitCondition ${dup.wait_condition_id}`);
        }
        this.waitConditions.set(wc.wait_condition_id, wc);
        return;
      }
      case 'WaitConditionSatisfied':
      case 'WaitConditionExpired':
      case 'WaitConditionCanceled': {
        const wc = this.waitConditions.get(str(event, 'wait_condition_id'));
        if (!wc) throw new Error(`${event.type}@${event.seq} 引用不存在的 WaitCondition`);
        wc.status = event.type === 'WaitConditionSatisfied' ? 'satisfied'
          : event.type === 'WaitConditionExpired' ? 'expired' : 'canceled';
        return;
      }
      case 'DecisionCreated': {
        this.decisions.set(str(event, 'decision_id'), {
          decision_id: str(event, 'decision_id'),
          subject_ref: str(event, 'subject_ref'),
          question: str(event, 'question'),
          status: str(event, 'status'),
          decided_by: null,
          resolution: null,
        });
        return;
      }
      case 'DecisionResolved': {
        const decision = this.mustDecision(str(event, 'decision_id'), event);
        decision.status = str(event, 'resolution');
        decision.decided_by = str(event, 'decided_by');
        decision.resolution = str(event, 'resolution');
        return;
      }
      default: {
        const nextRunState = RUN_STATE_BY_EVENT[event.type];
        if (nextRunState !== undefined) {
          const run = this.mustRun(str(event, 'run_id'), event);
          if (run.state === nextRunState) {
            throw new Error(`${event.type}@${event.seq} 自环不算迁移（§3.2）`);
          }
          run.state = nextRunState;
          // REQ-PC-6：Run 达终态落一条账目（K0 只记账不拦截）
          if (['succeeded', 'failed', 'canceled', 'timed_out'].includes(nextRunState)) {
            const ledger = field<{ estimated: number; actual: number; unit: string }>(event, 'budget');
            this.budget.push({
              kind: 'run',
              ref_id: run.run_id,
              estimated: ledger.estimated,
              actual: ledger.actual,
              unit: ledger.unit,
            });
          }
          return;
        }
        if (!NON_STATE_EVENT_TYPES.includes(event.type)) {
          throw new Error(
            `${event.type}@${event.seq} 既不被投影消费，也不在 NON_STATE_EVENT_TYPES 登记内 —— ` +
              `要么补派生规则，要么确认它无状态（D9：无事件的状态变更必须为零）`,
          );
        }
        this.nonStateCounts.set(event.type, (this.nonStateCounts.get(event.type) ?? 0) + 1);
        return;
      }
    }
  }

  applyAll(events: EventEnvelope[]): this {
    for (const event of events) this.apply(event);
    return this;
  }

  // -------------------------------------------------------------------------
  // 派生查询（只读投影，不读表）
  // -------------------------------------------------------------------------

  project(project_id: string): JProject {
    return this.mustProject(project_id, { type: 'query', seq: 0 } as unknown as EventEnvelope);
  }

  /** REQ-ACC-3：Task 达成判定 = 最新有效（未被 supersede）Acceptance。 */
  effectiveAcceptance(task_id: string): JAcceptance | null {
    const valid = [...this.acceptances.values()].filter(
      (a) => a.task_id === task_id && !a.superseded,
    );
    if (valid.length > 1) {
      throw new Error(`Task ${task_id} 有多条有效 Acceptance（${valid.map((v) => v.acceptance_id)}）—— 违反 §2.6`);
    }
    return valid[0] ?? null;
  }

  /** REQ-SCH-2：latest_accepted 指针，主语为上游 from_task。 */
  latestAcceptedOutcome(task_id: string): string | null {
    const moved = [...this.pointers].reverse().find((p) => p.from_task === task_id);
    return moved ? moved.to_outcome_id : null;
  }

  activeWaitConditions(task_id: string): JWaitCondition[] {
    return [...this.waitConditions.values()].filter(
      (w) => w.task_id === task_id && w.status === 'active',
    );
  }

  /** §3.1 待补集 = 最新有效 Acceptance 中 verdict=failed 的判据（REQ-ACC-3/S4）。 */
  pendingCriteria(task_id: string): string[] {
    const acceptance = this.effectiveAcceptance(task_id);
    if (!acceptance) return [];
    return acceptance.criterion_results
      .filter((r) => r.verdict === 'failed')
      .map((r) => r.criterion_ref);
  }

  contract(task_id: string, rev: number): JContract | null {
    return this.contracts.get(`${task_id}:${rev}`) ?? null;
  }

  liveAssignments(task_id: string): JAssignment[] {
    return [...this.assignments.values()].filter((a) => a.task_id === task_id && a.ended_at === null);
  }

  taskRuns(task_id: string): JRun[] {
    return [...this.runs.values()].filter((r) => r.task_id === task_id);
  }

  dataFromUpstream(downstream_task_id: string, upstream_task_id: string): JEdge[] {
    return [...this.edges.values()].filter(
      (e) => !e.removed && e.kind === 'data_from' &&
        e.from_task === upstream_task_id && e.to_task === downstream_task_id,
    );
  }

  snapshot(): JourneySnapshot {
    const byId = <T>(rows: Iterable<T>, key: (row: T) => string): T[] =>
      [...rows].sort((a, b) => key(a).localeCompare(key(b)));
    return {
      projects: byId(this.projects.values(), (r) => r.project_id),
      goals: byId(this.goals.values(), (r) => r.goal_id),
      tasks: byId(this.tasks.values(), (r) => r.task_id),
      contracts: byId(this.contracts.values(), (r) => `${r.task_id}:${r.rev}`),
      edges: byId(this.edges.values(), (r) => r.edge_id),
      changes: byId(this.changes.values(), (r) => r.change_id),
      assignments: byId(this.assignments.values(), (r) => r.assignment_id),
      runs: byId(this.runs.values(), (r) => r.run_id),
      feedbacks: byId(this.feedbacks.values(), (r) => r.feedback_id),
      outcomes: byId(this.outcomes.values(), (r) => r.outcome_id),
      evidences: byId(this.evidences.values(), (r) => r.evidence_id),
      acceptances: byId(this.acceptances.values(), (r) => r.acceptance_id),
      wait_conditions: byId(this.waitConditions.values(), (r) => r.wait_condition_id),
      decisions: byId(this.decisions.values(), (r) => r.decision_id),
      pointers: [...this.pointers].sort((a, b) => a.moved_at_seq - b.moved_at_seq),
      budget_ledger: [...this.budget],
      plan_rev: this.planRev,
      non_state_events: Object.fromEntries([...this.nonStateCounts.entries()].sort()),
    };
  }

  private mustTask(task_id: string, event: EventEnvelope): JTask {
    const task = this.tasks.get(task_id);
    if (!task) throw new Error(`${event.type}@${event.seq} 引用不存在的 Task ${task_id}`);
    return task;
  }

  private mustRun(run_id: string, event: EventEnvelope): JRun {
    const run = this.runs.get(run_id);
    if (!run) throw new Error(`${event.type}@${event.seq} 引用不存在的 Run ${run_id}`);
    return run;
  }

  private mustChange(change_id: string, event: EventEnvelope): JPlanChange {
    const change = this.changes.get(change_id);
    if (!change) throw new Error(`${event.type}@${event.seq} 引用不存在的 PlanChange ${change_id}`);
    return change;
  }

  private mustFeedback(feedback_id: string, event: EventEnvelope): JFeedback {
    const fb = this.feedbacks.get(feedback_id);
    if (!fb) throw new Error(`${event.type}@${event.seq} 引用不存在的 Feedback ${feedback_id}`);
    return fb;
  }

  private mustDecision(decision_id: string, event: EventEnvelope): JDecision {
    const decision = this.decisions.get(decision_id);
    if (!decision) throw new Error(`${event.type}@${event.seq} 引用不存在的 Decision ${decision_id}`);
    return decision;
  }

  private mustProject(project_id: string, event: EventEnvelope): JProject {
    const project = this.projects.get(project_id);
    if (!project) throw new Error(`${event.type}@${event.seq} 引用不存在的 Project ${project_id}`);
    return project;
  }
}

// ---------------------------------------------------------------------------
// 逐字段 diff（深比较，输出差异路径清单）
// ---------------------------------------------------------------------------

export function deepDiff(left: unknown, right: unknown, path = '$'): string[] {
  if (Object.is(left, right)) return [];

  if (Array.isArray(left) && Array.isArray(right)) {
    const diffs: string[] = [];
    if (left.length !== right.length) {
      diffs.push(`${path}.length: ${left.length} ≠ ${right.length}`);
    }
    const n = Math.min(left.length, right.length);
    for (let i = 0; i < n; i++) diffs.push(...deepDiff(left[i], right[i], `${path}[${i}]`));
    return diffs;
  }

  if (
    left !== null && right !== null &&
    typeof left === 'object' && typeof right === 'object' &&
    !Array.isArray(left) && !Array.isArray(right)
  ) {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    const diffs: string[] = [];
    for (const key of keys) diffs.push(...deepDiff(a[key], b[key], `${path}.${key}`));
    return diffs;
  }

  return [`${path}: ${JSON.stringify(left)} ≠ ${JSON.stringify(right)}`];
}
