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

describe('§4 HTTP 契约：投影类端点', () => {
  it('GET /api/health → {ok:true}', async () => {
    const body = await jsonOf(await api(booted, '/api/health'));
    expect(body.ok).toBe(true);
    expect(body.db).toBe(true);
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
  });

  it('GET /api/projects/:projectId：目标 + 任务图摘要 + 验收状态，带 projection_version', async () => {
    const body = await jsonOf(await api(booted, `/api/projects/${DEFAULT_PROJECT_ID}`));
    expect(body.ok).toBe(true);
    expect(body.data.projection_version).toBe(booted.config.projection.version());
    expect(body.data.goal.statement).toContain('张三');
    expect(body.data.tasks).toHaveLength(4);
    expect(body.data.graph.nodes).toHaveLength(4);
    expect(body.data.acceptance_status).toMatchObject({ accepted: 1, total: 4 });
    const accepted = body.data.tasks.find((t: any) => t.task_id === 'task_demo_kickoff');
    expect(accepted.lifecycle).toBe('accepted');
    expect(accepted.acceptance.verdict).toBe('accepted');
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
      for (const action of item.available_actions) {
        expect(action.next === null || action.next.guard === 'allowed').toBe(true);
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
    expect(proposal.data.available_actions.map((a: any) => a.id)).toEqual(['accept_proposal', 'reject_proposal']);

    const events = await booted.harness.store.readStream(DEFAULT_PROJECT_ID, 1);
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
