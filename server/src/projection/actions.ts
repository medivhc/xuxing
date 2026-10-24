// available_actions 与"当前用户可执行条目"判定（REQ-PJ-1 / REQ-PJ-2）。
//
// 唯一依据：内核 guard（迁移矩阵 + 前置条件）。这里不发明任何状态规则——
// 前端与 HTTP 层只渲染结果，命令层用同一函数复核（越权 409 的来源）。

import { guardTransition, guardWaitStateChange, type GuardFacts } from '../../../src/kernel/transition-guard.ts';
import type { ProjectionSnapshot, RunRecord, TaskRecord } from './projection.ts';

/** 命令词表（FIX-ROUND-1 R-1 定版）：HTTP 与 available_actions 只说这 6 个 canonical 值。 */
export const COMMAND_TYPES = [
  'proposal_accept',
  'proposal_reject',
  'task_advance',
  'feedback_submit',
  'acceptance_record',
  'task_cancel',
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];

export type TaskActionId =
  | 'next_lifecycle'
  | 'submit_feedback'
  | 'record_acceptance'
  | 'cancel_task'
  | 'release_block'
  | 'accept_proposal'
  | 'reject_proposal';

export interface NextTransition {
  type: 'task_lifecycle' | 'task_wait_state';
  from: string;
  to: string;
  guard: 'allowed';
  /** 该迁移依赖的事实（命令层据此构造 GuardFacts，不接受客户端自证） */
  facts_needed: string[];
}

export interface AvailableAction {
  id: TaskActionId;
  label: string;
  next: NextTransition | null;
  command_type: CommandType | null;
  /** 该动作要求的 verdict（验收类动作） */
  verdict?: 'accepted' | 'rejected' | 'partially_accepted';
}

function lifecycleAction(
  task: TaskRecord,
  to: string,
  facts: GuardFacts,
): { ok: boolean; facts_needed: string[]; missing: string[] } {
  const guard = guardTransition({
    entity: 'task',
    from: task.lifecycle,
    to,
    event_type: 'TaskLifecycleChanged',
    facts,
  });
  return {
    ok: guard.allowed,
    facts_needed: guard.allowed ? [] : (guard.missing_facts ?? []).map((hint) => hint.expected),
    missing: guard.missing_facts?.map((hint) => hint.fact) ?? [],
  };
}

export function baseTaskFacts(task: TaskRecord): GuardFacts {
  return {
    hasTitle: task.title.trim().length > 0,
    assigneeKind: task.assignee_kind,
    contractStructured: task.acceptance_criteria.length > 0,
  };
}

/** 逐 Task 算出当前动作集；actorId 决定"是否轮到我"。 */
export function computeAvailableActions(
  task: TaskRecord,
  snapshot: ProjectionSnapshot,
  actorId: string,
): AvailableAction[] {
  const actions: AvailableAction[] = [];
  const live = hasLiveRun(snapshot, task.task_id);

  // 主生命周期：captured→defined→ready→active（wait_state=none 才派发，REQ-SCH-1 的 wait 项）
  if (task.lifecycle === 'captured') {
    const check = lifecycleAction(task, 'defined', baseTaskFacts(task));
    if (check.ok) {
      actions.push({
        id: 'next_lifecycle',
        label: '定义完成（进入可排期）',
        next: { type: 'task_lifecycle', from: task.lifecycle, to: 'defined', guard: 'allowed', facts_needed: [] },
        command_type: 'task_advance',
      });
    }
  }

  if (task.lifecycle === 'defined' && task.wait_state === 'none' && !task.duplicate_suspect) {
    // REQ-SCH-1 全公式：wait/duplicate 两项已由本函数的门槛条件给出；
    // 依赖/数据/能力/策略在 K0 投影口径下无建模阻塞（命令层执行时由内核流派生复核）
    const check = lifecycleAction(task, 'ready', {
      waitStateNone: true,
      duplicateSuspectFalse: true,
      dependenciesSatisfied: true,
      dataInputsAvailable: true,
      capabilityAvailable: true,
      policyAllows: true,
    });
    if (check.ok) {
      actions.push({
        id: 'next_lifecycle',
        label: '标记就绪',
        next: { type: 'task_lifecycle', from: task.lifecycle, to: 'ready', guard: 'allowed', facts_needed: [] },
        command_type: 'task_advance',
      });
    }
  }

  if (task.lifecycle === 'ready' && task.wait_state === 'none' && !live) {
    // 该动作即派发：命令层先建 Run 再迁移，runDispatched 由动作本身满足
    const check = lifecycleAction(task, 'active', { runDispatched: true });
    if (check.ok) {
      actions.push({
        id: 'next_lifecycle',
        label: '开始执行（派发 Run）',
        next: { type: 'task_lifecycle', from: 'ready', to: 'active', guard: 'allowed', facts_needed: [] },
        command_type: 'task_advance',
      });
    }
  }

  if (canSubmitFeedback(task, snapshot, actorId)) {
    actions.push({ id: 'submit_feedback', label: '提交执行反馈', next: null, command_type: 'feedback_submit' });
  }

  // 验收：awaiting_acceptance → accepted / defined / active（REQ-ACC-2 / REQ-ACC-3）
  if (task.lifecycle === 'awaiting_acceptance') {
    const accepted = lifecycleAction(task, 'accepted', { ...baseTaskFacts(task), acceptanceVerdict: 'accepted' });
    if (accepted.ok) {
      actions.push({
        id: 'record_acceptance',
        label: '验收通过',
        next: { type: 'task_lifecycle', from: task.lifecycle, to: 'accepted', guard: 'allowed', facts_needed: ['criterion_results 覆盖全部判据'] },
        command_type: 'acceptance_record',
        verdict: 'accepted',
      });
    }
    const rejected = lifecycleAction(task, 'defined', { acceptanceVerdict: 'rejected' });
    if (rejected.ok) {
      actions.push({
        id: 'record_acceptance',
        label: '验收不通过（退回重做）',
        next: { type: 'task_lifecycle', from: task.lifecycle, to: 'defined', guard: 'allowed', facts_needed: [] },
        command_type: 'acceptance_record',
        verdict: 'rejected',
      });
    }
    const partial = lifecycleAction(task, 'active', { acceptanceVerdict: 'partially_accepted', needsReexecution: true });
    if (partial.ok && !live) {
      actions.push({
        id: 'record_acceptance',
        label: '部分通过（需再执行）',
        next: { type: 'task_lifecycle', from: task.lifecycle, to: 'active', guard: 'allowed', facts_needed: [] },
        command_type: 'acceptance_record',
        verdict: 'partially_accepted',
      });
    }
  }

  // 取消：REQ-RUN-6③ 全部 Run 达终态才正式 canceled
  if (task.cancel_requested_by === null) {
    const cancelFacts: GuardFacts =
      task.lifecycle === 'active' || task.lifecycle === 'awaiting_acceptance'
        ? { allRunsTerminal: !live }
        : {};
    const check = lifecycleAction(task, 'canceled', cancelFacts);
    if (check.ok) {
      actions.push({
        id: 'cancel_task',
        label: live ? '记取消意图' : '取消任务',
        next: { type: 'task_lifecycle', from: task.lifecycle, to: 'canceled', guard: 'allowed', facts_needed: live ? [] : [] },
        command_type: 'task_cancel',
      });
    }
  }

  // wait_state 人工解除（§3.1：非终态可叠加/解除；device 等待归入 blocked）。
  // K0 命令词表（FIX-ROUND-1 R-1）里没有 wait_state_change：内部动作不对外暴露，
  // 否则 available_actions 会出现一条执行不了的命令。解除等待留给 K1 契约补口径。
  if (resolveWaitStateAllowed(task)) {
    actions.push({
      id: 'release_block',
      label: '解除等待（K0 无对应命令，仅提示）',
      next: { type: 'task_wait_state', from: task.wait_state, to: 'none', guard: 'allowed', facts_needed: [] },
      command_type: null,
    });
  }

  return actions;
}

function resolveWaitStateAllowed(task: TaskRecord): boolean {
  return (
    ['waiting_on_person', 'waiting_until', 'waiting_on_dependency', 'blocked', 'on_hold'].includes(task.wait_state) &&
    guardWaitStateChange({ lifecycle: task.lifecycle, from: task.wait_state, to: 'none', reason: '人工解除等待' }).allowed
  );
}

export function hasLiveRun(snapshot: ProjectionSnapshot, task_id: string): boolean {
  return snapshot.runs.some(
    (run) => run.task_id === task_id && ['created', 'queued', 'leased', 'running'].includes(run.state),
  );
}

/** 该 Task 的 active human_light Run（人类"提交反馈"的前提，REQ-HUM-1/2）。 */
export function activeHumanRun(snapshot: ProjectionSnapshot, task_id: string, actorId?: string): RunRecord | undefined {
  return snapshot.runs.find(
    (run) =>
      run.task_id === task_id &&
      run.run_kind === 'human_light' &&
      run.state === 'running' &&
      (actorId === undefined || run.actor_id === actorId),
  );
}

export function canSubmitFeedback(task: TaskRecord, snapshot: ProjectionSnapshot, actorId: string): boolean {
  if (task.lifecycle !== 'active' || task.wait_state !== 'none') return false;
  return activeHumanRun(snapshot, task.task_id, actorId) !== undefined;
}

/**
 * REQ-PJ-2：My Actions = actor=当前用户 ∧ (可执行[ready/active 且 wait_state=none] ∨ 待其决策的 Decision)。
 * K0 Web 最小形态只覆盖前半句；Decision 待决项在投影中出现 DecisionCreated 后一并纳入（见 routes）。
 *
 * FIX-ROUND-1 R-10：`awaiting_acceptance` 的验收动作属于"待我处理"，必须留在 My Actions 里
 * （此前漏掉这一形态，任务一进验收就从列表消失）。判定只问"这个人此刻有没有可执行动作"，
 * 不另立状态规则。
 */
export function isActionableFor(task: TaskRecord, snapshot: ProjectionSnapshot, actorId: string): boolean {
  if (task.wait_state !== 'none') return false;
  if (task.lifecycle === 'ready') return true;
  if (task.lifecycle === 'active') {
    return activeHumanRun(snapshot, task.task_id, actorId) !== undefined || canSubmitFeedback(task, snapshot, actorId);
  }
  // 已定义但尚不就绪 / 捕获后未定义：仍是"当前用户"要推进的事（proposal 接受后即在此列）
  if (task.lifecycle === 'captured' || task.lifecycle === 'defined') return true;
  // 待验收：有 acceptance_record 可做就是"待我处理"
  if (task.lifecycle === 'awaiting_acceptance') {
    return computeAvailableActions(task, snapshot, actorId).some((action) => action.command_type === 'acceptance_record');
  }
  return false;
}
