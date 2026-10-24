import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { ApiErrorBody, CommandResultData } from '../contract.mts';
import { DEMO } from '../journeys.config.mts';
import {
  capture,
  expectCreatedCommand,
  expectReplayedCommand,
  findTask,
  getHome,
  getProject,
  getProposal,
  postCommand,
  requestJson,
} from '../support/api.mts';

// ============================================================================
// 命令契约守卫（契约内含义务，FIX-ROUND-1 R-5/R-6）
//
//   1. 幂等：同一 client_submit_id 重复提交只生效一次 ——
//      首次 201 + data.replayed=false；重放 200 + data.replayed=true 且 seq 不变；
//      同 id 但命令内容不同 → 409 conflict（detail.reason=idempotency_key_conflict）。
//   2. 越权：available_actions 不含该动作 → 409 conflict，detail 回显服务端认定的
//      available_actions，且不追加任何事件（projection_version 不变）。
//   3. 校验失败：未知 type / 缺 client_submit_id → 400 bad_request，不追加事件。
//
// 这些用例不污染主旅程/降级旅程：幂等用例先 capture 一条自己的提议再拒绝它；
// 越权用例用种子里已取消的任务（R-7①，available_actions=[]）；未知类型与缺键
// 在入口就被拒，根本不看任务。
// ============================================================================

test.describe('命令契约守卫', () => {
  test('同一 client_submit_id 重复提交只生效一次（201 → 200 replayed）；内容冲突 409', async ({
    request,
  }) => {
    const before = await getHome(request);
    const captured = await capture(request, `幂等守卫 ${randomUUID().slice(0, 8)}`);
    expect(captured.proposal_id).toBeTruthy();
    const proposalId = captured.proposal_id;
    expect(captured.projection_version).toBeGreaterThan(before.projection_version);

    const projectBefore = await getProject(request, DEMO.projectId);
    const taskCountBefore = projectBefore.tasks.length;

    const clientSubmitId = `idem-${randomUUID()}`;
    const payload = { proposal_id: proposalId, reason: '幂等拒绝' };

    // ---- 首次：201 + replayed=false ----------------------------------------
    const first = expectCreatedCommand(await postCommand(request, 'proposal_reject', payload, clientSubmitId));
    expect(first.command_type).toBe('proposal_reject');
    expect(first.client_submit_id).toBe(clientSubmitId);
    expect(first.subject.proposal_id).toBe(proposalId);
    expect(first.projection_version).toBeGreaterThanOrEqual(captured.projection_version);
    const firstVersion = first.projection_version;
    const firstReceipt = first.receipt_event_id;
    expect(first.emitted.length).toBeGreaterThan(0);

    const proposalAfterFirst = await getProposal(request, proposalId);
    expect(proposalAfterFirst.status).toBe('rejected');
    expect(proposalAfterFirst.available_actions).toEqual([]);
    expect(proposalAfterFirst.projection_version).toBe(firstVersion);

    // ---- 同一 id 完全相同的内容：200 + replayed=true，不追加事件 ----------
    const second = expectReplayedCommand(await postCommand(request, 'proposal_reject', payload, clientSubmitId));
    expect(second.command_type).toBe('proposal_reject');
    expect(second.emitted).toEqual([]);
    expect(second.subject).toEqual(first.subject);
    expect(second.receipt_event_id).toBe(firstReceipt);
    expect(second.projection_version).toBe(firstVersion);

    // 投影版本不变 = 没有追加事件；任务数不变 = 拒绝提议没有副作用。
    const homeAfter = await getHome(request);
    expect(homeAfter.projection_version).toBe(firstVersion);
    const projectAfter = await getProject(request, DEMO.projectId);
    expect(projectAfter.projection_version).toBe(firstVersion);
    expect(projectAfter.tasks.length).toBe(taskCountBefore);
    expect(findTask(projectAfter, DEMO.canceledTaskId).lifecycle).toBe('canceled');

    // ---- 同一 id 不同 payload：409 conflict，仍不产生任何事件 --------------
    const conflicting = await postCommand(
      request,
      'proposal_reject',
      { proposal_id: proposalId, reason: '不同的拒绝理由' },
      clientSubmitId,
    );
    expect(conflicting.status).toBe(409);
    const conflictBody = conflicting.body as ApiErrorBody;
    expect(conflictBody.ok).toBe(false);
    expect(conflictBody.error.code).toBe('conflict');
    expect((conflictBody.error.detail as { reason?: string } | undefined)?.reason).toBe(
      'idempotency_key_conflict',
    );
    expect((await getHome(request)).projection_version).toBe(firstVersion);
    expect((await getProposal(request, proposalId)).status).toBe('rejected');
  });

  test('available_actions 不含 task_advance → 409 conflict，回显动作集且无副作用', async ({ request }) => {
    const before = await getHome(request);
    const projectBefore = await getProject(request, DEMO.projectId);
    const canceled = findTask(projectBefore, DEMO.canceledTaskId);
    expect(canceled.lifecycle).toBe('canceled');
    expect(canceled.available_actions).toEqual([]);

    const result = await postCommand(
      request,
      'task_advance',
      { task_id: DEMO.canceledTaskId },
      `unauthorized-${randomUUID()}`,
    );
    expect(result.status).toBe(409);
    const body = result.body as ApiErrorBody;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('conflict');
    const detail = body.error.detail as {
      reason?: string;
      task_id?: string;
      lifecycle?: string;
      available_actions?: string[];
    };
    expect(detail.reason).toBe('not_in_available_actions');
    expect(detail.task_id).toBe(DEMO.canceledTaskId);
    expect(detail.lifecycle).toBe('canceled');
    // 服务端认定的动作集必须如实回显：终态任务没有可执行动作
    expect(detail.available_actions).toEqual([]);

    const homeAfter = await getHome(request);
    expect(homeAfter.projection_version).toBe(before.projection_version);
    const projectAfter = await getProject(request, DEMO.projectId);
    expect(projectAfter.projection_version).toBe(before.projection_version);
    expect(findTask(projectAfter, DEMO.canceledTaskId).lifecycle).toBe('canceled');
  });

  test('未知命令类型 → 400 bad_request，不追加事件', async ({ request }) => {
    const before = await getHome(request);
    const result = await postCommand(request, 'launch_rocket', { target: 'moon' }, `unknown-${randomUUID()}`);
    expect(result.status).toBe(400);
    const body = result.body as ApiErrorBody;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('bad_request');
    expect((body.error.detail as { field?: string } | undefined)?.field).toBe('type');
    expect((await getHome(request)).projection_version).toBe(before.projection_version);
  });

  test('缺少 client_submit_id → 400 bad_request，不追加事件', async ({ request }) => {
    const before = await getHome(request);
    const result = await requestJson<ApiErrorBody>(request, '/api/commands', {
      method: 'POST',
      data: { type: 'proposal_reject', payload: { proposal_id: DEMO.canceledTaskId } },
    });
    expect(result.status).toBe(400);
    const body = result.body as ApiErrorBody;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('bad_request');
    expect((body.error.detail as { field?: string } | undefined)?.field).toBe('client_submit_id');
    expect((await getHome(request)).projection_version).toBe(before.projection_version);
  });

  test('首次命令 201 与幂等重放的 data 形状一致（R-6：只差 replayed/emitted）', async ({ request }) => {
    // 用一条现场捕获的降级无关提议验证「201 与 200 的 data 键集相同」，
    // 避免调用方在两条路径上读不同的字段名。
    const captured = await capture(request, `回执形状 ${randomUUID().slice(0, 8)}`);
    const clientSubmitId = `shape-${randomUUID()}`;
    const payload = { proposal_id: captured.proposal_id, reason: '形状核对' };
    const created: CommandResultData = expectCreatedCommand(
      await postCommand(request, 'proposal_reject', payload, clientSubmitId),
    );
    const replayed: CommandResultData = expectReplayedCommand(
      await postCommand(request, 'proposal_reject', payload, clientSubmitId),
    );
    expect(Object.keys(replayed).sort()).toEqual(Object.keys(created).sort());
    expect(replayed.command_type).toBe(created.command_type);
    expect(replayed.subject).toEqual(created.subject);
    expect(replayed.replayed).not.toBe(created.replayed);
  });
});
