import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asProjectId, type ProjectId } from '../src/kernel/events.js';
import {
  createPgEventStore,
  migrate,
  type AppendBatchEntryInput,
  type PgEventStore,
} from '../src/kernel/event-store-pg.js';
import {
  SchedulerInputError,
  fireDueTimers,
  listDueTimers,
  registerWaitConditionTimer,
} from '../src/kernel/scheduler.js';
import {
  recomputeAcceptance,
  recomputeTaskAcceptance,
  type AcceptanceFact,
} from '../src/kernel/acceptance.js';
import { createTestPg, resetEventTables, type TestPg } from './support/pg.js';
import type { TaskLifecycle } from '../src/domain/types.js';

// ============================================================================
// S6-①：REQ-SCH-3 最小 Scheduler（注册 → 触发，定时器持久化在事件里）
// S6-②：REQ-ACC-3 判据级 Acceptance 重算命令入口
// ============================================================================

const STREAM: ProjectId = asProjectId('project-s6');
const TASK_ID = 'task-s6';
const FIXED_NOW = new Date('2026-10-24T12:00:00.000Z');

let ctx: TestPg;
let store: PgEventStore;

function base(overrides: Partial<AppendBatchEntryInput> = {}): AppendBatchEntryInput {
  return {
    stream_id: STREAM,
    type: 'TaskCaptured',
    actor_id: 'actor-human-1',
    actor_kind: 'human',
    causation_id: null,
    correlation_id: 'corr-s6',
    idempotency_key: null,
    payload: { task_id: TASK_ID, title: 'S6 任务' },
    ...overrides,
  };
}

async function seedProjectAndTask(): Promise<void> {
  await store.append(base({
    type: 'ProjectCreated',
    payload: { name: 'S6 项目', created_by: 'actor-human-1' },
  }));
  await store.append(base());
}

async function seedTaskAtAwaitingAcceptance(): Promise<void> {
  await seedProjectAndTask();
  for (const [from, to] of [
    ['captured', 'defined'],
    ['defined', 'ready'],
    ['ready', 'active'],
    ['active', 'awaiting_acceptance'],
  ] as const) {
    await store.append(base({
      type: 'TaskLifecycleChanged',
      payload: { task_id: TASK_ID, from, to, trigger_event_id: `seed-${to}` },
    }));
  }
  await store.append(base({
    type: 'OutcomeRecorded',
    payload: { outcome_id: 'out-1', task_id: TASK_ID, run_id: 'run-1' },
  }));
}

// 合入注记（Batch2×Q12）：受理一致性（REQ-ACC-2）要求信封 actor 与 payload acceptor 同一，本 helper 以验收人本人落账。
async function recordAcceptance(input: {
  acceptance_id: string;
  verdict: 'accepted' | 'rejected' | 'partially_accepted';
  criteria: { criterion_ref: string; verdict: 'passed' | 'failed' | 'not_applicable' }[];
  supersedes_id?: string;
}): Promise<void> {
  await store.append(base({
    type: 'AcceptanceRecorded',
    actor_id: 'actor-reviewer',
    actor_kind: 'human',
    payload: {
      acceptance_id: input.acceptance_id,
      task_id: TASK_ID,
      contract_rev: 1,
      subject_outcome_id: 'out-1',
      acceptor_id: 'actor-reviewer',
      acceptor_kind: 'human',
      verdict: input.verdict,
      criterion_results: input.criteria,
      ...(input.supersedes_id ? { supersedes_id: input.supersedes_id } : {}),
    },
  }));
}

async function currentLifecycle(): Promise<TaskLifecycle> {
  const events = await store.readStream(STREAM);
  let lifecycle: TaskLifecycle = 'captured';
  for (const event of events) {
    if (event.type === 'TaskLifecycleChanged') {
      lifecycle = (event.payload as { to: TaskLifecycle }).to;
    }
  }
  return lifecycle;
}

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

// ---------------------------------------------------------------------------
// S6-① Scheduler
// ---------------------------------------------------------------------------
describe('S6-① Scheduler：注册 → 触发（REQ-SCH-3 持久化定时器）', () => {
  it('注册 due_at → 到期前不触发、到期后 listDueTimers 命中', async () => {
    await seedProjectAndTask();
    await registerWaitConditionTimer(store, {
      stream_id: STREAM,
      wait_condition_id: 'wc-s6',
      task_id: TASK_ID,
      kind: 'until',
      target_ref: '2026-10-25',
      due_at: '2026-10-25T00:00:00.000Z',
      actor_id: 'actor-human-1',
      actor_kind: 'human',
      causation_id: null,
      correlation_id: 'corr-s6',
      idempotency_key: null,
    });

    expect(await listDueTimers(store, new Date('2026-10-24T23:59:59.000Z'))).toEqual([]);
    expect(await listDueTimers(store, FIXED_NOW)).toEqual([]); // 注册时间 = 触发时间点，未到期
    const due = await listDueTimers(store, new Date('2026-10-25T00:00:01.000Z'));
    expect(due).toEqual([
      {
        stream_id: STREAM,
        wait_condition_id: 'wc-s6',
        task_id: TASK_ID,
        due_at: '2026-10-25T00:00:00.000Z',
      },
    ]);
  });

  it('到期触发写 WaitConditionExpired；重复触发不产生第二条（触发后不再 active）', async () => {
    await seedProjectAndTask();
    await registerWaitConditionTimer(store, {
      stream_id: STREAM,
      wait_condition_id: 'wc-s6',
      task_id: TASK_ID,
      kind: 'until',
      target_ref: '2026-10-25',
      due_at: '2026-10-25T00:00:00.000Z',
      actor_id: 'actor-human-1',
      actor_kind: 'human',
      causation_id: null,
      correlation_id: 'corr-s6',
      idempotency_key: null,
    });

    const at = new Date('2026-10-25T00:00:01.000Z');
    const first = await fireDueTimers(store, at);
    expect(first.due).toHaveLength(1);
    expect(first.expired.map((event) => event.type)).toEqual(['WaitConditionExpired']);
    expect(first.expired[0].payload).toMatchObject({
      wait_condition_id: 'wc-s6',
      task_id: TASK_ID,
      reason: 'due_at_reached',
    });

    const second = await fireDueTimers(store, new Date('2026-10-25T00:01:00.000Z'));
    expect(second.due).toEqual([]);
    expect(second.expired).toEqual([]);
    expect((await store.verifyChain(STREAM)).ok).toBe(true);
  });

  it('定时器持久化：新进程实例从事件流恢复待触发集合（不靠内存计时）', async () => {
    await seedProjectAndTask();
    await registerWaitConditionTimer(store, {
      stream_id: STREAM,
      wait_condition_id: 'wc-s6',
      task_id: TASK_ID,
      kind: 'person',
      target_ref: 'person-1',
      due_at: '2026-10-25T00:00:00.000Z',
      actor_id: 'actor-human-1',
      actor_kind: 'human',
      causation_id: null,
      correlation_id: 'corr-s6',
      idempotency_key: null,
    });

    const restarted = createPgEventStore(ctx.pool, { clock: () => FIXED_NOW });
    const due = await listDueTimers(restarted, new Date('2026-10-25T00:00:01.000Z'));
    expect(due.map((timer) => timer.wait_condition_id)).toEqual(['wc-s6']);
  });

  it('kind=until 缺 due_at / 非法 due_at → SchedulerInputError，零写入', async () => {
    await seedProjectAndTask();
    const before = (await store.readStream(STREAM)).length;

    await expect(
      registerWaitConditionTimer(store, {
        stream_id: STREAM,
        wait_condition_id: 'wc-bad',
        task_id: TASK_ID,
        kind: 'until',
        target_ref: 'x',
        due_at: null,
        actor_id: 'actor-human-1',
        actor_kind: 'human',
        causation_id: null,
        correlation_id: 'corr-s6',
        idempotency_key: null,
      }),
    ).rejects.toBeInstanceOf(SchedulerInputError);

    await expect(
      registerWaitConditionTimer(store, {
        stream_id: STREAM,
        wait_condition_id: 'wc-bad',
        task_id: TASK_ID,
        kind: 'person',
        target_ref: 'x',
        due_at: 'not-a-date',
        actor_id: 'actor-human-1',
        actor_kind: 'human',
        causation_id: null,
        correlation_id: 'corr-s6',
        idempotency_key: null,
      }),
    ).rejects.toBeInstanceOf(SchedulerInputError);

    expect((await store.readStream(STREAM)).length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// S6-② Acceptance 重算
// ---------------------------------------------------------------------------
describe('S6-② Acceptance 重算（REQ-ACC-3）', () => {
  const criteria = ['c1', 'c2'];

  function fact(overrides: Partial<AcceptanceFact>): AcceptanceFact {
    return {
      acceptance_id: 'acc-1',
      task_id: TASK_ID,
      contract_rev: 1,
      subject_outcome_id: 'out-1',
      verdict: 'accepted',
      criterion_results: [
        { criterion_ref: 'c1', verdict: 'passed' },
        { criterion_ref: 'c2', verdict: 'passed' },
      ],
      supersedes_id: null,
      order: 10,
      ...overrides,
    };
  }

  it('accepted → lifecycle=accepted；rejected → defined；partially → 停在 awaiting_acceptance 并给待补集', () => {
    const accepted = recomputeAcceptance({
      task_lifecycle: 'awaiting_acceptance',
      contract_criteria: criteria,
      acceptances: [fact({})],
      superseded: [],
      has_outcome: true,
    });
    expect(accepted.target_lifecycle).toBe('accepted');
    expect(accepted.transition).toEqual({
      from: 'awaiting_acceptance',
      to: 'accepted',
      facts: { acceptanceVerdict: 'accepted' },
    });

    const rejected = recomputeAcceptance({
      task_lifecycle: 'awaiting_acceptance',
      contract_criteria: criteria,
      acceptances: [fact({
        verdict: 'rejected',
        criterion_results: [
          { criterion_ref: 'c1', verdict: 'failed' },
          { criterion_ref: 'c2', verdict: 'failed' },
        ],
      })],
      superseded: [],
      has_outcome: true,
    });
    expect(rejected.target_lifecycle).toBe('defined');
    expect(rejected.transition?.facts).toEqual({ acceptanceVerdict: 'rejected' });

    const partial = recomputeAcceptance({
      task_lifecycle: 'awaiting_acceptance',
      contract_criteria: criteria,
      acceptances: [fact({
        verdict: 'partially_accepted',
        criterion_results: [
          { criterion_ref: 'c1', verdict: 'passed' },
          { criterion_ref: 'c2', verdict: 'failed' },
        ],
      })],
      superseded: [],
      has_outcome: true,
    });
    expect(partial.target_lifecycle).toBe('awaiting_acceptance');
    expect(partial.pending_criteria).toEqual(['c2']);
    expect(partial.transition).toBeNull();
  });

  it('无有效 Acceptance 且已有 Outcome → awaiting_acceptance；supersede 后取最新有效记录', () => {
    const noAcceptance = recomputeAcceptance({
      task_lifecycle: 'active',
      contract_criteria: criteria,
      acceptances: [],
      superseded: [],
      has_outcome: true,
    });
    expect(noAcceptance.target_lifecycle).toBe('awaiting_acceptance');
    expect(noAcceptance.transition?.facts).toEqual({ runOutcomeRecorded: true });

    const superseded = recomputeAcceptance({
      task_lifecycle: 'awaiting_acceptance',
      contract_criteria: criteria,
      acceptances: [
        fact({ acceptance_id: 'acc-old', order: 5 }),
        fact({
          acceptance_id: 'acc-new',
          order: 9,
          verdict: 'rejected',
          criterion_results: [
            { criterion_ref: 'c1', verdict: 'failed' },
            { criterion_ref: 'c2', verdict: 'failed' },
          ],
        }),
      ],
      superseded: ['acc-old'],
      has_outcome: true,
    });
    expect(superseded.effective_acceptance_id).toBe('acc-new');
    expect(superseded.target_lifecycle).toBe('defined');
  });

  it('判据级违规：覆盖不完整 / 已过判据回退未 supersede', () => {
    const result = recomputeAcceptance({
      task_lifecycle: 'awaiting_acceptance',
      contract_criteria: ['c1', 'c2', 'c3'],
      acceptances: [
        fact({ acceptance_id: 'acc-old', order: 5 }),
        fact({
          acceptance_id: 'acc-new',
          order: 9,
          verdict: 'rejected',
          criterion_results: [{ criterion_ref: 'c1', verdict: 'failed' }],
        }),
      ],
      superseded: [],
      has_outcome: true,
    });

    expect(result.violations).toContain('coverage_missing:c2');
    expect(result.violations).toContain('coverage_missing:c3');
    expect(result.violations).toContain('inheritance_lock:c1');
  });

  it('命令入口：读取事件流 → accepted 重算 → 经 guard 落 lifecycle 迁移', async () => {
    await seedTaskAtAwaitingAcceptance();
    await recordAcceptance({
      acceptance_id: 'acc-1',
      verdict: 'accepted',
      criteria: [
        { criterion_ref: 'c1', verdict: 'passed' },
        { criterion_ref: 'c2', verdict: 'passed' },
      ],
    });

    const { result, event } = await recomputeTaskAcceptance(store, {
      stream_id: STREAM,
      task_id: TASK_ID,
      contract_criteria: criteria,
      actor_id: 'actor-kernel',
      actor_kind: 'system',
      correlation_id: 'corr-s6',
      causation_id: 'acc-1',
    });

    expect(result.target_lifecycle).toBe('accepted');
    expect(result.effective_acceptance_id).toBe('acc-1');
    expect(event?.type).toBe('TaskLifecycleChanged');
    expect(event?.payload).toMatchObject({ from: 'awaiting_acceptance', to: 'accepted' });
    expect(await currentLifecycle()).toBe('accepted');
    expect((await store.verifyChain(STREAM)).ok).toBe(true);
  });

  it('命令入口：rejected → 回 defined；partially → 不迁移', async () => {
    await seedTaskAtAwaitingAcceptance();
    await recordAcceptance({
      acceptance_id: 'acc-rej',
      verdict: 'rejected',
      criteria: [
        { criterion_ref: 'c1', verdict: 'failed' },
        { criterion_ref: 'c2', verdict: 'failed' },
      ],
    });

    const rejected = await recomputeTaskAcceptance(store, {
      stream_id: STREAM,
      task_id: TASK_ID,
      contract_criteria: criteria,
      actor_id: 'actor-kernel',
      actor_kind: 'system',
      correlation_id: 'corr-s6',
      causation_id: 'acc-rej',
    });
    expect(rejected.result.target_lifecycle).toBe('defined');
    expect(await currentLifecycle()).toBe('defined');
  });

  it('命令入口：AcceptanceSuperseded 后取最新有效记录（supersede 链生效）', async () => {
    await seedTaskAtAwaitingAcceptance();
    await recordAcceptance({
      acceptance_id: 'acc-old',
      verdict: 'accepted',
      criteria: [
        { criterion_ref: 'c1', verdict: 'passed' },
        { criterion_ref: 'c2', verdict: 'passed' },
      ],
    });
    await store.append(base({
      type: 'AcceptanceSuperseded',
      payload: { acceptance_id: 'acc-old', superseded_by: 'acc-new', reason: 'contract_changed' },
    }));
    await recordAcceptance({
      acceptance_id: 'acc-new',
      verdict: 'rejected',
      criteria: [
        { criterion_ref: 'c1', verdict: 'failed' },
        { criterion_ref: 'c2', verdict: 'failed' },
      ],
      supersedes_id: 'acc-old',
    });

    const { result, event } = await recomputeTaskAcceptance(store, {
      stream_id: STREAM,
      task_id: TASK_ID,
      contract_criteria: criteria,
      actor_id: 'actor-kernel',
      actor_kind: 'system',
      correlation_id: 'corr-s6',
      causation_id: 'acc-new',
    });

    expect(result.effective_acceptance_id).toBe('acc-new');
    expect(result.target_lifecycle).toBe('defined');
    expect(event?.type).toBe('TaskLifecycleChanged');
    expect(await currentLifecycle()).toBe('defined');
  });

  it('命令入口：partially_accepted 停在 awaiting_acceptance，待补集来自 failed 判据', async () => {
    await seedTaskAtAwaitingAcceptance();
    await recordAcceptance({
      acceptance_id: 'acc-partial',
      verdict: 'partially_accepted',
      criteria: [
        { criterion_ref: 'c1', verdict: 'passed' },
        { criterion_ref: 'c2', verdict: 'failed' },
      ],
    });

    const partial = await recomputeTaskAcceptance(store, {
      stream_id: STREAM,
      task_id: TASK_ID,
      contract_criteria: criteria,
      actor_id: 'actor-kernel',
      actor_kind: 'system',
      correlation_id: 'corr-s6',
      causation_id: 'acc-partial',
    });

    expect(partial.event).toBeNull();
    expect(partial.result.pending_criteria).toEqual(['c2']);
    expect(await currentLifecycle()).toBe('awaiting_acceptance');
  });
});
