import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { asProjectId, type EventEnvelope, type EventType, type ProjectId } from '../src/kernel/events.js';
import type { EventStore } from '../src/kernel/event-store.js';
import {
  CanonicalizationError,
  EventEntityMismatchError,
  GENESIS_HASH,
  IdempotencyKeyConflictError,
  PayloadNotPlainObjectError,
  ProjectStreamRequiredError,
  TerminalClosureRequiredError,
  TransitionDeniedError,
  TransitionPayloadError,
  TransitionPayloadMismatchError,
  TransitionStateError,
  UnknownEventTypeError,
  canonicalJson,
  computeEventHash,
  createPgEventStore,
  migrate,
  type PgEventStore,
} from '../src/kernel/event-store-pg.js';
import type { GuardFacts } from '../src/kernel/transition-guard.js';
import { createTestPg, assertPostgres16, resetEventTables, type TestPg } from './support/pg.js';

// ============================================================================
// PG Event Store 集成测试（真 PostgreSQL 16）
// 覆盖：C2（INV-13）、INV-12 哈希链、并发 append、append-only 触发器、
//       EventStore 接口一致性、非法迁移不产生事件、payload 规范化。
// 复审修复（F1–F9）另设独立 describe，负向用例逐条对应复审报告。
// ============================================================================

const FIXED_NOW = new Date('2026-10-21T00:00:00.000Z');
const STREAM = asProjectId('project-1');
const TASK_ID = 'task-1';
const RUN_ID = 'run-1';

function input(overrides: Partial<Parameters<EventStore['append']>[0]> = {}) {
  const base: Parameters<EventStore['append']>[0] = {
    stream_id: STREAM,
    type: 'TaskCaptured',
    actor_id: 'actor-human-1',
    actor_kind: 'human',
    causation_id: null,
    correlation_id: 'corr-1',
    idempotency_key: null,
    payload: { task_id: TASK_ID, title: '联系张三确认方案' },
  };
  return { ...base, ...overrides };
}

async function countEvents(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('select count(*)::int as n from events');
  return rows[0].n;
}

async function lastSeq(pool: Pool, streamId: string): Promise<number> {
  const { rows } = await pool.query<{ last_seq: string }>(
    'select last_seq from event_streams where stream_id = $1',
    [streamId],
  );
  return Number(rows[0].last_seq);
}

// ---------------------------------------------------------------------------
// 测试夹具：用通用 append 播种生命周期/运行态（generic append 只做矩阵纵深防御，
// 不评估前置条件），再用 appendStateTransition 验证写路径（F1 的 from 派生）。
// 所有 TaskLifecycleChanged 均带 trigger_event_id（F7 / spec §4）。
// ---------------------------------------------------------------------------

type SeedLifecycle = 'captured' | 'defined' | 'ready' | 'active' | 'awaiting_acceptance';

async function seedTaskAt(target: SeedLifecycle, taskId = TASK_ID): Promise<void> {
  await store.append(input({ payload: { task_id: taskId, title: '种子任务' } }));
  if (target === 'captured') return;

  const path: Array<[string, string]> = [
    ['captured', 'defined'],
    ['defined', 'ready'],
    ['ready', 'active'],
    ['active', 'awaiting_acceptance'],
  ];
  let current = 'captured';
  for (const [from, to] of path) {
    if (current === target) return;
    await store.append(input({
      type: 'TaskLifecycleChanged',
      payload: {
        task_id: taskId,
        from,
        to,
        trigger_event_id: `seed-${taskId}-${to}`,
      },
    }));
    current = to;
  }
}

async function seedRunAt(
  target: 'created' | 'queued' | 'leased' | 'running',
  runId = RUN_ID,
  taskId = TASK_ID,
): Promise<void> {
  await store.append(input({
    type: 'RunCreated',
    payload: { run_id: runId, task_id: taskId },
  }));
  if (target === 'created') return;
  await store.append(input({ type: 'RunQueued', payload: { run_id: runId, task_id: taskId } }));
  if (target === 'queued') return;
  await store.append(input({ type: 'RunLeased', payload: { run_id: runId, task_id: taskId } }));
  if (target === 'leased') return;
  await store.append(input({ type: 'RunStarted', payload: { run_id: runId, task_id: taskId } }));
}

interface TransitionOptions {
  from: string;
  to: string;
  entity?: 'task' | 'run';
  type?: EventType;
  payload?: Record<string, unknown>;
  facts?: GuardFacts;
  trigger_event_id?: string;
  causation_id?: string | null;
  idempotency_key?: string | null;
  run_id?: string;
  task_id?: string;
}

function transitionBase(options: TransitionOptions) {
  const entity = options.entity ?? 'task';
  return {
    stream_id: STREAM,
    type: options.type ?? ('TaskLifecycleChanged' as EventType),
    entity,
    from: options.from,
    to: options.to,
    actor_id: 'actor-human-1',
    actor_kind: 'human' as const,
    causation_id: options.causation_id ?? null,
    correlation_id: 'corr-1',
    idempotency_key: options.idempotency_key ?? null,
    trigger_event_id: options.trigger_event_id,
    facts: options.facts,
    payload: {
      ...(entity === 'task'
        ? { task_id: options.task_id ?? TASK_ID }
        : { run_id: options.run_id ?? RUN_ID }),
      ...(options.payload ?? {}),
    },
  };
}

function transition(options: TransitionOptions) {
  return store.appendStateTransition(transitionBase(options));
}

async function eventTypes(): Promise<string[]> {
  return (await store.readStream(STREAM)).map((event) => event.type);
}

let ctx: TestPg;
let store: PgEventStore;

beforeAll(async () => {
  ctx = await createTestPg();
  await migrate(ctx.pool);
  // 本套用例验证 store 机制（链/幂等/并发），使用不含 ProjectCreated 的局部流；
  // 项目流存在性由 tests/event-store-batch2.test.ts 的 S3-② 用例覆盖（生产默认强制）。
  store = createPgEventStore(ctx.pool, { clock: () => FIXED_NOW, requireProjectCreated: false });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetEventTables(ctx.pool);
});

describe('环境证据：真 PostgreSQL 16', () => {
  it('select version() 以 PostgreSQL 16 开头（不是 mock/内存实现）', async () => {
    const version = await assertPostgres16(ctx.pool);
    expect(version).toContain('PostgreSQL 16');
    expect(ctx.external).toBeTypeOf('boolean');
  });

  it('migrate 幂等（重复执行不报错）', async () => {
    await expect(migrate(ctx.pool)).resolves.toBeUndefined();
  });
});

describe('C2 / INV-13：同 idempotency_key 重复投递只入账一次', () => {
  it('同 key 顺序投递 3 次 → 1 行，信封 id/seq/global_seq/hash 完全相同，last_seq 只 +1', async () => {
    const key = 'feedback-submit-0001';
    const first = await store.append(input({ idempotency_key: key }));
    const second = await store.append(input({ idempotency_key: key }));
    const third = await store.append(input({ idempotency_key: key }));

    expect(await countEvents(ctx.pool)).toBe(1);
    expect(await lastSeq(ctx.pool, STREAM)).toBe(1);

    for (const envelope of [second, third]) {
      expect(envelope.id).toBe(first.id);
      expect(envelope.seq).toBe(first.seq);
      expect(envelope.global_seq).toBe(first.global_seq);
      expect(envelope.hash).toBe(first.hash);
      expect(envelope.prev_hash).toBe(first.prev_hash);
      expect(envelope.payload).toEqual(first.payload);
    }
    expect(third).toEqual(first);
  });

  it('同 key 3 路并发 → 仍 1 行，3 个返回值同一信封', async () => {
    const key = 'feedback-submit-concurrent';
    const results = await Promise.all([
      store.append(input({ idempotency_key: key })),
      store.append(input({ idempotency_key: key })),
      store.append(input({ idempotency_key: key })),
    ]);

    expect(await countEvents(ctx.pool)).toBe(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(new Set(results.map((r) => r.seq)).size).toBe(1);
    expect(new Set(results.map((r) => r.hash)).size).toBe(1);
  });

  it('同 key 不同内容 → IdempotencyKeyConflictError，行数不变（A3 裁决）', async () => {
    const key = 'feedback-submit-0002';
    await store.append(input({ idempotency_key: key }));

    await expect(
      store.append(input({ idempotency_key: key, payload: { task_id: 'other-task' } })),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);

    await expect(
      store.append(input({ idempotency_key: key, type: 'TaskDefined' })),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);

    expect(await countEvents(ctx.pool)).toBe(1);
  });

  it('同 key 不同 project 各自入账（唯一域 = (stream_id, key)，per-stream）', async () => {
    const key = 'same-key-two-projects';
    const a = await store.append(input({ stream_id: asProjectId('project-A'), idempotency_key: key }));
    const b = await store.append(input({ stream_id: asProjectId('project-B'), idempotency_key: key }));

    expect(a.id).not.toBe(b.id);
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(1);
    expect(await countEvents(ctx.pool)).toBe(2);
  });
});

describe('INV-12：哈希链', () => {
  it('首事件 prev_hash = 64 个 0；后续 prev_hash = 上一条 hash；可独立重算', async () => {
    const payloads = [
      { step: 1 },
      { step: 2, nested: { b: 2, a: 1 } },
      { step: 3, unicode: '张三 ✓' },
      { step: 4, num: 1.0, exp: 1e2 },
      { step: 5, list: [3, 2, 1] },
    ];
    for (const payload of payloads) {
      await store.append(input({ payload }));
    }

    const events = await store.readStream(STREAM);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events[0].prev_hash).toBe(GENESIS_HASH);
    expect(GENESIS_HASH).toBe('0'.repeat(64));

    for (let i = 0; i < events.length; i++) {
      if (i > 0) expect(events[i].prev_hash).toBe(events[i - 1].hash);
      const recomputed = computeEventHash(
        events[i].prev_hash,
        canonicalJson(events[i].payload),
        events[i].seq,
      );
      expect(recomputed).toBe(events[i].hash);
      expect(events[i].hash).toMatch(/^[0-9a-f]{64}$/);
    }

    const verification = await store.verifyChain(STREAM);
    expect(verification).toEqual({
      ok: true,
      stream_id: STREAM,
      length: 5,
      broken_at_seq: null,
      reason: null,
      stream_exists: true,
    });
  });

  it('jsonb 归一化不误报链断（1.0 / 1e2 / 深层对象 / Unicode 读回后仍验链通过）', async () => {
    await store.append(input({
      payload: { amount: 1.0, exp: 1e2, deep: { x: [1.0, 2e2] }, text: 'µ/ü/张三' },
    }));
    const [event] = await store.readStream(STREAM);
    // jsonb 会把 1.0 存成 1；读回的 payload 以 payload_canonical 为准，哈希不受影响
    expect(event.payload).toEqual({ amount: 1, exp: 100, deep: { x: [1, 200] }, text: 'µ/ü/张三' });
    expect((await store.verifyChain(STREAM)).ok).toBe(true);
  });

  it('verifyChain 真重算：绕过 store 插入断链行会被定位', async () => {
    await store.append(input({ payload: { step: 1 } }));
    await store.append(input({ payload: { step: 2 } }));

    // 直接 INSERT 一条 prev_hash 错误的行（模拟外部破坏/实现 bug）
    await ctx.pool.query(
      `INSERT INTO events
        (id, stream_id, seq, type, actor_id, actor_kind, causation_id, correlation_id,
         idempotency_key, payload, payload_canonical, prev_hash, hash, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,NULL,$8::jsonb,$9,$10,$11,$12)`,
      [
        '01J0000000000000000000TAMPER', STREAM, 3, 'TaskDefined',
        'actor-human-1', 'human', 'corr-1', JSON.stringify({ step: 3 }), canonicalJson({ step: 3 }),
        GENESIS_HASH, 'f'.repeat(64), FIXED_NOW.toISOString(),
      ],
    );

    const verification = await store.verifyChain(STREAM);
    expect(verification.ok).toBe(false);
    expect(verification.broken_at_seq).toBe(3);
    expect(verification.reason).toContain('prev_hash');
  });
});

describe('哈希编码 golden vector（编码一旦改动即红，Q1 冻结）', () => {
  it('genesis + seq 1 的固定向量', () => {
    const payload = { amount: 1.0, currency: 'CNY', tags: ['a', 'b'] };
    const canonical = canonicalJson(payload);
    expect(canonical).toBe('{"amount":1,"currency":"CNY","tags":["a","b"]}');
    expect(computeEventHash(GENESIS_HASH, canonical, 1))
      .toBe('3be4fc755914e1f7bf62e7fad4d28a827494992ef89c04d67dc1df1d138786c9');
  });

  it('非零 prev_hash + seq 7 的固定向量（含 Unicode 与深层对象）', () => {
    const payload = { nested: { y: 'ü', x: [3, 2, 1] }, name: '张三' };
    const canonical = canonicalJson(payload);
    expect(canonical).toBe('{"name":"张三","nested":{"x":[3,2,1],"y":"ü"}}');
    expect(computeEventHash('a'.repeat(64), canonical, 7))
      .toBe('681eb6144b683101f6e8fe7a1f5557bb2e3fc3f1294deb33638109a86034f61b');
  });

  it('编码含 0x1F 分隔符与十进制 seq（prev_hash 变化即 hash 变化）', () => {
    const canonical = canonicalJson({ a: 1 });
    expect(computeEventHash(GENESIS_HASH, canonical, 1))
      .not.toBe(computeEventHash(GENESIS_HASH, canonical, 2));
    expect(computeEventHash(GENESIS_HASH, canonical, 1))
      .not.toBe(computeEventHash('b'.repeat(64), canonical, 1));
  });
});

describe('payload 规范化（A4）', () => {
  it('键按 code unit 升序递归排序、数组保序、数值取 JSON 短表示', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, 1] } }))
      .toBe('{"a":{"c":[3,1],"d":2},"b":1}');
    expect(canonicalJson({ Z: 1, a: 2, 'Ä': 3 })).toBe('{"Z":1,"a":2,"Ä":3}');
    expect(canonicalJson({ x: 1.0, y: 1e2, z: -0 })).toBe('{"x":1,"y":100,"z":0}');
    expect(canonicalJson([{ b: 1, a: 2 }, null, true])).toBe('[{"a":2,"b":1},null,true]');
  });

  it('嵌套不可规范化的值 → CanonicalizationError，且不落库', async () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(CanonicalizationError);
    await expect(store.append(input({ payload: { a: undefined } })))
      .rejects.toBeInstanceOf(CanonicalizationError);
    expect(await countEvents(ctx.pool)).toBe(0);
  });

  it('未知事件类型 → UnknownEventTypeError，且不落库（不静默丢弃）', async () => {
    await expect(
      store.append(input({ type: 'NotAnEventType' as EventType })),
    ).rejects.toBeInstanceOf(UnknownEventTypeError);
    expect(await countEvents(ctx.pool)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F8：通用 append 的 payload 必须是 plain object（array/null/Date/Map 一律拒绝）
// ---------------------------------------------------------------------------
describe('F8：通用 append 只接受 plain object payload', () => {
  it.each([
    ['array', [1, 2, 3]],
    ['null', null],
    ['Date', new Date(FIXED_NOW)],
    ['Map', new Map([['a', 1]])],
    ['顶层 NaN', Number.NaN],
    ['顶层 undefined', undefined],
    ['bigint', 10n],
    ['function', () => 1],
    ['symbol', Symbol('x')],
  ])('%s payload → PayloadNotPlainObjectError，零落库', async (_name, bad) => {
    await expect(store.append(input({ payload: bad })))
      .rejects.toBeInstanceOf(PayloadNotPlainObjectError);
    expect(await countEvents(ctx.pool)).toBe(0);
  });

  it('appendStateTransition 的 payload 为 array → TransitionPayloadError，零落库', async () => {
    await expect(
      store.appendStateTransition({
        ...transitionBase({ from: 'captured', to: 'defined' }),
        payload: [1, 2],
      }),
    ).rejects.toBeInstanceOf(TransitionPayloadError);
    expect(await countEvents(ctx.pool)).toBe(0);
  });
});

describe('只追加：append-only 触发器（INV-12 纵深防御）', () => {
  it('UPDATE / DELETE 事件行一律失败', async () => {
    await store.append(input());

    await expect(
      ctx.pool.query("update events set payload = '{}'::jsonb"),
    ).rejects.toThrow(/append-only/i);

    await expect(ctx.pool.query('delete from events')).rejects.toThrow(/append-only/i);

    expect(await countEvents(ctx.pool)).toBe(1);
  });
});

describe('并发与 seq 原子分配', () => {
  it('20 路并发 append（不同 key）→ 20 行，seq 恰为 1..20，链完整', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.append(input({ payload: { i }, idempotency_key: `concurrent-${i}` })),
      ),
    );

    expect(await countEvents(ctx.pool)).toBe(20);
    expect(await lastSeq(ctx.pool, STREAM)).toBe(20);

    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(results.map((r) => r.global_seq)).size).toBe(20);
    expect((await store.verifyChain(STREAM)).ok).toBe(true);
  });

  it('跨 stream 并发：各流 seq 独立、global_seq 全库唯一（S5 起写路径全局串行，提交序=seq 序）', async () => {
    const results = await Promise.all([
      ...Array.from({ length: 5 }, (_, i) =>
        store.append(input({ stream_id: asProjectId('project-X'), payload: { i } }))),
      ...Array.from({ length: 5 }, (_, i) =>
        store.append(input({ stream_id: asProjectId('project-Y'), payload: { i } }))),
    ]);

    expect(new Set(results.map((r) => r.global_seq)).size).toBe(10);
    expect(await lastSeq(ctx.pool, 'project-X')).toBe(5);
    expect(await lastSeq(ctx.pool, 'project-Y')).toBe(5);
  });
});

describe('读路径：含起点语义（A5）', () => {
  it('readStream(from_seq) 含起点；replay(from_global_seq) 含起点且按 global_seq 升序', async () => {
    for (let i = 1; i <= 3; i++) await store.append(input({ payload: { i } }));

    expect((await store.readStream(STREAM, 2)).map((e) => e.seq)).toEqual([2, 3]);
    expect((await store.readStream(STREAM)).map((e) => e.seq)).toEqual([1, 2, 3]);

    const all = await store.replay(0);
    expect(all).toHaveLength(3);
    expect(all.map((e) => e.global_seq)).toEqual([1, 2, 3]);

    const tail = await store.replay(2);
    expect(tail.map((e) => e.global_seq)).toEqual([2, 3]);

    const globals = all.map((e) => e.global_seq);
    expect([...globals].sort((a, b) => a - b)).toEqual(globals);
  });
});

describe('接口一致性（接线第一层证据）', () => {
  it('createPgEventStore 可赋给 EventStore 接口并只经接口方法使用', async () => {
    const asInterface: EventStore = createPgEventStore(ctx.pool, { clock: () => FIXED_NOW, requireProjectCreated: false });
    const envelope = await asInterface.append(input());
    expect(envelope.seq).toBe(1);
    expect(await asInterface.readStream(STREAM)).toHaveLength(1);
    expect(await asInterface.replay(0)).toHaveLength(1);
  });

  it('index.ts 导出 store 工厂与校验器（接线审计可 grep）', async () => {
    const kernel = await import('../src/kernel/index.js');
    expect(kernel.createPgEventStore).toBeTypeOf('function');
    expect(kernel.migrate).toBeTypeOf('function');
    expect(kernel.guardTransition).toBeTypeOf('function');
  });
});

// ---------------------------------------------------------------------------
// F1：from 只来自事件流当前状态，调用方自述不得骗过写路径
// ---------------------------------------------------------------------------
describe('F1：appendStateTransition 从事件流派生期望 from', () => {
  it('TaskCaptured 后声称 awaiting_acceptance→accepted → from_mismatch（expected=captured）', async () => {
    await seedTaskAt('captured');
    const before = await countEvents(ctx.pool);

    await expect(
      transition({
        from: 'awaiting_acceptance',
        to: 'accepted',
        facts: { acceptanceVerdict: 'accepted' },
        causation_id: 'cause-f1',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TransitionStateError);
      const state = error as TransitionStateError;
      expect(state.reason).toBe('from_mismatch');
      expect(state.entity).toBe('task');
      expect(state.subject_id).toBe(TASK_ID);
      expect(state.expected_from).toBe('captured');
      expect(state.provided_from).toBe('awaiting_acceptance');
      return true;
    });

    expect(await countEvents(ctx.pool)).toBe(before);
  });

  it('已完成 captured→defined 后再声称 captured→defined → from_mismatch（expected=defined）', async () => {
    await seedTaskAt('captured');
    await transition({
      from: 'captured',
      to: 'defined',
      facts: { hasTitle: true, assigneeKind: 'human' },
      causation_id: 'cause-first',
    });
    const before = await countEvents(ctx.pool);

    await expect(
      transition({
        from: 'captured',
        to: 'defined',
        facts: { hasTitle: true, assigneeKind: 'human' },
        causation_id: 'cause-repeat',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TransitionStateError);
      expect((error as TransitionStateError).reason).toBe('from_mismatch');
      expect((error as TransitionStateError).expected_from).toBe('defined');
      return true;
    });

    expect(await countEvents(ctx.pool)).toBe(before);
  });

  it('事件流内没有该 Task → subject_not_found（不是 from_mismatch）', async () => {
    await store.append(input({ payload: { task_id: 'other-task', title: '别的任务' } }));

    await expect(
      transition({
        from: 'captured',
        to: 'defined',
        facts: { hasTitle: true, assigneeKind: 'human' },
        causation_id: 'cause-404',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TransitionStateError);
      expect((error as TransitionStateError).reason).toBe('subject_not_found');
      expect((error as TransitionStateError).subject_id).toBe(TASK_ID);
      return true;
    });
  });

  it('Run 无 RunCreated → subject_not_found；已有 RunStarted 却声称 leased → from_mismatch', async () => {
    await expect(
      transition({ entity: 'run', type: 'RunQueued', from: 'created', to: 'queued', run_id: 'run-404' }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TransitionStateError);
      expect((error as TransitionStateError).reason).toBe('subject_not_found');
      expect((error as TransitionStateError).subject_id).toBe('run-404');
      return true;
    });

    await seedRunAt('running');
    const before = await countEvents(ctx.pool);
    await expect(
      transition({
        entity: 'run',
        type: 'RunCanceled',
        from: 'leased',
        to: 'canceled',
        facts: { cancellationRequested: true },
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TransitionStateError);
      expect((error as TransitionStateError).reason).toBe('from_mismatch');
      expect((error as TransitionStateError).expected_from).toBe('running');
      return true;
    });
    expect(await countEvents(ctx.pool)).toBe(before);
  });

  it('payload 缺 task_id → subject_id_missing（分类可区分）', async () => {
    await expect(
      store.appendStateTransition({
        ...transitionBase({ from: 'captured', to: 'defined', causation_id: 'cause-x' }),
        payload: {},
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TransitionStateError);
      expect((error as TransitionStateError).reason).toBe('subject_id_missing');
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// F2：INV-11 收尾与迁移同事务；通用 append 不得绕过
// ---------------------------------------------------------------------------
describe('F2：INV-11 终态收尾同事务自动执行', () => {
  it('accepted 迁移自动补 WaitConditionCanceled + wait_state→none + lifecycle，顺序固定', async () => {
    await seedTaskAt('awaiting_acceptance');
    await store.append(input({
      type: 'WaitConditionCreated',
      payload: { wait_condition_id: 'wc-1', task_id: TASK_ID, kind: 'person' },
    }));
    await store.append(input({
      type: 'TaskWaitStateChanged',
      payload: {
        task_id: TASK_ID, from: 'none', to: 'waiting_on_person', reason: '等待对方回复',
        actor_id: 'actor-human-1', actor_kind: 'human',
      },
    }));
    const before = await countEvents(ctx.pool);

    const result = await transition({
      from: 'awaiting_acceptance',
      to: 'accepted',
      facts: { acceptanceVerdict: 'accepted' },
      causation_id: 'cause-accept',
    });

    expect(result.closure).not.toBeNull();
    expect(result.closure?.wait_conditions_canceled).toEqual(['wc-1']);
    expect(result.closure?.wait_state_reset_from).toBe('waiting_on_person');
    expect(result.closure?.effects_applied).toEqual([
      'cancel_active_wait_conditions',
      'reset_wait_state_none',
    ]);

    const events = await store.readStream(STREAM);
    expect(events.slice(before).map((event) => event.type)).toEqual([
      'WaitConditionCanceled',
      'TaskWaitStateChanged',
      'TaskLifecycleChanged',
    ]);
    const waitCanceled = events[before];
    expect(waitCanceled.payload).toMatchObject({
      wait_condition_id: 'wc-1',
      task_id: TASK_ID,
      reason: 'task_accepted',
    });
    expect(events[before + 1].payload).toMatchObject({
      task_id: TASK_ID,
      from: 'waiting_on_person',
      to: 'none',
      reason: 'task_accepted',
    });
    expect((await store.verifyChain(STREAM)).ok).toBe(true);
  });

  it('通用 append 直写 accepted/canceled → TerminalClosureRequiredError（F2 绕过口封堵）', async () => {
    await seedTaskAt('awaiting_acceptance');
    const before = await countEvents(ctx.pool);

    await expect(
      store.append(input({
        type: 'TaskLifecycleChanged',
        payload: {
          task_id: TASK_ID,
          from: 'awaiting_acceptance',
          to: 'accepted',
          trigger_event_id: 'trigger-accepted',
        },
      })),
    ).rejects.toBeInstanceOf(TerminalClosureRequiredError);

    await expect(
      store.append(input({
        type: 'TaskLifecycleChanged',
        payload: {
          task_id: TASK_ID,
          from: 'awaiting_acceptance',
          to: 'canceled',
          trigger_event_id: 'trigger-canceled',
        },
      })),
    ).rejects.toBeInstanceOf(TerminalClosureRequiredError);

    expect(await countEvents(ctx.pool)).toBe(before);
  });

  it('收尾与迁移同事务：调用方稍后抛错 → 全部回滚（含自动收尾事件）', async () => {
    await seedTaskAt('awaiting_acceptance');
    await store.append(input({
      type: 'WaitConditionCreated',
      payload: { wait_condition_id: 'wc-1', task_id: TASK_ID, kind: 'person' },
    }));
    await store.append(input({
      type: 'TaskWaitStateChanged',
      payload: {
        task_id: TASK_ID, from: 'none', to: 'waiting_on_person', reason: '等待对方回复',
        actor_id: 'actor-human-1', actor_kind: 'human',
      },
    }));
    const before = await countEvents(ctx.pool);
    const typesBefore = await eventTypes();

    await expect(
      store.withTransaction(async (tx) => {
        await tx.appendStateTransition({
          ...transitionBase({
            from: 'awaiting_acceptance',
            to: 'accepted',
            facts: { acceptanceVerdict: 'accepted' },
            causation_id: 'cause-accept-tx',
          }),
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await countEvents(ctx.pool)).toBe(before);
    const typesAfter = await eventTypes();
    expect(typesAfter).toEqual(typesBefore);
    expect(typesAfter).not.toContain('WaitConditionCanceled');
    expect((await store.verifyChain(STREAM)).ok).toBe(true);
  });

  it('同 idempotency_key 重放 accepted 迁移 → 返回首次事件，不重复执行收尾', async () => {
    await seedTaskAt('awaiting_acceptance');
    await store.append(input({
      type: 'WaitConditionCreated',
      payload: { wait_condition_id: 'wc-1', task_id: TASK_ID, kind: 'person' },
    }));
    await store.append(input({
      type: 'TaskWaitStateChanged',
      payload: {
        task_id: TASK_ID, from: 'none', to: 'waiting_on_person', reason: '等待对方回复',
        actor_id: 'actor-human-1', actor_kind: 'human',
      },
    }));

    const first = await transition({
      from: 'awaiting_acceptance',
      to: 'accepted',
      facts: { acceptanceVerdict: 'accepted' },
      causation_id: 'cause-idem',
      idempotency_key: 'accept-idem-1',
    });
    const before = await countEvents(ctx.pool);

    const replay = await transition({
      from: 'awaiting_acceptance',
      to: 'accepted',
      facts: { acceptanceVerdict: 'accepted' },
      causation_id: 'cause-idem',
      idempotency_key: 'accept-idem-1',
    });

    expect(replay.event).toEqual(first.event);
    expect(replay.closure).toBeNull();
    expect(await countEvents(ctx.pool)).toBe(before);
  });

  it('事务内 guard 拒绝 → 该事件不写，且事务可继续提交（拒绝发生在 SQL 之前）', async () => {
    await expect(
      store.withTransaction(async (tx) => {
        await tx.append(input({ payload: { task_id: TASK_ID, title: 'x' } }));
        await expect(
          tx.appendStateTransition(
            transitionBase({
              from: 'captured',
              to: 'defined',
              facts: { hasTitle: false, assigneeKind: 'human' },
              causation_id: 'cause-denied',
            }),
          ),
        ).rejects.toBeInstanceOf(TransitionDeniedError);
      }),
    ).resolves.toBeUndefined();

    expect(await countEvents(ctx.pool)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// F3：active→awaiting_acceptance 必须有 Run Outcome
// ---------------------------------------------------------------------------
describe('F3：active→awaiting_acceptance 需要事件流里有 OutcomeRecorded', () => {
  it('无 Outcome 时即便调用方自述 runOutcomeRecorded=true 也拒绝', async () => {
    await seedTaskAt('active');
    const before = await countEvents(ctx.pool);

    await expect(
      transition({
        from: 'active',
        to: 'awaiting_acceptance',
        facts: { runOutcomeRecorded: true },
        causation_id: 'cause-no-outcome',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TransitionDeniedError);
      const denied = error as TransitionDeniedError;
      expect(denied.result.reason).toBe('precondition_unmet');
      expect(denied.result.unmet).toContain('runOutcomeRecorded');
      return true;
    });

    expect(await countEvents(ctx.pool)).toBe(before);
  });

  it('先落 OutcomeRecorded → 同一迁移放行（fact 由流派生，不靠自述）', async () => {
    await seedTaskAt('active');
    await store.append(input({
      type: 'OutcomeRecorded',
      payload: { task_id: TASK_ID, outcome_id: 'outcome-1', conclusion_kind: 'done' },
    }));

    const result = await transition({
      from: 'active',
      to: 'awaiting_acceptance',
      causation_id: 'cause-outcome',
    });

    expect(result.event.type).toBe('TaskLifecycleChanged');
    expect(result.guard.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F5：触发条件编码在 guard/store，不接受「纯输入驱动」
// ---------------------------------------------------------------------------
describe('F5：defined→ready / ready→active / running→indeterminate 的条件', () => {
  it('defined→ready 缺 REQ-SCH-1 fact → precondition_facts_missing，补全后放行', async () => {
    await seedTaskAt('defined');
    const before = await countEvents(ctx.pool);

    await expect(
      transition({
        from: 'defined',
        to: 'ready',
        causation_id: 'cause-ready-missing',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TransitionDeniedError);
      const denied = error as TransitionDeniedError;
      expect(denied.result.reason).toBe('precondition_facts_missing');
      expect(denied.result.missing_facts?.map((hint) => hint.fact)).toEqual([
        'dependenciesSatisfied',
        'dataInputsAvailable',
        'capabilityAvailable',
        'policyAllows',
      ]);
      return true;
    });
    expect(await countEvents(ctx.pool)).toBe(before);

    const ok = await transition({
      from: 'defined',
      to: 'ready',
      facts: {
        dependenciesSatisfied: true,
        dataInputsAvailable: true,
        capabilityAvailable: true,
        policyAllows: true,
      },
      causation_id: 'cause-ready-ok',
    });
    expect(ok.guard.allowed).toBe(true);
  });

  it('ready→active 未派发 Run → 拒绝；runDispatched=true → 放行', async () => {
    await seedTaskAt('ready');

    await expect(
      transition({ from: 'ready', to: 'active', causation_id: 'cause-dispatch-missing' }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TransitionDeniedError);
      expect((error as TransitionDeniedError).result.unmet).toContain('runDispatched');
      return true;
    });

    const ok = await transition({
      from: 'ready',
      to: 'active',
      facts: { runDispatched: true },
      causation_id: 'cause-dispatch-ok',
    });
    expect(ok.guard.allowed).toBe(true);
  });

  it('running→indeterminate 缺 heartbeatLost → 拒绝；给定后放行', async () => {
    await seedRunAt('running');

    await expect(
      transition({
        entity: 'run',
        type: 'RunIndeterminate',
        from: 'running',
        to: 'indeterminate',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TransitionDeniedError);
      expect((error as TransitionDeniedError).result.reason).toBe('precondition_facts_missing');
      expect((error as TransitionDeniedError).result.unmet).toContain('heartbeatLost');
      return true;
    });

    const ok = await transition({
      entity: 'run',
      type: 'RunIndeterminate',
      from: 'running',
      to: 'indeterminate',
      facts: { heartbeatLost: true },
    });
    expect(ok.guard.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F4：取消意图 / 已启动 Run / 级联收尾的落点
// ---------------------------------------------------------------------------
describe('F4：取消级联（REQ-RUN-6）', () => {
  it('没有 TaskCancelRequested 时 task→canceled 被拒（自述 cancellationRequested 不算数）', async () => {
    await seedTaskAt('active');
    const before = await countEvents(ctx.pool);

    await expect(
      transition({
        from: 'active',
        to: 'canceled',
        facts: { cancellationRequested: true, allRunsTerminal: true },
        causation_id: 'cause-cancel-no-intent',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TransitionDeniedError);
      const denied = error as TransitionDeniedError;
      expect(denied.result.reason).toBe('precondition_unmet');
      expect(denied.result.unmet).toContain('cancellationRequested');
      return true;
    });

    expect(await countEvents(ctx.pool)).toBe(before);
    expect(await eventTypes()).not.toContain('TaskCanceled');
  });

  it('requestTaskCancellation 一次事务完成意图 + Decision/Assignment 收尾 + Run 取消 + TaskCanceled', async () => {
    await seedTaskAt('active');
    await store.append(input({
      type: 'DecisionCreated',
      payload: { decision_id: 'dec-1', subject_ref: TASK_ID },
    }));
    await store.append(input({
      type: 'AssignmentCreated',
      payload: { assignment_id: 'asg-1', task_id: TASK_ID },
    }));
    await seedRunAt('queued', 'run-1');
    const before = await countEvents(ctx.pool);

    const result = await store.requestTaskCancellation({
      stream_id: STREAM,
      task_id: TASK_ID,
      actor_id: 'actor-human-1',
      actor_kind: 'human',
      causation_id: 'cause-request',
      correlation_id: 'corr-cancel',
      idempotency_key: 'cancel-request-1',
      reason: '用户取消',
    });

    expect(result.cancel_requested?.type).toBe('TaskCancelRequested');
    expect(result.already_requested).toBe(false);
    expect(result.runs_canceled.map((event) => event.type)).toEqual(['RunCanceled']);
    expect(result.finalized).toBe(true);
    expect(result.task_lifecycle).toBe('canceled');
    expect(result.closure).toMatchObject({
      wait_conditions_canceled: [],
      wait_state_reset_from: null,
      decisions_expired: ['dec-1'],
      assignments_ended: ['asg-1'],
    });
    expect(result.closure?.task_canceled_event_id).toBeTypeOf('string');
    expect(result.closure?.effects_applied).toEqual([
      'expire_pending_decisions',
      'end_active_assignments',
      'cancel_active_wait_conditions',
      'reset_wait_state_none',
      'emit_task_canceled',
    ]);

    const events = await store.readStream(STREAM);
    expect(events.slice(before).map((event) => event.type)).toEqual([
      'TaskCancelRequested',
      'DecisionExpired',
      'AssignmentEnded',
      'RunCanceled',
      'TaskLifecycleChanged',
      'TaskCanceled',
    ]);
    const lifecycleEvent = events[before + 4];
    expect(lifecycleEvent.payload).toMatchObject({
      task_id: TASK_ID,
      from: 'active',
      to: 'canceled',
      trigger_event_id: result.cancel_requested?.id,
    });
    expect(events[before + 5].payload).toMatchObject({
      task_id: TASK_ID,
      lifecycle_event_id: lifecycleEvent.id,
      reason: '用户取消',
    });
    // Run 侧：未启动的 queued Run 直接 canceled（REQ-RUN-6②）
    expect(events[before + 3].payload).toMatchObject({
      run_id: 'run-1',
      task_id: TASK_ID,
      reason: 'task_canceled',
    });
    expect((await store.verifyChain(STREAM)).ok).toBe(true);
  });

  it('已启动 Run 不会被直接置 canceled：意图先落，等 Run 终态后再正式收尾', async () => {
    await seedTaskAt('active');
    await seedRunAt('running');
    const before = await countEvents(ctx.pool);

    const first = await store.requestTaskCancellation({
      stream_id: STREAM,
      task_id: TASK_ID,
      actor_id: 'actor-human-1',
      actor_kind: 'human',
      causation_id: 'cause-request-started',
      correlation_id: 'corr-cancel',
      idempotency_key: 'cancel-started-1',
    });

    expect(first.cancel_requested?.type).toBe('TaskCancelRequested');
    expect(first.runs_canceled).toEqual([]);
    expect(first.finalized).toBe(false);
    expect(first.task_lifecycle).toBe('active');
    expect(await eventTypes()).not.toContain('RunCanceled');
    expect(await eventTypes()).not.toContain('TaskCanceled');

    // Run 正常结束 → 再次请求只推进第③步（不重复记意图）
    await store.append(input({
      type: 'RunSucceeded',
      payload: { run_id: RUN_ID, task_id: TASK_ID },
    }));
    const second = await store.requestTaskCancellation({
      stream_id: STREAM,
      task_id: TASK_ID,
      actor_id: 'actor-human-1',
      actor_kind: 'human',
      causation_id: 'cause-finalize',
      correlation_id: 'corr-cancel',
      idempotency_key: null,
    });

    expect(second.cancel_requested).toBeNull();
    expect(second.already_requested).toBe(true);
    expect(second.finalized).toBe(true);
    expect(second.task_lifecycle).toBe('canceled');
    expect(second.closure?.task_canceled_event_id).toBeTypeOf('string');

    const types = await eventTypes();
    expect(types.filter((type) => type === 'TaskCancelRequested')).toHaveLength(1);
    expect(types.slice(-2)).toEqual(['TaskLifecycleChanged', 'TaskCanceled']);
    expect(await countEvents(ctx.pool)).toBe(before + 4); // 意图 + RunSucceeded + lifecycle + TaskCanceled
  });

  it('requestTaskCancellation 对 accepted 任务 → task_already_terminal（须另立 Task）', async () => {
    await seedTaskAt('awaiting_acceptance');
    await transition({
      from: 'awaiting_acceptance',
      to: 'accepted',
      facts: { acceptanceVerdict: 'accepted' },
      causation_id: 'cause-accept',
    });

    await expect(
      store.requestTaskCancellation({
        stream_id: STREAM,
        task_id: TASK_ID,
        actor_id: 'actor-human-1',
        actor_kind: 'human',
        causation_id: null,
        correlation_id: 'corr-cancel',
        idempotency_key: null,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TransitionStateError);
      expect((error as TransitionStateError).reason).toBe('task_already_terminal');
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// F6：事件类型必须参与迁移校验
// ---------------------------------------------------------------------------
describe('F6：事件类型与迁移格匹配（写路径）', () => {
  it('created→queued 配 RunSucceeded → event_type_mismatch，零落库', async () => {
    await seedRunAt('created');
    const before = await countEvents(ctx.pool);

    await expect(
      transition({
        entity: 'run',
        type: 'RunSucceeded',
        from: 'created',
        to: 'queued',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TransitionDeniedError);
      const denied = error as TransitionDeniedError;
      expect(denied.result.reason).toBe('event_type_mismatch');
      expect(denied.result.expected_event_types).toEqual(['RunQueued']);
      return true;
    });

    expect(await countEvents(ctx.pool)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// F7：TaskLifecycleChanged payload 必须带 trigger_event_id（spec §4）
// ---------------------------------------------------------------------------
describe('F7：TaskLifecycleChanged 的 trigger_event_id', () => {
  it('缺少显式 trigger 时由 causation_id 补齐并落库', async () => {
    await seedTaskAt('captured');
    const { event } = await transition({
      from: 'captured',
      to: 'defined',
      facts: { hasTitle: true, assigneeKind: 'human' },
      causation_id: 'cause-42',
    });

    expect((event.payload as { trigger_event_id: string }).trigger_event_id).toBe('cause-42');
    const stored = await store.readStream(STREAM, event.seq);
    expect((stored[0].payload as { trigger_event_id: string }).trigger_event_id).toBe('cause-42');
  });

  it('入参 trigger_event_id 覆盖 causation_id；payload 内的值优先级最高', async () => {
    await seedTaskAt('captured');
    const explicit = await transition({
      from: 'captured',
      to: 'defined',
      facts: { hasTitle: true, assigneeKind: 'human' },
      trigger_event_id: 'explicit-trigger',
      causation_id: 'cause-42',
    });
    expect((explicit.event.payload as { trigger_event_id: string }).trigger_event_id)
      .toBe('explicit-trigger');

    const fromPayload = await transition({
      from: 'defined',
      to: 'ready',
      facts: {
        dependenciesSatisfied: true,
        dataInputsAvailable: true,
        capabilityAvailable: true,
        policyAllows: true,
      },
      payload: { trigger_event_id: 'payload-trigger' },
      causation_id: 'cause-other',
    });
    expect((fromPayload.event.payload as { trigger_event_id: string }).trigger_event_id)
      .toBe('payload-trigger');
  });

  it('payload / 入参 / causation 都没有 → TransitionPayloadError，零落库', async () => {
    await seedTaskAt('captured');
    const before = await countEvents(ctx.pool);

    await expect(
      transition({
        from: 'captured',
        to: 'defined',
        facts: { hasTitle: true, assigneeKind: 'human' },
        causation_id: null,
      }),
    ).rejects.toBeInstanceOf(TransitionPayloadError);

    expect(await countEvents(ctx.pool)).toBe(before);
  });

  it('通用 append 直写 TaskLifecycleChanged 缺 trigger_event_id → TransitionPayloadError', async () => {
    await expect(
      store.append(input({
        type: 'TaskLifecycleChanged',
        payload: { task_id: TASK_ID, from: 'captured', to: 'defined' },
      })),
    ).rejects.toBeInstanceOf(TransitionPayloadError);
    expect(await countEvents(ctx.pool)).toBe(0);
  });
});

describe('verifyChain 运维真实性（F-b）', () => {
  it('不存在的 stream → ok:false / stream_not_found（不冒充健康空流）', async () => {
    expect(await store.verifyChain(asProjectId('proj-TYPO'))).toEqual({
      ok: false,
      stream_id: 'proj-TYPO',
      length: 0,
      broken_at_seq: null,
      reason: 'stream_not_found',
      stream_exists: false,
    });
    expect(await store.verifyChain('' as ProjectId)).toMatchObject({
      ok: false,
      reason: 'stream_not_found',
      stream_exists: false,
    });
  });

  it('链头 event_streams.last_hash 被改乱 → ok:false，报链头断点（不再假绿）', async () => {
    await store.append(input({ payload: { step: 1 } }));
    await store.append(input({ payload: { step: 2 } }));

    await ctx.pool.query(
      `UPDATE event_streams SET last_hash = $1 WHERE stream_id = $2`,
      ['a'.repeat(64), STREAM],
    );

    const verification = await store.verifyChain(STREAM);
    expect(verification.ok).toBe(false);
    expect(verification.stream_exists).toBe(true);
    expect(verification.broken_at_seq).toBe(2);
    expect(verification.reason).toContain('链头 last_hash');
  });

  it('链头 last_seq 与 events 行数不一致 → ok:false', async () => {
    await store.append(input({ payload: { step: 1 } }));

    await ctx.pool.query(
      `UPDATE event_streams SET last_seq = 9 WHERE stream_id = $1`,
      [STREAM],
    );

    const verification = await store.verifyChain(STREAM);
    expect(verification.ok).toBe(false);
    expect(verification.broken_at_seq).toBe(9);
    expect(verification.reason).toContain('链头 last_seq');
  });
});

describe('校验器嵌在写路径：非法迁移不产生事件（接线审计）', () => {
  it('appendStateTransition 非法迁移（accepted→canceled）→ TransitionDeniedError，行数不变', async () => {
    await seedTaskAt('awaiting_acceptance');
    await transition({
      from: 'awaiting_acceptance',
      to: 'accepted',
      facts: { acceptanceVerdict: 'accepted' },
      causation_id: 'cause-accept',
    });
    const before = await countEvents(ctx.pool);

    await expect(
      transition({
        from: 'accepted',
        to: 'canceled',
        causation_id: 'cause-illegal',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TransitionDeniedError);
      expect((error as TransitionDeniedError).result.reason).toBe('illegal_transition');
      return true;
    });

    expect(await countEvents(ctx.pool)).toBe(before);
  });

  it('appendStateTransition 前置条件不满足 → 拒绝且不落库', async () => {
    await seedTaskAt('captured');
    const before = await countEvents(ctx.pool);
    await expect(
      transition({
        from: 'captured',
        to: 'defined',
        facts: { hasTitle: false, assigneeKind: 'human' },
        causation_id: 'cause-no-title',
      }),
    ).rejects.toBeInstanceOf(TransitionDeniedError);
    expect(await countEvents(ctx.pool)).toBe(before);
  });

  it('appendStateTransition 缺 fact → 错误消息带可照抄的 fact 提示（F-a 接线）', async () => {
    await seedTaskAt('awaiting_acceptance');
    const before = await countEvents(ctx.pool);

    await expect(
      transition({
        from: 'awaiting_acceptance',
        to: 'accepted',
        causation_id: 'cause-missing-verdict',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TransitionDeniedError);
      const denied = error as TransitionDeniedError;
      expect(denied.result.missing_facts).toEqual([{
        requirement: 'acceptanceAccepted',
        fact: 'acceptanceVerdict',
        expected: "acceptanceVerdict='accepted'",
      }]);
      expect(denied.message).toContain("acceptanceVerdict='accepted'");
      return true;
    });

    expect(await countEvents(ctx.pool)).toBe(before);
  });

  it('appendStateTransition 合法迁移 → 行数 +1，payload.from/to 正确，返回 INV-11 收尾动作', async () => {
    await seedTaskAt('awaiting_acceptance');
    const before = await countEvents(ctx.pool);

    const { event, guard } = await transition({
      from: 'awaiting_acceptance',
      to: 'accepted',
      payload: { from: 'awaiting_acceptance', to: 'accepted' },
      facts: { acceptanceVerdict: 'accepted' },
      causation_id: 'cause-legal',
    });

    expect(await countEvents(ctx.pool)).toBe(before + 1);
    expect(event.type).toBe('TaskLifecycleChanged');
    expect((event.payload as { from: string }).from).toBe('awaiting_acceptance');
    expect((event.payload as { to: string }).to).toBe('accepted');
    expect(guard.allowed).toBe(true);
    expect(guard.required_effects).toEqual([
      'cancel_active_wait_conditions',
      'reset_wait_state_none',
    ]);
  });

  it('appendStateTransition 的 payload 缺 from/to → 以顶层补齐落库，replay 可重演（B1-①）', async () => {
    await seedTaskAt('awaiting_acceptance');
    const { event } = await transition({
      from: 'awaiting_acceptance',
      to: 'accepted',
      facts: { acceptanceVerdict: 'accepted' },
      causation_id: 'cause-b1',
    });

    // 落库事件必须满足 spec §4：payload 自带 from/to/trigger_event_id，且与 guard 判定一致
    expect(event.payload).toEqual({
      task_id: TASK_ID,
      from: 'awaiting_acceptance',
      to: 'accepted',
      trigger_event_id: 'cause-b1',
    });

    // C5 最小重演：仅凭 payload 就能还原这次迁移，且链仍完整
    const replayed = (await store.replay(0)).find((e) => e.id === event.id);
    expect(replayed).toBeDefined();
    expect((replayed?.payload as { from: string; to: string }).from).toBe('awaiting_acceptance');
    expect((replayed?.payload as { from: string; to: string }).to).toBe('accepted');
    expect(await store.verifyChain(STREAM)).toMatchObject({
      ok: true,
      length: await countEvents(ctx.pool),
    });
  });

  it('payload 与顶层 from/to 矛盾 → TransitionPayloadMismatchError，零落库（B1-②）', async () => {
    await expect(
      store.appendStateTransition({
        ...input({
          type: 'TaskLifecycleChanged',
          payload: { task_id: TASK_ID, from: 'awaiting_acceptance', to: 'accepted' },
        }),
        from: 'ready',
        to: 'active',
      }),
    ).rejects.toBeInstanceOf(TransitionPayloadMismatchError);

    expect(await countEvents(ctx.pool)).toBe(0);
  });

  it('entity 与事件类型家族错配 → EventEntityMismatchError，零落库（B1-③）', async () => {
    await expect(
      store.appendStateTransition({
        ...input({ type: 'RunStarted', payload: { run_id: RUN_ID } }),
        entity: 'task',
        from: 'ready',
        to: 'active',
      }),
    ).rejects.toBeInstanceOf(EventEntityMismatchError);

    await expect(
      store.appendStateTransition({
        ...input({ type: 'TaskLifecycleChanged', payload: { task_id: TASK_ID } }),
        entity: 'run',
        from: 'queued',
        to: 'leased',
      }),
    ).rejects.toBeInstanceOf(EventEntityMismatchError);

    expect(await countEvents(ctx.pool)).toBe(0);
  });

  it('payload 非对象（null/Date/Map）→ TransitionPayloadError，零落库', async () => {
    for (const payload of [null, new Date(FIXED_NOW), new Map([['a', 1]])]) {
      await expect(
        store.appendStateTransition({
          ...input({ type: 'TaskLifecycleChanged', payload }),
          from: 'ready',
          to: 'active',
        }),
      ).rejects.toBeInstanceOf(TransitionPayloadError);
    }

    expect(await countEvents(ctx.pool)).toBe(0);
  });

  it('append 对 TaskLifecycleChanged 做格合法性纵深防御 + R1 流状态对账（绕过 appendStateTransition 也拦）', async () => {
    // R1：生命周期迁移必须有事件流事实（TaskCaptured 先行），否则就是凭空建状态。
    await store.append(input());
    const before = await countEvents(ctx.pool);

    await expect(
      store.append(input({
        type: 'TaskLifecycleChanged',
        payload: {
          task_id: TASK_ID,
          from: 'accepted',
          to: 'canceled',
          trigger_event_id: 'trigger-illegal',
        },
      })),
    ).rejects.toBeInstanceOf(TransitionDeniedError);
    expect(await countEvents(ctx.pool)).toBe(before);

    // R1：格合法但 from 与流派生状态不符 → 同样拒绝（否则可写出互斥分支）。
    await expect(
      store.append(input({
        type: 'TaskLifecycleChanged',
        payload: {
          task_id: TASK_ID,
          from: 'ready',
          to: 'active',
          trigger_event_id: 'trigger-stale-from',
        },
      })),
    ).rejects.toBeInstanceOf(TransitionStateError);
    expect(await countEvents(ctx.pool)).toBe(before);

    const ok = await store.append(input({
      type: 'TaskLifecycleChanged',
      payload: {
        task_id: TASK_ID,
        from: 'captured',
        to: 'defined',
        trigger_event_id: 'trigger-ok',
      },
    }));
    expect(ok.seq).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// F11：canonicalJson 边界显式拒绝（稀疏数组 / 循环引用 / symbol / 不可枚举）
// ---------------------------------------------------------------------------
describe('F11：canonicalJson 边界显式拒绝', () => {
  it.each([
    ['稀疏数组 hole', () => [1, , 3] as unknown[], /hole/i],
    ['数组非索引自有属性', () => {
      const arr = [1] as unknown[] & Record<string, unknown>;
      arr.extra = 2;
      return arr;
    }, /非索引/],
    ['对象 symbol key', () => ({ [Symbol('s')]: 1 }), /symbol/i],
    ['数组 symbol 属性', () => {
      const arr = [1] as unknown[] & Record<symbol, unknown>;
      arr[Symbol('s')] = 2;
      return arr;
    }, /symbol/i],
    ['对象不可枚举自有属性', () => {
      const obj: Record<string, unknown> = {};
      Object.defineProperty(obj, 'hidden', { value: 1, enumerable: false });
      return obj;
    }, /不可枚举/],
    ['嵌套稀疏数组', () => ({ a: [{ b: 1 }, , 3] }), /hole/i],
  ])('%s → CanonicalizationError（不静默丢弃）', (_label, make, pattern) => {
    expect(() => canonicalJson(make())).toThrow(CanonicalizationError);
    expect(() => canonicalJson(make())).toThrow(pattern);
  });

  it('循环引用（对象 / 数组）→ CanonicalizationError', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => canonicalJson(obj)).toThrow(/循环引用/);

    const arr: unknown[] = [1];
    arr.push(arr);
    expect(() => canonicalJson(arr)).toThrow(/循环引用/);
  });

  it('共享引用但不是环（DAG）→ 允许，同一子对象序列化两次', () => {
    const shared = { a: 1 };
    expect(canonicalJson({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}');
  });

  it('边界错误在写入前抛出：稀疏数组 payload 零落库', async () => {
    await expect(store.append(input({ payload: { holes: [1, , 3] } })))
      .rejects.toBeInstanceOf(CanonicalizationError);
    expect(await countEvents(ctx.pool)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F12：TaskWaitStateChanged 接入写路径校验（形状 + from 对账 + guardWaitStateChange）
// ---------------------------------------------------------------------------
describe('F12：TaskWaitStateChanged 写路径校验', () => {
  function waitInput(payload: Record<string, unknown>, key: string | null = null) {
    return input({
      type: 'TaskWaitStateChanged',
      idempotency_key: key,
      payload: {
        task_id: TASK_ID,
        actor_id: 'actor-human-1',
        actor_kind: 'human',
        ...payload,
      },
    });
  }

  it.each([
    ['缺 from', { to: 'waiting_on_person', reason: 'r' }],
    ['缺 to', { from: 'none', reason: 'r' }],
    ['缺 reason', { from: 'none', to: 'waiting_on_person' }],
    ['reason 为空串', { from: 'none', to: 'waiting_on_person', reason: '' }],
    ['from 非字符串', { from: 1, to: 'waiting_on_person', reason: 'r' }],
  ])('%s → TransitionPayloadError，零落库', async (_label, payload) => {
    await seedTaskAt('active');
    const before = await countEvents(ctx.pool);
    await expect(store.append(waitInput(payload))).rejects.toBeInstanceOf(TransitionPayloadError);
    expect(await countEvents(ctx.pool)).toBe(before);
  });

  it('缺 payload actor → TransitionPayloadError（spec §4 要求记录置位 actor）', async () => {
    await seedTaskAt('active');
    await expect(store.append(input({
      type: 'TaskWaitStateChanged',
      payload: { task_id: TASK_ID, from: 'none', to: 'waiting_on_person', reason: 'r' },
    }))).rejects.toBeInstanceOf(TransitionPayloadError);
  });

  it('payload actor 与信封不一致 → TransitionPayloadError', async () => {
    await seedTaskAt('active');
    await expect(store.append(waitInput({
      from: 'none', to: 'waiting_on_person', reason: 'r', actor_id: 'actor-other',
    }))).rejects.toBeInstanceOf(TransitionPayloadError);
  });

  it('from 与流派生 wait_state 不一致 → TransitionStateError(from_mismatch)', async () => {
    await seedTaskAt('active');
    await expect(store.append(waitInput({
      from: 'waiting_on_person', to: 'none', reason: 'r',
    }))).rejects.toMatchObject({ name: 'TransitionStateError', reason: 'from_mismatch' });
  });

  it('自环（from=to）→ TransitionDeniedError(not_a_transition)', async () => {
    await seedTaskAt('active');
    await expect(store.append(waitInput({
      from: 'none', to: 'none', reason: 'r',
    }))).rejects.toMatchObject({ name: 'TransitionDeniedError', result: { reason: 'not_a_transition' } });
  });

  it('终态 lifecycle 上变更 wait_state → TransitionDeniedError(terminal_state)', async () => {
    await seedTaskAt('awaiting_acceptance');
    await transition({
      from: 'awaiting_acceptance', to: 'accepted',
      facts: { acceptanceVerdict: 'accepted' },
      causation_id: 'cause-accept-f12',
    });

    await expect(store.append(waitInput({
      from: 'none', to: 'blocked', reason: '人工置位',
    }))).rejects.toMatchObject({ name: 'TransitionDeniedError', result: { reason: 'terminal_state' } });
  });

  it('合法迁移可写入；同 key 重放返回首次事件（不因当前态已变而误伤）', async () => {
    await seedTaskAt('active');
    const first = await store.append(waitInput({
      from: 'none', to: 'waiting_on_person', reason: '等待回复',
    }, 'ws-key-1'));

    const replay = await store.append(waitInput({
      from: 'none', to: 'waiting_on_person', reason: '等待回复',
    }, 'ws-key-1'));

    expect(replay.id).toBe(first.id);
    const changes = (await store.readStream(STREAM))
      .filter((event) => event.type === 'TaskWaitStateChanged');
    expect(changes).toHaveLength(1);
    expect(changes[0].payload).toMatchObject({
      from: 'none', to: 'waiting_on_person', reason: '等待回复',
      actor_id: 'actor-human-1', actor_kind: 'human',
    });
    expect((await store.verifyChain(STREAM)).ok).toBe(true);
  });

  it('未知 task（流内无 TaskCaptured）→ TransitionStateError(subject_not_found)', async () => {
    await store.append(input({ payload: { task_id: 'other-task', title: 'x' } }));
    await expect(store.append(waitInput({
      from: 'none', to: 'blocked', reason: 'r',
    }))).rejects.toMatchObject({ name: 'TransitionStateError', reason: 'subject_not_found' });
  });
});

// ---------------------------------------------------------------------------
// F13：§4 / INV-12 —— stream_id 必须是 project_id
// ---------------------------------------------------------------------------
describe('F13：stream_id 必须是 project_id（§4 / INV-12）', () => {
  it('把 task_id 当 stream_id → ProjectStreamRequiredError，零落库', async () => {
    await expect(store.append(input({
      stream_id: asProjectId(TASK_ID),
      payload: { task_id: TASK_ID, title: 'x' },
    }))).rejects.toBeInstanceOf(ProjectStreamRequiredError);
    expect(await countEvents(ctx.pool)).toBe(0);
  });

  it('把 run_id 当 stream_id → ProjectStreamRequiredError', async () => {
    await expect(store.append(input({
      stream_id: asProjectId(RUN_ID),
      type: 'RunCreated',
      payload: { run_id: RUN_ID, task_id: TASK_ID },
    }))).rejects.toBeInstanceOf(ProjectStreamRequiredError);
  });

  it('appendStateTransition 用 task_id 作 stream → ProjectStreamRequiredError（先于流读取）', async () => {
    await expect(store.appendStateTransition({
      ...transitionBase({ from: 'captured', to: 'defined' }),
      stream_id: asProjectId(TASK_ID),
    })).rejects.toBeInstanceOf(ProjectStreamRequiredError);
  });

  it('requestTaskCancellation 用 task_id 作 stream → ProjectStreamRequiredError', async () => {
    await expect(store.requestTaskCancellation({
      stream_id: asProjectId(TASK_ID),
      task_id: TASK_ID,
      actor_id: 'actor-human-1',
      actor_kind: 'human',
      causation_id: null,
      correlation_id: 'corr-1',
      idempotency_key: null,
    })).rejects.toBeInstanceOf(ProjectStreamRequiredError);
  });

  it('payload.project_id 与 stream_id 不一致 → ProjectStreamRequiredError', async () => {
    await expect(store.append(input({
      payload: { task_id: TASK_ID, project_id: 'project-other' },
    }))).rejects.toBeInstanceOf(ProjectStreamRequiredError);
  });

  it('payload.project_id 与 stream_id 一致 → 正常写入', async () => {
    const event = await store.append(input({
      payload: { task_id: TASK_ID, project_id: STREAM, title: 'x' },
    }));
    expect(event.stream_id).toBe(STREAM);
  });

  it('asProjectId 拒绝空串 / 纯空白', () => {
    expect(() => asProjectId('')).toThrow(TypeError);
    expect(() => asProjectId('   ')).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// F14：verifyChain 的 payload_canonical 必须逐字节等于重新规范化结果
// ---------------------------------------------------------------------------
describe('F14：verifyChain 重新规范化 payload_canonical', () => {
  async function tamperPayloadCanonical(text: string): Promise<void> {
    await ctx.pool.query('ALTER TABLE events DISABLE TRIGGER events_no_mutation');
    try {
      await ctx.pool.query(
        'UPDATE events SET payload_canonical = $1 WHERE stream_id = $2 AND seq = 1',
        [text, STREAM],
      );
    } finally {
      await ctx.pool.query('ALTER TABLE events ENABLE TRIGGER events_no_mutation');
    }
  }

  it('规范化文本（正常写入）→ ok:true', async () => {
    await store.append(input());
    expect((await store.verifyChain(STREAM)).ok).toBe(true);
  });

  it('JSON 等价但非规范排序/含空白的 payload_canonical → 链校验报红（F14 先于 hash）', async () => {
    await store.append(input());
    // 语义相同，但不是 canonicalJson 的逐字节输出（键序 + 空白均不同）
    await tamperPayloadCanonical('{ "title": "联系张三确认方案", "task_id": "task-1" }');

    const result = await store.verifyChain(STREAM);
    expect(result.ok).toBe(false);
    expect(result.broken_at_seq).toBe(1);
    expect(result.reason).toContain('F14');
    expect(result.reason).toContain('非规范形式');
  });

  it('payload_canonical 不是合法 JSON → 明确报「无法重新规范化」', async () => {
    await store.append(input());
    await tamperPayloadCanonical('not-json-at-all');

    const result = await store.verifyChain(STREAM);
    expect(result.ok).toBe(false);
    expect(result.broken_at_seq).toBe(1);
    expect(result.reason).toContain('无法重新规范化');
  });
});

// ---------------------------------------------------------------------------
// F15：幂等「同内容」= type + payload + actor + correlation + causation
// ---------------------------------------------------------------------------
describe('F15：幂等冲突比较覆盖信封字段', () => {
  it('同 key 同 payload，但 actor_id 不同 → IdempotencyKeyConflictError', async () => {
    const key = 'f15-actor-id';
    await store.append(input({ idempotency_key: key }));
    await expect(store.append(input({ idempotency_key: key, actor_id: 'actor-human-2' })))
      .rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    expect(await countEvents(ctx.pool)).toBe(1);
  });

  it('actor_kind 不同 → 冲突', async () => {
    const key = 'f15-actor-kind';
    await store.append(input({ idempotency_key: key }));
    await expect(store.append(input({ idempotency_key: key, actor_kind: 'system' })))
      .rejects.toBeInstanceOf(IdempotencyKeyConflictError);
  });

  it('correlation_id 不同 → 冲突', async () => {
    const key = 'f15-correlation';
    await store.append(input({ idempotency_key: key }));
    await expect(store.append(input({ idempotency_key: key, correlation_id: 'corr-2' })))
      .rejects.toBeInstanceOf(IdempotencyKeyConflictError);
  });

  it('causation_id 不同 → 冲突', async () => {
    const key = 'f15-causation';
    await store.append(input({ idempotency_key: key }));
    await expect(store.append(input({ idempotency_key: key, causation_id: 'cause-2' })))
      .rejects.toBeInstanceOf(IdempotencyKeyConflictError);
  });

  it('全部字段相同 → 正常重放首次事件', async () => {
    const key = 'f15-same';
    const first = await store.append(input({ idempotency_key: key }));
    const again = await store.append(input({ idempotency_key: key }));
    expect(again.id).toBe(first.id);
    expect(await countEvents(ctx.pool)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// F16：append-only 覆盖 TRUNCATE（语句级触发器）
// ---------------------------------------------------------------------------
describe('F16：TRUNCATE 也被 append-only 封堵', () => {
  it('TRUNCATE events → 触发器拒绝', async () => {
    await store.append(input());
    await expect(ctx.pool.query('TRUNCATE events')).rejects.toThrow(/append-only/i);
    expect(await countEvents(ctx.pool)).toBe(1);
  });

  it('TRUNCATE events, event_streams（测试旧清理路径）→ 拒绝', async () => {
    await store.append(input());
    await expect(
      ctx.pool.query('TRUNCATE events, event_streams RESTART IDENTITY'),
    ).rejects.toThrow(/append-only/i);
    expect(await countEvents(ctx.pool)).toBe(1);
  });

  it('测试清理走 DROP + migrate 后触发器仍在（不弱化线上语义）', async () => {
    await store.append(input());
    await resetEventTables(ctx.pool);
    expect(await countEvents(ctx.pool)).toBe(0);

    // 重建后仍有事件行，才能触发 row-level DELETE 触发器
    await store.append(input());
    await expect(ctx.pool.query('TRUNCATE events')).rejects.toThrow(/append-only/i);
    await expect(ctx.pool.query('DELETE FROM events')).rejects.toThrow(/append-only/i);
    expect(await countEvents(ctx.pool)).toBe(1);
  });
});
