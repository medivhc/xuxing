// Mock 命令处理：命令词以服务端 canonical 词表为准（FIX-ROUND-1 R-1），
// K0 界面入口 5 词（proposal_accept / proposal_reject / task_advance /
// acceptance_record / task_cancel）；feedback_submit 在词表内但 K0 无界面
// 入口（捕获走 /api/capture），mock 返回 command_not_implemented_in_mock。
// 原 resolve_decision 无服务端对应，已整体移除（契约缺口登记见 web/README.md）。
//
// 与内核规约的对应（mock 只模拟可判定规则，不发明领域结论）：
// - REQ-ACC-2 actor 分离：acceptor 固定 human-reviewer，与 task.executed_by 不等；
// - REQ-ACC-2 覆盖完整性/继承锁定/verdict 一致性：覆盖完整才出最终 verdict；
//   已 passed 判据改判 failed/not_applicable 必须附新证据（否则 409 criterion_locked）；
// - REQ-ACC-3 迁移矩阵：accepted→accepted；rejected→defined；partially→停
//   awaiting_acceptance（待补集 = failed 判据）；
// - REQ-HUM-1：人类执行为 human_light Run（created→running→succeeded）；
// - D10/OQ-02=A：awaiting_acceptance 不进 My Actions（由 store 投影侧保证）。
//
// 【已知契约/内核张力（交卷登记）】任务书要求逐判据命令提交，而冻结规约的
// Acceptance 入账要求覆盖完整（单次提交全部判据）、事件目录亦无逐判据事件。
// mock 采取「逐条命令 + 累积判论 + 覆盖完整才落最终 Acceptance」的折中，
// 中间态以 AcceptanceRecorded(partially) + AcceptanceSuperseded 广播，
// 供前端观察投影刷新；最终语义以服务端车道对齐结果为准。

import type { CommandReceipt, CommandRequest, CaptureResponse, CriterionVerdict } from '../api/types';
import { CANONICAL_COMMAND_TYPES } from '../api/types';
import { MockHttpError } from './errors';
import type { MockStore, CommandReceiptRecord } from './store';
import { buildAcceptanceRecord, computeAcceptanceVerdict } from './store';
import { MOCK_ACCEPTOR_ACTOR, MOCK_HUMAN_ACTOR } from './types';
import type { MockProposalState, MockTaskState } from './types';

type Payload = Record<string, unknown>;

function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw MockHttpError.badRequest('invalid_payload', `命令 payload 缺少有效字段 ${field}`);
  }
  return value;
}

function optionalStr(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function taskOf(store: MockStore, payload: Payload): MockTaskState {
  const taskId = str(payload.task_id, 'task_id');
  const task = store.tasks.get(taskId);
  if (!task) throw MockHttpError.notFound('task_not_found', `任务 ${taskId} 不存在`);
  return task;
}

/** 幂等：同一 client_submit_id 重复提交返回 duplicate 回执（§0.5）。 */
function withIdempotency(
  store: MockStore,
  clientSubmitId: string,
  apply: () => void,
): CommandReceiptRecord {
  const seen = store.receiptFor(clientSubmitId);
  if (seen) {
    return { ...seen, status: 'duplicate', message: '重复提交已忽略（client_submit_id 幂等命中）' };
  }
  apply();
  const receipt: CommandReceiptRecord = {
    status: 'accepted',
    client_submit_id: clientSubmitId,
    command_id: store.newId('cmd'),
  };
  store.rememberReceipt(clientSubmitId, receipt);
  return receipt;
}

export function handleCommand(store: MockStore, request: CommandRequest): CommandReceiptRecord {
  const payload: Payload = (request.payload ?? {}) as Payload;
  switch (request.type) {
    case 'proposal_accept':
      return withIdempotency(store, request.client_submit_id, () => acceptProposal(store, payload));
    case 'proposal_reject':
      return withIdempotency(store, request.client_submit_id, () => rejectProposal(store, payload));
    case 'task_advance':
      return withIdempotency(store, request.client_submit_id, () => taskAdvance(store, payload));
    case 'acceptance_record':
      return withIdempotency(store, request.client_submit_id, () =>
        recordCriterionVerdict(store, payload),
      );
    case 'task_cancel':
      return withIdempotency(store, request.client_submit_id, () => cancelTask(store, payload));
    case 'resolve_decision':
      return withIdempotency(store, request.client_submit_id, () => resolveDecision(store, payload));
    default:
      // canonical 词表内但 mock 未实现的命令（当前仅 feedback_submit：
      // K0 无界面入口，捕获走 /api/capture 专用端点）
      throw MockHttpError.badRequest(
        'command_not_implemented_in_mock',
        `命令 ${String(request.type)} 在 mock 未实现（K0 无界面入口）`,
      );
  }
}

// ---------- 提议 ----------

function acceptProposal(store: MockStore, payload: Payload): void {
  const proposalId = str(payload.proposal_id, 'proposal_id');
  const proposal = store.proposals.get(proposalId);
  if (!proposal) throw MockHttpError.notFound('proposal_not_found', `提议 ${proposalId} 不存在`);
  if (proposal.status !== 'pending') {
    throw MockHttpError.conflict('proposal_not_pending', '提议已被处理，无法重复接受', {
      proposal_id: proposalId,
      status: proposal.status,
    });
  }

  // OQ-01=A 落点链：FeedbackReceived → FeedbackInterpreted → TaskCaptured（直接成 Task）
  // R-11：task_id 只在接受此刻新发（此前提议投影/界面均无 task_id 字段）
  const taskId = store.newId('task');
  const criteria = proposal.proposed.acceptance_criteria.map((criterion, index) => ({
    criterion_ref: `${taskId}/c${index + 1}`,
    text: criterion.text,
    auto: criterion.auto,
  }));
  const task: MockTaskState = {
    task_id: taskId,
    title: proposal.proposed.title,
    description: proposal.proposed.description,
    lifecycle: 'ready',
    wait_state: 'none',
    duplicate_suspect: false,
    current_contract_rev: 1,
    assignee: { actor_id: MOCK_HUMAN_ACTOR, actor_kind: 'human' },
    active_run: null,
    last_outcome_id: null,
    acceptance_criteria: criteria,
    criterion_results: [],
    acceptance: null,
    executed_by: null,
    updated_global_seq: 0,
  };
  store.tasks.set(taskId, task);

  store.appendEvent({
    kind: 'TaskCaptured',
    project_id: proposal.project_id,
    task_id: taskId,
    summary: `接受提议「${proposal.proposed.title}」，生成任务`,
  });
  store.appendEvent({
    kind: 'TaskDefined',
    project_id: proposal.project_id,
    task_id: taskId,
    summary: `任务「${task.title}」契约定稿（rev 1，${criteria.length} 条判据）`,
  });
  store.appendEvent({
    kind: 'ContractUpdated',
    project_id: proposal.project_id,
    task_id: taskId,
    summary: `任务「${task.title}」契约更新至 rev 1`,
  });
  store.appendEvent({
    kind: 'TaskLifecycleChanged',
    project_id: proposal.project_id,
    task_id: taskId,
    summary: `任务「${task.title}」进入 ready`,
  });
  task.updated_global_seq = store.currentSeq();

  proposal.status = 'accepted';
  proposal.updated_global_seq = store.currentSeq();
}

function rejectProposal(store: MockStore, payload: Payload): void {
  const proposalId = str(payload.proposal_id, 'proposal_id');
  const proposal = store.proposals.get(proposalId);
  if (!proposal) throw MockHttpError.notFound('proposal_not_found', `提议 ${proposalId} 不存在`);
  if (proposal.status !== 'pending') {
    throw MockHttpError.conflict('proposal_not_pending', '提议已被处理，无法重复拒绝', {
      proposal_id: proposalId,
      status: proposal.status,
    });
  }
  proposal.status = 'rejected';
  proposal.updated_global_seq = store.currentSeq();
  // 注：封闭事件目录无「提议拒绝」专属事件；界面在拒绝后离开提议页，
  // 手动重读投影即可看到 rejected（mock 简化，交卷登记）。
}

// ---------- 任务执行 ----------

/**
 * task_advance（canonical）：服务端以一个命令词覆盖「开始/完成」两个迁移，
 * 按任务当前生命周期分派——ready/defined → 开始；active → 完成；
 * 其余生命周期落到 startTask 的前置校验，按 409 task_not_ready 拒绝。
 * 分派口径为 mock 对服务端词表的模拟（K1 契约议题，见 web/README.md 已知边界）。
 */
function taskAdvance(store: MockStore, payload: Payload): void {
  const task = taskOf(store, payload);
  if (task.lifecycle === 'active') {
    completeTask(store, task, payload);
    return;
  }
  startTask(store, task);
}

function startTask(store: MockStore, task: MockTaskState): void {
  if (task.lifecycle !== 'ready' && task.lifecycle !== 'defined') {
    throw MockHttpError.conflict('task_not_ready', '任务不在可开始状态', {
      task_id: task.task_id,
      lifecycle: task.lifecycle,
    });
  }
  if (task.wait_state !== 'none') {
    throw MockHttpError.conflict('wait_state_blocked', '任务处于等待/阻塞状态，不能开始', {
      task_id: task.task_id,
      wait_state: task.wait_state,
    });
  }
  if (task.assignee?.actor_id !== MOCK_HUMAN_ACTOR) {
    throw MockHttpError.conflict('assignment_not_current_user', '任务未指派给当前用户', {
      task_id: task.task_id,
      assignee: task.assignee,
    });
  }

  const runId = store.newId('run');
  task.active_run = { run_id: runId, state: 'running', run_kind: 'human_light' };
  task.lifecycle = 'active';
  store.appendEvent({
    kind: 'RunCreated',
    project_id: store.project.project_id,
    task_id: task.task_id,
    summary: `任务「${task.title}」创建 human_light Run`,
  });
  store.appendEvent({
    kind: 'RunStarted',
    project_id: store.project.project_id,
    task_id: task.task_id,
    summary: `任务「${task.title}」开始执行`,
  });
  store.appendEvent({
    kind: 'TaskLifecycleChanged',
    project_id: store.project.project_id,
    task_id: task.task_id,
    summary: `任务「${task.title}」进入 active`,
  });
  task.updated_global_seq = store.currentSeq();
}

function completeTask(store: MockStore, task: MockTaskState, payload: Payload): void {
  if (task.lifecycle !== 'active' || !task.active_run) {
    throw MockHttpError.conflict('task_not_active', '任务不在执行中', {
      task_id: task.task_id,
      lifecycle: task.lifecycle,
    });
  }
  const note = optionalStr(payload.note);
  const outcomeId = store.newId('outcome');
  const executor = task.assignee?.actor_id ?? MOCK_HUMAN_ACTOR;

  if (note) {
    store.appendEvent({
      kind: 'FeedbackReceived',
      project_id: store.project.project_id,
      task_id: task.task_id,
      summary: `任务「${task.title}」提交执行反馈`,
    });
  }
  store.appendEvent({
    kind: 'OutcomeRecorded',
    project_id: store.project.project_id,
    task_id: task.task_id,
    summary: `任务「${task.title}」记录产出 ${outcomeId}`,
  });
  store.appendEvent({
    kind: 'RunSucceeded',
    project_id: store.project.project_id,
    task_id: task.task_id,
    summary: `任务「${task.title}」执行完成`,
  });

  // 新 Outcome 入账：旧 Acceptance 标记 superseded（重新验收，REQ-ACC-4 口径）
  if (task.acceptance && !task.acceptance.superseded) {
    task.acceptance = { ...task.acceptance, superseded: true };
    store.appendEvent({
      kind: 'AcceptanceSuperseded',
      project_id: store.project.project_id,
      task_id: task.task_id,
      summary: `任务「${task.title}」旧验收因新产出被 supersede`,
    });
  }

  task.active_run = null;
  task.last_outcome_id = outcomeId;
  task.executed_by = executor;
  task.criterion_results = [];
  task.lifecycle = 'awaiting_acceptance';
  store.appendEvent({
    kind: 'TaskLifecycleChanged',
    project_id: store.project.project_id,
    task_id: task.task_id,
    summary: `任务「${task.title}」进入 awaiting_acceptance，等待逐判据验收`,
  });
  task.updated_global_seq = store.currentSeq();
}

function recordCriterionVerdict(store: MockStore, payload: Payload): void {
  const task = taskOf(store, payload);
  if (task.lifecycle !== 'awaiting_acceptance') {
    throw MockHttpError.conflict('task_not_awaiting_acceptance', '任务不在待验收状态', {
      task_id: task.task_id,
      lifecycle: task.lifecycle,
    });
  }
  const criterionRef = str(payload.criterion_ref, 'criterion_ref');
  const criterion = task.acceptance_criteria.find((c) => c.criterion_ref === criterionRef);
  if (!criterion) {
    throw MockHttpError.conflict('unknown_criterion', `判据 ${criterionRef} 不属于该任务契约`, {
      task_id: task.task_id,
      criterion_ref: criterionRef,
    });
  }
  // unknown 经 typeof 守卫 + 字面量排除，收敛为 CriterionVerdict（不能写成
  // CriterionVerdict | string——那会被 TS 吸收成 string，后续窄化全部失效）
  const rawVerdict = payload.verdict;
  if (
    typeof rawVerdict !== 'string' ||
    (rawVerdict !== 'passed' && rawVerdict !== 'failed' && rawVerdict !== 'not_applicable')
  ) {
    throw MockHttpError.badRequest('invalid_verdict', 'verdict 必须为 passed/failed/not_applicable');
  }
  const verdict: CriterionVerdict = rawVerdict;
  const note = optionalStr(payload.note);
  const evidenceRefs = strArray(payload.evidence_refs);

  // REQ-ACC-2：执行者不得验收自己的 Run
  if (task.executed_by === MOCK_ACCEPTOR_ACTOR) {
    throw MockHttpError.conflict('forbidden', '执行该 Run 的 actor 不得担任其 acceptor（REQ-ACC-2）', {
      task_id: task.task_id,
      executed_by: task.executed_by,
    });
  }

  const existing = task.criterion_results.find((r) => r.criterion_ref === criterionRef);
  if (existing && existing.verdict === verdict) {
    // 同结论重提交：幂等无变化（继承锁定不触发）
    return;
  }
  // 继承锁定：已 passed 判据改判 failed/not_applicable 必须附新证据
  if (existing?.verdict === 'passed' && verdict !== 'passed' && evidenceRefs.length === 0) {
    throw MockHttpError.conflict('criterion_locked', '已 passed 判据改判必须附新证据（继承锁定）', {
      task_id: task.task_id,
      criterion_ref: criterionRef,
    });
  }
  if (verdict === 'failed' && note === null) {
    throw MockHttpError.conflict('note_required', '判据未通过必须填写备注', {
      task_id: task.task_id,
      criterion_ref: criterionRef,
    });
  }

  const result = { criterion_ref: criterionRef, verdict, note, evidence_refs: evidenceRefs };
  task.criterion_results = [
    ...task.criterion_results.filter((r) => r.criterion_ref !== criterionRef),
    result,
  ].sort(
    (a, b) =>
      task.acceptance_criteria.findIndex((c) => c.criterion_ref === a.criterion_ref) -
      task.acceptance_criteria.findIndex((c) => c.criterion_ref === b.criterion_ref),
  );

  const coverageComplete = task.criterion_results.length === task.acceptance_criteria.length;
  const acceptanceVerdict = computeAcceptanceVerdict(task.acceptance_criteria, task.criterion_results);

  if (task.acceptance && !task.acceptance.superseded) {
    task.acceptance = { ...task.acceptance, superseded: true };
    store.appendEvent({
      kind: 'AcceptanceSuperseded',
      project_id: store.project.project_id,
      task_id: task.task_id,
      summary: `任务「${task.title}」旧验收被新判论 supersede`,
    });
  }
  task.acceptance = buildAcceptanceRecord({
    acceptanceId: store.newId('acc'),
    contractRev: task.current_contract_rev,
    subjectOutcomeId: task.last_outcome_id,
    acceptorId: MOCK_ACCEPTOR_ACTOR,
    verdict: acceptanceVerdict,
    criterionResults: task.criterion_results,
  });
  store.appendEvent({
    kind: 'AcceptanceRecorded',
    project_id: store.project.project_id,
    task_id: task.task_id,
    summary: coverageComplete
      ? `任务「${task.title}」验收完成：${acceptanceVerdict}`
      : `任务「${task.title}」记录判论 ${task.criterion_results.length}/${task.acceptance_criteria.length}（部分验收）`,
  });

  if (coverageComplete) {
    // REQ-ACC-3 迁移矩阵（M4 加注口径）
    if (acceptanceVerdict === 'accepted') {
      task.lifecycle = 'accepted';
    } else if (acceptanceVerdict === 'rejected') {
      task.lifecycle = 'defined';
      task.active_run = null;
    }
    // partially_accepted：停在 awaiting_acceptance（待补集 = failed 判据，投影侧计算）
    store.appendEvent({
      kind: 'TaskLifecycleChanged',
      project_id: store.project.project_id,
      task_id: task.task_id,
      summary: `任务「${task.title}」按迁移矩阵进入 ${task.lifecycle}`,
    });
  }
  task.updated_global_seq = store.currentSeq();
}

// ---------- 决策 ----------

// K1-A：resolve_decision 已进服务端 canonical 词表（K1-SPEC §3.2），mock
// 同步实现裁决语义：校验（存在性/状态/reason/wake_condition）+ 状态落账 +
// DecisionResolved 事件。mock 的 Decision 是独立演示实体（无 subject 联动
// 的图效果），图效果以真服务端为准——mock 只保证界面交互与校验口径一致。
function resolveDecision(store: MockStore, payload: Payload): void {
  const decisionId = str(payload.decision_id, 'decision_id');
  const decision = store.decisions.get(decisionId);
  if (!decision) throw new MockHttpError(404, 'not_found', `Decision ${decisionId} 不存在`, { decision_id: decisionId });
  if (decision.status === 'expired') {
    throw MockHttpError.conflict('decision_expired', '该决策已过期，未执行', {
      reason: 'decision_expired',
      decision_id: decisionId,
      status: decision.status,
    });
  }
  if (decision.status !== 'pending') {
    throw MockHttpError.conflict('terminal_state', `Decision 已裁决（status=${decision.status}）`, {
      reason: 'terminal_state',
      decision_id: decisionId,
      status: decision.status,
      decided_by: 'user_demo',
      decided_at: decision.created_at,
    });
  }
  const verdict = payload.verdict;
  if (verdict !== 'approved' && verdict !== 'rejected' && verdict !== 'deferred') {
    throw new MockHttpError(400, 'schema_invalid', 'verdict 必须是 approved / rejected / deferred', { field: 'verdict' });
  }
  if (verdict === 'rejected' && (typeof payload.reason !== 'string' || payload.reason.trim() === '')) {
    throw new MockHttpError(400, 'schema_invalid', 'verdict=rejected 时 reason 必填非空', { field: 'reason' });
  }
  if (verdict === 'deferred' && (payload.wake_condition === null || typeof payload.wake_condition !== 'object')) {
    throw new MockHttpError(400, 'schema_invalid', 'verdict=deferred 时 wake_condition 必填', { field: 'wake_condition' });
  }
  decision.status = verdict;
  decision.updated_global_seq = store.currentSeq() + 1;
  store.appendEvent({
    kind: 'DecisionResolved',
    project_id: decision.project_id,
    decision_id: decision.decision_id,
    summary: `决策「${decision.question}」已裁决：${verdict}`,
  });
}

// ---------- 取消 ----------

function cancelTask(store: MockStore, payload: Payload): void {
  const task = taskOf(store, payload);
  if (task.lifecycle === 'accepted' || task.lifecycle === 'canceled') {
    throw MockHttpError.conflict('task_terminal', '任务已终态，无法取消', {
      task_id: task.task_id,
      lifecycle: task.lifecycle,
    });
  }
  store.appendEvent({
    kind: 'TaskCancelRequested',
    project_id: store.project.project_id,
    task_id: task.task_id,
    summary: `请求取消任务「${task.title}」`,
  });
  if (task.active_run) {
    task.active_run = null;
    store.appendEvent({
      kind: 'RunCanceled',
      project_id: store.project.project_id,
      task_id: task.task_id,
      summary: `任务「${task.title}」的 Run 已取消`,
    });
  }
  task.lifecycle = 'canceled';
  store.appendEvent({
    kind: 'TaskCanceled',
    project_id: store.project.project_id,
    task_id: task.task_id,
    summary: `任务「${task.title}」已取消`,
  });
  task.updated_global_seq = store.currentSeq();
}

// ---------- 捕获（POST /api/capture，非命令入口） ----------

export function handleCapture(
  store: MockStore,
  request: { text: string; client_submit_id: string },
): CaptureResponse {
  const text = typeof request.text === 'string' ? request.text.trim() : '';
  if (text === '') {
    throw MockHttpError.badRequest('text_required', '捕获内容不能为空');
  }
  const seen = store.receiptFor(request.client_submit_id);
  if (seen) {
    // 幂等重放：返回首次结果（capture_id/proposal_id 不变）
    const capture = [...store.captures.values()].find((c) => c.text === text);
    if (capture) return { capture_id: capture.capture_id, proposal_id: capture.proposal_id ?? undefined };
    return { capture_id: seen.command_id ?? seen.client_submit_id };
  }

  const captureId = store.newId('cap');
  const proposalId = store.newId('prop');
  const degraded = store.nextProposalDegraded || text.includes('[degraded]');
  const proposal: MockProposalState = {
    proposal_id: proposalId,
    capture_id: captureId,
    project_id: store.project.project_id,
    degraded,
    degraded_reason: degraded ? '解释器置信度低于阈值（mock 降级样本，需人工确认）' : null,
    status: 'pending',
    created_at: new Date().toISOString(),
    summary: degraded
      ? `「${text.slice(0, 40)}」——降级解释：结构不完整，请人工核对后再接受`
      : `「${text.slice(0, 40)}」——解释为可执行任务提议`,
    proposed: {
      title: text.slice(0, 24),
      description: `由捕获内容生成：${text}`,
      acceptance_criteria: [
        { criterion_ref: 'c1', text: '产出可被独立核对', auto: false },
        { criterion_ref: 'c2', text: '关键步骤有记录', auto: false },
      ],
      assignee_hint: MOCK_HUMAN_ACTOR,
    },
    updated_global_seq: 0,
  };
  store.proposals.set(proposalId, proposal);
  store.captures.set(captureId, {
    capture_id: captureId,
    project_id: proposal.project_id,
    text,
    proposal_id: proposalId,
    created_at: proposal.created_at,
  });

  store.appendEvent({
    kind: 'FeedbackReceived',
    project_id: proposal.project_id,
    summary: `捕获入账：${text.slice(0, 30)}`,
  });
  store.appendEvent({
    kind: 'FeedbackInterpreted',
    project_id: proposal.project_id,
    proposal_id: proposalId,
    summary: degraded ? '解释完成（降级：置信度不足，需人工确认）' : '解释完成，生成任务提议',
  });
  proposal.updated_global_seq = store.currentSeq();

  store.rememberReceipt(request.client_submit_id, {
    status: 'accepted',
    client_submit_id: request.client_submit_id,
    command_id: captureId,
  });
  return { capture_id: captureId, proposal_id: proposalId };
}

/** 供 handlers 校验命令体形状。 */
export function assertCommandShape(body: unknown): CommandRequest {
  if (typeof body !== 'object' || body === null) {
    throw MockHttpError.badRequest('invalid_command', '命令体必须为 JSON 对象');
  }
  const record = body as Record<string, unknown>;
  if (typeof record.type !== 'string') {
    throw MockHttpError.badRequest('invalid_command', '命令缺少 type');
  }
  // canonical 词表是唯一正本（FIX-ROUND-1 R-1）：词表外一律拒绝
  if (!CANONICAL_COMMAND_TYPES.includes(record.type as CommandRequest['type'])) {
    throw MockHttpError.badRequest(
      'unknown_command_type',
      `未知命令类型：${record.type}（canonical 词表之外）`,
    );
  }
  if (typeof record.client_submit_id !== 'string' || record.client_submit_id.trim() === '') {
    throw MockHttpError.badRequest('invalid_command', '命令缺少 client_submit_id（幂等键）');
  }
  return {
    type: record.type as CommandRequest['type'],
    payload: (record.payload ?? {}) as Record<string, unknown>,
    client_submit_id: record.client_submit_id,
  };
}

export type { CommandReceipt };
