// K1-A 决策闭环测试（K1-SPEC v0.4 §3）：resolve_decision 全形态、§3.4 按
// subject 分流的效果、approved_modified 旁路、deferred 唤起/过期、投影同源。
// 构造走事件追加（与种子同口径），断言走 API 回读 + 事件流直查。

import { describe, expect, it } from 'vitest';
import { asProjectId } from '../../src/kernel/events.ts';
import { api, bootApp, jsonOf, DEFAULT_PROJECT_ID, type BootedApp } from './support/harness.ts';

const PROJECT = DEFAULT_PROJECT_ID;
let seq = 0;
const key = (name: string) => `test-dec:${name}:${++seq}`;
const submitId = (name: string) => `sub-${name}-${++seq}`;

async function appendRaw(booted: BootedApp, type: string, payload: Record<string, unknown>, stream = PROJECT) {
  const event = await booted.harness.store.append({
    stream_id: asProjectId(stream),
    type: type as never,
    actor_id: 'user_demo',
    actor_kind: 'human',
    causation_id: null,
    correlation_id: key('corr'),
    idempotency_key: key(type),
    payload,
  });
  await booted.config.projection.refresh();
  return event;
}

async function appendTransition(
  booted: BootedApp,
  input: {
    type: string;
    entity: 'task' | 'run';
    from: string;
    to: string;
    facts?: Record<string, unknown>;
    payload: Record<string, unknown>;
  },
) {
  const result = await booted.harness.store.appendStateTransition({
    stream_id: asProjectId(PROJECT),
    type: input.type as never,
    entity: input.entity,
    actor_id: 'user_demo',
    actor_kind: 'human',
    causation_id: null,
    correlation_id: key('corr'),
    idempotency_key: key(input.type),
    trigger_event_id: key('trigger'),
    from: input.from,
    to: input.to,
    facts: input.facts as never,
    payload: input.payload,
  });
  await booted.config.projection.refresh();
  return result.event;
}

/** 构造一条 needs_decision 的 capture_task PlanChange + pending Decision。 */
async function makePlanChangeDecision(
  booted: BootedApp,
  opts: { changeId: string; decisionId: string; baseRev?: number; title?: string },
) {
  const title = opts.title ?? '待裁决任务';
  await appendRaw(booted, 'PlanChangeProposed', {
    change_id: opts.changeId,
    client_proposal_id: `cap-${opts.changeId}`,
    kind: 'capture_task',
    capture_id: `cap-${opts.changeId}`,
    task_id: null,
    base_plan_rev: opts.baseRev ?? 1,
    ops: [{ op: 'add_task' }],
    risk_level: 'L1',
    rationale: '测试构造',
    assumptions: [],
    proposer: { source: 'model', model: 'm', degraded: false, degraded_reason: null, latency_ms: 1 },
    details: {
      task: {
        title,
        description: '测试构造的待裁决任务',
        assignee_kind: 'human',
        acceptance_criteria: [{ criterion_ref: 'c1', text: '完成并留痕', auto: false }],
      },
    },
    proposed_at: null,
  });
  await appendRaw(booted, 'PlanChangeStatusChanged', {
    change_id: opts.changeId,
    status: 'needs_decision',
    reason: 'risk_requires_decision',
  });
  await appendRaw(booted, 'DecisionCreated', {
    decision_id: opts.decisionId,
    subject_ref: { kind: 'plan_change', id: opts.changeId },
    question: `是否批准「${title}」？`,
    recommendation: '建议批准',
    alternatives: ['拒绝'],
    evidence_refs: [`change:${opts.changeId}`],
    created_by: 'system',
  });
}

async function resolve(
  booted: BootedApp,
  payload: Record<string, unknown>,
  opts: { submit?: string; actor?: Record<string, unknown> } = {},
) {
  return api(booted, '/api/commands', {
    method: 'POST',
    body: JSON.stringify({
      type: 'resolve_decision',
      client_submit_id: opts.submit ?? submitId('resolve'),
      ...(opts.actor ? { actor: opts.actor } : {}),
      payload,
    }),
  });
}

async function streamEvents(booted: BootedApp, type: string, stream = PROJECT) {
  const events = await booted.harness.store.readStream(asProjectId(stream), 1);
  return events.filter((e) => e.type === type);
}

describe('K1-A resolve_decision：PlanChange subject', () => {
  it('AC-01：approved → 恰一条 DecisionResolved（审计字段齐全）、Change 应用、目标 Task 出现', async () => {
    const booted = await bootApp();
    await makePlanChangeDecision(booted, { changeId: 'chg-ac01', decisionId: 'dec-ac01', title: 'AC01 任务' });
    const res = await resolve(booted, { decision_id: 'dec-ac01', verdict: 'approved' });
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(body.data.subject).toMatchObject({ decision_id: 'dec-ac01', verdict: 'approved' });

    const resolved = await streamEvents(booted, 'DecisionResolved');
    const mine = resolved.filter((e) => (e.payload as Record<string, unknown>).decision_id === 'dec-ac01');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.payload).toMatchObject({
      verdict: 'approved',
      decided_by: 'user_demo',
      subject_ref: { kind: 'plan_change', id: 'chg-ac01' },
    });
    expect(typeof (mine[0]!.payload as Record<string, unknown>).resolved_at).toBe('string');

    const snapshot = booted.config.projection.snapshot();
    expect(snapshot.proposals.find((p) => p.proposal_id === 'chg-ac01')?.status).toBe('applied');
    expect(snapshot.tasks.some((t) => t.title === 'AC01 任务')).toBe(true);
    expect((await streamEvents(booted, 'PlanRevisionCreated')).length).toBeGreaterThanOrEqual(1);
    await booted.close();
  });

  it('AC-02：approved 撞 base_rev_conflict → 命令成功、生成 follow-up Decision、原 Change 维持 needs_decision', async () => {
    const booted = await bootApp();
    await makePlanChangeDecision(booted, { changeId: 'chg-ac02', decisionId: 'dec-ac02', baseRev: 99 });
    const res = await resolve(booted, { decision_id: 'dec-ac02', verdict: 'approved' });
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    const followUp = body.data.subject.follow_up_decision_id as string;
    expect(typeof followUp).toBe('string');

    const snapshot = booted.config.projection.snapshot();
    expect(snapshot.proposals.find((p) => p.proposal_id === 'chg-ac02')?.status).toBe('needs_decision');
    const follow = snapshot.decisions.find((d) => d.decision_id === followUp);
    expect(follow?.status).toBe('pending');
    expect(follow?.subject_ref).toEqual({ kind: 'plan_change', id: 'chg-ac02' });
    await booted.close();
  });

  it('AC-03：rejected 缺 reason → 400 字段级；带 reason → Change rejected（decision_rejected）、无 Task 产生', async () => {
    const booted = await bootApp();
    await makePlanChangeDecision(booted, { changeId: 'chg-ac03', decisionId: 'dec-ac03', title: 'AC03 任务' });
    const bad = await resolve(booted, { decision_id: 'dec-ac03', verdict: 'rejected' });
    expect(bad.status).toBe(400);
    expect((await jsonOf(bad)).error.detail).toMatchObject({ reason: 'schema_invalid', field: 'reason' });

    const okRes = await resolve(booted, { decision_id: 'dec-ac03', verdict: 'rejected', reason: '范围不合当前计划' });
    expect(okRes.status).toBe(201);
    const snapshot = booted.config.projection.snapshot();
    const change = snapshot.proposals.find((p) => p.proposal_id === 'chg-ac03');
    expect(change?.status).toBe('rejected');
    expect(change?.status_reason).toBe('decision_rejected');
    expect(snapshot.tasks.some((t) => t.title === 'AC03 任务')).toBe(false);
    await booted.close();
  });

  it('AC-04：deferred 缺 wake_condition → 400；带 at_time 唤起 → 到时自动回 proposed 并应用', async () => {
    const booted = await bootApp();
    await makePlanChangeDecision(booted, { changeId: 'chg-ac04', decisionId: 'dec-ac04', title: 'AC04 任务' });
    const bad = await resolve(booted, { decision_id: 'dec-ac04', verdict: 'deferred' });
    expect(bad.status).toBe(400);
    expect((await jsonOf(bad)).error.detail).toMatchObject({ reason: 'schema_invalid', field: 'wake_condition' });

    const wakeAt = new Date(booted.harness.clock.now.getTime() + 60_000).toISOString();
    const okRes = await resolve(booted, {
      decision_id: 'dec-ac04',
      verdict: 'deferred',
      wake_condition: { kind: 'at_time', at: wakeAt },
    });
    expect(okRes.status).toBe(201);
    let snapshot = booted.config.projection.snapshot();
    expect(snapshot.decisions.find((d) => d.decision_id === 'dec-ac04')?.status).toBe('deferred');
    expect(snapshot.proposals.find((p) => p.proposal_id === 'chg-ac04')?.status).toBe('needs_decision');

    // 未到时：tick 无效果；到时：唤起应用
    await booted.config.decisionWake.tick();
    snapshot = booted.config.projection.snapshot();
    expect(snapshot.proposals.find((p) => p.proposal_id === 'chg-ac04')?.status).toBe('needs_decision');
    booted.harness.clock.tick(61_000);
    const ticked = await booted.config.decisionWake.tick();
    expect(ticked.woken).toContain('dec-ac04');
    snapshot = booted.config.projection.snapshot();
    expect(snapshot.proposals.find((p) => p.proposal_id === 'chg-ac04')?.status).toBe('applied');
    expect(snapshot.tasks.some((t) => t.title === 'AC04 任务')).toBe(true);
    await booted.close();
  });

  it('AC-05：expired 后裁决 → 409 decision_expired 且零新事件', async () => {
    const booted = await bootApp();
    await appendRaw(booted, 'DecisionCreated', {
      decision_id: 'dec-ac05',
      subject_ref: { kind: 'plan_change', id: 'chg-none' },
      question: '会过期的决策',
      recommendation: null,
      alternatives: [],
      evidence_refs: [],
      expires_at: new Date(booted.harness.clock.now.getTime() + 1_000).toISOString(),
      created_by: 'system',
    });
    booted.harness.clock.tick(2_000);
    const ticked = await booted.config.decisionWake.tick();
    expect(ticked.expired).toContain('dec-ac05');
    const before = (await booted.harness.store.readStream(asProjectId(PROJECT), 1)).length;
    const res = await resolve(booted, { decision_id: 'dec-ac05', verdict: 'approved' });
    expect(res.status).toBe(409);
    expect((await jsonOf(res)).error.detail).toMatchObject({ reason: 'decision_expired' });
    const after = (await booted.harness.store.readStream(asProjectId(PROJECT), 1)).length;
    expect(after).toBe(before);
    await booted.close();
  });

  it('AC-06：非 human actor → 403 actor_not_human', async () => {
    const booted = await bootApp();
    await makePlanChangeDecision(booted, { changeId: 'chg-ac06', decisionId: 'dec-ac06' });
    const res = await resolve(
      booted,
      { decision_id: 'dec-ac06', verdict: 'approved' },
      { actor: { actor_id: 'agent-1', actor_kind: 'agent' } },
    );
    expect(res.status).toBe(403);
    expect((await jsonOf(res)).error.detail).toMatchObject({ reason: 'actor_not_human' });
    await booted.close();
  });

  it('AC-07/08：同 client_submit_id 重放返回首次结果零新事件；异内容同 id → 409；已裁决再裁决 → 409 terminal_state 带现状', async () => {
    const booted = await bootApp();
    await makePlanChangeDecision(booted, { changeId: 'chg-ac07', decisionId: 'dec-ac07' });
    const submit = submitId('ac07');
    const first = await resolve(booted, { decision_id: 'dec-ac07', verdict: 'approved' }, { submit });
    expect(first.status).toBe(201);
    const replay = await resolve(booted, { decision_id: 'dec-ac07', verdict: 'approved' }, { submit });
    expect(replay.status).toBe(200);
    expect((await jsonOf(replay)).data.replayed).toBe(true);
    const resolved = (await streamEvents(booted, 'DecisionResolved')).filter(
      (e) => (e.payload as Record<string, unknown>).decision_id === 'dec-ac07',
    );
    expect(resolved).toHaveLength(1);

    const conflict = await resolve(booted, { decision_id: 'dec-ac07', verdict: 'rejected', reason: 'x' }, { submit });
    expect(conflict.status).toBe(409);

    const again = await resolve(booted, { decision_id: 'dec-ac07', verdict: 'rejected', reason: '再裁决' });
    expect(again.status).toBe(409);
    expect((await jsonOf(again)).error.detail).toMatchObject({
      reason: 'terminal_state',
      status: 'approved',
      decided_by: 'user_demo',
    });
    await booted.close();
  });

  it('AC-09：decision 不存在 → 404；未知 subject 类型 → 409 subject_not_resolvable_in_k1', async () => {
    const booted = await bootApp();
    const missing = await resolve(booted, { decision_id: 'dec-nope', verdict: 'approved' });
    expect(missing.status).toBe(404);
    expect((await jsonOf(missing)).error.detail).toMatchObject({ reason: 'not_found' });

    await appendRaw(booted, 'DecisionCreated', {
      decision_id: 'dec-ac09',
      subject_ref: { kind: 'goal_conflict', id: 'goal-x' },
      question: '目标冲突',
      recommendation: null,
      alternatives: [],
      evidence_refs: [],
      created_by: 'system',
    });
    const res = await resolve(booted, { decision_id: 'dec-ac09', verdict: 'approved' });
    expect(res.status).toBe(409);
    expect((await jsonOf(res)).error.detail).toMatchObject({ reason: 'subject_not_resolvable_in_k1' });
    await booted.close();
  });

  it('AC-10：approved_modified 不走 resolve_decision（400）；走新 Change supersede 路径 → 旧 Change rejected + DecisionResolved(approved_modified)', async () => {
    const booted = await bootApp();
    await makePlanChangeDecision(booted, { changeId: 'chg-ac10', decisionId: 'dec-ac10' });
    const bad = await resolve(booted, { decision_id: 'dec-ac10', verdict: 'approved_modified', reason: '改了范围' });
    expect(bad.status).toBe(400);
    expect((await jsonOf(bad)).error.detail).toMatchObject({ reason: 'schema_invalid', field: 'verdict' });

    // 新 Change（proposed）→ proposal_accept 带 supersedes_change_id
    await appendRaw(booted, 'PlanChangeProposed', {
      change_id: 'chg-ac10-new',
      client_proposal_id: 'cap-chg-ac10-new',
      kind: 'capture_task',
      capture_id: 'cap-chg-ac10-new',
      task_id: null,
      base_plan_rev: 1,
      ops: [{ op: 'add_task' }],
      risk_level: 'L0',
      rationale: '修订版',
      assumptions: [],
      proposer: { source: 'model', model: 'm', degraded: false, degraded_reason: null, latency_ms: 1 },
      details: {
        task: {
          title: '修订后的任务',
          description: '按裁决者修改后的范围',
          assignee_kind: 'human',
          acceptance_criteria: [{ criterion_ref: 'c1', text: '完成并留痕', auto: false }],
        },
      },
      proposed_at: null,
    });
    const accept = await api(booted, '/api/commands', {
      method: 'POST',
      body: JSON.stringify({
        type: 'proposal_accept',
        client_submit_id: submitId('ac10-accept'),
        payload: {
          proposal_id: 'chg-ac10-new',
          supersedes_change_id: 'chg-ac10',
          decision_reason: '缩小范围：只做清单整理，不含回访排期',
        },
      }),
    });
    expect(accept.status).toBe(201);
    const snapshot = booted.config.projection.snapshot();
    const old = snapshot.proposals.find((p) => p.proposal_id === 'chg-ac10');
    expect(old?.status).toBe('rejected');
    expect(old?.status_reason).toBe('superseded_by_decision');
    const decision = snapshot.decisions.find((d) => d.decision_id === 'dec-ac10');
    expect(decision?.status).toBe('approved_modified');
    expect(decision?.reason).toContain('缩小范围');
    expect(snapshot.tasks.some((t) => t.title === '修订后的任务')).toBe(true);
    await booted.close();
  });

  it('AC-11/12：actions 与 attention 的 decision 条目同源同数；kind 集合恒 {task, decision}', async () => {
    const booted = await bootApp(); // 种子含 dec-degraded-1 / dec-degraded-2 两条 pending
    const actions = await jsonOf(await api(booted, '/api/actions'));
    const home = await jsonOf(await api(booted, '/api/home'));
    const decisionItems = actions.data.items.filter((i: any) => i.kind === 'decision');
    const attentionDecisions = home.data.attention.filter((a: any) => a.kind === 'decision_pending');
    expect(decisionItems.length).toBeGreaterThanOrEqual(2);
    expect(decisionItems.length).toBe(attentionDecisions.length);
    expect(actions.data.items.every((i: any) => i.kind === 'task' || i.kind === 'decision')).toBe(true);
    const item = decisionItems.find((i: any) => i.decision_id === 'dec-degraded-1');
    expect(item).toMatchObject({
      project_id: 'proj-degraded',
      subject_ref: { kind: 'plan_change', id: 'prop-degraded-decision' },
      available_actions: ['resolve_decision'],
    });
    expect(typeof item.question).toBe('string');
    expect(Array.isArray(item.alternatives)).toBe(true);
    expect(typeof item.rank).toBe('number');
    expect(home.data.my_actions_count).toBe(actions.data.items.length);
    await booted.close();
  });
});

/** 构造一个 active 的 agent Task + 已 indeterminate 的 executor Run + 对账 Decision。 */
async function makeIndeterminateRun(
  booted: BootedApp,
  opts: { taskId: string; runId: string; decisionId: string; cancelRequested?: boolean },
) {
  await appendRaw(booted, 'TaskCaptured', {
    task_id: opts.taskId,
    title: '对账任务',
    description: '',
    assignee_kind: 'agent',
    goal_id: null,
    capture_id: null,
    proposal_id: null,
    acceptance_criteria: [{ criterion_ref: 'c1', text: '完成', auto: false }],
    plan_rev_introduced: 1,
  });
  await appendRaw(booted, 'TaskDefined', {
    task_id: opts.taskId,
    title: '对账任务',
    description: '',
    contract_rev: 1,
    acceptance_criteria: [{ criterion_ref: 'c1', text: '完成', auto: false }],
  });
  await appendTransition(booted, {
    type: 'TaskLifecycleChanged', entity: 'task', from: 'captured', to: 'defined',
    facts: { hasTitle: true, assigneeKind: 'agent', contractStructured: true },
    payload: { task_id: opts.taskId },
  });
  await appendTransition(booted, {
    type: 'TaskLifecycleChanged', entity: 'task', from: 'defined', to: 'ready',
    facts: { waitStateNone: true, duplicateSuspectFalse: true, dependenciesSatisfied: true, dataInputsAvailable: true, capabilityAvailable: true, policyAllows: true },
    payload: { task_id: opts.taskId },
  });
  await appendRaw(booted, 'RunCreated', {
    run_id: opts.runId,
    task_id: opts.taskId,
    run_kind: 'executor',
    assignment_id: null,
    actor_id: 'user_demo',
    actor_version: 'k1',
    executor_kind: 'agent_hands_shell',
    side_effect_level: 'L1',
    task_rev: 1,
    contract_rev: 1,
    plan_rev: 1,
    input_snapshot: {},
    policy_snapshot: {},
    idempotency_key: `run-${opts.runId}`,
  });
  await appendTransition(booted, {
    type: 'TaskLifecycleChanged', entity: 'task', from: 'ready', to: 'active',
    facts: { runDispatched: true },
    payload: { task_id: opts.taskId },
  });
  await appendRaw(booted, 'RunStarted', { run_id: opts.runId, started_by: 'node-x' });
  await appendTransition(booted, {
    type: 'RunIndeterminate', entity: 'run', from: 'running', to: 'indeterminate',
    facts: { heartbeatLost: true },
    payload: { run_id: opts.runId },
  });
  if (opts.cancelRequested) {
    await appendRaw(booted, 'TaskCancelRequested', {
      task_id: opts.taskId,
      requested_by: 'user_demo',
      reason: 'user_canceled',
    });
  }
  await appendRaw(booted, 'DecisionCreated', {
    decision_id: opts.decisionId,
    subject_ref: { kind: 'run_reconciliation', id: opts.runId },
    question: `Run ${opts.runId} 结果不明，请裁决处置`,
    recommendation: null,
    alternatives: [],
    evidence_refs: [],
    created_by: 'system',
  });
}

describe('K1-A resolve_decision：Run 对账 subject', () => {
  it('approved 缺 disposition → 400 字段级；executed → 补录 Outcome、Run succeeded、Task awaiting_acceptance', async () => {
    const booted = await bootApp();
    await makeIndeterminateRun(booted, { taskId: 'task-rec-1', runId: 'run-rec-1', decisionId: 'dec-rec-1' });
    const bad = await resolve(booted, { decision_id: 'dec-rec-1', verdict: 'approved' });
    expect(bad.status).toBe(400);
    expect((await jsonOf(bad)).error.detail).toMatchObject({ reason: 'schema_invalid', field: 'disposition' });

    const okRes = await resolve(booted, { decision_id: 'dec-rec-1', verdict: 'approved', disposition: 'executed' });
    expect(okRes.status).toBe(201);
    const snapshot = booted.config.projection.snapshot();
    expect(snapshot.runs.find((r) => r.run_id === 'run-rec-1')?.state).toBe('succeeded');
    expect(snapshot.tasks.find((t) => t.task_id === 'task-rec-1')?.lifecycle).toBe('awaiting_acceptance');
    expect(snapshot.outcomes.some((o) => o.run_id === 'run-rec-1')).toBe(true);
    await booted.close();
  });

  it('m-03：Run 已非 indeterminate 且 disposition 缺失（组合错误）→ 先报 400 schema_invalid；带 disposition 才报 409', async () => {
    const booted = await bootApp();
    await makeIndeterminateRun(booted, { taskId: 'task-rec-0', runId: 'run-rec-0', decisionId: 'dec-rec-0' });
    // 先把 Run 移出 indeterminate（对账已由另一路径处置）
    await appendTransition(booted, {
      type: 'RunFailed', entity: 'run', from: 'indeterminate', to: 'failed',
      facts: { reconciliation: 'not_executed' },
      payload: { run_id: 'run-rec-0', reason: 'reconciled_not_executed' },
    });
    const bad = await resolve(booted, { decision_id: 'dec-rec-0', verdict: 'approved' });
    expect(bad.status).toBe(400);
    expect((await jsonOf(bad)).error.detail).toMatchObject({ reason: 'schema_invalid', field: 'disposition' });
    const conflict = await resolve(booted, { decision_id: 'dec-rec-0', verdict: 'approved', disposition: 'executed' });
    expect(conflict.status).toBe(409);
    expect((await jsonOf(conflict)).error.detail).toMatchObject({ reason: 'precondition_unmet' });
    await booted.close();
  });

  it('not_executed → Run failed（reconciled_not_executed）、Task 保持 active 且可重新派发新 Run', async () => {
    const booted = await bootApp();
    await makeIndeterminateRun(booted, { taskId: 'task-rec-2', runId: 'run-rec-2', decisionId: 'dec-rec-2' });
    const okRes = await resolve(booted, { decision_id: 'dec-rec-2', verdict: 'approved', disposition: 'not_executed' });
    expect(okRes.status).toBe(201);
    const failed = (await streamEvents(booted, 'RunFailed')).filter(
      (e) => (e.payload as Record<string, unknown>).run_id === 'run-rec-2',
    );
    expect(failed).toHaveLength(1);
    expect((failed[0]!.payload as Record<string, unknown>).reason).toBe('reconciled_not_executed');

    const advance = await api(booted, '/api/commands', {
      method: 'POST',
      body: JSON.stringify({
        type: 'task_advance',
        client_submit_id: submitId('rec2-advance'),
        payload: { task_id: 'task-rec-2' },
      }),
    });
    expect(advance.status).toBe(201);
    const snapshot = booted.config.projection.snapshot();
    const runs = snapshot.runs.filter((r) => r.task_id === 'task-rec-2');
    expect(runs.some((r) => r.state === 'queued')).toBe(true);
    await booted.close();
  });

  it('cancel_run 且 Task 有挂起取消 → Run canceled 且 Task 推进到 canceled（REQ-RUN-6 第③步）', async () => {
    const booted = await bootApp();
    await makeIndeterminateRun(booted, {
      taskId: 'task-rec-3', runId: 'run-rec-3', decisionId: 'dec-rec-3', cancelRequested: true,
    });
    const okRes = await resolve(booted, { decision_id: 'dec-rec-3', verdict: 'approved', disposition: 'cancel_run' });
    expect(okRes.status).toBe(201);
    const snapshot = booted.config.projection.snapshot();
    expect(snapshot.runs.find((r) => r.run_id === 'run-rec-3')?.state).toBe('canceled');
    expect(snapshot.tasks.find((t) => t.task_id === 'task-rec-3')?.lifecycle).toBe('canceled');
    await booted.close();
  });

  it('rejected → Run 维持 indeterminate、Decision 记已裁决', async () => {
    const booted = await bootApp();
    await makeIndeterminateRun(booted, { taskId: 'task-rec-4', runId: 'run-rec-4', decisionId: 'dec-rec-4' });
    const okRes = await resolve(booted, { decision_id: 'dec-rec-4', verdict: 'rejected', reason: '暂不处置' });
    expect(okRes.status).toBe(201);
    const snapshot = booted.config.projection.snapshot();
    expect(snapshot.runs.find((r) => r.run_id === 'run-rec-4')?.state).toBe('indeterminate');
    expect(snapshot.decisions.find((d) => d.decision_id === 'dec-rec-4')?.status).toBe('rejected');
    await booted.close();
  });
});

describe('K1-A resolve_decision：疑似重复 subject', () => {
  async function makeSuspect(booted: BootedApp, taskId: string, decisionId: string) {
    await appendRaw(booted, 'TaskCaptured', {
      task_id: taskId,
      title: '疑似重复任务',
      description: '',
      assignee_kind: 'human',
      goal_id: null,
      capture_id: null,
      proposal_id: null,
      acceptance_criteria: [{ criterion_ref: 'c1', text: '完成', auto: false }],
      plan_rev_introduced: 1,
    });
    await appendRaw(booted, 'TaskDuplicateSuspected', {
      task_id: taskId,
      duplicate_of: 'task-target',
      suspected_by: 'system',
    });
    await appendRaw(booted, 'DecisionCreated', {
      decision_id: decisionId,
      subject_ref: { kind: 'duplicate_suspect', id: taskId },
      question: `任务 ${taskId} 疑似与 task-target 重复，是否合并？`,
      recommendation: null,
      alternatives: [],
      evidence_refs: [],
      duplicate_of: 'task-target',
      created_by: 'system',
    });
  }

  it('rejected → TaskDuplicateResolved、duplicate_suspect 清除', async () => {
    const booted = await bootApp();
    await makeSuspect(booted, 'task-dup-1', 'dec-dup-1');
    const res = await resolve(booted, { decision_id: 'dec-dup-1', verdict: 'rejected', reason: '不是重复' });
    expect(res.status).toBe(201);
    const snapshot = booted.config.projection.snapshot();
    expect(snapshot.tasks.find((t) => t.task_id === 'task-dup-1')?.duplicate_suspect).toBe(false);
    await booted.close();
  });

  it('approved → 被疑 Task 级联 canceled（duplicate_merged）', async () => {
    const booted = await bootApp();
    await makeSuspect(booted, 'task-dup-2', 'dec-dup-2');
    const res = await resolve(booted, { decision_id: 'dec-dup-2', verdict: 'approved' });
    expect(res.status).toBe(201);
    expect((await jsonOf(res)).data.subject).toMatchObject({ cascade: 'completed', merged_into: 'task-target' });
    const snapshot = booted.config.projection.snapshot();
    expect(snapshot.tasks.find((t) => t.task_id === 'task-dup-2')?.lifecycle).toBe('canceled');
    const cancelReq = (await streamEvents(booted, 'TaskCancelRequested')).filter(
      (e) => (e.payload as Record<string, unknown>).task_id === 'task-dup-2',
    );
    expect((cancelReq[0]!.payload as Record<string, unknown>).reason).toBe('duplicate_merged');
    await booted.close();
  });

  it('approved → 被疑 Task 的未决事项以 PlanChange 并入目标 Task（AC-10 并入覆盖，M-02）', async () => {
    const booted = await bootApp();
    // 目标 Task 真实存在
    await appendRaw(booted, 'TaskCaptured', {
      task_id: 'task-target',
      title: '目标任务',
      description: '',
      assignee_kind: 'human',
      goal_id: null,
      capture_id: null,
      proposal_id: null,
      acceptance_criteria: [{ criterion_ref: 'c1', text: '目标完成', auto: false }],
      plan_rev_introduced: 1,
    });
    await makeSuspect(booted, 'task-dup-3', 'dec-dup-3');
    // 被疑 Task 的未决事项：一条活跃等待条件
    await appendRaw(booted, 'WaitConditionCreated', {
      wait_condition_id: 'wc-dup-3',
      task_id: 'task-dup-3',
      kind: 'person',
      target_ref: 'user:zhangsan',
    });
    const res = await resolve(booted, { decision_id: 'dec-dup-3', verdict: 'approved' });
    expect(res.status).toBe(201);
    const subject = (await jsonOf(res)).data.subject;
    expect(subject).toMatchObject({ cascade: 'completed', merged_into: 'task-target' });
    const changeId = subject.merged_change_id as string;
    expect(changeId).toBeTruthy();
    expect(subject.carried_wait_conditions).toEqual(['wc-dup-3']);

    // 事件流恰一条并入 PlanChange：以目标 Task 为 subject、审计链可溯
    const proposed = (await streamEvents(booted, 'PlanChangeProposed')).filter(
      (e) => (e.payload as Record<string, unknown>).change_id === changeId,
    );
    expect(proposed).toHaveLength(1);
    const payload = proposed[0]!.payload as Record<string, unknown>;
    expect(payload.task_id).toBe('task-target');
    expect(payload.client_proposal_id).toBe('merge:dec-dup-3');
    const ops = payload.ops as Array<Record<string, unknown>>;
    expect(ops[0]).toMatchObject({ op: 'merge_task', from_task_id: 'task-dup-3', into_task_id: 'task-target', decision_id: 'dec-dup-3' });
    expect(ops).toContainEqual(
      expect.objectContaining({ op: 'carry_wait_condition', wait_condition_id: 'wc-dup-3', kind: 'person', target_ref: 'user:zhangsan' }),
    );
    expect(ops).toContainEqual(expect.objectContaining({ op: 'carry_acceptance_criteria' }));

    // 投影：并入 Change 以 proposed 挂在目标 Task 名下；被疑 Task 已取消
    const snapshot = booted.config.projection.snapshot();
    const change = snapshot.proposals.find((pr) => pr.proposal_id === changeId);
    expect(change?.status).toBe('proposed');
    expect(change?.task_id).toBe('task-target');
    expect(snapshot.tasks.find((t) => t.task_id === 'task-dup-3')?.lifecycle).toBe('canceled');
    await booted.close();
  });
});
