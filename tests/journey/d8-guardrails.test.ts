import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CanonicalizationError,
  canonicalJson,
  EventEntityMismatchError,
  IdempotencyKeyConflictError,
  TransitionDeniedError,
  TransitionPayloadError,
  TransitionPayloadMismatchError,
  UnknownEventTypeError,
  computeEventHash,
  createPgEventStore,
  migrate,
  type PgEventStore,
} from '../../src/kernel/event-store-pg.js';
import type { EventEnvelope, EventType } from '../../src/kernel/events.js';
import { EVENT_TYPES } from '../../src/kernel/events.js';
import {
  RUN_STATES,
  TASK_STATES,
  guardTransition,
  isMatrixCellAllowed,
} from '../../src/kernel/transition-guard.js';
import { createTestPg, resetEventTables, type TestPg } from '../support/pg.js';
import { D8, FIXED_NOW, runD8Journey } from './support/journey-script.js';

// ============================================================================
// D9 质量门 · 旅程流上的硬拒（guardrails）
//
// 旅程把合法路径走通；本文件在**同一事件流之上**故意做非法写入，逐条验证：
//   A. 内核抛的是哪个 typed error（不是笼统 500、更不是静默落库）；
//   B. 被拒之后事件流一条都没多（零写入），且后续合法写入仍可继续。
//
// 纪律：断言只引用内核真实行为与 spec §3.1/§3.2/§4/§5 的明文条款；
//       矩阵里确实走不通的 REQ-HUM-1 created→running 按事实登记为缺口（FINDING D9-J2）。
// ============================================================================

const KERNEL = { actor_id: 'actor-kernel', actor_kind: 'system' as const };

let ctx: TestPg;
let store: PgEventStore;
let stream: EventEnvelope[];

async function eventCount(): Promise<number> {
  const { rows } = await ctx.pool.query<{ n: number }>('select count(*)::int as n from events');
  return rows[0].n;
}

async function streamLength(): Promise<number> {
  return (await store.readStream(D8.project)).length;
}

/** 期望被拒的写入：断言 error 类型 + 事件流零增长（含全局表计数与本流长度）。 */
async function expectRefused(
  label: string,
  fn: () => Promise<unknown>,
  errorType: new (...args: never[]) => Error,
): Promise<Error> {
  const beforeTotal = await eventCount();
  const beforeStream = await streamLength();
  let thrown: unknown = null;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `${label}：内核必须拒绝，而不是静默落库`).toBeInstanceOf(errorType);
  expect(await eventCount(), `${label}：被拒后 events 表不得多行`).toBe(beforeTotal);
  expect(await streamLength(), `${label}：被拒后本流不得多事件`).toBe(beforeStream);
  return thrown as Error;
}

beforeAll(async () => {
  ctx = await createTestPg();
  await migrate(ctx.pool);
  await resetEventTables(ctx.pool);
  store = createPgEventStore(ctx.pool, { clock: () => FIXED_NOW });
  await runD8Journey(store);
  stream = await store.readStream(D8.project);
});

afterAll(async () => {
  await ctx?.close();
});

describe('封闭事件目录（spec §4）', () => {
  it('目录条目与 spec 一致：53 类冻结 + K1 修订增补 3 类，且心跳不在目录内（P1-4）', () => {
    // K1-SPEC v0.4 §1.2/§4.2/§4.4 修订增补（登记于 docs/interaction-contract.md
    // K1 附则）：NodeRegistered / NodeOffline（$system 流）、RunSideEffectRecorded。
    // 除此三类外，目录仍须与冻结 spec §4 逐字一致——多一类少一类都失败。
    expect(EVENT_TYPES).toHaveLength(56);
    for (const added of ['NodeRegistered', 'NodeOffline', 'RunSideEffectRecorded']) {
      expect(EVENT_TYPES as readonly string[]).toContain(added);
    }
    expect(EVENT_TYPES).not.toContain('RunHeartbeat');
    // 旅程里出现过的类型必须全在目录内
    const used = new Set(stream.map((event) => event.type));
    for (const type of used) expect(EVENT_TYPES as readonly string[]).toContain(type);
  });

  it('写目录外类型 ⇒ UnknownEventTypeError，且零落库', async () => {
    const error = await expectRefused(
      '未知事件类型',
      () => store.append({
        stream_id: D8.project, type: 'TaskHeartbeat' as EventType,
        ...KERNEL, causation_id: null, correlation_id: 'd9-guardrails', idempotency_key: null,
        payload: { task_id: D8.captureTask },
      }),
      UnknownEventTypeError,
    );
    expect(error.message).toMatch(/事件目录是封闭集/);
  });
});

describe('§3.1 Task 矩阵硬拒', () => {
  it('captured → ready（跳步）⇒ TransitionDeniedError/illegal_transition', async () => {
    const error = await expectRefused(
      'captured→ready 跳步',
      () => store.appendStateTransition({
        stream_id: D8.project, type: 'TaskLifecycleChanged', ...KERNEL,
        causation_id: null, correlation_id: 'd9-guardrails', idempotency_key: null,
        payload: { task_id: D8.captureTask, trigger_event_id: 'guardrail-probe-captured-ready' }, entity: 'task', from: 'captured', to: 'ready',
        facts: { hasTitle: true, assigneeKind: 'human' },
      }),
      TransitionDeniedError,
    ) as TransitionDeniedError;
    expect(error.result.reason).toBe('illegal_transition');
    expect(error.result.basis.row).toBe('captured');
    expect(error.result.basis.col).toBe('ready');
  });

  it('accepted → canceled ⇒ 被拒（FINDING D9-J4：task 终态集只含 canceled，理由标签为 illegal_transition）', async () => {
    const cell = isMatrixCellAllowed('task', 'accepted', 'canceled');
    expect(cell.allowed).toBe(false);
    const error = await expectRefused(
      'accepted→canceled',
      () => store.appendStateTransition({
        stream_id: D8.project, type: 'TaskLifecycleChanged', ...KERNEL,
        causation_id: null, correlation_id: 'd9-guardrails', idempotency_key: null,
        payload: { task_id: D8.importTask, trigger_event_id: 'guardrail-probe-accepted-canceled' }, entity: 'task', from: 'accepted', to: 'canceled',
        facts: { allRunsTerminal: true },
      }),
      TransitionDeniedError,
    ) as TransitionDeniedError;
    // spec §3.1 矩阵格注写的是「accepted 为终态；取消须另立 Task」，
    // 但 src/kernel/transition-guard.ts:573 的 isTerminal('task', …) 只认 canceled，
    // 于是拒绝理由标签是 illegal_transition（结论一致，归因不同）。旅程按事实断言。
    expect(error.result.reason).toBe('illegal_transition');
    expect(error.result.basis.cell).toBe('–');
    expect(error.result.basis.note).toContain('accepted 为终态');
    // 同族对照：Run 的 succeeded 在 isTerminal 里确实算终态
    expect(isMatrixCellAllowed('run', 'succeeded', 'running').reason).toBe('terminal_state');
  });

  it('canceled → 除 captured 外整行皆拒；captured 列缺格 ⇒ 大声抛（FINDING D9-J3）', () => {
    for (const to of TASK_STATES.filter((state) => state !== 'captured')) {
      if (to === 'canceled') continue;
      expect(isMatrixCellAllowed('task', 'canceled', to).allowed, `canceled→${to}`).toBe(false);
    }
    expect(() => isMatrixCellAllowed('task', 'canceled', 'captured'))
      .toThrow(/transition matrix incomplete: §3.1 canceled→captured/);
  });

  it('缺 fact ⇒ precondition_facts_missing，并给出可执行提示（F-a）', () => {
    // 合并后口径（F1）：写路径先按事件流派生当前状态校验 from——importTask 实际已 accepted，
    // 写路径探针（from='awaiting_acceptance'）会先撞 from_mismatch（TransitionStateError），到不了 guard 的 fact 判定。
    // 「缺 fact ⇒ precondition_facts_missing + 可执行提示」的语义改在 guard 层判定（本测试下半段原本即 guard 层）；
    // 提示文本由 missing_facts 的 expected 字段承载（原断言对异常消息的检查随层移去掉）。
    const denied = guardTransition({
      entity: 'task', event_type: 'TaskLifecycleChanged',
      from: 'awaiting_acceptance', to: 'accepted', facts: {},
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('precondition_facts_missing');
    expect(denied.missing_facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requirement: 'acceptanceAccepted',
          fact: 'acceptanceVerdict',
          expected: "acceptanceVerdict='accepted'",
        }),
      ]),
    );

    // 给了 fact 但值不满足 ⇒ 走 unmet_requirements（另一种拒绝，不是「缺参数」）
    const unmet = guardTransition({
      entity: 'task', event_type: 'TaskLifecycleChanged',
      from: 'awaiting_acceptance', to: 'accepted',
      facts: { acceptanceVerdict: 'partially_accepted' },
    });
    expect(unmet.allowed).toBe(false);
    expect(unmet.reason).toBe('precondition_unmet');
    expect(unmet.unmet).toContain('acceptanceAccepted');
  });
});

describe('§3.2 Run 矩阵硬拒 + D9-J2（Batch 2 关闭）', () => {
  it('终态 Run 再迁移（succeeded → running）⇒ 被拒', async () => {
    const error = await expectRefused(
      '终态 Run 复活',
      () => store.appendStateTransition({
        stream_id: D8.project, type: 'RunStarted', ...KERNEL,
        causation_id: null, correlation_id: 'd9-guardrails', idempotency_key: null,
        payload: { run_id: D8.runImport }, entity: 'run', from: 'succeeded', to: 'running',
      }),
      TransitionDeniedError,
    ) as TransitionDeniedError;
    expect(['illegal_transition', 'terminal_state']).toContain(error.result.reason);
  });

  it('Run 自环（running → running）不算迁移 ⇒ not_a_transition', () => {
    // 合并后口径（F1）：写路径先按事件流派生当前状态校验 from——本 Run 实际已 succeeded，
    // 写路径自环探针会先撞 from_mismatch（TransitionStateError），到不了 guard 的自环判定。
    // 「自环不算迁移」的语义在 guard 层判定，与本文件其他格级断言同层。
    expect(
      guardTransition({ entity: 'run', event_type: 'RunStarted', from: 'running', to: 'running' }).reason,
    ).toBe('not_a_transition');
  });

  it('queued → running（未经租约）⇒ 被拒；queued → leased ⇒ 放行', () => {
    expect(isMatrixCellAllowed('run', 'queued', 'running').allowed).toBe(false);
    expect(isMatrixCellAllowed('run', 'queued', 'leased').allowed).toBe(true);
    // 格本身合法（租约过期未启动可回队列），但没有 facts 就走不通：矩阵与前置条件是两层
    expect(isMatrixCellAllowed('run', 'leased', 'queued').allowed).toBe(true);
    expect(
      guardTransition({
        entity: 'run', event_type: 'RunQueued', from: 'leased', to: 'queued', facts: {},
      }).reason,
    ).toBe('precondition_facts_missing');
  });

  it('indeterminate 不是死端：REQ-RUN-3 对账三格放行，其余格拒绝', () => {
    for (const to of ['queued', 'leased', 'running', 'timed_out'] as const) {
      const cell = isMatrixCellAllowed('run', 'indeterminate', to);
      expect(cell.allowed, `indeterminate→${to}`).toBe(false);
      expect(cell.reason).toBe('illegal_transition');
    }
    // 无 facts 时对账格也不放行（缺 fact 而非缺格）
    expect(
      guardTransition({
        entity: 'run', event_type: 'RunSucceeded', from: 'indeterminate', to: 'succeeded', facts: {}, // F6：对账格 event_types 白名单按目标格取终态事件（原 RunReconciled 已不在白名单）
      }).reason,
    ).toBe('precondition_facts_missing');
    // 补上对账结论才允许：三条出路各用自己的 fact
    expect(
      guardTransition({
        entity: 'run', event_type: 'RunSucceeded', from: 'indeterminate', to: 'succeeded',
        facts: { reconciliation: 'completed' },
      }).allowed,
    ).toBe(true);
    expect(
      guardTransition({
        entity: 'run', event_type: 'RunFailed', from: 'indeterminate', to: 'failed',
        facts: { reconciliation: 'not_executed' },
      }).allowed,
    ).toBe(true);
    expect(
      guardTransition({
        entity: 'run', event_type: 'RunCanceled', from: 'indeterminate', to: 'canceled',
        facts: { reconciliation: 'completed', reconciliationConcluded: true },
      }).allowed,
    ).toBe(true);
    // succeeded/failed/canceled 三个真终态整行拒绝（除缺格的 →created）
    for (const from of ['succeeded', 'failed', 'canceled', 'timed_out'] as const) {
      for (const to of RUN_STATES.filter((state) => state !== 'created' && state !== from)) {
        expect(isMatrixCellAllowed('run', from, to).allowed, `${from}→${to}`).toBe(false);
      }
    }
  });

  it('FINDING D9-J3：§3.1/§3.2 表在「回到初始态」这一列缺格（16 格），内核按编程错误大声抛', () => {
    const gaps: string[] = [];
    const decided: string[] = [];
    for (const entity of ['task', 'run'] as const) {
      const states = entity === 'task' ? TASK_STATES : RUN_STATES;
      for (const from of states) {
        for (const to of states) {
          try {
            const cell = isMatrixCellAllowed(entity, from, to);
            decided.push(`${entity}:${from}→${to}=${cell.allowed ? '✓' : cell.reason}`);
          } catch (error) {
            gaps.push(`${entity}:${from}→${to}`);
            expect(String((error as Error).message)).toMatch(/transition matrix incomplete/);
          }
        }
      }
    }
    // 缺的正好是两枚初始列：task 的 →captured 全列（含 captured→captured 自格）、run 的 →created 全列
    expect(gaps).toEqual([
      ...TASK_STATES.map((from) => `task:${from}→captured`),
      ...RUN_STATES.map((from) => `run:${from}→created`),
    ]);
    // 其余格（7×7 + 8×8 减去缺格）都必须给出可判定的结论，而不是静默放行
    expect(decided).toHaveLength(TASK_STATES.length ** 2 + RUN_STATES.length ** 2 - gaps.length);
    const silentAllow = decided.filter((entry) => entry.endsWith('=✓'));
    // ✓ 格只应出现在 spec 允许的迁移上；这里至少保证「回到初始态」没有任何一条被放行
    expect(silentAllow.filter((entry) => /→captured$|→created$/.test(entry))).toEqual([]);
  });

  it('D9-J2 关闭：human_light created→running 由 run_kind 维度按 REQ-HUM-1 放行', () => {
    // executor 的 §3.2 格不变（未经租约不可启动）
    const executorCell = isMatrixCellAllowed('run', 'created', 'running');
    expect(executorCell.allowed).toBe(false);
    expect(executorCell.basis.note).toBe('未经租约不可启动');

    // human_light 维度按 REQ-HUM-1 放行（无租约/无队列/无超时）
    expect(isMatrixCellAllowed('run', 'created', 'running', 'human_light').allowed).toBe(true);
    expect(
      guardTransition({
        entity: 'run', event_type: 'RunStarted', from: 'created', to: 'running', run_kind: 'human_light',
      }).allowed,
    ).toBe(true);
    // 但 REQ-HUM-1 明确不出现 leased / indeterminate / timed_out
    for (const to of ['queued', 'leased', 'indeterminate', 'timed_out'] as const) {
      expect(
        guardTransition({
          entity: 'run', event_type: 'RunStarted', from: 'created', to, run_kind: 'human_light',
        }).allowed,
        `human_light created→${to}`,
      ).toBe(false);
    }
  });
});

describe('写路径形状校验（typed denials，全部零写入）', () => {
  it('entity 与事件家族不符 ⇒ EventEntityMismatchError', async () => {
    await expectRefused(
      'entity:task 配 RunStarted',
      () => store.appendStateTransition({
        stream_id: D8.project, type: 'RunStarted', ...KERNEL,
        causation_id: null, correlation_id: 'd9-guardrails', idempotency_key: null,
        payload: { run_id: D8.runImport }, entity: 'task', from: 'ready', to: 'active',
      }),
      EventEntityMismatchError,
    );
  });

  it('payload.from 与顶层 from 矛盾 ⇒ TransitionPayloadMismatchError', async () => {
    const error = await expectRefused(
      'payload.from 矛盾',
      () => store.appendStateTransition({
        stream_id: D8.project, type: 'TaskLifecycleChanged', ...KERNEL,
        causation_id: null, correlation_id: 'd9-guardrails', idempotency_key: null,
        payload: { task_id: D8.captureTask, from: 'active', to: 'ready' },
        entity: 'task', from: 'captured', to: 'defined',
        facts: { hasTitle: true, assigneeKind: 'human' },
      }),
      TransitionPayloadMismatchError,
    ) as TransitionPayloadMismatchError;
    expect(error.field).toBe('from');
    expect(error.top_level).toBe('captured');
  });

  it('payload 非 plain object ⇒ TransitionPayloadError', async () => {
    await expectRefused(
      'payload 是数组',
      () => store.appendStateTransition({
        stream_id: D8.project, type: 'TaskLifecycleChanged', ...KERNEL,
        causation_id: null, correlation_id: 'd9-guardrails', idempotency_key: null,
        payload: [D8.captureTask], entity: 'task', from: 'captured', to: 'defined',
        // 先让矩阵与前置条件通过，才轮到 payload 形状校验（顺序也是内核写路径的事实）
        facts: { hasTitle: true, assigneeKind: 'human' },
      }),
      TransitionPayloadError,
    );
  });

  it('payload 含不可规范化值 ⇒ CanonicalizationError（目录外类型也拦在写前）', async () => {
    const error = await expectRefused(
      'payload 带 undefined',
      () => store.append({
        stream_id: D8.project, type: 'EvidenceAdded', ...KERNEL,
        causation_id: null, correlation_id: 'd9-guardrails', idempotency_key: null,
        payload: { evidence_id: 'ev-d9-bad', task_id: D8.importTask, note: undefined },
      }),
      CanonicalizationError,
    );
    expect(error.message).toMatch(/不可规范化/);
  });
});

describe('INV-13 幂等键：同键同内容是重放，同键不同内容是错误', () => {
  it('重放返回既有事件本身（不改内容、不占新 seq）', async () => {
    const before = await eventCount();
    const payload = {
      evidence_id: 'ev-d9-idem', task_id: D8.importTask, source_kind: 'external_doc',
      content_ref: 'object://d9/idem', content_hash: '0'.repeat(64),
      captured_at: FIXED_NOW.toISOString(), environment: 'sandbox', verification_status: 'unverified',
    };
    const first = await store.append({
      stream_id: D8.project, type: 'EvidenceAdded', ...KERNEL,
      causation_id: null, correlation_id: 'd9-guardrails', idempotency_key: 'd9-idem-1', payload,
    });
    const again = await store.append({
      stream_id: D8.project, type: 'EvidenceAdded', ...KERNEL,
      causation_id: null, correlation_id: 'd9-guardrails', idempotency_key: 'd9-idem-1', payload,
    });
    expect(again.id).toBe(first.id);
    expect(again.hash).toBe(first.hash);
    expect(await eventCount()).toBe(before + 1);
  });

  it('同键不同内容 ⇒ IdempotencyKeyConflictError 且不写第二行', async () => {
    const before = await eventCount();
    const error = await expectRefused(
      '幂等键内容冲突',
      () => store.append({
        stream_id: D8.project, type: 'EvidenceAdded', ...KERNEL,
        causation_id: null, correlation_id: 'd9-guardrails', idempotency_key: 'd9-idem-1',
        payload: {
          evidence_id: 'ev-d9-idem', task_id: D8.importTask, source_kind: 'device_log',
          content_ref: 'object://d9/other', content_hash: '1'.repeat(64),
          captured_at: FIXED_NOW.toISOString(), environment: 'sandbox', verification_status: 'unverified',
        },
      }),
      IdempotencyKeyConflictError,
    ) as IdempotencyKeyConflictError;
    expect(error.idempotency_key).toBe('d9-idem-1');
    expect(error.stream_id).toBe(D8.project);
    expect(await eventCount()).toBe(before);
  });
});

describe('append-only 与哈希链', () => {
  it('UPDATE events ⇒ 触发器拒绝（历史不可改写）', async () => {
    const target = stream[0];
    await expect(ctx.pool.query('update events set payload = $1::jsonb where id = $2', [
      JSON.stringify({ tampered: true }), target.id,
    ])).rejects.toThrow(/append-only|只允许追加|do not modify|BEFORE UPDATE/);
    const { rows } = await ctx.pool.query<{ payload_canonical: string }>(
      'select payload_canonical from events where id = $1', [target.id],
    );
    expect(rows[0].payload_canonical).toBe(canonicalJson(target.payload));
  });

  it('DELETE FROM events ⇒ 触发器拒绝，整条链仍可验', async () => {
    await expect(ctx.pool.query('delete from events where stream_id = $1', [D8.project]))
      .rejects.toThrow(/append-only|只允许追加|do not modify|BEFORE DELETE/);
    const verification = await store.verifyChain(D8.project);
    const current = await store.readStream(D8.project);
    expect(verification.ok).toBe(true);
    expect(verification.length).toBe(current.length);
  });

  it('逐事件重算哈希：prev_hash 链 + GENESIS 起点 + canonical payload 参与摘要', () => {
    let prev = '0'.repeat(64);
    for (const event of stream) {
      expect(event.prev_hash, `seq=${event.seq} 的 prev_hash`).toBe(prev);
      expect(event.hash).toBe(computeEventHash(prev, canonicalJson(event.payload), event.seq));
      expect(event.hash).toMatch(/^[0-9a-f]{64}$/);
      prev = event.hash;
    }
  });

  it('seq 从 1 连号、global_seq 严格升序且唯一（INV-12 全序）', () => {
    expect(stream.map((event) => event.seq)).toEqual(stream.map((_, i) => i + 1));
    const globals = stream.map((event) => event.global_seq);
    expect(globals).toEqual([...globals].sort((a, b) => a - b));
    expect(new Set(globals).size).toBe(globals.length);
  });
});

describe('INV-11 事务性：收尾动作要么全成，要么零事件', () => {
  it('withTransaction 内抛错 ⇒ 回滚，事件流一条不加', async () => {
    const beforeTotal = await eventCount();
    const beforeStream = await streamLength();
    await expect(
      store.withTransaction(async (tx) => {
        await tx.append({
          stream_id: D8.project, type: 'WaitConditionCreated', ...KERNEL,
          causation_id: null, correlation_id: 'd9-rollback', idempotency_key: null,
          payload: {
            wait_condition_id: 'wait-d9-ghost', task_id: D8.importTask, kind: 'person',
            target: 'actor-ghost', created_at: FIXED_NOW.toISOString(),
          },
        });
        throw new Error('故意的收尾失败（验证回滚）');
      }),
    ).rejects.toThrow(/故意的收尾失败/);
    expect(await eventCount()).toBe(beforeTotal);
    expect(await streamLength()).toBe(beforeStream);
    const { rows } = await ctx.pool.query<{ n: number }>(
      "select count(*)::int as n from events where payload->>'wait_condition_id' = $1",
      ['wait-d9-ghost'],
    );
    expect(rows[0].n).toBe(0);
  });

  it('同事务内多条事件共享同一 client：seq 连号且链连续（正例对照）', async () => {
    const before = await streamLength();
    await store.withTransaction(async (tx) => {
      await tx.append({
        stream_id: D8.project, type: 'EvidenceAdded', ...KERNEL,
        causation_id: null, correlation_id: 'd9-tx', idempotency_key: null,
        payload: {
          evidence_id: 'ev-d9-tx-1', task_id: D8.importTask, source_kind: 'external_doc',
          content_ref: 'object://d9/tx-1', content_hash: '2'.repeat(64),
          captured_at: FIXED_NOW.toISOString(), environment: 'sandbox', verification_status: 'unverified',
        },
      });
      await tx.append({
        stream_id: D8.project, type: 'EvidenceAdded', ...KERNEL,
        causation_id: null, correlation_id: 'd9-tx', idempotency_key: null,
        payload: {
          evidence_id: 'ev-d9-tx-2', task_id: D8.importTask, source_kind: 'external_doc',
          content_ref: 'object://d9/tx-2', content_hash: '3'.repeat(64),
          captured_at: FIXED_NOW.toISOString(), environment: 'sandbox', verification_status: 'unverified',
        },
      });
    });
    const after = await store.readStream(D8.project);
    expect(after).toHaveLength(before + 2);
    const [first, second] = after.slice(before);
    expect(second.prev_hash).toBe(first.hash);
    expect((await store.verifyChain(D8.project)).ok).toBe(true);
  });
});

describe('拒绝之后旅程仍可继续（拒绝不留半成品状态）', () => {
  it('前面的硬拒未污染投影：合法迁移照常放行', async () => {
    const before = await streamLength();
    const { guard } = await store.appendStateTransition({
      stream_id: D8.project, type: 'TaskLifecycleChanged', ...KERNEL,
      causation_id: null, correlation_id: 'd9-after', idempotency_key: null,
      payload: { task_id: D8.reportTask, trigger_event_id: 'guardrail-probe-aftermath-legal' }, entity: 'task', from: 'ready', to: 'defined',
      facts: {},
    });
    expect(guard.allowed).toBe(true);
    expect(await streamLength()).toBe(before + 1);
  });
});
