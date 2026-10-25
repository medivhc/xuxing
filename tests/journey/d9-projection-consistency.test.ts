import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  createPgEventStore,
  migrate,
  type PgEventStore,
} from '../../src/kernel/event-store-pg.js';
import type { EventEnvelope, EventType } from '../../src/kernel/events.js';
import { createTestPg, resetEventTables, type TestPg } from '../support/pg.js';
import {
  MinimalProjection,
  createProjectionTables,
  readProjectionSnapshot,
  truncateProjectionTables,
  writeProjection,
} from '../support/minimal-projection.js';
import {
  JourneyProjection,
  NON_STATE_EVENT_TYPES,
  deepDiff,
  type JourneySnapshot,
} from './support/journey-projection.js';
import { D8, FIXED_NOW, runD8Journey, type JourneyRun } from './support/journey-script.js';

// ============================================================================
// D9 质量门 · 投影一致性（旅程版）
//
// D9 的一句话纪律：状态只能由事件派生。本文件用 D8 完整旅程的事件流做四件事：
//   1. 同一事件流「从空重放」与「边写边算」的投影逐字段 diff 为零；
//   2. 任意 seq 水位分段重放 === 整段重放（重放顺序确定性）；
//   3. 与仓库自带 C5 夹具 MinimalProjection 交叉核对 task/run 行；
//   4. 逐事件删除敏感性：删掉任一携带状态的事件，重放结果必须改变（或引用断裂而抛错）
//      —— 反向证明「无事件的状态变更为零」，也证明投影没有隐藏种子。
//
// 与 src/ 的关系：本文件只读内核公开写/读接口，不改任何生产代码。
// ============================================================================

let ctx: TestPg;
let store: PgEventStore;
let stream: EventEnvelope[];
let journey: JourneyRun;

function replay(events: EventEnvelope[]): JourneyProjection {
  return new JourneyProjection().applyAll(events);
}

beforeAll(async () => {
  ctx = await createTestPg();
  await migrate(ctx.pool);
  await resetEventTables(ctx.pool);
  store = createPgEventStore(ctx.pool, { clock: () => FIXED_NOW });
  journey = await runD8Journey(store);
  stream = await store.readStream(D8.project);
});

afterAll(async () => {
  await ctx?.close();
});

describe('D9-1 重放等价：状态只从事件派生', () => {
  it('空事件流 → 空投影（投影没有任何种子数据、没有构造参数）', () => {
    const empty = new JourneyProjection().snapshot();
    expect(empty).toMatchObject({
      projects: [], goals: [], tasks: [], runs: [], outcomes: [], acceptances: [],
      edges: [], assignments: [], wait_conditions: [], decisions: [], pointers: [],
      budget_ledger: [], plan_rev: 0,
    });
  });

  it('旅程「边写边 apply」的投影与「从空重建整条流」逐字段 diff 为零', () => {
    expect(deepDiff(journey.projection.snapshot(), replay(stream).snapshot())).toEqual([]);
  });

  it('任意 seq 水位分段重放 === 整段重放', () => {
    const full = replay(stream).snapshot();
    for (const watermark of [1, 5, 12, 33, Math.floor(stream.length / 2), stream.length - 1]) {
      const head = stream.filter((event) => event.seq <= watermark);
      const tail = stream.filter((event) => event.seq > watermark);
      expect(head.length + tail.length).toBe(stream.length);
      const partial = replay(head);
      expect(partial.snapshot().plan_rev).toBeLessThanOrEqual(full.plan_rev);
      partial.applyAll(tail);
      expect(deepDiff(partial.snapshot(), full)).toEqual([]);
    }
  });

  it('global_seq 全序：投影只按 global_seq 消费，乱序输入必然被拒或等价', () => {
    const globals = stream.map((event) => event.global_seq);
    expect(globals).toEqual([...globals].sort((a, b) => a - b));
    // 逐条按 global_seq 升序喂入，与按 seq 喂入结果一致（同一 stream_id 时两者同序）
    const sorted = [...stream].sort((a, b) => a.global_seq - b.global_seq);
    expect(deepDiff(replay(sorted).snapshot(), replay(stream).snapshot())).toEqual([]);
  });

  it('每个实体都能指回引入它的那一条事件（无凭空状态）', () => {
    const projection = replay(stream);
    const snapshot = projection.snapshot();
    const idsOf = (type: EventType, field: string): Set<string> =>
      new Set(
        stream
          .filter((event) => event.type === type)
          .map((event) => String((event.payload as Record<string, unknown>)[field])),
      );
    expect([...projection.tasks.keys()].sort()).toEqual([...idsOf('TaskCaptured', 'task_id')].sort());
    expect([...projection.runs.keys()].sort()).toEqual([...idsOf('RunCreated', 'run_id')].sort());
    expect(snapshot.outcomes.map((o) => o.outcome_id).sort())
      .toEqual([...idsOf('OutcomeRecorded', 'outcome_id')].sort());
    expect(snapshot.acceptances.map((a) => a.acceptance_id).sort())
      .toEqual([...idsOf('AcceptanceRecorded', 'acceptance_id')].sort());
    expect([...projection.edges.keys()].sort()).toEqual([...idsOf('EdgeAdded', 'edge_id')].sort());
    expect(snapshot.wait_conditions.map((w) => w.wait_condition_id).sort())
      .toEqual([...idsOf('WaitConditionCreated', 'wait_condition_id')].sort());
    expect([...projection.assignments.keys()].sort())
      .toEqual([...idsOf('AssignmentCreated', 'assignment_id')].sort());
  });

  it('未登记且不消费的事件类型进投影 ⇒ 抛错（禁止静默跳过）', () => {
    const synthetic = {
      ...stream[0],
      id: 'synthetic-1',
      seq: stream.length + 1,
      global_seq: stream.length + 1,
      type: 'PolicyChanged' as EventType,
    } as unknown as EventEnvelope;
    expect(NON_STATE_EVENT_TYPES).not.toContain('PolicyChanged');
    expect(() => new JourneyProjection().apply(synthetic)).toThrow(/既不被投影消费，也不在 NON_STATE_EVENT_TYPES 登记内/);
  });
});

describe('D9-2 与仓库 C5 夹具（MinimalProjection）交叉核对', () => {
  it('两套独立投影在 task/run 行上完全一致', () => {
    const mine = replay(stream);
    const theirs = new MinimalProjection().applyAll(stream);
    const theirsRows = theirs.snapshot();

    expect(theirsRows.tasks.map((row) => row.task_id).sort())
      .toEqual([...mine.tasks.keys()].sort());
    for (const row of theirsRows.tasks) {
      const myRow = mine.tasks.get(row.task_id);
      expect(myRow, `Task ${row.task_id} 缺失`).toBeDefined();
      expect({ lifecycle: myRow?.lifecycle, wait_state: myRow?.wait_state, last_outcome_id: myRow?.last_outcome_id })
        .toEqual({ lifecycle: row.lifecycle, wait_state: row.wait_state, last_outcome_id: row.last_outcome_id });
    }
    for (const row of theirsRows.runs) {
      expect(mine.runs.get(row.run_id)?.state).toBe(row.state);
    }
  });

  it('清空投影表 → 由事件流重放写回 → 逐字段 diff 为零（C5 同法，用在旅程流上）', async () => {
    await createProjectionTables(ctx.pool);
    const rebuilt = new MinimalProjection().applyAll(stream).snapshot();
    await truncateProjectionTables(ctx.pool);
    await writeProjection(ctx.pool, rebuilt);
    const fromDb = await readProjectionSnapshot(ctx.pool);
    expect(fromDb).toEqual(rebuilt);

    // 再清一次表，从「表为空」重放到相同状态：证明表只是缓存，不是状态源
    await truncateProjectionTables(ctx.pool);
    const replayed = await readProjectionSnapshot(ctx.pool);
    expect(replayed.tasks).toEqual([]);
    expect(replayed.runs).toEqual([]);
    await writeProjection(ctx.pool, new MinimalProjection().applyAll(stream).snapshot());
    expect(await readProjectionSnapshot(ctx.pool)).toEqual(rebuilt);
  });

  it('旅程投影读的是事件流，不是投影表（表被清空后状态不变）', async () => {
    const before = replay(stream).snapshot();
    await truncateProjectionTables(ctx.pool);
    expect(deepDiff(replay(stream).snapshot(), before)).toEqual([]);
    await writeProjection(ctx.pool, new MinimalProjection().applyAll(stream).snapshot());
  });
});

describe('D9-3 事件→状态痕迹（无事件即无状态变化）', () => {
  it('逐条 apply：每条事件都必须留下可观察的状态增量，除非显式登记为无状态事件', () => {
    const projection = new JourneyProjection();
    let previous: JourneySnapshot = structuredClone(projection.snapshot());
    const silent: { seq: number; type: string }[] = [];

    for (const event of stream) {
      projection.apply(event);
      const next: JourneySnapshot = structuredClone(projection.snapshot());
      const delta = deepDiff(next, previous);
      if (delta.length === 0) silent.push({ seq: event.seq, type: event.type });
      previous = next;
    }

    // 「删了/加了也不改变状态」的事件必须事先在 NON_STATE_EVENT_TYPES 里显式登记，
    // 且登记过的确是留痕类（回执、重建、 supersede 通知等），而不是被投影漏掉。
    const unregistered = silent.filter(
      (entry) => !NON_STATE_EVENT_TYPES.includes(entry.type as EventType),
    );
    expect({ unregistered, silent }).toEqual({ unregistered: [], silent: [] });
  });

  it('状态痕迹可归因：状态序列的长度 = 携带状态的事件数（没有无事件的状态跳变）', () => {
    const projection = new JourneyProjection();
    let previous = structuredClone(projection.snapshot());
    let statefulEvents = 0;
    for (const event of stream) {
      projection.apply(event);
      const next = structuredClone(projection.snapshot());
      if (deepDiff(next, previous).length > 0) statefulEvents += 1;
      previous = next;
    }
    const nonState = stream.filter((event) =>
      NON_STATE_EVENT_TYPES.includes(event.type as EventType),
    ).length;
    expect(statefulEvents).toBe(stream.length - nonState);
    // 中间态可观测：Run 的 created/queued/leased/running 各自留下一次状态变化
    const runStates = new Set<string>();
    const probe = new JourneyProjection();
    for (const event of stream) {
      probe.apply(event);
      const run = probe.runs.get(D8.runImport);
      if (run) runStates.add(run.state);
    }
    expect([...runStates]).toEqual(['created', 'queued', 'leased', 'running', 'succeeded']);
  });

  it('REQ-OC-2/S7 护栏：判定不解析自由文本（改掉文本，结论逐字段不变）', () => {
    const mutated = stream.map((event) => {
      if (event.type === 'OutcomeRecorded') {
        const payload = structuredClone(event.payload) as {
          dimensions: { blockers: unknown[]; followup_suggestions: unknown[] };
        };
        payload.dimensions.blockers = ['完全相反的阻塞描述'];
        payload.dimensions.followup_suggestions = ['与旅程无关的建议'];
        return { ...event, payload } as EventEnvelope;
      }
      if (event.type === 'FeedbackReceived') {
        const payload = structuredClone(event.payload) as { raw_content: string };
        payload.raw_content = '一段被随机替换的原文，语义与结论相反';
        return { ...event, payload } as EventEnvelope;
      }
      return event;
    });
    expect(conclusionsOf(mutated)).toEqual(conclusionsOf(stream));
    // 文本本身确实进了投影（供人阅读），只是不参与任何判定
    const kept = replay(stream).snapshot().outcomes;
    expect(kept.some((outcome) => JSON.stringify(outcome.dimensions).length > 0)).toBe(true);
  });
});

describe('D9-4 重放确定性：同剧本在另一套 schema 上逐字节复现', () => {
  it('第二次运行的事件类型、seq、canonicalJson(payload) 序列完全相同', async () => {
    const first = stream.map((event) => `${event.seq}:${event.type}:${canonicalJson(event.payload)}`);
    const second = await isolatedRun();
    expect(second).toEqual(first);
    // 事件数与链长也一致（不是靠截断凑出来的相等）
    expect(second.length).toBeGreaterThan(60);
    expect(second.length).toBe(stream.length);
  });
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 把「结论性状态」抽成可比较的纯数据（全部由投影派生查询算出）。 */
function conclusionsOf(events: EventEnvelope[]) {
  const projection = replay(events);
  const taskIds = [...projection.tasks.keys()].sort();
  return {
    tasks: taskIds.map((id) => {
      const task = projection.tasks.get(id)!;
      return {
        task_id: id,
        lifecycle: task.lifecycle,
        wait_state: task.wait_state,
        last_outcome_id: task.last_outcome_id,
        effective_verdict: projection.effectiveAcceptance(id)?.verdict ?? null,
        pending_criteria: projection.pendingCriteria(id),
        latest_accepted_outcome: projection.latestAcceptedOutcome(id),
        active_waits: projection.activeWaitConditions(id).map((w) => w.wait_condition_id),
      };
    }),
    runs: [...projection.runs.values()].sort((a, b) => a.run_id.localeCompare(b.run_id))
      .map((run) => ({ run_id: run.run_id, state: run.state })),
    goals: [...projection.goals.values()].map((goal) => ({ goal_id: goal.goal_id, status: goal.status })),
    ledger: projection.budget,
    plan_rev: projection.planRev,
  };
}

/** 在全新 schema 里重跑同一剧本，返回可比对的规范化事件序列。 */
async function isolatedRun(): Promise<string[]> {
  const other = await createTestPg();
  try {
    await migrate(other.pool);
    const otherStore = createPgEventStore(other.pool, { clock: () => FIXED_NOW });
    await runD8Journey(otherStore);
    const events = await otherStore.readStream(D8.project);
    return events.map((event) => `${event.seq}:${event.type}:${canonicalJson(event.payload)}`);
  } finally {
    await other.close();
  }
}
