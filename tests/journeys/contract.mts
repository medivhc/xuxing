// HTTP API 契约（协调者定版）的 DTO 与封闭枚举。
//
// 本文件是 mock 与测试共用的「契约正本」在代码里的映射：
//   - 只描述 HTTP 响应形状，不描述数据库/内核内部结构；
//   - 测试断言投影字段时用这里的类型，避免各自手写 any；
//   - 事件 type 名对齐内核 §4 封闭目录（src/kernel/events.ts），kind 是 SSE 传输层分类。
//
// 命名冲突登记：任务指令写「落 FeedbackCaptured」，而内核事件目录只有
// FeedbackReceived（src/kernel/events.ts）。mock 的 SSE kind 用契约语义
// feedback.captured，domain type 用内核的 FeedbackReceived —— 两者都保留，
// 交卷的「契约冲突」一节记录此差异，未擅自改契约或内核。

/** POST /api/commands 允许的命令类型（封闭集）。 */
export const COMMAND_TYPES = [
  'accept_proposal',
  'reject_proposal',
  'complete_task',
  'record_acceptance',
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];

/** 内核 §3.1 任务生命周期子集（本 mock 只建模旅程需要的那几格）。 */
export type TaskLifecycle =
  | 'defined'
  | 'ready'
  | 'active'
  | 'awaiting_acceptance'
  | 'accepted'
  | 'canceled';

export type CriterionKind = 'auto' | 'manual';
export type CriterionVerdict = 'passed' | 'failed';
export type AcceptanceVerdict = 'accepted' | 'rejected' | 'partially_accepted';

export interface Criterion {
  criterion_ref: string;
  kind: CriterionKind;
  label: string;
}

export interface CriterionResult {
  criterion_ref: string;
  verdict: CriterionVerdict;
  evidence_refs: string[];
}

export interface ProposedTask {
  task_id: string;
  title: string;
  assignee_id: string;
  assignee_kind: 'human' | 'agent';
  criteria: Criterion[];
}

export interface ProposalProjection {
  projection_version: number;
  proposal_id: string;
  project_id: string;
  capture_id: string;
  status: 'proposed' | 'accepted' | 'rejected';
  degraded: boolean;
  degraded_reasons: string[];
  summary: string;
  rationale: string;
  proposed_tasks: ProposedTask[];
  /** 内核复核用：当前 actor 对该提议可执行的动作；已决提议为空。 */
  available_actions: CommandType[];
  created_at: string;
  decided_at: string | null;
}

export interface ProjectTaskNode {
  task_id: string;
  title: string;
  lifecycle: TaskLifecycle;
  wait_state: string;
  intended_assignee_id: string;
  assignee_kind: 'human' | 'agent';
  current_contract_rev: number;
  criteria: Criterion[];
  criterion_results: CriterionResult[];
  available_actions: CommandType[];
  degraded: boolean;
  created_from_proposal: string | null;
  outcome: { outcome_id: string; conclusion_kind: string; recorded_at: string } | null;
  last_acceptance: {
    acceptance_id: string;
    verdict: AcceptanceVerdict;
    recorded_at: string;
  } | null;
}

export interface ProjectProjection {
  projection_version: number;
  project_id: string;
  title: string;
  plan_rev: number;
  goal: { goal_id: string; text: string; status: 'draft' | 'in_progress' | 'achieved' };
  task_graph: {
    nodes: ProjectTaskNode[];
    edges: { edge_id: string; from_task: string; to_task: string; kind: string }[];
  };
  acceptance: {
    status: 'not_started' | 'pending' | 'partially_accepted' | 'in_progress' | 'accepted';
    accepted_tasks: number;
    active_tasks: number;
    total_tasks: number;
    canceled_tasks: number;
    awaiting_tasks: number;
    pending_criteria: { task_id: string; criterion_ref: string }[];
    last_acceptance: {
      acceptance_id: string;
      task_id: string;
      verdict: AcceptanceVerdict;
      recorded_at: string;
    } | null;
  };
  provenance: { degraded_proposals: number; degraded_tasks: number };
}

export interface ActionRow {
  action_id: string;
  project_id: string;
  task_id: string;
  title: string;
  lifecycle: TaskLifecycle;
  available_actions: CommandType[];
  blocked_reasons: string[];
  pending_criteria: string[];
  degraded: boolean;
}

export interface ActionsProjection {
  projection_version: number;
  actor_id: string;
  actions: ActionRow[];
}

export interface HomeProjection {
  projection_version: number;
  pending_actions_count: number;
  projects: {
    project_id: string;
    title: string;
    goal_text: string;
    goal_status: 'draft' | 'in_progress' | 'achieved';
    task_summary: {
      active_tasks: number;
      accepted_tasks: number;
      awaiting_acceptance: number;
      canceled_tasks: number;
    };
    acceptance_status: ProjectProjection['acceptance']['status'];
    pending_actions_count: number;
    degraded: boolean;
    updated_at: string;
  }[];
  recent_activity: {
    seq: number;
    kind: string;
    type: string;
    project_id: string;
    summary: string;
    degraded: boolean;
    occurred_at: string;
  }[];
}

export interface CaptureResponse {
  capture_id: string;
  proposal_id: string | null;
  projection_version: number;
}

export interface CommandReceipt {
  client_submit_id: string;
  command_type: CommandType;
  accepted_at: string;
  /** 该命令产生的最后一条事件的全局序号；幂等重放时返回首次值。 */
  seq: number;
  projection_version: number;
  duplicate: boolean;
}

export interface CommandResponse {
  receipt: CommandReceipt;
  projection_version: number;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    available_actions?: CommandType[];
    details?: Record<string, unknown>;
  };
  projection_version?: number;
}

export interface HealthResponse {
  ok: true;
  service: string;
  mock: boolean;
  limits: {
    max_connections: number;
    max_pending_per_connection: number;
    slow_consumer_timeout_ms: number;
    pump_interval_ms: number;
    heartbeat_ms: number;
  };
  streams: { active: number };
}

/** SSE update 帧的 data（契约要求含 seq 与 kind）。 */
export interface StreamEventFrame {
  seq: number;
  kind: string;
  type: string;
  project_id: string;
  entity_id: string;
  summary: string;
  degraded: boolean;
  occurred_at: string;
}

export type CommandPayload =
  | { proposal_id: string }
  | { task_id: string }
  | { task_id: string; criterion_results: CriterionResult[]; rationale?: string };
