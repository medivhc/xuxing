// 状态迁移矩阵校验器 —— 纯函数、无 IO。
// 唯一依据：spec/K0-SPEC-FROZEN-v1.0.md §3.1（Task 主生命周期）、§3.2（Run 状态）、
// §3.1 INV-11（终态收尾）、§4（事件目录与派生规则）、REQ-RUN-4、REQ-RUN-6、
// REQ-SCH-1（ready 公式）。
//
// 设计约束（spec §3 迁移矩阵 / §4 事件目录）：
// - 每格显式存在（✓ 与 – 都写），不用「缺省即拒绝」造成不可追溯；
// - ✓ 格的 trigger 必须写明触发事件语义，前置条件逐条带 spec 原句落点；
// - 每格允许的触发事件类型必须显式（F6：created→queued 不许配 RunSucceeded）；
// - 未知状态（编程错误）/ 自环 / 矩阵 ✗ 三类拒绝必须可区分；
// - 前置条件 fact 缺失一律 precondition_facts_missing，不默认放行也不默认拒绝。
// 本模块不写事件、不读库：是否落事件由调用方（PgEventStore.appendStateTransition）决定。
// 注意：本模块的 facts 是「可判定输入」，生产写路径必须从事件流派生客观 fact
// （见 event-store-pg.ts deriveStreamFacts），不能只信调用方自述。

import type { EventType } from './events.js';
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
  | 'event_type_mismatch'
  | 'unknown_state';

export type GuardEffect =
  // INV-11：迁入 accepted/canceled 时按序执行
  | 'cancel_active_wait_conditions'
  | 'reset_wait_state_none'
  // REQ-RUN-6①：记取消意图时级联收尾
  | 'expire_pending_decisions'
  | 'end_active_assignments'
  // REQ-RUN-6③：正式取消
  | 'emit_task_canceled';

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
  // §3.1 defined→ready（REQ-SCH-1 ready 公式逐项）
  dependenciesSatisfied?: boolean;
  dataInputsAvailable?: boolean;
  waitStateNone?: boolean;
  duplicateSuspectFalse?: boolean;
  capabilityAvailable?: boolean;
  policyAllows?: boolean;
  // §3.1 ready→active
  runDispatched?: boolean;
  // §3.1 active→awaiting_acceptance（F3：Run 已产出 Outcome）
  runOutcomeRecorded?: boolean;
  // §3.1 awaiting_acceptance / accepted
  acceptanceVerdict?: 'accepted' | 'rejected' | 'partially_accepted';
  needsReexecution?: boolean;
  acceptanceSuperseded?: boolean;
  declaresRevalidation?: boolean;
  // §3.1 / REQ-RUN-6：取消意图与 Run 收尾
  cancellationRequested?: boolean;
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
  heartbeatLost?: boolean;
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
  /** 该格允许的触发事件类型；event_type_mismatch 时供调用方比对。 */
  expected_event_types?: EventType[];
  /** INV-11 / REQ-RUN-6：迁入 accepted/canceled 时内核须同事务执行的收尾动作（按序）。 */
  required_effects?: GuardEffect[];
  required_effects_basis?: 'INV-11' | 'REQ-RUN-6';
}

export interface GuardTransitionInput {
  entity: GuardEntity;
  from: string;
  to: string;
  event_type: string;
  facts?: GuardFacts;
  /**
   * S3-①：Run 的状态机分两种运行形态。缺省 executor 走 spec §3.2 矩阵；
   * human_light 走 REQ-HUM-1 的 created → running → succeeded/failed/canceled
   * （无租约/排队/超时/indeterminate）。该值由事件流派生（RunCreated.payload.run_kind）。
   */
  run_kind?: 'executor' | 'human_light';
}

interface MatrixCell {
  cell: '✓' | '–';
  trigger?: string;
  requirement?: string;
  requires?: RequirementId[];
  note?: string;
  effects?: GuardEffect[];
  /** F6：该迁移允许的触发事件类型（封闭；不允许仅凭 entity 家族放行）。 */
  event_types?: EventType[];
}

// ---------------------------------------------------------------------------
// 前置条件（只编码 spec 明文写死的条件）
// ---------------------------------------------------------------------------

type RequirementId =
  | 'hasTitle'
  | 'agentContractStructured'
  // REQ-SCH-1
  | 'dependenciesSatisfied'
  | 'dataInputsAvailable'
  | 'waitStateNone'
  | 'duplicateSuspectFalse'
  | 'capabilityAvailable'
  | 'policyAllows'
  // §3.1 ready→active / active→awaiting_acceptance
  | 'runDispatched'
  | 'runOutcomeRecorded'
  // 验收
  | 'acceptanceRejected'
  | 'reexecutionNeeded'
  | 'acceptanceAccepted'
  | 'acceptanceInvalidated'
  // 取消（REQ-RUN-6）
  | 'cancellationRequested'
  | 'allRunsTerminal'
  | 'runNotStarted'
  // REQ-RUN-4
  | 'leaseExpiredNotStarted'
  | 'leaseExpiredStartedLowSideEffect'
  | 'leaseExpiredStartedHighSideEffect'
  | 'timeoutNoSideEffectResidue'
  | 'cancelAcknowledged'
  | 'heartbeatLost'
  // REQ-RUN-3
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

/**
 * 三值 OR（F9）：任一项为 met 即 met，即使另一项缺 fact。
 * 只有「没有 met 且存在 missing」才返回 missing，避免把 OR 误判成 AND。
 */
function anyOf(...states: FactState[]): FactState {
  if (states.includes('met')) return 'met';
  if (states.includes('missing')) return 'missing';
  return 'unmet';
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
  // REQ-SCH-1 ready 公式：depends_on 全部满足
  dependenciesSatisfied: (f) => flag(f.dependenciesSatisfied),
  // REQ-SCH-1：data_from 可用（pinned 版本存在 / latest_accepted 指针非空）
  dataInputsAvailable: (f) => flag(f.dataInputsAvailable),
  // REQ-SCH-1：wait_state=none
  waitStateNone: (f) => flag(f.waitStateNone),
  // REQ-SCH-1：duplicate_suspect=false
  duplicateSuspectFalse: (f) => flag(f.duplicateSuspectFalse),
  // REQ-SCH-1 / REQ-SCH-4：存在具备能力的在册 actor
  capabilityAvailable: (f) => flag(f.capabilityAvailable),
  // REQ-SCH-1：Policy 未拦截
  policyAllows: (f) => flag(f.policyAllows),
  // §3.1 ready→active「派发 Run」
  runDispatched: (f) => flag(f.runDispatched),
  // §3.1 active→awaiting_acceptance「Run 出 Outcome」（F3）
  runOutcomeRecorded: (f) => flag(f.runOutcomeRecorded),
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
  // F10：OR 语义——任一为 true 即 met；均 false 才 unmet；任一未知且无 true 则 missing。
  acceptanceInvalidated: (f) => {
    if (f.acceptanceSuperseded === true || f.declaresRevalidation === true) return 'met';
    if (f.acceptanceSuperseded === false && f.declaresRevalidation === false) return 'unmet';
    return 'missing';
  },
  // REQ-RUN-6①「先记取消意图（TaskCancelRequested）」
  cancellationRequested: (f) => flag(f.cancellationRequested),
  // REQ-RUN-6③「全部 Run 达终态后才正式 canceled」
  allRunsTerminal: (f) => flag(f.allRunsTerminal),
  // REQ-RUN-6②「created/queued/leased 未启动的 Run 直接置 canceled」——
  // 已启动（有 RunStarted）的 Run 不得从 leased 直接 canceled（F4）。
  runNotStarted: (f) => negatedFlag(f.started),
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
  // 「已启动且（L2/L3 或已有外部副作用调用记录）」——OR，不是 AND（F9）
  leaseExpiredStartedHighSideEffect: (f) =>
    all(
      flag(f.leaseExpired),
      flag(f.started),
      anyOf(
        fromSet(f.sideEffectLevel, ['L2', 'L3'] as const),
        flag(f.externalSideEffectCalled),
      ),
    ),
  // 「超时且确认无副作用残留」
  timeoutNoSideEffectResidue: (f) =>
    all(flag(f.runTimeoutExceeded), fromSet(f.sideEffectResidue, ['none'] as const)),
  // 「取消确认后」
  cancelAcknowledged: (f) => flag(f.cancelAcknowledged),
  // §3.2 running→indeterminate「心跳丢失/进程崩溃」
  heartbeatLost: (f) => flag(f.heartbeatLost),
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
    case 'dependenciesSatisfied':
      add('dependenciesSatisfied', 'dependenciesSatisfied=true', facts.dependenciesSatisfied);
      break;
    case 'dataInputsAvailable':
      add('dataInputsAvailable', 'dataInputsAvailable=true', facts.dataInputsAvailable);
      break;
    case 'waitStateNone':
      add('waitStateNone', 'waitStateNone=true', facts.waitStateNone);
      break;
    case 'duplicateSuspectFalse':
      add('duplicateSuspectFalse', 'duplicateSuspectFalse=true', facts.duplicateSuspectFalse);
      break;
    case 'capabilityAvailable':
      add('capabilityAvailable', 'capabilityAvailable=true', facts.capabilityAvailable);
      break;
    case 'policyAllows':
      add('policyAllows', 'policyAllows=true', facts.policyAllows);
      break;
    case 'runDispatched':
      add('runDispatched', 'runDispatched=true', facts.runDispatched);
      break;
    case 'runOutcomeRecorded':
      add('runOutcomeRecorded', 'runOutcomeRecorded=true', facts.runOutcomeRecorded);
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
    case 'acceptanceInvalidated': {
      // F10：只提示真正缺的那一侧；两侧都缺时给一条带 alternatives 的提示。
      const superseded = facts.acceptanceSuperseded;
      const revalidation = facts.declaresRevalidation;
      if (superseded === undefined) {
        hints.push({
          requirement: requirementId,
          fact: 'acceptanceSuperseded',
          expected: 'acceptanceSuperseded=true 或 declaresRevalidation=true',
          alternatives: ['declaresRevalidation'],
        });
      } else if (revalidation === undefined) {
        hints.push({
          requirement: requirementId,
          fact: 'declaresRevalidation',
          expected: 'declaresRevalidation=true 或 acceptanceSuperseded=true',
          alternatives: ['acceptanceSuperseded'],
        });
      }
      break;
    }
    case 'cancellationRequested':
      add(
        'cancellationRequested',
        'cancellationRequested=true（先发 TaskCancelRequested）',
        facts.cancellationRequested,
      );
      break;
    case 'allRunsTerminal':
      add('allRunsTerminal', 'allRunsTerminal=true', facts.allRunsTerminal);
      break;
    case 'runNotStarted':
      add('started', 'started=false', facts.started);
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
    case 'leaseExpiredStartedHighSideEffect': {
      add('leaseExpired', 'leaseExpired=true', facts.leaseExpired);
      add('started', 'started=true', facts.started);
      // OR 条件（F9）：sideEffectLevel 已是 L2/L3 时不需要副作用记录；反之亦然。
      const highKnown = facts.sideEffectLevel === 'L2' || facts.sideEffectLevel === 'L3';
      const externalKnown = facts.externalSideEffectCalled === true;
      if (!highKnown && !externalKnown) {
        add(
          'sideEffectLevel',
          "sideEffectLevel='L2'|'L3' 或 externalSideEffectCalled=true",
          facts.sideEffectLevel,
        );
        add(
          'externalSideEffectCalled',
          'externalSideEffectCalled=true（与 sideEffectLevel 满足其一即可）',
          facts.externalSideEffectCalled,
        );
      }
      break;
    }
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
    case 'heartbeatLost':
      add('heartbeatLost', 'heartbeatLost=true', facts.heartbeatLost);
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

const TASK_TRANSITION_EVENT: EventType[] = ['TaskLifecycleChanged'];

const INV11_EFFECTS: GuardEffect[] = ['cancel_active_wait_conditions', 'reset_wait_state_none'];

/** REQ-RUN-6 三步：① 级联收尾 Decision/Assignment → ② Run 达终态（外部保证）→ ③ 收尾并正式取消。 */
const CANCEL_EFFECTS: GuardEffect[] = [
  'expire_pending_decisions',
  'end_active_assignments',
  'cancel_active_wait_conditions',
  'reset_wait_state_none',
  'emit_task_canceled',
];

const TASK_MATRIX: Record<string, Record<string, MatrixCell>> = {
  captured: {
    defined: {
      cell: '✓', trigger: '定义完成', requirement: 'REQ-TC-1',
      requires: ['hasTitle', 'agentContractStructured'],
      event_types: TASK_TRANSITION_EVENT,
    },
    ready: { cell: '–', note: '未定义不可就绪' },
    active: { cell: '–', note: '未就绪不可派发' },
    awaiting_acceptance: { cell: '–', note: '未执行无 Outcome' },
    accepted: { cell: '–', note: '未执行不可验收' },
    canceled: {
      cell: '✓', trigger: '取消（先记取消意图，全部 Run 达终态后收尾）',
      requirement: 'REQ-RUN-6',
      requires: ['cancellationRequested', 'allRunsTerminal'],
      effects: CANCEL_EFFECTS, event_types: TASK_TRANSITION_EVENT,
    },
  },
  defined: {
    defined: { cell: '–', note: '自环：契约/文本修订，不算迁移' },
    ready: {
      cell: '✓', trigger: '依赖满足（REQ-SCH-1 全公式）', requirement: 'REQ-SCH-1',
      requires: [
        'dependenciesSatisfied',
        'dataInputsAvailable',
        'waitStateNone',
        'duplicateSuspectFalse',
        'capabilityAvailable',
        'policyAllows',
      ],
      event_types: TASK_TRANSITION_EVENT,
    },
    active: { cell: '–', note: '未经 ready 不可派发' },
    awaiting_acceptance: { cell: '–', note: '未执行无 Outcome' },
    accepted: { cell: '–', note: '未验收不可 accepted' },
    canceled: {
      cell: '✓', trigger: '取消（先记取消意图，全部 Run 达终态后收尾）',
      requirement: 'REQ-RUN-6',
      requires: ['cancellationRequested', 'allRunsTerminal'],
      effects: CANCEL_EFFECTS, event_types: TASK_TRANSITION_EVENT,
    },
  },
  ready: {
    defined: {
      cell: '✓', trigger: '依赖回退', requirement: 'REQ-SCH-1',
      event_types: TASK_TRANSITION_EVENT,
    },
    ready: { cell: '–', note: '自环不算迁移' },
    active: {
      cell: '✓', trigger: '派发 Run', requirement: 'REQ-RUN-1/REQ-SCH-1',
      requires: ['runDispatched'],
      event_types: TASK_TRANSITION_EVENT,
    },
    awaiting_acceptance: { cell: '–', note: '未执行无 Outcome' },
    accepted: { cell: '–', note: '未验收不可 accepted' },
    canceled: {
      cell: '✓', trigger: '取消（先记取消意图，全部 Run 达终态后收尾）',
      requirement: 'REQ-RUN-6',
      requires: ['cancellationRequested', 'allRunsTerminal'],
      effects: CANCEL_EFFECTS, event_types: TASK_TRANSITION_EVENT,
    },
  },
  active: {
    defined: { cell: '–', note: 'Run 在跑不可回 defined' },
    ready: { cell: '–', note: 'Run 在跑不可回 ready' },
    active: { cell: '–', note: '自环不算迁移' },
    awaiting_acceptance: {
      cell: '✓', trigger: 'Run 出 Outcome', requirement: 'REQ-ACC-3',
      requires: ['runOutcomeRecorded'],
      event_types: TASK_TRANSITION_EVENT,
    },
    accepted: { cell: '–', note: '须先经 awaiting_acceptance 验收' },
    canceled: {
      cell: '✓', trigger: '取消级联收尾（全部 Run 达终态）', requirement: 'REQ-RUN-6',
      requires: ['cancellationRequested', 'allRunsTerminal'],
      effects: CANCEL_EFFECTS, event_types: TASK_TRANSITION_EVENT,
    },
  },
  awaiting_acceptance: {
    defined: {
      cell: '✓', trigger: '验收 rejected', requirement: 'REQ-ACC-3',
      requires: ['acceptanceRejected'],
      event_types: TASK_TRANSITION_EVENT,
    },
    ready: { cell: '–', note: 'rejected 后回 defined 重走 ready 判定' },
    active: {
      cell: '✓',
      trigger: '验收 rejected 且需再执行；或 partially_accepted 且未过判据需再执行（S4）',
      requirement: 'REQ-ACC-3', requires: ['reexecutionNeeded'],
      event_types: TASK_TRANSITION_EVENT,
    },
    awaiting_acceptance: { cell: '–', note: '自环不算迁移' },
    accepted: {
      cell: '✓', trigger: '验收 accepted', requirement: 'REQ-ACC-3',
      requires: ['acceptanceAccepted'], effects: INV11_EFFECTS,
      event_types: TASK_TRANSITION_EVENT,
    },
    canceled: {
      cell: '✓', trigger: '取消（先记取消意图，全部 Run 达终态后收尾）',
      requirement: 'REQ-RUN-6',
      requires: ['cancellationRequested', 'allRunsTerminal'],
      effects: CANCEL_EFFECTS, event_types: TASK_TRANSITION_EVENT,
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
      event_types: TASK_TRANSITION_EVENT,
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
    queued: {
      cell: '✓', trigger: '排入队列', note: '创建即入队', event_types: ['RunQueued'],
    },
    leased: { cell: '–', note: '未经队列不可领取' },
    running: { cell: '–', note: '未经租约不可启动' },
    succeeded: { cell: '–', note: '未执行不可成功' },
    failed: { cell: '–', note: '未执行不可失败' },
    canceled: {
      cell: '✓', trigger: '未启动直接取消（REQ-RUN-6②）', requirement: 'REQ-RUN-6',
      requires: ['cancellationRequested'], event_types: ['RunCanceled'],
    },
    timed_out: { cell: '–', note: '未启动无超时' },
    indeterminate: { cell: '–', note: '未启动无副作用，不进 indeterminate' },
  },
  queued: {
    queued: { cell: '–', note: '自环不算迁移' },
    leased: {
      cell: '✓', trigger: '领取（分配租约）', requirement: 'REQ-RUN-1',
      event_types: ['RunLeased'],
    },
    running: { cell: '–', note: '未经租约不可启动' },
    succeeded: { cell: '–', note: '未执行不可成功' },
    failed: { cell: '–', note: '未执行不可失败' },
    canceled: {
      cell: '✓', trigger: '未启动直接取消（REQ-RUN-6②）', requirement: 'REQ-RUN-6',
      requires: ['cancellationRequested'], event_types: ['RunCanceled'],
    },
    timed_out: { cell: '–', note: '未启动无超时' },
    indeterminate: { cell: '–', note: '未启动无副作用，不进 indeterminate' },
  },
  leased: {
    queued: {
      cell: '✓', trigger: '租约过期未启动（分界见 REQ-RUN-4）', requirement: 'REQ-RUN-4',
      requires: ['leaseExpiredNotStarted'], event_types: ['RunQueued'],
    },
    leased: { cell: '–', note: '自环不算迁移' },
    running: {
      cell: '✓', trigger: '启动回报', requirement: 'REQ-RUN-1',
      event_types: ['RunStarted'],
    },
    succeeded: { cell: '–', note: '须先启动' },
    failed: {
      cell: '✓',
      trigger: '租约过期且已启动 + L0/L1 + 无外部副作用调用记录',
      requirement: 'REQ-RUN-4', requires: ['leaseExpiredStartedLowSideEffect'],
      event_types: ['RunFailed'],
    },
    canceled: {
      cell: '✓', trigger: '未启动直接取消（REQ-RUN-6②；已启动不得走此格）',
      requirement: 'REQ-RUN-6',
      requires: ['cancellationRequested', 'runNotStarted'],
      event_types: ['RunCanceled'],
    },
    timed_out: { cell: '–', note: '超时自 RunStarted 起算' },
    indeterminate: {
      cell: '✓',
      trigger: '租约过期且已启动 + L2/L3 或已有外部副作用调用记录',
      requirement: 'REQ-RUN-4', requires: ['leaseExpiredStartedHighSideEffect'],
      event_types: ['RunIndeterminate'],
    },
  },
  running: {
    queued: { cell: '–', note: '禁止复用旧 Run 记录回 queued（INV-4）' },
    leased: { cell: '–', note: '已启动不可回 leased' },
    running: { cell: '–', note: '自环不算迁移' },
    succeeded: { cell: '✓', trigger: '执行成功回报', event_types: ['RunSucceeded'] },
    failed: { cell: '✓', trigger: '执行失败回报', event_types: ['RunFailed'] },
    canceled: {
      cell: '✓', trigger: '取消确认后', requirement: 'REQ-RUN-6',
      requires: ['cancellationRequested', 'cancelAcknowledged'],
      event_types: ['RunCanceled'],
    },
    timed_out: {
      cell: '✓', trigger: '超时且确认无副作用残留', requirement: 'REQ-RUN-4',
      requires: ['timeoutNoSideEffectResidue'], event_types: ['RunTimedOut'],
    },
    indeterminate: {
      cell: '✓', trigger: '心跳丢失/进程崩溃', requirement: 'REQ-RUN-4',
      requires: ['heartbeatLost'], event_types: ['RunIndeterminate'],
    },
  },
  indeterminate: {
    queued: { cell: '–', note: '对账不改变 Run 身份（INV-4）' },
    leased: { cell: '–', note: '不可重新领取旧 Run' },
    running: { cell: '–', note: '对账不回到执行中' },
    succeeded: {
      cell: '✓', trigger: '对账确认已完成（补录 RawResult）', requirement: 'REQ-RUN-3',
      requires: ['reconciliationCompleted'], event_types: ['RunSucceeded'],
    },
    failed: {
      cell: '✓', trigger: '对账确认未执行或已失败', requirement: 'REQ-RUN-3',
      requires: ['reconciliationFailed'], event_types: ['RunFailed'],
    },
    canceled: {
      cell: '✓', trigger: '对账后人工取消', requirement: 'REQ-RUN-3',
      requires: ['reconciliationConcluded'], event_types: ['RunCanceled'],
    },
    timed_out: { cell: '–', note: '对账结论不含超时' },
    indeterminate: { cell: '–', note: '自环不算迁移' },
  },
  succeeded: TERMINAL_RUN_CELLS,
  failed: TERMINAL_RUN_CELLS,
  canceled: TERMINAL_RUN_CELLS,
  timed_out: TERMINAL_RUN_CELLS,
};

/**
 * REQ-HUM-1（S3）：human_light Run 只走 created → running → succeeded/failed/canceled，
 * 不出现 queued/leased/indeterminate/timed_out。§3.2 矩阵描述的是 executor Run 的租约状态机，
 * 这里按 spec 明文补上人机轻量形态的格，避免命令层被迫绕过 guard。
 */
const HUMAN_LIGHT_RUN_MATRIX: Record<string, Record<string, MatrixCell>> = {
  created: {
    queued: { cell: '–', note: 'human_light 无排队（REQ-HUM-1）' },
    leased: { cell: '–', note: 'human_light 无租约（REQ-HUM-1）' },
    running: {
      cell: '✓', trigger: '人类开始执行', requirement: 'REQ-HUM-1',
      event_types: ['RunStarted'],
    },
    succeeded: { cell: '–', note: '未执行不可成功' },
    failed: { cell: '–', note: '未执行不可失败' },
    canceled: {
      cell: '✓', trigger: '未开始直接取消（human_light 无确认环节）',
      requirement: 'REQ-HUM-1/REQ-RUN-6', event_types: ['RunCanceled'],
    },
    timed_out: { cell: '–', note: 'human_light 无超时（REQ-HUM-1）' },
    indeterminate: { cell: '–', note: 'human_light 不进 indeterminate（REQ-HUM-1）' },
  },
  running: {
    queued: { cell: '–', note: 'human_light 无排队（REQ-HUM-1）' },
    leased: { cell: '–', note: 'human_light 无租约（REQ-HUM-1）' },
    running: { cell: '–', note: '自环不算迁移' },
    succeeded: {
      cell: '✓', trigger: '绑定该 Run 的 Outcome 入账', requirement: 'REQ-HUM-1/REQ-HUM-2',
      event_types: ['RunSucceeded'],
    },
    failed: { cell: '✓', trigger: '人类执行失败回报', event_types: ['RunFailed'] },
    canceled: {
      cell: '✓', trigger: 'human_light 取消无确认环节，直接 canceled',
      requirement: 'REQ-HUM-1/REQ-RUN-6', event_types: ['RunCanceled'],
    },
    timed_out: { cell: '–', note: 'human_light 无超时（REQ-HUM-1）' },
    indeterminate: { cell: '–', note: 'human_light 不进 indeterminate（REQ-HUM-1）' },
  },
};

function runMatrixFor(runKind: 'executor' | 'human_light' | undefined): Record<string, Record<string, MatrixCell>> {
  // human_light 只有 created/running 两行有专门格；其余行（终态等）沿用 executor 的「不可再迁移」。
  if (runKind !== 'human_light') return RUN_MATRIX;
  return { ...RUN_MATRIX, ...HUMAN_LIGHT_RUN_MATRIX };
}

function isTerminal(entity: GuardEntity, state: string): boolean {
  if (entity === 'task') return state === 'canceled';
  return state === 'succeeded' || state === 'failed' || state === 'canceled' || state === 'timed_out';
}

function matrixFor(
  entity: GuardEntity,
  runKind?: 'executor' | 'human_light',
): Record<string, Record<string, MatrixCell>> {
  return entity === 'task' ? TASK_MATRIX : runMatrixFor(runKind);
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
 * 以及 appendStateTransition() 的完整校验（矩阵 + 前置条件 + 事件类型）。
 */
export function isMatrixCellAllowed(
  entity: GuardEntity,
  from: string,
  to: string,
  runKind?: 'executor' | 'human_light',
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

  const cell = matrixFor(entity, runKind)[from]?.[to];
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

/** 完整校验：矩阵格 + 触发事件类型（F6）+ 前置条件（facts 缺失即拒）。 */
export function guardTransition(input: GuardTransitionInput): GuardResult {
  const cellCheck = isMatrixCellAllowed(input.entity, input.from, input.to, input.run_kind);
  if (!cellCheck.allowed || cellCheck.reason !== undefined) return cellCheck;

  const cell = matrixFor(input.entity, input.run_kind)[input.from][input.to];

  // F6：事件类型必须与该迁移匹配（「created→queued 不许配 RunSucceeded」）。
  const expectedTypes = cell.event_types ?? [];
  if (expectedTypes.length > 0 && !expectedTypes.includes(input.event_type as EventType)) {
    return {
      allowed: false,
      basis: cellCheck.basis,
      reason: 'event_type_mismatch',
      expected_event_types: expectedTypes,
    };
  }

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
  const basis = input.to === 'canceled' && input.entity === 'task' ? 'REQ-RUN-6' : 'INV-11';
  return {
    allowed: true,
    basis: cellCheck.basis,
    unmet: [],
    unmet_requirements: [],
    missing_facts: [],
    required_effects: effects,
    ...(effects.length > 0 ? { required_effects_basis: basis as 'INV-11' | 'REQ-RUN-6' } : {}),
  };
}

/**
 * 幂等重放专用：事件已存在于流中时，不再重跑前置条件（当时的 fact 已不可复原），
 * 只还原该格的依据与收尾声明。仅供 EventStore 复读首次结果使用，不做准入判定。
 */
export function guardTransitionReplay(input: {
  entity: GuardEntity;
  from: string;
  to: string;
  event_type: string;
  run_kind?: 'executor' | 'human_light';
}): GuardResult {
  const cellCheck = isMatrixCellAllowed(input.entity, input.from, input.to, input.run_kind);
  if (!cellCheck.allowed || cellCheck.reason !== undefined) return cellCheck;

  const cell = matrixFor(input.entity, input.run_kind)[input.from][input.to];
  const expectedTypes = cell.event_types ?? [];
  if (expectedTypes.length > 0 && !expectedTypes.includes(input.event_type as EventType)) {
    return {
      allowed: false,
      basis: cellCheck.basis,
      reason: 'event_type_mismatch',
      expected_event_types: expectedTypes,
    };
  }

  const effects = cell.effects ?? [];
  const basis = input.to === 'canceled' && input.entity === 'task' ? 'REQ-RUN-6' : 'INV-11';
  return {
    allowed: true,
    basis: cellCheck.basis,
    unmet: [],
    unmet_requirements: [],
    missing_facts: [],
    required_effects: effects,
    ...(effects.length > 0 ? { required_effects_basis: basis as 'INV-11' | 'REQ-RUN-6' } : {}),
  };
}

/**
 * §3.1 wait_state 正交维度：
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
