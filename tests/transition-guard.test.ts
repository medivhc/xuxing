import { describe, expect, it } from 'vitest';
import {
  TASK_STATES,
  TASK_WAIT_STATES,
  RUN_STATES,
  WAIT_STATE_BY_CONDITION_KIND,
  guardTransition,
  guardWaitStateChange,
  type GuardFacts,
} from '../src/kernel/transition-guard.js';

// ============================================================================
// 本文件按 spec/K0-SPEC-FROZEN-v1.0.md §3.1 / §3.2 表格**独立转录**期望矩阵。
// 与 src/kernel/transition-guard.ts 内的实现表分开抄写：任何一格分歧必红。
// 计数元测试（§3.1 42 格/允许 14；§3.2 72 格/允许 17）防止漏格或多格。
// ============================================================================

type Cell = '✓' | '–';
type TaskState =
  | 'captured' | 'defined' | 'ready' | 'active'
  | 'awaiting_acceptance' | 'accepted' | 'canceled';
type RunState =
  | 'created' | 'queued' | 'leased' | 'running' | 'succeeded'
  | 'failed' | 'canceled' | 'timed_out' | 'indeterminate';

// spec §3.1 表头：列
const TASK_COLS: TaskState[] = [
  'defined', 'ready', 'active', 'awaiting_acceptance', 'accepted', 'canceled',
];

// spec §3.1 逐行转录（行=当前，列=目标）。defined 行第一格是「自环：契约/文本修订，不算迁移」。
const TASK_ROWS: Array<[TaskState, Cell[]]> = [
  ['captured',            ['✓', '–', '–', '–', '–', '✓']],
  ['defined',             ['–', '✓', '–', '–', '–', '✓']],
  ['ready',               ['✓', '–', '✓', '–', '–', '✓']],
  ['active',              ['–', '–', '–', '✓', '–', '✓']],
  ['awaiting_acceptance', ['✓', '–', '✓', '–', '✓', '✓']],
  ['accepted',            ['–', '–', '–', '✓', '–', '–']],
  ['canceled',            ['–', '–', '–', '–', '–', '–']],
];

// spec §3.2 表头：列
const RUN_COLS: RunState[] = [
  'queued', 'leased', 'running', 'succeeded', 'failed', 'canceled', 'timed_out', 'indeterminate',
];

// spec §3.2 逐行转录；终态行（succeeded/failed/canceled/timed_out）展开为 4×8=32 格全 –。
const RUN_ROWS: Array<[RunState, Cell[]]> = [
  ['created',       ['✓', '–', '–', '–', '–', '✓', '–', '–']],
  ['queued',        ['–', '✓', '–', '–', '–', '✓', '–', '–']],
  ['leased',        ['✓', '–', '✓', '–', '✓', '✓', '–', '✓']],
  ['running',       ['–', '–', '–', '✓', '✓', '✓', '✓', '✓']],
  ['indeterminate', ['–', '–', '–', '✓', '✓', '✓', '–', '–']],
  ['succeeded',     ['–', '–', '–', '–', '–', '–', '–', '–']],
  ['failed',        ['–', '–', '–', '–', '–', '–', '–', '–']],
  ['canceled',      ['–', '–', '–', '–', '–', '–', '–', '–']],
  ['timed_out',     ['–', '–', '–', '–', '–', '–', '–', '–']],
];

// 满足前置条件所需的最小 facts（逐格显式，避免用一个「全真」对象掩盖条件分支）。
const TASK_FACTS: Record<string, GuardFacts> = {
  'captured->defined': { hasTitle: true, assigneeKind: 'human' },
  'awaiting_acceptance->defined': { acceptanceVerdict: 'rejected' },
  'awaiting_acceptance->active': { acceptanceVerdict: 'rejected', needsReexecution: true },
  'awaiting_acceptance->accepted': { acceptanceVerdict: 'accepted' },
  'accepted->awaiting_acceptance': { acceptanceSuperseded: true },
  'active->canceled': { allRunsTerminal: true },
  'awaiting_acceptance->canceled': { allRunsTerminal: true },
};

const RUN_FACTS: Record<string, GuardFacts> = {
  'leased->queued': { leaseExpired: true, started: false },
  'leased->failed': {
    leaseExpired: true, started: true, sideEffectLevel: 'L1', externalSideEffectCalled: false,
  },
  'leased->indeterminate': {
    leaseExpired: true, started: true, sideEffectLevel: 'L2', externalSideEffectCalled: false,
  },
  'running->timed_out': { runTimeoutExceeded: true, sideEffectResidue: 'none' },
  'running->canceled': { cancelAcknowledged: true },
  'indeterminate->succeeded': { reconciliation: 'completed' },
  'indeterminate->failed': { reconciliation: 'failed' },
  'indeterminate->canceled': { reconciliationConcluded: true },
};

interface MatrixCase {
  spec_ref: '§3.1' | '§3.2';
  entity: 'task' | 'run';
  row: string;
  col: string;
  cell: Cell;
  facts?: GuardFacts;
}

function expand(
  spec_ref: '§3.1' | '§3.2',
  entity: 'task' | 'run',
  rows: Array<[string, Cell[]]>,
  cols: string[],
  factsByCell: Record<string, GuardFacts>,
): MatrixCase[] {
  return rows.flatMap(([row, cells]) =>
    cells.map((cell, i) => ({
      spec_ref,
      entity,
      row,
      col: cols[i],
      cell,
      facts: factsByCell[`${row}->${cols[i]}`] ?? {},
    })),
  );
}

const TASK_CASES = expand('§3.1', 'task', TASK_ROWS, TASK_COLS, TASK_FACTS);
const RUN_CASES = expand('§3.2', 'run', RUN_ROWS, RUN_COLS, RUN_FACTS);

const label = (c: MatrixCase) => `${c.spec_ref} ${c.row}→${c.col}`;

const TERMINAL_TASK = new Set(['canceled']);
const TERMINAL_RUN = new Set(['succeeded', 'failed', 'canceled', 'timed_out']);

// §4.2：三类拒绝可区分——自环 / 终态 / 矩阵 ✗
function expectedDenyReason(c: MatrixCase) {
  if (c.row === c.col) return 'not_a_transition';
  const terminal = c.entity === 'task' ? TERMINAL_TASK : TERMINAL_RUN;
  return terminal.has(c.row) ? 'terminal_state' : 'illegal_transition';
}

describe('迁移矩阵 §3.1 Task（7×6=42 格，逐格）', () => {
  it.each(TASK_CASES.map((c) => [label(c), c] as const))('%s', (_name, c) => {
    const result = guardTransition({
      entity: 'task',
      from: c.row,
      to: c.col,
      event_type: 'TaskLifecycleChanged',
      facts: c.facts,
    });

    expect(result.basis.spec_ref).toBe('§3.1');
    expect(result.basis.row).toBe(c.row);
    expect(result.basis.col).toBe(c.col);
    expect(result.basis.cell).toBe(c.cell);

    if (c.cell === '✓') {
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
      // 每格允许都必须给出触发事件说明，否则不可追溯
      expect(result.basis.trigger).toBeTruthy();
    } else {
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe(expectedDenyReason(c));
    }
  });

  it('计数元测试：42 格且恰好 14 格允许', () => {
    expect(TASK_CASES).toHaveLength(42);
    expect(TASK_CASES.filter((c) => c.cell === '✓')).toHaveLength(14);
    expect(TASK_STATES).toHaveLength(7);
  });
});

describe('迁移矩阵 §3.2 Run（5×8 + 4×8=72 格，逐格）', () => {
  it.each(RUN_CASES.map((c) => [label(c), c] as const))('%s', (_name, c) => {
    const result = guardTransition({
      entity: 'run',
      from: c.row,
      to: c.col,
      event_type: 'RunQueued',
      facts: c.facts,
    });

    expect(result.basis.spec_ref).toBe('§3.2');
    expect(result.basis.row).toBe(c.row);
    expect(result.basis.col).toBe(c.col);
    expect(result.basis.cell).toBe(c.cell);

    if (c.cell === '✓') {
      expect(result.allowed).toBe(true);
      expect(result.basis.trigger).toBeTruthy();
    } else {
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe(expectedDenyReason(c));
    }
  });

  it('计数元测试：72 格且恰好 17 格允许', () => {
    expect(RUN_CASES).toHaveLength(72);
    expect(RUN_CASES.filter((c) => c.cell === '✓')).toHaveLength(17);
    expect(RUN_STATES).toHaveLength(9);
  });

  it('终态行整体不可迁移（INV-4），reason=terminal_state', () => {
    for (const from of ['succeeded', 'failed', 'canceled', 'timed_out']) {
      for (const to of RUN_COLS) {
        if (from === to) continue; // 自环不等于「终态再迁移」，单独分类
        const result = guardTransition({
          entity: 'run', from, to, event_type: 'RunQueued', facts: {},
        });
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('terminal_state');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §4.3 前置条件：每格正向 + 反向各一条
// ---------------------------------------------------------------------------
interface PreconditionCase {
  name: string;
  entity: 'task' | 'run';
  from: string;
  to: string;
  good: GuardFacts;
  bad: GuardFacts;
  unmet: string[];
}

const PRECONDITIONS: PreconditionCase[] = [
  {
    name: '§3.1 captured→defined（有 title）',
    entity: 'task', from: 'captured', to: 'defined',
    good: { hasTitle: true, assigneeKind: 'human' },
    bad: { hasTitle: false, assigneeKind: 'human' },
    unmet: ['hasTitle'],
  },
  {
    name: '§3.1 captured→defined（指派 Agent 须结构化契约 REQ-TC-1）',
    entity: 'task', from: 'captured', to: 'defined',
    good: { hasTitle: true, assigneeKind: 'agent', contractStructured: true },
    bad: { hasTitle: true, assigneeKind: 'agent', contractStructured: false },
    unmet: ['agentContractStructured'],
  },
  {
    name: '§3.1 awaiting_acceptance→defined（验收 rejected）',
    entity: 'task', from: 'awaiting_acceptance', to: 'defined',
    good: { acceptanceVerdict: 'rejected' },
    bad: { acceptanceVerdict: 'accepted' },
    unmet: ['acceptanceRejected'],
  },
  {
    name: '§3.1 awaiting_acceptance→active（rejected 且需再执行）',
    entity: 'task', from: 'awaiting_acceptance', to: 'active',
    good: { acceptanceVerdict: 'rejected', needsReexecution: true },
    bad: { acceptanceVerdict: 'rejected', needsReexecution: false },
    unmet: ['reexecutionNeeded'],
  },
  {
    name: '§3.1 awaiting_acceptance→active（partially_accepted 且需再执行，S4）',
    entity: 'task', from: 'awaiting_acceptance', to: 'active',
    good: { acceptanceVerdict: 'partially_accepted', needsReexecution: true },
    bad: { acceptanceVerdict: 'partially_accepted', needsReexecution: false },
    unmet: ['reexecutionNeeded'],
  },
  {
    name: '§3.1 awaiting_acceptance→accepted（验收 accepted）',
    entity: 'task', from: 'awaiting_acceptance', to: 'accepted',
    good: { acceptanceVerdict: 'accepted' },
    bad: { acceptanceVerdict: 'rejected' },
    unmet: ['acceptanceAccepted'],
  },
  {
    name: '§3.1 accepted→awaiting_acceptance（supersede 或 declares_revalidation）',
    entity: 'task', from: 'accepted', to: 'awaiting_acceptance',
    good: { acceptanceSuperseded: true },
    bad: { acceptanceSuperseded: false, declaresRevalidation: false },
    unmet: ['acceptanceInvalidated'],
  },
  {
    name: '§3.1 active→canceled（全部 Run 达终态 REQ-RUN-6③）',
    entity: 'task', from: 'active', to: 'canceled',
    good: { allRunsTerminal: true },
    bad: { allRunsTerminal: false },
    unmet: ['allRunsTerminal'],
  },
  {
    name: '§3.1 awaiting_acceptance→canceled（全部 Run 达终态 REQ-RUN-6③）',
    entity: 'task', from: 'awaiting_acceptance', to: 'canceled',
    good: { allRunsTerminal: true },
    bad: { allRunsTerminal: false },
    unmet: ['allRunsTerminal'],
  },
  {
    name: '§3.2 leased→queued（租约过期未启动，C1b）',
    entity: 'run', from: 'leased', to: 'queued',
    good: { leaseExpired: true, started: false },
    bad: { leaseExpired: true, started: true },
    unmet: ['leaseExpiredNotStarted'],
  },
  {
    name: '§3.2 leased→failed（已启动 + L0/L1 + 无外部副作用）',
    entity: 'run', from: 'leased', to: 'failed',
    good: { leaseExpired: true, started: true, sideEffectLevel: 'L0', externalSideEffectCalled: false },
    bad: { leaseExpired: true, started: true, sideEffectLevel: 'L2', externalSideEffectCalled: false },
    unmet: ['leaseExpiredStartedLowSideEffect'],
  },
  {
    name: '§3.2 leased→indeterminate（已启动 + L2/L3）',
    entity: 'run', from: 'leased', to: 'indeterminate',
    good: { leaseExpired: true, started: true, sideEffectLevel: 'L3', externalSideEffectCalled: false },
    bad: { leaseExpired: true, started: true, sideEffectLevel: 'L1', externalSideEffectCalled: false },
    unmet: ['leaseExpiredStartedHighSideEffect'],
  },
  {
    name: '§3.2 leased→indeterminate（已启动 + 有外部副作用调用记录）',
    entity: 'run', from: 'leased', to: 'indeterminate',
    good: { leaseExpired: true, started: true, sideEffectLevel: 'L1', externalSideEffectCalled: true },
    bad: { leaseExpired: true, started: false, sideEffectLevel: 'L1', externalSideEffectCalled: true },
    unmet: ['leaseExpiredStartedHighSideEffect'],
  },
  {
    name: '§3.2 running→timed_out（超时且无副作用残留）',
    entity: 'run', from: 'running', to: 'timed_out',
    good: { runTimeoutExceeded: true, sideEffectResidue: 'none' },
    bad: { runTimeoutExceeded: true, sideEffectResidue: 'unknown' },
    unmet: ['timeoutNoSideEffectResidue'],
  },
  {
    name: '§3.2 running→canceled（取消确认）',
    entity: 'run', from: 'running', to: 'canceled',
    good: { cancelAcknowledged: true },
    bad: { cancelAcknowledged: false },
    unmet: ['cancelAcknowledged'],
  },
  {
    name: '§3.2 indeterminate→succeeded（对账确认已完成）',
    entity: 'run', from: 'indeterminate', to: 'succeeded',
    good: { reconciliation: 'completed' },
    bad: { reconciliation: 'not_executed' },
    unmet: ['reconciliationCompleted'],
  },
  {
    name: '§3.2 indeterminate→failed（对账确认未执行或已失败）',
    entity: 'run', from: 'indeterminate', to: 'failed',
    good: { reconciliation: 'not_executed' },
    bad: { reconciliation: 'inconclusive' },
    unmet: ['reconciliationFailed'],
  },
  {
    name: '§3.2 indeterminate→canceled（对账后人工取消）',
    entity: 'run', from: 'indeterminate', to: 'canceled',
    good: { reconciliationConcluded: true },
    bad: { reconciliationConcluded: false },
    unmet: ['reconciliationConcluded'],
  },
];

describe('§4.3 前置条件（正向 + 反向）', () => {
  it.each(PRECONDITIONS.map((p) => [p.name, p] as const))('%s', (_name, p) => {
    const base = { entity: p.entity, from: p.from, to: p.to, event_type: 'TaskLifecycleChanged' };

    const ok = guardTransition({ ...base, facts: p.good });
    expect(ok.allowed).toBe(true);
    expect(ok.unmet ?? []).toHaveLength(0);

    const denied = guardTransition({ ...base, facts: p.bad });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('precondition_unmet');
    expect(denied.unmet).toEqual(p.unmet);
  });

  it('facts 缺失（undefined）→ precondition_facts_missing，既不放行也不默认拒绝', () => {
    const result = guardTransition({
      entity: 'task', from: 'captured', to: 'defined', event_type: 'TaskLifecycleChanged', facts: {},
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('precondition_facts_missing');
    // assigneeKind 也缺失，因此「指派 Agent 须结构化契约」同样不可判定
    expect(result.unmet).toEqual(['hasTitle', 'agentContractStructured']);
    // F-a：缺哪个 fact、期望值是什么，可直接照抄
    expect(result.missing_facts).toEqual([
      { requirement: 'hasTitle', fact: 'hasTitle', expected: 'hasTitle=true' },
      {
        requirement: 'agentContractStructured',
        fact: 'assigneeKind',
        expected: "assigneeKind='human'|'agent'",
      },
    ]);
    expect(result.unmet_requirements).toEqual([]);
  });

  it('facts 整体省略同样按缺失处理', () => {
    const result = guardTransition({
      entity: 'run', from: 'leased', to: 'queued', event_type: 'RunQueued',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('precondition_facts_missing');
    expect(result.unmet).toEqual(['leaseExpiredNotStarted']);
    expect(result.missing_facts).toEqual([
      {
        requirement: 'leaseExpiredNotStarted',
        fact: 'leaseExpired',
        expected: 'leaseExpired=true',
      },
      { requirement: 'leaseExpiredNotStarted', fact: 'started', expected: 'started=false' },
    ]);
  });

  it('缺 fact 提示给出 fact 名 + 期望值（acceptanceVerdict）', () => {
    const result = guardTransition({
      entity: 'task', from: 'awaiting_acceptance', to: 'accepted',
      event_type: 'TaskLifecycleChanged', facts: {},
    });
    expect(result.reason).toBe('precondition_facts_missing');
    expect(result.missing_facts).toEqual([{
      requirement: 'acceptanceAccepted',
      fact: 'acceptanceVerdict',
      expected: "acceptanceVerdict='accepted'",
    }]);
    expect(result.unmet_requirements).toEqual([]);
  });

  it('缺失与「已给但不满足」分开：unmet_requirements 只放已给但不满足的', () => {
    const result = guardTransition({
      entity: 'task', from: 'captured', to: 'defined', event_type: 'TaskLifecycleChanged',
      facts: { hasTitle: false, assigneeKind: 'agent' },
    });
    expect(result.reason).toBe('precondition_facts_missing');
    expect(result.unmet).toEqual(['hasTitle', 'agentContractStructured']);
    expect(result.unmet_requirements).toEqual(['hasTitle']);
    expect(result.missing_facts).toEqual([{
      requirement: 'agentContractStructured',
      fact: 'contractStructured',
      expected: 'contractStructured=true',
    }]);
  });

  it('facts 全给但不满足 → precondition_unmet，missing_facts 为空', () => {
    const result = guardTransition({
      entity: 'task', from: 'awaiting_acceptance', to: 'accepted',
      event_type: 'TaskLifecycleChanged', facts: { acceptanceVerdict: 'rejected' },
    });
    expect(result.reason).toBe('precondition_unmet');
    expect(result.unmet).toEqual(['acceptanceAccepted']);
    expect(result.unmet_requirements).toEqual(['acceptanceAccepted']);
    expect(result.missing_facts).toEqual([]);
  });

  it('复合条件只列真正缺失的 fact（已给的不重复提示）', () => {
    const result = guardTransition({
      entity: 'run', from: 'leased', to: 'indeterminate', event_type: 'RunIndeterminate',
      facts: { leaseExpired: true, started: true },
    });
    expect(result.reason).toBe('precondition_facts_missing');
    expect(result.unmet_requirements).toEqual([]);
    expect(result.missing_facts).toEqual([
      {
        requirement: 'leaseExpiredStartedHighSideEffect',
        fact: 'sideEffectLevel',
        expected: "sideEffectLevel='L2'|'L3' 或 externalSideEffectCalled=true",
      },
      {
        requirement: 'leaseExpiredStartedHighSideEffect',
        fact: 'externalSideEffectCalled',
        expected: 'externalSideEffectCalled=true',
      },
    ]);
  });

  it('accepted→awaiting_acceptance 的另一条通道：declares_revalidation 单独即可放行（S1）', () => {
    const result = guardTransition({
      entity: 'task', from: 'accepted', to: 'awaiting_acceptance',
      event_type: 'TaskLifecycleChanged',
      facts: { acceptanceSuperseded: false, declaresRevalidation: true },
    });
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INV-11：迁入 accepted/canceled 必须返回收尾动作（顺序固定），但不拒绝迁移
// ---------------------------------------------------------------------------
describe('INV-11 终态收尾 required_effects', () => {
  it.each([
    ['awaiting_acceptance', 'accepted', { acceptanceVerdict: 'accepted' as const }],
    ['awaiting_acceptance', 'canceled', { allRunsTerminal: true }],
    ['active', 'canceled', { allRunsTerminal: true }],
    ['ready', 'canceled', {}],
    ['defined', 'canceled', {}],
    ['captured', 'canceled', {}],
  ])('task %s→%s 返回按序两项收尾动作', (from, to, facts) => {
    const result = guardTransition({
      entity: 'task', from, to, event_type: 'TaskLifecycleChanged', facts,
    });
    expect(result.allowed).toBe(true);
    expect(result.required_effects).toEqual([
      'cancel_active_wait_conditions',
      'reset_wait_state_none',
    ]);
    expect(result.required_effects_basis).toBe('INV-11');
  });

  it('非终态目标不返回收尾动作', () => {
    const result = guardTransition({
      entity: 'task', from: 'captured', to: 'defined',
      event_type: 'TaskLifecycleChanged', facts: { hasTitle: true, assigneeKind: 'human' },
    });
    expect(result.required_effects ?? []).toEqual([]);
  });

  it('INV-11 不要求调用方先满足前置条件：wait_state 非 none 也放行迁移', () => {
    // 前置条件表里没有 wait_state 项，这条用例防止实现偷偷加条件
    const result = guardTransition({
      entity: 'task', from: 'awaiting_acceptance', to: 'accepted',
      event_type: 'TaskLifecycleChanged',
      facts: { acceptanceVerdict: 'accepted' },
    });
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §3.1 wait_state 正交维度（§4.4）
// ---------------------------------------------------------------------------
describe('wait_state 维度迁移', () => {
  it.each([
    ['active', 'none', 'waiting_on_person'],
    ['active', 'waiting_on_person', 'none'],
    ['defined', 'none', 'blocked'],
    ['ready', 'none', 'on_hold'],
    ['awaiting_acceptance', 'waiting_until', 'waiting_on_dependency'],
  ])('非终态 lifecycle=%s 允许 %s→%s', (lifecycle, from, to) => {
    const result = guardWaitStateChange({ lifecycle, from, to, reason: 'test' });
    expect(result.allowed).toBe(true);
    expect(result.basis.spec_ref).toBe('§3.1');
    expect(result.required_effects ?? []).toEqual([]);
  });

  it.each(['accepted', 'canceled'])('终态 lifecycle=%s 拒绝 wait_state 变更（INV-11 已归 none）', (lifecycle) => {
    const result = guardWaitStateChange({ lifecycle, from: 'none', to: 'blocked' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('terminal_state');
  });

  it('自环不算迁移', () => {
    const result = guardWaitStateChange({ lifecycle: 'active', from: 'none', to: 'none' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not_a_transition');
  });

  it('未知 wait_state / lifecycle → unknown_state', () => {
    expect(guardWaitStateChange({ lifecycle: 'active', from: 'bogus', to: 'none' }).reason)
      .toBe('unknown_state');
    expect(guardWaitStateChange({ lifecycle: 'bogus', from: 'none', to: 'blocked' }).reason)
      .toBe('unknown_state');
  });

  it('TASK_WAIT_STATES 覆盖 spec §2.2 的六个值', () => {
    expect([...TASK_WAIT_STATES].sort()).toEqual(
      ['blocked', 'none', 'on_hold', 'waiting_on_dependency', 'waiting_on_person', 'waiting_until'],
    );
  });

  it('WaitCondition.kind → wait_state 映射表逐项带 spec_ref', () => {
    expect(WAIT_STATE_BY_CONDITION_KIND.person.wait_state).toBe('waiting_on_person');
    expect(WAIT_STATE_BY_CONDITION_KIND.until.wait_state).toBe('waiting_until');
    expect(WAIT_STATE_BY_CONDITION_KIND.dependency.wait_state).toBe('waiting_on_dependency');
    expect(WAIT_STATE_BY_CONDITION_KIND.device.wait_state).toBe('blocked');
    for (const entry of Object.values(WAIT_STATE_BY_CONDITION_KIND)) {
      expect(entry.spec_ref).toBe('§3.1');
    }
  });
});

// ---------------------------------------------------------------------------
// 错误分类：未知状态 / 自环 / 非法迁移三者必须可区分（§4.2）
// ---------------------------------------------------------------------------
describe('拒绝原因分类可区分（§4.2）', () => {
  it('未知 from/to → unknown_state（编程错误，非矩阵 ✗）', () => {
    expect(guardTransition({
      entity: 'task', from: 'bogus', to: 'defined', event_type: 'TaskLifecycleChanged',
    }).reason).toBe('unknown_state');
    expect(guardTransition({
      entity: 'task', from: 'captured', to: 'bogus', event_type: 'TaskLifecycleChanged',
    }).reason).toBe('unknown_state');
    expect(guardTransition({
      entity: 'run', from: 'bogus', to: 'queued', event_type: 'RunQueued',
    }).reason).toBe('unknown_state');
  });

  it('自环（defined→defined）→ not_a_transition，不是 illegal_transition', () => {
    const result = guardTransition({
      entity: 'task', from: 'defined', to: 'defined', event_type: 'TaskLifecycleChanged', facts: {},
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not_a_transition');
  });

  it('§3.1 accepted→canceled 是矩阵明示的 – 格 → illegal_transition', () => {
    const result = guardTransition({
      entity: 'task', from: 'accepted', to: 'canceled', event_type: 'TaskLifecycleChanged', facts: {},
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('illegal_transition');
  });

  it('允许格 basis 携带 spec 依据（requirement 或 note 至少其一非空）', () => {
    const result = guardTransition({
      entity: 'task', from: 'ready', to: 'active',
      event_type: 'TaskLifecycleChanged', facts: {},
    });
    expect(result.allowed).toBe(true);
    expect(Boolean(result.basis.requirement || result.basis.note)).toBe(true);
  });
});
