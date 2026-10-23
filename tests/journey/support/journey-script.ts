// D8 完整旅程脚本（spec/K0-SPEC-FROZEN-v1.0.md 领域语义）—— 一条可执行、可复用的旅程。
//
// 六阶段：① Capture 一个目标 → ② 生成计划（PlanChange 提议与校验）→ ③ 派活给代码 Agent（Run）
//         → ④ 人类反馈（Feedback）→ ⑤ 产出（Outcome）→ ⑥ 验收（Acceptance）
//
// 分工（诚实边界，勿夸大）：
// - 事件写入全部经真内核 PgEventStore（append / appendStateTransition / withTransaction）。
//   迁移矩阵 + 前置条件（INV-11）、幂等（INV-13）、哈希链（INV-12）、append-only、
//   canonicalJson 稳定性由 src/kernel 生产代码执行。
// - PlanChange 流水线（REQ-PC-1/3/5/6）、ready 判定（REQ-SCH-1/4）、Acceptance 入账校验
//   （REQ-ACC-1/2/3/4 + 新 P1-1）、Outcome 入账校验（REQ-OC-1 + 新 P1-3）在
//   journey-rules.ts = 冻结 spec 的测试侧编码（内核 Plan Engine/Scheduler/Acceptance 未实现）。
// - 投影状态只由 JourneyProjection 从 DB 读回的事件流派生（D9 纪律）。
//
// 每个 step 记录：本步在事件流**新增**了什么（从 PG 读回的 seq 增量）+ 本步后的派生投影快照。

import { createHash } from 'node:crypto';
import {
  TransitionDeniedError,
  canonicalJson,
  type PgEventStore,
} from '../../../src/kernel/event-store-pg.js';
import type { GuardFacts } from '../../../src/kernel/transition-guard.js';
import type { EventEnvelope, EventType } from '../../../src/kernel/events.js';
import type { ActorKind } from '../../../src/kernel/events.js';
import type { SideEffectLevel } from '../../../src/domain/types.js';
import {
  JourneyProjection,
  type JourneySnapshot,
  type JOp,
} from './journey-projection.js';
import {
  computeReady,
  validateAcceptance,
  validateOutcomeProposal,
  validatePlanChange,
  waitStateForConditionKind,
  type AcceptanceDraft,
  type OutcomeDraft,
  type PlanChangeDraft,
} from './journey-rules.js';

export const FIXED_NOW = new Date('2026-10-23T00:00:00.000Z');

export const D8 = {
  project: 'proj-d8',
  policy: 'policy-d8',
  goal: 'goal-d8',
  captureTask: 'task-d8-capture',
  importTask: 'task-d8-import',
  reportTask: 'task-d8-report',
  followupTask: 'task-d8-followup',
  docTask: 'task-d8-docgap',
  assignmentImport: 'asg-d8-import',
  assignmentReport: 'asg-d8-report',
  runImport: 'run-d8-import-1',
  runHumanLight: 'run-d8-humanlight-1',
  feedbackRun: 'fb-d8-run-1',
  feedbackStray: 'fb-d8-stray-1',
  feedbackSecond: 'fb-d8-run-2',
  outcomePartial: 'oc-d8-1',
  outcomeFinal: 'oc-d8-2',
  evidenceAgentClaim: 'ev-d8-agent-claim',
  evidenceExternalDoc: 'ev-d8-external-doc',
  evidenceUserStatement: 'ev-d8-user-statement',
  evidenceNewDoc: 'ev-d8-mapping-notes',
  acceptancePartial: 'acc-d8-1',
  acceptanceFinal: 'acc-d8-2',
  waitCondition: 'wc-d8-person-1',
  planChange: 'pc-d8-plan-1',
  planDocGap: 'pc-d8-shadow-1',
  planMidflight: 'pc-d8-midflight-1',
  planFollowup: 'pc-d8-followup-1',
  decisionDocGap: 'dec-d8-shadow-1',
  criterionRoundtrip: 'c-roundtrip:auto',
  criterionUnmapped: 'c-unmapped-list',
} as const;

interface ActorRef {
  id: string;
  kind: ActorKind;
}

export const HUMAN: ActorRef = { id: 'actor-human-1', kind: 'human' };
export const PLANNER: ActorRef = { id: 'actor-planner', kind: 'agent' };
export const SHADOW_PLANNER: ActorRef = { id: 'actor-planner-shadow', kind: 'agent' };
export const EXECUTOR: ActorRef = { id: 'actor-opencode', kind: 'agent' };
export const INTERPRETER: ActorRef = { id: 'actor-outcome-interpreter', kind: 'agent' };
export const REVIEW_BOT: ActorRef = { id: 'actor-review-bot', kind: 'agent' };
export const KERNEL: ActorRef = { id: 'kernel', kind: 'system' };

const RAW_RESULT_TEXT =
  '导入完成：3 个 phase 映射为 Task，phase-1/2 的产物已入 Artifact 索引；' +
  'phase-3 的 verdict 字段（achieved/partial 混合语义）无法映射到 Acceptance.criterion_results，' +
  '已按 external_doc 记录原始文件路径与 sha256。CHAIN.json 顶层 run-id=nx-2026-10-18-07。';

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** REQ-CX-1（P2-3）：确定性摘录 = 原文前 512 字符 + raw_result_ref + content_hash 成对出现。 */
export const RAW_EXCERPT = RAW_RESULT_TEXT.slice(0, 512);

// ---------------------------------------------------------------------------
// step 记录
// ---------------------------------------------------------------------------

export interface JourneyStep {
  index: number;
  name: string;
  specRefs: string[];
  /** 本步在事件流新增的事件类型（按 seq 升序，从 PG 读回）。 */
  appendedTypes: EventType[];
  appendedIds: string[];
  /** 本步后的派生投影快照（深拷贝，不会被后续步骤改写）。 */
  snapshot: JourneySnapshot;
  /** 本步的判定证据（guard reason、校验结论码、被拒次数等）。 */
  notes: string[];
}

export interface JourneyRun {
  steps: JourneyStep[];
  projection: JourneyProjection;
  seenProposals: Map<string, string>;
}

class JourneyRunner {
  private readonly seenEventIds = new Set<string>();
  private current: JourneyStep | null = null;
  private markerIds = new Set<string>();
  private readonly notes: string[] = [];

  constructor(
    readonly store: PgEventStore,
    readonly projection: JourneyProjection,
    readonly seenProposals: Map<string, string>,
  ) {}

  // -- 写路径（真内核）------------------------------------------------------

  async emit(
    type: EventType,
    payload: unknown,
    actor: ActorRef = KERNEL,
    options: { idempotency_key?: string | null; causation_id?: string | null } = {},
  ): Promise<EventEnvelope> {
    return this.store.append({
      stream_id: D8.project,
      type,
      actor_id: actor.id,
      actor_kind: actor.kind,
      causation_id: options.causation_id ?? null,
      correlation_id: 'd8-journey',
      idempotency_key: options.idempotency_key ?? null,
      payload,
    });
  }

  async transitionTask(input: {
    task_id: string;
    from: string;
    to: string;
    facts?: GuardFacts;
    actor?: ActorRef;
    causation_id?: string | null;
    extra?: Record<string, unknown>;
  }): Promise<EventEnvelope> {
    const { event } = await this.store.appendStateTransition({
      stream_id: D8.project,
      type: 'TaskLifecycleChanged',
      actor_id: (input.actor ?? KERNEL).id,
      actor_kind: (input.actor ?? KERNEL).kind,
      causation_id: input.causation_id ?? null,
      correlation_id: 'd8-journey',
      idempotency_key: null,
      payload: { task_id: input.task_id, ...(input.extra ?? {}) },
      entity: 'task',
      from: input.from,
      to: input.to,
      facts: input.facts,
    });
    return event;
  }

  async transitionRun(input: {
    run_id: string;
    type: EventType;
    from: string;
    to: string;
    payload?: Record<string, unknown>;
    facts?: GuardFacts;
    actor?: ActorRef;
    idempotency_key?: string | null;
  }): Promise<EventEnvelope> {
    const actor = input.actor ?? KERNEL;
    const { event } = await this.store.appendStateTransition({
      stream_id: D8.project,
      type: input.type,
      actor_id: actor.id,
      actor_kind: actor.kind,
      causation_id: null,
      correlation_id: 'd8-journey',
      idempotency_key: input.idempotency_key ?? null,
      payload: { run_id: input.run_id, ...(input.payload ?? {}) },
      entity: 'run',
      from: input.from,
      to: input.to,
      facts: input.facts,
    });
    return event;
  }

  async transitionRunDenied(input: Parameters<JourneyRunner['transitionRun']>[0]): Promise<string> {
    try {
      await this.transitionRun(input);
    } catch (error) {
      if (error instanceof TransitionDeniedError) {
        const reason = error.result.reason ?? 'unknown';
        this.note(`内核拒绝 ${input.from}→${input.to}（${input.type}）reason=${reason}`);
        return reason;
      }
      throw error;
    }
    this.note(`内核**未**拒绝 ${input.from}→${input.to}（${input.type}）—— 旅程预期被打破`);
    return 'NOT_DENIED';
  }

  /** 记录一条被拒写入：期望 fn 抛错/返回拒绝，且事件流零增长。 */
  async expectDeniedWrite(label: string, fn: () => Promise<unknown>): Promise<void> {
    const before = await this.store.readStream(D8.project);
    let outcome = 'NOT_DENIED';
    try {
      await fn();
    } catch (error) {
      outcome = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    const after = await this.store.readStream(D8.project);
    this.note(`零写入拒绝[${label}] → ${outcome}；事件数 ${before.length}→${after.length}`);
  }

  // -- step 边界 ------------------------------------------------------------

  async begin(name: string, specRefs: string[]): Promise<void> {
    await this.flush();
    const stream = await this.store.readStream(D8.project);
    this.markerIds = new Set(stream.map((event) => event.id));
    this.current = { index: 0, name, specRefs, appendedTypes: [], appendedIds: [], snapshot: this.projection.snapshot(), notes: [] };
  }

  async end(): Promise<JourneyStep> {
    if (this.current === null) throw new Error('step.end() 前未 begin()');
    await this.flush();
    // 本步增量以「从 PG 读回的流」为准（不依赖内存记账，也不依赖 flush 的返回值）
    const stream = await this.store.readStream(D8.project);
    const fresh = stream.filter((event) => !this.markerIds.has(event.id));
    this.current.index = this.steps.length + 1;
    this.current.appendedTypes = fresh.map((event) => event.type);
    this.current.appendedIds = fresh.map((event) => event.id);
    this.current.snapshot = cloneSnapshot(this.projection.snapshot());
    this.current.notes = [...this.notes];
    this.notes.length = 0;
    const step = this.current;
    this.steps.push(step);
    this.current = null;
    return step;
  }

  /**
   * INV-11 收尾必须与 lifecycle 迁移同事务提交（真内核 withTransaction 入口）。
   * fn 抛错 → 整体回滚、零事件落库。
   */
  async withTransaction<T>(fn: (tx: TxWriter) => Promise<T>): Promise<T> {
    return this.store.withTransaction(async (tx) =>
      fn({
        append: (type, payload, actor = KERNEL) => tx.append({
          stream_id: D8.project, type,
          actor_id: actor.id, actor_kind: actor.kind,
          causation_id: null, correlation_id: 'd8-journey', idempotency_key: null, payload,
        }),
        transitionTask: async (task_id, from, to, facts) => {
          const result = await tx.appendStateTransition({
            stream_id: D8.project, type: 'TaskLifecycleChanged',
            actor_id: KERNEL.id, actor_kind: KERNEL.kind,
            causation_id: null, correlation_id: 'd8-journey', idempotency_key: null,
            payload: { task_id }, entity: 'task', from, to, facts,
          });
          return result.guard.required_effects ?? [];
        },
      }),
    );
  }

  readonly steps: JourneyStep[] = [];

  note(text: string): void {
    this.notes.push(text);
  }

  /** 把 PG 里尚未进入投影的事件按 seq 顺序喂给投影（读回真库，不是内存记账）。 */
  private async flush(): Promise<EventEnvelope[]> {
    const stream = await this.store.readStream(D8.project);
    const applied: EventEnvelope[] = [];
    for (const event of stream) {
      if (this.seenEventIds.has(event.id)) continue;
      this.seenEventIds.add(event.id);
      this.projection.apply(event);
      applied.push(event);
    }
    return applied;
  }
  /**
   * 把已落库但尚未派生到投影的事件读回并 apply（同一步骤内「先写后验」时调用）。
   * 投影仍然只从事件流派生 —— 这里没有任何旁路写状态。
   */
  async sync(): Promise<void> {
    await this.flush();
  }
}

// 快照深拷贝：step 记录不能被后续事件改写（否则「本步后的状态」失真）
function cloneSnapshot(snapshot: JourneySnapshot): JourneySnapshot {
  return structuredClone(snapshot);
}

// ---------------------------------------------------------------------------
// 旅程正文
// ---------------------------------------------------------------------------

export async function runD8Journey(store: PgEventStore): Promise<JourneyRun> {
  const projection = new JourneyProjection();
  const seenProposals = new Map<string, string>();
  const r = new JourneyRunner(store, projection, seenProposals);
  let step: JourneyStep;

  // ======================================================================
  // ① Capture：目标 + 模糊输入入图（§2.1/§2.2、REQ-PJ-3）
  // ======================================================================
  await r.begin('① Capture：目标与模糊输入入账', ['§2.1', '§2.2', 'REQ-PJ-3', '§4']);

  await r.emit('ProjectCreated', {
    name: '续行 K0 · D8 双轨对照',
    policy_id: D8.policy,
    auto_apply_ceiling: 'L1' as SideEffectLevel,
    allowed_proposers: [PLANNER.id, INTERPRETER.id],
    require_decision_for: ['policy_change', 'external_side_effect_L2'],
  }, HUMAN);

  await r.emit('GoalCreated', {
    goal_id: D8.goal,
    statement: '跑通 nx-pipeline 双轨对照：导入一次真实 run 并产出映射成功率报告',
    success_criteria: 'CHAIN.json 的 phase 全部映射为 Task；无法映射项有清单',
    stop_conditions: '映射缺陷需改 pipeline 侧则先停在报告',
    status: 'active',
  }, HUMAN);

  const capturePayload = {
    task_id: D8.captureTask,
    goal_id: D8.goal,
    title: '导入并跑通双轨对照',
    description: '帮我把上次 nx-pipeline 那轮 run 导进续行，看看双轨对照能不能跑通',
    raw_input: '帮我把上次 nx-pipeline 那轮 run 导进续行，看看双轨对照能不能跑通',
    captured_via: 'capture-api',
  };
  const firstCapture = await r.emit('TaskCaptured', capturePayload, HUMAN, { idempotency_key: 'capture-d8-raw-1' });
  // 同一 capture 客户端幂等键重放：内核返回既有事件，事件流不得增长（INV-13/C2 的 capture 侧证据）
  const replayCapture = await r.emit('TaskCaptured', capturePayload, HUMAN, { idempotency_key: 'capture-d8-raw-1' });
  r.note(`capture 幂等重放：返回同一事件 id=${replayCapture.id === firstCapture.id}，seq=${replayCapture.seq}`);

  step = await r.end();
  assertTypes(step, ['ProjectCreated', 'GoalCreated', 'TaskCaptured']);

  // ======================================================================
  // ② 生成计划：Planner 提议 PlanChange → REQ-PC-1 流水线 → 应用（+ 三类负例）
  // ======================================================================
  await r.begin('②a 计划提议：结构错误类负例（schema/dag_cycle）', ['§2.7', 'REQ-PC-1①③', 'REQ-PC-3', 'INV-2']);

  const badSchema: PlanChangeDraft = {
    change_id: 'pc-d8-bad-schema', client_proposal_id: 'prop-bad-1', proposer_id: PLANNER.id,
    base_plan_rev: 0, risk_level: 'L1', estimated_budget: 1000, rationale: '误用未注册 op',
    assumptions: [], ops: [{ op: 'remove_task', task_id: D8.captureTask }],
  };
  const vBadSchema = validatePlanChange(projection, D8.project, badSchema, seenProposals);
  r.note(`schema 负例 → stage=${vBadSchema.stage} code=${vBadSchema.reason_code} 可裁决=${vBadSchema.decision_eligible}`);
  await r.emit('PlanChangeProposed', planChangePayload(badSchema), PLANNER);
  seenProposals.set(proposalKey(badSchema), badSchema.change_id);
  await r.emit('PlanChangeRejected', { change_id: badSchema.change_id, reason_code: vBadSchema.reason_code, detail: vBadSchema.detail }, KERNEL);

  const badEdge: PlanChangeDraft = {
    change_id: 'pc-d8-bad-edge', client_proposal_id: 'prop-bad-2', proposer_id: PLANNER.id,
    base_plan_rev: 0, risk_level: 'L1', estimated_budget: 1000, rationale: '把 report 也设为 import 的上游，造环',
    assumptions: [],
    ops: [{ op: 'add_edge', edge_id: 'edge-cycle', from_task: D8.reportTask, to_task: D8.importTask, kind: 'depends_on' }],
  };
  // 边端点此时还不存在 → 先落两个 Task 才谈得上环；此处期望 illegal_edge（引用不存在 Task）
  const vBadEdge = validatePlanChange(projection, D8.project, badEdge, seenProposals);
  r.note(`环/悬空边负例 → stage=${vBadEdge.stage} code=${vBadEdge.reason_code}`);
  await r.emit('PlanChangeProposed', planChangePayload(badEdge), PLANNER);
  seenProposals.set(proposalKey(badEdge), badEdge.change_id);
  await r.emit('PlanChangeRejected', { change_id: badEdge.change_id, reason_code: vBadEdge.reason_code, detail: vBadEdge.detail }, KERNEL);

  step = await r.end();
  assertTypes(step, [
    'PlanChangeProposed', 'PlanChangeRejected', 'PlanChangeProposed', 'PlanChangeRejected',
  ]);

  await r.begin('②b 计划应用：主计划（rev 1）', ['REQ-PC-1', 'REQ-PC-2', 'INV-8', 'REQ-TC-1', 'REQ-ASG-1']);

  const mainPlan: PlanChangeDraft = {
    change_id: D8.planChange, client_proposal_id: 'prop-plan-1', proposer_id: PLANNER.id,
    base_plan_rev: 0, risk_level: 'L1', estimated_budget: 32000,
    rationale: '把目标拆成「导入器实现（Agent）」+「报告复核（人）」两 Task 与依赖',
    assumptions: ['pipeline run 目录只读可得', 'CHAIN.json 结构稳定'],
    ops: [
      {
        op: 'add_task', task_id: D8.importTask, title: '实现 CHAIN.json 导入器并跑通一次端到端导入',
        assignee: { actor_id: EXECUTOR.id, actor_kind: 'agent' },
        contract: {
          rev: 1,
          acceptance_criteria: [
            { criterion_ref: D8.criterionRoundtrip, check: 'auto', text: '端到端导入后 Task/Run/Acceptance 数量与 CHAIN.json 一致' },
            { criterion_ref: D8.criterionUnmapped, check: 'human', text: '无法映射清单已逐项列出并给出来源路径' },
          ],
          expected_outputs: ['导入脚本', '映射成功率报告草稿'],
          required_capabilities: ['doc.import', 'code.write'],
          side_effect_ceiling: 'L1' as SideEffectLevel,
          run_timeout: 'PT15M',
        },
      },
      { op: 'add_task', task_id: D8.reportTask, title: '复核映射成功率报告并给结论', assignee: { actor_id: HUMAN.id, actor_kind: 'human' } },
      { op: 'add_edge', edge_id: 'edge-import-report', from_task: D8.importTask, to_task: D8.reportTask, kind: 'depends_on' },
      { op: 'add_edge', edge_id: 'edge-data-import-report', from_task: D8.importTask, to_task: D8.reportTask, kind: 'data_from', data_mode: 'latest_accepted' },
      { op: 'add_edge', edge_id: 'edge-part-import', from_task: D8.importTask, to_task: D8.captureTask, kind: 'part_of' },
    ],
  };

  const vMain = validatePlanChange(projection, D8.project, mainPlan, seenProposals);
  r.note(`主计划校验 → ok=${vMain.ok} stage=${vMain.stage}（预算关口恒通过、只记账：REQ-PC-6）`);
  if (!vMain.ok) throw new Error(`主计划理应通过 REQ-PC-1，实际被拒：${vMain.detail}`);

  await r.emit('PlanChangeProposed', planChangePayload(mainPlan), PLANNER);
  seenProposals.set(proposalKey(mainPlan), mainPlan.change_id);

  // REQ-PC-2 原子性：ops 要么全应用并产生恰一个 PlanRevision
  const mainApplied = await r.emit('PlanChangeApplied', { change_id: mainPlan.change_id, plan_rev: 1, applied_ops: mainPlan.ops.length }, KERNEL);
  await r.emit('TaskCaptured', { task_id: D8.importTask, goal_id: D8.goal, title: '实现 CHAIN.json 导入器并跑通一次端到端导入', change_id: mainPlan.change_id, introduced_via: 'plan-change-op:add_task' }, KERNEL, { causation_id: mainApplied.id });
  await r.emit('TaskCaptured', { task_id: D8.reportTask, goal_id: D8.goal, title: '复核映射成功率报告并给结论', change_id: mainPlan.change_id, introduced_via: 'plan-change-op:add_task' }, KERNEL);
  await r.emit('ContractUpdated', contractPayload(D8.importTask, 1, mainPlan), KERNEL);
  for (const op of mainPlan.ops.filter((o) => o.op === 'add_edge')) {
    await r.emit('EdgeAdded', { edge_id: op.edge_id, from_task: op.from_task, to_task: op.to_task, kind: op.kind, ...(op.data_mode ? { data_mode: op.data_mode } : {}) }, KERNEL);
  }
  await r.emit('PlanRevisionCreated', { rev: 1, change_id: mainPlan.change_id, applied_at: FIXED_NOW.toISOString(), diff_summary: '+2 Task, +3 Edge' }, KERNEL);

  step = await r.end();
  assertTypes(step, [
    'PlanChangeProposed', 'PlanChangeApplied', 'TaskCaptured', 'TaskCaptured',
    'ContractUpdated', 'EdgeAdded', 'EdgeAdded', 'EdgeAdded', 'PlanRevisionCreated',
  ]);

  // ======================================================================
  // ②c Policy 越权 → Decision 回路（REQ-PC-3 / REQ-PC-5）→ rev 2
  // ======================================================================
  await r.begin('②c 越权提议 → Decision → 批准后以当前 rev 为新 base 重走校验', ['REQ-PC-1④', 'REQ-PC-3', 'REQ-PC-5', 'REQ-GD-2']);

  const shadowPlan: PlanChangeDraft = {
    change_id: D8.planDocGap, client_proposal_id: 'prop-shadow-1', proposer_id: SHADOW_PLANNER.id,
    base_plan_rev: 1, risk_level: 'L1', estimated_budget: 800,
    rationale: '不在 allowed_proposers 内的提议者加一个「记录映射缺陷清单」Task',
    assumptions: [],
    ops: [{ op: 'add_task', task_id: D8.docTask, title: '登记无法映射字段清单（缺陷证据）', assignee: { actor_id: HUMAN.id, actor_kind: 'human' } }],
  };
  const vShadow = validatePlanChange(projection, D8.project, shadowPlan, seenProposals);
  r.note(`越权校验 → code=${vShadow.reason_code} 可由人裁决=${vShadow.decision_eligible}`);
  await r.emit('PlanChangeProposed', planChangePayload(shadowPlan), SHADOW_PLANNER);
  await r.emit('DecisionCreated', {
    decision_id: D8.decisionDocGap, subject_ref: `plan_change:${shadowPlan.change_id}`,
    question: '是否允许非在册提议者的计划改动并登记缺陷清单？',
    recommendation: '批准改动，但改由在册 Planner 重新提交', status: 'pending',
  }, KERNEL);
  await r.emit('PlanChangeStatusChanged', { change_id: shadowPlan.change_id, from: 'proposed', to: 'needs_decision', decision_id: D8.decisionDocGap }, KERNEL);

  // REQ-PC-5：approved ≠ 绕过校验，以裁决时刻当前 rev 为新 base 重走 REQ-PC-1
  await r.emit('DecisionResolved', { decision_id: D8.decisionDocGap, resolution: 'approved', decided_by: HUMAN.id, decided_at: FIXED_NOW.toISOString() }, HUMAN);
  const resubmit: PlanChangeDraft = { ...shadowPlan, change_id: `${shadowPlan.change_id}-approved`, client_proposal_id: 'prop-shadow-1-approved', proposer_id: PLANNER.id, base_plan_rev: projection.planRev };
  const vResubmit = validatePlanChange(projection, D8.project, resubmit, seenProposals);
  r.note(`批准后重走校验 → ok=${vResubmit.ok} base 已更新为 ${resubmit.base_plan_rev}`);
  if (!vResubmit.ok) throw new Error(`REQ-PC-5 批准后重走校验理应通过：${vResubmit.detail}`);

  await r.emit('PlanChangeProposed', planChangePayload(resubmit), PLANNER);
  seenProposals.set(proposalKey(resubmit), resubmit.change_id);
  await r.emit('PlanChangeApplied', { change_id: resubmit.change_id, plan_rev: 2, applied_ops: resubmit.ops.length }, KERNEL);
  await r.emit('TaskCaptured', { task_id: D8.docTask, goal_id: D8.goal, title: '登记无法映射字段清单（缺陷证据）', change_id: resubmit.change_id, introduced_via: 'plan-change-op:add_task' }, KERNEL);
  await r.emit('PlanRevisionCreated', { rev: 2, change_id: resubmit.change_id, applied_at: FIXED_NOW.toISOString(), diff_summary: '+1 Task' }, KERNEL);

  step = await r.end();
  assertTypes(step, [
    'PlanChangeProposed', 'DecisionCreated', 'PlanChangeStatusChanged', 'DecisionResolved',
    'PlanChangeProposed', 'PlanChangeApplied', 'TaskCaptured', 'PlanRevisionCreated',
  ]);

  // ======================================================================
  // ②d base_rev_conflict 负例（REQ-PC-1②：返回三方差异，不自动覆盖）
  // ======================================================================
  await r.begin('②d 版本冲突负例（陈旧 base_plan_rev）', ['REQ-PC-1②', 'REQ-PC-3', 'C3']);

  const stale: PlanChangeDraft = {
    change_id: 'pc-d8-stale', client_proposal_id: 'prop-stale-1', proposer_id: PLANNER.id,
    base_plan_rev: 0, risk_level: 'L1', estimated_budget: 100, rationale: '以 rev 0 为基线的旧提议',
    assumptions: [], ops: [{ op: 'update_task_text', task_id: D8.importTask, title: '导入器（改标题）' }],
  };
  const vStale = validatePlanChange(projection, D8.project, stale, seenProposals);
  const triple = vStale.conflict_baseline
    ? `基线=${vStale.conflict_baseline.base_plan_rev}/当前=${vStale.conflict_baseline.current_plan_rev}/提议=${vStale.conflict_baseline.proposed.change_id}`
    : '无三方基线';
  r.note(`版本冲突 → code=${vStale.reason_code} 可由人裁决=${vStale.decision_eligible}；${triple}`);
  await r.emit('PlanChangeProposed', planChangePayload(stale), PLANNER);
  await r.emit('DecisionCreated', { decision_id: 'dec-d8-stale', subject_ref: 'plan_change:pc-d8-stale', question: '基线过期：以当前 rev 重提还是作废？', recommendation: '作废并重提', status: 'pending' }, KERNEL);
  await r.emit('PlanChangeStatusChanged', { change_id: stale.change_id, from: 'proposed', to: 'needs_decision', decision_id: 'dec-d8-stale' }, KERNEL);

  step = await r.end();
  assertTypes(step, ['PlanChangeProposed', 'DecisionCreated', 'PlanChangeStatusChanged']);

  // ======================================================================
  // ③ 派活给代码 Agent：Assignment + Run 全生命周期（§3.1/§3.2、REQ-RUN-1）
  // ======================================================================
  await r.begin('③a 定义与就绪判定（REQ-TC-1 / REQ-SCH-1 / REQ-SCH-4）', ['§3.1', 'REQ-TC-1', 'REQ-SCH-1', 'REQ-SCH-4']);

  const notReady = computeReady(projection, D8.importTask);
  r.note(`captured 态 ready 判定 → ready=${notReady.ready} 原因=${notReady.reasons.join(' | ')}`);

  await r.transitionTask({
    task_id: D8.importTask, from: 'captured', to: 'defined',
    facts: { hasTitle: true, assigneeKind: 'agent', contractStructured: true },
    extra: { trigger_event_id: null, contract_rev: 1 },
  });
  await r.sync();
  const ready = computeReady(projection, D8.importTask);
  r.note(`defined 态 ready 判定 → ready=${ready.ready} 原因=${ready.reasons.join(' | ') || '（无）'}`);
  const reportNotReady = computeReady(projection, D8.reportTask);
  r.note(`下游 report ready → ready=${reportNotReady.ready} 原因=${reportNotReady.reasons.join(' | ')}`);

  await r.transitionTask({ task_id: D8.importTask, from: 'defined', to: 'ready' });
  await r.emit('AssignmentCreated', {
    assignment_id: D8.assignmentImport, task_id: D8.importTask,
    actor_id: EXECUTOR.id, actor_kind: 'agent', role: 'executor',
    scope_note: '按契约 rev 1 实现并跑通导入', created_via: 'plan-change-op:add_task',
    assigned_at: FIXED_NOW.toISOString(),
  }, HUMAN);

  step = await r.end();
  assertTypes(step, ['TaskLifecycleChanged', 'TaskLifecycleChanged', 'AssignmentCreated']);

  await r.begin('③b 派发 Run 并推进 created→queued→leased→running', ['§2.4', '§3.2', 'REQ-RUN-1', 'REQ-CX-1', 'INV-3']);

  const inputSnapshot = {
    contract: { task_id: D8.importTask, contract_rev: 1, criteria: [D8.criterionRoundtrip, D8.criterionUnmapped], expected_outputs: ['导入脚本', '映射成功率报告草稿'] },
    goal_statement: '跑通 nx-pipeline 双轨对照：导入一次真实 run 并产出映射成功率报告',
    hard_rules: { auto_apply_ceiling: 'L1', require_decision_for: ['policy_change', 'external_side_effect_L2'] },
    upstream_accepted: [],
    prior_run_excerpt: null,
    assembled_by: 'kernel-context-assembler',
  };
  const beforeHash = canonicalJson(inputSnapshot);

  await r.transitionTask({ task_id: D8.importTask, from: 'ready', to: 'active', extra: { triggered_by: '派发 Run' } });
  await r.emit('RunCreated', {
    run_id: D8.runImport, task_id: D8.importTask, assignment_id: D8.assignmentImport,
    run_kind: 'executor', task_rev: 1, contract_rev: 1, plan_rev: 1,
    input_snapshot: inputSnapshot,
    policy_snapshot: { policy_id: D8.policy, auto_apply_ceiling: 'L1', side_effect_grants: ['L0', 'L1'] },
    actor_id: EXECUTOR.id, actor_version: 'opencode@1.4.2',
    idempotency_key: 'run-d8-import-1', side_effect_level: 'L1' as SideEffectLevel,
  }, KERNEL);
  await r.transitionRun({ run_id: D8.runImport, type: 'RunQueued', from: 'created', to: 'queued' });
  await r.transitionRun({
    run_id: D8.runImport, type: 'RunLeased', from: 'queued', to: 'leased', actor: EXECUTOR,
    payload: { lease_expires_at: '2026-10-23T00:00:45.000Z', lease_ttl_seconds: 45 },
  });
  await r.transitionRun({
    run_id: D8.runImport, type: 'RunStarted', from: 'leased', to: 'running', actor: EXECUTOR,
    payload: { started_at: FIXED_NOW.toISOString(), run_timeout: 'PT15M' },
  });

  step = await r.end();
  assertTypes(step, [
    'TaskLifecycleChanged', 'RunCreated', 'RunQueued', 'RunLeased', 'RunStarted',
  ]);

  // ======================================================================
  // ③c 在跑 Run 期间改计划（G2 / REQ-PC-4 / INV-3）
  // ======================================================================
  await r.begin('③c 在跑 Run 应用新 Revision：快照哈希不变（G2）', ['REQ-PC-4', 'INV-3', 'INV-5', '§8.1 G2']);

  const midflight: PlanChangeDraft = {
    change_id: D8.planMidflight, client_proposal_id: 'prop-mid-1', proposer_id: PLANNER.id,
    base_plan_rev: projection.planRev, risk_level: 'L1', estimated_budget: 400,
    rationale: '运行中新加一个补充 Task，验证不追改在跑 Run 的快照',
    assumptions: [],
    ops: [{ op: 'add_task', task_id: 'task-d8-appendix', title: '补充：记录导入耗时（G2 观察项）', assignee: { actor_id: HUMAN.id, actor_kind: 'human' } }],
  };
  const vMid = validatePlanChange(projection, D8.project, midflight, seenProposals);
  if (!vMid.ok) throw new Error(`G2 计划改动理应通过：${vMid.detail}`);
  await r.emit('PlanChangeProposed', planChangePayload(midflight), PLANNER);
  seenProposals.set(proposalKey(midflight), midflight.change_id);
  await r.emit('PlanChangeApplied', { change_id: midflight.change_id, plan_rev: 3, applied_ops: midflight.ops.length }, KERNEL);
  await r.emit('TaskCaptured', { task_id: 'task-d8-appendix', goal_id: D8.goal, title: '补充：记录导入耗时（G2 观察项）', change_id: midflight.change_id, introduced_via: 'plan-change-op:add_task' }, KERNEL);
  await r.emit('PlanRevisionCreated', { rev: 3, change_id: midflight.change_id, applied_at: FIXED_NOW.toISOString(), diff_summary: '+1 Task' }, KERNEL);

  const runRow = projection.runs.get(D8.runImport);
  const afterHash = canonicalJson(runRow?.input_snapshot);
  r.note(`在跑 Run 快照哈希 before=${beforeHash.slice(0, 16)}… after=${afterHash.slice(0, 16)}… 相同=${beforeHash === afterHash}；run.plan_rev 仍=${runRow?.plan_rev}（新 Revision=${projection.planRev}）`);

  step = await r.end();
  assertTypes(step, ['PlanChangeProposed', 'PlanChangeApplied', 'TaskCaptured', 'PlanRevisionCreated']);

  // ======================================================================
  // ④ 人类反馈：RawResult + Feedback 入账/解析解耦 + 幂等重放（C2）
  // ======================================================================
  await r.begin('④a Executor 原始回报入 Evidence/RawResult（REQ-CX-1）', ['§2.5', 'REQ-CX-1', 'INV-6', 'S5']);

  await r.emit('RunRawResultReceived', {
    run_id: D8.runImport, raw_result_ref: 'object://d8/run-import-1.raw.txt',
    content_hash: sha256(RAW_RESULT_TEXT), excerpt: RAW_EXCERPT, excerpt_chars: RAW_EXCERPT.length,
  }, EXECUTOR);
  await r.emit('EvidenceAdded', {
    evidence_id: D8.evidenceAgentClaim, task_id: D8.importTask, source_kind: 'agent_claim',
    content_ref: 'object://d8/run-import-1.raw.txt', content_hash: sha256(RAW_RESULT_TEXT),
    captured_at: FIXED_NOW.toISOString(), environment: 'sandbox-node24', verification_status: 'unverified',
  }, EXECUTOR);
  await r.emit('EvidenceAdded', {
    evidence_id: D8.evidenceExternalDoc, task_id: D8.importTask, source_kind: 'external_doc',
    content_ref: 'file://nx-pipeline/runs/nx-2026-10-18-07/CHAIN.json', content_hash: sha256('CHAIN.json-placeholder'),
    captured_at: FIXED_NOW.toISOString(), environment: 'pipeline-archive', verification_status: 'unverified',
    source_note: '双轨导入按 external_doc 入账，不冒充 tool_output（S5/REQ-DT-1）',
  }, KERNEL);

  step = await r.end();
  assertTypes(step, ['RunRawResultReceived', 'EvidenceAdded', 'EvidenceAdded']);

  await r.begin('④b 人类反馈入账 + 同客户端提交 id 重放 10 次（REQ-FB-1 / REQ-DD-1 / C2）', ['§2.5', 'REQ-FB-1', 'REQ-DD-1', 'INV-13', 'C2']);

  const feedbackPayload = {
    feedback_id: D8.feedbackRun, task_id: D8.importTask, run_id: D8.runImport,
    author_id: HUMAN.id,
    raw_content: '我看了导入输出：三个 phase 里第三个的 verdict 字段确实没法直接映射，原始文件在 run 目录里，我按 external_doc 记了路径',
    raw_attachments: ['file://nx-pipeline/runs/nx-2026-10-18-07/CHAIN.json'],
    received_at: FIXED_NOW.toISOString(), interpretation_status: 'pending',
    client_submit_id: 'fb-submit-d8-1',
  };
  const firstFb = await r.emit('FeedbackReceived', feedbackPayload, HUMAN, { idempotency_key: 'fb-submit-d8-1' });
  for (let i = 0; i < 10; i++) {
    const replayed = await r.emit('FeedbackReceived', feedbackPayload, HUMAN, { idempotency_key: 'fb-submit-d8-1' });
    if (replayed.id !== firstFb.id) {
      r.note(`重放第 ${i + 1} 次返回了**不同**信封（INV-13 违约）`);
    }
  }
  r.note('同 client_submit_id 投递 1+10 次 → 期望事件流仅 +1（INV-13/REQ-DD-1）');
  await r.emit('FeedbackInterpreted', { feedback_id: D8.feedbackRun, interpretation_status: 'interpreted', proposal_id: 'prop-oc-d8-1', interpreted_by: INTERPRETER.id }, INTERPRETER);
  await r.emit('EvidenceAdded', {
    evidence_id: D8.evidenceUserStatement, task_id: D8.importTask, source_kind: 'user_statement',
    content_ref: 'object://d8/feedback-1.txt', content_hash: sha256('人类反馈原文'),
    captured_at: FIXED_NOW.toISOString(), environment: 'phone', verification_status: 'unverified',
  }, HUMAN);

  step = await r.end();
  assertTypes(step, ['FeedbackReceived', 'FeedbackInterpreted', 'EvidenceAdded']);

  await r.begin('④c 游离 Feedback（未绑定 Run）只入账不产 Outcome（新 P1-3）', ['§2.5', 'REQ-OC-1', 'REQ-HUM-2', '新 P1-3']);

  const outcomesBefore = projection.outcomes.size;
  await r.emit('FeedbackReceived', {
    feedback_id: D8.feedbackStray, task_id: null, run_id: null, author_id: HUMAN.id,
    raw_content: '顺便说一句，之后也许可以把 UDP 那条也测一下（此刻无对应 Run）',
    raw_attachments: [], received_at: FIXED_NOW.toISOString(),
    interpretation_status: 'pending', client_submit_id: 'fb-submit-d8-stray',
  }, HUMAN, { idempotency_key: 'fb-submit-d8-stray' });
  await r.emit('FeedbackInterpreted', { feedback_id: D8.feedbackStray, interpretation_status: 'interpreted', proposal_id: 'prop-oc-d8-stray', interpreted_by: INTERPRETER.id, excerpt_for_future_binding: 'UDP 实测建议（留待绑定）' }, INTERPRETER);

  const strayDraft: OutcomeDraft = {
    outcome_id: 'oc-d8-stray', task_id: D8.importTask, run_id: null, feedback_id: D8.feedbackStray,
    proposal_id: 'prop-oc-d8-stray', interpreted_by: INTERPRETER.id, evidence_refs: [],
    dimensions: { info_obtained: false, conclusion_kind: 'unknown', certainty: 'low', evidence_sufficiency: 'none', blockers: [], followup_suggestions: ['UDP 实测'] },
  };
  const vStray = validateOutcomeProposal(projection, strayDraft);
  r.note(`游离 Feedback 生成 Outcome 的校验 → ok=${vStray.ok} code=${vStray.code}（${vStray.detail}）`);
  const tasksWithOutcomeBefore = new Map([...projection.tasks].map(([id, t]) => [id, t.last_outcome_id]));
  r.note(`游离 Feedback 未新增 Outcome：outcomes ${outcomesBefore}→${projection.outcomes.size}；各 Task last_outcome_id 未变=${JSON.stringify([...tasksWithOutcomeBefore.entries()]) === JSON.stringify([...projection.tasks].map(([id, t]) => [id, t.last_outcome_id]))}`);

  step = await r.end();
  assertTypes(step, ['FeedbackReceived', 'FeedbackInterpreted']);

  // ======================================================================
  // ⑤ 产出：Outcome 入账（REQ-OC-1/OC-2）+ Run succeeded + Task awaiting_acceptance
  // ======================================================================
  await r.begin('⑤ 产出：Outcome 入账 → Run succeeded → Task active→awaiting_acceptance', ['§2.5', 'REQ-OC-1', '§3.1', 'REQ-ACC-3', '§8.1 G3']);

  const directDraft: OutcomeDraft = {
    outcome_id: 'oc-d8-illegal', task_id: D8.importTask, run_id: D8.runImport, feedback_id: D8.feedbackRun,
    proposal_id: null, interpreted_by: EXECUTOR.id, evidence_refs: [D8.evidenceAgentClaim],
    dimensions: { info_obtained: true, conclusion_kind: 'achieved', certainty: 'high', evidence_sufficiency: 'sufficient', blockers: [], followup_suggestions: [] },
  };
  const vDirect = validateOutcomeProposal(projection, directDraft);
  r.note(`Executor 直接写 Outcome（无 proposal_id）→ ok=${vDirect.ok} code=${vDirect.code}（REQ-OC-1 拒绝）`);
  await r.expectDeniedWrite('Outcome 由 Executor 直写', async () => {
    if (!vDirect.ok) throw new Error(`${vDirect.code}: ${vDirect.detail}`);
    return r.emit('OutcomeRecorded', outcomePayload(directDraft), KERNEL);
  });

  const partialDraft: OutcomeDraft = {
    outcome_id: D8.outcomePartial, task_id: D8.importTask, run_id: D8.runImport, feedback_id: D8.feedbackRun,
    proposal_id: 'prop-oc-d8-1', interpreted_by: INTERPRETER.id,
    evidence_refs: [D8.evidenceAgentClaim, D8.evidenceExternalDoc, D8.evidenceUserStatement],
    dimensions: {
      info_obtained: true, conclusion_kind: 'partial', certainty: 'med', evidence_sufficiency: 'sufficient',
      blockers: ['CHAIN.json phase-3 的 verdict 字段没有对应的 Acceptance.criterion_results 结构'],
      followup_suggestions: ['补一份无法映射字段清单'],
    },
  };
  const vPartial = validateOutcomeProposal(projection, partialDraft);
  if (!vPartial.ok) throw new Error(`Outcome 理应通过 REQ-OC-1：${vPartial.detail}`);
  await r.emit('OutcomeRecorded', outcomePayload(partialDraft), KERNEL);
  await r.transitionRun({
    run_id: D8.runImport, type: 'RunSucceeded', from: 'running', to: 'succeeded', actor: EXECUTOR,
    payload: { budget: { estimated: 32000, actual: 9340, unit: 'token' }, finished_at: FIXED_NOW.toISOString() },
  });
  await r.transitionTask({ task_id: D8.importTask, from: 'active', to: 'awaiting_acceptance', extra: { trigger: 'Run 出 Outcome', outcome_id: D8.outcomePartial } });

  step = await r.end();
  assertTypes(step, ['OutcomeRecorded', 'RunSucceeded', 'TaskLifecycleChanged']);

  // ======================================================================
  // ⑥ 验收：负例 → partially_accepted → 补集 → accepted + INV-11 收尾 + 下游就绪
  // ======================================================================
  await r.begin('⑥a 跟进提议（REQ-HUM-3：add_wait + add_task + add_edge part_of）', ['§5.7', 'REQ-HUM-3', '§3.1', 'INV-10']);

  const followupPlan: PlanChangeDraft = {
    change_id: D8.planFollowup, client_proposal_id: 'prop-followup-1', proposer_id: INTERPRETER.id,
    base_plan_rev: projection.planRev, risk_level: 'L1', estimated_budget: 600,
    rationale: '为未过判据挂 person 等待 + 恰一个跟进 Task',
    assumptions: [],
    ops: [
      { op: 'add_task', task_id: D8.followupTask, title: '补无法映射字段清单并回签', assignee: { actor_id: HUMAN.id, actor_kind: 'human' } },
      { op: 'add_wait', wait_condition_id: D8.waitCondition, task_id: D8.importTask, wait_kind: 'person', target_ref: 'actor-human-2', due_at: '2026-10-30T00:00:00.000Z' },
      { op: 'add_edge', edge_id: 'edge-part-followup', from_task: D8.followupTask, to_task: D8.importTask, kind: 'part_of' },
    ],
  };
  const vFollowup = validatePlanChange(projection, D8.project, followupPlan, seenProposals);
  if (!vFollowup.ok) throw new Error(`跟进计划理应通过：${vFollowup.detail}`);
  await r.emit('PlanChangeProposed', planChangePayload(followupPlan), INTERPRETER);
  seenProposals.set(proposalKey(followupPlan), followupPlan.change_id);
  await r.emit('PlanChangeApplied', { change_id: followupPlan.change_id, plan_rev: 4, applied_ops: followupPlan.ops.length }, KERNEL);
  await r.emit('TaskCaptured', { task_id: D8.followupTask, goal_id: D8.goal, title: '补无法映射字段清单并回签', change_id: followupPlan.change_id, introduced_via: 'plan-change-op:add_task' }, KERNEL);
  await r.emit('EdgeAdded', { edge_id: 'edge-part-followup', from_task: D8.followupTask, to_task: D8.importTask, kind: 'part_of' }, KERNEL);
  await r.emit('WaitConditionCreated', {
    wait_condition_id: D8.waitCondition, task_id: D8.importTask, kind: 'person',
    target_ref: 'actor-human-2', due_at: '2026-10-30T00:00:00.000Z', followup_task_id: D8.followupTask,
  }, KERNEL);
  const mappedWait = waitStateForConditionKind('person');
  await r.emit('TaskWaitStateChanged', { task_id: D8.importTask, from: 'none', to: mappedWait ?? 'waiting_on_person', reason: 'WaitCondition kind=person（§3.1 映射表）', set_by: KERNEL.id }, KERNEL);
  await r.emit('PlanRevisionCreated', { rev: 4, change_id: followupPlan.change_id, applied_at: FIXED_NOW.toISOString(), diff_summary: '+1 Task, +1 Edge, +1 WaitCondition' }, KERNEL);
  r.note(`跟进 Task 唯一：followup_task_id=${D8.followupTask}；wait_state 映射自内核 WAIT_STATE_BY_CONDITION_KIND → ${mappedWait}`);

  step = await r.end();
  assertTypes(step, [
    'PlanChangeProposed', 'PlanChangeApplied', 'TaskCaptured', 'EdgeAdded',
    'WaitConditionCreated', 'TaskWaitStateChanged', 'PlanRevisionCreated',
  ]);

  await r.begin('⑥b 入账负例：actor 分离 / 覆盖完整性 / verdict 一致性', ['REQ-ACC-2', '新 P1-1', 'C6']);

  const accSelf: AcceptanceDraft = {
    acceptance_id: 'acc-d8-self', task_id: D8.importTask, contract_rev: 1,
    subject_outcome_id: D8.outcomePartial, acceptor_id: EXECUTOR.id, acceptor_kind: 'human',
    verdict: 'accepted',
    criterion_results: [
      { criterion_ref: D8.criterionRoundtrip, verdict: 'passed', evidence_refs: [D8.evidenceAgentClaim] },
      { criterion_ref: D8.criterionUnmapped, verdict: 'passed', evidence_refs: [D8.evidenceAgentClaim] },
    ],
    supersedes_id: null, evidence_refs: [D8.evidenceAgentClaim], rationale: 'Agent 自验自收',
  };
  const vSelf = validateAcceptance(projection, accSelf);
  r.note(`执行 Run 的 actor 自验收 → ok=${vSelf.ok} code=${vSelf.code}（REQ-ACC-2/C6 拦截）`);
  await r.expectDeniedWrite('Acceptance 由 Run actor 自验', async () => {
    if (!vSelf.ok) throw new Error(`${vSelf.code}: ${vSelf.detail}`);
    return r.emit('AcceptanceRecorded', acceptancePayload(accSelf), HUMAN);
  });

  const accMissing: AcceptanceDraft = { ...accSelf, acceptance_id: 'acc-d8-missing', acceptor_id: HUMAN.id, criterion_results: [{ criterion_ref: D8.criterionRoundtrip, verdict: 'passed', evidence_refs: [D8.evidenceAgentClaim] }] };
  const vMissing = validateAcceptance(projection, accMissing);
  r.note(`漏判据入账 → ok=${vMissing.ok} code=${vMissing.code}（新 P1-1① 覆盖完整性）`);
  await r.expectDeniedWrite('Acceptance 缺判据', async () => {
    if (!vMissing.ok) throw new Error(`${vMissing.code}: ${vMissing.detail}`);
    return r.emit('AcceptanceRecorded', acceptancePayload(accMissing), HUMAN);
  });

  const accInconsistent: AcceptanceDraft = { ...accMissing, acceptance_id: 'acc-d8-inconsistent', criterion_results: [
    { criterion_ref: D8.criterionRoundtrip, verdict: 'failed', evidence_refs: [D8.evidenceAgentClaim] },
    { criterion_ref: D8.criterionUnmapped, verdict: 'failed', evidence_refs: [D8.evidenceAgentClaim] },
  ], verdict: 'accepted' };
  const vInconsistent = validateAcceptance(projection, accInconsistent);
  r.note(`逐项全 failed 却写 accepted → ok=${vInconsistent.ok} code=${vInconsistent.code}（REQ-ACC-2 一致性）`);
  await r.expectDeniedWrite('Acceptance verdict 不一致', async () => {
    if (!vInconsistent.ok) throw new Error(`${vInconsistent.code}: ${vInconsistent.detail}`);
    return r.emit('AcceptanceRecorded', acceptancePayload(accInconsistent), HUMAN);
  });

  const accByBot: AcceptanceDraft = { ...accMissing, acceptance_id: 'acc-d8-bot', acceptor_id: REVIEW_BOT.id, acceptor_kind: 'agent', criterion_results: [
    { criterion_ref: D8.criterionRoundtrip, verdict: 'passed', evidence_refs: [D8.evidenceAgentClaim] },
    { criterion_ref: D8.criterionUnmapped, verdict: 'passed', evidence_refs: [D8.evidenceAgentClaim] },
  ] };
  const vBot = validateAcceptance(projection, accByBot);
  r.note(`非 auto 判据由 agent actor 结论 → ok=${vBot.ok} code=${vBot.code}（REQ-ACC-2：须人/独立评审）`);

  step = await r.end();
  assertTypes(step, []);

  await r.begin('⑥c partially_accepted：停在 awaiting_acceptance，只留待补集（S4）', ['§2.6', 'REQ-ACC-3', 'S4', 'Q1']);

  const accPartial: AcceptanceDraft = {
    acceptance_id: D8.acceptancePartial, task_id: D8.importTask, contract_rev: 1,
    subject_outcome_id: D8.outcomePartial, acceptor_id: HUMAN.id, acceptor_kind: 'human',
    verdict: 'partially_accepted',
    criterion_results: [
      { criterion_ref: D8.criterionRoundtrip, verdict: 'passed', evidence_refs: [D8.evidenceAgentClaim, D8.evidenceExternalDoc] },
      { criterion_ref: D8.criterionUnmapped, verdict: 'failed', evidence_refs: [] },
    ],
    supersedes_id: null, evidence_refs: [D8.evidenceAgentClaim, D8.evidenceExternalDoc],
    rationale: '端到端数量一致可判；无法映射清单未交',
  };
  const vPartialAcc = validateAcceptance(projection, accPartial);
  if (!vPartialAcc.ok) throw new Error(`partially 理应入账：${vPartialAcc.detail}`);
  r.note(`partially 校验通过 → 重算落点=${vPartialAcc.derived_lifecycle}，待补集=${(vPartialAcc.pending_criteria ?? []).join(',')}`);
  await r.emit('AcceptanceRecorded', acceptancePayload(accPartial), HUMAN);

  step = await r.end();
  assertTypes(step, ['AcceptanceRecorded']);

  await r.begin('⑥d 补集：第二次 Feedback → 新 Outcome supersede → accepted（INV-11 同事务收尾）', ['REQ-FB-1', 'INV-7', '§2.5', 'REQ-ACC-3/4', 'INV-11']);

  await r.emit('EvidenceAdded', {
    evidence_id: D8.evidenceNewDoc, task_id: D8.importTask, source_kind: 'external_doc',
    content_ref: 'object://d8/unmapped-field-notes.md', content_hash: sha256('无法映射字段清单 v1'),
    captured_at: FIXED_NOW.toISOString(), environment: 'phone', verification_status: 'unverified',
  }, HUMAN);
  await r.emit('FeedbackReceived', {
    feedback_id: D8.feedbackSecond, task_id: D8.importTask, run_id: D8.runImport, author_id: HUMAN.id,
    raw_content: '无法映射字段清单我补齐了：verdict 拆成 criterion 级、run-id 作为 Artifact 版本键',
    raw_attachments: ['object://d8/unmapped-field-notes.md'], received_at: FIXED_NOW.toISOString(),
    interpretation_status: 'pending', client_submit_id: 'fb-submit-d8-2',
  }, HUMAN, { idempotency_key: 'fb-submit-d8-2' });
  await r.emit('FeedbackInterpreted', { feedback_id: D8.feedbackSecond, interpretation_status: 'interpreted', proposal_id: 'prop-oc-d8-2', interpreted_by: INTERPRETER.id }, INTERPRETER);

  const finalOutcomeDraft: OutcomeDraft = {
    outcome_id: D8.outcomeFinal, task_id: D8.importTask, run_id: D8.runImport, feedback_id: D8.feedbackSecond,
    proposal_id: 'prop-oc-d8-2', interpreted_by: INTERPRETER.id,
    evidence_refs: [D8.evidenceNewDoc, D8.evidenceUserStatement],
    supersedes_id: D8.outcomePartial,
    dimensions: { info_obtained: true, conclusion_kind: 'achieved', certainty: 'high', evidence_sufficiency: 'sufficient', blockers: [], followup_suggestions: [] },
  };
  // 同步骤内先写后验：把上面 EvidenceAdded/Feedback* 事件读回投影（仍只从事件派生）
  await r.sync();
  const vFinal = validateOutcomeProposal(projection, finalOutcomeDraft);
  if (!vFinal.ok) throw new Error(`补集 Outcome 理应通过：${vFinal.detail}`);
  await r.emit('OutcomeRecorded', outcomePayload(finalOutcomeDraft), KERNEL);
  await r.sync();

  const accFinal: AcceptanceDraft = {
    acceptance_id: D8.acceptanceFinal, task_id: D8.importTask, contract_rev: 1,
    subject_outcome_id: D8.outcomeFinal, acceptor_id: HUMAN.id, acceptor_kind: 'human',
    verdict: 'accepted',
    criterion_results: [
      { criterion_ref: D8.criterionRoundtrip, verdict: 'passed', evidence_refs: [D8.evidenceAgentClaim, D8.evidenceExternalDoc] },
      { criterion_ref: D8.criterionUnmapped, verdict: 'passed', evidence_refs: [D8.evidenceNewDoc] },
    ],
    supersedes_id: D8.acceptancePartial, evidence_refs: [D8.evidenceNewDoc],
    rationale: '判据全过；acc-partial 由本条取代',
  };
  const vFinalAcc = validateAcceptance(projection, accFinal);
  if (!vFinalAcc.ok) throw new Error(`最终验收理应入账：${vFinalAcc.detail}`);
  await r.emit('AcceptanceRecorded', acceptancePayload(accFinal), HUMAN);
  await r.emit('AcceptanceSuperseded', {
    superseded_id: D8.acceptancePartial, superseded_by_id: D8.acceptanceFinal,
    reason: 'superseded_by_new_acceptance', downstream_tasks: [D8.reportTask],
  }, KERNEL);
  await r.emit('LatestAcceptedPointerMoved', {
    from_task: D8.importTask, to_task: D8.reportTask,
    from_outcome_id: D8.outcomePartial, to_outcome_id: D8.outcomeFinal,
  }, KERNEL);

  // INV-11：终态迁移同事务自动收尾（先 canceled → wait 归 none → lifecycle accepted）
  const inv11Effects = await r.withTransaction(async (tx) => {
    await tx.append('WaitConditionCanceled', { wait_condition_id: D8.waitCondition, reason: 'INV-11 终态收尾' });
    await tx.append('TaskWaitStateChanged', { task_id: D8.importTask, from: 'waiting_on_person', to: 'none', reason: 'INV-11 终态收尾归 none' });
    return tx.transitionTask(D8.importTask, 'awaiting_acceptance', 'accepted', { acceptanceVerdict: 'accepted' });
  });
  r.note(`INV-11 收尾：required_effects=${inv11Effects.join('+')} → 同事务 3 事件提交`);

  await r.emit('GoalStatusChanged', { goal_id: D8.goal, from: 'active', to: 'achieved', reason: '判据全过且已验收' }, HUMAN);

  step = await r.end();
  assertTypes(step, [
    'EvidenceAdded', 'FeedbackReceived', 'FeedbackInterpreted', 'OutcomeRecorded',
    'AcceptanceRecorded', 'AcceptanceSuperseded', 'LatestAcceptedPointerMoved',
    'WaitConditionCanceled', 'TaskWaitStateChanged', 'TaskLifecycleChanged', 'GoalStatusChanged',
  ]);

  await r.begin('⑥e 下游 report 依赖满足 → ready（REQ-ACC-1 跨 rev + REQ-SCH-1/2）', ['REQ-SCH-1', 'REQ-SCH-2', 'REQ-ACC-1', 'S1', 'REQ-ASG-1']);

  await r.transitionTask({ task_id: D8.reportTask, from: 'captured', to: 'defined', facts: { hasTitle: true, assigneeKind: 'human' }, extra: { contract_rev: 0 } });
  await r.sync();
  const reportReady = computeReady(projection, D8.reportTask);
  r.note(`report ready 判定 → ready=${reportReady.ready} 原因=${reportReady.reasons.join(' | ') || '（无）'}；上游 latest_accepted 指针=${projection.latestAcceptedOutcome(D8.importTask)}`);
  if (!reportReady.ready) throw new Error(`上游已 accepted，report 理应 ready：${reportReady.reasons.join(' | ')}`);
  await r.transitionTask({ task_id: D8.reportTask, from: 'defined', to: 'ready' });
  await r.emit('AssignmentCreated', {
    assignment_id: D8.assignmentReport, task_id: D8.reportTask, actor_id: HUMAN.id, actor_kind: 'human',
    role: 'reviewer', scope_note: '按导入产物复核映射成功率报告', created_via: 'human-ui',
    assigned_at: FIXED_NOW.toISOString(),
  }, HUMAN);

  step = await r.end();
  assertTypes(step, ['TaskLifecycleChanged', 'TaskLifecycleChanged', 'AssignmentCreated']);

  // ======================================================================
  // 附：human_light Run 在 §3.2 矩阵上走不通（D9 发现的缺口，登记为断言）
  // ======================================================================
  await r.begin('附 S7：human_light Run 的 created→running 被内核矩阵拒绝（登记缺口）', ['§2.4 INV-4', '§3.2', 'REQ-HUM-1', 'S3']);

  await r.emit('RunCreated', {
    run_id: D8.runHumanLight, task_id: D8.followupTask,
    assignment_id: 'asg-d8-followup-none', run_kind: 'human_light',
    task_rev: 1, contract_rev: 0, plan_rev: 4,
    input_snapshot: { contract: { task_id: D8.followupTask, contract_rev: 0, text: '补无法映射字段清单并回签' } },
    policy_snapshot: { policy_id: D8.policy, auto_apply_ceiling: 'L1' },
    actor_id: HUMAN.id, actor_version: 'human', idempotency_key: 'run-d8-humanlight-1',
    side_effect_level: 'L0' as SideEffectLevel,
  }, HUMAN);
  const denied = await r.transitionRunDenied({ run_id: D8.runHumanLight, type: 'RunStarted', from: 'created', to: 'running', actor: HUMAN });
  r.note(`FINDING D9-J2：REQ-HUM-1 要求 human_light 走 created→running，§3.2 矩阵（src/kernel 实现）判 ${denied}。旅程在此停住该 Run，不伪造合法迁移。`);

  step = await r.end();
  assertTypes(step, ['RunCreated']);

  return { steps: r.steps, projection, seenProposals };
}

// ---------------------------------------------------------------------------
// 事务内写入句柄（INV-11 收尾；仍全部经真内核 tx.append / tx.appendStateTransition）
// ---------------------------------------------------------------------------

interface TxWriter {
  append(type: EventType, payload: unknown, actor?: ActorRef): Promise<EventEnvelope>;
  transitionTask(
    task_id: string, from: string, to: string, facts?: GuardFacts,
  ): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// payload 组装
// ---------------------------------------------------------------------------

function proposalKey(draft: PlanChangeDraft): string {
  return `${D8.project}/${draft.proposer_id}/${draft.client_proposal_id}`;
}

function planChangePayload(draft: PlanChangeDraft): Record<string, unknown> {
  return {
    change_id: draft.change_id,
    client_proposal_id: draft.client_proposal_id,
    project_id: D8.project,
    base_plan_rev: draft.base_plan_rev,
    ops: draft.ops,
    rationale: draft.rationale,
    assumptions: draft.assumptions,
    risk_level: draft.risk_level,
    estimated_budget: draft.estimated_budget,
    proposer_id: draft.proposer_id,
    status: 'proposed',
  };
}

function contractPayload(task_id: string, rev: number, draft: PlanChangeDraft): Record<string, unknown> {
  const op = draft.ops.find((o) => o.op === 'add_task' && o.task_id === task_id);
  const contract = (op?.contract ?? {}) as NonNullable<JOp['contract']>;
  return {
    task_id,
    rev,
    acceptance_criteria: contract.acceptance_criteria,
    expected_outputs: contract.expected_outputs,
    required_capabilities: contract.required_capabilities,
    side_effect_ceiling: contract.side_effect_ceiling,
    run_timeout: contract.run_timeout,
    declares_revalidation: contract.declares_revalidation ?? false,
  };
}

function outcomePayload(draft: OutcomeDraft): Record<string, unknown> {
  return {
    outcome_id: draft.outcome_id,
    task_id: draft.task_id,
    run_id: draft.run_id,
    feedback_id: draft.feedback_id,
    interpreted_by: draft.interpreted_by,
    proposal_id: draft.proposal_id,
    supersedes_id: draft.supersedes_id ?? null,
    dimensions: draft.dimensions,
    evidence_refs: draft.evidence_refs,
  };
}

function acceptancePayload(draft: AcceptanceDraft): Record<string, unknown> {
  return {
    acceptance_id: draft.acceptance_id,
    task_id: draft.task_id,
    contract_rev: draft.contract_rev,
    subject_outcome_id: draft.subject_outcome_id,
    acceptor_id: draft.acceptor_id,
    acceptor_kind: draft.acceptor_kind,
    verdict: draft.verdict,
    criterion_results: draft.criterion_results,
    evidence_refs: draft.evidence_refs,
    supersedes_id: draft.supersedes_id,
    rationale: draft.rationale,
    created_at: FIXED_NOW.toISOString(),
  };
}

function assertTypes(step: JourneyStep, expected: string[]): void {
  const actual = step.appendedTypes.join(',');
  const want = expected.join(',');
  if (actual !== want) {
    throw new Error(`步骤「${step.name}」事件流新增不符：\n  期望 ${want}\n  实际 ${actual}`);
  }
}
