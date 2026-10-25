// REQ-ACC-3：判据级 Acceptance 重算（K0 最小可用命令入口，为 Q11 G1 预备）。
//
// 重算规则逐条对应 spec §2.6：
// - 认「最新有效 Acceptance（未被 supersede）」；
// - accepted → lifecycle=accepted；rejected → lifecycle=defined（重走 ready 判定）；
// - partially_accepted → 停在 awaiting_acceptance，待补集 = 该 Acceptance 中 verdict=failed 的判据；
// - 无有效 Acceptance 且已有 Outcome → awaiting_acceptance。
// 只做判据级重算与一条 lifecycle 迁移提案；C1/C1b 租约对账、G1 全旅程、PlanChange 流水线不在本批。

import type { EventEnvelope, ProjectId } from './events.js';
import type { PgEventStoreTx } from './event-store-pg.js';
import type { GuardFacts } from './transition-guard.js';
import type { TaskLifecycle } from '../domain/types.js';

export type AcceptanceVerdict = 'accepted' | 'rejected' | 'partially_accepted';
export type CriterionVerdict = 'passed' | 'failed' | 'not_applicable';

export interface AcceptanceCriterionResult {
  criterion_ref: string;
  verdict: CriterionVerdict;
}

/** 一条 AcceptanceRecorded 的可判定事实（order = 事件流内顺序，越大越新）。 */
export interface AcceptanceFact {
  acceptance_id: string;
  task_id: string;
  contract_rev: number;
  subject_outcome_id: string | null;
  verdict: AcceptanceVerdict;
  criterion_results: AcceptanceCriterionResult[];
  /** supersede 链路：本 Acceptance 指向它推翻的旧记录。 */
  supersedes_id: string | null;
  order: number;
}

export interface AcceptanceRecomputeInput {
  task_lifecycle: TaskLifecycle;
  /** 当前契约声明的全部 criterion_ref（覆盖完整性校验，REQ-ACC-2 ①）。 */
  contract_criteria: string[];
  acceptances: AcceptanceFact[];
  /** 已被 AcceptanceSuperseded 标记失效的 acceptance_id。 */
  superseded: string[];
  /** 该 Task 是否已有 OutcomeRecorded。 */
  has_outcome: boolean;
}

export interface AcceptanceTransitionProposal {
  from: TaskLifecycle;
  to: TaskLifecycle;
  facts: GuardFacts;
}

export interface AcceptanceRecomputeResult {
  effective_acceptance_id: string | null;
  verdict: AcceptanceVerdict | null;
  /** 重算后的 lifecycle（等于当前值时表示无需迁移）。 */
  target_lifecycle: TaskLifecycle;
  /** partially_accepted 的待补判据（verdict=failed）。 */
  pending_criteria: string[];
  /** 判据级违规：覆盖不完整 / 继承锁定被破坏（不产生迁移）。 */
  violations: string[];
  /** 需要写入的 lifecycle 迁移；null = 无需迁移。 */
  transition: AcceptanceTransitionProposal | null;
}

function transitionFor(
  from: TaskLifecycle,
  to: TaskLifecycle,
): AcceptanceTransitionProposal | null {
  if (from === to) return null;

  if (to === 'accepted') {
    return { from, to, facts: { acceptanceVerdict: 'accepted' } };
  }
  if (to === 'defined') {
    return { from, to, facts: { acceptanceVerdict: 'rejected' } };
  }
  if (to === 'awaiting_acceptance') {
    // active → awaiting_acceptance：Run 出 Outcome（REQ-ACC-3 最后一条）
    if (from === 'active') {
      return { from, to, facts: { runOutcomeRecorded: true } };
    }
    // accepted → awaiting_acceptance：旧验收被 supersede（REQ-ACC-1 唯一例外通道）
    return { from, to, facts: { acceptanceSuperseded: true } };
  }
  // 其余目标不是 Acceptance 重算能产生的；不编造迁移。
  return null;
}

/** 纯函数重算：不读库、不写事件（命令层负责落库）。 */
export function recomputeAcceptance(input: AcceptanceRecomputeInput): AcceptanceRecomputeResult {
  const superseded = new Set(input.superseded);
  const ordered = [...input.acceptances]
    .filter((acceptance) => !superseded.has(acceptance.acceptance_id))
    .sort((a, b) => a.order - b.order);
  const effective = ordered.length > 0 ? ordered[ordered.length - 1] : null;

  if (effective === null) {
    const target: TaskLifecycle =
      input.has_outcome && input.task_lifecycle === 'active'
        ? 'awaiting_acceptance'
        : input.task_lifecycle;
    return {
      effective_acceptance_id: null,
      verdict: null,
      target_lifecycle: target,
      pending_criteria: [],
      violations: [],
      transition: transitionFor(input.task_lifecycle, target),
    };
  }

  const violations: string[] = [];

  // REQ-ACC-2 ①：覆盖完整性——契约的全部 criterion_ref 必须出现在 criterion_results 中
  const covered = new Set(effective.criterion_results.map((item) => item.criterion_ref));
  for (const criterion_ref of input.contract_criteria) {
    if (!covered.has(criterion_ref)) {
      violations.push(`coverage_missing:${criterion_ref}`);
    }
  }

  // REQ-ACC-3 继承锁定：先前 Acceptance 已 passed 的判据，本次置 failed/not_applicable
  // 必须 supersede 旧记录；否则视为违规（不因此产生回退迁移）。
  if (effective.supersedes_id === null) {
    const previouslyPassed = new Map<string, string>();
    for (const acceptance of ordered) {
      if (acceptance.order >= effective.order) continue;
      for (const item of acceptance.criterion_results) {
        if (item.verdict === 'passed') previouslyPassed.set(item.criterion_ref, acceptance.acceptance_id);
      }
    }
    for (const item of effective.criterion_results) {
      if (item.verdict === 'passed') continue;
      if (previouslyPassed.has(item.criterion_ref)) {
        violations.push(`inheritance_lock:${item.criterion_ref}`);
      }
    }
  }

  let target: TaskLifecycle;
  let pending_criteria: string[] = [];

  switch (effective.verdict) {
    case 'accepted':
      target = 'accepted';
      break;
    case 'rejected':
      target = 'defined';
      break;
    case 'partially_accepted':
      target = 'awaiting_acceptance';
      pending_criteria = effective.criterion_results
        .filter((item) => item.verdict === 'failed')
        .map((item) => item.criterion_ref);
      break;
  }

  return {
    effective_acceptance_id: effective.acceptance_id,
    verdict: effective.verdict,
    target_lifecycle: target,
    pending_criteria,
    violations,
    transition: transitionFor(input.task_lifecycle, target),
  };
}

// ---------------------------------------------------------------------------
// 命令入口：从事件流派生事实 → 重算 → （需要时）用既有守卫入口迁移 lifecycle
// ---------------------------------------------------------------------------

export interface RecomputeTaskAcceptanceInput {
  stream_id: ProjectId;
  task_id: string;
  /** 当前契约的 criterion_refs（覆盖完整性校验用）。 */
  contract_criteria: string[];
  actor_id: string;
  actor_kind: EventEnvelope['actor_kind'];
  correlation_id: string;
  causation_id?: string | null;
  idempotency_key?: string | null;
}

export interface RecomputeTaskAcceptanceResult {
  result: AcceptanceRecomputeResult;
  /** 本次写入的 lifecycle 迁移事件；无需迁移时为 null。 */
  event: EventEnvelope | null;
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function criterionResultsOf(value: unknown): AcceptanceCriterionResult[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => payloadRecord(item))
    .filter((item) => typeof item.criterion_ref === 'string')
    .map((item) => ({
      criterion_ref: item.criterion_ref as string,
      verdict: item.verdict as CriterionVerdict,
    }));
}

/** 只读推导：从事件流派生某个 Task 的 Acceptance 重算输入。 */
export async function deriveAcceptanceInput(
  store: PgEventStoreTx,
  stream_id: ProjectId,
  task_id: string,
  contract_criteria: string[],
): Promise<AcceptanceRecomputeInput> {
  const events = await store.readStream(stream_id);

  let lifecycle: TaskLifecycle | null = null;
  let has_outcome = false;
  const acceptances: AcceptanceFact[] = [];
  const superseded: string[] = [];

  for (const event of events) {
    const payload = payloadRecord(event.payload);

    // AcceptanceSuperseded 的 payload 只带 acceptance_id / superseded_by，没有 task_id；
    // 必须在按 Task 过滤之前收集，否则 supersede 链永远不会生效。
    if (event.type === 'AcceptanceSuperseded') {
      if (typeof payload.acceptance_id === 'string') superseded.push(payload.acceptance_id);
      continue;
    }

    if (payload.task_id !== task_id) continue;

    switch (event.type) {
      case 'TaskCaptured':
        lifecycle = 'captured';
        break;
      case 'TaskLifecycleChanged':
        if (typeof payload.to === 'string') lifecycle = payload.to as TaskLifecycle;
        break;
      case 'OutcomeRecorded':
        has_outcome = true;
        break;
      case 'AcceptanceRecorded':
        if (typeof payload.acceptance_id === 'string' && typeof payload.verdict === 'string') {
          acceptances.push({
            acceptance_id: payload.acceptance_id,
            task_id,
            contract_rev: typeof payload.contract_rev === 'number' ? payload.contract_rev : 0,
            subject_outcome_id:
              typeof payload.subject_outcome_id === 'string' ? payload.subject_outcome_id : null,
            verdict: payload.verdict as AcceptanceVerdict,
            criterion_results: criterionResultsOf(payload.criterion_results),
            supersedes_id: typeof payload.supersedes_id === 'string' ? payload.supersedes_id : null,
            order: event.seq,
          });
        }
        break;
      default:
        break;
    }
  }

  if (lifecycle === null) {
    throw new AcceptanceRecomputeError(`stream 内没有 Task ${task_id} 的创建/生命周期事件`);
  }

  return {
    task_lifecycle: lifecycle,
    contract_criteria,
    acceptances,
    superseded,
    has_outcome,
  };
}

export class AcceptanceRecomputeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcceptanceRecomputeError';
  }
}

/** 命令入口：派生事实 → 重算 → 需要时经 appendStateTransition 迁移 lifecycle。 */
export async function recomputeTaskAcceptance(
  store: PgEventStoreTx,
  input: RecomputeTaskAcceptanceInput,
): Promise<RecomputeTaskAcceptanceResult> {
  const derived = await deriveAcceptanceInput(
    store,
    input.stream_id,
    input.task_id,
    input.contract_criteria,
  );
  const result = recomputeAcceptance(derived);
  if (result.transition === null) return { result, event: null };

  const trigger_event_id =
    input.causation_id
    ?? result.effective_acceptance_id
    ?? `acceptance_recompute:${input.task_id}:${result.target_lifecycle}`;

  const { event } = await store.appendStateTransition({
    stream_id: input.stream_id,
    type: 'TaskLifecycleChanged',
    entity: 'task',
    from: result.transition.from,
    to: result.transition.to,
    facts: result.transition.facts,
    actor_id: input.actor_id,
    actor_kind: input.actor_kind,
    causation_id: input.causation_id ?? null,
    correlation_id: input.correlation_id,
    idempotency_key: input.idempotency_key ?? null,
    trigger_event_id,
    payload: { task_id: input.task_id },
  });

  return { result, event };
}
