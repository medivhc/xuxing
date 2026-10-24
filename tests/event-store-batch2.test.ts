import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { asProjectId, type EventEnvelope, type EventType, type ProjectId } from '../src/kernel/events.js';
import {
  AppendBatchError,
  EventEntityMismatchError,
  TerminalClosureRequiredError,
  TransitionDeniedError,
  TransitionStateError,
  createPgEventStore,
  migrate,
  type AppendBatchEntryInput,
  type PgEventStore,
} from '../src/kernel/event-store-pg.js';
import { createTestPg, assertPostgres16, resetEventTables, type TestPg } from './support/pg.js';

// ============================================================================
// Batch 2 · 原生断面测试（真 PostgreSQL 16）
//   S1-① appendBatch：同 stream、同事务、哈希链内连续、失败零落库
//   S1-② 原始 append 写迁移事件不得绕行流派生 from
//   S3-② 无 ProjectCreated 事实的流不得写入
//   S4-① 事务内误用外层 store 写同 stream：立即报错，不挂起
//   S4-② withTransaction 检查 COMMIT command tag
//   S4-确认 Q15 F2 收尾语义（引用既有用例，见 tests/event-store-pg.test.ts）
//   S3-确认乙 pF6 anyOf 短路文案与语义
//   杂-1 / 杂-2 文案与 API 硬化
// ============================================================================

const FIXED_NOW = new Date('2026-10-24T00:00:00.000Z');
const STREAM = asProjectId('project-b2');
const TASK_ID = 'task-b2';
const RUN_ID = 'run-b2';

function input(overrides: Partial<AppendBatchEntryInput> = {}): AppendBatchEntryInput {
  const base: AppendBatchEntryInput = {
    stream_id: STREAM,
    type: 'TaskCaptured',
    actor_id: 'actor-human-1',
    actor_kind: 'human',
    causation_id: null,
    correlation_id: 'corr-b2',
    idempotency_key: null,
    payload: { task_id: TASK_ID, title: 'Batch 2 任务' },
  };
  return { ...base, ...overrides };
}

function transitionEntry(overrides: Partial<AppendBatchEntryInput> = {}): AppendBatchEntryInput {
  return {
    ...input(),
    type: 'TaskLifecycleChanged',
    entity: 'task',
    from: 'captured',
    to: 'defined',
    payload: { task_id: TASK_ID, trigger_event_id: 'trigger-b2' },
    facts: { hasTitle: true, assigneeKind: 'human' },
    ...overrides,
  };
}

async function countEvents(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('select count(*)::int as n from events');
  return rows[0].n;
}

async function typesOf(store: PgEventStore, stream: ProjectId): Promise<string[]> {
  return (await store.readStream(stream)).map((event) => event.type);
}

/** 用普通 append 播种生命周期（B1 语义：generic append 只做矩阵格校验）。 */
async function seedTaskAt(target: 'captured' | 'defined' | 'ready' | 'active' | 'awaiting_acceptance'): Promise<void> {
  await store.append(input());
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
      payload: { task_id: TASK_ID, from, to, trigger_event_id: `seed-${to}` },
    }));
    current = to;
  }
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
  it('select version() 以 PostgreSQL 16 开头', async () => {
    await expect(assertPostgres16(ctx.pool)).resolves.toContain('PostgreSQL 16');
  });
});

// ---------------------------------------------------------------------------
// S1-① appendBatch
// ---------------------------------------------------------------------------
describe('S1-① appendBatch：同 stream / 同事务 / 链内连续（Q4）', () => {
  it('golden：3 条事件一个 batch → seq 1..3 连续、verifyChain ok、global_seq 唯一', async () => {
    const result = await store.appendBatch([
      input({ payload: { task_id: TASK_ID, title: '第一条' } }),
      input({ type: 'GoalCreated', payload: { goal_id: 'goal-1', statement: '目标' } }),
      input({ type: 'TaskDefined', payload: { task_id: TASK_ID, title: '定义完成' } }),
    ]);

    expect(result.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(result.events.map((e) => e.type)).toEqual(['TaskCaptured', 'GoalCreated', 'TaskDefined']);
    expect(new Set(result.events.map((e) => e.global_seq)).size).toBe(3);
    expect(result.transitions).toEqual([]);

    const chain = await store.verifyChain(STREAM);
    expect(chain).toMatchObject({ ok: true, length: 3, stream_exists: true });
  });

  it('迁移条目在同一 batch 内按序累积事实（captured→defined→ready 一次提交）', async () => {
    const result = await store.appendBatch([
      input(),
      transitionEntry(),
      transitionEntry({
        from: 'defined',
        to: 'ready',
        facts: {
          dependenciesSatisfied: true,
          dataInputsAvailable: true,
          waitStateNone: true,
          duplicateSuspectFalse: true,
          capabilityAvailable: true,
          policyAllows: true,
        },
      }),
    ]);

    expect(result.transitions.map((t) => t.guard.allowed)).toEqual([true, true]);
    expect(result.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect((await store.verifyChain(STREAM)).ok).toBe(true);
  });

  it('中途 guard 拒绝 → 整批回滚，零事件落库（失败前已写入的条目也不留）', async () => {
    await expect(
      store.appendBatch([
        input(),
        // 形状合法（格 ✓），但缺 hasTitle/assigneeKind → 事务内 guard 拒绝
        transitionEntry({ facts: {} }),
      ]),
    ).rejects.toBeInstanceOf(TransitionDeniedError);

    expect(await countEvents(ctx.pool)).toBe(0);
    expect(await store.readStream(STREAM)).toEqual([]);
  });

  it('中途流状态校验失败（wait_state from 不一致）→ 整批回滚', async () => {
    await seedTaskAt('defined');
    const before = await countEvents(ctx.pool);

    await expect(
      store.appendBatch([
        input({ type: 'WaitConditionCreated', payload: { wait_condition_id: 'wc-1', task_id: TASK_ID, kind: 'person' } }),
        input({
          type: 'TaskWaitStateChanged',
          payload: {
            task_id: TASK_ID, from: 'blocked', to: 'waiting_on_person', reason: 'x',
            actor_id: 'actor-human-1', actor_kind: 'human',
          },
        }),
      ]),
    ).rejects.toBeInstanceOf(TransitionStateError);

    expect(await countEvents(ctx.pool)).toBe(before);
  });

  it('INV-11 收尾序列（WC 取消 + wait_state=none + accepted）可由一个 batch 原子表达', async () => {
    await seedTaskAt('awaiting_acceptance');
    await store.append(input({
      type: 'WaitConditionCreated',
      payload: { wait_condition_id: 'wc-1', task_id: TASK_ID, kind: 'person' },
    }));
    await store.append(input({
      type: 'TaskWaitStateChanged',
      payload: {
        task_id: TASK_ID, from: 'none', to: 'waiting_on_person', reason: '等待回复',
        actor_id: 'actor-human-1', actor_kind: 'human',
      },
    }));
    const before = await countEvents(ctx.pool);

    const result = await store.appendBatch([
      input({
        type: 'WaitConditionCanceled',
        payload: { wait_condition_id: 'wc-1', task_id: TASK_ID, reason: 'task_accepted' },
      }),
      input({
        type: 'TaskWaitStateChanged',
        payload: {
          task_id: TASK_ID, from: 'waiting_on_person', to: 'none', reason: 'task_accepted',
          actor_id: 'actor-human-1', actor_kind: 'human',
        },
      }),
      transitionEntry({
        from: 'awaiting_acceptance',
        to: 'accepted',
        facts: { acceptanceVerdict: 'accepted' },
      }),
    ]);

    expect(result.events.map((e) => e.type)).toEqual([
      'WaitConditionCanceled',
      'TaskWaitStateChanged',
      'TaskLifecycleChanged',
    ]);
    // 收尾已在批次内显式表达 → 内核不重复补发
    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0].closure?.effects_applied).toEqual([
      'cancel_active_wait_conditions',
      'reset_wait_state_none',
    ]);
    expect(await countEvents(ctx.pool)).toBe(before + 3);
    expect((await store.verifyChain(STREAM)).ok).toBe(true);
    expect((await typesOf(store, STREAM)).slice(-3)).toEqual([
      'WaitConditionCanceled',
      'TaskWaitStateChanged',
      'TaskLifecycleChanged',
    ]);
  });

  it('跨 stream / 空批次 / from-to 只给一半 → AppendBatchError，零写入', async () => {
    const before = await countEvents(ctx.pool);

    await expect(
      store.appendBatch([
        input(),
        input({ stream_id: asProjectId('project-other') }),
      ]),
    ).rejects.toBeInstanceOf(AppendBatchError);

    await expect(store.appendBatch([])).rejects.toBeInstanceOf(AppendBatchError);

    await expect(
      store.appendBatch([{ ...transitionEntry(), to: undefined }]),
    ).rejects.toBeInstanceOf(AppendBatchError);

    expect(await countEvents(ctx.pool)).toBe(before);
  });

  it('entity 与事件家族不符在开事务前拒绝（零写入）', async () => {
    await expect(
      store.appendBatch([
        transitionEntry({ entity: 'task', type: 'RunStarted' }),
      ]),
    ).rejects.toBeInstanceOf(EventEntityMismatchError);
    expect(await countEvents(ctx.pool)).toBe(0);
  });

  it('普通条目写终态迁移仍被 TerminalClosureRequiredError 拦住（batch 不是绕过口）', async () => {
    await seedTaskAt('awaiting_acceptance');
    const before = await countEvents(ctx.pool);

    await expect(
      store.appendBatch([
        input({
          type: 'TaskLifecycleChanged',
          payload: { task_id: TASK_ID, from: 'awaiting_acceptance', to: 'accepted', trigger_event_id: 't1' },
        }),
      ]),
    ).rejects.toBeInstanceOf(TerminalClosureRequiredError);

    expect(await countEvents(ctx.pool)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// S1-②（reverify-R1）：原始 append 写迁移事件不得绕行
// ---------------------------------------------------------------------------
describe('S1-② 原始 append：TaskLifecycleChanged 必须与流派生状态对账（R1）', () => {
  it('无 from/to 的裸 TaskLifecycleChanged → TransitionPayloadError，零写入', async () => {
    const before = await countEvents(ctx.pool);
    await expect(
      store.append(input({
        type: 'TaskLifecycleChanged',
        payload: { task_id: TASK_ID, trigger_event_id: 'trigger-1' },
      })),
    ).rejects.toThrow(/必须带 from\/to/);
    expect(await countEvents(ctx.pool)).toBe(before);
  });

  it('from 与流派生 lifecycle 不一致 → TransitionStateError/from_mismatch，零写入', async () => {
    await seedTaskAt('ready');
    const before = await countEvents(ctx.pool);

    await expect(
      store.append(input({
        type: 'TaskLifecycleChanged',
        payload: {
          task_id: TASK_ID, from: 'captured', to: 'defined', trigger_event_id: 'trigger-1',
        },
      })),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TransitionStateError);
      const state = error as TransitionStateError;
      expect(state.reason).toBe('from_mismatch');
      expect(state.expected_from).toBe('ready');
      return true;
    });

    expect(await countEvents(ctx.pool)).toBe(before);
  });

  it('流里没有该 Task → subject_not_found（不得凭空建生命周期）', async () => {
    await store.append(input());
    const before = await countEvents(ctx.pool);

    await expect(
      store.append(input({
        type: 'TaskLifecycleChanged',
        payload: {
          task_id: 'task-ghost', from: 'captured', to: 'defined', trigger_event_id: 'trigger-1',
        },
      })),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TransitionStateError);
      expect((error as TransitionStateError).reason).toBe('subject_not_found');
      return true;
    });

    expect(await countEvents(ctx.pool)).toBe(before);
  });

  it('合法路径回归：按当前态逐条追加仍成功且链完整', async () => {
    await seedTaskAt('defined');
    expect(await typesOf(store, STREAM)).toEqual(['TaskCaptured', 'TaskLifecycleChanged']);
    expect((await store.verifyChain(STREAM)).ok).toBe(true);
  });
});
