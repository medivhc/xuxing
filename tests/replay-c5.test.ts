import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate, createPgEventStore, type PgEventStore } from '../src/kernel/event-store-pg.js';
import type { EventType } from '../src/kernel/events.js';
import { createTestPg, resetEventTables, type TestPg } from './support/pg.js';
import {
  MinimalProjection,
  createProjectionTables,
  diffSnapshots,
  readProjectionSnapshot,
  truncateProjectionTables,
  writeProjection,
} from './support/minimal-projection.js';

// ============================================================================
// C5（spec §8.2 / INV-12）：任一投影表清空后由事件流重演重建，与重建前逐字段 diff 为零。
// 投影 = tests/support/minimal-projection.ts（最小测试夹具，非生产投影，Q3 裁决）。
// ============================================================================

const FIXED_NOW = new Date('2026-10-21T00:00:00.000Z');
const PROJECTS = ['proj-alpha', 'proj-beta'] as const;

let ctx: TestPg;
let store: PgEventStore;

function input(
  stream_id: string,
  type: EventType,
  payload: unknown,
  extra: Partial<{ idempotency_key: string | null; causation_id: string | null }> = {},
) {
  return {
    stream_id,
    type,
    actor_id: 'actor-human-1',
    actor_kind: 'human' as const,
    causation_id: extra.causation_id ?? null,
    correlation_id: 'c5-correlation',
    idempotency_key: extra.idempotency_key ?? null,
    payload,
  };
}

/** 跨 2 个 project 投 ~30 条事件（lifecycle / wait_state / run / outcome 全覆盖）。 */
async function seedThirtyEvents(): Promise<void> {
  for (const project of PROJECTS) {
    const task_id = `task-${project}`;
    const run1 = `run-1-${project}`;
    const run2 = `run-2-${project}`;

    await store.append(input(project, 'TaskCaptured', { task_id, title: `任务 ${project}` }));
    await store.append(input(project, 'TaskLifecycleChanged', {
      task_id, from: 'captured', to: 'defined',
    }));
    await store.append(input(project, 'TaskLifecycleChanged', {
      task_id, from: 'defined', to: 'ready',
    }));
    await store.append(input(project, 'TaskLifecycleChanged', {
      task_id, from: 'ready', to: 'active',
    }));

    await store.append(input(project, 'RunCreated', { run_id: run1, task_id }));
    await store.append(input(project, 'RunQueued', { run_id: run1 }));
    await store.append(input(project, 'RunLeased', { run_id: run1 }));
    await store.append(input(project, 'RunStarted', { run_id: run1 }));
    await store.append(input(project, 'RunSucceeded', { run_id: run1 }));

    await store.append(input(project, 'TaskWaitStateChanged', {
      task_id, from: 'none', to: 'waiting_on_person', reason: '等待对方回复',
    }));
    await store.append(input(project, 'TaskWaitStateChanged', {
      task_id, from: 'waiting_on_person', to: 'none', reason: '已回复',
    }));

    await store.append(input(project, 'OutcomeRecorded', {
      task_id, outcome_id: `outcome-${project}`, conclusion_kind: 'no_response',
    }));

    await store.append(input(project, 'TaskLifecycleChanged', {
      task_id, from: 'active', to: 'awaiting_acceptance',
    }));

    await store.append(input(project, 'RunCreated', { run_id: run2, task_id }));
    await store.append(input(project, 'RunQueued', { run_id: run2 }));
  }
}

async function rebuildFromReplay(): Promise<MinimalProjection> {
  const projection = new MinimalProjection();
  projection.applyAll(await store.replay(0));
  return projection;
}

beforeAll(async () => {
  ctx = await createTestPg();
  await migrate(ctx.pool);
  await createProjectionTables(ctx.pool);
  store = createPgEventStore(ctx.pool, { clock: () => FIXED_NOW });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetEventTables(ctx.pool);
  await truncateProjectionTables(ctx.pool);
});

describe('C5：投影清空 → replay(0) 全量重演 → 逐字段 diff 为零', () => {
  it('事件流实时投影 vs 清空后重演投影，diff 为空', async () => {
    await seedThirtyEvents();

    // 1) 实时投影（第一次构建）并落表
    const live = await rebuildFromReplay();
    await writeProjection(ctx.pool, live.snapshot());
    const before = await readProjectionSnapshot(ctx.pool);

    expect(before.tasks).toHaveLength(PROJECTS.length);
    expect(before.runs).toHaveLength(PROJECTS.length * 2);
    for (const task of before.tasks) {
      expect(task.lifecycle).toBe('awaiting_acceptance');
      expect(task.wait_state).toBe('none');
      expect(task.last_outcome_id).toBe(`outcome-${task.project_id}`);
    }
    for (const run of before.runs) {
      // 每个 project 有两个 Run：run-1 已成功，run-2 仍在队列
      expect(run.state).toBe(run.run_id.startsWith('run-1-') ? 'succeeded' : 'queued');
    }

    // 2) 清空投影表（只清投影，事件流不动）
    await truncateProjectionTables(ctx.pool);
    expect((await readProjectionSnapshot(ctx.pool)).tasks).toHaveLength(0);
    expect((await readProjectionSnapshot(ctx.pool)).runs).toHaveLength(0);

    // 3) 全新 reducer 从事件流重演并重建投影表
    const replayed = await rebuildFromReplay();
    await writeProjection(ctx.pool, replayed.snapshot());
    const after = await readProjectionSnapshot(ctx.pool);

    // 4) 逐字段 diff（显式列清单）必须为空
    const diffs = diffSnapshots(before, after);
    expect(diffs).toEqual([]);
    expect(after).toEqual(before);
  });

  it('replay 返回的 global_seq 严格升序（INV-12：投影按 global_seq 重演）', async () => {
    await seedThirtyEvents();
    const events = await store.replay(0);
    expect(events).toHaveLength(30);

    const globals = events.map((event) => event.global_seq);
    expect(globals).toEqual([...globals].sort((a, b) => a - b));
    expect(new Set(globals).size).toBe(globals.length);
  });

  it('单流 readStream 重建的投影与全量重演中该 project 的行逐字段一致', async () => {
    await seedThirtyEvents();
    const full = (await rebuildFromReplay()).snapshot();

    for (const project of PROJECTS) {
      const single = new MinimalProjection().applyAll(await store.readStream(project));
      const snapshot = single.snapshot();
      expect(diffSnapshots(
        { tasks: snapshot.tasks, runs: snapshot.runs },
        {
          tasks: full.tasks.filter((task) => task.project_id === project),
          runs: full.runs.filter((run) => run.project_id === project),
        },
      )).toEqual([]);
    }
  });

  it('重演是确定性的：连续两次重演结果相同（含 updated_global_seq 水位）', async () => {
    await seedThirtyEvents();
    const first = (await rebuildFromReplay()).snapshot();
    const second = (await rebuildFromReplay()).snapshot();
    expect(diffSnapshots(first, second)).toEqual([]);
  });

  it('投影重演不依赖投影表旧值：清空前后事件流字节未变（verifyChain 仍绿）', async () => {
    await seedThirtyEvents();
    for (const project of PROJECTS) {
      const verification = await store.verifyChain(project);
      expect(verification.ok).toBe(true);
      expect(verification.length).toBe(15);
    }
    await truncateProjectionTables(ctx.pool);
    for (const project of PROJECTS) {
      expect((await store.verifyChain(project)).ok).toBe(true);
    }
  });
});
