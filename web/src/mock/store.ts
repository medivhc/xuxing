// Mock 存储：内存事件日志 + 领域状态 + 投影构建 + SSE 订阅广播。
//
// 边界（任务书要求）：mock 与 API 客户端严格分离——本模块只被 mock/install.ts
// 的 fetch 拦截层调用；api/ 下任何代码不 import 本目录。
// 投影语义：projection_version = 已并入的最大事件序号（与 SSE 事件 seq 同源），
// head_global_seq/lag_state 为可选补充（控制面可注入 lag 用于同步徽标测试）。

import { ulid } from '../lib/ulid';
import type {
  AcceptanceCriterion,
  AcceptanceRecord,
  AttentionItem,
  CriterionResult,
  HomeProjection,
  LagState,
  MyActionsProjection,
  ProjectAcceptanceStatus,
  ProjectProjection,
  ProjectTaskRow,
  ProposalProjection,
  RecentActivity,
} from '../api/types';
import {
  SEED_PROJECT_ID,
  seedCaptures,
  seedDecisions,
  seedEvents,
  seedProject,
  seedProposals,
  seedTasks,
} from './seed';
import type {
  MockCaptureState,
  MockDecisionState,
  MockProposalState,
  MockProjectState,
  MockSnapshot,
  MockTaskState,
} from './types';
import { MOCK_AGENT_ACTOR } from './types';

export interface MockEventRecord {
  seq: number;
  kind: string;
  project_id?: string;
  task_id?: string;
  proposal_id?: string;
  decision_id?: string;
  summary?: string;
  occurred_at: string;
}

export interface CommandReceiptRecord {
  status: 'accepted' | 'duplicate';
  client_submit_id: string;
  command_id?: string;
  message?: string;
}

type EventListener = (event: MockEventRecord) => void;

/** My Actions 收录范围（D10/OQ-02=A：待验收不进 My Actions；captured 无可行动作）。 */
const MY_ACTIONS_LIFECYCLES = new Set(['defined', 'ready', 'active']);

export class MockStore {
  // reset() 在构造函数中同步赋值（种子装载）；! 告知 TS 确实被初始化
  project!: MockProjectState;
  tasks = new Map<string, MockTaskState>();
  decisions = new Map<string, MockDecisionState>();
  proposals = new Map<string, MockProposalState>();
  captures = new Map<string, MockCaptureState>();

  private events: MockEventRecord[] = [];
  private listeners = new Set<EventListener>();
  private receipts = new Map<string, CommandReceiptRecord>();

  private seqCounter = 0;
  private lagOverride: LagState | null = null;
  private heartbeatsEnabled = true;
  private forceNextProposalDegraded = false;

  constructor() {
    this.reset();
  }

  // ---------- 生命周期 ----------

  reset(): void {
    this.project = seedProject();
    this.tasks = new Map(seedTasks().map((t) => [t.task_id, t]));
    this.decisions = new Map(seedDecisions().map((d) => [d.decision_id, d]));
    this.proposals = new Map(seedProposals().map((p) => [p.proposal_id, p]));
    this.captures = new Map(seedCaptures().map((c) => [c.capture_id, c]));
    this.events = [];
    this.listeners = new Set();
    this.receipts = new Map();
    this.seqCounter = 0;
    this.lagOverride = null;
    this.heartbeatsEnabled = true;
    this.forceNextProposalDegraded = false;

    const base = Date.parse('2026-10-20T09:00:00.000Z');
    seedEvents().forEach((seed, index) => {
      this.events.push({
        seq: (this.seqCounter += 1),
        kind: seed.kind,
        project_id: seed.project_id,
        task_id: seed.task_id,
        proposal_id: seed.proposal_id,
        decision_id: seed.decision_id,
        summary: seed.summary,
        occurred_at: new Date(base + index * 60_000).toISOString(),
      });
    });
  }

  // ---------- 事件日志 / SSE ----------

  currentSeq(): number {
    return this.seqCounter;
  }

  eventsAfter(cursor: number): MockEventRecord[] {
    return this.events.filter((e) => e.seq > cursor);
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 命令/捕获路径：更新状态后调用，落事件并广播（投影失效由前端按 §1.2 映射处理）。 */
  appendEvent(event: {
    kind: string;
    project_id?: string;
    task_id?: string;
    proposal_id?: string;
    decision_id?: string;
    summary?: string;
  }): MockEventRecord {
    const record: MockEventRecord = {
      seq: (this.seqCounter += 1),
      kind: event.kind,
      project_id: event.project_id,
      task_id: event.task_id,
      proposal_id: event.proposal_id,
      decision_id: event.decision_id,
      summary: event.summary,
      occurred_at: new Date().toISOString(),
    };
    this.events.push(record);
    for (const listener of this.listeners) listener(record);
    return record;
  }

  /** 控制面注入（不改变领域状态，仅广播；用于 ProjectionRebuilt 等场景测试）。 */
  injectEvent(kind: string, payload: { project_id?: string; task_id?: string } = {}): void {
    this.appendEvent({ kind, project_id: payload.project_id, task_id: payload.task_id, summary: `控制面注入 ${kind}` });
  }

  // ---------- 幂等 ----------

  receiptFor(clientSubmitId: string): CommandReceiptRecord | undefined {
    return this.receipts.get(clientSubmitId);
  }

  rememberReceipt(clientSubmitId: string, receipt: CommandReceiptRecord): void {
    this.receipts.set(clientSubmitId, receipt);
  }

  // ---------- 控制面状态 ----------

  get heartbeatsOn(): boolean {
    return this.heartbeatsEnabled;
  }

  setHeartbeats(enabled: boolean): void {
    this.heartbeatsEnabled = enabled;
  }

  get lagState(): LagState | null {
    return this.lagOverride;
  }

  setLagState(state: LagState | null): void {
    this.lagOverride = state;
  }

  get nextProposalDegraded(): boolean {
    return this.forceNextProposalDegraded;
  }

  setNextProposalDegraded(value: boolean): void {
    this.forceNextProposalDegraded = value;
  }

  // ---------- ID 生成 ----------

  newId(prefix: string): string {
    return `${prefix}-${ulid()}`;
  }

  // ---------- 投影构建 ----------

  private projectionMeta() {
    return {
      projection_version: this.seqCounter,
      head_global_seq: this.seqCounter,
      lag_state: (this.lagOverride ?? 'fresh') as LagState,
      generated_at: new Date().toISOString(),
    };
  }

  private taskCounts(): Record<string, number> {
    const counts: Record<string, number> = {
      captured: 0,
      defined: 0,
      ready: 0,
      active: 0,
      awaiting_acceptance: 0,
      accepted: 0,
      canceled: 0,
    };
    for (const task of this.tasks.values()) {
      counts[task.lifecycle] = (counts[task.lifecycle] ?? 0) + 1;
    }
    return counts as HomeProjection['projects'][number]['task_counts'];
  }

  homeProjection(): HomeProjection {
    const lastEvent = this.events[this.events.length - 1];
    return {
      projection_id: 'home',
      ...this.projectionMeta(),
      projects: [
        {
          project_id: this.project.project_id,
          name: this.project.name,
          goal_statement: this.project.goal?.statement ?? null,
          goal_status: this.project.goal?.status ?? null,
          task_counts: this.taskCounts(),
          last_activity_at: lastEvent?.occurred_at ?? null,
        },
      ],
      attention: this.attentionItems(),
      recent: this.recentActivities(),
    };
  }

  /** 契约 §2：acceptance_due = awaiting_acceptance 且无有效 Acceptance 或最新为 partially。 */
  private attentionItems(): AttentionItem[] {
    const items: AttentionItem[] = [];
    let rank = 0;
    for (const decision of this.decisions.values()) {
      if (decision.status !== 'pending') continue;
      items.push({
        attention_id: `attention:${decision.decision_id}`,
        kind: 'decision_pending',
        project_id: decision.project_id,
        decision_id: decision.decision_id,
        rank: (rank += 1),
        // resolve_decision 无服务端对应、动作入口已下线（FIX-ROUND-1 R-1）：
        // 决策仍作为 attention 呈现，但不再广告任何可执行动作。
        available_actions: [],
        created_at: decision.created_at,
      });
    }
    for (const task of this.tasks.values()) {
      if (task.lifecycle !== 'awaiting_acceptance') continue;
      const verdict = task.acceptance?.verdict ?? null;
      if (verdict === 'accepted' || verdict === 'rejected') continue;
      items.push({
        attention_id: `attention:${task.task_id}`,
        kind: 'acceptance_due',
        project_id: SEED_PROJECT_ID,
        task_id: task.task_id,
        rank: (rank += 1),
        available_actions: taskActions(task),
        created_at: new Date(Date.parse('2026-10-20T08:00:00.000Z')).toISOString(),
      });
    }
    return items.sort((a, b) => a.rank - b.rank);
  }

  private recentActivities(): RecentActivity[] {
    return this.events
      .slice(-6)
      .reverse()
      .map((event) => ({
        event_id: `evt-${event.seq}`,
        project_id: event.project_id ?? SEED_PROJECT_ID,
        task_id: event.task_id,
        summary: event.summary ?? event.kind,
        occurred_at: event.occurred_at,
      }));
  }

  actionsProjection(): MyActionsProjection {
    const items: MyActionsProjection['items'] = [];
    let rank = 0;
    for (const decision of this.decisions.values()) {
      if (decision.status !== 'pending') continue;
      const expired = decision.expires_at !== null && Date.parse(decision.expires_at) < Date.now();
      items.push({
        item_id: `decision:${decision.decision_id}`,
        kind: 'decision',
        project_id: decision.project_id,
        decision_id: decision.decision_id,
        decision: {
          question: decision.question,
          recommendation: decision.recommendation,
          alternatives: decision.alternatives,
          evidence_refs: decision.evidence_refs,
          status: expired ? 'expired' : decision.status,
          expires_at: decision.expires_at,
        },
        rank: (rank += 1),
        // resolve_decision 已下线（FIX-ROUND-1 R-1：服务端命令词表无对应项），
        // 无论是否过期都不再广告该动作；expired 仍以 blocked_reason 明示。
        available_actions: [],
        blocked_reason: expired ? 'decision_expired' : null,
        updated_global_seq: decision.updated_global_seq,
      });
    }
    for (const task of this.tasks.values()) {
      if (!MY_ACTIONS_LIFECYCLES.has(task.lifecycle)) continue;
      const blocked = task.wait_state !== 'none';
      items.push({
        item_id: `task:${task.task_id}`,
        kind: 'task',
        project_id: SEED_PROJECT_ID,
        task_id: task.task_id,
        task_lifecycle: task.lifecycle,
        task_wait_state: task.wait_state,
        active_run: task.active_run ?? undefined,
        rank: (rank += 1),
        available_actions: blocked ? [] : taskActions(task),
        blocked_reason: blocked ? 'wait_state' : null,
        updated_global_seq: task.updated_global_seq,
      });
    }
    items.sort((a, b) => a.rank - b.rank);
    return { projection_id: 'my_actions', ...this.projectionMeta(), items };
  }

  projectProjection(projectId: string): ProjectProjection | null {
    if (projectId !== this.project.project_id) return null;
    const tasks = [...this.tasks.values()]
      .sort((a, b) => a.updated_global_seq - b.updated_global_seq)
      .map((task) => this.toTaskRow(task));
    return {
      projection_id: 'project',
      ...this.projectionMeta(),
      // 键集与真 ProjectView 一致（FIX-ROUND-3）：{project, goal, tasks,
      // acceptance_status, graph, pending_proposals}
      project: {
        project_id: this.project.project_id,
        name: this.project.name,
        policy_id: 'policy-seed',
        created_by: 'seed',
      },
      goal: this.project.goal
        ? { goal_id: `${this.project.project_id}-goal`, ...this.project.goal }
        : null,
      tasks,
      acceptance_status: this.acceptanceStatus(tasks),
      graph: {
        nodes: [
          { id: 'task-seed-1', title: '整理发布检查清单', lifecycle: 'active' },
          { id: 'task-seed-3', title: '回顾上周阻塞项', lifecycle: 'captured' },
        ],
        edges: [{ from: 'task-seed-1', to: 'task-seed-3', kind: 'depends_on' }],
      },
      // 只列 pending 提议；task_id 在接受后由服务端新发（R-11），此处不携带
      pending_proposals: [...this.proposals.values()]
        .filter((p) => p.project_id === this.project.project_id && p.status === 'pending')
        .map((p) => ({
          proposal_id: p.proposal_id,
          kind: 'capture_task',
          status: 'proposed',
          degraded: p.degraded,
          rationale: p.summary,
          created_at: p.created_at,
        })),
    };
  }

  /** 项目级验收计数（FIX-ROUND-3 对齐真 ProjectView）：mock 模拟服务端统计。 */
  private acceptanceStatus(tasks: ProjectTaskRow[]): ProjectAcceptanceStatus {
    return {
      accepted: tasks.filter((t) => t.lifecycle === 'accepted').length,
      awaiting: tasks.filter((t) => t.lifecycle === 'awaiting_acceptance').length,
      rejected: tasks.filter((t) => t.acceptance?.verdict === 'rejected').length,
      total: tasks.length,
      criterion_summary: tasks.flatMap((t) =>
        (t.acceptance?.criterion_results ?? []).map((r) => ({
          task_id: t.task_id,
          criterion_ref: r.criterion_ref,
          verdict: r.verdict,
        })),
      ),
    };
  }

  private toTaskRow(task: MockTaskState): ProjectTaskRow {
    return {
      task_id: task.task_id,
      project_id: this.project.project_id,
      title: task.title,
      description: task.description,
      lifecycle: task.lifecycle,
      wait_state: task.wait_state,
      assignee_kind: task.assignee?.actor_kind ?? 'human',
      assigned_by: null,
      duplicate_suspect: task.duplicate_suspect,
      capture_id: null,
      proposal_id: null,
      current_contract_rev: task.current_contract_rev,
      last_outcome_id: task.last_outcome_id,
      feedback_count: 0,
      cancel_requested: false,
      acceptance_criteria: task.acceptance_criteria,
      acceptance: task.acceptance
        ? {
            acceptance_id: task.acceptance.acceptance_id,
            verdict: task.acceptance.verdict,
            criterion_results: task.acceptance.criterion_results,
            created_at: task.acceptance.created_at,
          }
        : null,
      active_wait_conditions: [],
      available_actions: taskActions(task),
      updated_global_seq: task.updated_global_seq,
    };
  }

  proposalProjection(proposalId: string): ProposalProjection | null {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return null;
    // 状态词映射到真词汇（FIX-ROUND-3）：pending→proposed、accepted→applied、
    // rejected→rejected、expired→needs_decision（mock 内部词保留，仅投影层译）
    const status =
      proposal.status === 'pending'
        ? 'proposed'
        : proposal.status === 'accepted'
          ? 'applied'
          : proposal.status === 'rejected'
            ? 'rejected'
            : 'needs_decision';
    return {
      projection_id: 'proposal',
      ...this.projectionMeta(),
      proposal_id: proposal.proposal_id,
      project_id: proposal.project_id,
      kind: 'capture_task',
      status,
      status_reason: null,
      capture_id: proposal.capture_id,
      task_id: null,
      rationale: proposal.summary,
      assumptions: [],
      risk_level: 'low',
      degraded: proposal.degraded,
      proposer: {
        source: proposal.degraded ? 'fallback' : 'model',
        model: null,
        degraded: proposal.degraded,
        degraded_reason: proposal.degraded_reason,
        latency_ms: null,
      },
      details: {
        kind: 'capture_task',
        task: {
          title: proposal.proposed.title,
          description: proposal.proposed.description,
          assignee_kind: proposal.proposed.assignee_hint === MOCK_AGENT_ACTOR ? 'agent' : 'human',
          acceptance_criteria: proposal.proposed.acceptance_criteria,
        },
      },
      created_at: proposal.created_at,
      available_actions: proposalActions(proposal),
    };
  }

  // ---------- 调试 ----------

  snapshot(): MockSnapshot {
    return {
      project: this.project,
      tasks: [...this.tasks.values()],
      decisions: [...this.decisions.values()],
      proposals: [...this.proposals.values()],
      captures: [...this.captures.values()],
      events: this.events.map((e) => ({ seq: e.seq, kind: e.kind })),
      lagState: this.lagOverride,
      heartbeatsEnabled: this.heartbeatsEnabled,
      forceNextProposalDegraded: this.forceNextProposalDegraded,
    };
  }
}

/** 任务可用动作：只认内核 available_actions 语义（mock 按生命周期模拟）。
 *  词表为服务端 canonical（FIX-ROUND-1 R-1）：task_advance 一词覆盖开始/完成，
 *  界面按 task_lifecycle 分派渲染具体按钮。 */
export function taskActions(task: MockTaskState): string[] {
  if (task.wait_state !== 'none') return [];
  switch (task.lifecycle) {
    case 'defined':
    case 'ready':
      return ['task_advance', 'task_cancel'];
    case 'active':
      return ['task_advance', 'task_cancel'];
    case 'awaiting_acceptance':
      return ['acceptance_record'];
    default:
      return [];
  }
}

export function proposalActions(proposal: MockProposalState): string[] {
  return proposal.status === 'pending' ? ['proposal_accept', 'proposal_reject'] : [];
}

/** 供 commands.ts 复用：累积判论后的验收结论（覆盖完整时）。 */
export function computeAcceptanceVerdict(
  criteria: AcceptanceCriterion[],
  results: CriterionResult[],
): 'accepted' | 'rejected' | 'partially_accepted' {
  if (results.length < criteria.length) return 'partially_accepted';
  return results.some((r) => r.verdict === 'failed') ? 'rejected' : 'accepted';
}

export function buildAcceptanceRecord(params: {
  acceptanceId: string;
  contractRev: number;
  subjectOutcomeId: string | null;
  acceptorId: string;
  verdict: AcceptanceRecord['verdict'];
  criterionResults: CriterionResult[];
  rationale?: string | null;
}): AcceptanceRecord {
  return {
    acceptance_id: params.acceptanceId,
    contract_rev: params.contractRev,
    subject_outcome_id: params.subjectOutcomeId,
    acceptor_id: params.acceptorId,
    verdict: params.verdict,
    criterion_results: params.criterionResults,
    rationale: params.rationale ?? null,
    created_at: new Date().toISOString(),
    superseded: false,
  };
}
