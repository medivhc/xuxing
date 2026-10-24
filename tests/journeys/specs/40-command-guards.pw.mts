import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { ApiErrorBody, CommandResponse } from '../contract.mts';
import { DEMO } from '../journeys.config.mts';
import {
  capture,
  findTask,
  getHome,
  getProject,
  getProposal,
  postCommand,
  requestJson,
} from '../support/api.mts';

// ============================================================================
// 命令契约守卫（契约内含义务）：
//   1. 同一 client_submit_id 重复提交 POST /api/commands 必须幂等：
//      只生效一次，重复请求返回首次回执（duplicate=true，seq 不变）；
//      同 id 但命令内容不同 → 409 idempotency_conflict。
//   2. 越权命令：available_actions 不含该动作 → 409，回显服务端认定的
//      available_actions，且不追加任何事件（projection_version 不变）。
//
// 这些用例不创建任务：幂等用例使用 reject_proposal，越权用例使用种子里
// 已取消的历史任务，因此不会污染主旅程/降级旅程的 My Actions。
// ============================================================================

test.describe('命令契约守卫', () => {
  test('同一 client_submit_id 重复提交只生效一次；内容冲突回 409', async ({ request }) => {
    const before = await getHome(request);
    const captured = await capture(request, `幂等守卫 ${randomUUID().slice(0, 8)}`);
    expect(captured.proposal_id).toBeTruthy();
    const proposalId = captured.proposal_id!;
    expect(captured.projection_version).toBeGreaterThan(before.projection_version);

    const projectBefore = await getProject(request, DEMO.projectId);
    const taskCountBefore = projectBefore.task_graph.nodes.length;

    const clientSubmitId = `idem-${randomUUID()}`;
    const payload = { proposal_id: proposalId, reason: '幂等拒绝' };

    const first = await postCommand(request, 'reject_proposal', payload, clientSubmitId);
    expect(first.status).toBe(202);
    const firstBody = first.body as CommandResponse;
    expect(firstBody.receipt.client_submit_id).toBe(clientSubmitId);
    expect(firstBody.receipt.command_type).toBe('reject_proposal');
    expect(firstBody.receipt.duplicate).toBe(false);
    expect(firstBody.projection_version).toBeGreaterThanOrEqual(captured.projection_version);

    const firstSeq = firstBody.receipt.seq;
    const firstVersion = firstBody.projection_version;

    const proposalAfterFirst = await getProposal(request, proposalId);
    expect(proposalAfterFirst.status).toBe('rejected');
    expect(proposalAfterFirst.available_actions).toEqual([]);
    expect(proposalAfterFirst.projection_version).toBe(firstVersion);

    // ---- 同一 id 完全相同的内容：幂等重放，不产生第二次效果 ----------------
    const second = await postCommand(request, 'reject_proposal', payload, clientSubmitId);
    expect(second.status).toBe(202);
    const secondBody = second.body as CommandResponse;
    expect(secondBody.receipt.duplicate).toBe(true);
    expect(secondBody.receipt.seq).toBe(firstSeq);
    expect(secondBody.receipt.projection_version).toBe(firstBody.receipt.projection_version);
    expect(secondBody.projection_version).toBe(firstVersion);

    // 投影版本不变 = 没有追加事件；任务数不变 = 拒绝提议没有副作用。
    const homeAfter = await getHome(request);
    expect(homeAfter.projection_version).toBe(firstVersion);
    const projectAfter = await getProject(request, DEMO.projectId);
    expect(projectAfter.projection_version).toBe(firstVersion);
    expect(projectAfter.task_graph.nodes.length).toBe(taskCountBefore);
    expect(findTask(projectAfter, DEMO.canceledTaskId).lifecycle).toBe('canceled');

    // ---- 同一 id 不同 payload：409，仍不产生任何事件 ----------------------
    const conflicting = await postCommand(
      request,
      'reject_proposal',
      { proposal_id: proposalId, reason: '不同的拒绝理由' },
      clientSubmitId,
    );
    expect(conflicting.status).toBe(409);
    const conflictBody = conflicting.body as ApiErrorBody;
    expect(conflictBody.error.code).toBe('idempotency_conflict');
    expect(conflictBody.projection_version).toBe(firstVersion);
    expect((await getHome(request)).projection_version).toBe(firstVersion);

    // 原提议仍然只被拒绝过一次（事件数不变即可由版本号证明）。
    expect((await getProposal(request, proposalId)).status).toBe('rejected');
  });

  test('available_actions 不含 complete_task → 409，回显动作集且无副作用', async ({ request }) => {
    const before = await getHome(request);
    const projectBefore = await getProject(request, DEMO.projectId);
    const legacy = findTask(projectBefore, DEMO.canceledTaskId);
    expect(legacy.lifecycle).toBe('canceled');
    expect(legacy.available_actions).not.toContain('complete_task');

    const result = await postCommand(
      request,
      'complete_task',
      { task_id: DEMO.canceledTaskId },
      `unauthorized-${randomUUID()}`,
    );
    expect(result.status).toBe(409);
    const body = result.body as ApiErrorBody;
    // 终态任务在 mock 里先命中 terminal_state；真服务若归入 forbidden 也接受。
    expect(['terminal_state', 'forbidden']).toContain(body.error.code);
    expect(body.error.available_actions).toBeDefined();
    expect(body.error.available_actions).not.toContain('complete_task');
    expect(body.projection_version).toBe(before.projection_version);

    const homeAfter = await getHome(request);
    expect(homeAfter.projection_version).toBe(before.projection_version);
    const projectAfter = await getProject(request, DEMO.projectId);
    expect(projectAfter.projection_version).toBe(before.projection_version);
    expect(findTask(projectAfter, DEMO.canceledTaskId).lifecycle).toBe('canceled');
  });

  test('未知命令类型 → 400，不追加事件', async ({ request }) => {
    const before = await getHome(request);
    const result = await postCommand(
      request,
      'launch_rocket',
      { target: 'moon' },
      `unknown-${randomUUID()}`,
    );
    expect(result.status).toBe(400);
    const body = result.body as ApiErrorBody;
    expect(body.error.code).toBe('invalid_request');
    expect((await getHome(request)).projection_version).toBe(before.projection_version);
  });

  test('缺少 client_submit_id → 400，不追加事件', async ({ request }) => {
    const before = await getHome(request);
    const result = await requestJson<ApiErrorBody>(request, '/api/commands', {
      method: 'POST',
      data: { type: 'reject_proposal', payload: { proposal_id: 'prop-missing-key' } },
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('invalid_request');
    expect((await getHome(request)).projection_version).toBe(before.projection_version);
  });
});
