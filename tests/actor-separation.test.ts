import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { asProjectId } from '../src/kernel/events.js';
import type { EventStore } from '../src/kernel/event-store.js';
import { createPgEventStore, migrate, type PgEventStore } from '../src/kernel/event-store-pg.js';
import {
  ActorValidationError,
  ToolOutputChannelError,
} from '../src/kernel/actor-guard.js';
import { ToolGateway, ToolGatewayCredentialError } from '../src/kernel/tool-gateway.js';
import { createTestPg, resetEventTables, type TestPg } from './support/pg.js';

// ============================================================================
// K0-Q12 / C6 内核级用例（真 PostgreSQL 16）：
// - actor 身份形状校验：缺失 / 空 / 类型错 / kind 非法 → 拒绝且零落盘；
// - AcceptanceRecorded：payload acceptor 与信封 actor 不一致（伪造）→ 拒绝；
// - INV-6：tool_output Evidence 通用写路径一律拒（含 payload 自称网关的伪造）；
// - Tool Gateway：凭据正确才可写 tool_output，且事件带审计字段、凭据不入事件。
// ============================================================================

const FIXED_NOW = new Date('2026-10-24T00:00:00.000Z');
const STREAM = asProjectId('project-q12');

let ctx: TestPg;
let store: PgEventStore;

beforeAll(async () => {
  ctx = await createTestPg();
  await migrate(ctx.pool);
  // 合入注记（Q12×Batch2）：本套件只测 actor 分离，不测 S3-② 建流规则（F13 由 event-store-pg 套件覆盖），故关 requireProjectCreated；生产默认恒 true 不变。
  store = createPgEventStore(ctx.pool, { clock: () => FIXED_NOW, requireProjectCreated: false });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetEventTables(ctx.pool);
});

function baseInput(overrides: Partial<Parameters<EventStore['append']>[0]> = {}): Parameters<EventStore['append']>[0] {
  return {
    stream_id: STREAM,
    type: 'TaskCaptured',
    actor_id: 'actor-human-1',
    actor_kind: 'human',
    causation_id: null,
    correlation_id: 'corr-q12',
    idempotency_key: null,
    payload: { task_id: 'task-q12', title: 'Q12 内核用例任务' },
    ...overrides,
  };
}

async function countEvents(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('select count(*)::int as n from events');
  return rows[0].n;
}

describe('actor 身份形状校验（写路径，零落盘）', () => {
  it('正向：合法 actor 正常入账，信封 actor 原样落盘', async () => {
    const event = await store.append(baseInput());
    expect(event.actor_id).toBe('actor-human-1');
    expect(event.actor_kind).toBe('human');
    expect(await countEvents(ctx.pool)).toBe(1);
  });

  it.each([
    ['空字符串', ''],
    ['纯空白', '   '],
    ['缺失（undefined）', undefined],
    ['类型错（number）', 123],
    ['类型错（null）', null],
    ['非法字符（含空格/感叹号）', 'bad actor!'],
    ['超长（129 位）', 'a'.repeat(129)],
  ])('负向：actor_id %s → ActorValidationError 且零落盘', async (_label, bad) => {
    await expect(store.append(baseInput({ actor_id: bad as never }))).rejects.toBeInstanceOf(ActorValidationError);
    expect(await countEvents(ctx.pool)).toBe(0);
  });

  it.each([
    ['非枚举 kind', 'superuser'],
    ['缺失 kind', undefined],
    ['类型错 kind（number）', 7],
  ])('负向：actor_kind %s → ActorValidationError 且零落盘', async (_label, bad) => {
    await expect(store.append(baseInput({ actor_kind: bad as never }))).rejects.toBeInstanceOf(ActorValidationError);
    expect(await countEvents(ctx.pool)).toBe(0);
  });
});

describe('AcceptanceRecorded 的 acceptor 一致性（防 payload 伪造验收人）', () => {
  const acceptancePayload = {
    acceptance_id: 'acc-q12-1',
    task_id: 'task-q12',
    contract_rev: 1,
    subject_outcome_id: 'out-q12-1',
    acceptor_id: 'actor-human-1',
    acceptor_kind: 'human',
    verdict: 'accepted',
    criterion_results: [{ criterion_ref: 'c1', verdict: 'passed', evidence_refs: [] }],
  };

  it('正向：acceptor 与信封一致 → 入账', async () => {
    const event = await store.append(baseInput({ type: 'AcceptanceRecorded', payload: acceptancePayload }));
    expect(event.type).toBe('AcceptanceRecorded');
    expect(await countEvents(ctx.pool)).toBe(1);
  });

  it('负向：payload acceptor 冒充他人 → 拒绝且零落盘', async () => {
    await expect(
      store.append(baseInput({
        type: 'AcceptanceRecorded',
        payload: { ...acceptancePayload, acceptor_id: 'someone-else' },
      })),
    ).rejects.toBeInstanceOf(ActorValidationError);
    expect(await countEvents(ctx.pool)).toBe(0);
  });

  it('负向：payload acceptor_kind 与信封不一致 → 拒绝且零落盘', async () => {
    await expect(
      store.append(baseInput({
        type: 'AcceptanceRecorded',
        payload: { ...acceptancePayload, acceptor_kind: 'system' },
      })),
    ).rejects.toBeInstanceOf(ActorValidationError);
    expect(await countEvents(ctx.pool)).toBe(0);
  });

  it('负向：payload 缺 acceptor_id → 拒绝且零落盘', async () => {
    const { acceptor_id: _drop, ...rest } = acceptancePayload;
    await expect(
      store.append(baseInput({ type: 'AcceptanceRecorded', payload: rest })),
    ).rejects.toBeInstanceOf(ActorValidationError);
    expect(await countEvents(ctx.pool)).toBe(0);
  });
});

describe('INV-6：Evidence 的 source_kind 封闭集与 tool_output 通道封锁', () => {
  const evidencePayload = {
    evidence_id: 'ev-q12-1',
    task_id: 'task-q12',
    content_ref: 'artifact://run-1/log.txt',
    content_hash: 'sha256:abc',
    verification_status: 'unverified',
  };

  it('正向：external_doc / device_log / user_statement / agent_claim 经通用路径入账', async () => {
    for (const kind of ['external_doc', 'device_log', 'user_statement', 'agent_claim']) {
      const event = await store.append(baseInput({
        type: 'EvidenceAdded',
        payload: { ...evidencePayload, evidence_id: `ev-q12-${kind}`, source_kind: kind },
      }));
      expect((event.payload as Record<string, unknown>).source_kind).toBe(kind);
    }
    expect(await countEvents(ctx.pool)).toBe(4);
  });

  it('负向：tool_output 经通用 append → ToolOutputChannelError 且零落盘', async () => {
    await expect(
      store.append(baseInput({ type: 'EvidenceAdded', payload: { ...evidencePayload, source_kind: 'tool_output' } })),
    ).rejects.toBeInstanceOf(ToolOutputChannelError);
    expect(await countEvents(ctx.pool)).toBe(0);
  });

  it('负向：payload 自称已过网关（伪造 recorded_via/gateway 字段）→ 照样拒绝', async () => {
    await expect(
      store.append(baseInput({
        type: 'EvidenceAdded',
        payload: {
          ...evidencePayload,
          source_kind: 'tool_output',
          recorded_via: 'tool_gateway',
          gateway_id: 'gw-forged',
          gateway_credential: 'whatever',
        },
      })),
    ).rejects.toBeInstanceOf(ToolOutputChannelError);
    expect(await countEvents(ctx.pool)).toBe(0);
  });

  it('负向：source_kind 枚举外值 → ActorValidationError 且零落盘', async () => {
    await expect(
      store.append(baseInput({
        type: 'EvidenceAdded',
        payload: { ...evidencePayload, source_kind: 'top_secret' },
      })),
    ).rejects.toBeInstanceOf(ActorValidationError);
    expect(await countEvents(ctx.pool)).toBe(0);
  });

  it('口径：source_kind 缺失不在内核拦截面（必填性由命令层 evidence_add 把关，见 server e2e）', async () => {
    const payload: Record<string, unknown> = { ...evidencePayload };
    delete payload.source_kind;
    const event = await store.append(baseInput({ type: 'EvidenceAdded', payload }));
    expect(event.type).toBe('EvidenceAdded');
    expect(await countEvents(ctx.pool)).toBe(1);
  });

  it('负向：网关专用入口写非 EvidenceAdded 类型 → ToolOutputChannelError', async () => {
    await expect(
      store.appendToolOutputEvidence({ ...baseInput(), gateway_id: 'gw-1' }),
    ).rejects.toBeInstanceOf(ToolOutputChannelError);
    expect(await countEvents(ctx.pool)).toBe(0);
  });
});

describe('Tool Gateway（专用凭据 + 审计字段）', () => {
  const evidenceInput = {
    stream_id: STREAM,
    actor_id: 'agent-exec-1',
    actor_kind: 'agent' as const,
    causation_id: null,
    correlation_id: 'corr-q12-gw',
    idempotency_key: null,
    payload: {
      evidence_id: 'ev-q12-gw-1',
      task_id: 'task-q12',
      content_ref: 'tool://run-1/stdout',
      content_hash: 'sha256:def',
      verification_status: 'unverified',
    },
  };

  it('正向：凭据正确 → tool_output 入账，payload 带内核注入的审计字段且不含凭据', async () => {
    const gateway = new ToolGateway(store, { gateway_id: 'gw-test', credential: 'gw-secret-1' });
    const event = await gateway.recordToolOutputEvidence('gw-secret-1', evidenceInput);
    const payload = event.payload as Record<string, unknown>;
    expect(payload.source_kind).toBe('tool_output');
    expect(payload.recorded_via).toBe('tool_gateway');
    expect(payload.gateway_id).toBe('gw-test');
    expect(JSON.stringify(payload)).not.toContain('gw-secret-1');
    expect(event.actor_id).toBe('agent-exec-1');
    expect(await countEvents(ctx.pool)).toBe(1);
  });

  it('正向：调用方自带 recorded_via/gateway_id 被内核审计值覆盖（防伪造审计来源）', async () => {
    const gateway = new ToolGateway(store, { gateway_id: 'gw-real', credential: 'gw-secret-2' });
    const event = await gateway.recordToolOutputEvidence('gw-secret-2', {
      ...evidenceInput,
      idempotency_key: 'gw-override-1',
      payload: { ...evidenceInput.payload, evidence_id: 'ev-q12-gw-2', recorded_via: 'direct', gateway_id: 'gw-forged' },
    });
    const payload = event.payload as Record<string, unknown>;
    expect(payload.recorded_via).toBe('tool_gateway');
    expect(payload.gateway_id).toBe('gw-real');
  });

  it('负向：凭据错误 → ToolGatewayCredentialError 且零落盘', async () => {
    const gateway = new ToolGateway(store, { gateway_id: 'gw-test', credential: 'gw-secret-1' });
    await expect(gateway.recordToolOutputEvidence('wrong-cred', evidenceInput)).rejects.toBeInstanceOf(
      ToolGatewayCredentialError,
    );
    expect(await countEvents(ctx.pool)).toBe(0);
  });

  it('负向：网关未配置凭据（fail-closed）→ 任何凭据都失败、零落盘', async () => {
    const gateway = new ToolGateway(store, { gateway_id: 'gw-off', credential: null });
    expect(gateway.enabled).toBe(false);
    await expect(gateway.recordToolOutputEvidence('anything', evidenceInput)).rejects.toBeInstanceOf(
      ToolGatewayCredentialError,
    );
    expect(await countEvents(ctx.pool)).toBe(0);
  });
});
