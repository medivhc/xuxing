// D9 旅程即测试 —— spec 校验规则的**测试侧**编码（PLAN ENGINE / ACCEPTANCE 内核模块尚未实现）。
//
// 诚实声明（重要）：
// - src/kernel 目前只有 Event Store + 迁移矩阵校验器；Plan Engine（§5.1 REQ-PC）、
//   Scheduler ready 判定（§5.2 REQ-SCH）、Acceptance 重算（§2.6 REQ-ACC）尚未落地。
// - 因此本文件的规则是把冻结 spec 的判定顺序与结论**写成可执行断言**，
//   用来钉住「内核实现完成后必须产出这样的事件流」；它们**不是**对生产代码的调用。
//   内核实现落地后，应把这里换成生产 API（见 tests/e2e/README.md 的启用条件）。
// - 事件流本身的约束（哈希链、幂等、迁移矩阵、终态收尾、append-only）全部由真内核 store 执行。
//
// 规则出处逐条标注：REQ-PC-1/2/3/5/6、INV-2、INV-8、REQ-SCH-1/2/4、REQ-TC-1、REQ-ACC-1/2/3/4、S4。

import type { SideEffectLevel } from '../../../src/domain/types.js';
import { WAIT_STATE_BY_CONDITION_KIND } from '../../../src/kernel/transition-guard.js';
import {
  sideEffectRank,
  type JOp,
  type JourneyProjection,
} from './journey-projection.js';

// ---------------------------------------------------------------------------
// PlanChange 校验流水线（REQ-PC-1：顺序固定，全通过才应用）
// ---------------------------------------------------------------------------

/** §5.1 REQ-PC-3 原因码封闭枚举（budget_exceeded 已删除，K1 随拦截引入）。 */
export type PlanChangeReasonCode =
  | 'schema_invalid'
  | 'base_rev_conflict'
  | 'dag_cycle'
  | 'illegal_edge'
  | 'policy_denied'
  | 'duplicate'
  | 'superseded_by_decision'
  | 'decision_rejected'
  | 'decision_expired';

/** §2.7 ops 封闭枚举。 */
export const PLAN_CHANGE_OPS = [
  'add_task',
  'update_task_text',
  'add_edge',
  'remove_edge',
  'reassign',
  'update_contract',
  'cancel_task',
  'add_wait',
] as const;

export type PlanChangeOpKind = (typeof PLAN_CHANGE_OPS)[number];

/** §2.3 edge kind 封闭枚举。 */
export const EDGE_KINDS = [
  'depends_on',
  'data_from',
  'part_of',
  'related_to',
  'conflicts_with',
  'supersedes',
] as const;

export interface PlanChangeDraft {
  change_id: string;
  client_proposal_id: string;
  proposer_id: string;
  base_plan_rev: number;
  risk_level: SideEffectLevel;
  estimated_budget: number;
  rationale: string;
  assumptions: string[];
  ops: JOp[];
  /** REQ-PC-5（approved_modified）：新 Change 取代旧 Change 时指向旧 change_id；其余情形不填。 */
  supersedes_change_id?: string | null;
}

export interface PlanChangeVerdict {
  ok: boolean;
  /** 校验停在哪一步（REQ-PC-1 的顺序可追溯）。 */
  stage: 'schema' | 'base_rev' | 'graph' | 'policy' | 'budget' | 'idempotency' | 'applied';
  reason_code: PlanChangeReasonCode | null;
  /** 是否属「可由人裁决」类（REQ-PC-3：权限/风险超限、版本冲突 → Decision；结构错误 → rejected）。 */
  decision_eligible: boolean;
  detail: string;
  /** 三方差异基线（REQ-PC-1 base_rev_conflict 时返回：基线/当前/提议）。 */
  conflict_baseline?: { base_plan_rev: number; current_plan_rev: number; proposed: PlanChangeDraft };
  /** REQ-PC-6：预算关口恒通过、只记账。 */
  budget_ledgered: boolean;
}

function fail(
  stage: PlanChangeVerdict['stage'],
  reason_code: PlanChangeReasonCode,
  decision_eligible: boolean,
  detail: string,
  extra: Partial<PlanChangeVerdict> = {},
): PlanChangeVerdict {
  return {
    ok: false, stage, reason_code, decision_eligible, detail,
    budget_ledgered: false, ...extra,
  };
}

/** ① Schema：op kind 属封闭枚举 + 必填字段齐 + 不许夹带直接改状态。 */
function checkSchema(draft: PlanChangeDraft): PlanChangeVerdict | null {
  for (const op of draft.ops) {
    if (!(PLAN_CHANGE_OPS as readonly string[]).includes(op.op)) {
      return fail('schema', 'schema_invalid', false, `未知 op：${JSON.stringify(op.op)}（§2.7 封闭枚举）`);
    }
    switch (op.op) {
      case 'add_task':
        if (typeof op.task_id !== 'string' || typeof op.title !== 'string') {
          return fail('schema', 'schema_invalid', false, `add_task 缺 task_id/title：${op.task_id}`);
        }
        // 状态只能由事件派生：op 里出现 lifecycle/wait_state 直写即结构错误
        if ('lifecycle' in op || 'wait_state' in op) {
          return fail('schema', 'schema_invalid', false, `add_task 不得直写 lifecycle/wait_state（§4 派生规则声明）`);
        }
        break;
      case 'add_edge':
        if (typeof op.edge_id !== 'string' || typeof op.from_task !== 'string' || typeof op.to_task !== 'string') {
          return fail('schema', 'schema_invalid', false, 'add_edge 缺 edge_id/from_task/to_task');
        }
        break;
      case 'remove_edge':
        if (typeof op.edge_id !== 'string') return fail('schema', 'schema_invalid', false, 'remove_edge 缺 edge_id');
        break;
      case 'add_wait':
        if (typeof op.wait_condition_id !== 'string' || typeof op.task_id !== 'string' ||
          typeof op.wait_kind !== 'string' || typeof op.target_ref !== 'string') {
          return fail('schema', 'schema_invalid', false, 'add_wait 缺 wait_condition_id/task_id/wait_kind/target_ref');
        }
        if (!(op.wait_kind in WAIT_STATE_BY_CONDITION_KIND)) {
          return fail('schema', 'schema_invalid', false, `wait_kind 不在 §3.1 映射表内：${op.wait_kind}`);
        }
        break;
      case 'update_contract':
        if (typeof op.task_id !== 'string' || op.contract === undefined) {
          return fail('schema', 'schema_invalid', false, 'update_contract 缺 task_id/contract');
        }
        break;
      default:
        break;
    }
  }
  if (typeof draft.rationale !== 'string' || draft.rationale.length === 0) {
    return fail('schema', 'schema_invalid', false, 'PlanChange.rationale 必填（§2.7）');
  }
  return null;
}

/** ③ 图校验：边 kind 合法、data_from 的 data_mode/pinned_version 形状、depends_on DAG 无环（INV-2）。 */
function checkGraph(state: JourneyProjection, draft: PlanChangeDraft): PlanChangeVerdict | null {
  const tasks = new Set(state.tasks.keys());
  for (const op of draft.ops) {
    if (op.op === 'add_task') tasks.add(String(op.task_id));
  }

  const depends = new Map<string, Set<string>>();
  for (const edge of state.edges.values()) {
    if (!edge.removed && edge.kind === 'depends_on') {
      if (!depends.has(edge.to_task)) depends.set(edge.to_task, new Set());
      depends.get(edge.to_task)!.add(edge.from_task);
    }
  }

  for (const op of draft.ops) {
    if (op.op !== 'add_edge') continue;
    const kind = String(op.kind);
    if (!(EDGE_KINDS as readonly string[]).includes(kind)) {
      return fail('graph', 'illegal_edge', false, `边 kind 不在 §2.3 枚举内：${kind}`);
    }
    for (const end of [op.from_task, op.to_task] as const) {
      if (!tasks.has(String(end))) {
        return fail('graph', 'illegal_edge', false, `边 ${op.edge_id} 引用了不存在的 Task ${end}`);
      }
    }
    if (String(op.from_task) === String(op.to_task)) {
      return fail('graph', 'dag_cycle', false, `自环边 ${op.edge_id}（同一 Task）`);
    }
    if (kind === 'data_from') {
      const mode = op.data_mode;
      if (mode !== 'pinned' && mode !== 'latest_accepted') {
        return fail('graph', 'illegal_edge', false, `data_from 必须带 data_mode ∈ {pinned, latest_accepted}（§2.3）`);
      }
      if (mode === 'pinned') {
        const pinned = op.pinned_version as
          | { target_kind?: unknown; target_id?: unknown; artifact_version?: unknown }
          | undefined;
        if (!pinned || (pinned.target_kind !== 'outcome' && pinned.target_kind !== 'artifact') ||
          typeof pinned.target_id !== 'string') {
          return fail('graph', 'illegal_edge', false, 'pinned_version 形状非法（§2.3 封闭联合）');
        }
        if (pinned.target_kind === 'artifact' && pinned.artifact_version === undefined) {
          return fail('graph', 'illegal_edge', false, 'target_kind=artifact 时 artifact_version 必填（§2.3 新 P2-6）');
        }
      }
    }
    if ('release_override' in op && op.release_override !== undefined && kind !== 'depends_on') {
      return fail('graph', 'illegal_edge', false, 'release_override 只允许出现在 depends_on 边上（§2.3/REQ-SCH-5）');
    }
    if (kind === 'depends_on') {
      if (!depends.has(String(op.to_task))) depends.set(String(op.to_task), new Set());
      depends.get(String(op.to_task))!.add(String(op.from_task));
    }
  }

  const cycle = findCycle(depends);
  if (cycle) {
    return fail('graph', 'dag_cycle', false, `depends_on 成环：${cycle.join(' → ')}`);
  }
  return null;
}

function findCycle(graph: Map<string, Set<string>>): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    const state = color.get(node) ?? WHITE;
    if (state === BLACK) return null;
    if (state === GRAY) return [...stack.slice(stack.indexOf(node)), node];
    color.set(node, GRAY);
    stack.push(node);
    for (const dep of graph.get(node) ?? []) {
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  };

  for (const node of graph.keys()) {
    const found = visit(node);
    if (found) return found;
  }
  return null;
}

/**
 * REQ-PC 校验流水线：Schema → base_plan_rev → 图 → Policy → 预算（恒通过只记账）→ 幂等。
 * @param seenProposals 已见过的 (project_id, proposer_id, client_proposal_id) → 首次 change_id（REQ-PC-1 ⑥）
 */
export function validatePlanChange(
  state: JourneyProjection,
  project_id: string,
  draft: PlanChangeDraft,
  seenProposals: Map<string, string>,
): PlanChangeVerdict {
  const schema = checkSchema(draft);
  if (schema) return schema;

  // ② base_plan_rev 必须等于当前 rev
  if (draft.base_plan_rev !== state.planRev) {
    return fail('base_rev', 'base_rev_conflict', true,
      `base_plan_rev=${draft.base_plan_rev} ≠ 当前 rev=${state.planRev}（REQ-PC-1②：返回三方差异，不自动重试覆盖）`,
      { conflict_baseline: { base_plan_rev: draft.base_plan_rev, current_plan_rev: state.planRev, proposed: draft } });
  }

  const graph = checkGraph(state, draft);
  if (graph) return graph;

  // ④ Policy：proposer 权限 + risk_level ≤ auto_apply_ceiling（同量纲序比较，REQ-PC-1④）
  const policy = state.project(project_id);
  if (!policy.allowed_proposers.includes(draft.proposer_id)) {
    return fail('policy', 'policy_denied', true,
      `proposer ${draft.proposer_id} 不在 Policy.allowed_proposers 内（REQ-PC-1④）`);
  }
  if (sideEffectRank(draft.risk_level) > sideEffectRank(policy.auto_apply_ceiling)) {
    return fail('policy', 'policy_denied', true,
      `risk_level ${draft.risk_level} 超出 auto_apply_ceiling ${policy.auto_apply_ceiling}（REQ-PC-1④：须转 Decision）`);
  }

  // ⑤ 预算关口：K0 恒通过、只记账（REQ-PC-6）
  const budgetLedgered = true;

  // ⑥ 幂等：同 (project_id, proposer_id, client_proposal_id) 重放返回首次结果
  const key = `${project_id}/${draft.proposer_id}/${draft.client_proposal_id}`;
  const firstChangeId = seenProposals.get(key);
  if (firstChangeId !== undefined && firstChangeId !== draft.change_id) {
    return {
      ok: false, stage: 'idempotency', reason_code: 'duplicate', decision_eligible: false,
      detail: `重复提议：返回首次结果 change_id=${firstChangeId}`,
      budget_ledgered: false,
    };
  }

  return {
    ok: true, stage: 'applied', reason_code: null, decision_eligible: false,
    detail: 'REQ-PC-1 全关口通过', budget_ledgered: budgetLedgered,
  };
}

/** REQ-PC-3：是否属可由人裁决类（版本冲突 / 权限风险超限）。 */
export function isDecisionEligible(verdict: PlanChangeVerdict): boolean {
  return !verdict.ok && verdict.decision_eligible;
}

// ---------------------------------------------------------------------------
// ActorProfile（§2.4 最小能力声明）—— seed 夹具
//
// 登记（D9 发现）：REQ-SCH-4 的 ActorProfile 在 spec §4 事件目录里**没有对应事件类型**
// （无 ActorProfileCreated/Updated），因此在册执行者只能作为外部 seed/配置进入旅程。
// 本旅程用 seed 表达，并在报告里登记为「派生规则与事件目录的缺口」，不自造事件类型。
// ---------------------------------------------------------------------------

export interface ActorProfile {
  actor_id: string;
  actor_kind: 'human' | 'agent';
  capabilities: string[];
  environments: string[];
  max_side_effect_level: SideEffectLevel;
  liveness_probe: boolean;
  active: boolean;
}

export const D8_ACTOR_PROFILES: readonly ActorProfile[] = [
  {
    actor_id: 'actor-opencode',
    actor_kind: 'agent',
    capabilities: ['code.write', 'code.test', 'doc.import'],
    environments: ['sandbox-node24'],
    max_side_effect_level: 'L1',
    liveness_probe: true,
    active: true,
  },
  {
    actor_id: 'actor-human-1',
    actor_kind: 'human',
    capabilities: ['talk', 'review', 'doc.read'],
    environments: ['phone'],
    max_side_effect_level: 'L3',
    liveness_probe: false,
    active: true,
  },
];

/** REQ-SCH-4：存在在册 active 的 actor 且 capabilities ⊇ required 且 max_side_effect_level ≥ ceiling。 */
export function hasCapableActor(
  contract: { required_capabilities: string[]; side_effect_ceiling: SideEffectLevel },
  profiles: readonly ActorProfile[] = D8_ACTOR_PROFILES,
): { ok: boolean; actor_id: string | null } {
  for (const profile of profiles) {
    if (!profile.active) continue;
    const covers = contract.required_capabilities.every((c) => profile.capabilities.includes(c));
    if (covers && sideEffectRank(profile.max_side_effect_level) >= sideEffectRank(contract.side_effect_ceiling)) {
      return { ok: true, actor_id: profile.actor_id };
    }
  }
  return { ok: false, actor_id: null };
}

// ---------------------------------------------------------------------------
// ready 判定（REQ-SCH-1：判定逻辑只有一处实现，投影/API 不得各算各的）
// ---------------------------------------------------------------------------

export interface ReadyVerdict {
  ready: boolean;
  reasons: string[];
}

export function computeReady(state: JourneyProjection, task_id: string): ReadyVerdict {
  const task = state.tasks.get(task_id);
  const reasons: string[] = [];
  if (!task) return { ready: false, reasons: ['task_not_found'] };

  if (task.lifecycle !== 'defined') reasons.push(`lifecycle=${task.lifecycle}（须 defined）`);
  if (task.wait_state !== 'none') reasons.push(`wait_state=${task.wait_state}（≠none 不派发）`);
  if (task.duplicate_suspect) reasons.push('duplicate_suspect=true（REQ-DD-2）');

  // REQ-TC-1：指派给 Agent 的 Task 必须有结构化 acceptance_criteria（≥1 条可判定）与 expected_outputs
  const assigneeKind =
    state.liveAssignments(task_id).find((a) => a.actor_kind === 'agent') ? 'agent' : task.intended_assignee_kind;
  const contract = state.contract(task_id, task.current_contract_rev);
  if (assigneeKind === 'agent' && (!contract || contract.criterion_refs.length === 0 || contract.expected_outputs.length === 0)) {
    reasons.push('req_tc_1_structured_contract_missing（REQ-TC-1：指派 Agent 须结构化契约，Scheduler 不得派发）');
  }
  if (contract && contract.criterion_refs.length > 0) {
    const actor = hasCapableActor(contract);
    if (!actor.ok) reasons.push('no_capable_actor（REQ-SCH-4）');
  }

  // depends_on：上游最新有效 Acceptance=accepted（REQ-ACC-1 跨 rev），或该边 release_override active
  for (const edge of state.edges.values()) {
    if (edge.removed || edge.kind !== 'depends_on' || edge.to_task !== task_id) continue;
    const upstream = state.effectiveAcceptance(edge.from_task);
    const overridden = (edge as unknown as { release_override_active?: boolean }).release_override_active === true;
    if (!overridden && (!upstream || upstream.verdict !== 'accepted')) {
      reasons.push(`depends_on_unsatisfied:${edge.from_task}`);
    }
  }

  // data_from 可用性（REQ-SCH-1/SCH-2）
  for (const edge of state.edges.values()) {
    if (edge.removed || edge.kind !== 'data_from' || edge.to_task !== task_id) continue;
    if (edge.data_mode === 'latest_accepted') {
      if (state.latestAcceptedOutcome(edge.from_task) === null) {
        reasons.push(`data_from_unavailable:${edge.from_task}`);
      }
    } else if (edge.data_mode === 'pinned') {
      const pinned = edge.pinned_version as { target_kind?: string; target_id?: string } | null;
      if (!pinned?.target_id) {
        reasons.push(`data_from_unavailable:pinned:${edge.from_task}`);
      } else if (pinned.target_kind === 'outcome' && !state.outcomes.has(pinned.target_id)) {
        reasons.push(`data_from_pinned_missing:${pinned.target_id}`);
      }
    }
  }

  // 已知缺口（评审 m4 登记）：REQ-SCH-1 的合取式还含「Policy 未拦截」一项，本编码
  // 未实现 —— K0 里 Policy 拦截只定义在 PlanChange 流水线（REQ-PC-1④ 的权限/风险，
  // 见 validatePlanChange 的 policy 关口）与预算（REQ-PC-6 恒不拦截、只记账），
  // Scheduler 侧没有可读的 Policy 拦截状态可消费。待 spec 明示其 Scheduler 侧语义
  // 后再补，不自造拦截规则（与本文件一贯处理：缺口登记在案、不断言伪造覆盖）。
  return { ready: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Acceptance 入账校验（REQ-ACC-2 含新 P1-1 两条 + REQ-ACC-1/3/4）
//
// 下列 code 是测试诊断码（spec 未定义 Acceptance 的原因码枚举），不是 spec 术语。
// ---------------------------------------------------------------------------

export interface AcceptanceDraft {
  acceptance_id: string;
  task_id: string;
  contract_rev: number;
  subject_outcome_id: string;
  acceptor_id: string;
  acceptor_kind: 'human' | 'agent' | 'system';
  verdict: 'accepted' | 'rejected' | 'partially_accepted';
  criterion_results: { criterion_ref: string; verdict: 'passed' | 'failed' | 'not_applicable'; evidence_refs: string[] }[];
  supersedes_id: string | null;
  evidence_refs: string[];
  rationale: string;
}

export interface AcceptanceVerdict {
  ok: boolean;
  code: string | null;
  detail: string;
  /** REQ-ACC-3：入账后内核重算出的 lifecycle 目标（undefined = 不迁移）。 */
  derived_lifecycle?: 'awaiting_acceptance' | 'accepted' | 'defined';
  pending_criteria?: string[];
}

function expectVerdict(results: AcceptanceDraft['criterion_results']): AcceptanceDraft['verdict'] {
  const passed = results.filter((r) => r.verdict === 'passed' || r.verdict === 'not_applicable').length;
  const failed = results.filter((r) => r.verdict === 'failed').length;
  if (failed === 0) return 'accepted';
  if (passed === 0) return 'rejected';
  return 'partially_accepted';
}

export function validateAcceptance(state: JourneyProjection, draft: AcceptanceDraft): AcceptanceVerdict {
  const reject = (code: string, detail: string): AcceptanceVerdict => ({ ok: false, code, detail });

  const task = state.tasks.get(draft.task_id);
  if (!task) return reject('task_not_found', `Task ${draft.task_id} 不存在`);

  const contract = state.contract(draft.task_id, draft.contract_rev);
  if (!contract) return reject('contract_rev_unknown', `契约 (task=${draft.task_id}, rev=${draft.contract_rev}) 不存在（REQ-ACC-1）`);

  const subject = state.outcomes.get(draft.subject_outcome_id);
  if (!subject) return reject('subject_outcome_missing', `subject_outcome_id=${draft.subject_outcome_id} 无对应 Outcome（REQ-ACC-1 显式钉死）`);
  if (subject.task_id !== draft.task_id && state.dataFromUpstream(draft.task_id, subject.task_id).length === 0) {
    return reject('subject_outcome_foreign', `对象 Outcome 不属于本 Task 也不是其 data_from 上游产物（§8.1 G1 构造唯一性）`);
  }

  // ① 覆盖完整性（新 P1-1）：契约全部 criterion_ref 必须出现
  const reported = new Set(draft.criterion_results.map((r) => r.criterion_ref));
  const missing = contract.criterion_refs.filter((ref) => !reported.has(ref));
  if (missing.length > 0) {
    return reject('coverage_incomplete', `缺判据 ${missing.join(',')}（新 P1-1：缺项不入账，防只列 passed 拼 accepted）`);
  }
  const unknown = [...reported].filter((ref) => !contract.criterion_refs.includes(ref));
  if (unknown.length > 0) return reject('criterion_ref_unknown', `未知判据 ${unknown.join(',')}`);

  // ② 顶层 verdict 与逐项一致（REQ-ACC-2）
  const expected = expectVerdict(draft.criterion_results);
  if (expected !== draft.verdict) {
    return reject('verdict_inconsistent', `逐项结论应得 ${expected}，顶层写 ${draft.verdict}（REQ-ACC-2 内核校验）`);
  }

  // ③ actor 分离（REQ-ACC-2 / C6）：被禁的只有 subject Outcome 所属 Run 的执行者。
  //    spec 钉死的是「执行该 Run 的 actor」，「该 Run」= subject_outcome_id 所属 Run；
  //    本 Task 其他 Run 的执行者不在禁止之列（多 Run 时不得按整 Task 误拒）。
  const subjectRun = subject.run_id !== null ? state.runs.get(subject.run_id) : undefined;
  if (subjectRun && subjectRun.actor_id === draft.acceptor_id) {
    return reject('acceptor_is_run_actor', `acceptor=${draft.acceptor_id} 是 subject Outcome 所属 Run ${subjectRun.run_id} 的执行者（REQ-ACC-2 拦截）`);
  }

  // ④ 非 auto 判据必须由人类或独立评审 actor 给出（REQ-ACC-2）：「独立评审」指
  //    不是 subject Run 执行者的评审者（human 恒可；agent 须已过 ③ 的分离校验，
  //    走到这里即与 subject Run 无关）；system 类 actor 不得代判非 auto 判据。
  const autoRefs = new Set(contract.auto_criterion_refs);
  const manual = draft.criterion_results.filter((r) => !autoRefs.has(r.criterion_ref));
  if (manual.length > 0 && draft.acceptor_kind === 'system') {
    return reject('manual_criterion_needs_reviewer', `判据 ${manual.map((m) => m.criterion_ref)} 非 auto，须由人类或独立评审 actor 结论，system 不得代判（REQ-ACC-2）`);
  }

  // ⑤ 继承锁定校验（新 P1-1②）：先前已 passed 的判据被置 failed/not_applicable 时须 supersede 且附新证据
  const previous = state.effectiveAcceptance(draft.task_id);
  if (previous) {
    for (const result of draft.criterion_results) {
      const before = previous.criterion_results.find((r) => r.criterion_ref === result.criterion_ref);
      if (before?.verdict === 'passed' && result.verdict !== 'passed') {
        if (draft.supersedes_id !== previous.acceptance_id) {
          return reject('inheritance_lock', `判据 ${result.criterion_ref} 从 passed 回退却未 supersedes ${previous.acceptance_id}（REQ-ACC-3/4 锁定）`);
        }
        if (result.evidence_refs.length === 0) {
          return reject('inheritance_lock', `判据 ${result.criterion_ref} 被推翻但无新证据（REQ-ACC-2②：该项 evidence_refs 须非空）`);
        }
      }
    }
  }

  // REQ-ACC-3 重算：accepted→accepted；rejected→defined；partially→停在 awaiting_acceptance
  const pending = draft.criterion_results.filter((r) => r.verdict === 'failed').map((r) => r.criterion_ref);
  const derived_lifecycle =
    draft.verdict === 'accepted' ? 'accepted' :
    draft.verdict === 'rejected' ? 'defined' : 'awaiting_acceptance';
  return { ok: true, code: null, detail: 'REQ-ACC-2 入账校验通过', derived_lifecycle, pending_criteria: pending };
}

/** §3.1 映射表（person→waiting_on_person 等）；从内核 transition-guard 取，避免测试另写一份。 */
export function waitStateForConditionKind(kind: string): string | null {
  const entry = (WAIT_STATE_BY_CONDITION_KIND as Record<string, { wait_state: string } | undefined>)[kind];
  return entry ? entry.wait_state : null;
}

// ---------------------------------------------------------------------------
// Outcome 入账校验（REQ-OC-1 + 新 P1-3 来源限定 + §2.5 dimensions 封闭集 / S7）
// ---------------------------------------------------------------------------

export interface OutcomeDraft {
  outcome_id: string;
  task_id: string;
  run_id: string | null;
  feedback_id: string | null;
  proposal_id: string | null;
  interpreted_by: string;
  evidence_refs: string[];
  dimensions: {
    info_obtained: boolean;
    conclusion_kind: string;
    certainty: string;
    evidence_sufficiency: string;
    blockers: string[];
    followup_suggestions: string[];
  };
  supersedes_id?: string | null;
}

const CONCLUSION_KINDS = ['achieved', 'partial', 'infeasible', 'no_response', 'unknown'];
const CERTAINTY = ['low', 'med', 'high'];
const EVIDENCE_SUFFICIENCY = ['sufficient', 'insufficient', 'none'];

/** 提出 Outcome 的合法解释器（REQ-OC-1 写死：Outcome 只能由 Outcome Interpreter 的
 * 提议经内核校验后生成；Intent Interpreter 按 §2.1 只产 Task 草稿/PlanChange 提议，
 * 不在此列。Executor 与人类同样不得直接写 Outcome）。 */
export const D8_INTERPRETERS = ['actor-outcome-interpreter'] as const;

export function validateOutcomeProposal(
  state: JourneyProjection,
  draft: OutcomeDraft,
): AcceptanceVerdict {
  const reject = (code: string, detail: string): AcceptanceVerdict => ({ ok: false, code, detail });

  if (!state.tasks.has(draft.task_id)) return reject('task_not_found', `Task ${draft.task_id} 不存在`);

  // REQ-OC-1：Outcome 只能由 Interpreter 的提议经内核校验后生成
  if (draft.proposal_id === null || draft.proposal_id.length === 0) {
    return reject('missing_proposal', 'Outcome 必须携带 Interpreter 的 proposal_id（REQ-OC-1）');
  }
  if (!(D8_INTERPRETERS as readonly string[]).includes(draft.interpreted_by)) {
    return reject('not_interpreter', `interpreted_by=${draft.interpreted_by} 不是在册 Interpreter（REQ-OC-1：Executor 与人类不得直接写 Outcome）`);
  }

  // 新 P1-3 / REQ-OC-1 来源限定：未绑定 Run 的游离 Feedback 不生成 Outcome
  if (draft.run_id === null) {
    return reject('unbound_source', '游离（未绑定 Run）来源不生成 Outcome，只更新 interpretation_status（新 P1-3）');
  }
  const run = state.runs.get(draft.run_id);
  if (!run) return reject('run_not_found', `Run ${draft.run_id} 不存在`);
  if (run.task_id !== draft.task_id) {
    return reject('run_task_mismatch', `Run ${run.run_id} 不属于 Task ${draft.task_id}`);
  }
  // REQ-OC-1 来源限定（新 P1-3）：Outcome 只能挂在 run_kind ∈ {executor, human_light} 的 Run 上
  if (run.run_kind !== 'executor' && run.run_kind !== 'human_light') {
    return reject('run_kind_not_outcome_source', `Run ${run.run_id} 的 run_kind=${run.run_kind} 不在 {executor, human_light} 内（REQ-OC-1 来源限定）`);
  }

  // 引用的 Evidence 必须存在（REQ-OC-1）
  for (const ref of draft.evidence_refs) {
    if (!state.evidences.has(ref)) return reject('evidence_missing', `引用的 Evidence ${ref} 不存在（REQ-OC-1）`);
  }

  // §2.5 dimensions 必填 + 封闭集（S7：扩维须走 spec 修订）
  const d = draft.dimensions;
  if (typeof d.info_obtained !== 'boolean') return reject('dimensions_invalid', 'info_obtained 必填 boolean');
  if (!CONCLUSION_KINDS.includes(d.conclusion_kind)) {
    return reject('dimensions_invalid', `conclusion_kind=${d.conclusion_kind} 不在封闭集 ${CONCLUSION_KINDS.join('|')}（S7）`);
  }
  if (!CERTAINTY.includes(d.certainty)) return reject('dimensions_invalid', `certainty=${d.certainty} 不在封闭集`);
  if (!EVIDENCE_SUFFICIENCY.includes(d.evidence_sufficiency)) {
    return reject('dimensions_invalid', `evidence_sufficiency=${d.evidence_sufficiency} 不在封闭集`);
  }
  for (const list of [d.blockers, d.followup_suggestions]) {
    if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) {
      return reject('dimensions_invalid', 'blockers/followup_suggestions 必须是 string[]');
    }
  }

  if (draft.supersedes_id) {
    if (!state.outcomes.has(draft.supersedes_id)) return reject('supersedes_missing', `supersedes_id=${draft.supersedes_id} 不存在`);
    if (draft.supersedes_id === draft.outcome_id) return reject('supersedes_self', 'Outcome 不得 supersede 自身（INV-7 只追加）');
  }

  // REQ-OC-2：内核判定只读封闭维度枚举，绝不解析 blockers/followup_suggestions 文本
  // —— 该条由 d9-projection-consistency.test.ts 用「改文本不改结论」的正面对照证明。
  return {
    ok: true, code: null,
    detail: 'REQ-OC-1 校验通过（提议来源 + Run 绑定 + Evidence 存在 + dimensions 封闭集）',
    derived_lifecycle: 'awaiting_acceptance',
  };
}
