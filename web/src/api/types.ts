// API DTO 类型 —— 与任务书 HTTP 接口契约 + docs/interaction-contract.md v0.2 对齐。
// 领域枚举与 src/domain/types.ts 同源（TaskLifecycle / TaskWaitState / RunState）。
// 约定：
// - 投影类响应必带 projection_version（该投影已并入的最大事件序号，任务书契约）。
// - 契约 §1.1 信封的 head_global_seq / lag_state 为可选补充：服务端提供时按契约呈现
//   （catching_up/rebuilding 与 as_of<head 同样显示同步徽标，F-011）；缺失时由
//   projection_version 与 SSE 已收事件 seq 推导（见 api/projection.ts）。
// - 标注 [web 层补充] 的字段是契约投影清单未列、但逐判据验收表单（OQ-03=A）必需的
//   投影字段；服务端未提供时 UI 降级提示，不自行推断领域状态。

export type TaskLifecycle =
  | 'captured'
  | 'defined'
  | 'ready'
  | 'active'
  | 'awaiting_acceptance'
  | 'accepted'
  | 'canceled';

export type TaskWaitState =
  | 'none'
  | 'waiting_on_person'
  | 'waiting_until'
  | 'waiting_on_dependency'
  | 'blocked'
  | 'on_hold';

export type RunState =
  | 'created'
  | 'queued'
  | 'leased'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'timed_out'
  | 'indeterminate';

export type AcceptanceVerdict = 'accepted' | 'rejected' | 'partially_accepted';

export type CriterionVerdict = 'passed' | 'failed' | 'not_applicable';

export type LagState = 'fresh' | 'catching_up' | 'rebuilding';

export type AttentionKind =
  | 'decision_pending'
  | 'acceptance_due'
  | 'run_indeterminate'
  | 'duplicate_suspect'
  | 'wait_expired'
  | 'cancel_pending';

// ---------- 投影信封 ----------

export interface ProjectionMeta {
  projection_version: number;
  head_global_seq?: number;
  lag_state?: LagState;
  generated_at?: string;
}

// ---------- Home（GET /api/home） ----------

export interface HomeProjection extends ProjectionMeta {
  projection_id: 'home';
  projects: HomeProjectSummary[];
  attention: AttentionItem[];
  recent: RecentActivity[];
}

export interface HomeProjectSummary {
  project_id: string;
  name: string;
  goal_statement: string | null;
  goal_status: 'active' | 'achieved' | 'abandoned' | null;
  task_counts: Record<TaskLifecycle, number>;
  last_activity_at: string | null;
}

export interface AttentionItem {
  attention_id: string;
  kind: AttentionKind;
  project_id: string;
  task_id?: string;
  decision_id?: string;
  /** 内核计算（OQ-08=A），前端只按此排序 */
  rank: number;
  available_actions: string[];
  created_at: string;
}

export interface RecentActivity {
  event_id: string;
  project_id: string;
  task_id?: string;
  /** 服务端确定性文案，不由前端拼领域结论 */
  summary: string;
  occurred_at: string;
}

// ---------- My Actions（GET /api/actions） ----------

export interface MyActionsProjection extends ProjectionMeta {
  projection_id: 'my_actions';
  items: ActionItem[];
}

export interface ActionItem {
  item_id: string;
  kind: 'task' | 'decision';
  project_id: string;
  task_id?: string;
  decision_id?: string;
  task_lifecycle?: TaskLifecycle;
  task_wait_state?: TaskWaitState;
  active_run?: {
    run_id: string;
    run_kind: 'executor' | 'human_light';
    state: RunState;
  };
  decision?: {
    question: string;
    recommendation: string | null;
    alternatives: string[];
    evidence_refs: string[];
    status: 'pending' | 'approved' | 'approved_modified' | 'rejected' | 'deferred' | 'expired';
    expires_at: string | null;
  };
  /** 内核计算（OQ-08=A），前端只排序 */
  rank: number;
  available_actions: string[];
  /** 如 no_capable_actor、wait_state（§0.4：禁用必须给原因码） */
  blocked_reason: string | null;
  updated_global_seq: number;
}

// ---------- Project（GET /api/projects/:projectId） ----------

/**
 * 项目级验收摘要（FIX-ROUND-1 R-8 新增键）。
 * 口径为内核计算，前端只呈现、不自行统计（与 rank/verdict 同纪律）。
 */
export interface ProjectAcceptanceStatus {
  /** awaiting_acceptance 任务 id —— Project 是验收动作落点（OQ-02=A） */
  awaiting_task_ids: string[];
  /** 已落 AcceptanceRecorded 最终 verdict 的任务数 */
  recorded_count: number;
  /** partially_accepted 且仍有待补判据的任务（部分通过待续） */
  outstanding: Array<{ task_id: string; title: string; pending_criteria: string[] }>;
}

/**
 * 项目内待处理提议（FIX-ROUND-1 R-8 新增键）：从 Project 直达提议页。
 * 提议只携带 draft（标题 + 验收判据）；task_id 在提议接受后由服务端新发（R-11）。
 */
export interface PendingProposal {
  proposal_id: string;
  capture_id: string;
  summary: string;
  created_at: string;
  /** 服务端广告的动作（canonical 词表，R-1） */
  available_actions: string[];
}

export interface ProjectProjection extends ProjectionMeta {
  projection_id: 'project';
  /** 项目标识（R-8：原顶层 project_id/name 收入此子对象） */
  project: { project_id: string; name: string };
  goal: {
    statement: string;
    success_criteria: string;
    stop_conditions: string;
    status: 'active' | 'achieved' | 'abandoned';
  } | null;
  tasks: ProjectTaskRow[];
  acceptance_status: ProjectAcceptanceStatus;
  /** 聚焦子图（R-8：原 focused_subgraph 改名 graph），固定 1-hop depends_on + data_from，只读（OQ-09=A） */
  graph: ProjectGraph | null;
  pending_proposals: PendingProposal[];
}

export interface ProjectTaskRow {
  task_id: string;
  title: string;
  lifecycle: TaskLifecycle;
  wait_state: TaskWaitState;
  duplicate_suspect: boolean;
  current_contract_rev: number;
  assignee: { actor_id: string; actor_kind: 'human' | 'agent' } | null;
  active_run: { run_id: string; state: RunState; run_kind: 'executor' | 'human_light' } | null;
  last_outcome_id: string | null;
  acceptance_summary: {
    verdict: AcceptanceVerdict | null;
    pending_criteria: string[];
  };
  available_actions: string[];
  updated_global_seq: number;
  // [web 层补充] 逐判据验收表单（OQ-03=A）所需；服务端未提供时 UI 降级。
  acceptance_criteria?: AcceptanceCriterion[];
  criterion_results?: CriterionResult[];
  acceptance?: AcceptanceRecord | null;
}

export interface AcceptanceCriterion {
  criterion_ref: string;
  text: string;
  kind: 'auto' | 'manual';
}

export interface CriterionResult {
  criterion_ref: string;
  verdict: CriterionVerdict;
  note?: string | null;
  evidence_refs?: string[];
}

export interface AcceptanceRecord {
  acceptance_id: string;
  contract_rev: number;
  subject_outcome_id: string | null;
  acceptor_id: string;
  verdict: AcceptanceVerdict;
  criterion_results: CriterionResult[];
  rationale?: string | null;
  created_at: string;
  superseded?: boolean;
}

export interface ProjectGraph {
  root_task_id: string;
  nodes: Array<{ task_id: string; title: string; lifecycle: TaskLifecycle }>;
  edges: Array<{
    edge_id: string;
    from_task: string;
    to_task: string;
    kind: 'depends_on' | 'data_from';
    data_mode?: string;
    release_override_active?: boolean;
  }>;
}

// ---------- Proposal（GET /api/proposals/:proposalId） ----------

export interface ProposalProjection extends ProjectionMeta {
  projection_id: 'proposal';
  proposal_id: string;
  capture_id: string;
  project_id: string;
  /** 降级提议标记（任务书红线：必须在提议卡片上明示，不许隐藏） */
  degraded: boolean;
  degraded_reason?: string | null;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  created_at: string;
  summary: string;
  proposed: {
    title: string;
    description: string;
    acceptance_criteria: AcceptanceCriterion[];
    assignee_hint?: string | null;
  };
  available_actions: string[];
}

// ---------- Capture（POST /api/capture） ----------

export interface CaptureRequest {
  text: string;
  /** 客户端为每次提交生成的唯一值（§0.5 幂等；重试复用同一个） */
  client_submit_id: string;
}

export interface CaptureResponse {
  capture_id: string;
  proposal_id?: string;
}

// ---------- 命令（POST /api/commands） ----------

/**
 * 服务端命令词表（canonical，唯一正本；协调者 FIX-ROUND-1 R-1 定版，共 6 词）：
 *   proposal_accept / proposal_reject / task_advance / feedback_submit /
 *   acceptance_record / task_cancel
 * 界面 available_actions 一律以服务端为准，不许自造动作。原 web 车道 7 动词
 * 到本词表的映射（FIX-ROUND-1 R-1）：
 *   accept_proposal          → proposal_accept
 *   reject_proposal          → proposal_reject
 *   start_task / complete_task → task_advance（按任务当前生命周期分派，见 mock/commands.ts）
 *   record_criterion_verdict → acceptance_record
 *   cancel_task              → task_cancel
 * 原 resolve_decision 无服务端对应，本轮已下线动作入口（契约缺口登记见
 * web/README.md「已知边界」，待协调者裁决后再恢复）。
 * feedback_submit 在词表内但 K0 无界面入口（捕获走 /api/capture 专用端点，
 * 不经命令入口）；mock 对其返回 command_not_implemented_in_mock。
 */
export type CommandType =
  | 'proposal_accept'
  | 'proposal_reject'
  | 'task_advance'
  | 'feedback_submit'
  | 'acceptance_record'
  | 'task_cancel';

/** canonical 词表全量（单一来源：mock 校验命令体形状以此为准）。 */
export const CANONICAL_COMMAND_TYPES: readonly CommandType[] = [
  'proposal_accept',
  'proposal_reject',
  'task_advance',
  'feedback_submit',
  'acceptance_record',
  'task_cancel',
];

export interface CommandRequest {
  type: CommandType;
  payload: Record<string, unknown>;
  client_submit_id: string;
}

/** 202 + receipt = 已受理，不表示领域动作已完成（§0.5） */
export interface CommandReceipt {
  status: 'accepted' | 'duplicate';
  client_submit_id: string;
  command_id?: string;
  message?: string;
}

// ---------- SSE（GET /api/stream?cursor=<seq>） ----------

export interface StreamEvent {
  /** 事件序号（心跳帧同样携带，用于游标对齐） */
  seq: number;
  /** 事件类型（内核事件目录封闭集）或 'heartbeat' */
  kind: string;
  project_id?: string;
  [key: string]: unknown;
}

/**
 * health 端点信封内的 data（FIX-ROUND-1 R-2：health 与其他端点同样统一信封，
 * 响应为 {ok:true, data:{...}}；http 层解包后业务只拿下面的形状）。
 */
export interface HealthResponse {
  ok: boolean;
  /** 数据库连接态（如 'ok'）；K0 界面未消费，仅客户端保留端点封装。 */
  db: string;
  projection_version: number;
}
