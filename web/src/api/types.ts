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
  actor_id: string;
  items: ActionItem[];
}

// 形状以服务端 server/src/api/views.ts 的 ActionItem / myActionItems 为准
// （FIX-ROUND-4 对齐真投影，与 tests/journeys/contract.mts 同定义）。
// 此前本节按 mock 形状写：item_id/kind/task|decision 联合、rank、decision
// 包装、blocked_reason——真投影一样都没有，已部署「待我处理」页把每条任务
// 都误判为 decision 行、只渲染下线占位卡（ACTIONS-EMPTY-1024）。真投影是
// 扁平任务列表：只有任务、只有标题/项目名/下一步标签，不发明投影字段。
// 决策待办不经此端点（服务端 myActionItems 只产任务）：决策在 Home
// attention 呈现并跳项目页（FIX-ROUND-3 裁决；resolve_decision 仍属 K1 缺口）。
export interface ActionItem {
  task_id: string;
  project_id: string;
  project_name: string;
  title: string;
  lifecycle: TaskLifecycle;
  wait_state: TaskWaitState;
  /** 内核给出的下一步标签（给用户看的文案，不是 command_type） */
  next_action: string;
  available_actions: string[];
  updated_global_seq: number;
}

// ---------- Project（GET /api/projects/:projectId） ----------
// 形状以服务端 server/src/api/views.ts 的 ProjectView 为准（FIX-ROUND-3 对齐真投影）。
// 此前本节按 mock 形状写：acceptance_status 是 {awaiting_task_ids, recorded_count,
// outstanding}、任务行带 acceptance_summary——真投影两样都没有，项目页一读即崩
// （CLICK-AUDIT §2-2）。前端不许再造字段：缺的展示信息按契约缺口登记，不前端推断。

/** 项目级验收计数（服务端计算：按 lifecycle 与有效 Acceptance 统计，前端只呈现） */
export interface ProjectAcceptanceStatus {
  accepted: number;
  awaiting: number;
  rejected: number;
  total: number;
  /** 有效验收的逐判据结果汇总（服务端平铺，前端只呈现） */
  criterion_summary: Array<{ task_id: string; criterion_ref: string; verdict: CriterionVerdict }>;
}

/** 项目内待处理提议（真投影无 summary/capture_id/available_actions 键） */
export interface PendingProposal {
  proposal_id: string;
  kind: string;
  status: string;
  degraded: boolean;
  /** 提议理由（列表展示文本以此为准） */
  rationale: string;
  created_at: string;
}

export interface ProjectProjection extends ProjectionMeta {
  projection_id: 'project';
  project: { project_id: string; name: string; policy_id: string; created_by: string };
  goal: {
    goal_id: string;
    statement: string;
    success_criteria: string;
    stop_conditions: string;
    status: string;
  } | null;
  tasks: ProjectTaskRow[];
  acceptance_status: ProjectAcceptanceStatus;
  /** 聚焦子图（服务端现口径：全部项目任务节点、edges 恒空；节点 id 即 task_id） */
  graph: ProjectGraph | null;
  pending_proposals: PendingProposal[];
}

export interface ProjectTaskRow {
  task_id: string;
  project_id: string;
  title: string;
  description: string;
  lifecycle: TaskLifecycle;
  wait_state: TaskWaitState;
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
  /** 最新有效验收摘要（服务端只给四键：id/verdict/逐判据结果/时间，非完整记录） */
  acceptance: {
    acceptance_id: string;
    verdict: AcceptanceVerdict;
    criterion_results: CriterionResult[];
    created_at: string;
  } | null;
  active_wait_conditions: Array<{ wait_condition_id: string; kind: string; target_ref: string }>;
  available_actions: string[];
  updated_global_seq: number;
}

export interface AcceptanceCriterion {
  criterion_ref: string;
  text: string;
  /** 真形状为布尔（内核 AcceptanceCriterion.auto）；此前 web 按 kind:'auto'|'manual' 写，恒判错 */
  auto: boolean;
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
  nodes: Array<{ id: string; title: string; lifecycle: TaskLifecycle }>;
  edges: Array<{ from: string; to: string; kind: string }>;
}

// ---------- Proposal（GET /api/proposals/:proposalId） ----------
// 形状以服务端 ProposalView 为准（FIX-ROUND-3）：无 proposed/summary 键——草案在
// details（按 kind 分派的联合）；降级原因在 proposer.degraded_reason；状态词为
// proposed/applied/rejected/needs_decision。此前 web 按 pending + proposed.* 写，
// 提议页读 data.proposed.title 直接崩（CLICK-AUDIT §2-3），且 pending 判定恒假。

export type ProposalStatus = 'proposed' | 'applied' | 'rejected' | 'needs_decision';

export type ProposalDetails =
  | {
      kind: 'capture_task';
      task: {
        title: string;
        description: string;
        assignee_kind: 'human' | 'agent';
        acceptance_criteria: AcceptanceCriterion[];
      };
    }
  | { kind: 'human_light_run'; task_id: string; suggested_run_kind: 'human_light'; next_action: string }
  | { kind: 'wait_condition'; task_id: string; wait: { kind: string; target_ref: string; reason: string } };

export interface ProposalProjection extends ProjectionMeta {
  projection_id: 'proposal';
  proposal_id: string;
  project_id: string;
  kind: string;
  status: ProposalStatus;
  status_reason: string | null;
  capture_id: string | null;
  /** 接受后服务端新发的任务 id（R-11：未接受时恒 null，本页不预分配） */
  task_id: string | null;
  rationale: string;
  assumptions: string[];
  risk_level: string;
  /** 降级标记（任务书红线：必须在提议卡片上明示，不许隐藏） */
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
