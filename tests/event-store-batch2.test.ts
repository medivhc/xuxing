import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { asProjectId, type EventEnvelope, type EventType, type ProjectId } from '../src/kernel/events.js';
import {
  AppendBatchError,
  EventEntityMismatchError,
  IdempotencyKeyConflictError,
  PayloadNotPlainObjectError,
  ProjectCreatedRequiredError,
  TransitionPayloadError,
  TransactionCommitError,
  TransactionScopeError,
  TerminalClosureRequiredError,
  TransitionDeniedError,
  TransitionStateError,
  createPgEventStore,
  migrate,
  type AppendBatchEntryInput,
  type PgEventStore,
} from '../src/kernel/event-store-pg.js';
import {
  guardTransition,
  isMatrixCellAllowed,
} from '../src/kernel/transition-guard.js';
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

function projectCreated(overrides: Partial<AppendBatchEntryInput> = {}): AppendBatchEntryInput {
  return input({
    type: 'ProjectCreated',
    payload: { name: 'Batch 2 项目', created_by: 'actor-human-1' },
    ...overrides,
  });
}

/** 建项目流（S3-②：流的首条事件必须是 ProjectCreated）。 */
async function seedProject(): Promise<void> {
  if ((await store.readStream(STREAM)).length > 0) return;
  await store.append(projectCreated());
}

/** 用普通 append 播种生命周期（B1 语义：generic append 只做矩阵格校验）。 */
async function seedTaskAt(target: 'captured' | 'defined' | 'ready' | 'active' | 'awaiting_acceptance'): Promise<void> {
  await seedProject();
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
      projectCreated(),
      input({ payload: { task_id: TASK_ID, title: '第一条' } }),
      input({ type: 'GoalCreated', payload: { goal_id: 'goal-1', statement: '目标' } }),
      input({ type: 'TaskDefined', payload: { task_id: TASK_ID, title: '定义完成' } }),
    ]);

    expect(result.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(result.events.map((e) => e.type)).toEqual([
      'ProjectCreated', 'TaskCaptured', 'GoalCreated', 'TaskDefined',
    ]);
    expect(new Set(result.events.map((e) => e.global_seq)).size).toBe(4);
    expect(result.transitions).toEqual([]);

    const chain = await store.verifyChain(STREAM);
    expect(chain).toMatchObject({ ok: true, length: 4, stream_exists: true });
  });

  it('迁移条目在同一 batch 内按序累积事实（captured→defined→ready 一次提交）', async () => {
    const result = await store.appendBatch([
      projectCreated(),
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
    expect(result.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect((await store.verifyChain(STREAM)).ok).toBe(true);
  });

  it('中途 guard 拒绝 → 整批回滚，零事件落库（失败前已写入的条目也不留）', async () => {
    await expect(
      store.appendBatch([
        projectCreated(),
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
        projectCreated(),
        projectCreated({ stream_id: asProjectId('project-other') }),
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
        projectCreated(),
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
    await seedProject();
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
    await seedProject();
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
    expect(await typesOf(store, STREAM)).toEqual(['ProjectCreated', 'TaskCaptured', 'TaskLifecycleChanged']);
    expect((await store.verifyChain(STREAM)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// S3-②（REVIEW-q15 MINOR-1 / F13 残留）：流内 ProjectCreated 存在性校验
// ---------------------------------------------------------------------------
describe('S3-② 无 ProjectCreated 事实的流不得写入（两路 + batch）', () => {
  it('append：TaskCaptured 作为新流首条 → ProjectCreatedRequiredError，零写入', async () => {
    await expect(store.append(input())).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ProjectCreatedRequiredError);
      const denied = error as ProjectCreatedRequiredError;
      expect(denied.stream_id).toBe(STREAM);
      expect(denied.type).toBe('TaskCaptured');
      return true;
    });
    expect(await countEvents(ctx.pool)).toBe(0);
    expect(await store.readStream(STREAM)).toEqual([]);
  });

  it('appendStateTransition：新流上的迁移 → ProjectCreatedRequiredError', async () => {
    await expect(
      store.appendStateTransition({
        ...transitionEntry(),
        payload: { task_id: TASK_ID, trigger_event_id: 'trigger-1' },
      } as never),
    ).rejects.toBeInstanceOf(ProjectCreatedRequiredError);
    expect(await countEvents(ctx.pool)).toBe(0);
  });

  it('appendBatch：首条不是 ProjectCreated → 整批拒绝，零写入', async () => {
    await expect(
      store.appendBatch([
        input(),
        projectCreated(),
      ]),
    ).rejects.toBeInstanceOf(ProjectCreatedRequiredError);
    expect(await countEvents(ctx.pool)).toBe(0);
  });

  it('正常建项目流回归：ProjectCreated 先行后，普通事件与迁移都放行', async () => {
    await seedProject();
    await store.append(input());
    const result = await store.appendStateTransition({
      ...transitionEntry(),
      payload: { task_id: TASK_ID, trigger_event_id: 'trigger-1' },
    } as never);
    expect(result.event.type).toBe('TaskLifecycleChanged');
    expect((await store.verifyChain(STREAM)).ok).toBe(true);
  });

  it('requireProjectCreated:false 只服务于 store 机制夹具（显式关闭才允许局部流）', async () => {
    const fixtureStore = createPgEventStore(ctx.pool, {
      clock: () => FIXED_NOW,
      requireProjectCreated: false,
    });
    const event = await fixtureStore.append(input({ stream_id: asProjectId('project-fixture') }));
    expect(event.seq).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// S3-确认乙（pF6 残留）：anyOf 短路——OR 一侧已满足时不得再要求补另一侧
// ---------------------------------------------------------------------------
describe('S3-确认乙 pF6：guard anyOf 与 store 报错文案同步短路', () => {
  it('guard 层：leased→indeterminate 已给 externalSideEffectCalled=true → 放行，missing_facts 为空', () => {
    const result = guardTransition({
      entity: 'run',
      from: 'leased',
      to: 'indeterminate',
      event_type: 'RunIndeterminate',
      facts: { leaseExpired: true, started: true, externalSideEffectCalled: true },
    });

    expect(result.allowed).toBe(true);
    expect(result.missing_facts).toEqual([]);
    expect(result.unmet_requirements).toEqual([]);
  });

  it('guard 层：同格 sideEffectLevel=L2 也满足 OR；两侧都缺时才给 alternatives', () => {
    expect(
      guardTransition({
        entity: 'run',
        from: 'leased',
        to: 'indeterminate',
        event_type: 'RunIndeterminate',
        facts: { leaseExpired: true, started: true, sideEffectLevel: 'L2' },
      }).allowed,
    ).toBe(true);

    const missing = guardTransition({
      entity: 'run',
      from: 'leased',
      to: 'indeterminate',
      event_type: 'RunIndeterminate',
      facts: { leaseExpired: true, started: true },
    });
    expect(missing.allowed).toBe(false);
    expect(missing.missing_facts?.map((hint) => hint.fact)).toEqual([
      'sideEffectLevel',
      'externalSideEffectCalled',
    ]);
  });

  it('store 层：accepted→awaiting_acceptance 只给 acceptanceSuperseded=true → 放行（不再要求 declaresRevalidation）', async () => {
    await seedTaskAt('awaiting_acceptance');
    await store.appendStateTransition({
      ...transitionEntry({
        from: 'awaiting_acceptance',
        to: 'accepted',
        facts: { acceptanceVerdict: 'accepted' },
      }),
      payload: { task_id: TASK_ID, trigger_event_id: 'trigger-b2' },
    } as never);

    const result = await store.appendStateTransition({
      ...transitionEntry({
        from: 'accepted',
        to: 'awaiting_acceptance',
        facts: { acceptanceSuperseded: true },
      }),
      payload: { task_id: TASK_ID, trigger_event_id: 'trigger-reopen' },
    } as never);

    expect(result.guard.allowed).toBe(true);
    expect(result.event.type).toBe('TaskLifecycleChanged');
    expect((await store.verifyChain(STREAM)).ok).toBe(true);
  });

  it('store 层：两侧都缺时错误文案同时给出两个可选 fact（而不是只报一个）', async () => {
    await seedTaskAt('awaiting_acceptance');
    await store.appendStateTransition({
      ...transitionEntry({
        from: 'awaiting_acceptance',
        to: 'accepted',
        facts: { acceptanceVerdict: 'accepted' },
      }),
      payload: { task_id: TASK_ID, trigger_event_id: 'trigger-b2' },
    } as never);

    await expect(
      store.appendStateTransition({
        ...transitionEntry({
          from: 'accepted',
          to: 'awaiting_acceptance',
          facts: {},
        }),
        payload: { task_id: TASK_ID, trigger_event_id: 'trigger-reopen' },
      } as never),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TransitionDeniedError);
      const denied = error as TransitionDeniedError;
      expect(denied.message).toContain("acceptanceSuperseded=true");
      expect(denied.message).toContain('declaresRevalidation');
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// S4-① 事务作用域：外层 store 写同 stream → 立即报错，不挂起
// ---------------------------------------------------------------------------
describe('S4-① 事务内误用外层 store：立即 TransactionScopeError（有耗时上界）', () => {
  it('tx 已写 stream 后，外层 store 写同 stream → 1.5s 内显式报错，且不留半提交', async () => {
    await seedProject();
    const before = await countEvents(ctx.pool);
    const started = Date.now();

    await expect(
      store.withTransaction(async (tx) => {
        await tx.append(input());
        // 误用外层 store（而不是 tx）：旧行为是等 tx 自己持有的链头行锁 → 挂起
        await store.append(input({ payload: { task_id: TASK_ID, title: '外层误写' } }));
      }),
    ).rejects.toBeInstanceOf(TransactionScopeError);

    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1500);
    // tx 内的写入随异常回滚；外层写入根本没执行
    expect(await countEvents(ctx.pool)).toBe(before);
  });

  it('事务作用域内的外层写入（即使不同 stream）同样立即拒绝：全局追加锁下也会死锁', async () => {
    await seedProject();
    const other = asProjectId('project-other-b2');

    await expect(
      store.withTransaction(async (tx) => {
        await tx.append(input());
        await store.append(projectCreated({ stream_id: other }));
      }),
    ).rejects.toBeInstanceOf(TransactionScopeError);

    expect(await store.readStream(other)).toEqual([]);
  });

  it('appendStateTransition 走外层 store 写同 stream 同样立即报错', async () => {
    await seedProject();
    await store.append(input());
    const started = Date.now();

    await expect(
      store.withTransaction(async (tx) => {
        await tx.append(input({ payload: { task_id: TASK_ID, title: '登记 stream' } }));
        await store.appendStateTransition({
          ...transitionEntry(),
          payload: { task_id: TASK_ID, trigger_event_id: 'trigger-outer' },
        } as never);
      }),
    ).rejects.toBeInstanceOf(TransactionScopeError);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

// ---------------------------------------------------------------------------
// S4-② withTransaction 检查 COMMIT command tag（reverify-R2）
// ---------------------------------------------------------------------------
describe('S4-② COMMIT 真实结果：吞掉 SQL 错误不得假成功', () => {
  it('fn 吞掉 SQL 错误 → COMMIT 隐式 ROLLBACK → TransactionCommitError，零落库', async () => {
    await seedProject();
    const before = await countEvents(ctx.pool);

    // 用一条临时 CHECK 约束制造真 SQL 错误（不是 JS 层校验失败）
    await ctx.pool.query(
      "ALTER TABLE events ADD CONSTRAINT batch2_block_goal CHECK (type <> 'GoalCreated')",
    );
    try {
      await expect(
        store.withTransaction(async (tx) => {
          try {
            await tx.append(input({ type: 'GoalCreated', payload: { goal_id: 'goal-blocked' } }));
          } catch {
            // 吞掉 SQL 错误继续返回 —— 旧实现会让调用方误以为提交成功
          }
          return 'fn-returned-ok';
        }),
      ).rejects.toBeInstanceOf(TransactionCommitError);
    } finally {
      await ctx.pool.query('ALTER TABLE events DROP CONSTRAINT IF EXISTS batch2_block_goal');
    }

    expect(await countEvents(ctx.pool)).toBe(before);
  });

  it('正常事务仍返回 fn 结果并真实提交', async () => {
    await seedProject();
    const value = await store.withTransaction(async (tx) => {
      await tx.append(input());
      return 'committed';
    });
    expect(value).toBe('committed');
    expect(await countEvents(ctx.pool)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 杂-1：文案与运维语义（pF7）
// ---------------------------------------------------------------------------
describe('杂-1 pF7 文案组', () => {
  it('① 数组 payload 点名 array（append 与状态迁移两个入口）', async () => {
    await seedProject();
    await expect(store.append(input({ payload: [1, 2] }))).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(PayloadNotPlainObjectError);
      expect((error as Error).message).toContain('array');
      return true;
    });

    await expect(
      store.appendStateTransition({
        ...transitionEntry(),
        payload: [1, 2],
      } as never),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TransitionPayloadError);
      expect((error as Error).message).toContain('array');
      return true;
    });
  });

  it('③ 只有链头行的流：healthy 空流 ok，链头被改乱时 broken_in=stream_head 且 broken_at_seq=null', async () => {
    const emptyStream = asProjectId('project-head-only');
    await ctx.pool.query(
      `INSERT INTO event_streams (stream_id, last_seq, last_hash) VALUES ($1, 0, $2)`,
      [emptyStream, '0'.repeat(64)],
    );
    const healthy = await store.verifyChain(emptyStream);
    expect(healthy).toMatchObject({
      ok: true,
      stream_exists: true,
      length: 0,
      broken_at_seq: null,
      broken_in: null,
    });

    await ctx.pool.query(
      `UPDATE event_streams SET last_seq = 3 WHERE stream_id = $1`,
      [emptyStream],
    );
    const broken = await store.verifyChain(emptyStream);
    expect(broken).toMatchObject({
      ok: false,
      stream_exists: true,
      broken_at_seq: null,
      broken_in: 'stream_head',
    });
    expect(broken.reason).toContain('断点在链头行');
  });
});

// ---------------------------------------------------------------------------
// 杂-2：unknown_state 侧别 / assigneeKind 未指派 / 幂等冲突定位
// ---------------------------------------------------------------------------
describe('杂-2 pF8 余项', () => {
  it('① unknown_state 点名 from / to / both', () => {
    const fromSide = isMatrixCellAllowed('task', 'bogus', 'defined');
    expect(fromSide.reason).toBe('unknown_state');
    expect(fromSide.unknown_state_side).toBe('from');
    expect(fromSide.basis.note).toContain('from=');

    const toSide = isMatrixCellAllowed('task', 'captured', 'bogus');
    expect(toSide.unknown_state_side).toBe('to');

    const both = isMatrixCellAllowed('run', 'bogus', 'also-bogus');
    expect(both.unknown_state_side).toBe('both');
  });

  it('② assigneeKind=unassigned 可表达「未指派」，不要求 Agent 结构化契约', () => {
    const unassigned = guardTransition({
      entity: 'task',
      from: 'captured',
      to: 'defined',
      event_type: 'TaskLifecycleChanged',
      facts: { hasTitle: true, assigneeKind: 'unassigned' },
    });
    expect(unassigned.allowed).toBe(true);

    const agentMissingContract = guardTransition({
      entity: 'task',
      from: 'captured',
      to: 'defined',
      event_type: 'TaskLifecycleChanged',
      facts: { hasTitle: true, assigneeKind: 'agent' },
    });
    expect(agentMissingContract.allowed).toBe(false);
    expect(agentMissingContract.missing_facts?.map((hint) => hint.fact)).toEqual([
      'contractStructured',
    ]);
  });

  it('③ IdempotencyKeyConflictError 带冲突事件 id 与字段名', async () => {
    await seedProject();
    const first = await store.append(input({ idempotency_key: 'idem-misc-1' }));

    await expect(
      store.append(input({
        idempotency_key: 'idem-misc-1',
        payload: { task_id: TASK_ID, title: '不同内容' },
      })),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(IdempotencyKeyConflictError);
      const conflict = error as IdempotencyKeyConflictError;
      expect(conflict.existing_event_id).toBe(first.id);
      expect(conflict.conflicting_fields).toEqual(['payload']);
      expect(conflict.message).toContain(`existing_event_id=${first.id}`);
      expect(conflict.message).toContain('冲突字段=payload');
      return true;
    });
  });
});
