// 脊柱领域类型 —— 与冻结 spec K0-SPEC v1.0 §2/§3 对应。
// 只放枚举与实体形状；行为（迁移校验、ready 计算、验收重算）在 kernel 模块实现，
// 且必须以 spec 的迁移矩阵与 REQ 条目为唯一依据。

export type TaskLifecycle =
  | 'captured' | 'defined' | 'ready' | 'active'
  | 'awaiting_acceptance' | 'accepted' | 'canceled';

export type TaskWaitState =
  | 'none' | 'waiting_on_person' | 'waiting_until'
  | 'waiting_on_dependency' | 'blocked' | 'on_hold';

export type RunState =
  | 'created' | 'queued' | 'leased' | 'running' | 'succeeded'
  | 'failed' | 'canceled' | 'timed_out' | 'indeterminate';

export type EdgeKind =
  | 'depends_on' | 'data_from' | 'part_of'
  | 'related_to' | 'conflicts_with' | 'supersedes';

export type SideEffectLevel = 'L0' | 'L1' | 'L2' | 'L3';

export type ConclusionKind =
  | 'achieved' | 'partial' | 'infeasible' | 'no_response' | 'unknown';

export type EvidenceSourceKind =
  | 'user_statement' | 'agent_claim' | 'tool_output' | 'external_doc' | 'device_log';

export interface Task {
  id: string;
  project_id: string;
  goal_id: string | null;
  title: string;
  description: string;
  lifecycle: TaskLifecycle;
  wait_state: TaskWaitState;
  current_contract_rev: number;
  plan_rev_introduced: number;
  duplicate_suspect: boolean;
}

export interface Run {
  id: string;
  task_id: string;
  assignment_id: string;
  task_rev: number;
  contract_rev: number;
  plan_rev: number;
  input_snapshot: unknown; // 不可变（INV-3）
  policy_snapshot: unknown; // 不可变（INV-3）
  actor_id: string;
  actor_version: string;
  idempotency_key: string;
  side_effect_level: SideEffectLevel;
  state: RunState;
  lease_expires_at: string | null;
  heartbeat_at: string | null; // 心跳不是领域事件（REQ-RUN-1），只更新本行
}

export interface OutcomeDimensions {
  info_obtained: boolean;
  conclusion_kind: ConclusionKind;
  certainty: 'low' | 'med' | 'high';
  evidence_sufficiency: 'sufficient' | 'insufficient' | 'none';
  blockers: string[]; // 只供人阅读与 Planner 参考；内核判定不得解析其文本（REQ-OC-2）
  followup_suggestions: string[]; // 同上
}
