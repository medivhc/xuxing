import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, bootApp, jsonOf, type BootedApp } from './support/harness.ts';
import { DEFAULT_PROJECT_ID } from '../src/seed/demo.ts';
import { asProjectId } from '../../src/kernel/events.ts';

// ============================================================================
// K0-Q12 / C6 API 级真服务 e2e（真 PG + 真 HTTP）：
// - REQ-ACC-2：Agent 执行者自验收被拦截（409，零落盘）；独立评审 agent 可验收；
//   system 对非 auto 判据代判被拦；human_light 人类自验收保留放行（self_acceptance 标记）；
// - actor 伪造/缺失/类型错：payload acceptor 自称、非法 actor_id、非法 actor_kind → 400；
// - INV-6：POST /api/evidence 写 tool_output → 409（含夹带伪造网关凭据）；
//   普通 source_kind 正向入账且投影透出 actor 与 recorded_via。
// ============================================================================

let booted: BootedApp;

beforeAll(async () => {
  booted = await bootApp();
});

afterAll(async () => {
  await booted.close();
});

interface CallOptions {
  actor?: string;
  kind?: string;
}

async function command(body: unknown, opts: CallOptions = {}) {
  const headers: Record<string, string> = {};
  if (opts.kind) headers['x-xuxing-actor-kind'] = opts.kind;
  const response = await api(booted, '/api/commands', {
    method: 'POST',
    body: JSON.stringify(body),
    actor: opts.actor,
    headers,
  });
  return { status: response.status, body: await jsonOf(response) };
}

async function evidence(body: unknown, opts: CallOptions = {}) {
  const headers: Record<string, string> = {};
  if (opts.kind) headers['x-xuxing-actor-kind'] = opts.kind;
  const response = await api(booted, '/api/evidence', {
    method: 'POST',
    body: JSON.stringify(body),
    actor: opts.actor,
    headers,
  });
  return { status: response.status, body: await jsonOf(response) };
}

async function capture(text: string, client_submit_id: string) {
  const body = await jsonOf(await api(booted, '/api/capture', {
    method: 'POST',
    body: JSON.stringify({ text, client_submit_id }),
  }));
  return body.data as { capture_id: string; proposal_id: string };
}

async function projectView() {
  const body = await jsonOf(await api(booted, `/api/projects/${DEFAULT_PROJECT_ID}`));
  return body.data;
}

async function streamEvents() {
  return booted.harness.store.readStream(asProjectId(DEFAULT_PROJECT_ID));
}

async function eventCount(): Promise<number> {
  return (await streamEvents()).length;
}

/** 走命令 API 把一个任务推到 awaiting_acceptance（human_light，执行者 = user_demo）。 */
async function taskAwaitingAcceptance(tag: string): Promise<string> {
  const captured = await capture(`Q12 用例任务 ${tag}`, `${tag}-cap`);
  const accepted = await command({
    type: 'proposal_accept',
    payload: { proposal_id: captured.proposal_id },
    client_submit_id: `${tag}-accept`,
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
  const task_id = accepted.body.data.subject.task_id as string;
  for (const step of ['ready', 'active']) {
    const advanced = await command({
      type: 'task_advance',
      payload: { task_id },
      client_submit_id: `${tag}-${step}`,
    });
    expect(advanced.status, JSON.stringify(advanced.body)).toBe(201);
  }
  const feedback = await command({
    type: 'feedback_submit',
    payload: { task_id, content: `已执行完毕（${tag}）` },
    client_submit_id: `${tag}-feedback`,
  });
  expect(feedback.status, JSON.stringify(feedback.body)).toBe(201);
  return task_id;
}

const PASS_ALL = [{ criterion_ref: 'c1', verdict: 'passed', evidence_refs: ['ev-ref-1'] }];

describe('REQ-ACC-2 actor 分离（命令层拦截，零落盘）', () => {
  it('正向：非执行者的人类验收 → 201，Acceptance 事件信封 actor 与投影 acceptor 一致', async () => {
    const task_id = await taskAwaitingAcceptance('q12-pos-human');
    const res = await command(
      {
        type: 'acceptance_record',
        payload: { task_id, criterion_results: PASS_ALL, rationale: '核对无误' },
        client_submit_id: 'q12-pos-human-acc',
      },
      { actor: 'human-reviewer' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.subject.verdict).toBe('accepted');
    expect(res.body.data.subject.self_acceptance).toBe(false);

    const events = await streamEvents();
    const acc = events.find(
      (e) => e.type === 'AcceptanceRecorded' && (e.payload as Record<string, unknown>).task_id === task_id,
    );
    expect(acc).toBeTruthy();
    expect(acc!.actor_id).toBe('human-reviewer');
    expect((acc!.payload as Record<string, unknown>).acceptor_id).toBe('human-reviewer');

    const view = await projectView();
    const task = view.tasks.find((t: any) => t.task_id === task_id);
    expect(task.lifecycle).toBe('accepted');
    expect(task.acceptance.acceptor_id).toBe('human-reviewer');
  });

  it('正向（保留口径）：human_light 的人类执行者自验收 → 201 且 self_acceptance=true 诚实落盘', async () => {
    const task_id = await taskAwaitingAcceptance('q12-pos-self');
    const res = await command({
      type: 'acceptance_record',
      payload: { task_id, criterion_results: PASS_ALL },
      client_submit_id: 'q12-pos-self-acc',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.subject.self_acceptance).toBe(true);
  });

  it('负向（C6 本体）：Agent 执行者验收自己执行的 Run → 409 acceptor_is_run_actor，零落盘', async () => {
    const task_id = await taskAwaitingAcceptance('q12-neg-agent');
    // 把 subject Outcome 改绑到一个 executor 类 Run（执行者 agent-exec-1），模拟 Agent 执行场景
    const store = booted.harness.store;
    const pid = asProjectId(DEFAULT_PROJECT_ID);
    await store.append({
      stream_id: pid, type: 'RunCreated', actor_id: 'agent-exec-1', actor_kind: 'agent',
      causation_id: null, correlation_id: 'corr-q12-neg', idempotency_key: 'q12-neg-run-created',
      payload: {
        run_id: 'run_q12_agent', task_id, assignment_id: null, run_kind: 'executor',
        actor_id: 'agent-exec-1', actor_version: 'k0', side_effect_level: 'L1',
      },
    });
    await store.append({
      stream_id: pid, type: 'RunStarted', actor_id: 'agent-exec-1', actor_kind: 'agent',
      causation_id: null, correlation_id: 'corr-q12-neg', idempotency_key: 'q12-neg-run-started',
      payload: { run_id: 'run_q12_agent' },
    });
    await store.append({
      stream_id: pid, type: 'RunSucceeded', actor_id: 'agent-exec-1', actor_kind: 'agent',
      causation_id: null, correlation_id: 'corr-q12-neg', idempotency_key: 'q12-neg-run-succeeded',
      payload: { run_id: 'run_q12_agent', outcome_id: 'out_q12_agent' },
    });
    await store.append({
      stream_id: pid, type: 'OutcomeRecorded', actor_id: 'outcome-interpreter', actor_kind: 'system',
      causation_id: null, correlation_id: 'corr-q12-neg', idempotency_key: 'q12-neg-outcome',
      payload: {
        outcome_id: 'out_q12_agent', task_id, run_id: 'run_q12_agent', feedback_id: null,
        conclusion_kind: 'achieved', info_obtained: true, certainty: 'high',
        evidence_sufficiency: 'sufficient', blockers: [], followup_suggestions: [],
        interpreted_by: 'test', proposal_id: 'pc_q12_neg',
      },
    });
    await booted.config.projection.refresh();

    const before = await eventCount();
    const versionBefore = booted.config.projection.version();

    // ① 执行者本人（agent）自验收 → 409
    const selfRes = await command(
      {
        type: 'acceptance_record',
        payload: { task_id, criterion_results: PASS_ALL },
        client_submit_id: 'q12-neg-agent-self',
      },
      { actor: 'agent-exec-1', kind: 'agent' },
    );
    expect(selfRes.status, JSON.stringify(selfRes.body)).toBe(409);
    expect(selfRes.body.error.detail.reason).toBe('acceptor_is_run_actor');
    expect(await eventCount()).toBe(before);
    expect(booted.config.projection.version()).toBe(versionBefore);

    // ② system 对非 auto 判据代判 → 409（判据 c1 来自 stub 提议器，auto=false）
    const sysRes = await command(
      {
        type: 'acceptance_record',
        payload: { task_id, criterion_results: PASS_ALL },
        client_submit_id: 'q12-neg-agent-system',
      },
      { actor: 'kernel-system', kind: 'system' },
    );
    expect(sysRes.status, JSON.stringify(sysRes.body)).toBe(409);
    expect(sysRes.body.error.detail.reason).toBe('manual_criterion_needs_reviewer');
    expect(await eventCount()).toBe(before);

    // ③ 正向收尾：独立评审 agent（未执行该 Run）可结论非 auto 判据 → 201
    const reviewerRes = await command(
      {
        type: 'acceptance_record',
        payload: { task_id, criterion_results: PASS_ALL },
        client_submit_id: 'q12-neg-agent-reviewer',
      },
      { actor: 'agent-reviewer-1', kind: 'agent' },
    );
    expect(reviewerRes.status, JSON.stringify(reviewerRes.body)).toBe(201);
    expect(reviewerRes.body.data.subject.verdict).toBe('accepted');
    expect(reviewerRes.body.data.subject.self_acceptance).toBe(false);
  });
});

describe('actor 伪造 / 缺失 / 类型错（命令入口）', () => {
  it('负向：payload.acceptor_id 冒充他人 → 400 acceptor_spoofed，零落盘', async () => {
    const task_id = await taskAwaitingAcceptance('q12-spoof');
    const before = await eventCount();
    const res = await command(
      {
        type: 'acceptance_record',
        payload: { task_id, criterion_results: PASS_ALL, acceptor_id: 'the-boss' },
        client_submit_id: 'q12-spoof-acc',
      },
      { actor: 'human-reviewer' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.detail.reason).toBe('acceptor_spoofed');
    expect(await eventCount()).toBe(before);
  });

  it('负向：actor_id 非法字符 → 400，零落盘', async () => {
    const before = await eventCount();
    const res = await command(
      { type: 'task_cancel', payload: { task_id: 'task_demo_contact' }, client_submit_id: 'q12-badactor' },
      { actor: 'bad actor!' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.detail.reason).toBe('actor_id_invalid');
    expect(await eventCount()).toBe(before);
  });

  it('负向：actor_kind 非法（superuser）→ 400，零落盘', async () => {
    const before = await eventCount();
    const res = await command(
      { type: 'task_cancel', payload: { task_id: 'task_demo_contact' }, client_submit_id: 'q12-badkind' },
      { kind: 'superuser' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.detail.reason).toBe('actor_kind_invalid');
    expect(await eventCount()).toBe(before);
  });

  it('负向：actor_kind=external 冒充命令通道 → 400', async () => {
    const res = await command(
      { type: 'task_cancel', payload: { task_id: 'task_demo_contact' }, client_submit_id: 'q12-extkind' },
      { kind: 'external' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.detail.reason).toBe('actor_kind_invalid');
  });
});

describe('INV-6 / evidence_add（POST /api/evidence）', () => {
  const evPayload = {
    project_id: DEFAULT_PROJECT_ID,
    source_kind: 'external_doc',
    content_ref: 'doc://q12/spec-note',
    content_hash: 'sha256:q12-1',
  };

  it('正向：external_doc 入账 → 201，投影透出 actor 与 recorded_via=direct；重放幂等', async () => {
    const res = await evidence(
      { payload: evPayload, client_submit_id: 'q12-ev-1' },
      { actor: 'human-reviewer' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.source_kind).toBe('external_doc');
    expect(res.body.data.replayed).toBe(false);

    const view = await projectView();
    const ev = view.evidences.find((e: any) => e.evidence_id === res.body.data.evidence_id);
    expect(ev).toBeTruthy();
    expect(ev.actor_id).toBe('human-reviewer');
    expect(ev.recorded_via).toBe('direct');
    expect(ev.content_hash).toBe('sha256:q12-1');

    const replay = await evidence({ payload: evPayload, client_submit_id: 'q12-ev-1' }, { actor: 'human-reviewer' });
    expect(replay.status).toBe(200);
    expect(replay.body.data.replayed).toBe(true);
    expect(replay.body.data.evidence_id).toBe(res.body.data.evidence_id);
  });

  it('正向：device_log 入账 → 201', async () => {
    const res = await evidence({
      payload: { ...evPayload, source_kind: 'device_log', content_ref: 'log://device/1', content_hash: 'sha256:q12-2' },
      client_submit_id: 'q12-ev-2',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.source_kind).toBe('device_log');
  });

  it('负向：tool_output 经普通命令口 → 409 tool_output_channel_required，零落盘', async () => {
    const before = await eventCount();
    const res = await evidence({
      payload: { ...evPayload, source_kind: 'tool_output', content_hash: 'sha256:q12-3' },
      client_submit_id: 'q12-ev-3',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.detail.reason).toBe('tool_output_channel_required');
    expect(await eventCount()).toBe(before);
  });

  it('负向：tool_output + payload 夹带伪造网关凭据字段 → 照样 409，零落盘', async () => {
    const before = await eventCount();
    const res = await evidence(
      {
        payload: {
          ...evPayload,
          source_kind: 'tool_output',
          content_hash: 'sha256:q12-4',
          gateway_credential: 'forged',
          recorded_via: 'tool_gateway',
          gateway_id: 'gw-forged',
        },
        client_submit_id: 'q12-ev-4',
      },
      { actor: 'agent-exec-1', kind: 'agent' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.detail.reason).toBe('tool_output_channel_required');
    expect(await eventCount()).toBe(before);
  });

  it('负向：source_kind 非枚举 → 400，零落盘', async () => {
    const before = await eventCount();
    const res = await evidence({
      payload: { ...evPayload, source_kind: 'top_secret' },
      client_submit_id: 'q12-ev-5',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.detail.reason).toBe('source_kind_invalid');
    expect(await eventCount()).toBe(before);
  });

  it('负向：项目不存在 → 409 project_not_found', async () => {
    const res = await evidence({
      payload: { ...evPayload, project_id: 'proj_nope' },
      client_submit_id: 'q12-ev-6',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.detail.reason).toBe('project_not_found');
  });
});
