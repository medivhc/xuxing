import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, createPgEventStore, migrate, type PgEventStore } from '../../src/kernel/event-store-pg.js';
import { isMatrixCellAllowed } from '../../src/kernel/transition-guard.js';
import { createTestPg, resetEventTables, type TestPg } from '../support/pg.js';
import { JourneyProjection } from './support/journey-projection.js';
import { computeReady } from './support/journey-rules.js';
import {
  D8,
  FIXED_NOW,
  runD8Journey,
  sha256,
  type JourneyRun,
  type JourneyStep,
} from './support/journey-script.js';

// ============================================================================
// D8 完整旅程（内核/API 级）：Capture → 计划（PlanChange）→ 派活（Run）→ 反馈 → 产出 → 验收
//
// 每个步骤断言两件事：
//   A. 事件流新增了哪些事件（类型序列，从 PG 读回的 seq 增量）；
//   B. 投影状态变成了什么（JourneyProjection 只从事件派生 —— D9 纪律）。
//
// 环境说明：本仓库 PG 基建由 tests/support/pg.ts 提供（docker 或 XUXING_TEST_PG_URL 外部 PG）。
// 版本闸门 assertPostgres16() 属于 C2 批次的证据，旅程测试不调用它（沙箱为真 PostgreSQL 14.24），
// 这里只断言「确实是真 PG 在服务，不是 mock」。
// ============================================================================

let ctx: TestPg;
let store: PgEventStore;
let journey: JourneyRun;
let stream: Awaited<ReturnType<PgEventStore['readStream']>>;
let pgVersion = '';

beforeAll(async () => {
  ctx = await createTestPg();
  await migrate(ctx.pool);
  await resetEventTables(ctx.pool);
  store = createPgEventStore(ctx.pool, { clock: () => FIXED_NOW });
  const { rows } = await ctx.pool.query<{ version: string }>('select version()');
  pgVersion = rows[0].version;
  journey = await runD8Journey(store);
  stream = await store.readStream(D8.project);
});

afterAll(async () => {
  await ctx?.close();
});

/** 步骤 N 结束时的投影：用「事件流前缀」重建，而不是复用脚本内存对象。 */
function stateAt(stepIndex: number): JourneyProjection {
  for (let i = stepIndex; i >= 1; i -= 1) {
    const lastId = journey.steps[i - 1].appendedIds.at(-1);
    if (lastId === undefined) continue; // 零写入步骤：状态沿用前一步水位
    const found = stream.find((event) => event.id === lastId);
    if (!found) throw new Error(`事件 ${lastId} 不在流里（步骤 ${i}）`);
    return stateThroughSeq(found.seq);
  }
  return stateThroughSeq(0);
}

/** 任意 seq 水位处的投影：只喂入 seq ≤ maxSeq 的事件（D9：状态只从事件派生）。 */
function stateThroughSeq(maxSeq: number): JourneyProjection {
  const projection = new JourneyProjection();
  for (const event of stream) {
    if (event.seq > maxSeq) break;
    projection.apply(event);
  }
  return projection;
}

/** 某步内某类事件首次出现的 seq（用于「迁移发生之前一刻」的就绪谓词判定）。 */
function firstSeqOfStep(stepName: string, type: string): number {
  const ids = new Set(step(stepName).appendedIds);
  const found = stream.find((event) => ids.has(event.id) && event.type === type);
  if (!found) throw new Error(`步骤「${stepName}」内没有 ${type} 事件`);
  return found.seq;
}

function step(name: string): JourneyStep {
  const found = journey.steps.find((s) => s.name.startsWith(name));
  if (!found) throw new Error(`旅程步骤未记录：${name}（已有：${journey.steps.map((s) => s.name).join(' / ')}）`);
  return found;
}

function taskRow(stepIndex: number, task_id: string) {
  const row = stateAt(stepIndex).tasks.get(task_id);
  if (!row) throw new Error(`步骤 ${stepIndex} 无 Task ${task_id}`);
  return row;
}

describe('环境证据：真 PostgreSQL + 旅程整体形状', () => {
  it('select version() 是真 PostgreSQL（非 mock / 非内存实现）', () => {
    expect(pgVersion).toMatch(/^PostgreSQL \d+/);
  });

  it('旅程 18 步全部执行，事件流 seq 连续且 global_seq 严格升序', () => {
    expect(journey.steps).toHaveLength(18);
    expect(stream.map((event) => event.seq)).toEqual(stream.map((_, i) => i + 1));
    const globals = stream.map((event) => event.global_seq);
    expect(globals).toEqual([...globals].sort((a, b) => a - b));
    expect(new Set(globals).size).toBe(globals.length);
  });

  it('每步 appendedTypes 之和 === 事件流总长度（无步骤外写入、无遗漏）', () => {
    const sum = journey.steps.reduce((acc, s) => acc + s.appendedTypes.length, 0);
    expect(sum).toBe(stream.length);
  });

  it('整条链可验：verifyChain ok 且长度等于事件数', async () => {
    const verification = await store.verifyChain(D8.project);
    expect(verification.ok).toBe(true);
    expect(verification.length).toBe(stream.length);
    expect(verification.stream_exists).toBe(true);
  });
});

describe('① Capture：目标与模糊输入入账', () => {
  it('事件流新增 ProjectCreated → GoalCreated → TaskCaptured', () => {
    expect(step('① Capture').appendedTypes).toEqual(['ProjectCreated', 'GoalCreated', 'TaskCaptured']);
  });

  it('投影：capture Task=captured/none，Goal=active，计划 rev=0', () => {
    const s = taskRow(1, D8.captureTask);
    expect(s.lifecycle).toBe('captured');
    expect(s.wait_state).toBe('none');
    expect(s.goal_id).toBe(D8.goal);
    const snap = step('① Capture').snapshot;
    expect(snap.goals[0].status).toBe('active');
    expect(snap.plan_rev).toBe(0);
    expect(snap.tasks).toHaveLength(1);
  });

  it('Capture 幂等：同客户端 capture id 重放只入账一次（流里该类事件仍为 1 条）', () => {
    expect(stream[2].idempotency_key).toBe('capture-d8-raw-1');
    const captures = stream.filter(
      (event) => event.type === 'TaskCaptured' &&
        (event.payload as { task_id: string }).task_id === D8.captureTask,
    );
    expect(captures).toHaveLength(1);
    // 脚本内的重放未产生第二个事件，且内核回的是同一条事件
    expect(step('① Capture').appendedTypes.filter((type) => type === 'TaskCaptured')).toHaveLength(1);
    expect(step('① Capture').notes.join(' | ')).toContain('返回同一事件 id=true');
  });
});

describe('②a 计划提议：结构错误类负例', () => {
  it('新增恰为 提议→拒绝→提议→拒绝（结构错误不转 Decision）', () => {
    expect(step('②a').appendedTypes).toEqual([
      'PlanChangeProposed', 'PlanChangeRejected', 'PlanChangeProposed', 'PlanChangeRejected',
    ]);
  });

  it('投影：两条 Change 均 rejected 且原因码为 spec 封闭枚举；没有新 Task、rev 仍 0', () => {
    const state = stateAt(2);
    const bad = state.changes.get('pc-d8-bad-schema');
    const edge = state.changes.get('pc-d8-bad-edge');
    expect(bad?.status).toBe('rejected');
    expect(bad?.reason_code).toBe('schema_invalid');
    expect(edge?.status).toBe('rejected');
    expect(edge?.reason_code).toBe('illegal_edge');
    expect(['schema_invalid', 'illegal_edge']).toContain(bad?.reason_code);
    expect(state.tasks.size).toBe(1);
    expect(state.planRev).toBe(0);
    expect(state.budget.filter((b) => b.kind === 'change')).toHaveLength(0);
  });
});

describe('②b 主计划应用（rev 1）', () => {
  it('事件流新增：提议→应用→2×TaskCaptured→ContractUpdated→3×EdgeAdded→PlanRevisionCreated', () => {
    expect(step('②b').appendedTypes).toEqual([
      'PlanChangeProposed', 'PlanChangeApplied', 'TaskCaptured', 'TaskCaptured',
      'ContractUpdated', 'EdgeAdded', 'EdgeAdded', 'EdgeAdded', 'PlanRevisionCreated',
    ]);
  });

  it('REQ-PC-2 原子性：恰一个 PlanRevision，rev 单调到 1，ops 全落地', () => {
    const snap = step('②b').snapshot;
    expect(snap.plan_rev).toBe(1);
    expect(snap.budget_ledger.filter((b) => b.kind === 'change')).toHaveLength(1);
    expect(snap.tasks.map((t) => t.task_id)).toEqual(
      [D8.captureTask, D8.importTask, D8.reportTask].sort((a, b) => a.localeCompare(b)),
    );
    expect(snap.edges).toHaveLength(3);
    expect(snap.changes.find((c) => c.change_id === D8.planChange)?.status).toBe('applied');
  });

  it('REQ-TC-1：Agent Task 带结构化契约（2 条判据 + expected_outputs + 能力 + L1 上限）', () => {
    const contract = stateAt(3).contract(D8.importTask, 1);
    expect(contract?.criterion_refs).toEqual([D8.criterionRoundtrip, D8.criterionUnmapped]);
    expect(contract?.auto_criterion_refs).toEqual([D8.criterionRoundtrip]);
    expect(contract?.expected_outputs).toEqual(['导入脚本', '映射成功率报告草稿']);
    expect(contract?.required_capabilities).toEqual(['doc.import', 'code.write']);
    expect(contract?.side_effect_ceiling).toBe('L1');
    expect(contract?.run_timeout).toBe('PT15M');
  });

  it('计划引入的 Task 记下来源（introduced_by_change_id）且引入时 rev 已生效', () => {
    const importTask = taskRow(3, D8.importTask);
    expect(importTask.introduced_by_change_id).toBe(D8.planChange);
    // TaskCaptured 在 PlanRevisionCreated 之前落库 → 引入时计划仍为 captured 初态
    expect(importTask.lifecycle).toBe('captured');
  });
});

describe('②c 越权提议 → Decision 回路（REQ-PC-3/5）', () => {
  it('事件流：提议→Decision→needs_decision→批准→重提议→应用→TaskCaptured→Revision', () => {
    expect(step('②c').appendedTypes).toEqual([
      'PlanChangeProposed', 'DecisionCreated', 'PlanChangeStatusChanged', 'DecisionResolved',
      'PlanChangeProposed', 'PlanChangeApplied', 'TaskCaptured', 'PlanRevisionCreated',
    ]);
  });

  it('投影：原越权 Change=needs_decision，批准后的新 Change=applied，rev→2', () => {
    const state = stateAt(4);
    expect(state.changes.get(D8.planDocGap)?.status).toBe('needs_decision');
    expect(state.changes.get(`${D8.planDocGap}-approved`)?.status).toBe('applied');
    expect(state.decisions.get(D8.decisionDocGap)?.status).toBe('approved');
    expect(state.planRev).toBe(2);
    expect(state.tasks.has(D8.docTask)).toBe(true);
  });

  it('REQ-PC-5：批准不等于绕过校验 —— 重提交时 base 已换成裁决时刻的当前 rev', () => {
    const state = stateAt(4);
    const resubmitted = state.changes.get(`${D8.planDocGap}-approved`);
    expect(resubmitted?.base_plan_rev).toBe(1);
    expect(resubmitted?.proposer_id).toBe('actor-planner');
    expect(step('②c').notes.join(' | ')).toContain('base 已更新为 1');
  });
});

describe('②d 版本冲突负例', () => {
  it('陈旧 base 的提议不应用：只新增 提议→Decision→needs_decision', () => {
    expect(step('②d').appendedTypes).toEqual([
      'PlanChangeProposed', 'DecisionCreated', 'PlanChangeStatusChanged',
    ]);
  });

  it('REQ-PC-1②：三方差异基线（基线/当前/提议）可追溯，且 rev 不变', () => {
    const notes = step('②d').notes.join(' | ');
    expect(notes).toContain('基线=0/当前=2');
    expect(notes).toContain('code=base_rev_conflict');
    expect(notes).toContain('可由人裁决=true');
    expect(stateAt(5).planRev).toBe(2);
  });
});

describe('③ 派活给代码 Agent', () => {
  it('③a 事件流：captured→defined→ready 两条迁移 + AssignmentCreated', () => {
    expect(step('③a').appendedTypes).toEqual([
      'TaskLifecycleChanged', 'TaskLifecycleChanged', 'AssignmentCreated',
    ]);
  });

  it('REQ-TC-1/SCH-4：defined 态即可 ready（有结构化契约 + 在册有能力执行者），内核据此放行迁移', () => {
    // 就绪谓词只在 defined 态求值：切到本步第一条 TaskLifecycleChanged（defined 已入账、ready 未入账）
    const atDefined = stateThroughSeq(firstSeqOfStep('③a', 'TaskLifecycleChanged'));
    expect(taskRow(6, D8.importTask).lifecycle).toBe('ready');
    expect(atDefined.tasks.get(D8.importTask)?.lifecycle).toBe('defined');
    const verdict = computeReady(atDefined, D8.importTask);
    expect(verdict).toEqual({ ready: true, reasons: [] });
    // 已 ready 后谓词不再成立（REQ-SCH-1 只对 defined 候选求值），避免误读为「可重复派发」
    expect(computeReady(stateAt(6), D8.importTask).reasons[0]).toContain('lifecycle=ready');
    expect(stateAt(6).liveAssignments(D8.importTask).map((a) => a.actor_id)).toEqual([EXECUTOR_ID]);
  });

  it('REQ-SCH-1：上游未验收时下游 report 不得 ready（depends_on + data_from 双不满足）', () => {
    const state = stateAt(6);
    const verdict = computeReady(state, D8.reportTask);
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons).toContain(`depends_on_unsatisfied:${D8.importTask}`);
    expect(verdict.reasons).toContain(`data_from_unavailable:${D8.importTask}`);
  });

  it('INV-14：同一 Task 只有一个 active Assignment', () => {
    expect(stateAt(6).liveAssignments(D8.importTask)).toHaveLength(1);
  });

  it('③b 事件流：ready→active + RunCreated→Queued→Leased→Started', () => {
    expect(step('③b').appendedTypes).toEqual([
      'TaskLifecycleChanged', 'RunCreated', 'RunQueued', 'RunLeased', 'RunStarted',
    ]);
  });

  it('投影：Task=active，Run=running，租约与副作用级按 REQ-RUN-1/4 落 payload', () => {
    const state = stateAt(7);
    expect(taskRow(7, D8.importTask).lifecycle).toBe('active');
    const run = state.runs.get(D8.runImport);
    expect(run?.state).toBe('running');
    expect(run?.run_kind).toBe('executor');
    expect(run?.side_effect_level).toBe('L1');
    expect(run?.contract_rev).toBe(1);
    expect(run?.plan_rev).toBe(1);
    expect(run?.actor_id).toBe(EXECUTOR_ID);
    const started = stream.find((event) => event.type === 'RunStarted');
    expect((started?.payload as { started_at: string }).started_at).toBe(FIXED_NOW.toISOString());
    const leased = stream.find((event) => event.type === 'RunLeased');
    expect((leased?.payload as { lease_ttl_seconds: number }).lease_ttl_seconds).toBe(45);
  });

  it('Run 状态迁移确实经内核矩阵校验（queued→leased 合法、running→queued 被拒）', () => {
    expect(isMatrixCellAllowed('run', 'queued', 'leased').allowed).toBe(true);
    const forbidden = isMatrixCellAllowed('run', 'running', 'queued');
    expect(forbidden.allowed).toBe(false);
    expect(forbidden.reason).toBe('illegal_transition');
  });

  it('③c G2/REQ-PC-4：应用新 Revision 后，在跑 Run 的 input_snapshot 哈希不变、plan_rev 仍钉旧值', () => {
    expect(step('③c').appendedTypes).toEqual([
      'PlanChangeProposed', 'PlanChangeApplied', 'TaskCaptured', 'PlanRevisionCreated',
    ]);
    const state = stateAt(8);
    expect(state.planRev).toBe(3);
    const run = state.runs.get(D8.runImport);
    expect(run?.plan_rev).toBe(1);
    const atDispatch = stateAt(7).runs.get(D8.runImport);
    expect(canonicalJson(run?.input_snapshot)).toBe(canonicalJson(atDispatch?.input_snapshot));
    expect(sha256(canonicalJson(run?.input_snapshot))).toBe(sha256(canonicalJson(atDispatch?.input_snapshot)));
    expect(sha256(canonicalJson(run?.input_snapshot))).toMatch(/^[0-9a-f]{64}$/);
    expect(step('③c').notes.join(' | ')).toContain('相同=true');
  });

  it('REQ-CX-1：快照组装内容由内核组装器标注，且含契约/目标/hard 规则三段', () => {
    const snapshot = stateAt(7).runs.get(D8.runImport)?.input_snapshot as Record<string, unknown>;
    expect(snapshot.assembled_by).toBe('kernel-context-assembler');
    // PG jsonb 不保留键序，因此按键集合比较（字段缺失/多余同样会被抓出）
    expect(Object.keys(snapshot).sort()).toEqual(
      ['assembled_by', 'contract', 'goal_statement', 'hard_rules', 'prior_run_excerpt', 'upstream_accepted'].sort(),
    );
    expect((snapshot.contract as { contract_rev: number }).contract_rev).toBe(1);
  });
});

describe('④ 人类反馈', () => {
  it('④a 事件流：RawResult 入账 + 2 条 Evidence（agent_claim / external_doc）', () => {
    expect(step('④a').appendedTypes).toEqual([
      'RunRawResultReceived', 'EvidenceAdded', 'EvidenceAdded',
    ]);
  });

  it('REQ-CX-1(P2-3)：摘录 = 原文前 512 字符，且与 raw_result_ref + content_hash 成对出现', () => {
    const event = stream.find((e) => e.type === 'RunRawResultReceived');
    const payload = event?.payload as { excerpt: string; content_hash: string; raw_result_ref: string };
    expect(payload.excerpt.length).toBeLessThanOrEqual(512);
    expect(payload.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stateAt(9).runs.get(D8.runImport)?.raw_result_ref).toBe(payload.raw_result_ref);
  });

  it('S5/REQ-DT-1：导入产物以 external_doc 入账，不冒充 tool_output', () => {
    const kinds = stateAt(9).evidences.get(D8.evidenceExternalDoc)?.source_kind;
    expect(kinds).toBe('external_doc');
    expect([...stateAt(9).evidences.values()].map((e) => e.source_kind)).not.toContain('tool_output');
  });

  it('④b 同 client_submit_id 投递 11 次 → 事件流仅 +1（REQ-FB-1/REQ-DD-1/INV-13/C2）', () => {
    expect(step('④b').appendedTypes).toEqual([
      'FeedbackReceived', 'FeedbackInterpreted', 'EvidenceAdded',
    ]);
    const feedbackEvents = stream.filter((e) => e.type === 'FeedbackReceived' &&
      (e.payload as { feedback_id: string }).feedback_id === D8.feedbackRun);
    expect(feedbackEvents).toHaveLength(1);
    expect(feedbackEvents[0].idempotency_key).toBe('fb-submit-d8-1');
    expect(step('④b').notes.join(' | ')).toContain('期望事件流仅 +1');
  });

  it('投影：Feedback 先 pending 入账、随后 interpreted（入账与解析解耦）', () => {
    const pending = stateAt(10).feedbacks.get(D8.feedbackRun);
    expect(pending?.interpretation_status).toBe('interpreted');
    expect(pending?.run_id).toBe(D8.runImport);
    const justAfterReceipt = new JourneyProjection()
      .applyAll(stream.filter((e) => e.seq <= (stream.find((x) => x.type === 'FeedbackInterpreted')!.seq - 1)));
    expect(justAfterReceipt.feedbacks.get(D8.feedbackRun)?.interpretation_status).toBe('pending');
  });

  it('④c 游离 Feedback（未绑定 Run）只入账与解释，不生成 Outcome（新 P1-3）', () => {
    expect(step('④c').appendedTypes).toEqual(['FeedbackReceived', 'FeedbackInterpreted']);
    const state = stateAt(11);
    expect(state.outcomes.size).toBe(0);
    expect(state.feedbacks.get(D8.feedbackStray)?.interpretation_status).toBe('interpreted');
    expect(state.feedbacks.get(D8.feedbackStray)?.run_id).toBeNull();
    expect(step('④c').notes.join(' | ')).toContain('code=unbound_source');
  });
});

describe('⑤ 产出（Outcome）', () => {
  it('事件流：OutcomeRecorded → RunSucceeded → TaskLifecycleChanged(active→awaiting_acceptance)', () => {
    expect(step('⑤').appendedTypes).toEqual([
      'OutcomeRecorded', 'RunSucceeded', 'TaskLifecycleChanged',
    ]);
  });

  it('REQ-OC-1：Executor 直写 Outcome 被拒且零落库', () => {
    const notes = step('⑤').notes.join(' | ');
    expect(notes).toContain('code=missing_proposal');
    expect(notes).toContain('事件数 ');
    expect(notes).toMatch(/零写入拒绝\[Outcome 由 Executor 直写\].*→.*事件数 (\d+)→\1/);
  });

  it('§2.5/S7：dimensions 六维齐备且取封闭集值', () => {
    const outcome = stateAt(12).outcomes.get(D8.outcomePartial);
    expect(outcome?.dimensions).toMatchObject({
      info_obtained: true,
      conclusion_kind: 'partial',
      certainty: 'med',
      evidence_sufficiency: 'sufficient',
    });
    expect(Array.isArray((outcome?.dimensions as { blockers: unknown[] }).blockers)).toBe(true);
    expect(outcome?.proposal_id).toBe('prop-oc-d8-1');
    expect(outcome?.run_id).toBe(D8.runImport);
  });

  it('四分关系（G3 试金石）：Run succeeded 与 Outcome conclusion_kind=partial 同时成立，Task 进 awaiting_acceptance', () => {
    const state = stateAt(12);
    expect(state.runs.get(D8.runImport)?.state).toBe('succeeded');
    expect(state.outcomes.get(D8.outcomePartial)?.dimensions).toMatchObject({ conclusion_kind: 'partial' });
    expect(taskRow(12, D8.importTask).lifecycle).toBe('awaiting_acceptance');
    expect(taskRow(12, D8.importTask).last_outcome_id).toBe(D8.outcomePartial);
  });

  it('REQ-PC-6：Run 达终态落一条账目（只记账不拦截）', () => {
    const ledger = stateAt(12).budget.filter((b) => b.kind === 'run');
    expect(ledger).toEqual([{ kind: 'run', ref_id: D8.runImport, estimated: 32000, actual: 9340, unit: 'token' }]);
  });
});

describe('⑥ 验收（Acceptance）', () => {
  it('⑥a 跟进路径唯一化（REQ-HUM-3）：一个 PlanChange 产出 跟进 Task + part_of 边 + WaitCondition + wait_state', () => {
    expect(step('⑥a').appendedTypes).toEqual([
      'PlanChangeProposed', 'PlanChangeApplied', 'TaskCaptured', 'EdgeAdded',
      'WaitConditionCreated', 'TaskWaitStateChanged', 'PlanRevisionCreated',
    ]);
    const state = stateAt(13);
    const waits = state.activeWaitConditions(D8.importTask);
    expect(waits).toHaveLength(1);
    expect(waits[0].kind).toBe('person');
    expect(waits[0].followup_task_id).toBe(D8.followupTask);
    expect(state.tasks.get(D8.followupTask)?.lifecycle).toBe('captured');
    const partOf = state.edges.get('edge-part-followup');
    expect([partOf?.kind, partOf?.from_task, partOf?.to_task]).toEqual(['part_of', D8.followupTask, D8.importTask]);
  });

  it('§3.1 映射表：kind=person ⇒ wait_state=waiting_on_person（取内核常量表）', () => {
    expect(taskRow(13, D8.importTask).wait_state).toBe('waiting_on_person');
  });

  it('part_of 边不阻塞调度：跟进 Task 的原 Task 仍可继续（INV-2）', () => {
    expect(taskRow(13, D8.importTask).lifecycle).toBe('awaiting_acceptance');
  });

  it('⑥b 四类入账负例 → 事件流零新增', () => {
    expect(step('⑥b').appendedTypes).toEqual([]);
    const notes = step('⑥b').notes.join(' | ');
    for (const code of ['acceptor_is_run_actor', 'coverage_incomplete', 'verdict_inconsistent', 'manual_criterion_needs_human']) {
      expect(notes).toContain(code);
    }
    expect(notes).toMatch(/零写入拒绝\[Acceptance 由 Run actor 自验\].*事件数 (\d+)→\1/);
    expect(notes).toMatch(/零写入拒绝\[Acceptance 缺判据\].*事件数 (\d+)→\1/);
    expect(notes).toMatch(/零写入拒绝\[Acceptance verdict 不一致\].*事件数 (\d+)→\1/);
  });

  it('REQ-ACC-2/C6：执行该 Run 的 actor 自验收被拦截', () => {
    expect(stateAt(12).runs.get(D8.runImport)?.actor_id).toBe(EXECUTOR_ID);
    expect(step('⑥b').notes.join(' | ')).toContain('acceptor_is_run_actor');
  });

  it('⑥c S4：partially_accepted 停在 awaiting_acceptance，不发 lifecycle 事件，待补集=failed 判据', () => {
    expect(step('⑥c').appendedTypes).toEqual(['AcceptanceRecorded']);
    const state = stateAt(15);
    expect(taskRow(15, D8.importTask).lifecycle).toBe('awaiting_acceptance');
    expect(state.pendingCriteria(D8.importTask)).toEqual([D8.criterionUnmapped]);
    expect(state.effectiveAcceptance(D8.importTask)?.verdict).toBe('partially_accepted');
  });

  it('⑥d 补集→accepted：新 Outcome supersedes 旧、指针移动、INV-11 同事务收尾、Goal achieved', () => {
    expect(step('⑥d').appendedTypes).toEqual([
      'EvidenceAdded', 'FeedbackReceived', 'FeedbackInterpreted', 'OutcomeRecorded',
      'AcceptanceRecorded', 'AcceptanceSuperseded', 'LatestAcceptedPointerMoved',
      'WaitConditionCanceled', 'TaskWaitStateChanged', 'TaskLifecycleChanged', 'GoalStatusChanged',
    ]);
    const state = stateAt(16);
    expect(taskRow(16, D8.importTask).lifecycle).toBe('accepted');
    expect(taskRow(16, D8.importTask).wait_state).toBe('none');
    expect(state.activeWaitConditions(D8.importTask)).toHaveLength(0);
    expect(state.waitConditions.get(D8.waitCondition)?.status).toBe('canceled');
    expect(state.outcomes.get(D8.outcomeFinal)?.supersedes_id).toBe(D8.outcomePartial);
    expect(state.acceptances.get(D8.acceptancePartial)?.superseded).toBe(true);
    expect(state.effectiveAcceptance(D8.importTask)?.acceptance_id).toBe(D8.acceptanceFinal);
    expect(state.latestAcceptedOutcome(D8.importTask)).toBe(D8.outcomeFinal);
    expect(state.goals.get(D8.goal)?.status).toBe('achieved');
    expect(step('⑥d').notes.join(' | ')).toContain('required_effects=cancel_active_wait_conditions+reset_wait_state_none');
  });

  it('INV-11：终态收尾三事件在同一个 withTransaction 内提交（seq 相邻，且夹在指针移动与 Goal 收尾之间）', () => {
    const pointerSeq = stream.find((e) => e.type === 'LatestAcceptedPointerMoved')?.seq ?? 0;
    const goalSeq = stream.find((e) => e.type === 'GoalStatusChanged')?.seq ?? Number.POSITIVE_INFINITY;
    const closing = stream
      .filter((e) => e.seq > pointerSeq && e.seq < goalSeq)
      .map((e) => ({ seq: e.seq, type: e.type }));
    // 同事务提交 ⇒ 这三条事件在流里连号，且正是 spec §4 INV-11 要求的三件
    expect(closing.map((e) => e.type)).toEqual(['WaitConditionCanceled', 'TaskWaitStateChanged', 'TaskLifecycleChanged']);
    expect(closing.map((e) => e.seq)).toEqual([pointerSeq + 1, pointerSeq + 2, pointerSeq + 3]);
    expect(goalSeq).toBe(closing[2].seq + 1);
  });

  it('REQ-SCH-1/ACC-1：上游 accepted（跨 rev 有效）+ 指针非空 ⇒ 下游 report 在 defined 态即判 ready', () => {
    const atDefined = stateThroughSeq(firstSeqOfStep('⑥e', 'TaskLifecycleChanged'));
    expect(atDefined.tasks.get(D8.reportTask)?.lifecycle).toBe('defined');
    expect(computeReady(atDefined, D8.reportTask)).toEqual({ ready: true, reasons: [] });
    expect(taskRow(17, D8.reportTask).lifecycle).toBe('ready');
    expect(stateAt(17).liveAssignments(D8.reportTask).map((a) => a.actor_id)).toEqual([HUMAN_ID]);
  });

  it('REQ-SCH-2：指针移动事件带 from/to outcome，主语为上游 from_task', () => {
    const pointer = step('⑥d').snapshot.pointers.at(-1);
    expect(pointer).toMatchObject({
      from_task: D8.importTask, to_task: D8.reportTask,
      from_outcome_id: D8.outcomePartial, to_outcome_id: D8.outcomeFinal,
    });
  });
});

describe('附：human_light Run 在 §3.2 矩阵上走不通（D9 发现的缺口）', () => {
  it('REQ-HUM-1 要求的 created→running 被内核矩阵拒绝（illegal_transition）', () => {
    expect(isMatrixCellAllowed('run', 'created', 'running').allowed).toBe(false);
    expect(step('附 S7').appendedTypes).toEqual(['RunCreated']);
    expect(stateAt(18).runs.get(D8.runHumanLight)?.state).toBe('created');
    expect(step('附 S7').notes.join(' | ')).toContain('FINDING D9-J2');
  });

  it('旅程不伪造合法迁移：不出现 RunStarted/leased 事件（S3 与 §3.2 需一处修订）', () => {
    expect(stream.map((e) => e.type)).not.toContain('RunHeartbeat');
    const humanLightEvents = stream.filter((e) => (e.payload as { run_id?: string })?.run_id === D8.runHumanLight);
    expect(humanLightEvents.map((e) => e.type)).toEqual(['RunCreated']);
  });
});

// 与脚本内常量对齐（避免测试里写死不同拼写的 actor id）
const EXECUTOR_ID = 'actor-opencode';
const HUMAN_ID = 'actor-human-1';
