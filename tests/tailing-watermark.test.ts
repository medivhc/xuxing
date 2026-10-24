import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asProjectId, type ProjectId } from '../src/kernel/events.js';
import {
  StoreInvariantError,
  createPgEventStore,
  migrate,
  type AppendBatchEntryInput,
  type PgEventStore,
} from '../src/kernel/event-store-pg.js';
import { createTestPg, resetEventTables, type TestPg } from './support/pg.js';

// ============================================================================
// S5-①：增量消费水位保护（真 PostgreSQL 16）
// - 水位落库（consumer_watermarks），进程重启后恢复
// - 投递幂等键（consumer_deliveries），重复投递不重复入账
// - 混沌：并发写入 + 消费者 kill-restart，从水位续消费不丢不重
// 本文件只验证机制 + 测试消费夹具，不实现生产投影消费者（后续批次）。
// ============================================================================

const CONSUMER = 'test-consumer';
const STREAM = asProjectId('project-tailing');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let ctx: TestPg;
let store: PgEventStore;

function input(overrides: Partial<AppendBatchEntryInput> = {}): AppendBatchEntryInput {
  return {
    stream_id: STREAM,
    type: 'TaskCaptured',
    actor_id: 'actor-human-1',
    actor_kind: 'human',
    causation_id: null,
    correlation_id: 'corr-tailing',
    idempotency_key: null,
    payload: { task_id: `task-${Math.random()}`, title: 'tailing' },
    ...overrides,
  };
}

async function seedStream(count: number, tag = 'seed'): Promise<void> {
  await store.append(input({
    type: 'ProjectCreated',
    payload: { name: 'tailing 项目', created_by: 'actor-human-1' },
  }));
  for (let i = 0; i < count; i += 1) {
    await store.append(input({
      type: 'GoalCreated',
      payload: { goal_id: `goal-${tag}-${i}`, statement: `目标 ${i}` },
    }));
  }
}

async function countDeliveries(): Promise<number> {
  const { rows } = await ctx.pool.query<{ n: number }>(
    'select count(*)::int as n from consumer_deliveries where consumer_id = $1',
    [CONSUMER],
  );
  return rows[0].n;
}

async function maxGlobalSeq(): Promise<number> {
  const { rows } = await ctx.pool.query<{ n: string }>(
    'select coalesce(max(global_seq), 0)::text as n from events',
  );
  return Number(rows[0].n);
}

beforeAll(async () => {
  ctx = await createTestPg();
  await migrate(ctx.pool);
  store = createPgEventStore(ctx.pool, { clock: () => new Date() });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetEventTables(ctx.pool);
  // 事件表由 resetEventTables 重建；消费水位/投递记录也要隔离（否则跨用例串水位）。
  await ctx.pool.query('DELETE FROM consumer_deliveries');
  await ctx.pool.query('DELETE FROM consumer_watermarks');
});

describe('S5-① 水位与投递幂等的基本语义', () => {
  it('空流：水位 0、空批、has_more=false', async () => {
    expect(await store.readWatermark(CONSUMER)).toBe(0);
    const batch = await store.fetchAfterWatermark({ consumer_id: CONSUMER, limit: 5 });
    expect(batch).toEqual({ events: [], watermark: 0, has_more: false });
  });

  it('按 limit 分批：has_more 正确，水位单调推进且不越过已提交事件', async () => {
    await seedStream(7);

    const first = await store.fetchAfterWatermark({ consumer_id: CONSUMER, limit: 3 });
    expect(first.events).toHaveLength(3);
    expect(first.has_more).toBe(true);
    expect(first.watermark).toBe(first.events[2].global_seq);

    await store.commitDeliveries({
      consumer_id: CONSUMER,
      last_global_seq: first.watermark,
      event_ids: first.events.map((event) => event.id),
    });
    expect(await store.readWatermark(CONSUMER)).toBe(first.watermark);

    const second = await store.fetchAfterWatermark({ consumer_id: CONSUMER, limit: 100 });
    expect(second.events.every((event) => event.global_seq > first.watermark)).toBe(true);
    expect(second.has_more).toBe(false);
    const all = await store.replay(0);
    expect([...first.events, ...second.events].map((event) => event.global_seq)).toEqual(
      all.map((event) => event.global_seq),
    );
  });

  it('commitDeliveries 幂等：重复提交同一批 → new_deliveries=0；水位不回退', async () => {
    await seedStream(4);
    const batch = await store.fetchAfterWatermark({ consumer_id: CONSUMER, limit: 10 });
    const ids = batch.events.map((event) => event.id);

    const first = await store.commitDeliveries({
      consumer_id: CONSUMER,
      last_global_seq: batch.watermark,
      event_ids: ids,
    });
    expect(first.new_deliveries).toBe(5);
    expect(first.watermark).toBe(batch.watermark);

    const replay = await store.commitDeliveries({
      consumer_id: CONSUMER,
      last_global_seq: batch.watermark,
      event_ids: ids,
    });
    expect(replay.new_deliveries).toBe(0);

    const regressed = await store.commitDeliveries({
      consumer_id: CONSUMER,
      last_global_seq: 1,
      event_ids: [],
    });
    expect(regressed.watermark).toBe(batch.watermark);
    expect(await countDeliveries()).toBe(5);
  });

  it('非法 limit / 水位参数显式拒绝', async () => {
    await expect(
      store.fetchAfterWatermark({ consumer_id: CONSUMER, limit: 0 }),
    ).rejects.toBeInstanceOf(StoreInvariantError);
    await expect(
      store.commitDeliveries({ consumer_id: CONSUMER, last_global_seq: -1, event_ids: [] }),
    ).rejects.toBeInstanceOf(StoreInvariantError);
  });
});

describe('S5-① 混沌：并发写入 + 消费者 kill-restart（不丢不重）', () => {
  it('消费者在处理完一批、提交前崩溃 → 重启后从持久化水位续消费，效果恰好一次', async () => {
    await seedStream(11);
    const total = (await store.readStream(STREAM)).length;

    // 消费者把「外部效果」写在按 event_id 幂等的 sink 里（消费幂等键 = 事件 id）。
    // 崩溃前未提交的那一批会被重新投递，sink 用 event_id 去重，因此效果恰好一次。
    const effects = new Map<string, number>();
    let skipped_by_idempotency_key = 0;
    const applyBatch = (events: { id: string }[]): void => {
      for (const event of events) {
        if (effects.has(event.id)) {
          skipped_by_idempotency_key += 1;
          continue;
        }
        effects.set(event.id, 1);
      }
    };

    // 第一次运行：消费 2 批，第 3 批处理完但**不提交**就崩溃（模拟 kill -9）。
    let batches = 0;
    for (;;) {
      const batch = await store.fetchAfterWatermark({ consumer_id: CONSUMER, limit: 3 });
      if (batch.events.length === 0) break;
      applyBatch(batch.events);
      batches += 1;
      if (batches === 3) break; // 崩溃点：本批未 commitDeliveries
      await store.commitDeliveries({
        consumer_id: CONSUMER,
        last_global_seq: batch.watermark,
        event_ids: batch.events.map((event) => event.id),
      });
    }

    const committedBeforeCrash = await store.readWatermark(CONSUMER);
    expect(committedBeforeCrash).toBeGreaterThan(0);

    // 重启：新 store 实例（模拟新进程），水位从库里恢复
    const restarted = createPgEventStore(ctx.pool, { clock: () => new Date() });
    expect(await restarted.readWatermark(CONSUMER)).toBe(committedBeforeCrash);

    for (;;) {
      const batch = await restarted.fetchAfterWatermark({ consumer_id: CONSUMER, limit: 3 });
      if (batch.events.length === 0) break;
      applyBatch(batch.events);
      await restarted.commitDeliveries({
        consumer_id: CONSUMER,
        last_global_seq: batch.watermark,
        event_ids: batch.events.map((event) => event.id),
      });
    }

    // 不丢：事件流每一条都产生了效果；不重：重复投递被幂等键吃掉（效果各一次）
    expect(effects.size).toBe(total);
    expect([...effects.values()].every((count) => count === 1)).toBe(true);
    expect(skipped_by_idempotency_key).toBeGreaterThan(0); // 证明确实发生过崩溃后的重投
    expect(await countDeliveries()).toBe(total);
    expect(await restarted.readWatermark(CONSUMER)).toBe(await maxGlobalSeq());
  });

  it('并发写入期间消费者持续消费：最终全部投递、恰好一次、水位到达最大 global_seq', async () => {
    await seedStream(1);
    const writer = (async () => {
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          store.append(input({
            type: 'GoalCreated',
            payload: { goal_id: `goal-concurrent-${i}`, statement: `并发目标 ${i}` },
            idempotency_key: `concurrent-${i}`,
          }))),
      );
    })();

    const effects = new Map<string, number>();
    let writersDone = false;
    writer.finally(() => {
      writersDone = true;
    });

    // 消费者按小批次追平；写入未完成时空批要等下一轮（而不是提前判终）。
    for (let guard = 0; guard < 500; guard += 1) {
      const batch = await store.fetchAfterWatermark({ consumer_id: CONSUMER, limit: 3 });
      if (batch.events.length > 0) {
        for (const event of batch.events) {
          effects.set(event.id, (effects.get(event.id) ?? 0) + 1);
        }
        await store.commitDeliveries({
          consumer_id: CONSUMER,
          last_global_seq: batch.watermark,
          event_ids: batch.events.map((event) => event.id),
        });
        continue;
      }
      if (writersDone) break;
      await sleep(5);
    }
    await writer;

    const all = await store.replay(0);
    expect([...effects.keys()].sort()).toEqual(all.map((event) => event.id).sort());
    expect([...effects.values()].every((count) => count === 1)).toBe(true);
    expect(await store.readWatermark(CONSUMER)).toBe(await maxGlobalSeq());
  });

  it('未提交事件不会被水位越过：读快照只看到已提交前缀', async () => {
    await seedStream(2);
    const committed = await store.fetchAfterWatermark({ consumer_id: CONSUMER, limit: 100 });
    await store.commitDeliveries({
      consumer_id: CONSUMER,
      last_global_seq: committed.watermark,
      event_ids: committed.events.map((event) => event.id),
    });
    const watermarkBefore = await store.readWatermark(CONSUMER);

    // 打开一个事务写一条事件后挂住（未提交）——消费者此时读不到它，也不得越过它。
    let signalWritten!: () => void;
    const written = new Promise<void>((resolve) => {
      signalWritten = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const txPromise = store.withTransaction(async (tx) => {
      await tx.append(input({
        type: 'GoalCreated',
        payload: { goal_id: 'goal-uncommitted', statement: '未提交目标' },
      }));
      signalWritten();
      await gate;
    });

    await written;
    const during = await store.fetchAfterWatermark({ consumer_id: CONSUMER, limit: 100 });
    expect(during.events).toEqual([]);
    expect(during.watermark).toBe(watermarkBefore);

    release();
    await txPromise;

    const after = await store.fetchAfterWatermark({ consumer_id: CONSUMER, limit: 100 });
    expect(after.events).toHaveLength(1);
    expect(after.watermark).toBeGreaterThan(watermarkBefore);
  });

  it('水位在「进程重启」后恢复：新实例继续从同一条事件之后读', async () => {
    await seedStream(5);
    const batch = await store.fetchAfterWatermark({ consumer_id: CONSUMER, limit: 3 });
    await store.commitDeliveries({
      consumer_id: CONSUMER,
      last_global_seq: batch.watermark,
      event_ids: batch.events.map((event) => event.id),
    });

    const restarted = createPgEventStore(ctx.pool, { clock: () => new Date() });
    const resumed = await restarted.fetchAfterWatermark({ consumer_id: CONSUMER, limit: 3 });
    expect(resumed.events.every((event) => event.global_seq > batch.watermark)).toBe(true);
    expect(resumed.events).toHaveLength(3);
  });
});

describe('杂-2④ listStreams：全库流清单（链头 + 事件数）', () => {
  it('列出每个流的 last_seq / last_hash / event_count，与 verifyChain 一致', async () => {
    await seedStream(3);
    const other: ProjectId = asProjectId('project-other-tailing');
    await store.append(input({
      stream_id: other,
      type: 'ProjectCreated',
      payload: { name: '另一个项目', created_by: 'actor-human-1' },
    }));

    const streams = await store.listStreams();
    expect(streams.map((s) => s.stream_id)).toEqual([STREAM, other].sort());

    const mine = streams.find((s) => s.stream_id === STREAM)!;
    expect(mine.last_seq).toBe(4);
    expect(mine.event_count).toBe(4);
    const chain = await store.verifyChain(STREAM);
    expect(chain.ok).toBe(true);
    expect(mine.last_hash).toBe((await store.readStream(STREAM)).at(-1)!.hash);
  });
});
