// HTTP 视图（§4 契约的响应形状）。投影类响应一律带 projection_version（= 已并入最大 global_seq）。
// 视图只做"投影 → 响应"的形状映射，不重算任何状态判定：available_actions 来自 projection/actions.ts（内核 guard）。

import type { ProjectionSnapshot, TaskRecord } from '../projection/projection.ts';
import { computeAvailableActions, isActionableFor, type AvailableAction, type CommandType } from '../projection/actions.ts';
import type { ProjectionMeta } from '../api/http.ts';

export interface Actor {
  /** 当前用户（K0 单用户；由请求头 x-xuxing-actor 注入，缺省 demo 用户） */
  actor_id: string;
}

/**
 * available_actions 的对外形态（FIX-ROUND-1 R-1 定版）：canonical command_type 字符串数组。
 * 去重保序——同一命令可对应多种 verdict（如 acceptance_record 的三档），对外只说"能做这个命令"。
 */
export function availableCommands(actions: AvailableAction[]): CommandType[] {
  const seen: CommandType[] = [];
  for (const action of actions) {
    if (action.command_type === null) continue;
    if (!seen.includes(action.command_type)) seen.push(action.command_type);
  }
  return seen;
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
        acceptor_id: acceptance.acceptor_id,
        acceptor_kind: acceptance.acceptor_kind,
        verdict: acceptance.verdict,
        criterion_results: acceptance.criterion_results,
        created_at: acceptance.created_at,
      },
    active_wait_conditions: activeWait.map((wc) => ({
      wait_condition_id: wc.wait_condition_id,
      kind: wc.kind,
      target_ref: wc.target_ref,
    })),
    available_actions: availableCommands(actions),
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
    /** 页面契约键名（契约 §2.2）；与 last_event_at 同值，last_event_at 为 API 级附加键保留。 */
    last_activity_at: string | null;
  }>;
  my_actions_count: number;
  /** 页面契约（契约 §2.2）：需要关注列表，恒在（空态为空数组）。 */
  attention: AttentionItemView[];
  /** 页面契约（契约 §2.2）：与 recent_activity 同源（snapshot.recent_events）的页面形状。 */
  recent: Array<{
    event_id: string;
    project_id: string;
    task_id?: string;
    summary: string;
    occurred_at: string;
  }>;
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

export interface AttentionItemView {
  attention_id: string;
  kind: 'decision_pending' | 'acceptance_due' | 'run_indeterminate' | 'duplicate_suspect' | 'wait_expired' | 'cancel_pending';
  project_id: string;
  task_id?: string;
  decision_id?: string;
  rank: number;
  available_actions: string[];
  created_at: string;
}

/** attention 的 kind 优先序（rank 计算的第一键；见 attentionItems 的定版注释）。 */
const ATTENTION_KIND_ORDER: AttentionItemView['kind'][] = [
  'decision_pending',
  'acceptance_due',
  'run_indeterminate',
  'cancel_pending',
  'wait_expired',
  'duplicate_suspect',
];

/**
 * 任务派生 attention 项的 created_at 口径：该任务在投影保留窗口（recent_events）
 * 内最近一条事件的 occurred_at；窗口内无该任务事件时退到全局最近事件，
 * 再退到项目 created_at。投影记录本身不带任务创建时间，这是现有证据下的最近似，
 * 与契约 §2.2 的实现口径注记一致。
 */
function attentionCreatedAt(snapshot: ProjectionSnapshot, task: TaskRecord): string {
  const own = snapshot.recent_events.find((e) => e.task_id === task.task_id);
  if (own) return own.occurred_at;
  const latest = snapshot.recent_events[0];
  if (latest) return latest.occurred_at;
  return snapshot.projects.find((pr) => pr.project_id === task.project_id)?.created_at ?? '';
}

/**
 * Home「需要关注」（attention）派生——契约 docs/interaction-contract.md §2.2 的派生表
 * 在服务端投影的落地（此前只有契约与前端 mock 实现，真实投影缺失导致整页白屏，
 * 见 WHITESCREEN-FIX-1024）。六类 kind 的出现/消失条件按 §2.2，映射到投影记录面：
 *
 * - decision_pending：DecisionCreated 且 status=pending（冻结 spec §2.2 正本
 *   口径）。K0 曾以提议派生近似（无 Decision 实体）；K1-A 起投影落独立
 *   DecisionRecord，本类与 My Actions 的 decision 条目同源同数（K1 §3.6）。
 * - acceptance_due：任务 awaiting_acceptance 且最新有效 Acceptance 不存在或
 *   verdict=partially_accepted（accepted/rejected 即消失；partially 保留「待补判据」）。
 * - run_indeterminate：RunRecord.state=indeterminate（结果不明且未对账到终态）。
 * - duplicate_suspect：TaskRecord.duplicate_suspect 且 lifecycle != canceled
 *   （TaskDuplicateResolved 清标记即消失，TaskCanceled 亦消失）。
 * - wait_expired：WaitConditionRecord.status=expired 且任务未终态（accepted/canceled）。
 * - cancel_pending：cancel_requested_by 非空且 lifecycle != canceled
 *   （TaskCancelRequested 已落、TaskCanceled 未落）。
 *
 * attention_id 格式 `attention:<kind>:<entity_id>`：kind 限定保证同一任务多类
 * 共存时唯一（React key 与行标识）。rank 由服务端计算（OQ-08=A，前端只排序）：
 * kind 优先序 ATTENTION_KIND_ORDER → created_at 升序 → attention_id 字典序，
 * 顺序编号 1..n。available_actions 一律走内核 guard（computeAvailableActions）；
 * 提议与 proposalView 同口径（capture_task 且 proposed 才给 accept/reject）。
 * 空态恒返回空数组——字段必须在，不能缺（REQ-PJ-1：Home 不制造待办）。
 */
export function attentionItems(snapshot: ProjectionSnapshot, actor: Actor): AttentionItemView[] {
  const raw: Array<Omit<AttentionItemView, 'rank'>> = [];
  const taskById = new Map(snapshot.tasks.map((t) => [t.task_id, t]));
  const taskActions = (task: TaskRecord): string[] =>
    availableCommands(computeAvailableActions(task, snapshot, actor.actor_id));

  for (const decision of snapshot.decisions) {
    if (decision.status !== 'pending') continue;
    raw.push({
      attention_id: `attention:decision_pending:${decision.decision_id}`,
      kind: 'decision_pending',
      project_id: decision.project_id,
      ...(decision.subject_ref.kind === 'duplicate_suspect' ? { task_id: decision.subject_ref.id } : {}),
      decision_id: decision.decision_id,
      available_actions: ['resolve_decision'],
      created_at: decision.created_at,
    });
  }

  for (const task of snapshot.tasks) {
    if (task.lifecycle === 'awaiting_acceptance') {
      const acceptance = latestEffectiveAcceptance(snapshot, task.task_id);
      if (!acceptance || acceptance.verdict === 'partially_accepted') {
        raw.push({
          attention_id: `attention:acceptance_due:${task.task_id}`,
          kind: 'acceptance_due',
          project_id: task.project_id,
          task_id: task.task_id,
          available_actions: taskActions(task),
          created_at: attentionCreatedAt(snapshot, task),
        });
      }
    }
    if (task.duplicate_suspect && task.lifecycle !== 'canceled') {
      raw.push({
        attention_id: `attention:duplicate_suspect:${task.task_id}`,
        kind: 'duplicate_suspect',
        project_id: task.project_id,
        task_id: task.task_id,
        available_actions: taskActions(task),
        created_at: attentionCreatedAt(snapshot, task),
      });
    }
    if (task.cancel_requested_by !== null && task.lifecycle !== 'canceled') {
      raw.push({
        attention_id: `attention:cancel_pending:${task.task_id}`,
        kind: 'cancel_pending',
        project_id: task.project_id,
        task_id: task.task_id,
        available_actions: taskActions(task),
        created_at: attentionCreatedAt(snapshot, task),
      });
    }
  }

  for (const run of snapshot.runs) {
    if (run.state !== 'indeterminate') continue;
    const task = taskById.get(run.task_id);
    if (!task) continue;
    raw.push({
      attention_id: `attention:run_indeterminate:${run.run_id}`,
      kind: 'run_indeterminate',
      project_id: task.project_id,
      task_id: task.task_id,
      available_actions: taskActions(task),
      created_at: attentionCreatedAt(snapshot, task),
    });
  }

  for (const wc of snapshot.wait_conditions) {
    if (wc.status !== 'expired') continue;
    const task = taskById.get(wc.task_id);
    if (!task) continue;
    if (task.lifecycle === 'accepted' || task.lifecycle === 'canceled') continue;
    raw.push({
      attention_id: `attention:wait_expired:${wc.wait_condition_id}`,
      kind: 'wait_expired',
      project_id: task.project_id,
      task_id: task.task_id,
      available_actions: taskActions(task),
      created_at: attentionCreatedAt(snapshot, task),
    });
  }

  const order = new Map(ATTENTION_KIND_ORDER.map((kind, i) => [kind, i]));
  raw.sort((a, b) => {
    const byKind = (order.get(a.kind) ?? 99) - (order.get(b.kind) ?? 99);
    if (byKind !== 0) return byKind;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.attention_id < b.attention_id ? -1 : a.attention_id > b.attention_id ? 1 : 0;
  });
  return raw.map((item, i) => ({ ...item, rank: i + 1 }));
}

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
        last_activity_at: lastEvent?.occurred_at ?? null,
      };
    }),
    my_actions_count: myActions.length,
    attention: attentionItems(snapshot, actor),
    recent: activity.map((entry) => ({
      event_id: `evt-${entry.seq}`,
      project_id: entry.project_id,
      ...(entry.task_id ? { task_id: entry.task_id } : {}),
      summary: entry.summary,
      occurred_at: entry.occurred_at,
    })),
    recent_activity: activity,
    proposals: {
      pending: snapshot.proposals.filter((p) => p.status === 'proposed').length,
      degraded: snapshot.proposals.filter((p) => p.status === 'proposed' && p.proposer.degraded).length,
    },
  };
}

/**
 * My Actions 条目（K1 §3.6）：封闭联合 kind ∈ {task, decision}，同列由 rank
 * 统一排序。task 条目保持 K0 扁平字段（标题/项目名/下一步标签）；decision
 * 条目按 §3.6 字段集（decision_id/subject_ref/question/recommendation/
 * alternatives/evidence_refs/created_at/available_actions=["resolve_decision"]）。
 * 排序口径：decision 条目优先（阻塞性待裁决），同类按 updated_global_seq 升序；
 * rank 顺序编号 1..n，前端只渲染不自算。
 */
export interface ActionItem {
  kind: 'task' | 'decision';
  item_id: string;
  rank: number;
  task_id: string | null;
  project_id: string;
  project_name: string;
  title: string | null;
  lifecycle: string | null;
  wait_state: string | null;
  next_action: string;
  available_actions: CommandType[];
  updated_global_seq: number;
  decision_id: string | null;
  subject_ref: { kind: string; id: string } | null;
  question: string | null;
  recommendation: string | null;
  alternatives: string[];
  evidence_refs: string[];
  created_at: string | null;
}

/** REQ-PJ-2：My Actions = actor=当前用户 ∧ (可执行[ready/active 且 wait_state=none] ∨ 待其决策的 Decision)。 */
export function myActionItems(snapshot: ProjectionSnapshot, actor: Actor): ActionItem[] {
  const projectName = (project_id: string): string =>
    snapshot.projects.find((p) => p.project_id === project_id)?.name ?? project_id;

  const taskItems: ActionItem[] = snapshot.tasks
    .filter((task) => isActionableFor(task, snapshot, actor.actor_id))
    .map((task) => {
      const actions = computeAvailableActions(task, snapshot, actor.actor_id);
      return {
        kind: 'task' as const,
        item_id: `task:${task.task_id}`,
        rank: 0,
        task_id: task.task_id,
        project_id: task.project_id,
        project_name: projectName(task.project_id),
        title: task.title,
        lifecycle: task.lifecycle,
        wait_state: task.wait_state,
        next_action: actions[0]?.label ?? '',
        available_actions: availableCommands(actions),
        updated_global_seq: task.updated_global_seq,
        decision_id: null,
        subject_ref: null,
        question: null,
        recommendation: null,
        alternatives: [],
        evidence_refs: [],
        created_at: null,
      };
    })
    .filter((item) => item.available_actions.length > 0);

  const decisionItems: ActionItem[] = snapshot.decisions
    .filter((decision) => decision.status === 'pending')
    .map((decision) => ({
      kind: 'decision' as const,
      item_id: `decision:${decision.decision_id}`,
      rank: 0,
      task_id: null,
      project_id: decision.project_id,
      project_name: projectName(decision.project_id),
      title: null,
      lifecycle: null,
      wait_state: null,
      next_action: '裁决此决策',
      available_actions: ['resolve_decision'] as CommandType[],
      updated_global_seq: decision.updated_global_seq,
      decision_id: decision.decision_id,
      subject_ref: decision.subject_ref,
      question: decision.question,
      recommendation: decision.recommendation,
      alternatives: decision.alternatives,
      evidence_refs: decision.evidence_refs,
      created_at: decision.created_at,
    }));

  const merged = [...decisionItems, ...taskItems].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'decision' ? -1 : 1;
    return a.updated_global_seq - b.updated_global_seq;
  });
  return merged.map((item, i) => ({ ...item, rank: i + 1 }));
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
  /** K1-B：项目内 Run 视图（state_reason 为派发行合成字段）。 */
  runs: Array<{
    run_id: string;
    task_id: string;
    run_kind: string;
    state: string;
    executor_kind: string | null;
    side_effect_level: string;
    side_effect_count: number;
    state_reason: string | null;
    updated_global_seq: number;
  }>;
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
  evidences: Array<{
    evidence_id: string; task_id: string | null; source_kind: string; content_ref: string;
    content_hash: string; verification_status: string; recorded_via: string; gateway_id: string | null;
    actor_id: string; actor_kind: string; created_at: string;
  }>;
}

export function projectView(
  snapshot: ProjectionSnapshot,
  project_id: string,
  actor: Actor,
  dispatchReasons?: Map<string, string | null>,
): ProjectView | null {
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
    // K1-B §4.4：Run 视图（state 为投影事件派生；state_reason 为派发行
    // 状态，由 routes 层合成传入——无可用节点挂起时固定 awaiting_node）。
    runs: snapshot.runs
      .filter((r) => tasks.some((t) => t.task_id === r.task_id))
      .map((r) => ({
        run_id: r.run_id,
        task_id: r.task_id,
        run_kind: r.run_kind,
        state: r.state,
        executor_kind: r.executor_kind,
        side_effect_level: r.side_effect_level,
        side_effect_count: r.side_effect_count,
        state_reason: dispatchReasons?.get(r.run_id) ?? null,
        updated_global_seq: r.updated_global_seq,
      })),
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
    evidences: snapshot.evidences
      .filter((e) => e.project_id === project_id)
      .map((e) => ({
        evidence_id: e.evidence_id, task_id: e.task_id, source_kind: e.source_kind,
        content_ref: e.content_ref, content_hash: e.content_hash,
        verification_status: e.verification_status, recorded_via: e.recorded_via,
        gateway_id: e.gateway_id, actor_id: e.actor_id, actor_kind: e.actor_kind,
        created_at: e.created_at,
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
  available_actions: CommandType[];
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
    available_actions: acceptable ? ['proposal_accept', 'proposal_reject'] : [],
  };
}
