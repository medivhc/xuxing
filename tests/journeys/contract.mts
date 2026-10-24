// HTTP API 契约（协调者定版，FIX-ROUND-1 裁决 R-1/R-2/R-7/R-8）的 DTO 与封闭枚举。
//
// 本文件是 mock 与测试共用的「契约正本」在代码里的映射：
//   - 只描述 HTTP 响应形状，不描述数据库/内核内部结构；
//   - 测试断言投影字段时用这里的类型，避免各自手写 any；
//   - 事件 kind 对齐内核封闭目录（src/kernel/events.ts）的 PascalCase 领域事件名。
//
// 定版要点：
//   R-1 命令词表 = proposal_accept / proposal_reject / task_advance /
//       feedback_submit / acceptance_record / task_cancel；available_actions 是
//       **canonical command_type 字符串数组**（不是 {id, command_type} 对象数组）。
//   R-2 全部端点统一信封：成功 {ok:true, data}，失败 {ok:false, error}；客户端一律从
//       data 里读字段（capture_id / projection_version / limits …）。
//   R-7 种子契约：演示项目 proj_demo_oq05 / 目标 goal_demo_oq05 / actor user_demo；
//       降级夹具 proj-degraded + prop-degraded-1；提议不预告 task_id。
//   R-8 项目视图 data 键集 = {project, goal, tasks, acceptance_status, graph, pending_proposals}。
//   R-9 SSE 帧 kind = 内核事件 PascalCase（捕获反馈是 FeedbackReceived）。

/** POST /api/commands 允许的命令类型（封闭集，R-1 定版）。 */
export const COMMAND_TYPES = [
  'proposal_accept',
  'proposal_reject',
  'task_advance',
  'feedback_submit',
  'acceptance_record',
  'task_cancel',
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];

/** 内核 §3.1 任务生命周期（投影 `lifecycle` 的取值域）。 */
export type TaskLifecycle =
  | 'captured'
  | 'defined'
  | 'ready'
  | 'active'
  | 'awaiting_acceptance'
  | 'accepted'
  | 'canceled';

export type CriterionVerdict = 'passed' | 'failed' | 'not_applicable';
export type AcceptanceVerdict = 'accepted' | 'rejected' | 'partially_accepted';

/** 验收判据（内核 AcceptanceCriterion：ref + 文案 + 是否可自动核对）。 */
export interface AcceptanceCriterion {
  criterion_ref: string;
  text: string;
  auto: boolean;
}

export interface CriterionResult {
  criterion_ref: string;
  verdict: CriterionVerdict;
  evidence_refs: string[];
}

// ---------------------------------------------------------------------------
// 信封（R-2）
// ---------------------------------------------------------------------------

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
}

export interface ApiErrorBody {
  ok: false;
  error: {
    code: string;
    message: string;
    detail?: unknown;
  };
}

export type Envelope<T> = SuccessEnvelope<T> | ApiErrorBody;

/** 全部投影/视图共有的元信息：projection_version = 已并入的最大 global_seq。 */
export interface ProjectionMeta {
  projection_version: number;
}

// ---------------------------------------------------------------------------
// GET /api/health（R-2：health 也走信封，data 内含 ok / db / limits）
// ---------------------------------------------------------------------------

export interface RuntimeLimits {
  heartbeat_ms: number;
  max_connections: number;
  max_queue: number;
}

export interface HealthData extends ProjectionMeta {
  ok: boolean;
  db: boolean;
  limits: RuntimeLimits;
}

export type HealthResponse = SuccessEnvelope<HealthData>;

// ---------------------------------------------------------------------------
// GET /api/home
// ---------------------------------------------------------------------------

export interface HomeProjectSummary {
  project_id: string;
  name: string;
  goal_statement: string | null;
  goal_status: string | null;
  task_counts: Record<string, number>;
  total_tasks: number;
  accepted_tasks: number;
  last_event_at: string | null;
}

export interface HomeActivity {
  seq: number;
  /** 内核事件类型（PascalCase，R-9） */
  kind: string;
  project_id: string;
  task_id: string | null;
  occurred_at: string;
  summary: string;
}

export interface HomeData extends ProjectionMeta {
  actor_id: string;
  projects: HomeProjectSummary[];
  my_actions_count: number;
  recent_activity: HomeActivity[];
  proposals: { pending: number; degraded: number };
}

export type HomeResponse = SuccessEnvelope<HomeData>;

// ---------------------------------------------------------------------------
// GET /api/actions（My Actions）
// ---------------------------------------------------------------------------

export interface ActionItem {
  task_id: string;
  project_id: string;
  project_name: string;
  title: string;
  lifecycle: TaskLifecycle;
  wait_state: string;
  next_action: string;
  available_actions: CommandType[];
  updated_global_seq: number;
}

export interface ActionsData extends ProjectionMeta {
  actor_id: string;
  items: ActionItem[];
}

export type ActionsResponse = SuccessEnvelope<ActionsData>;

// ---------------------------------------------------------------------------
// GET /api/projects/:projectId（R-8 键集）
// ---------------------------------------------------------------------------

export interface ProjectHeader {
  project_id: string;
  name: string;
  policy_id: string;
  created_by: string;
}

export interface ProjectGoal {
  goal_id: string;
  statement: string;
  success_criteria: string;
  stop_conditions: string;
  /** 目标状态取值域（真服务与 web 均用 active/achieved/abandoned） */
  status: string;
}

export interface ProjectTaskRow {
  task_id: string;
  project_id: string;
  title: string;
  description: string;
  lifecycle: TaskLifecycle;
  wait_state: string;
  assignee_kind: 'human' | 'agent';
  assigned_by: string | null;
  duplicate_suspect: boolean;
  capture_id: string | null;
  proposal_id: string | null;
  current_contract_rev: number;
  last_outcome_id: string | null;
  feedback_count: number;
  cancel_requested: boolean;
  acceptance_criteria: AcceptanceCriterion[];
  acceptance: {
    acceptance_id: string;
    verdict: AcceptanceVerdict;
    criterion_results: CriterionResult[];
    created_at: string;
  } | null;
  active_wait_conditions: Array<{ wait_condition_id: string; kind: string; target_ref: string }>;
  available_actions: CommandType[];
  updated_global_seq: number;
}

export interface ProjectAcceptanceStatus {
  accepted: number;
  awaiting: number;
  rejected: number;
  total: number;
  criterion_summary: Array<{ task_id: string; criterion_ref: string; verdict: string }>;
}

export interface ProjectGraph {
  nodes: Array<{ id: string; title: string; lifecycle: TaskLifecycle }>;
  edges: Array<{ from: string; to: string; kind: string }>;
}

export interface PendingProposal {
  proposal_id: string;
  kind: string;
  status: string;
  degraded: boolean;
  rationale: string;
  created_at: string;
}

export interface ProjectData extends ProjectionMeta {
  project: ProjectHeader;
  goal: ProjectGoal | null;
  tasks: ProjectTaskRow[];
  acceptance_status: ProjectAcceptanceStatus;
  graph: ProjectGraph;
  pending_proposals: PendingProposal[];
}

export type ProjectResponse = SuccessEnvelope<ProjectData>;

// ---------------------------------------------------------------------------
// GET /api/proposals/:proposalId（R-11：提议不预告 task_id）
// ---------------------------------------------------------------------------

export interface ProposalDraft {
  title: string;
  description: string;
  assignee_kind: 'human' | 'agent';
  acceptance_criteria: AcceptanceCriterion[];
}

export interface ProposalDetails {
  kind: 'capture_task';
  task: ProposalDraft;
}

export interface ProposalData extends ProjectionMeta {
  proposal_id: string;
  project_id: string;
  kind: string;
  status: 'proposed' | 'accepted' | 'rejected';
  status_reason: string | null;
  capture_id: string | null;
  /** 提议接受前恒为 null：任务 id 只由服务端在 proposal_accept 后发号（R-11）。 */
  task_id: string | null;
  rationale: string;
  assumptions: string[];
  risk_level: string;
  base_plan_rev: number;
  ops: unknown[];
  degraded: boolean;
  proposer: {
    source: 'model' | 'fallback';
    model: string | null;
    degraded: boolean;
    degraded_reason: string | null;
    latency_ms: number | null;
  };
  details: ProposalDetails;
  created_at: string;
  available_actions: CommandType[];
}

export type ProposalResponse = SuccessEnvelope<ProposalData>;

// ---------------------------------------------------------------------------
// POST /api/capture
// ---------------------------------------------------------------------------

export interface CaptureData extends ProjectionMeta {
  capture_id: string;
  proposal_id: string;
  project_id: string;
  degraded: boolean;
  degraded_reason: string | null;
  proposer: { source: 'model' | 'fallback'; model: string | null; latency_ms: number | null };
  draft: ProposalDraft;
  replayed: boolean;
  emitted: Array<{ seq: number; kind: string }>;
}

export type CaptureResponse = SuccessEnvelope<CaptureData>;

// ---------------------------------------------------------------------------
// POST /api/commands（R-6：首次 201，幂等重放 200 + replayed:true）
// ---------------------------------------------------------------------------

export interface CommandResultData extends ProjectionMeta {
  command_type: CommandType;
  client_submit_id: string;
  /** true = 幂等重放，未产生新事件 */
  replayed: boolean;
  emitted: Array<{ seq: number; kind: string }>;
  subject: Record<string, unknown>;
  receipt_event_id: string;
}

export type CommandResponse = SuccessEnvelope<CommandResultData>;

// ---------------------------------------------------------------------------
// GET /api/stream（SSE，R-9：kind = 内核事件 PascalCase）
// ---------------------------------------------------------------------------

export interface StreamEventFrame extends ProjectionMeta {
  seq: number;
  /** 内核事件类型（PascalCase 领域事件名，如 FeedbackReceived / PlanChangeProposed） */
  kind: string;
  stream_id: string;
  project_id: string;
  task_id: string | null;
  proposal_id: string | null;
  occurred_at: string;
}

/** SSE ready 帧（真服务在补发之后、实时之前发一次）。 */
export interface StreamReadyFrame {
  projection_version: number;
  cursor: number | null;
  requested_cursor: number | null;
  replayed: number;
  project_id: string | null;
  heartbeat_ms: number;
}

/** 业务提示帧（不占 seq）：降级提议必须在此明示（R-9 保留该断言）。 */
export interface StreamNoticeFrame {
  kind: string;
  proposal_id?: string;
  degraded_reason?: string;
  [key: string]: unknown;
}

/** POST /api/dev/burst 的响应（mock-only，mock 背压造流用）。 */
export interface DevBurstData {
  emitted: number;
  projection_version: number;
}
