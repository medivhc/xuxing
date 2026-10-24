// HTTP 视图（§4 契约的响应形状）。投影类响应一律带 projection_version（= 已并入最大 global_seq）。
// 视图只做"投影 → 响应"的形状映射，不重算任何状态判定：available_actions 来自 projection/actions.ts（内核 guard）。

import type { ProjectionSnapshot } from '../projection/projection.ts';
import { computeAvailableActions, isActionableFor } from '../projection/actions.ts';
import type { ProjectionMeta } from '../api/http.ts';

export interface Actor {
  /** 当前用户（K0 单用户；由请求头 x-xuxing-actor 注入，缺省 demo 用户） */
  actor_id: string;
}

function taskSummary(task: ProjectionSnapshot['tasks'][number], snapshot: ProjectionSnapshot, actor: Actor) {
  const actions = computeAvailableActions(task, snapshot, actor.actor_id);
  const activeWait = snapshot.wait_conditions.filter((wc) => wc.task_id === task.task_id && wc.status === 'active');
  const acceptance = latestEffectiveAcceptance(snapshot, task.task_id);
  return {
    task_id: task.task_id,
    project_id: task.project_id,
    title: task.title,
    description: task.description,
    lifecycle: task.lifecycle,
    wait_state: task.wait_state,
    assignee_kind: task.assignee_kind,
    assigned_by: task.assigned_by,
    duplicate_suspect: task.duplicate_suspect,
    capture_id: task.capture_id,
    proposal_id: task.proposal_id,
    current_contract_rev: task.current_contract_rev,
    last_outcome_id: task.last_outcome_id,
    feedback_count: task.feedback_count,
    cancel_requested: task.cancel_requested_by !== null,
    acceptance_criteria: task.acceptance_criteria,
    acceptance: acceptance === undefined
      ? null
      : {
        acceptance_id: acceptance.acceptance_id,
        verdict: acceptance.verdict,
        criterion_results: acceptance.criterion_results,
        created_at: acceptance.created_at,
      },
    active_wait_conditions: activeWait.map((wc) => ({
      wait_condition_id: wc.wait_condition_id,
      kind: wc.kind,
      target_ref: wc.target_ref,
    })),
    available_actions: actions,
    updated_global_seq: task.updated_global_seq,
  };
}

export function latestEffectiveAcceptance(snapshot: ProjectionSnapshot, task_id: string) {
  return snapshot.acceptances
    .filter((a) => a.task_id === task_id && a.superseded_by === null)
    .sort((a, b) => b.updated_global_seq - a.updated_global_seq)[0];
}

function meta(snapshot: ProjectionSnapshot): ProjectionMeta {
  return { projection_version: snapshot.projection_version };
}

export interface HomeView extends ProjectionMeta {
  actor_id: string;
  projects: Array<{
    project_id: string;
    name: string;
    goal_statement: string | null;
    goal_status: string | null;
    task_counts: Record<string, number>;
    total_tasks: number;
    accepted_tasks: number;
    last_event_at: string | null;
  }>;
  my_actions_count: number;
  recent_activity: Array<{
    seq: number;
    kind: string;
    project_id: string;
    task_id: string | null;
    occurred_at: string;
    summary: string;
  }>;
  proposals: {
    pending: number;
    degraded: number;
  };
}

const ACTIVITY_LABEL: Record<string, string> = {
  ProjectCreated: '项目创建',
  GoalCreated: '目标登记',
  TaskCaptured: '任务创建',
  TaskLifecycleChanged: '任务状态变更',
  TaskWaitStateChanged: '等待状态变更',
  TaskCancelRequested: '记录取消意图',
  TaskCanceled: '任务取消',
  RunCreated: '执行尝试创建',
  RunStarted: '开始执行',
  RunSucceeded: '执行完成',
  RunFailed: '执行失败',
  RunCanceled: '执行取消',
  FeedbackReceived: '收到反馈',
  FeedbackInterpreted: '反馈已解释',
  OutcomeRecorded: '记录结果',
  AcceptanceRecorded: '记录验收',
  AcceptanceSuperseded: '验收被取代',
  PlanChangeProposed: '产生提议',
  PlanChangeApplied: '提议已应用',
  PlanChangeRejected: '提议被拒绝',
  AssignmentCreated: '指派执行者',
  WaitConditionCreated: '登记等待条件',
  WaitConditionCanceled: '等待条件收尾',
};

export function homeView(snapshot: ProjectionSnapshot, actor: Actor): HomeView {
  const myActions = myActionItems(snapshot, actor);
  const activity = snapshot.recent_events.slice(0, 20).map((entry) => ({
    seq: entry.seq,
    kind: entry.kind,
    project_id: entry.stream_id,
    task_id: entry.task_id,
    occurred_at: entry.occurred_at,
    summary: `${ACTIVITY_LABEL[entry.kind] ?? entry.kind}${entry.task_id ? `（${entry.task_id.slice(0, 12)}）` : ''}`,
  }));

  return {
    ...meta(snapshot),
    actor_id: actor.actor_id,
    projects: snapshot.projects.map((project) => {
      const tasks = snapshot.tasks.filter((t) => t.project_id === project.project_id);
      const goal = snapshot.goals.find((g) => g.project_id === project.project_id) ?? null;
      const counts: Record<string, number> = {};
      for (const task of tasks) counts[task.lifecycle] = (counts[task.lifecycle] ?? 0) + 1;
      const lastEvent = snapshot.recent_events.find((e) => e.stream_id === project.project_id);
      return {
        project_id: project.project_id,
        name: project.name,
        goal_statement: goal?.statement ?? null,
        goal_status: goal?.status ?? null,
        task_counts: counts,
        total_tasks: tasks.length,
        accepted_tasks: counts.accepted ?? 0,
        last_event_at: lastEvent?.occurred_at ?? null,
      };
    }),
    my_actions_count: myActions.length,
    recent_activity: activity,
    proposals: {
      pending: snapshot.proposals.filter((p) => p.status === 'proposed').length,
      degraded: snapshot.proposals.filter((p) => p.status === 'proposed' && p.proposer.degraded).length,
    },
  };
}

export interface ActionItem {
  task_id: string;
  project_id: string;
  project_name: string;
  title: string;
  lifecycle: string;
  wait_state: string;
  next_action: string;
  available_actions: ReturnType<typeof computeAvailableActions>;
  updated_global_seq: number;
}

/** REQ-PJ-2：My Actions = actor=当前用户 ∧ (可执行[ready/active 且 wait_state=none] ∨ 待其决策的 Decision)。 */
export function myActionItems(snapshot: ProjectionSnapshot, actor: Actor): ActionItem[] {
  return snapshot.tasks
    .filter((task) => isActionableFor(task, snapshot, actor.actor_id))
    .map((task) => {
      const actions = computeAvailableActions(task, snapshot, actor.actor_id);
      return {
        task_id: task.task_id,
        project_id: task.project_id,
        project_name: snapshot.projects.find((p) => p.project_id === task.project_id)?.name ?? task.project_id,
        title: task.title,
        lifecycle: task.lifecycle,
        wait_state: task.wait_state,
        next_action: actions[0]?.label ?? '',
        available_actions: actions,
        updated_global_seq: task.updated_global_seq,
      };
    })
    .filter((item) => item.available_actions.length > 0)
    .sort((a, b) => a.updated_global_seq - b.updated_global_seq);
}

export interface ActionsView extends ProjectionMeta {
  actor_id: string;
  items: ActionItem[];
}

export function actionsView(snapshot: ProjectionSnapshot, actor: Actor): ActionsView {
  return { ...meta(snapshot), actor_id: actor.actor_id, items: myActionItems(snapshot, actor) };
}

export interface ProjectView extends ProjectionMeta {
  project: { project_id: string; name: string; policy_id: string; created_by: string };
  goal: { goal_id: string; statement: string; success_criteria: string; stop_conditions: string; status: string } | null;
  tasks: ReturnType<typeof taskSummary>[];
  acceptance_status: {
    accepted: number;
    awaiting: number;
    rejected: number;
    total: number;
    criterion_summary: Array<{ task_id: string; criterion_ref: string; verdict: string }>;
  };
  graph: {
    nodes: Array<{ id: string; title: string; lifecycle: string }>;
    edges: Array<{ from: string; to: string; kind: string }>;
  };
  pending_proposals: Array<{ proposal_id: string; kind: string; status: string; degraded: boolean; rationale: string; created_at: string }>;
}

export function projectView(snapshot: ProjectionSnapshot, project_id: string, actor: Actor): ProjectView | null {
  const project = snapshot.projects.find((p) => p.project_id === project_id);
  if (!project) return null;
  const tasks = snapshot.tasks.filter((t) => t.project_id === project_id);
  const goal = snapshot.goals.find((g) => g.project_id === project_id) ?? null;
  const acceptances = snapshot.acceptances.filter((a) => tasks.some((t) => t.task_id === a.task_id));
  const effective = acceptances.filter((a) => a.superseded_by === null);
  const criterionSummary = effective.flatMap((a) =>
    a.criterion_results.map((r) => ({ task_id: a.task_id, criterion_ref: r.criterion_ref, verdict: r.verdict })),
  );

  return {
    ...meta(snapshot),
    project: {
      project_id: project.project_id,
      name: project.name,
      policy_id: project.policy_id,
      created_by: project.created_by,
    },
    goal: goal === null
      ? null
      : {
        goal_id: goal.goal_id,
        statement: goal.statement,
        success_criteria: goal.success_criteria,
        stop_conditions: goal.stop_conditions,
        status: goal.status,
      },
    tasks: tasks.map((task) => taskSummary(task, snapshot, actor)),
    acceptance_status: {
      accepted: tasks.filter((t) => t.lifecycle === 'accepted').length,
      awaiting: tasks.filter((t) => t.lifecycle === 'awaiting_acceptance').length,
      rejected: effective.filter((a) => a.verdict === 'rejected').length,
      total: tasks.length,
      criterion_summary: criterionSummary,
    },
    graph: {
      nodes: tasks.map((t) => ({ id: t.task_id, title: t.title, lifecycle: t.lifecycle })),
      edges: [],
    },
    pending_proposals: snapshot.proposals
      .filter((p) => p.project_id === project_id && p.status === 'proposed')
      .map((p) => ({
        proposal_id: p.proposal_id,
        kind: p.kind,
        status: p.status,
        degraded: p.proposer.degraded,
        rationale: p.rationale,
        created_at: p.created_at,
      })),
  };
}

export interface ProposalView extends ProjectionMeta {
  proposal_id: string;
  project_id: string;
  kind: string;
  status: string;
  status_reason: string | null;
  capture_id: string | null;
  task_id: string | null;
  rationale: string;
  assumptions: string[];
  risk_level: string;
  base_plan_rev: number;
  ops: unknown[];
  /** 降级标记（SSE 与界面必须明示"不是智能产出"） */
  degraded: boolean;
  proposer: {
    source: 'model' | 'fallback';
    model: string | null;
    degraded: boolean;
    degraded_reason: string | null;
    latency_ms: number | null;
  };
  details: unknown;
  created_at: string;
  available_actions: Array<{ id: string; command_type: string }>;
}

export function proposalView(snapshot: ProjectionSnapshot, proposal_id: string): ProposalView | null {
  const proposal = snapshot.proposals.find((p) => p.proposal_id === proposal_id);
  if (!proposal) return null;
  const acceptable = proposal.status === 'proposed' && proposal.kind === 'capture_task';
  return {
    ...meta(snapshot),
    proposal_id: proposal.proposal_id,
    project_id: proposal.project_id,
    kind: proposal.kind,
    status: proposal.status,
    status_reason: proposal.status_reason,
    capture_id: proposal.capture_id,
    task_id: proposal.task_id,
    rationale: proposal.rationale,
    assumptions: proposal.assumptions,
    risk_level: proposal.risk_level,
    base_plan_rev: proposal.base_plan_rev,
    ops: proposal.ops,
    degraded: proposal.proposer.degraded,
    proposer: proposal.proposer,
    details: proposal.details,
    created_at: proposal.created_at,
    available_actions: acceptable
      ? [
        { id: 'accept_proposal', command_type: 'proposal_accept' },
        { id: 'reject_proposal', command_type: 'proposal_reject' },
      ]
      : [],
  };
}
