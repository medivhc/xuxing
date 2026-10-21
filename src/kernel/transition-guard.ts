// 状态迁移矩阵校验器 —— 纯函数、无 IO。
// 唯一依据：spec/K0-SPEC-FROZEN-v1.0.md §3.1（Task 主生命周期）、§3.2（Run 状态）、
// §4.2（INV-11 终态收尾）、§3.1 wait_state 正交维度与 WaitCondition.kind 映射表。
//
// 设计约束（plan §4）：
// - 每格显式存在（✓ 与 – 都写），不用「缺省即拒绝」造成不可追溯；
// - ✓ 格的 trigger 必须写明触发事件语义，前置条件逐条带 spec 原句落点；
// - 未知状态（编程错误）/ 自环 / 矩阵 ✗ 三类拒绝必须可区分；
// - 前置条件 fact 缺失一律 precondition_facts_missing，不默认放行也不默认拒绝。
// 本模块不写事件、不读库：是否落事件由调用方（PgEventStore.appendStateTransition）决定。

import type { RunState, SideEffectLevel, TaskLifecycle, TaskWaitState } from '../domain/types.js';

export const TASK_STATES = [
  'captured',
  'defined',
  'ready',
  'active',
  'awaiting_acceptance',
  'accepted',
  'canceled',
] as const satisfies readonly TaskLifecycle[];

export const RUN_STATES = [
  'created',
  'queued',
  'leased',
  'running',
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'indeterminate',
] as const satisfies readonly RunState[];

export const TASK_WAIT_STATES = [
  'none',
  'waiting_on_person',
  'waiting_until',
  'waiting_on_dependency',
  'blocked',
  'on_hold',
] as const satisfies readonly TaskWaitState[];

/** spec §3.1「WaitCondition.kind → wait_state 映射表」，逐项带出处。 */
export const WAIT_STATE_BY_CONDITION_KIND = {
  person: { wait_state: 'waiting_on_person', spec_ref: '§3.1' },
  until: { wait_state: 'waiting_until', spec_ref: '§3.1' },
  dependency: { wait_state: 'waiting_on_dependency', spec_ref: '§3.1' },
  device: { wait_state: 'blocked', spec_ref: '§3.1' },
} as const satisfies Record<string, { wait_state: TaskWaitState; spec_ref: '§3.1' }>;

export type GuardEntity = 'task' | 'run';

export type GuardReason =
  | 'illegal_transition'
  | 'terminal_state'
  | 'not_a_transition'
  | 'precondition_unmet'
  | 'precondition_facts_missing'
  | 'unknown_state';

export type GuardEffect = 'cancel_active_wait_conditions' | 'reset_wait_state_none';

/**
 * 缺失 fact 的可执行提示：告诉调用方要补 GuardFacts 的哪个键、期望值是什么。
 * expected 可直接照抄进日志或调用代码（如 acceptanceVerdict='accepted'）。
 */
export interface MissingFactHint {
  /** 触发该提示的 requirement id（可回溯到 spec 原句）。 */
  requirement: string;
  /** 缺失的 GuardFacts 键名。 */
  fact: string;
  /** 期望值/可照抄赋值；多选一条件用文案表达。 */
  expected: string;
  /** 多选一条件中的其它可选 fact（无则省略）。 */
  alternatives?: string[];
}

/** 前置条件 fact：由调用方显式提供；undefined = 缺失（拒绝，不猜）。 */
export interface GuardFacts {
  // §3.1 captured→defined
  hasTitle?: boolean;
  assigneeKind?: 'human' | 'agent';
  contractStructured?: boolean;
  // §3.1 awaiting_acceptance / accepted
  acceptanceVerdict?: 'accepted' | 'rejected' | 'partially_accepted';
  needsReexecution?: boolean;
  acceptanceSuperseded?: boolean;
  declaresRevalidation?: boolean;
  allRunsTerminal?: boolean;
  // §3.2 租约过期分界（REQ-RUN-4）
  leaseExpired?: boolean;
  started?: boolean;
  sideEffectLevel?: SideEffectLevel;
  externalSideEffectCalled?: boolean;
  // §3.2 超时 / 取消 / 对账
  runTimeoutExceeded?: boolean;
  sideEffectResidue?: 'none' | 'unknown';
  cancelAcknowledged?: boolean;
  reconciliation?: 'completed' | 'not_executed' | 'failed' | 'inconclusive';
  reconciliationConcluded?: boolean;
}

export interface GuardBasis {
  spec_ref: '§3.1' | '§3.2';
  row: string;
  col: string;
  cell: '✓' | '–';
  trigger?: string;
  requirement?: string;
  note?: string;
}

export interface GuardResult {
  allowed: boolean;
  basis: GuardBasis;
  reason?: GuardReason;
  /**
   * 未满足的前置条件 id（兼容字段）：缺失 fact 与已给但不满足的 requirement 的并集。
   * 需要区分时用 unmet_requirements（已给但不满足）与 missing_facts（缺 fact）。
   */
  unmet?: string[];
  /** 已给 fact 但不满足的 requirement id（无需补 fact，这条路当前走不通）。 */
  unmet_requirements?: string[];
  /** 缺失的 fact 及期望值：能直接告诉调用方要传什么（precondition_facts_missing 时非空）。 */
  missing_facts?: MissingFactHint[];
  /** INV-11：迁入 accepted/canceled 时内核须同事务执行的收尾动作（按序）。 */
  required_effects?: GuardEffect[];
  required_effects_basis?: 'INV-11';
}

export interface GuardTransitionInput {
  entity: GuardEntity;
  from: string;
  to: string;
  event_type: string;
  facts?: GuardFacts;
}

interface MatrixCell {
  cell: '✓' | '–';
  trigger?: string;
  requirement?: string;
  requires?: RequirementId[];
  note?: string;
  effects?: GuardEffect[];
}

// ---------------------------------------------------------------------------
// 前置条件（只编码 spec 明文写死的条件，逐条见 §4.3 表的出处）
// ---------------------------------------------------------------------------

type RequirementId =
  | 'hasTitle'
  | 'agentContractStructured'
  | 'acceptanceRejected'
  | 'reexecutionNeeded'
  | 'acceptanceAccepted'
  | 'acceptanceInvalidated'
  | 'allRunsTerminal'
  | 'leaseExpiredNotStarted'
  | 'leaseExpiredStartedLowSideEffect'
  | 'leaseExpiredStartedHighSideEffect'
  | 'timeoutNoSideEffectResidue'
  | 'cancelAcknowledged'
  | 'reconciliationCompleted'
  | 'reconciliationFailed'
  | 'reconciliationConcluded';

type FactState = 'met' | 'unmet' | 'missing';

function flag(value: boolean | undefined): FactState {
  if (value === undefined) return 'missing';
  return value ? 'met' : 'unmet';
}

function negatedFlag(value: boolean | undefined): FactState {
  if (value === undefined) return 'missing';
  return value ? 'unmet' : 'met';
}

function all(...states: FactState[]): FactState {
  if (states.includes('missing')) return 'missing';
  return states.every((s) => s === 'met') ? 'met' : 'unmet';
}

function fromSet<T extends string>(value: T | undefined, allowed: readonly T[]): FactState {
  if (value === undefined) return 'missing';
  return allowed.includes(value) ? 'met' : 'unmet';
}

const REQUIREMENTS: Record<RequirementId, (facts: GuardFacts) => FactState> = {
  // 「有 title」
  hasTitle: (f) => flag(f.hasTitle),
  // 「指派 Agent 时另须满足 REQ-TC-1」——人工执行不要求结构化契约
  agentContractStructured: (f) => {
    if (f.assigneeKind === undefined) return 'missing';
    if (f.assigneeKind === 'human') return 'met';
    return flag(f.contractStructured);
  },
  // 「验收 rejected」
  acceptanceRejected: (f) => fromSet(f.acceptanceVerdict, ['rejected'] as const),
  // 「rejected 且需再执行；或 partially_accepted 且未过判据需再执行（S4）」
  reexecutionNeeded: (f) => {
    const verdict = fromSet(f.acceptanceVerdict, ['rejected', 'partially_accepted'] as const);
    if (verdict !== 'met') return verdict;
    return flag(f.needsReexecution);
  },
  // 「验收 accepted」
  acceptanceAccepted: (f) => fromSet(f.acceptanceVerdict, ['accepted'] as const),
  // 「Acceptance 被 supersede 且新结论未定；或新契约显式声明需重验（S1）」
  acceptanceInvalidated: (f) => {
    if (f.acceptanceSuperseded === undefined && f.declaresRevalidation === undefined) {
      return 'missing';
    }
    return f.acceptanceSuperseded === true || f.declaresRevalidation === true ? 'met' : 'unmet';
  },
  // REQ-RUN-6③「全部 Run 达终态后才正式 canceled」
  allRunsTerminal: (f) => flag(f.allRunsTerminal),
  // 「租约过期未启动」（REQ-RUN-4 / C1b）
  leaseExpiredNotStarted: (f) => all(flag(f.leaseExpired), negatedFlag(f.started)),
  // 「已启动且 side_effect_level ∈ {L0,L1} 且无外部副作用工具调用记录」
  leaseExpiredStartedLowSideEffect: (f) =>
    all(
      flag(f.leaseExpired),
      flag(f.started),
      fromSet(f.sideEffectLevel, ['L0', 'L1'] as const),
      negatedFlag(f.externalSideEffectCalled),
    ),
  // 「已启动且（L2/L3 或已有外部副作用调用记录）」
  leaseExpiredStartedHighSideEffect: (f) => {
    if (
      f.leaseExpired === undefined ||
      f.started === undefined ||
      f.sideEffectLevel === undefined ||
      f.externalSideEffectCalled === undefined
    ) {
      return 'missing';
    }
    const highSideEffect = f.sideEffectLevel === 'L2' || f.sideEffectLevel === 'L3';
    return f.leaseExpired && f.started && (highSideEffect || f.externalSideEffectCalled)
      ? 'met'
      : 'unmet';
  },
  // 「超时且确认无副作用残留」
  timeoutNoSideEffectResidue: (f) =>
    all(flag(f.runTimeoutExceeded), fromSet(f.sideEffectResidue, ['none'] as const)),
  // 「取消确认后」
  cancelAcknowledged: (f) => flag(f.cancelAcknowledged),
  // 「对账确认已完成」
  reconciliationCompleted: (f) => fromSet(f.reconciliation, ['completed'] as const),
  // 「对账确认未执行或已失败」
  reconciliationFailed: (f) => fromSet(f.reconciliation, ['not_executed', 'failed'] as const),
  // 「对账后人工取消」
  reconciliationConcluded: (f) => flag(f.reconciliationConcluded),
};

// ---------------------------------------------------------------------------
// 缺失 fact → 可执行提示（F-a：不能只报 requirement 名）
// ---------------------------------------------------------------------------

/**
 * 只列出调用方确实没给的 fact（undefined），并给出期望值。
 * 已给但值不满足的 requirement 不在这里出现（由 unmet_requirements 表达）。
 */
function missingFactHints(requirementId: RequirementId, facts: GuardFacts): MissingFactHint[] {
  const hints: MissingFactHint[] = [];
  const add = (fact: string, expected: string, value: unknown): void => {
    if (value === undefined) hints.push({ requirement: requirementId, fact, expected });
  };

  switch (requirementId) {
    case 'hasTitle':
      add('hasTitle', 'hasTitle=true', facts.hasTitle);
      break;
    case 'agentContractStructured':
      add('assigneeKind', "assigneeKind='human'|'agent'", facts.assigneeKind);
      if (facts.assigneeKind === 'agent') {
        add('contractStructured', 'contractStructured=true', facts.contractStructured);
      }
      break;
    case 'acceptanceRejected':
      add('acceptanceVerdict', "acceptanceVerdict='rejected'", facts.acceptanceVerdict);
      break;
    case 'reexecutionNeeded':
      add(
        'acceptanceVerdict',
        "acceptanceVerdict='rejected'|'partially_accepted'",
        facts.acceptanceVerdict,
      );
      if (
        facts.acceptanceVerdict === 'rejected' ||
        facts.acceptanceVerdict === 'partially_accepted'
      ) {
        add('needsReexecution', 'needsReexecution=true', facts.needsReexecution);
      }
      break;
    case 'acceptanceAccepted':
      add('acceptanceVerdict', "acceptanceVerdict='accepted'", facts.acceptanceVerdict);
      break;
    case 'acceptanceInvalidated':
      if (
        facts.acceptanceSuperseded === undefined &&
        facts.declaresRevalidation === undefined
      ) {
        hints.push({
          requirement: requirementId,
          fact: 'acceptanceSuperseded',
          expected: 'acceptanceSuperseded=true 或 declaresRevalidation=true',
          alternatives: ['declaresRevalidation'],
        });
      }
      break;
    case 'allRunsTerminal':
      add('allRunsTerminal', 'allRunsTerminal=true', facts.allRunsTerminal);
      break;
    case 'leaseExpiredNotStarted':
      add('leaseExpired', 'leaseExpired=true', facts.leaseExpired);
      add('started', 'started=false', facts.started);
      break;
    case 'leaseExpiredStartedLowSideEffect':
      add('leaseExpired', 'leaseExpired=true', facts.leaseExpired);
      add('started', 'started=true', facts.started);
      add('sideEffectLevel', "sideEffectLevel='L0'|'L1'", facts.sideEffectLevel);
      add(
        'externalSideEffectCalled',
        'externalSideEffectCalled=false',
        facts.externalSideEffectCalled,
      );
      break;
    case 'leaseExpiredStartedHighSideEffect':
      add('leaseExpired', 'leaseExpired=true', facts.leaseExpired);
      add('started', 'started=true', facts.started);
      add(
        'sideEffectLevel',
        "sideEffectLevel='L2'|'L3' 或 externalSideEffectCalled=true",
        facts.sideEffectLevel,
      );
      add(
        'externalSideEffectCalled',
        'externalSideEffectCalled=true',
        facts.externalSideEffectCalled,
      );
      break;
    case 'timeoutNoSideEffectResidue':
      add('runTimeoutExceeded', 'runTimeoutExceeded=true', facts.runTimeoutExceeded);
      add(
        'sideEffectResidue',
        "sideEffectResidue='none'",
        facts.sideEffectResidue,
      );
      break;
    case 'cancelAcknowledged':
      add('cancelAcknowledged', 'cancelAcknowledged=true', facts.cancelAcknowledged);
      break;
    case 'reconciliationCompleted':
      add('reconciliation', "reconciliation='completed'", facts.reconciliation);
      break;
    case 'reconciliationFailed':
      add(
        'reconciliation',
        "reconciliation='not_executed'|'failed'",
        facts.reconciliation,
      );
      break;
    case 'reconciliationConcluded':
      add(
        'reconciliationConcluded',
        'reconciliationConcluded=true',
        facts.reconciliationConcluded,
      );
      break;
  }

  return hints;
}

// ---------------------------------------------------------------------------
// §3.1 Task 主生命周期矩阵（7 行 × 6 列 = 42 格，逐格显式）
// ---------------------------------------------------------------------------

const INV11_EFFECTS: GuardEffect[] = ['cancel_active_wait_conditions', 'reset_wait_state_none'];

const TASK_MATRIX: Record<string, Record<string, MatrixCell>> = {
  captured: {
    defined: {
      cell: '✓', trigger: '定义完成', requirement: 'REQ-TC-1',
      requires: ['hasTitle', 'agentContractStructured'],
    },
    ready: { cell: '–', note: '未定义不可就绪' },
    active: { cell: '–', note: '未就绪不可派发' },
    awaiting_acceptance: { cell: '–', note: '未执行无 Outcome' },
    accepted: { cell: '–', note: '未执行不可验收' },
    canceled: {
      cell: '✓', trigger: '取消（无在跑 Run，直接收尾）', requirement: 'REQ-RUN-6',
      effects: INV11_EFFECTS,
    },
  },
  defined: {
    defined: { cell: '–', note: '自环：契约/文本修订，不算迁移' },
    ready: { cell: '✓', trigger: '依赖满足', requirement: 'REQ-SCH-1' },
    active: { cell: '–', note: '未经 ready 不可派发' },
    awaiting_acceptance: { cell: '–', note: '未执行无 Outcome' },
    accepted: { cell: '–', note: '未验收不可 accepted' },
    canceled: {
      cell: '✓', trigger: '取消', requirement: 'REQ-RUN-6', effects: INV11_EFFECTS,
    },
  },
  ready: {
    defined: { cell: '✓', trigger: '依赖回退', requirement: 'REQ-SCH-1' },
    ready: { cell: '–', note: '自环不算迁移' },
    active: { cell: '✓', trigger: '派发 Run', requirement: 'REQ-RUN-1/REQ-SCH-1' },
    awaiting_acceptance: { cell: '–', note: '未执行无 Outcome' },
    accepted: { cell: '–', note: '未验收不可 accepted' },
    canceled: {
      cell: '✓', trigger: '取消', requirement: 'REQ-RUN-6', effects: INV11_EFFECTS,
    },
  },
  active: {
    defined: { cell: '–', note: 'Run 在跑不可回 defined' },
    ready: { cell: '–', note: 'Run 在跑不可回 ready' },
    active: { cell: '–', note: '自环不算迁移' },
    awaiting_acceptance: { cell: '✓', trigger: 'Run 出 Outcome', requirement: 'REQ-ACC-3' },
    accepted: { cell: '–', note: '须先经 awaiting_acceptance 验收' },
    canceled: {
      cell: '✓', trigger: '取消级联收尾（全部 Run 达终态）', requirement: 'REQ-RUN-6',
      requires: ['allRunsTerminal'], effects: INV11_EFFECTS,
    },
  },
  awaiting_acceptance: {
    defined: {
      cell: '✓', trigger: '验收 rejected', requirement: 'REQ-ACC-3',
      requires: ['acceptanceRejected'],
    },
    ready: { cell: '–', note: 'rejected 后回 defined 重走 ready 判定' },
    active: {
      cell: '✓',
      trigger: '验收 rejected 且需再执行；或 partially_accepted 且未过判据需再执行（S4）',
      requirement: 'REQ-ACC-3', requires: ['reexecutionNeeded'],
    },
    awaiting_acceptance: { cell: '–', note: '自环不算迁移' },
    accepted: {
      cell: '✓', trigger: '验收 accepted', requirement: 'REQ-ACC-3',
      requires: ['acceptanceAccepted'], effects: INV11_EFFECTS,
    },
    canceled: {
      cell: '✓', trigger: '取消（无在跑 Run 时直接收尾）', requirement: 'REQ-RUN-6',
      requires: ['allRunsTerminal'], effects: INV11_EFFECTS,
    },
  },
  accepted: {
    defined: { cell: '–', note: 'accepted 是终态' },
    ready: { cell: '–', note: 'accepted 是终态' },
    active: { cell: '–', note: 'accepted 是终态' },
    awaiting_acceptance: {
      cell: '✓',
      trigger: 'Acceptance 被 supersede 且新结论未定；或新契约显式声明需重验（declares_revalidation）',
      requirement: 'REQ-ACC-1/REQ-ACC-4',
      requires: ['acceptanceInvalidated'],
    },
    accepted: { cell: '–', note: '自环不算迁移' },
    canceled: { cell: '–', note: 'accepted 为终态；取消须另立 Task' },
  },
  canceled: {
    defined: { cell: '–', note: '终态不可再迁移' },
    ready: { cell: '–', note: '终态不可再迁移' },
    active: { cell: '–', note: '终态不可再迁移' },
    awaiting_acceptance: { cell: '–', note: '终态不可再迁移' },
    accepted: { cell: '–', note: '终态不可再迁移' },
    canceled: { cell: '–', note: '终态不可再迁移' },
  },
};

// ---------------------------------------------------------------------------
// §3.2 Run 状态矩阵（5 行 × 8 列 + 终态 4 行 × 8 列 = 72 格，逐格显式）
// ---------------------------------------------------------------------------

const TERMINAL_RUN_CELLS: Record<string, MatrixCell> = {
  queued: { cell: '–', note: '终态不可再迁移（INV-4）' },
  leased: { cell: '–', note: '终态不可再迁移（INV-4）' },
  running: { cell: '–', note: '终态不可再迁移（INV-4）' },
  succeeded: { cell: '–', note: '终态不可再迁移（INV-4）' },
  failed: { cell: '–', note: '终态不可再迁移（INV-4）' },
  canceled: { cell: '–', note: '终态不可再迁移（INV-4）' },
  timed_out: { cell: '–', note: '终态不可再迁移（INV-4）' },
  indeterminate: { cell: '–', note: '终态不可再迁移（INV-4）' },
};

const RUN_MATRIX: Record<string, Record<string, MatrixCell>> = {
  created: {
    queued: { cell: '✓', trigger: '排入队列', note: '创建即入队' },
    leased: { cell: '–', note: '未经队列不可领取' },
    running: { cell: '–', note: '未经租约不可启动' },
    succeeded: { cell: '–', note: '未执行不可成功' },
    failed: { cell: '–', note: '未执行不可失败' },
    canceled: { cell: '✓', trigger: '未启动直接取消', requirement: 'REQ-RUN-6' },
    timed_out: { cell: '–', note: '未启动无超时' },
    indeterminate: { cell: '–', note: '未启动无副作用，不进 indeterminate' },
  },
  queued: {
    queued: { cell: '–', note: '自环不算迁移' },
    leased: { cell: '✓', trigger: '领取（分配租约）', requirement: 'REQ-RUN-1' },
    running: { cell: '–', note: '未经租约不可启动' },
    succeeded: { cell: '–', note: '未执行不可成功' },
    failed: { cell: '–', note: '未执行不可失败' },
    canceled: { cell: '✓', trigger: '未启动直接取消', requirement: 'REQ-RUN-6' },
    timed_out: { cell: '–', note: '未启动无超时' },
    indeterminate: { cell: '–', note: '未启动无副作用，不进 indeterminate' },
  },
  leased: {
    queued: {
      cell: '✓', trigger: '租约过期未启动（分界见 REQ-RUN-4）', requirement: 'REQ-RUN-4',
      requires: ['leaseExpiredNotStarted'],
    },
    leased: { cell: '–', note: '自环不算迁移' },
    running: { cell: '✓', trigger: '启动回报', requirement: 'REQ-RUN-1' },
    succeeded: { cell: '–', note: '须先启动' },
    failed: {
      cell: '✓',
      trigger: '租约过期且已启动 + L0/L1 + 无外部副作用调用记录',
      requirement: 'REQ-RUN-4', requires: ['leaseExpiredStartedLowSideEffect'],
    },
    canceled: { cell: '✓', trigger: '未启动直接取消', requirement: 'REQ-RUN-6' },
    timed_out: { cell: '–', note: '超时自 RunStarted 起算' },
    indeterminate: {
      cell: '✓',
      trigger: '租约过期且已启动 + L2/L3 或已有外部副作用调用记录',
      requirement: 'REQ-RUN-4', requires: ['leaseExpiredStartedHighSideEffect'],
    },
  },
  running: {
    queued: { cell: '–', note: '禁止复用旧 Run 记录回 queued（INV-4）' },
    leased: { cell: '–', note: '已启动不可回 leased' },
    running: { cell: '–', note: '自环不算迁移' },
    succeeded: { cell: '✓', trigger: '执行成功回报' },
    failed: { cell: '✓', trigger: '执行失败回报' },
    canceled: {
      cell: '✓', trigger: '取消确认后', requirement: 'REQ-RUN-6',
      requires: ['cancelAcknowledged'],
    },
    timed_out: {
      cell: '✓', trigger: '超时且确认无副作用残留', requirement: 'REQ-RUN-4',
      requires: ['timeoutNoSideEffectResidue'],
    },
    indeterminate: { cell: '✓', trigger: '心跳丢失/进程崩溃' },
  },
  indeterminate: {
    queued: { cell: '–', note: '对账不改变 Run 身份（INV-4）' },
    leased: { cell: '–', note: '不可重新领取旧 Run' },
    running: { cell: '–', note: '对账不回到执行中' },
    succeeded: {
      cell: '✓', trigger: '对账确认已完成（补录 RawResult）', requirement: 'REQ-RUN-3',
      requires: ['reconciliationCompleted'],
    },
    failed: {
      cell: '✓', trigger: '对账确认未执行或已失败', requirement: 'REQ-RUN-3',
      requires: ['reconciliationFailed'],
    },
    canceled: {
      cell: '✓', trigger: '对账后人工取消', requirement: 'REQ-RUN-3',
      requires: ['reconciliationConcluded'],
    },
    timed_out: { cell: '–', note: '对账结论不含超时' },
    indeterminate: { cell: '–', note: '自环不算迁移' },
  },
  succeeded: TERMINAL_RUN_CELLS,
  failed: TERMINAL_RUN_CELLS,
  canceled: TERMINAL_RUN_CELLS,
  timed_out: TERMINAL_RUN_CELLS,
};

function isTerminal(entity: GuardEntity, state: string): boolean {
  if (entity === 'task') return state === 'canceled';
  return state === 'succeeded' || state === 'failed' || state === 'canceled' || state === 'timed_out';
}

function matrixFor(entity: GuardEntity): Record<string, Record<string, MatrixCell>> {
  return entity === 'task' ? TASK_MATRIX : RUN_MATRIX;
}

function specRefFor(entity: GuardEntity): '§3.1' | '§3.2' {
  return entity === 'task' ? '§3.1' : '§3.2';
}

function basisOf(cell: MatrixCell, spec_ref: '§3.1' | '§3.2', row: string, col: string): GuardBasis {
  return {
    spec_ref,
    row,
    col,
    cell: cell.cell,
    trigger: cell.trigger,
    requirement: cell.requirement,
    note: cell.note,
  };
}

/**
 * 只校验矩阵格是否允许，不评估前置条件。
 * 用途：PgEventStore.append() 对 TaskLifecycleChanged 的纵深防御（格合法性），
 * 以及 appendStateTransition() 的完整校验（矩阵 + 前置条件）。
 */
export function isMatrixCellAllowed(
  entity: GuardEntity,
  from: string,
  to: string,
): GuardResult {
  const spec_ref = specRefFor(entity);
  const states: readonly string[] = entity === 'task' ? TASK_STATES : RUN_STATES;

  if (!states.includes(from) || !states.includes(to)) {
    return {
      allowed: false,
      basis: { spec_ref, row: from, col: to, cell: '–', note: '未知状态（不在该实体的状态枚举内）' },
      reason: 'unknown_state',
    };
  }

  const cell = matrixFor(entity)[from]?.[to];
  if (!cell) {
    // 表必须逐格完整：缺格是编程错误，大声失败而不是悄悄放行
    throw new Error(`transition matrix incomplete: ${spec_ref} ${from}→${to}`);
  }

  const basis = basisOf(cell, spec_ref, from, to);

  if (from === to) return { allowed: false, basis, reason: 'not_a_transition' };
  if (cell.cell === '–') {
    return {
      allowed: false,
      basis,
      reason: isTerminal(entity, from) ? 'terminal_state' : 'illegal_transition',
    };
  }
  return { allowed: true, basis };
}

/** 完整校验：矩阵格 + 前置条件（facts 缺失即拒）。 */
export function guardTransition(input: GuardTransitionInput): GuardResult {
  const cellCheck = isMatrixCellAllowed(input.entity, input.from, input.to);
  if (!cellCheck.allowed || cellCheck.reason !== undefined) return cellCheck;

  const cell = matrixFor(input.entity)[input.from][input.to];
  const requires = cell.requires ?? [];
  const facts = input.facts ?? {};

  const unmet: string[] = [];
  const unmetRequirements: string[] = [];
  const missingFacts: MissingFactHint[] = [];
  let anyMissing = false;
  for (const requirementId of requires) {
    const state = REQUIREMENTS[requirementId](facts);
    if (state === 'missing') {
      anyMissing = true;
      unmet.push(requirementId);
      missingFacts.push(...missingFactHints(requirementId, facts));
    } else if (state === 'unmet') {
      unmet.push(requirementId);
      unmetRequirements.push(requirementId);
    }
  }

  if (unmet.length > 0) {
    return {
      allowed: false,
      basis: cellCheck.basis,
      reason: anyMissing ? 'precondition_facts_missing' : 'precondition_unmet',
      unmet,
      unmet_requirements: unmetRequirements,
      missing_facts: missingFacts,
    };
  }

  const effects = cell.effects ?? [];
  return {
    allowed: true,
    basis: cellCheck.basis,
    unmet: [],
    unmet_requirements: [],
    missing_facts: [],
    required_effects: effects,
    ...(effects.length > 0 ? { required_effects_basis: 'INV-11' as const } : {}),
  };
}

/**
 * §3.1 wait_state 正交维度（plan §4.4）：
 * - lifecycle ∈ {accepted, canceled}（终态）→ 拒绝（INV-11 已把 wait_state 归 none）；
 * - 其余非终态 → 允许任意合法 wait_state 间迁移（含人工直接置位 blocked/on_hold）；
 * - 自环不算迁移（不产生 TaskWaitStateChanged）。
 * 不编码 REQ-HUM-1 的 human_light 限制（Q6：留后续批次）。
 */
export function guardWaitStateChange(input: {
  lifecycle: string;
  from: string;
  to: string;
  reason?: string;
}): GuardResult {
  const spec_ref = '§3.1';
  const { lifecycle, from, to } = input;

  if (
    !(TASK_STATES as readonly string[]).includes(lifecycle) ||
    !(TASK_WAIT_STATES as readonly string[]).includes(from) ||
    !(TASK_WAIT_STATES as readonly string[]).includes(to)
  ) {
    return {
      allowed: false,
      basis: { spec_ref, row: lifecycle, col: to, cell: '–', note: '未知 lifecycle / wait_state' },
      reason: 'unknown_state',
    };
  }

  if (lifecycle === 'accepted' || lifecycle === 'canceled') {
    return {
      allowed: false,
      basis: {
        spec_ref, row: lifecycle, col: to, cell: '–',
        requirement: 'INV-11',
        note: '终态收尾已把 wait_state 归 none，不得再变更',
      },
      reason: 'terminal_state',
    };
  }

  if (from === to) {
    return {
      allowed: false,
      basis: { spec_ref, row: lifecycle, col: to, cell: '–', note: '自环不算迁移' },
      reason: 'not_a_transition',
    };
  }

  return {
    allowed: true,
    basis: {
      spec_ref, row: lifecycle, col: to, cell: '✓',
      requirement: '§2.2/§3.1 wait_state 正交维度',
      note: 'lifecycle 非终态：wait_state 可叠加/解除，每次变更发 TaskWaitStateChanged',
    },
    unmet: [],
    required_effects: [],
  };
}
