import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, bootApp, jsonOf, type BootedApp } from './support/harness.ts';
import { DEFAULT_PROJECT_ID } from '../src/seed/demo.ts';

let booted: BootedApp;

beforeAll(async () => {
  booted = await bootApp();
});

afterAll(async () => {
  await booted.close();
});

async function command(body: unknown, actor?: string) {
  const response = await api(booted, '/api/commands', {
    method: 'POST',
    body: JSON.stringify(body),
    actor,
  });
  return { status: response.status, body: await jsonOf(response) };
}

async function capture(text: string, client_submit_id?: string): Promise<{ capture_id: string; proposal_id: string }> {
  const body = await jsonOf(await api(booted, '/api/capture', {
    method: 'POST',
    body: JSON.stringify({ text, client_submit_id }),
  }));
  return body.data;
}

async function taskOf(task_id: string) {
  const body = await jsonOf(await api(booted, `/api/projects/${DEFAULT_PROJECT_ID}`));
  return body.data.tasks.find((t: any) => t.task_id === task_id);
}

describe('POST /api/commands：完整旅途（捕获 → 提议 → 接受 → MyActions → 完成 → 验收）', () => {
  it('端到端：一条输入走完 G1 形态的链路，状态全部由事件派生', async () => {
    const captured = await capture('给王五发邮件确认交付清单', 'journey-1');

    const accepted = await command({
      type: 'proposal_accept',
      payload: { proposal_id: captured.proposal_id },
      client_submit_id: 'journey-1-accept',
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    const task_id = accepted.body.data.subject.task_id as string;

    // 接受后：任务已 defined，出现在 My Actions（ready 前先有"标记就绪"动作）
    let task = await taskOf(task_id);
    expect(task.lifecycle).toBe('defined');
    expect(task.proposal_id).toBe(captured.proposal_id);
    let actions = await jsonOf(await api(booted, '/api/actions'));
    let item = actions.data.items.find((i: any) => i.task_id === task_id);
    expect(item).toBeTruthy();
    expect(item.available_actions.map((a: any) => a.id)).toContain('next_lifecycle');

    // defined → ready → active（active 同时建 human_light Run）
    const ready = await command({ type: 'task_advance', payload: { task_id }, client_submit_id: 'journey-1-ready' });
    expect(ready.status, JSON.stringify(ready.body)).toBe(201);
    expect(ready.body.data.subject).toMatchObject({ from: 'defined', to: 'ready' });

    const active = await command({ type: 'task_advance', payload: { task_id }, client_submit_id: 'journey-1-active' });
    expect(active.status, JSON.stringify(active.body)).toBe(201);
    expect(active.body.data.emitted.map((e: any) => e.kind)).toContain('RunStarted');

    // 提交执行反馈 → Outcome → Run succeeded → awaiting_acceptance
    const feedback = await command({
      type: 'feedback_submit',
      payload: { task_id, content: '邮件已发，王五回复明天上午确认' },
      client_submit_id: 'journey-1-feedback',
    });
    expect(feedback.status, JSON.stringify(feedback.body)).toBe(201);
    expect(feedback.body.data.subject.degraded).toBe(false);

    task = await taskOf(task_id);
    expect(task.lifecycle).toBe('awaiting_acceptance');
    expect(task.last_outcome_id).toBe(feedback.body.data.subject.outcome_id);
    expect(task.acceptance_criteria).toHaveLength(1);

    // 逐判据验收 → accepted
    const acceptance = await command({
      type: 'acceptance_record',
      payload: {
        task_id,
        criterion_results: [{ criterion_ref: 'c1', verdict: 'passed', evidence_refs: ['ev-mail'] }],
        rationale: '对方已回复',
      },
      client_submit_id: 'journey-1-acceptance',
    });
    expect(acceptance.status, JSON.stringify(acceptance.body)).toBe(201);
    expect(acceptance.body.data.subject.verdict).toBe('accepted');

    task = await taskOf(task_id);
    expect(task.lifecycle).toBe('accepted');
    expect(task.acceptance).toMatchObject({ verdict: 'accepted' });
  });

  it('命令幂等：同 client_submit_id 重放返回首次结果，不重复落事件（D11 OQ-07）', async () => {
    const captured = await capture('整理竞品清单', 'idem-cap');
    const payload = {
      type: 'proposal_accept',
      payload: { proposal_id: captured.proposal_id },
      client_submit_id: 'idem-accept',
    };
    const first = await command(payload);
    const before = booted.config.projection.version();
    const second = await command(payload);
    expect(second.status).toBe(200);
    expect(second.body.data.replayed).toBe(true);
    expect(second.body.data.subject.task_id).toBe(first.body.data.subject.task_id);
    expect(booted.config.projection.version()).toBe(before);

    // 同 id 不同内容 → 409
    const conflict = await command({
      type: 'proposal_reject',
      payload: { proposal_id: captured.proposal_id },
      client_submit_id: 'idem-accept',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.detail.reason).toBe('idempotency_key_conflict');
  });

  it('越权命令 → 409 并说明（不在 available_actions 内）', async () => {
    // contract 处于 defined：不能直接 accepted（矩阵不允许），也不能跳步 active
    const response = await command({
      type: 'acceptance_record',
      payload: { task_id: 'task_demo_contract', criterion_results: [{ criterion_ref: 'c1', verdict: 'passed' }] },
      client_submit_id: 'overreach-1',
    });
    expect(response.status).toBe(409);
    expect(response.body.error.detail.reason).toBe('not_in_available_actions');
    expect(response.body.error.detail.lifecycle).toBe('defined');
  });

  it('跳步推进（defined → active）→ 409，且内核不落事件', async () => {
    const before = booted.config.projection.version();
    const response = await command({
      type: 'task_advance',
      payload: { task_id: 'task_demo_contract', to: 'active' },
      client_submit_id: 'overreach-2',
    });
    expect(response.status).toBe(409);
    expect(response.body.error.detail).toMatchObject({ requested_to: 'active', available_to: 'ready' });
    expect(booted.config.projection.version()).toBe(before);
  });

  it('反馈越权：非本人 Run 或非 active 任务 → 409', async () => {
    const response = await command(
      { type: 'feedback_submit', payload: { task_id: 'task_demo_contact', content: '代别人汇报' }, client_submit_id: 'overreach-fb' },
      'someone_else',
    );
    expect(response.status).toBe(409);
    expect(response.body.error.detail.reason).toBe('not_in_available_actions');
  });

  it('验收缺判据 → 400（REQ-ACC-2 覆盖完整性，内核不入账）', async () => {
    const captured = await capture('补齐验收覆盖测试', 'cover-cap');
    const accepted = await command({ type: 'proposal_accept', payload: { proposal_id: captured.proposal_id }, client_submit_id: 'cover-accept' });
    const task_id = accepted.body.data.subject.task_id;
    await command({ type: 'task_advance', payload: { task_id }, client_submit_id: 'cover-ready' });
    await command({ type: 'task_advance', payload: { task_id }, client_submit_id: 'cover-active' });
    await command({ type: 'feedback_submit', payload: { task_id, content: '做完了' }, client_submit_id: 'cover-fb' });

    const missing = await command({
      type: 'acceptance_record',
      payload: { task_id, criterion_results: [] },
      client_submit_id: 'cover-acceptance-missing',
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('bad_request');
    expect(missing.body.error.detail.missing_criteria).toEqual(['c1']);

    const inconsistent = await command({
      type: 'acceptance_record',
      payload: { task_id, criterion_results: [{ criterion_ref: 'c1', verdict: 'failed' }], verdict: 'accepted' },
      client_submit_id: 'cover-acceptance-inconsistent',
    });
    expect(inconsistent.status).toBe(400);
    expect(inconsistent.body.error.detail.derived).toBe('rejected');
  });

  it('取消任务：captured/defined 直接收尾，记取消意图且 lifecycle=canceled', async () => {
    const captured = await capture('这条会被取消', 'cancel-cap');
    const accepted = await command({ type: 'proposal_accept', payload: { proposal_id: captured.proposal_id }, client_submit_id: 'cancel-accept' });
    const task_id = accepted.body.data.subject.task_id;
    const canceled = await command({ type: 'task_cancel', payload: { task_id }, client_submit_id: 'cancel-1' });
    expect(canceled.status, JSON.stringify(canceled.body)).toBe(201);
    expect(canceled.body.data.emitted.map((e: any) => e.kind)).toContain('TaskCancelRequested');
    expect(canceled.body.data.emitted.map((e: any) => e.kind)).toContain('TaskCanceled');
    expect((await taskOf(task_id)).lifecycle).toBe('canceled');
  });

  it('未知命令 type → 400；缺 client_submit_id → 400', async () => {
    const unknown = await command({ type: 'drop_database', payload: {}, client_submit_id: 'x-1' });
    expect(unknown.status).toBe(400);
    const noId = await command({ type: 'task_advance', payload: { task_id: 'task_demo_quote' } });
    expect(noId.status).toBe(400);
    expect(noId.body.error.detail.field).toBe('client_submit_id');
  });

  it('拒绝提议：提议置 rejected，且不会生成任务', async () => {
    const captured = await capture('不想要这条任务', 'reject-cap');
    const rejected = await command({ type: 'proposal_reject', payload: { proposal_id: captured.proposal_id, reason: 'out_of_scope' }, client_submit_id: 'reject-1' });
    expect(rejected.status).toBe(201);
    const proposal = await jsonOf(await api(booted, `/api/proposals/${captured.proposal_id}`));
    expect(proposal.data.status).toBe('rejected');
    expect(proposal.data.available_actions).toEqual([]);
    const project = await jsonOf(await api(booted, `/api/projects/${DEFAULT_PROJECT_ID}`));
    expect(project.data.tasks.some((t: any) => t.proposal_id === captured.proposal_id)).toBe(false);
  });
});
