import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { EventEnvelope, EventType } from '../src/kernel/events.js';
import type { EventStore } from '../src/kernel/event-store.js';
import {
  CanonicalizationError,
  EventEntityMismatchError,
  GENESIS_HASH,
  IdempotencyKeyConflictError,
  TransitionDeniedError,
  TransitionPayloadError,
  TransitionPayloadMismatchError,
  UnknownEventTypeError,
  canonicalJson,
  computeEventHash,
  createPgEventStore,
  migrate,
  type PgEventStore,
} from '../src/kernel/event-store-pg.js';
import { createTestPg, assertPostgres16, resetEventTables, type TestPg } from './support/pg.js';

// ============================================================================
// PG Event Store 集成测试（真 PostgreSQL 16，plan §6）
// 覆盖：C2（INV-13）、INV-12 哈希链、并发 append、append-only 触发器、
//       EventStore 接口一致性、非法迁移不产生事件、payload 规范化。
// ============================================================================

const FIXED_NOW = new Date('2026-10-21T00:00:00.000Z');

function input(overrides: Partial<Parameters<EventStore['append']>[0]> = {}) {
  const base: Parameters<EventStore['append']>[0] = {
    stream_id: 'project-1',
    type: 'TaskCaptured',
    actor_id: 'actor-human-1',
    actor_kind: 'human',
    causation_id: null,
    correlation_id: 'corr-1',
    idempotency_key: null,
    payload: { task_id: 'task-1', title: '联系张三确认方案' },
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

let ctx: TestPg;
let store: PgEventStore;

beforeAll(async () => {
  ctx = await createTestPg();
  await migrate(ctx.pool);
  store = createPgEventStore(ctx.pool, { clock: () => FIXED_NOW });
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
    expect(await lastSeq(ctx.pool, 'project-1')).toBe(1);

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
    const a = await store.append(input({ stream_id: 'project-A', idempotency_key: key }));
    const b = await store.append(input({ stream_id: 'project-B', idempotency_key: key }));

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

    const events = await store.readStream('project-1');
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

    const verification = await store.verifyChain('project-1');
    expect(verification).toEqual({
      ok: true,
      stream_id: 'project-1',
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
    const [event] = await store.readStream('project-1');
    // jsonb 会把 1.0 存成 1；读回的 payload 以 payload_canonical 为准，哈希不受影响
    expect(event.payload).toEqual({ amount: 1, exp: 100, deep: { x: [1, 200] }, text: 'µ/ü/张三' });
    expect((await store.verifyChain('project-1')).ok).toBe(true);
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
        '01J0000000000000000000TAMPER', 'project-1', 3, 'TaskDefined',
        'actor-human-1', 'human', 'corr-1', JSON.stringify({ step: 3 }), canonicalJson({ step: 3 }),
        GENESIS_HASH, 'f'.repeat(64), FIXED_NOW.toISOString(),
      ],
    );

    const verification = await store.verifyChain('project-1');
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

  it.each([
    ['undefined（顶层）', undefined],
    ['undefined（嵌套值）', { a: undefined }],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['bigint', 10n],
    ['function', () => 1],
    ['symbol', Symbol('x')],
  ])('拒绝不可规范化的值：%s → CanonicalizationError，且不落库', async (_name, bad) => {
    expect(() => canonicalJson(bad)).toThrow(CanonicalizationError);
    await expect(store.append(input({ payload: bad }))).rejects.toBeInstanceOf(CanonicalizationError);
    expect(await countEvents(ctx.pool)).toBe(0);
  });

  it('未知事件类型 → UnknownEventTypeError，且不落库（不静默丢弃）', async () => {
    await expect(
      store.append(input({ type: 'NotAnEventType' as EventType })),
    ).rejects.toBeInstanceOf(UnknownEventTypeError);
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
    expect(await lastSeq(ctx.pool, 'project-1')).toBe(20);

    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(results.map((r) => r.global_seq)).size).toBe(20);
    expect((await store.verifyChain('project-1')).ok).toBe(true);
  });

  it('跨 stream 并发互不阻塞，global_seq 全库唯一', async () => {
    const results = await Promise.all([
      ...Array.from({ length: 5 }, (_, i) =>
        store.append(input({ stream_id: 'project-X', payload: { i } }))),
      ...Array.from({ length: 5 }, (_, i) =>
        store.append(input({ stream_id: 'project-Y', payload: { i } }))),
    ]);

    expect(new Set(results.map((r) => r.global_seq)).size).toBe(10);
    expect(await lastSeq(ctx.pool, 'project-X')).toBe(5);
    expect(await lastSeq(ctx.pool, 'project-Y')).toBe(5);
  });
});

describe('读路径：含起点语义（A5）', () => {
  it('readStream(from_seq) 含起点；replay(from_global_seq) 含起点且按 global_seq 升序', async () => {
    for (let i = 1; i <= 3; i++) await store.append(input({ payload: { i } }));

    expect((await store.readStream('project-1', 2)).map((e) => e.seq)).toEqual([2, 3]);
    expect((await store.readStream('project-1')).map((e) => e.seq)).toEqual([1, 2, 3]);

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
    const asInterface: EventStore = createPgEventStore(ctx.pool, { clock: () => FIXED_NOW });
    const envelope = await asInterface.append(input());
    expect(envelope.seq).toBe(1);
    expect(await asInterface.readStream('project-1')).toHaveLength(1);
    expect(await asInterface.replay(0)).toHaveLength(1);
  });

  it('index.ts 导出 store 工厂与校验器（接线审计可 grep）', async () => {
    const kernel = await import('../src/kernel/index.js');
    expect(kernel.createPgEventStore).toBeTypeOf('function');
    expect(kernel.migrate).toBeTypeOf('function');
    expect(kernel.guardTransition).toBeTypeOf('function');
  });
});

describe('INV-11：withTransaction 同事务收尾（B2）', () => {
  it('一个事务内提交 WaitConditionCanceled + wait_state 变更 + lifecycle 迁移 → 链连续、verifyChain 通过', async () => {
    const result = await store.withTransaction(async (tx) => {
      const waitCanceled = await tx.append(input({
        type: 'WaitConditionCanceled',
        payload: { wait_condition_id: 'wc-1' },
      }));
      const waitState = await tx.append(input({
        type: 'TaskWaitStateChanged',
        payload: { task_id: 'task-1', from: 'waiting_on_person', to: 'none' },
      }));
      const transition = await tx.appendStateTransition({
        ...input({ type: 'TaskLifecycleChanged', payload: { task_id: 'task-1' } }),
        from: 'awaiting_acceptance',
        to: 'accepted',
        facts: { acceptanceVerdict: 'accepted' },
      });
      // 事务内读取自己的未提交写入：链头与 events 一致
      const inTxVerification = await tx.verifyChain('project-1');
      return { waitCanceled, waitState, transition, inTxVerification };
    });

    expect(result.inTxVerification).toMatchObject({ ok: true, length: 3, stream_exists: true });
    expect(result.transition.guard.required_effects).toEqual([
      'cancel_active_wait_conditions',
      'reset_wait_state_none',
    ]);

    const events = await store.readStream('project-1');
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.type)).toEqual([
      'WaitConditionCanceled',
      'TaskWaitStateChanged',
      'TaskLifecycleChanged',
    ]);
    expect(events[2].payload).toMatchObject({
      task_id: 'task-1',
      from: 'awaiting_acceptance',
      to: 'accepted',
    });
    expect(await store.verifyChain('project-1')).toMatchObject({
      ok: true,
      length: 3,
      stream_exists: true,
      broken_at_seq: null,
    });
  });

  it('事务中途抛错 → 整体回滚：零事件、无链头行（不留半提交）', async () => {
    await expect(
      store.withTransaction(async (tx) => {
        await tx.append(input({ payload: { task_id: 'task-1' } }));
        await tx.appendStateTransition({
          ...input({ type: 'TaskLifecycleChanged', payload: { task_id: 'task-1' } }),
          from: 'ready',
          to: 'active',
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await countEvents(ctx.pool)).toBe(0);
    const heads = await ctx.pool.query<{ n: number }>(
      'select count(*)::int as n from event_streams',
    );
    expect(heads.rows[0].n).toBe(0);
  });

  it('事务内 guard 拒绝 → 该事件不写，且事务可继续提交（拒绝发生在 SQL 之前）', async () => {
    await expect(
      store.withTransaction(async (tx) => {
        await tx.append(input({ payload: { task_id: 'task-1' } }));
        await expect(
          tx.appendStateTransition({
            ...input({ type: 'TaskLifecycleChanged', payload: { task_id: 'task-1' } }),
            from: 'accepted',
            to: 'canceled',
          }),
        ).rejects.toBeInstanceOf(TransitionDeniedError);
      }),
    ).resolves.toBeUndefined();

    expect(await countEvents(ctx.pool)).toBe(1);
  });
});

describe('verifyChain 运维真实性（F-b）', () => {
  it('不存在的 stream → ok:false / stream_not_found（不冒充健康空流）', async () => {
    expect(await store.verifyChain('proj-TYPO')).toEqual({
      ok: false,
      stream_id: 'proj-TYPO',
      length: 0,
      broken_at_seq: null,
      reason: 'stream_not_found',
      stream_exists: false,
    });
    expect(await store.verifyChain('')).toMatchObject({
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
      ['a'.repeat(64), 'project-1'],
    );

    const verification = await store.verifyChain('project-1');
    expect(verification.ok).toBe(false);
    expect(verification.stream_exists).toBe(true);
    expect(verification.broken_at_seq).toBe(2);
    expect(verification.reason).toContain('链头 last_hash');
  });

  it('链头 last_seq 与 events 行数不一致 → ok:false', async () => {
    await store.append(input({ payload: { step: 1 } }));

    await ctx.pool.query(
      `UPDATE event_streams SET last_seq = 9 WHERE stream_id = $1`,
      ['project-1'],
    );

    const verification = await store.verifyChain('project-1');
    expect(verification.ok).toBe(false);
    expect(verification.broken_at_seq).toBe(9);
    expect(verification.reason).toContain('链头 last_seq');
  });
});

describe('校验器嵌在写路径：非法迁移不产生事件（接线审计）', () => {
  it('appendStateTransition 非法迁移（accepted→canceled）→ TransitionDeniedError，行数不变', async () => {
    await store.append(input({ payload: { task_id: 'task-1' } }));
    const before = await countEvents(ctx.pool);

    await expect(
      store.appendStateTransition({
        ...input({ type: 'TaskLifecycleChanged', payload: { task_id: 'task-1', from: 'accepted', to: 'canceled' } }),
        from: 'accepted',
        to: 'canceled',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TransitionDeniedError);
      expect((error as TransitionDeniedError).result.reason).toBe('illegal_transition');
      return true;
    });

    expect(await countEvents(ctx.pool)).toBe(before);
  });

  it('appendStateTransition 前置条件不满足 → 拒绝且不落库', async () => {
    const before = await countEvents(ctx.pool);
    await expect(
      store.appendStateTransition({
        ...input({ type: 'TaskLifecycleChanged', payload: { task_id: 'task-1', from: 'captured', to: 'defined' } }),
        from: 'captured',
        to: 'defined',
        facts: { hasTitle: false, assigneeKind: 'human' },
      }),
    ).rejects.toBeInstanceOf(TransitionDeniedError);
    expect(await countEvents(ctx.pool)).toBe(before);
  });

  it('appendStateTransition 缺 fact → 错误消息带可照抄的 fact 提示（F-a 接线）', async () => {
    await expect(
      store.appendStateTransition({
        ...input({ type: 'TaskLifecycleChanged', payload: { task_id: 'task-1' } }),
        from: 'awaiting_acceptance',
        to: 'accepted',
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

    expect(await countEvents(ctx.pool)).toBe(0);
  });

  it('appendStateTransition 合法迁移 → 行数 +1，payload.from/to 正确，返回 INV-11 收尾动作', async () => {
    await store.append(input({ payload: { task_id: 'task-1' } }));
    const before = await countEvents(ctx.pool);

    const { event, guard } = await store.appendStateTransition({
      ...input({
        type: 'TaskLifecycleChanged',
        payload: { task_id: 'task-1', from: 'awaiting_acceptance', to: 'accepted' },
      }),
      from: 'awaiting_acceptance',
      to: 'accepted',
      facts: { acceptanceVerdict: 'accepted' },
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
    const { event } = await store.appendStateTransition({
      ...input({ type: 'TaskLifecycleChanged', payload: { task_id: 'task-1' } }),
      from: 'awaiting_acceptance',
      to: 'accepted',
      facts: { acceptanceVerdict: 'accepted' },
    });

    // 落库事件必须满足 spec §4：payload 自带 from/to，且与 guard 判定一致
    expect(event.payload).toEqual({
      task_id: 'task-1',
      from: 'awaiting_acceptance',
      to: 'accepted',
    });

    // C5 最小重演：仅凭 payload 就能还原这次迁移，且链仍完整
    const replayed = (await store.replay(0)).find((e) => e.id === event.id);
    expect(replayed).toBeDefined();
    expect((replayed?.payload as { from: string; to: string }).from).toBe('awaiting_acceptance');
    expect((replayed?.payload as { from: string; to: string }).to).toBe('accepted');
    expect(await store.verifyChain('project-1')).toMatchObject({ ok: true, length: 1 });
  });

  it('payload 与顶层 from/to 矛盾 → TransitionPayloadMismatchError，零落库（B1-②）', async () => {
    await expect(
      store.appendStateTransition({
        ...input({
          type: 'TaskLifecycleChanged',
          payload: { task_id: 'task-1', from: 'awaiting_acceptance', to: 'accepted' },
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
        ...input({ type: 'RunStarted', payload: { run_id: 'run-1' } }),
        entity: 'task',
        from: 'ready',
        to: 'active',
      }),
    ).rejects.toBeInstanceOf(EventEntityMismatchError);

    await expect(
      store.appendStateTransition({
        ...input({ type: 'TaskLifecycleChanged', payload: { task_id: 'task-1' } }),
        entity: 'run',
        from: 'queued',
        to: 'leased',
      }),
    ).rejects.toBeInstanceOf(EventEntityMismatchError);

    expect(await countEvents(ctx.pool)).toBe(0);
  });

  it('payload 非对象（无法承载 from/to）→ TransitionPayloadError，零落库', async () => {
    await expect(
      store.appendStateTransition({
        ...input({ type: 'TaskLifecycleChanged', payload: null }),
        from: 'ready',
        to: 'active',
      }),
    ).rejects.toBeInstanceOf(TransitionPayloadError);

    expect(await countEvents(ctx.pool)).toBe(0);
  });

  it('payload 非 plain object（Date/Map）→ TransitionPayloadError，不静默丢 payload', async () => {
    for (const payload of [new Date(FIXED_NOW), new Map([['a', 1]])]) {
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

  it('append 对 TaskLifecycleChanged 做格合法性纵深防御（绕过 appendStateTransition 也拦）', async () => {
    const before = await countEvents(ctx.pool);

    await expect(
      store.append(input({
        type: 'TaskLifecycleChanged',
        payload: { task_id: 'task-1', from: 'accepted', to: 'canceled' },
      })),
    ).rejects.toBeInstanceOf(TransitionDeniedError);
    expect(await countEvents(ctx.pool)).toBe(before);

    const ok = await store.append(input({
      type: 'TaskLifecycleChanged',
      payload: { task_id: 'task-1', from: 'captured', to: 'defined' },
    }));
    expect(ok.seq).toBe(1);
  });

});
