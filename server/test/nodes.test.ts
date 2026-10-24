// K1-B 执行节点测试（K1-SPEC v0.4 §4）：注册/心跳/$system 流、长轮询派发、
// ack 租约、租约过期分流（REQ-RUN-4）、awaiting_node、能力匹配、取消确认、
// probe 对账（REQ-RUN-3）、重启恢复、错令牌隔离（K1B-AC-12）。
// 构造走真实命令链（capture → proposal_accept → task_advance），节点交互
// 全部走 HTTP 端点；时间操纵走运维表直写（租约/心跳时刻是运维状态）。
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { asProjectId } from '../../src/kernel/events.ts';
import { api, bootApp, jsonOf, stubProposer, DEFAULT_PROJECT_ID, type BootedApp } from './support/harness.ts';
import type { Proposer } from '../src/proposers/proposer.ts';

const PROJECT = DEFAULT_PROJECT_ID;
let seq = 0;
const sid = (name: string) => `nodes-${name}-${++seq}`;

function agentProposer(): Proposer {
  const base = stubProposer();
  return {
    interpretCapture: async ({ text }) => ({
      title: `代理任务：${text.slice(0, 12)}`,
      description: text,
      assignee_kind: 'agent' as const,
      acceptance_criteria: [{ criterion_ref: 'c1', text: '产出可核对结果', auto: false }],
      rationale: '测试替身（agent）',
      meta: { source: 'model' as const, model: 'stub', degraded: false, degraded_reason: null, latency_ms: 1 },
    }),
    interpretFeedback: base.interpretFeedback,
  };
}

async function command(booted: BootedApp, type: string, payload: Record<string, unknown>, name: string) {
  const res = await api(booted, '/api/commands', {
    method: 'POST',
    body: JSON.stringify({ type, payload, client_submit_id: sid(name) }),
  });
  return { status: res.status, body: await jsonOf(res) };
}

/** 真实命令链造一条 agent Task 并推进到 active（生成 executor Run）。 */
async function makeAgentRun(
  booted: BootedApp,
  opts: { level?: string; command?: string; note?: string } = {},
): Promise<{ task_id: string; run_id: string }> {
  const cap = await jsonOf(
    await api(booted, '/api/capture', {
      method: 'POST',
      body: JSON.stringify({ text: '在节点上执行检查', client_submit_id: sid('cap') }),
    }),
  );
  const accepted = await command(booted, 'proposal_accept', { proposal_id: cap.data.proposal_id }, 'accept');
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
  const task_id = accepted.body.data.subject.task_id as string;
  const ready = await command(booted, 'task_advance', { task_id }, 'ready');
  expect(ready.status, JSON.stringify(ready.body)).toBe(201);
  const active = await command(
    booted,
    'task_advance',
    {
      task_id,
      ...(opts.level ? { side_effect_level: opts.level } : {}),
      ...(opts.command ? { command: opts.command } : {}),
      ...(opts.note ? { note_side_effect: opts.note } : {}),
    },
    'active',
  );
  expect(active.status, JSON.stringify(active.body)).toBe(201);
  const run_id = active.body.data.subject.run_id as string;
  expect(run_id).toBeTruthy();
  return { task_id, run_id };
}

async function nodePost(booted: BootedApp, path: string, body: Record<string, unknown> = {}, headers?: Record<string, string>) {
  const res = await api(booted, path, { method: 'POST', body: JSON.stringify(body), headers });
  return { status: res.status, body: await jsonOf(res) };
}

async function registerNode(booted: BootedApp, opts: { node_id?: string; kinds?: string[]; level?: string } = {}) {
  const res = await nodePost(booted, '/api/nodes/register', {
    ...(opts.node_id ? { node_id: opts.node_id } : {}),
    display_name: '测试节点',
    executor_kinds: opts.kinds ?? ['agent_hands_shell'],
    max_side_effect_level: opts.level ?? 'L1',
    agent_version: 'test/1.0',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.node_id as string;
}

/** 轮询直到领到目标 Run：途中领到的其他 Run 先持有（占用是排他的，不会被
 * 重复下发）、结束时统一 nack 释放——立即 nack 会让 FIFO 把同一单再次下发。
 * 返回目标 poll 响应（或 null）。 */
async function pollFor(booted: BootedApp, nodeId: string, runId: string, tries = 12) {
  const held: string[] = [];
  try {
    for (let i = 0; i < tries; i++) {
      const poll = await jsonOf(await api(booted, `/api/nodes/${nodeId}/dispatch-poll?wait=0`));
      if (!poll.data.dispatch) return null;
      if (poll.data.dispatch.run_id === runId) return poll.data;
      held.push(poll.data.dispatch.run_id);
    }
    return null;
  } finally {
    for (const id of held) {
      await nodePost(booted, `/api/nodes/${nodeId}/runs/${id}/nack`, { reason: 'not-target' });
    }
  }
}

async function projectRun(booted: BootedApp, run_id: string) {
  const body = await jsonOf(await api(booted, `/api/projects/${PROJECT}`));
  return body.data.runs.find((r: any) => r.run_id === run_id);
}

async function streamTypes(booted: BootedApp, stream = PROJECT) {
  const events = await booted.harness.store.readStream(asProjectId(stream), 1);
  return events;
}

describe('K1-B 节点生命周期与 $system 流（AC-01/02）', () => {
  let booted: BootedApp;
  beforeAll(async () => {
    booted = await bootApp({ proposer: agentProposer() });
  });
  afterAll(async () => {
    await booted.close();
  });

  it('AC-01：注册落 NodeRegistered、列表含节点与能力；同 id 重注册不重复发事件', async () => {
    const nodeId = await registerNode(booted, { node_id: 'node-ac01' });
    expect(nodeId).toBe('node-ac01');
    await registerNode(booted, { node_id: 'node-ac01' });

    const system = await streamTypes(booted, '$system');
    const registered = system.filter((e) => e.type === 'NodeRegistered');
    expect(registered).toHaveLength(1);
    expect(registered[0]!.payload).toMatchObject({ node_id: 'node-ac01', executor_kinds: ['agent_hands_shell'] });

    const list = await jsonOf(await api(booted, '/api/nodes'));
    const view = list.data.nodes.find((n: any) => n.node_id === 'node-ac01');
    expect(view).toMatchObject({ status: 'online', max_side_effect_level: 'L1', display_name: '测试节点' });
  });

  it('AC-02：心跳更新存活；超 stale/offline 阈值状态翻转；offline 收敛补发 NodeOffline 只一次', async () => {
    const d = booted.config.dispatcher;
    await booted.harness.pool.query(`UPDATE node_agents SET last_heartbeat_at = now() - interval '45 seconds' WHERE node_id='node-ac01'`);
    let list = await jsonOf(await api(booted, '/api/nodes'));
    expect(list.data.nodes.find((n: any) => n.node_id === 'node-ac01').status).toBe('stale');

    await nodePost(booted, '/api/nodes/node-ac01/heartbeat');
    list = await jsonOf(await api(booted, '/api/nodes'));
    expect(list.data.nodes.find((n: any) => n.node_id === 'node-ac01').status).toBe('online');

    await booted.harness.pool.query(`UPDATE node_agents SET last_heartbeat_at = now() - interval '120 seconds' WHERE node_id='node-ac01'`);
    await d.tick();
    await d.tick();
    const system = await streamTypes(booted, '$system');
    const offline = system.filter(
      (e) => e.type === 'NodeOffline' && (e.payload as any).node_id === 'node-ac01' && (e.payload as any).reason === 'heartbeat_timeout',
    );
    expect(offline).toHaveLength(1);
    list = await jsonOf(await api(booted, '/api/nodes'));
    expect(list.data.nodes.find((n: any) => n.node_id === 'node-ac01').status).toBe('offline');

    // 恢复心跳自动回 online
    await nodePost(booted, '/api/nodes/node-ac01/heartbeat');
    list = await jsonOf(await api(booted, '/api/nodes'));
    expect(list.data.nodes.find((n: any) => n.node_id === 'node-ac01').status).toBe('online');
  });

  it('AC-02：注销落 NodeOffline(deregister)；注销后心跳 404 node_not_registered', async () => {
    const res = await nodePost(booted, '/api/nodes/node-ac01/deregister');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const system = await streamTypes(booted, '$system');
    const off = system.filter(
      (e) => e.type === 'NodeOffline' && (e.payload as any).node_id === 'node-ac01' && (e.payload as any).reason === 'deregister',
    );
    expect(off).toHaveLength(1);
    const hb = await nodePost(booted, '/api/nodes/node-ac01/heartbeat');
    expect(hb.status).toBe(404);
    expect(hb.body.error.detail.reason).toBe('node_not_registered');
  });
});

describe('K1-B 派发全链（AC-03/04/05/08/09/10/11）', () => {
  let booted: BootedApp;
  beforeAll(async () => {
    booted = await bootApp({ proposer: agentProposer() });
  });
  afterAll(async () => {
    await booted.close();
  });

  it('AC-04：无节点时 Run 保持 queued 且 state_reason=awaiting_node，不丢不改判', async () => {
    const { run_id } = await makeAgentRun(booted);
    await booted.config.dispatcher.tick();
    const run = await projectRun(booted, run_id);
    expect(run.state).toBe('queued');
    expect(run.state_reason).toBe('awaiting_node');
  });

  it('AC-03：注册→poll 信封→ack（租约同值）→started→副作用去重→心跳续租→raw-result 全链 + 重放幂等', async () => {
    const nodeId = await registerNode(booted, { node_id: 'node-ac03' });
    const { task_id, run_id } = await makeAgentRun(booted, { command: 'echo hello', note: '将调用 shell 工具' });

    const poll = await pollFor(booted, nodeId, run_id);
    expect(poll).toBeTruthy();
    expect(poll.dispatch).toMatchObject({
      run_id,
      task_id,
      idempotency_key: `run:${run_id}`,
      side_effect_level: 'L1',
      executor_kind: 'agent_hands_shell',
      lease_duration_sec: 45,
    });
    expect(poll.dispatch.input_snapshot.command).toBe('echo hello');
    expect(poll.dispatch.assignment_id).toBeTruthy();
    expect(poll.dispatch.contract_rev).toBe(1);
    expect(poll.cancel_requests).toEqual([]);
    expect(poll.probe_requests).toEqual([]);

    const ack = await nodePost(booted, `/api/nodes/${nodeId}/runs/${run_id}/ack`);
    expect(ack.status, JSON.stringify(ack.body)).toBe(200);
    const events = await streamTypes(booted);
    const leased = events.find((e) => e.type === 'RunLeased' && (e.payload as any).run_id === run_id);
    expect(leased).toBeTruthy();
    expect((leased!.payload as any).lease_expires_at).toBe(ack.body.data.lease_expires_at);
    // ack 幂等重放：同值返回、不重复落事件
    const ack2 = await nodePost(booted, `/api/nodes/${nodeId}/runs/${run_id}/ack`);
    expect(ack2.body.data.lease_expires_at).toBe(ack.body.data.lease_expires_at);
    expect((await streamTypes(booted)).filter((e) => e.type === 'RunLeased')).toHaveLength(1);

    const started = await nodePost(booted, `/api/nodes/${nodeId}/runs/${run_id}/started`);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect((await projectRun(booted, run_id)).state).toBe('running');

    // 副作用记录：同 client_note_id 只落一条
    await nodePost(booted, `/api/nodes/${nodeId}/runs/${run_id}/side-effect-note`, {
      tool_name: 'shell',
      note: '将调用 shell 工具',
      client_note_id: `note:${run_id}:start`,
    });
    await nodePost(booted, `/api/nodes/${nodeId}/runs/${run_id}/side-effect-note`, {
      tool_name: 'shell',
      note: '将调用 shell 工具',
      client_note_id: `note:${run_id}:start`,
    });
    const afterNotes = await streamTypes(booted);
    expect(afterNotes.filter((e) => e.type === 'RunSideEffectRecorded' && (e.payload as any).run_id === run_id)).toHaveLength(1);
    expect((await projectRun(booted, run_id)).side_effect_count).toBe(1);

    const hb = await nodePost(booted, `/api/nodes/${nodeId}/runs/${run_id}/heartbeat`);
    expect(hb.status).toBe(200);
    expect(Date.parse(hb.body.data.lease_expires_at)).toBeGreaterThanOrEqual(Date.parse(ack.body.data.lease_expires_at));

    const result = await nodePost(booted, `/api/nodes/${nodeId}/runs/${run_id}/raw-result`, {
      client_result_id: `res:run:${run_id}`,
      summary: '检查完成，一切正常',
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.data.run_state).toBe('succeeded');
    const finalRun = await projectRun(booted, run_id);
    expect(finalRun.state).toBe('succeeded');
    const all = await streamTypes(booted);
    expect(all.some((e) => e.type === 'OutcomeRecorded' && (e.payload as any).run_id === run_id)).toBe(true);
    const proj = await jsonOf(await api(booted, `/api/projects/${PROJECT}`));
    expect(proj.data.tasks.find((t: any) => t.task_id === task_id).lifecycle).toBe('awaiting_acceptance');

    // raw-result 重放：返回首次结果、零新事件
    const countBefore = (await streamTypes(booted)).length;
    const replay = await nodePost(booted, `/api/nodes/${nodeId}/runs/${run_id}/raw-result`, {
      client_result_id: `res:run:${run_id}`,
      summary: '检查完成，一切正常',
    });
    expect(replay.body.data).toEqual(result.body.data);
    expect((await streamTypes(booted)).length).toBe(countBefore);
  });

  it('AC-05：派发 30s 未 ack 自动释放；终态后迟到 ack 409 terminal_state', async () => {
    const nodeId = 'node-ac03';
    const { run_id } = await makeAgentRun(booted);
    const poll = await pollFor(booted, nodeId, run_id);
    expect(poll?.dispatch.run_id).toBe(run_id);
    await booted.harness.pool.query(`UPDATE run_dispatch SET dispatching_at = now() - interval '31 seconds' WHERE run_id=$1`, [run_id]);
    await booted.config.dispatcher.tick();
    const row = await booted.config.nodeStore.getDispatch(run_id);
    expect(row?.node_id).toBeNull();
    // 释放后原节点 ack → 409
    const ack = await nodePost(booted, `/api/nodes/${nodeId}/runs/${run_id}/ack`);
    expect(ack.status).toBe(409);
    expect(ack.body.error.detail.reason).toBe('precondition_unmet');
    // 重新领取走完后，迟到 ack → terminal_state
    await pollFor(booted, nodeId, run_id);
    await nodePost(booted, `/api/nodes/${nodeId}/runs/${run_id}/ack`);
    await nodePost(booted, `/api/nodes/${nodeId}/runs/${run_id}/started`);
    await nodePost(booted, `/api/nodes/${nodeId}/runs/${run_id}/raw-result`, { client_result_id: `res:run:${run_id}`, summary: 'done' });
    const late = await nodePost(booted, `/api/nodes/${nodeId}/runs/${run_id}/ack`);
    expect(late.status).toBe(409);
    expect(late.body.error.detail.reason).toBe('terminal_state');
  });

  it('AC-08：nack 后 Run 回 queued 并可被再次派发，不计惩罚', async () => {
    const nodeId = 'node-ac03';
    const { run_id } = await makeAgentRun(booted);
    const first = await pollFor(booted, nodeId, run_id);
    expect(first?.dispatch.run_id).toBe(run_id);
    const nack = await nodePost(booted, `/api/nodes/${nodeId}/runs/${run_id}/nack`, { reason: 'busy' });
    expect(nack.status).toBe(200);
    const second = await pollFor(booted, nodeId, run_id);
    expect(second?.dispatch.run_id).toBe(run_id);
    expect((await projectRun(booted, run_id)).state).toBe('queued');
  });

  it('AC-09：L2 Run 不派给 L1 节点（awaiting_node），L3 节点可领', async () => {
    const { run_id } = await makeAgentRun(booted, { level: 'L2' });
    await booted.config.dispatcher.tick();
    expect((await projectRun(booted, run_id)).state_reason).toBe('awaiting_node');
    // L1 节点反复轮询（nack 掉其他 L1 单）也永远领不到这条 L2 Run
    const notOffered = await pollFor(booted, 'node-ac03', run_id, 4);
    expect(notOffered).toBeNull();
    const bigNode = await registerNode(booted, { node_id: 'node-ac09', level: 'L3' });
    const pollL3 = await pollFor(booted, bigNode, run_id);
    expect(pollL3?.dispatch.run_id).toBe(run_id);
    expect(pollL3?.dispatch.side_effect_level).toBe('L2');
    // 释放占用，避免影响 AC-10 的节点状态
    await nodePost(booted, `/api/nodes/${bigNode}/runs/${run_id}/nack`, { reason: 'test-cleanup' });
  });

  it('AC-10：有 leased 的节点注销先释放回 queued；有 running 的节点注销 409 node_busy', async () => {
    const runA = await makeAgentRun(booted);
    await pollFor(booted, 'node-ac09', runA.run_id);
    await nodePost(booted, `/api/nodes/node-ac09/runs/${runA.run_id}/ack`);
    const dereg = await nodePost(booted, '/api/nodes/node-ac09/deregister');
    expect(dereg.status, JSON.stringify(dereg.body)).toBe(200);
    expect((await projectRun(booted, runA.run_id)).state).toBe('queued');

    const runB = await makeAgentRun(booted);
    await pollFor(booted, 'node-ac03', runB.run_id);
    await nodePost(booted, `/api/nodes/node-ac03/runs/${runB.run_id}/ack`);
    await nodePost(booted, `/api/nodes/node-ac03/runs/${runB.run_id}/started`);
    const busy = await nodePost(booted, '/api/nodes/node-ac03/deregister');
    expect(busy.status).toBe(409);
    expect(busy.body.error.detail.reason).toBe('node_busy');
    // 清理：走完该 Run 恢复节点可注销状态
    await nodePost(booted, `/api/nodes/node-ac03/runs/${runB.run_id}/raw-result`, {
      client_result_id: `res:run:${runB.run_id}`,
      summary: 'cleanup',
    });
  });

  it('AC-11：服务端重启后 queued/leased 以 PG 持久化恢复派发', async () => {
    const { run_id } = await makeAgentRun(booted);
    // 模拟重启：同 pool/store 重新装配应用（投影重演 + 运维表持久）。
    const { buildApp } = await import('../src/app.ts');
    const again = await buildApp({
      pool: booted.harness.pool,
      store: booted.harness.store,
      proposer: agentProposer(),
      clock: () => booted.harness.clock.now,
    });
    await again.config.projection.rebuild();
    // 队列里可能有更早的遗留 Run：先持有、后释放，逐个跳过直到目标 Run。
    const held: string[] = [];
    let offered: string | null = null;
    for (let i = 0; i < 12 && offered !== run_id; i++) {
      const data = await again.config.dispatcher.poll('node-ac03', 0);
      if (!data.dispatch) break;
      offered = data.dispatch.run_id;
      if (offered !== run_id) held.push(offered);
    }
    for (const id of held) await again.config.dispatcher.nack('node-ac03', id);
    expect(offered).toBe(run_id);
    const ack = await again.config.dispatcher.ack('node-ac03', run_id);
    expect(ack.lease_expires_at).toBeTruthy();
    again.config.hub.closeAll();
  });
});

describe('K1-B 租约过期分流与 probe 对账（AC-06/07）', () => {
  let booted: BootedApp;
  const NODE = 'node-lease';
  beforeAll(async () => {
    booted = await bootApp({ proposer: agentProposer() });
    await registerNode(booted, { node_id: NODE });
  });
  afterAll(async () => {
    await booted.close();
  });

  async function leaseAndStart(opts: { level?: string; note?: boolean } = {}) {
    const made = await makeAgentRun(booted, { level: opts.level, note: opts.note ? '有副作用' : undefined });
    const poll = await pollFor(booted, NODE, made.run_id);
    expect(poll?.dispatch.run_id).toBe(made.run_id);
    await nodePost(booted, `/api/nodes/${NODE}/runs/${made.run_id}/ack`);
    await nodePost(booted, `/api/nodes/${NODE}/runs/${made.run_id}/started`);
    return made;
  }

  async function expireLease(run_id: string) {
    await booted.harness.pool.query(`UPDATE run_dispatch SET lease_expires_at = now() - interval '1 second' WHERE run_id=$1`, [run_id]);
    await booted.config.dispatcher.tick();
  }

  it('AC-07a：leased 未 started 租约过期回 queued 并可重派', async () => {
    const { run_id } = await makeAgentRun(booted);
    await pollFor(booted, NODE, run_id);
    await nodePost(booted, `/api/nodes/${NODE}/runs/${run_id}/ack`);
    expect((await projectRun(booted, run_id)).state).toBe('leased');
    await expireLease(run_id);
    expect((await projectRun(booted, run_id)).state).toBe('queued');
    const poll = await pollFor(booted, NODE, run_id);
    expect(poll?.dispatch.run_id).toBe(run_id);
    await nodePost(booted, `/api/nodes/${NODE}/runs/${run_id}/nack`, { reason: 'test-cleanup' });
  });

  it('AC-07b：running 无副作用记录心跳丢失 → RunFailed(lease_expired)', async () => {
    const { run_id } = await leaseAndStart();
    await expireLease(run_id);
    const run = await projectRun(booted, run_id);
    expect(run.state).toBe('failed');
    const events = await streamTypes(booted);
    const failed = events.find((e) => e.type === 'RunFailed' && (e.payload as any).run_id === run_id);
    expect((failed!.payload as any).reason).toBe('lease_expired');
  });

  it('AC-07c：running 有副作用记录 → indeterminate；probe executed 补 Outcome 收敛且只处置一次', async () => {
    const { task_id, run_id } = await leaseAndStart({ note: true });
    await nodePost(booted, `/api/nodes/${NODE}/runs/${run_id}/side-effect-note`, {
      tool_name: 'shell',
      note: '已执行外部调用',
      client_note_id: `note:${run_id}:1`,
    });
    await expireLease(run_id);
    expect((await projectRun(booted, run_id)).state).toBe('indeterminate');

    const poll = await jsonOf(await api(booted, `/api/nodes/${NODE}/dispatch-poll?wait=0`));
    expect(poll.data.probe_requests).toEqual([{ run_id, idempotency_key: `probe:${run_id}` }]);

    const probe = await nodePost(booted, `/api/nodes/${NODE}/runs/${run_id}/probe-result`, {
      idempotency_key: `probe:${run_id}`,
      result: 'executed',
      summary: '对账确认已执行',
    });
    expect(probe.status, JSON.stringify(probe.body)).toBe(200);
    expect(probe.body.data.run_state).toBe('succeeded');
    expect((await projectRun(booted, run_id)).state).toBe('succeeded');
    const proj = await jsonOf(await api(booted, `/api/projects/${PROJECT}`));
    expect(proj.data.tasks.find((t: any) => t.task_id === task_id).lifecycle).toBe('awaiting_acceptance');

    // 重复回报同键 → 首次结果、零新 Outcome
    const outcomesBefore = (await streamTypes(booted)).filter((e) => e.type === 'OutcomeRecorded' && (e.payload as any).run_id === run_id).length;
    const replay = await nodePost(booted, `/api/nodes/${NODE}/runs/${run_id}/probe-result`, {
      idempotency_key: `probe:${run_id}`,
      result: 'executed',
      summary: '对账确认已执行',
    });
    expect(replay.body.data).toEqual(probe.body.data);
    const outcomesAfter = (await streamTypes(booted)).filter((e) => e.type === 'OutcomeRecorded' && (e.payload as any).run_id === run_id).length;
    expect(outcomesAfter).toBe(outcomesBefore);
  });

  it('AC-07d：probe not_executed → RunFailed；probe unknown → 生成 run_reconciliation Decision 且只处置一次', async () => {
    const a = await leaseAndStart({ note: true });
    await nodePost(booted, `/api/nodes/${NODE}/runs/${a.run_id}/side-effect-note`, {
      tool_name: 'shell',
      note: 'n',
      client_note_id: `note:${a.run_id}:1`,
    });
    await expireLease(a.run_id);
    const probeA = await nodePost(booted, `/api/nodes/${NODE}/runs/${a.run_id}/probe-result`, {
      idempotency_key: `probe:${a.run_id}`,
      result: 'not_executed',
    });
    expect(probeA.body.data.run_state).toBe('failed');
    expect((await projectRun(booted, a.run_id)).state).toBe('failed');

    const b = await leaseAndStart({ note: true });
    await nodePost(booted, `/api/nodes/${NODE}/runs/${b.run_id}/side-effect-note`, {
      tool_name: 'shell',
      note: 'n',
      client_note_id: `note:${b.run_id}:1`,
    });
    await expireLease(b.run_id);
    const probeB = await nodePost(booted, `/api/nodes/${NODE}/runs/${b.run_id}/probe-result`, {
      idempotency_key: `probe:${b.run_id}`,
      result: 'unknown',
    });
    expect(probeB.body.data.decision_id).toBe(`dec_probe_${b.run_id}`);
    expect((await projectRun(booted, b.run_id)).state).toBe('indeterminate');
    const actions = await jsonOf(await api(booted, '/api/actions'));
    const item = actions.data.items.find((i: any) => i.decision_id === `dec_probe_${b.run_id}`);
    expect(item).toBeTruthy();
    expect(item.subject_ref).toEqual({ kind: 'run_reconciliation', id: b.run_id });
    // 只处置一次：换键再报 → 409
    const again = await nodePost(booted, `/api/nodes/${NODE}/runs/${b.run_id}/probe-result`, {
      idempotency_key: `probe:${b.run_id}:second`,
      result: 'executed',
    });
    expect(again.status).toBe(409);
  });

  it('AC-06：task_cancel 后 poll 下发 cancel_requests，cancel-confirmed 推进 Task 取消落账', async () => {
    const { task_id, run_id } = await leaseAndStart();
    const cancel = await command(booted, 'task_cancel', { task_id, reason: '用户取消' }, 'cancel');
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(201);
    await booted.config.dispatcher.tick();
    const poll = await jsonOf(await api(booted, `/api/nodes/${NODE}/dispatch-poll?wait=0`));
    expect(poll.data.cancel_requests).toContain(run_id);
    const confirmed = await nodePost(booted, `/api/nodes/${NODE}/runs/${run_id}/cancel-confirmed`);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect((await projectRun(booted, run_id)).state).toBe('canceled');
    const proj = await jsonOf(await api(booted, `/api/projects/${PROJECT}`));
    expect(proj.data.tasks.find((t: any) => t.task_id === task_id).lifecycle).toBe('canceled');
  });
});

describe('K1-B 错令牌隔离（AC-12）', () => {
  it('节点面错令牌/用户令牌 401 且零状态变化；用户面用节点令牌 401', async () => {
    const booted = await bootApp({
      proposer: agentProposer(),
      auth: { accessToken: 'user-token-0123456789', nodeToken: 'node-token-0123456789', production: false, sessionTtlSec: 3600, cookieSecure: false },
    });
    try {
      const wrong = await nodePost(booted, '/api/nodes/register', { display_name: 'x', executor_kinds: ['agent_hands_shell'], max_side_effect_level: 'L1' }, { authorization: 'Bearer wrong-token-0000000000' });
      expect(wrong.status).toBe(401);
      const userOnNode = await nodePost(booted, '/api/nodes/register', { display_name: 'x', executor_kinds: ['agent_hands_shell'], max_side_effect_level: 'L1' }, { authorization: 'Bearer user-token-0123456789' });
      expect(userOnNode.status).toBe(401);

      const listRes = await api(booted, '/api/nodes', { headers: { authorization: 'Bearer user-token-0123456789' } });
      const list = await jsonOf(listRes);
      expect(list.data.nodes).toHaveLength(0);
      const system = await booted.harness.store.readStream(asProjectId('$system'), 1);
      expect(system).toHaveLength(0);

      const nodeOnUser = await api(booted, '/api/nodes', { headers: { authorization: 'Bearer node-token-0123456789' } });
      expect(nodeOnUser.status).toBe(401);

      const okReg = await nodePost(booted, '/api/nodes/register', { display_name: 'ok', executor_kinds: ['agent_hands_shell'], max_side_effect_level: 'L1' }, { authorization: 'Bearer node-token-0123456789' });
      expect(okReg.status).toBe(200);
    } finally {
      await booted.close();
    }
  });
});
