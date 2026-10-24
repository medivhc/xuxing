import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, bootApp, jsonOf, TEST_SSE, type BootedApp } from './support/harness.ts';
import { DEFAULT_PROJECT_ID, seedDemo } from '../src/seed/demo.ts';
import { COMMAND_TYPES } from '../src/projection/actions.ts';
import { asProjectId } from '../../src/kernel/events.ts';
import { sseOptionsFromEnv } from '../src/sse/protocol.ts';

let booted: BootedApp;

beforeAll(async () => {
  booted = await bootApp();
});

afterAll(async () => {
  await booted.close();
});

describe('§4 HTTP 契约：投影类端点', () => {
  it('GET /api/health → {ok:true,data}（信封统一，health 不裸奔）', async () => {
    const body = await jsonOf(await api(booted, '/api/health'));
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty('db');
    expect(body.data.ok).toBe(true);
    expect(body.data.db).toBe(true);
    expect(body.data.projection_version).toBe(booted.config.projection.version());
  });

  it('GET /api/health：limits 从 SSE 配置单点读取（不另写硬编码）', async () => {
    const body = await jsonOf(await api(booted, '/api/health'));
    // 测试 harness 用的是自己的 SSE 配置：health 必须原样反映它，而不是任何内置默认值
    expect(body.data.limits).toEqual({
      heartbeat_ms: TEST_SSE.heartbeatMs,
      max_connections: TEST_SSE.maxConnections,
      max_queue: TEST_SSE.queueLimit,
    });
    // 同一份配置也驱动 SSE 实际行为（连接上限）
    expect(booted.config.sse).toEqual(TEST_SSE);
  });

  it('SSE 配置默认值（env 缺省）：15000 / 32 / 256', () => {
    expect(sseOptionsFromEnv({})).toMatchObject({ heartbeatMs: 15_000, maxConnections: 32, queueLimit: 256 });
  });

  it('GET /api/home：项目摘要 + 待我处理计数 + 最近活动，带 projection_version', async () => {
    const response = await api(booted, '/api/home');
    expect(response.status).toBe(200);
    const body = await jsonOf(response);
    expect(body.ok).toBe(true);
    expect(typeof body.data.projection_version).toBe('number');
    expect(body.data.projection_version).toBe(booted.config.projection.version());
    const project = body.data.projects.find((p: any) => p.project_id === DEFAULT_PROJECT_ID);
    expect(project).toBeTruthy();
    expect(project.name).toContain('续行演示');
    expect(project.goal_statement).toContain('张三');
    expect(typeof body.data.my_actions_count).toBe('number');
    expect(body.data.my_actions_count).toBeGreaterThan(0);
    expect(body.data.recent_activity.length).toBeGreaterThan(0);
    expect(body.data.recent_activity[0]).toHaveProperty('seq');
    expect(body.data.recent_activity[0]).toHaveProperty('kind');
    // 页面契约键集（契约 §2.2 / WHITESCREEN-FIX-1024）：attention 恒在、recent 为页面形状、
    // 项目带 last_activity_at——缺任一键真实前端都会渲染崩溃，投影层在此钉死。
    expect(Array.isArray(body.data.attention)).toBe(true);
    expect(Array.isArray(body.data.recent)).toBe(true);
    expect(body.data.recent[0]).toHaveProperty('event_id');
    expect(body.data.recent[0]).toHaveProperty('summary');
    expect(project).toHaveProperty('last_activity_at');
  });

  it('GET /api/projects/:projectId：目标 + 任务图摘要 + 验收状态，带 projection_version', async () => {
    const body = await jsonOf(await api(booted, `/api/projects/${DEFAULT_PROJECT_ID}`));
    expect(body.ok).toBe(true);
    expect(body.data.projection_version).toBe(booted.config.projection.version());
    expect(body.data.goal.statement).toContain('张三');
    // R-7 种子契约：4 条跨生命周期任务 + 1 条已取消夹具
    expect(body.data.tasks).toHaveLength(5);
    expect(body.data.graph.nodes).toHaveLength(5);
    expect(body.data.acceptance_status).toMatchObject({ accepted: 1, total: 5 });
    const accepted = body.data.tasks.find((t: any) => t.task_id === 'task_demo_kickoff');
    expect(accepted.lifecycle).toBe('accepted');
    expect(accepted.acceptance.verdict).toBe('accepted');
    const canceled = body.data.tasks.find((t: any) => t.task_id === 'task_demo_archived');
    expect(canceled).toMatchObject({ lifecycle: 'canceled', cancel_requested: true, available_actions: [] });
  });

  it('R-7 种子契约：4 条 canonical 任务跨生命周期 + 1 条已取消夹具，My Actions 不含已取消项', async () => {
    const project = await jsonOf(await api(booted, `/api/projects/${DEFAULT_PROJECT_ID}`));
    const byId = new Map(project.data.tasks.map((t: any) => [t.task_id, t]));
    expect([...byId.keys()].sort()).toEqual([
      'task_demo_archived',
      'task_demo_contact',
      'task_demo_contract',
      'task_demo_kickoff',
      'task_demo_quote',
    ]);
    expect(byId.get('task_demo_contact')).toMatchObject({ lifecycle: 'active' });
    expect(byId.get('task_demo_quote')).toMatchObject({ lifecycle: 'ready' });
    expect(byId.get('task_demo_contract')).toMatchObject({ lifecycle: 'defined' });
    expect(byId.get('task_demo_kickoff')).toMatchObject({ lifecycle: 'accepted' });
    expect(byId.get('task_demo_archived')).toMatchObject({ lifecycle: 'canceled' });

    const events = await booted.harness.store.readStream(asProjectId(DEFAULT_PROJECT_ID), 1);
    const canceledEvents = events.filter(
      (e) => e.type === 'TaskCanceled' && (e.payload as Record<string, unknown>)['task_id'] === 'task_demo_archived',
    );
    expect(canceledEvents).toHaveLength(1);

    const actions = await jsonOf(await api(booted, '/api/actions'));
    expect(actions.data.items.map((i: any) => i.task_id)).not.toContain('task_demo_archived');
  });

  it('R-7② 降级夹具：proj-degraded + prop-degraded-1 预置，degraded 标记透传', async () => {
    const proposal = await jsonOf(await api(booted, '/api/proposals/prop-degraded-1'));
    expect(proposal.ok).toBe(true);
    expect(proposal.data).toMatchObject({
      project_id: 'proj-degraded',
      status: 'proposed',
      kind: 'capture_task',
      degraded: true,
    });
    expect(proposal.data.proposer).toMatchObject({ source: 'fallback', degraded: true, degraded_reason: 'not_configured' });
    expect(proposal.data.available_actions).toEqual(['proposal_accept', 'proposal_reject']);

    const project = await jsonOf(await api(booted, '/api/projects/proj-degraded'));
    expect(project.ok).toBe(true);
    expect(project.data.pending_proposals).toHaveLength(1);
    expect(project.data.pending_proposals[0]).toMatchObject({ proposal_id: 'prop-degraded-1', degraded: true });

    const home = await jsonOf(await api(booted, '/api/home'));
    expect(home.data.projects.some((p: any) => p.project_id === 'proj-degraded')).toBe(true);
    expect(home.data.proposals.degraded).toBeGreaterThanOrEqual(1);
    // K1 口径：attention 的 decision_pending 只由 Decision 实体派生；
    // prop-degraded-1 是普通待决提议（无关联 Decision），不得再派生条目。
    const fromProposal = home.data.attention.find(
      (a: any) => a.kind === 'decision_pending' && a.decision_id === 'prop-degraded-1',
    );
    expect(fromProposal).toBeUndefined();
    // K1 决策夹具的 Decision 必须进 attention，动作是 resolve_decision。
    const pending = home.data.attention.find(
      (a: any) => a.kind === 'decision_pending' && a.decision_id === 'dec-degraded-1',
    );
    expect(pending).toMatchObject({
      attention_id: 'attention:decision_pending:dec-degraded-1',
      project_id: 'proj-degraded',
      available_actions: ['resolve_decision'],
    });
    expect(typeof pending.rank).toBe('number');
    expect(typeof pending.created_at).toBe('string');
  });

  it('种子幂等：重复执行不产生重复实体（含夹具）', async () => {
    const before = booted.config.projection.version();
    const again = await seedDemo({ store: booted.harness.store, projection: booted.config.projection });
    // 幂等：不新增任何事件，水位不动
    expect(again.projection_version).toBe(before);
    expect(again.tasks).toBe(5);
    const proposals = await booted.config.projection.snapshot().proposals.filter((p) => p.proposal_id === 'prop-degraded-1');
    expect(proposals).toHaveLength(1);
  });

  it('GET /api/projects/:projectId 不存在 → 404', async () => {
    const response = await api(booted, '/api/projects/proj_missing');
    expect(response.status).toBe(404);
    const body = await jsonOf(response);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('not_found');
  });

  it('GET /api/actions：My Actions 只含当前用户可执行项，每条带 available_actions', async () => {
    const body = await jsonOf(await api(booted, '/api/actions'));
    expect(body.ok).toBe(true);
    expect(body.data.projection_version).toBe(booted.config.projection.version());
    const ids = body.data.items.map((item: any) => item.task_id);
    // 种子：contact 在 active（人类 Run 在跑）、quote 在 ready、contract 在 defined → 都不该是 accepted
    expect(ids).toContain('task_demo_contact');
    expect(ids).toContain('task_demo_quote');
    expect(ids).not.toContain('task_demo_kickoff');
    for (const item of body.data.items) {
      expect(Array.isArray(item.available_actions)).toBe(true);
      expect(item.available_actions.length).toBeGreaterThan(0);
      // FIX-ROUND-1 R-1：available_actions = canonical command_type 字符串数组，不再发对象
      for (const action of item.available_actions) {
        expect(typeof action).toBe('string');
        expect(COMMAND_TYPES).toContain(action);
      }
    }
  });

  it('GET /api/proposals/:proposalId 不存在 → 404；投影版本随事件推进', async () => {
    const response = await api(booted, '/api/proposals/pc_missing');
    expect(response.status).toBe(404);
    expect(booted.config.projection.version()).toBeGreaterThan(0);
  });
});

describe('§4 HTTP 契约：POST /api/capture', () => {
  it('捕获 → 落 FeedbackCaptured（FeedbackReceived）并触发提议流程，回 {capture_id, proposal_id}', async () => {
    const response = await api(booted, '/api/capture', {
      method: 'POST',
      body: JSON.stringify({ text: '给李四打电话确认下周现场支持的时间' }),
    });
    expect(response.status).toBe(201);
    const body = await jsonOf(response);
    expect(body.ok).toBe(true);
    expect(body.data.capture_id).toMatch(/^cap_/);
    expect(body.data.proposal_id).toMatch(/^pc_/);
    expect(body.data.degraded).toBe(false);
    expect(body.data.projection_version).toBe(booted.config.projection.version());

    const proposal = await jsonOf(await api(booted, `/api/proposals/${body.data.proposal_id}`));
    expect(proposal.ok).toBe(true);
    expect(proposal.data).toMatchObject({ status: 'proposed', kind: 'capture_task', degraded: false });
    expect(proposal.data.details.task.title).toContain('李四');
    expect(proposal.data.available_actions).toEqual(['proposal_accept', 'proposal_reject']);

    const events = await booted.harness.store.readStream(asProjectId(DEFAULT_PROJECT_ID), 1);
    expect(events.some((e) => e.type === 'FeedbackReceived' && (e.payload as Record<string, unknown>)['capture_id'] === body.data.capture_id)).toBe(true);
  });

  it('同一 client_submit_id 重放只入账一次（幂等），返回首次 capture_id', async () => {
    const before = booted.config.projection.version();
    const first = await jsonOf(await api(booted, '/api/capture', {
      method: 'POST',
      body: JSON.stringify({ text: '整理季度复盘材料', client_submit_id: 'cap-fixed-1' }),
    }));
    const secondRaw = await api(booted, "/api/capture", {
      method: 'POST',
      body: JSON.stringify({ text: '整理季度复盘材料', client_submit_id: 'cap-fixed-1' }),
    });
    const second = await jsonOf(secondRaw);
    expect(secondRaw.status, JSON.stringify(second)).toBe(200);
    expect(second.data.capture_id).toBe(first.data.capture_id);
    expect(second.data.proposal_id).toBe(first.data.proposal_id);
    expect(second.data.replayed).toBe(true);
    const after = booted.config.projection.version();
    expect(after - before).toBe(2); // PlanChangeProposed + FeedbackReceived，仅一次
  });

  it('text 缺失 → 400', async () => {
    const response = await api(booted, '/api/capture', { method: 'POST', body: JSON.stringify({}) });
    expect(response.status).toBe(400);
    expect((await jsonOf(response)).error.code).toBe('bad_request');
  });
});
