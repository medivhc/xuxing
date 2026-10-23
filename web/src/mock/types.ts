// Mock 层内部类型（不进生产构建路径；与 api/types.ts 的 DTO 一一对应，
// 但携带投影不暴露的服务端内部事实，如 executed_by（actor 分离校验用））。

import type {
  AcceptanceCriterion,
  AcceptanceRecord,
  CriterionResult,
  LagState,
  RunState,
  TaskLifecycle,
  TaskWaitState,
} from '../api/types';

/** Mock 固定 actor：人类用户（界面操作者/执行者）、验收者（REQ-ACC-2 要求与执行者分离）、
 * 执行 agent。K0 无用户体系，mock 以三个固定 actor 演示 actor 分离校验。 */
export const MOCK_HUMAN_ACTOR = 'human-user';
export const MOCK_ACCEPTOR_ACTOR = 'human-reviewer';
export const MOCK_AGENT_ACTOR = 'agent-exec-1';

export interface MockActor {
  actor_id: string;
  actor_kind: 'human' | 'agent';
}

export interface MockTaskState {
  task_id: string;
  title: string;
  description: string;
  lifecycle: TaskLifecycle;
  wait_state: TaskWaitState;
  duplicate_suspect: boolean;
  current_contract_rev: number;
  assignee: MockActor | null;
  active_run: { run_id: string; state: RunState; run_kind: 'executor' | 'human_light' } | null;
  last_outcome_id: string | null;
  acceptance_criteria: AcceptanceCriterion[];
  criterion_results: CriterionResult[];
  /** 最新有效 Acceptance（partially 时 pending_criteria 非空） */
  acceptance: AcceptanceRecord | null;
  /** 执行最近一次 Run 的 actor（验收 actor 分离校验，REQ-ACC-2） */
  executed_by: string | null;
  updated_global_seq: number;
}

export interface MockDecisionState {
  decision_id: string;
  project_id: string;
  question: string;
  recommendation: string | null;
  alternatives: string[];
  evidence_refs: string[];
  status: 'pending' | 'approved' | 'approved_modified' | 'rejected' | 'deferred' | 'expired';
  expires_at: string | null;
  created_at: string;
  updated_global_seq: number;
}

export interface MockProposalState {
  proposal_id: string;
  capture_id: string;
  project_id: string;
  degraded: boolean;
  degraded_reason: string | null;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  created_at: string;
  summary: string;
  proposed: {
    title: string;
    description: string;
    acceptance_criteria: AcceptanceCriterion[];
    assignee_hint: string | null;
  };
  updated_global_seq: number;
}

export interface MockCaptureState {
  capture_id: string;
  project_id: string;
  text: string;
  proposal_id: string | null;
  created_at: string;
}

export interface MockProjectState {
  project_id: string;
  name: string;
  goal: {
    statement: string;
    success_criteria: string;
    stop_conditions: string;
    status: 'active' | 'achieved' | 'abandoned';
  } | null;
  plan_rev: number;
  plan_history: Array<{ rev: number; applied_at: string; diff_summary: string }>;
}

/** 种子事件：只描述历史（seq 由 store 分配）；投影状态在 seed.ts 手工给出。 */
export interface SeedEvent {
  kind: string;
  project_id?: string;
  task_id?: string;
  proposal_id?: string;
  decision_id?: string;
  summary?: string;
  payload?: Record<string, unknown>;
}

export interface MockSnapshot {
  project: MockProjectState;
  tasks: MockTaskState[];
  decisions: MockDecisionState[];
  proposals: MockProposalState[];
  captures: MockCaptureState[];
  events: Array<{ seq: number; kind: string }>;
  lagState: LagState | null;
  heartbeatsEnabled: boolean;
  forceNextProposalDegraded: boolean;
}
