import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { asProjectId, type EventType } from '../src/kernel/events.js';
import {
  EventEntityMismatchError,
  TransitionDeniedError,
  createPgEventStore,
  migrate,
  type AppendBatchEntryInput,
  type PgEventStore,
} from '../src/kernel/event-store-pg.js';
import {
  RunAlreadyCreatedError,
  RunDispatchError,
  appendRunCreated,
  appendRunTransition,
  type RunKind,
} from '../src/kernel/run-events.js';
import { guardTransition } from '../src/kernel/transition-guard.js';
import { createTestPg, resetEventTables, type TestPg } from './support/pg.js';

// ============================================================================
// S3-①：Run 事件派发的守卫接线（命令层封装 + 可审计的「绕过即红」）
// S3-③：EventEntityMismatchError 的建议不得指向死路
// ============================================================================

const FIXED_NOW = new Date('2026-10-24T00:00:00.000Z');
const STREAM = asProjectId('project-run-wiring');
const TASK_ID = 'task-rw';
const RUN_ID = 'run-rw';

/** 唯一允许直写 Run* 事件的模块（RunCreated 的创建校验入口）。 */
const RUN_WRITER = 'src/kernel/run-events.ts';

interface Violation {
  file: string;
  line: number;
  method: string;
  type: string;
}

/**
 * 审计器：`.append(...)` / `.appendBatch(...)` 里出现 `type: 'Run*'` 字面量即违规。
 * 用 TypeScript AST 而非 grep：新增代码只要写成直调 append 就会被抓到，不依赖格式。
 */
export function findRunAppendViolations(source: string, file: string): Violation[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const violations: Violation[] = [];

  const typesInExpression = (node: ts.Expression): string[] => {
    const found: string[] = [];
    const visit = (child: ts.Node): void => {
      if (ts.isPropertyAssignment(child) && ts.isIdentifier(child.name) && child.name.text === 'type') {
        if (ts.isStringLiteralLike(child.initializer)) found.push(child.initializer.text);
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'append' || node.expression.name.text === 'appendBatch')
    ) {
      const first = node.arguments[0];
      if (first !== undefined) {
        for (const type of typesInExpression(first)) {
          if (!type.startsWith('Run')) continue;
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          violations.push({
            file,
            line: line + 1,
            method: node.expression.name.text,
            type,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return violations;
}

function listTsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}

describe('S3-① 审计：src/ 与 server/src/ 不得直调 append 写 Run* 事件', () => {
  it('真实源码扫描：除 run-events.ts 外零违规', () => {
    const repoRoot = process.cwd();
    const files = [
      ...listTsFiles(join(repoRoot, 'src')),
      ...listTsFiles(join(repoRoot, 'server', 'src')),
    ];
    const violations = files.flatMap((file) => {
      const rel = relative(repoRoot, file).split('\\').join('/');
      if (rel === RUN_WRITER) return [];
      return findRunAppendViolations(readFileSync(file, 'utf8'), rel);
    });
    expect(violations).toEqual([]);
  });

  it('审计器本身有效：直调 append 写 Run 事件会被抓到（绕过即红）', () => {
    const bad = [
      "async function oops(tx: any) {",
      "  return tx.append({ type: 'RunStarted', payload: {} });",
      "}",
    ].join('\n');
    expect(findRunAppendViolations(bad, 'server/src/commands/oops.ts')).toEqual([
      { file: 'server/src/commands/oops.ts', line: 2, method: 'append', type: 'RunStarted' },
    ]);

    const batchBad = "tx.appendBatch([{ type: 'RunCanceled' }]);";
    expect(findRunAppendViolations(batchBad, 'x.ts')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 入口语义（真 PG16）
// ---------------------------------------------------------------------------

function base(
  overrides: Partial<AppendBatchEntryInput> & { run_kind?: RunKind } = {},
): AppendBatchEntryInput & { run_kind?: RunKind } {
  return {
    stream_id: STREAM,
    type: 'TaskCaptured',
    actor_id: 'actor-human-1',
    actor_kind: 'human',
    causation_id: null,
    correlation_id: 'corr-rw',
    idempotency_key: null,
    payload: { task_id: TASK_ID, title: 'Run 接线任务' },
    ...overrides,
  };
}

let ctx: TestPg;
let store: PgEventStore;

async function seedProjectAndTask(): Promise<void> {
  await store.append(base({
    type: 'ProjectCreated',
    payload: { name: 'Run 接线项目', created_by: 'actor-human-1' },
  }));
  await store.append(base());
}

async function createRun(run_kind: 'executor' | 'human_light' = 'human_light'): Promise<void> {
  await store.withTransaction(async (tx) => {
    await appendRunCreated(tx, base({
      type: 'RunCreated',
      run_kind,
      payload: { run_id: RUN_ID, task_id: TASK_ID, run_kind },
    }));
  });
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

describe('S3-① appendRunCreated / appendRunTransition', () => {
  it('RunCreated 必须经 appendRunCreated：重复创建同一个 run_id → RunAlreadyCreatedError', async () => {
    await seedProjectAndTask();
    await createRun();
    await expect(createRun()).rejects.toBeInstanceOf(RunAlreadyCreatedError);
  });

  it('run_kind 入参与 payload 不一致 → RunDispatchError（不静默择一）', async () => {
    await seedProjectAndTask();
    await expect(
      store.withTransaction((tx) => appendRunCreated(tx, base({
        type: 'RunCreated',
        run_kind: 'executor',
        payload: { run_id: RUN_ID, run_kind: 'human_light' },
      }))),
    ).rejects.toBeInstanceOf(RunDispatchError);
  });

  it('事件类型与目标状态错配 → RunDispatchError，零写入', async () => {
    await seedProjectAndTask();
    await createRun();
    const before = (await store.readStream(STREAM)).length;

    await expect(
      store.withTransaction((tx) => appendRunTransition(tx, {
        ...base(),
        type: 'RunStarted',
        entity: 'run',
        from: 'created',
        to: 'succeeded',
        payload: { run_id: RUN_ID },
      })),
    ).rejects.toBeInstanceOf(RunDispatchError);

    expect((await store.readStream(STREAM)).length).toBe(before);
  });

  it('非 Run 事件不得走 appendRunTransition', async () => {
    await expect(
      store.withTransaction((tx) => appendRunTransition(tx, {
        ...base(),
        type: 'TaskLifecycleChanged',
        entity: 'run',
        from: 'created',
        to: 'queued',
        payload: { run_id: RUN_ID },
      })),
    ).rejects.toBeInstanceOf(RunDispatchError);
  });

  it('human_light：created→running→succeeded 全部经守卫入口，链完整', async () => {
    await seedProjectAndTask();
    await createRun('human_light');

    const started = await store.withTransaction((tx) => appendRunTransition(tx, {
      ...base(),
      type: 'RunStarted',
      entity: 'run',
      from: 'created',
      to: 'running',
      payload: { run_id: RUN_ID, started_by: 'actor-human-1' },
    }));
    expect(started.event.type).toBe('RunStarted');

    const succeeded = await store.withTransaction((tx) => appendRunTransition(tx, {
      ...base(),
      type: 'RunSucceeded',
      entity: 'run',
      from: 'running',
      to: 'succeeded',
      payload: { run_id: RUN_ID, outcome_id: 'out-1' },
    }));
    expect(succeeded.event.type).toBe('RunSucceeded');
    expect((await store.verifyChain(STREAM)).ok).toBe(true);
  });

  it('human_light 不进 indeterminate/timed_out/leased（REQ-HUM-1）→ guard 拒绝', async () => {
    await seedProjectAndTask();
    await createRun('human_light');

    for (const [type, to] of [
      ['RunIndeterminate', 'indeterminate'],
      ['RunTimedOut', 'timed_out'],
      ['RunLeased', 'leased'],
    ] as const) {
      await expect(
        store.withTransaction((tx) => appendRunTransition(tx, {
          ...base(),
          type: type as EventType,
          entity: 'run',
          from: 'created',
          to,
          payload: { run_id: RUN_ID },
        })),
      ).rejects.toBeInstanceOf(TransitionDeniedError);
    }
  });

  it('executor：created→running 仍按 §3.2 拒绝（run_kind 是事件流派生，不是调用方可选）', async () => {
    await seedProjectAndTask();
    await createRun('executor');

    await expect(
      store.withTransaction((tx) => appendRunTransition(tx, {
        ...base(),
        type: 'RunStarted',
        entity: 'run',
        from: 'created',
        to: 'running',
        payload: { run_id: RUN_ID },
      })),
    ).rejects.toSatisfy((error: unknown) => {
      // guard 拒绝（run_kind 从 RunCreated 派生为 executor）
      expect((error as Error).name).toBe('TransitionDeniedError');
      return true;
    });
  });
});

describe('S3-③ EventEntityMismatchError 的建议不是死路', () => {
  it('task 配 wait_state 事件：建议指向 append/requestTaskCancellation，而不仅 TaskLifecycleChanged', async () => {
    await seedProjectAndTask();
    const error = await store.withTransaction((tx) => tx.appendStateTransition({
      ...base(),
      type: 'TaskWaitStateChanged',
      entity: 'task',
      from: 'none',
      to: 'waiting_on_person',
      payload: {
        task_id: TASK_ID, from: 'none', to: 'waiting_on_person', reason: 'x',
        actor_id: 'actor-human-1', actor_kind: 'human',
      },
    })).catch((caught: unknown) => caught as EventEntityMismatchError);

    expect(error).toBeInstanceOf(EventEntityMismatchError);
    const message = (error as EventEntityMismatchError).message;
    expect(message).toContain('append');
    expect(message).toContain('TaskWaitStateChanged');
    expect(message).toContain('requestTaskCancellation');
  });

  it('run 配 task 事件：建议指向 appendRunTransition / appendRunCreated', () => {
    const message = new EventEntityMismatchError('run', 'TaskLifecycleChanged').message;
    expect(message).toContain('appendRunTransition');
    expect(message).toContain('appendRunCreated');
  });
});
