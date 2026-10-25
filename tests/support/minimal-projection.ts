// ⚠️ 仅测试用夹具（Q3 裁决）：这是 C5 的「最小测试投影」，**不是生产投影**。
// 生产投影（Home / MyActions / Project 三投影、available_actions 计算）不在本批范围，
// 本文件只求确定性地证明「投影清空后可由事件流按 global_seq 重演重建，逐字段 diff 为零」。
//
// 设计约束：
// - 只消费事件信封（不读事件表），因此 replay() 与 readStream() 两条读路径都能驱动它；
// - 遇到的引用缺失（task/run 不存在）立即抛错，不静默跳过 —— 否则 diff 为零毫无意义；
// - 输出行按主键排序，字段清单显式枚举，diff 逐字段比较而不是比 JSON 字符串。

import type { Pool } from 'pg';
import type { EventEnvelope } from '../../src/kernel/events.js';

export interface ProjectionTaskRow {
  project_id: string;
  task_id: string;
  lifecycle: string;
  wait_state: string;
  last_outcome_id: string | null;
  updated_global_seq: number;
}

export interface ProjectionRunRow {
  project_id: string;
  run_id: string;
  task_id: string;
  state: string;
  updated_global_seq: number;
}

export interface ProjectionSnapshot {
  tasks: ProjectionTaskRow[];
  runs: ProjectionRunRow[];
}

const TASK_FIELDS: Array<keyof ProjectionTaskRow> = [
  'project_id', 'task_id', 'lifecycle', 'wait_state', 'last_outcome_id', 'updated_global_seq',
];

const RUN_FIELDS: Array<keyof ProjectionRunRow> = [
  'project_id', 'run_id', 'task_id', 'state', 'updated_global_seq',
];

const RUN_STATE_BY_EVENT: Record<string, string> = {
  RunCreated: 'created',
  RunQueued: 'queued',
  RunLeased: 'leased',
  RunStarted: 'running',
  RunSucceeded: 'succeeded',
  RunFailed: 'failed',
  RunCanceled: 'canceled',
  RunTimedOut: 'timed_out',
  RunIndeterminate: 'indeterminate',
};

function requireString(payload: unknown, field: string, event: EventEnvelope): string {
  const value = (payload as Record<string, unknown> | null)?.[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${event.type}@${event.global_seq} 缺少 ${field}`);
  }
  return value;
}

export class MinimalProjection {
  private readonly tasks = new Map<string, ProjectionTaskRow>();
  private readonly runs = new Map<string, ProjectionRunRow>();

  apply(event: EventEnvelope): void {
    const project_id = event.stream_id;

    switch (event.type) {
      case 'TaskCaptured': {
        const task_id = requireString(event.payload, 'task_id', event);
        this.tasks.set(task_id, {
          project_id,
          task_id,
          lifecycle: 'captured',
          wait_state: 'none',
          last_outcome_id: null,
          updated_global_seq: event.global_seq,
        });
        return;
      }
      case 'TaskLifecycleChanged': {
        const task_id = requireString(event.payload, 'task_id', event);
        const from = requireString(event.payload, 'from', event);
        const to = requireString(event.payload, 'to', event);
        const task = this.mustTask(project_id, task_id, event);
        if (task.lifecycle !== from) {
          throw new Error(
            `TaskLifecycleChanged@${event.global_seq} 投影态不一致：期望 ${from}，实际 ${task.lifecycle}`,
          );
        }
        task.lifecycle = to;
        task.updated_global_seq = event.global_seq;
        return;
      }
      case 'TaskWaitStateChanged': {
        const task_id = requireString(event.payload, 'task_id', event);
        const from = requireString(event.payload, 'from', event);
        const to = requireString(event.payload, 'to', event);
        const task = this.mustTask(project_id, task_id, event);
        if (task.wait_state !== from) {
          throw new Error(
            `TaskWaitStateChanged@${event.global_seq} 投影态不一致：期望 ${from}，实际 ${task.wait_state}`,
          );
        }
        task.wait_state = to;
        task.updated_global_seq = event.global_seq;
        return;
      }
      case 'OutcomeRecorded': {
        const task_id = requireString(event.payload, 'task_id', event);
        const outcome_id = requireString(event.payload, 'outcome_id', event);
        const task = this.mustTask(project_id, task_id, event);
        task.last_outcome_id = outcome_id;
        task.updated_global_seq = event.global_seq;
        return;
      }
      default: {
        const nextState = RUN_STATE_BY_EVENT[event.type];
        if (nextState === undefined) return; // 本夹具不消费的事件类型
        const run_id = requireString(event.payload, 'run_id', event);
        if (event.type === 'RunCreated') {
          const task_id = requireString(event.payload, 'task_id', event);
          this.mustTask(project_id, task_id, event);
          this.runs.set(run_id, {
            project_id,
            run_id,
            task_id,
            state: 'created',
            updated_global_seq: event.global_seq,
          });
          return;
        }
        const run = this.runs.get(run_id);
        if (!run || run.project_id !== project_id) {
          throw new Error(`${event.type}@${event.global_seq} 引用了不存在的 Run ${run_id}`);
        }
        run.state = nextState;
        run.updated_global_seq = event.global_seq;
        return;
      }
    }
  }

  applyAll(events: EventEnvelope[]): this {
    for (const event of events) this.apply(event);
    return this;
  }

  snapshot(): ProjectionSnapshot {
    return {
      tasks: [...this.tasks.values()]
        .map((row) => ({ ...row }))
        .sort((a, b) => (a.project_id + a.task_id).localeCompare(b.project_id + b.task_id)),
      runs: [...this.runs.values()]
        .map((row) => ({ ...row }))
        .sort((a, b) => (a.project_id + a.run_id).localeCompare(b.project_id + b.run_id)),
    };
  }

  private mustTask(project_id: string, task_id: string, event: EventEnvelope): ProjectionTaskRow {
    const task = this.tasks.get(task_id);
    if (!task || task.project_id !== project_id) {
      throw new Error(`${event.type}@${event.global_seq} 引用了不存在的 Task ${task_id}`);
    }
    return task;
  }
}

// ---------------------------------------------------------------------------
// 投影表（本夹具专用；与生产表无关）
// ---------------------------------------------------------------------------

export async function createProjectionTables(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS test_proj_tasks (
      project_id         text   NOT NULL,
      task_id            text   NOT NULL,
      lifecycle          text   NOT NULL,
      wait_state         text   NOT NULL,
      last_outcome_id    text,
      updated_global_seq bigint NOT NULL,
      PRIMARY KEY (project_id, task_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS test_proj_runs (
      project_id         text   NOT NULL,
      run_id             text   NOT NULL,
      task_id            text   NOT NULL,
      state              text   NOT NULL,
      updated_global_seq bigint NOT NULL,
      PRIMARY KEY (project_id, run_id)
    )`);
}

export async function truncateProjectionTables(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE test_proj_tasks, test_proj_runs');
}

export async function writeProjection(pool: Pool, snapshot: ProjectionSnapshot): Promise<void> {
  for (const row of snapshot.tasks) {
    await pool.query(
      `INSERT INTO test_proj_tasks
        (project_id, task_id, lifecycle, wait_state, last_outcome_id, updated_global_seq)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        row.project_id, row.task_id, row.lifecycle, row.wait_state,
        row.last_outcome_id, row.updated_global_seq,
      ],
    );
  }
  for (const row of snapshot.runs) {
    await pool.query(
      `INSERT INTO test_proj_runs
        (project_id, run_id, task_id, state, updated_global_seq)
       VALUES ($1,$2,$3,$4,$5)`,
      [row.project_id, row.run_id, row.task_id, row.state, row.updated_global_seq],
    );
  }
}

interface TaskDbRow {
  project_id: string;
  task_id: string;
  lifecycle: string;
  wait_state: string;
  last_outcome_id: string | null;
  updated_global_seq: string;
}

interface RunDbRow {
  project_id: string;
  run_id: string;
  task_id: string;
  state: string;
  updated_global_seq: string;
}

/** 从投影表读快照（显式列清单、显式排序，bigint 转 Number 并校验安全整数）。 */
export async function readProjectionSnapshot(pool: Pool): Promise<ProjectionSnapshot> {
  const tasks = await pool.query<TaskDbRow>(
    `SELECT project_id, task_id, lifecycle, wait_state, last_outcome_id, updated_global_seq
     FROM test_proj_tasks ORDER BY project_id, task_id`,
  );
  const runs = await pool.query<RunDbRow>(
    `SELECT project_id, run_id, task_id, state, updated_global_seq
     FROM test_proj_runs ORDER BY project_id, run_id`,
  );

  const toSafe = (raw: string): number => {
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) throw new Error(`投影 bigint 越界：${raw}`);
    return n;
  };

  return {
    tasks: tasks.rows.map((row) => ({
      project_id: row.project_id,
      task_id: row.task_id,
      lifecycle: row.lifecycle,
      wait_state: row.wait_state,
      last_outcome_id: row.last_outcome_id,
      updated_global_seq: toSafe(row.updated_global_seq),
    })),
    runs: runs.rows.map((row) => ({
      project_id: row.project_id,
      run_id: row.run_id,
      task_id: row.task_id,
      state: row.state,
      updated_global_seq: toSafe(row.updated_global_seq),
    })),
  };
}

// ---------------------------------------------------------------------------
// 逐字段 diff（显式列清单，不比较 JSON 字符串整体）
// ---------------------------------------------------------------------------

export function diffSnapshots(left: ProjectionSnapshot, right: ProjectionSnapshot): string[] {
  const diffs: string[] = [];

  const diffRows = <T extends object>(
    table: 'tasks' | 'runs',
    a: T[],
    b: T[],
    keyOf: (row: T) => string,
    fields: Array<keyof T>,
  ): void => {
    const aMap = new Map(a.map((row) => [keyOf(row), row]));
    const bMap = new Map(b.map((row) => [keyOf(row), row]));

    for (const key of new Set([...aMap.keys(), ...bMap.keys()])) {
      const leftRow = aMap.get(key);
      const rightRow = bMap.get(key);
      if (!leftRow || !rightRow) {
        diffs.push(`${table}[${key}] 行缺失：left=${Boolean(leftRow)} right=${Boolean(rightRow)}`);
        continue;
      }
      for (const field of fields) {
        if (leftRow[field] !== rightRow[field]) {
          diffs.push(
            `${table}[${key}].${String(field)}: ${String(leftRow[field])} ≠ ${String(rightRow[field])}`,
          );
        }
      }
    }
  };

  diffRows('tasks', left.tasks, right.tasks, (r) => `${r.project_id}/${r.task_id}`, TASK_FIELDS);
  diffRows('runs', left.runs, right.runs, (r) => `${r.project_id}/${r.run_id}`, RUN_FIELDS);

  return diffs;
}
