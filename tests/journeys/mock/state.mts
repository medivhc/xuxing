import { randomUUID } from 'node:crypto';
import type {
  AcceptanceCriterion,
  AcceptanceVerdict,
  ActionItem,
  ActionsData,
  CaptureData,
  CommandResultData,
  CommandType,
  CriterionResult,
  HomeData,
  HomeProjectSummary,
  ProjectData,
  ProjectTaskRow,
  ProposalData,
  ProposalDraft,
  StreamEventFrame,
} from '../contract.mts';
import { COMMAND_TYPES } from '../contract.mts';
import { CURRENT_ACTOR_ID, DEMO, DEGRADED } from '../journeys.config.mts';
import { badRequest, conflict, notFound } from './errors.mts';

// ============================================================================
// mock 的领域存储：append-only 事件日志 + 由事件 apply 出来的最小实体集。
//
// 纪律对应：
//   - 投影只从事件 apply 得到（home/project/actions/proposal 都是纯读）；
//   - 每个投影带 projection_version = 已并入的最大全局 seq；
//   - 事件 kind = 内核封闭目录的 PascalCase 领域事件名（FIX-ROUND-1 R-9）；
//   - 命令词表 / available_actions 是 canonical command_type 字符串（R-1）；
//   - 命令首次成功 201 + data.replayed=false，幂等重放 200 + data.replayed=true（R-6）；
//   - 种子与真服务 R-7 种子契约同名同形（proj_demo_oq05 / proj-degraded / prop-degraded-1）；
//   - 提议只带 draft，不预告 task_id（R-11）：任务 id 只在 proposal_accept 时由 mock 发号。
//
// 这是**测试用 mock**：只建模本旅程需要的那部分内核语义（生命周期迁移 + 逐判据验收），
// 不实现 Run/Assignment/Policy 的完整判定。真服务集成时整套 mock 不会被拉起。
// ============================================================================

export interface EventRecord {
  seq: number;
  /** 内核事件类型（PascalCase 领域事件名，R-9） */
  kind: string;
  project_id: string;
  entity_id: string;
  occurred_at: string;
  payload: Record<string, unknown>;
}

interface ProjectRecord {
  project_id: string;
  name: string;
  policy_id: string;
  created_by: string;
  goal_id: string;
  goal_statement: string;
  goal_success: string;
  goal_stop: string;
  goal_status: string;
  created_at: string;
  updated_at: string;
}

interface TaskRecord {
  task_id: string;
  project_id: string;
  title: string;
  description: string;
  lifecycle: ProjectTaskRow['lifecycle'];
  wait_state: string;
  assignee_id: string;
  assignee_kind: 'human' | 'agent';
  current_contract_rev: number;
  criteria: AcceptanceCriterion[];
  proposal_id: string | null;
  capture_id: string | null;
  last_outcome_id: string | null;
  feedback_count: number;
  cancel_requested: boolean;
  acceptance: {
    acceptance_id: string;
    verdict: AcceptanceVerdict;
    criterion_results: CriterionResult[];
    created_at: string;
  } | null;
  created_at: string;
}

interface ProposalRecord extends Omit<ProposalData, 'projection_version' | 'available_actions' | 'task_id'> {
  /** 接受提议时由服务端发号（R-11）；提议阶段恒为 null。 */
  assigned_task_id: string | null;
}

interface StoredReceipt {
  /** 首次落账的命令类型（与真服务回执 payload.command 同义） */
  type: CommandType;
  /** 请求体指纹（只含 payload，与真服务 request_fingerprint 同口径） */
  fingerprint: string;
  result: CommandResultData;
}

export interface ExecuteCommandInput {
  type: string;
  payload: Record<string, unknown>;
  client_submit_id: string;
}

export type EventListener = (event: EventRecord) => void;

const TERMINAL: ReadonlySet<TaskRecord['lifecycle']> = new Set(['accepted', 'canceled']);

/** 三个种子里 My Actions 里可见的任务（R-7 种子契约）。 */
const SEED_TASKS: Array<{
  task_id: string;
  title: string;
  description: string;
  lifecycle: TaskRecord['lifecycle'];
  criteria: AcceptanceCriterion[];
  proposal_id?: string;
  capture_id?: string;
  accepted?: boolean;
  canceled?: boolean;
  feedback?: string;
}> = [
  {
    task_id: 'task_demo_contact',
    title: '联系张三确认方案',
    description: '给张三打电话确认上周讨论的方案细节，并记录对方意见。',
    lifecycle: 'active',
    criteria: [{ criterion_ref: 'c1', text: '确认了方案的关键细节（时间、范围、负责人）', auto: false }],
  },
  {
    task_id: 'task_demo_quote',
    title: '整理报价单',
    description: '按确认后的方案整理报价单，附上工作量说明。',
    lifecycle: 'ready',
    criteria: [
      { criterion_ref: 'c1', text: '报价单覆盖全部交付项', auto: false },
      { criterion_ref: 'c2', text: '金额与工作量一致', auto: false },
    ],
  },
  {
    task_id: 'task_demo_contract',
    title: '起草合同附件',
    description: '按已确认的方案与报价起草合同附件。',
    lifecycle: 'defined',
    criteria: [{ criterion_ref: 'c1', text: '附件条款与方案一致', auto: false }],
  },
  {
    task_id: 'task_demo_kickoff',
    title: '确认客户启动会时间',
    description: '与客户确认启动会时间（已通过种子演示"已完成"状态）。',
    lifecycle: 'accepted',
    criteria: [{ criterion_ref: 'c1', text: '已在日历中登记启动会', auto: true }],
    feedback: '已和客户约定下周二下午三点的启动会，日历已登记。',
    accepted: true,
  },
  {
    task_id: 'task_demo_archived',
    title: '复核旧版报价模板',
    description: '已按客户要求改为使用现行模板，本条作废（种子演示"已取消"状态）。',
    lifecycle: 'canceled',
    criteria: [{ criterion_ref: 'c1', text: '模板与现行版本一致', auto: false }],
    canceled: true,
  },
];

function copyCriteria(criteria: AcceptanceCriterion[]): AcceptanceCriterion[] {
  return criteria.map((criterion) => ({ ...criterion }));
}

/** 现场捕获由 mock 提议给出的判据（与真服务同理：ref 由提议给出，旅程按 projection 取值）。 */
const CAPTURE_CRITERIA: AcceptanceCriterion[] = [
  { criterion_ref: 'c-journey-1', text: '导入结果可查询，映射字段齐全', auto: true },
  { criterion_ref: 'c-journey-2', text: '双轨对照结论已给出（人工判定）', auto: false },
];

/** 当前 actor 对一条 Task 的可用动作（canonical 词表，服务端复核用同一函数）。 */
export function availableActionsFor(task: TaskRecord, actorId: string): CommandType[] {
  if (TERMINAL.has(task.lifecycle)) return [];
  if (task.assignee_id !== actorId) return [];
  switch (task.lifecycle) {
    case 'defined':
    case 'ready':
      return ['task_advance', 'task_cancel'];
    case 'active':
      // cancel_task 与内核一致地保留在执行中（REQ-RUN-6：执行中也能记取消意图）
      return ['feedback_submit', 'task_cancel'];    case 'awaiting_acceptance':
      // R-10：验收动作就在这条上，任务留在 My Actions 直到验收落账
      return ['acceptance_record', 'task_cancel'];
    default:
      return [];
  }
}

function proposalActionsFor(proposal: ProposalRecord): CommandType[] {
  return proposal.status === 'proposed' ? ['proposal_accept', 'proposal_reject'] : [];
}

/** 与真服务 ActionItem.next_action 同义：next_action 是**给用户看的标签**，不是 command_type。 */
const ACTION_LABEL: Record<CommandType, string> = {
  proposal_accept: '接受提议',
  proposal_reject: '拒绝提议',
  task_advance: '推进任务',
  feedback_submit: '提交执行反馈',
  acceptance_record: '逐判据验收',
  task_cancel: '取消任务',
};

/** 首次命令回执（R-6）：与真服务一致，receipt_event_id 是幂等键本身（事件表 idempotency_key = client_id:<id>）。 */
function receiptEventId(clientSubmitId: string): string {
  return `client_id:${clientSubmitId}`;
}

export class JourneyState {
  readonly events: EventRecord[] = [];
  readonly projects = new Map<string, ProjectRecord>();
  readonly tasks = new Map<string, TaskRecord>();
  readonly proposals = new Map<string, ProposalRecord>();

  head = 0;
  private readonly receipts = new Map<string, StoredReceipt>();
  private readonly listener: EventListener | null;

  constructor(listener: EventListener | null = null) {
    this.listener = listener;
  }

  // --------------------------------------------------------------------------
  // 事件追加 + apply
  // --------------------------------------------------------------------------

  emit(input: {
    kind: string;
    project_id: string;
    entity_id: string;
    payload?: Record<string, unknown>;
    at?: string;
  }): EventRecord {
    const event: EventRecord = {
      seq: ++this.head,
      kind: input.kind,
      project_id: input.project_id,
      entity_id: input.entity_id,
      occurred_at: input.at ?? new Date().toISOString(),
      payload: input.payload ?? {},
    };
    this.events.push(event);
    this.apply(event);
    this.listener?.(event);
    return event;
  }

  private apply(event: EventRecord): void {
    const payload = event.payload;
    const project = this.projects.get(event.project_id);
    if (project) project.updated_at = event.occurred_at;

    switch (event.kind) {
      case 'ProjectCreated': {
        this.projects.set(event.project_id, {
          project_id: event.project_id,
          name: String(payload.name ?? event.project_id),
          policy_id: String(payload.policy_id ?? ''),
          created_by: String(payload.created_by ?? ''),
          goal_id: '',
          goal_statement: '',
          goal_success: '',
          goal_stop: '',
          goal_status: 'active',
          created_at: event.occurred_at,
          updated_at: event.occurred_at,
        });
        break;
      }
      case 'GoalCreated': {
        if (!project) throw new Error(`GoalCreated before ProjectCreated: ${event.project_id}`);
        project.goal_id = String(payload.goal_id);
        project.goal_statement = String(payload.statement ?? '');
        project.goal_success = String(payload.success_criteria ?? '');
        project.goal_stop = String(payload.stop_conditions ?? '');
        break;
      }
      case 'TaskCaptured': {
        this.tasks.set(String(payload.task_id), {
          task_id: String(payload.task_id),
          project_id: event.project_id,
          title: String(payload.title ?? ''),
          description: String(payload.description ?? ''),
          lifecycle: (payload.lifecycle as TaskRecord['lifecycle']) ?? 'defined',
          wait_state: 'none',
          assignee_id: String(payload.assignee_id ?? ''),
          assignee_kind: (payload.assignee_kind as 'human' | 'agent') ?? 'human',
          current_contract_rev: Number(payload.contract_rev ?? 1),
          criteria: copyCriteria((payload.acceptance_criteria as AcceptanceCriterion[]) ?? []),
          proposal_id: (payload.proposal_id as string | null) ?? null,
          capture_id: (payload.capture_id as string | null) ?? null,
          last_outcome_id: null,
          feedback_count: 0,
          cancel_requested: false,
          acceptance: null,
          created_at: event.occurred_at,
        });
        break;
      }
      case 'TaskLifecycleChanged': {
        const task = this.tasks.get(String(payload.task_id));
        if (!task) throw new Error(`TaskLifecycleChanged without task: ${String(payload.task_id)}`);
        task.lifecycle = payload.to as TaskRecord['lifecycle'];
        break;
      }
      case 'TaskCanceled': {
        const task = this.tasks.get(String(payload.task_id));
        if (!task) throw new Error(`TaskCanceled without task: ${String(payload.task_id)}`);
        task.lifecycle = 'canceled';
        break;
      }
      case 'FeedbackReceived': {
        const taskId = payload.task_id;
        const task = typeof taskId === 'string' ? this.tasks.get(taskId) : undefined;
        if (task) task.feedback_count += 1;
        break;
      }
      case 'OutcomeRecorded': {
        const task = this.tasks.get(String(payload.task_id));
        if (!task) throw new Error(`OutcomeRecorded without task: ${String(payload.task_id)}`);
        task.last_outcome_id = String(payload.outcome_id);
        break;
      }
      case 'AcceptanceRecorded': {
        const task = this.tasks.get(String(payload.task_id));
        if (!task) throw new Error(`AcceptanceRecorded without task: ${String(payload.task_id)}`);
        task.acceptance = {
          acceptance_id: String(payload.acceptance_id),
          verdict: payload.verdict as AcceptanceVerdict,
          criterion_results: ((payload.criterion_results as CriterionResult[]) ?? []).map((result) => ({
            criterion_ref: result.criterion_ref,
            verdict: result.verdict,
            evidence_refs: [...result.evidence_refs],
          })),
          created_at: event.occurred_at,
        };
        break;
      }
      case 'PlanChangeProposed': {
        this.proposals.set(String(payload.change_id), {
          proposal_id: String(payload.change_id),
          project_id: event.project_id,
          kind: String(payload.kind ?? 'capture_task'),
          status: 'proposed',
          status_reason: null,
          capture_id: (payload.capture_id as string | null) ?? null,
          rationale: String(payload.rationale ?? ''),
          assumptions: (payload.assumptions as string[]) ?? [],
          risk_level: String(payload.risk_level ?? 'L0'),
          base_plan_rev: Number(payload.base_plan_rev ?? 0),
          ops: (payload.ops as unknown[]) ?? [],
          degraded: ((payload.proposer as { degraded?: boolean } | undefined)?.degraded ?? false) === true,
          proposer: (payload.proposer as ProposalRecord['proposer']) ?? {
            source: 'fallback',
            model: null,
            degraded: false,
            degraded_reason: null,
            latency_ms: null,
          },
          details: (payload.details as ProposalRecord['details']) ?? {
            kind: 'capture_task',
            task: { title: '', description: '', assignee_kind: 'human', acceptance_criteria: [] },
          },
          created_at: String(payload.proposed_at ?? event.occurred_at),
          assigned_task_id: null,
        });
        break;
      }
      case 'PlanChangeApplied': {
        const proposal = this.proposals.get(String(payload.change_id));
        if (!proposal) throw new Error(`PlanChangeApplied without proposal: ${String(payload.change_id)}`);
        proposal.status = 'accepted';
        proposal.assigned_task_id = (payload.task_id as string | null) ?? proposal.assigned_task_id;
        break;
      }
      case 'PlanChangeRejected': {
        const proposal = this.proposals.get(String(payload.change_id));
        if (!proposal) throw new Error(`PlanChangeRejected without proposal: ${String(payload.change_id)}`);
        proposal.status = 'rejected';
        proposal.status_reason = String(payload.reason ?? '');
        break;
      }
      case 'AssignmentCreated':
      case 'TaskDefined':
      case 'RunCreated':
      case 'RunStarted':
      case 'RunSucceeded':
      case 'FeedbackInterpreted':
      case 'TaskCancelRequested':
      case 'RunCanceled':
      case 'DevBurstRecorded':
        // mock-only 负载：这些事件不改本 mock 的投影形状。
        break;
      default:
        throw new Error(`mock apply 不认识事件类型：${event.kind}`);
    }
  }

  // --------------------------------------------------------------------------
  // 种子（R-7：与真服务种子契约同名同形）
  // --------------------------------------------------------------------------

  seedDemoProject(): void {
    const projectId = DEMO.projectId;
    this.emit({
      kind: 'ProjectCreated',
      project_id: projectId,
      entity_id: projectId,
      payload: {
        name: '续行演示 · 客户方案落地',
        policy_id: 'policy_demo',
        created_by: CURRENT_ACTOR_ID,
      },
    });
    this.emit({
      kind: 'GoalCreated',
      project_id: projectId,
      entity_id: DEMO.goalId,
      payload: {
        goal_id: DEMO.goalId,
        statement: '把「张三方案确认 → 报价 → 合同」这条客户落地链路跑通并完成验收',
        success_criteria: '每个任务都有可核对反馈，最终验收全部判据通过',
        stop_conditions: '客户明确终止合作时停止',
      },
    });

    for (const seed of SEED_TASKS) {
      const base = { project_id: projectId, entity_id: seed.task_id };
      this.emit({
        ...base,
        kind: 'TaskCaptured',
        payload: {
          task_id: seed.task_id,
          title: seed.title,
          description: seed.description,
          assignee_id: CURRENT_ACTOR_ID,
          assignee_kind: 'human',
          contract_rev: 1,
          acceptance_criteria: copyCriteria(seed.criteria),
          proposal_id: seed.proposal_id ?? null,
          capture_id: seed.capture_id ?? null,
          lifecycle: 'captured',
        },
      });
      this.emit({ ...base, kind: 'AssignmentCreated', payload: { task_id: seed.task_id } });
      this.emit({ ...base, kind: 'TaskDefined', payload: { task_id: seed.task_id } });
      this.transition(seed.task_id, 'captured', 'defined');

      if (seed.lifecycle === 'defined') continue;
      this.transition(seed.task_id, 'defined', 'ready');
      if (seed.lifecycle === 'ready') continue;

      this.emit({ ...base, kind: 'RunCreated', payload: { task_id: seed.task_id, run_kind: 'human_light' } });
      this.emit({ ...base, kind: 'RunStarted', payload: { task_id: seed.task_id } });
      this.transition(seed.task_id, 'ready', 'active');
      if (seed.lifecycle === 'active') continue;

      if (seed.canceled === true) {
        this.emit({ ...base, kind: 'TaskCancelRequested', payload: { task_id: seed.task_id } });
        this.emit({ ...base, kind: 'RunCanceled', payload: { task_id: seed.task_id } });
        this.transition(seed.task_id, 'active', 'canceled');
        this.emit({ ...base, kind: 'TaskCanceled', payload: { task_id: seed.task_id, reason: 'seed' } });
        continue;
      }

      const runKey = `seed-${seed.task_id}`;
      this.emit({
        ...base,
        kind: 'FeedbackReceived',
        payload: {
          task_id: seed.task_id,
          run_id: `run-${runKey}`,
          author_id: CURRENT_ACTOR_ID,
          raw_content: seed.feedback ?? '',
        },
      });
      this.emit({
        ...base,
        kind: 'OutcomeRecorded',
        payload: { task_id: seed.task_id, outcome_id: `out-${runKey}`, conclusion_kind: 'achieved' },
      });
      this.emit({ ...base, kind: 'RunSucceeded', payload: { task_id: seed.task_id } });
      this.transition(seed.task_id, 'active', 'awaiting_acceptance');
      if (seed.accepted !== true) continue;

      this.emit({
        ...base,
        kind: 'AcceptanceRecorded',
        payload: {
          task_id: seed.task_id,
          acceptance_id: `acc-${runKey}`,
          verdict: 'accepted',
          criterion_results: seed.criteria.map((criterion) => ({
            criterion_ref: criterion.criterion_ref,
            verdict: 'passed',
            evidence_refs: [],
          })),
        },
      });
      this.transition(seed.task_id, 'awaiting_acceptance', 'accepted');
    }
  }

  /** R-7② 降级夹具：proj-degraded + goal-degraded-1 + prop-degraded-1（不预告 task_id）。 */
  seedDegradedFixture(): void {
    const projectId = DEGRADED.projectId;
    this.emit({
      kind: 'ProjectCreated',
      project_id: projectId,
      entity_id: projectId,
      payload: { name: '续行演示 · 降级场景', policy_id: 'policy_demo', created_by: CURRENT_ACTOR_ID },
    });
    this.emit({
      kind: 'GoalCreated',
      project_id: projectId,
      entity_id: DEGRADED.goalId,
      payload: {
        goal_id: DEGRADED.goalId,
        statement: '模型不可达时，系统仍能把捕获的输入记成可审阅的提议',
        success_criteria: '用户能看到降级明示，并决定接受或拒绝',
        stop_conditions: '用户拒绝该提议时停止',
      },
    });
    this.emit({
      kind: 'PlanChangeProposed',
      project_id: projectId,
      entity_id: DEGRADED.proposalId,
      payload: {
        change_id: DEGRADED.proposalId,
        client_proposal_id: 'cap-degraded-1',
        kind: 'capture_task',
        capture_id: 'cap-degraded-1',
        task_id: null,
        base_plan_rev: 1,
        ops: [{ op: 'add_task' }],
        risk_level: 'L0',
        rationale: '模型不可用，按输入文本生成确定性占位草稿（种子预置）',
        assumptions: ['模型不可用，任务草稿为确定性占位'],
        proposer: {
          source: 'fallback',
          model: null,
          degraded: true,
          degraded_reason: 'not_configured',
          latency_ms: null,
        },
        details: {
          kind: 'capture_task',
          task: {
            title: '跟进降级状态下捕获的事项',
            description: '由种子预置的降级草稿，用于演示"模型不可达时提议层降级"的界面与 API 形态。',
            assignee_kind: 'human',
            acceptance_criteria: [{ criterion_ref: 'c1', text: '事项已跟进并留有可核对记录', auto: false }],
          },
        },
        proposed_at: null,
      },
    });
  }

  private transition(taskId: string, from: string, to: string): EventRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`transition without task: ${taskId}`);
    if (task.lifecycle !== from) {
      throw new Error(`transition ${taskId}: 期望 from=${from}，实际 ${task.lifecycle}`);
    }
    return this.emit({
      kind: 'TaskLifecycleChanged',
      project_id: task.project_id,
      entity_id: taskId,
      payload: { task_id: taskId, from, to },
    });
  }

  // --------------------------------------------------------------------------
  // Capture（只产提议，不建任务 —— R-11）
  // --------------------------------------------------------------------------

  capture(text: string, projectId = DEMO.projectId): CaptureData {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw badRequest('capture.text 必须是非空字符串');
    }
    const project = this.projects.get(projectId);
    if (!project) throw badRequest(`项目 ${projectId} 不存在`, { field: 'project_id' });

    const captureId = `cap-${randomUUID()}`;
    const proposalId = `pc-${randomUUID()}`;
    const title = `整理并提交：${text.trim().slice(0, 48)}`;
    const draft: ProposalDraft = {
      title,
      description: text.trim(),
      assignee_kind: 'human',
      acceptance_criteria: copyCriteria(CAPTURE_CRITERIA),
    };

    this.emit({
      kind: 'PlanChangeProposed',
      project_id: projectId,
      entity_id: proposalId,
      payload: {
        change_id: proposalId,
        client_proposal_id: captureId,
        kind: 'capture_task',
        capture_id: captureId,
        task_id: null,
        base_plan_rev: this.proposalsAll(projectId).length,
        ops: [{ op: 'add_task' }],
        risk_level: 'L0',
        rationale: '把输入收敛为一条可验收任务，交由当前用户完成并逐判据验收。',
        assumptions: [],
        proposer: { source: 'model', model: 'mock-intent-interpreter', degraded: false, degraded_reason: null, latency_ms: 1 },
        details: { kind: 'capture_task', task: draft },
        proposed_at: new Date().toISOString(),
      },
    });
    this.emit({
      kind: 'FeedbackReceived',
      project_id: projectId,
      entity_id: captureId,
      payload: { feedback_id: `fb-${captureId}`, task_id: null, author_id: CURRENT_ACTOR_ID, raw_content: text, capture_id: captureId },
    });

    return {
      projection_version: this.head,
      capture_id: captureId,
      proposal_id: proposalId,
      project_id: projectId,
      degraded: false,
      degraded_reason: null,
      proposer: { source: 'model', model: 'mock-intent-interpreter', latency_ms: 1 },
      draft,
      replayed: false,
      emitted: [{ seq: this.head - 1, kind: 'PlanChangeProposed' }, { seq: this.head, kind: 'FeedbackReceived' }],
    };
  }

  private proposalsAll(projectId: string): ProposalRecord[] {
    return [...this.proposals.values()].filter((proposal) => proposal.project_id === projectId);
  }

  // --------------------------------------------------------------------------
  // 命令（统一入口，available_actions 复核 + client_submit_id 幂等）
  // --------------------------------------------------------------------------

  executeCommand(input: ExecuteCommandInput, actorId = CURRENT_ACTOR_ID): CommandResultData {
    if (typeof input.client_submit_id !== 'string' || input.client_submit_id.length === 0) {
      throw badRequest('client_submit_id 必填（幂等键）', { field: 'client_submit_id' });
    }
    if (typeof input.type !== 'string' || input.type.length === 0) {
      throw badRequest('命令 type 必填', { field: 'type' });
    }
    // 与真服务同口径：指纹只含 payload（commands.ts 的 fingerprint(requestPayload)），
    // 回执里另记 command_type —— 同一 id 换命令类型也是 409（幂等键冲突）。
    const fingerprint = JSON.stringify(input.payload);
    const existing = this.receipts.get(input.client_submit_id);
    if (existing) {
      if (existing.type !== input.type || existing.fingerprint !== fingerprint) {
        throw conflict(`client_submit_id=${input.client_submit_id} 已用于不同内容的命令`, {
          reason: 'idempotency_key_conflict',
          retryable: false,
        });
      }
      return { ...existing.result, emitted: [], replayed: true };
    }

    if (!(COMMAND_TYPES as readonly string[]).includes(input.type)) {
      throw badRequest(`不支持的命令 type=${input.type}`, {
        field: 'type',
        allowed: [...COMMAND_TYPES],
      });
    }
    const type = input.type as CommandType;
    const before = this.head;
    let subject: Record<string, unknown>;
    switch (type) {
      case 'proposal_accept':
        subject = this.acceptProposal(String(input.payload.proposal_id ?? ''), actorId);
        break;
      case 'proposal_reject':
        subject = this.rejectProposal(String(input.payload.proposal_id ?? ''), String(input.payload.reason ?? '用户拒绝提议'));
        break;
      case 'task_advance':
        subject = this.advanceTask(String(input.payload.task_id ?? ''), input.payload.to, actorId);
        break;
      case 'feedback_submit':
        subject = this.submitFeedback(String(input.payload.task_id ?? ''), String(input.payload.content ?? ''), actorId);
        break;
      case 'acceptance_record':
        subject = this.recordAcceptance(input.payload, actorId);
        break;
      case 'task_cancel':
        subject = this.cancelTask(String(input.payload.task_id ?? ''), actorId);
        break;
      default:
        throw badRequest(`未实现的命令 type=${String(type)}`);
    }

    const emitted = this.events.filter((event) => event.seq > before).map((event) => ({ seq: event.seq, kind: event.kind }));
    const result: CommandResultData = {
      projection_version: this.head,
      command_type: type,
      client_submit_id: input.client_submit_id,
      replayed: false,
      emitted,
      subject,
      receipt_event_id: receiptEventId(input.client_submit_id),
    };
    this.receipts.set(input.client_submit_id, { type, fingerprint, result });
    return result;
  }

  private requireProposal(proposalId: string): ProposalRecord {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw conflict(`提议 ${proposalId} 不存在`, { reason: 'proposal_not_found' });
    return proposal;
  }

  private requireTask(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw conflict(`任务 ${taskId} 不存在`, { reason: 'task_not_found' });
    return task;
  }

  private acceptProposal(proposalId: string, actorId: string): Record<string, unknown> {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status !== 'proposed') {
      throw conflict(`提议 ${proposalId} 当前状态为 ${proposal.status}，不可再接受`, {
        reason: 'proposal_not_proposed',
        status: proposal.status,
      });
    }
    // R-11：任务 id 在接受的这一刻由服务端发号
    const taskId = `task-${randomUUID()}`;
    const draft = proposal.details.task;
    const base = { project_id: proposal.project_id, entity_id: taskId };
    this.emit({
      ...base,
      kind: 'TaskCaptured',
      payload: {
        task_id: taskId,
        title: draft.title,
        description: draft.description,
        assignee_id: actorId,
        assignee_kind: draft.assignee_kind,
        contract_rev: 1,
        acceptance_criteria: copyCriteria(draft.acceptance_criteria),
        proposal_id: proposal.proposal_id,
        capture_id: proposal.capture_id,
        lifecycle: 'captured',
      },
    });
    this.emit({ ...base, kind: 'AssignmentCreated', payload: { task_id: taskId, actor_id: actorId } });
    this.emit({ ...base, kind: 'TaskDefined', payload: { task_id: taskId } });
    this.transition(taskId, 'captured', 'defined');
    this.emit({
      ...base,
      kind: 'PlanChangeApplied',
      entity_id: proposal.proposal_id,
      payload: { change_id: proposal.proposal_id, task_id: taskId, command: 'proposal_accept' },
    });
    return { proposal_id: proposal.proposal_id, task_id: taskId, project_id: proposal.project_id };
  }

  private rejectProposal(proposalId: string, reason: string): Record<string, unknown> {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status !== 'proposed') {
      throw conflict(`提议 ${proposalId} 当前状态为 ${proposal.status}，不可拒绝`, {
        reason: 'proposal_not_proposed',
        status: proposal.status,
      });
    }
    this.emit({
      kind: 'PlanChangeRejected',
      project_id: proposal.project_id,
      entity_id: proposal.proposal_id,
      payload: { change_id: proposal.proposal_id, reason, rejected_by: CURRENT_ACTOR_ID },
    });
    return { proposal_id: proposal.proposal_id, project_id: proposal.project_id };
  }

  private advanceTask(taskId: string, to: unknown, actorId: string): Record<string, unknown> {
    const task = this.requireTask(taskId);
    const actions = availableActionsFor(task, actorId);
    if (!actions.includes('task_advance')) {
      throw conflict(`任务 ${taskId} 当前无可用推进动作（lifecycle=${task.lifecycle}）`, {
        reason: 'not_in_available_actions',
        task_id: taskId,
        lifecycle: task.lifecycle,
        available_actions: actions,
      });
    }
    const next = task.lifecycle === 'defined' ? 'ready' : 'active';
    if (to !== undefined && to !== next) {
      throw conflict(`目标状态 ${String(to)} 不在 available_actions 中（期望 ${next}）`, {
        reason: 'not_in_available_actions',
        task_id: taskId,
        requested_to: to,
        available_to: next,
      });
    }
    if (next === 'active') {
      this.emit({
        kind: 'RunCreated',
        project_id: task.project_id,
        entity_id: taskId,
        payload: { task_id: taskId, run_kind: 'human_light', actor_id: actorId },
      });
      this.emit({ kind: 'RunStarted', project_id: task.project_id, entity_id: taskId, payload: { task_id: taskId } });
    }
    this.transition(taskId, task.lifecycle, next);
    return { task_id: taskId, from: task.lifecycle === next ? next : null, to: next, project_id: task.project_id };
  }

  private submitFeedback(taskId: string, content: string, actorId: string): Record<string, unknown> {
    const task = this.requireTask(taskId);
    const actions = availableActionsFor(task, actorId);
    if (!actions.includes('feedback_submit')) {
      throw conflict(`任务 ${taskId} 当前不接受 ${actorId} 的执行反馈（lifecycle=${task.lifecycle}）`, {
        reason: 'not_in_available_actions',
        task_id: taskId,
        lifecycle: task.lifecycle,
        available_actions: actions,
      });
    }
    if (content.trim().length === 0) throw badRequest('feedback_submit.content 必填', { field: 'content' });
    const feedbackId = `fb-${randomUUID()}`;
    const outcomeId = `out-${randomUUID()}`;
    const base = { project_id: task.project_id, entity_id: taskId };
    this.emit({
      ...base,
      kind: 'FeedbackReceived',
      payload: { feedback_id: feedbackId, task_id: taskId, run_id: `run-${taskId}`, author_id: actorId, raw_content: content },
    });
    this.emit({
      ...base,
      kind: 'FeedbackInterpreted',
      payload: { feedback_id: feedbackId, task_id: taskId },
    });
    this.emit({
      ...base,
      kind: 'OutcomeRecorded',
      payload: { outcome_id: outcomeId, task_id: taskId, feedback_id: feedbackId, conclusion_kind: 'achieved' },
    });
    this.emit({ ...base, kind: 'RunSucceeded', payload: { task_id: taskId, outcome_id: outcomeId } });
    this.transition(taskId, 'active', 'awaiting_acceptance');
    return { task_id: taskId, feedback_id: feedbackId, outcome_id: outcomeId, project_id: task.project_id };
  }

  private recordAcceptance(payload: Record<string, unknown>, actorId: string): Record<string, unknown> {
    const taskId = String(payload.task_id ?? '');
    const task = this.requireTask(taskId);
    const actions = availableActionsFor(task, actorId);
    if (!actions.includes('acceptance_record')) {
      throw conflict(`任务 ${taskId} 当前不可验收（lifecycle=${task.lifecycle}）`, {
        reason: 'not_in_available_actions',
        task_id: taskId,
        lifecycle: task.lifecycle,
        available_actions: actions,
      });
    }

    const rawResults = payload.criterion_results;
    if (!Array.isArray(rawResults) || rawResults.length === 0) {
      throw badRequest('criterion_results 必须是非空数组', { field: 'criterion_results' });
    }
    const results: CriterionResult[] = [];
    const seen = new Set<string>();
    for (const raw of rawResults as Record<string, unknown>[]) {
      const ref = String(raw.criterion_ref ?? '');
      const verdict = String(raw.verdict ?? '');
      if (!['passed', 'failed', 'not_applicable'].includes(verdict)) {
        throw badRequest(`criterion ${ref} 的 verdict 非法`, { field: 'criterion_results' });
      }
      if (seen.has(ref)) throw badRequest(`criterion_ref ${ref} 重复`, { field: 'criterion_results' });
      seen.add(ref);
      if (!task.criteria.some((criterion) => criterion.criterion_ref === ref)) {
        throw badRequest(`criterion_ref ${ref} 不在当前契约里`, {
          field: 'criterion_results',
          allowed: task.criteria.map((criterion) => criterion.criterion_ref),
        });
      }
      results.push({
        criterion_ref: ref,
        verdict: verdict as CriterionResult['verdict'],
        evidence_refs: Array.isArray(raw.evidence_refs) ? raw.evidence_refs.map(String) : [],
      });
    }
    // 覆盖完整性：契约里每条判据都要有结果（内核 REQ-ACC-2①）
    const missing = task.criteria.map((criterion) => criterion.criterion_ref).filter((ref) => !seen.has(ref));
    if (missing.length > 0) {
      throw badRequest('验收缺少判据（覆盖不完整，内核不入账）', {
        field: 'criterion_results',
        missing_criteria: missing,
      });
    }

    const passed = results.filter((result) => result.verdict !== 'failed').length;
    const failed = results.filter((result) => result.verdict === 'failed').length;
    const verdict: AcceptanceVerdict = failed === 0 ? 'accepted' : passed === 0 ? 'rejected' : 'partially_accepted';
    if (payload.verdict !== undefined && payload.verdict !== verdict) {
      throw badRequest('顶层 verdict 与逐判据结果不一致', { field: 'verdict', derived: verdict });
    }

    const acceptanceId = `acc-${randomUUID()}`;
    this.emit({
      kind: 'AcceptanceRecorded',
      project_id: task.project_id,
      entity_id: taskId,
      payload: {
        acceptance_id: acceptanceId,
        task_id: taskId,
        verdict,
        criterion_results: results,
        rationale: String(payload.rationale ?? ''),
        acceptor_id: actorId,
      },
    });
    // 内核矩阵：accepted → accepted；rejected → defined；partially_accepted → active（需再执行）
    const target: TaskRecord['lifecycle'] =
      verdict === 'accepted' ? 'accepted' : verdict === 'rejected' ? 'defined' : 'active';
    this.transition(taskId, 'awaiting_acceptance', target);
    return { task_id: taskId, acceptance_id: acceptanceId, verdict, project_id: task.project_id };
  }

  private cancelTask(taskId: string, actorId: string): Record<string, unknown> {
    const task = this.requireTask(taskId);
    const actions = availableActionsFor(task, actorId);
    if (!actions.includes('task_cancel')) {
      throw conflict(`任务 ${taskId} 当前不可取消（lifecycle=${task.lifecycle}）`, {
        reason: 'not_in_available_actions',
        task_id: taskId,
        lifecycle: task.lifecycle,
        available_actions: actions,
      });
    }
    const from = task.lifecycle;
    this.emit({ kind: 'TaskCancelRequested', project_id: task.project_id, entity_id: taskId, payload: { task_id: taskId } });
    this.emit({ kind: 'RunCanceled', project_id: task.project_id, entity_id: taskId, payload: { task_id: taskId } });
    this.transition(taskId, from, 'canceled');
    this.emit({ kind: 'TaskCanceled', project_id: task.project_id, entity_id: taskId, payload: { task_id: taskId } });
    return { task_id: taskId, lifecycle: 'canceled', cancel_requested: true, project_id: task.project_id };
  }

  // --------------------------------------------------------------------------
  // 投影（全部只读，R-8 键集）
  // --------------------------------------------------------------------------

  proposalData(proposalId: string): ProposalData {
    const proposal = this.requireProposal(proposalId);
    return {
      projection_version: this.head,
      proposal_id: proposal.proposal_id,
      project_id: proposal.project_id,
      kind: proposal.kind,
      status: proposal.status,
      status_reason: proposal.status_reason,
      capture_id: proposal.capture_id,
      // R-11：提议阶段恒为 null，接受后才挂上服务端发出的 id
      task_id: proposal.assigned_task_id,
      rationale: proposal.rationale,
      assumptions: [...proposal.assumptions],
      risk_level: proposal.risk_level,
      base_plan_rev: proposal.base_plan_rev,
      ops: proposal.ops,
      degraded: proposal.degraded,
      proposer: { ...proposal.proposer },
      details: {
        kind: 'capture_task',
        task: {
          ...proposal.details.task,
          acceptance_criteria: copyCriteria(proposal.details.task.acceptance_criteria),
        },
      },
      created_at: proposal.created_at,
      available_actions: proposalActionsFor(proposal),
    };
  }

  projectData(projectId: string, actorId = CURRENT_ACTOR_ID): ProjectData {
    const project = this.projects.get(projectId);
    if (!project) throw notFound(`项目 ${projectId} 不存在`);
    const tasks = [...this.tasks.values()]
      .filter((task) => task.project_id === projectId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.task_id.localeCompare(b.task_id));

    const criterionSummary = tasks
      .filter((task) => task.acceptance !== null)
      .flatMap((task) =>
        task.acceptance!.criterion_results.map((result) => ({
          task_id: task.task_id,
          criterion_ref: result.criterion_ref,
          verdict: result.verdict,
        })),
      );

    return {
      projection_version: this.head,
      project: {
        project_id: project.project_id,
        name: project.name,
        policy_id: project.policy_id,
        created_by: project.created_by,
      },
      goal: {
        goal_id: project.goal_id,
        statement: project.goal_statement,
        success_criteria: project.goal_success,
        stop_conditions: project.goal_stop,
        status: project.goal_status,
      },
      tasks: tasks.map((task) => ({
        task_id: task.task_id,
        project_id: task.project_id,
        title: task.title,
        description: task.description,
        lifecycle: task.lifecycle,
        wait_state: task.wait_state,
        assignee_kind: task.assignee_kind,
        assigned_by: task.assignee_id,
        duplicate_suspect: false,
        capture_id: task.capture_id,
        proposal_id: task.proposal_id,
        current_contract_rev: task.current_contract_rev,
        last_outcome_id: task.last_outcome_id,
        feedback_count: task.feedback_count,
        cancel_requested: task.cancel_requested,
        acceptance_criteria: copyCriteria(task.criteria),
        acceptance: task.acceptance === null
          ? null
          : {
            ...task.acceptance,
            criterion_results: task.acceptance.criterion_results.map((result) => ({
              ...result,
              evidence_refs: [...result.evidence_refs],
            })),
          },
        active_wait_conditions: [],
        available_actions: availableActionsFor(task, actorId),
        updated_global_seq: this.head,
      })),
      acceptance_status: {
        accepted: tasks.filter((task) => task.lifecycle === 'accepted').length,
        awaiting: tasks.filter((task) => task.lifecycle === 'awaiting_acceptance').length,
        rejected: tasks.filter((task) => task.acceptance?.verdict === 'rejected').length,
        total: tasks.length,
        criterion_summary: criterionSummary,
      },
      graph: {
        nodes: tasks.map((task) => ({ id: task.task_id, title: task.title, lifecycle: task.lifecycle })),
        edges: [],
      },
      pending_proposals: this.proposalsAll(projectId)
        .filter((proposal) => proposal.status === 'proposed')
        .map((proposal) => ({
          proposal_id: proposal.proposal_id,
          kind: proposal.kind,
          status: proposal.status,
          degraded: proposal.degraded,
          rationale: proposal.rationale,
          created_at: proposal.created_at,
        })),
    };
  }

  actionsData(actorId = CURRENT_ACTOR_ID): ActionsData {
    const items: ActionItem[] = [];
    for (const task of [...this.tasks.values()].sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || a.task_id.localeCompare(b.task_id),
    )) {
      const available = availableActionsFor(task, actorId);
      if (available.length === 0) continue;
      items.push({
        task_id: task.task_id,
        project_id: task.project_id,
        project_name: this.projects.get(task.project_id)?.name ?? task.project_id,
        title: task.title,
        lifecycle: task.lifecycle,
        wait_state: task.wait_state,
        next_action: ACTION_LABEL[available[0]],
        available_actions: available,
        updated_global_seq: this.head,
      });
    }
    return { projection_version: this.head, actor_id: actorId, items };
  }

  homeData(actorId = CURRENT_ACTOR_ID): HomeData {
    const actions = this.actionsData(actorId).items;
    const projects: HomeProjectSummary[] = [...this.projects.values()].map((project) => {
      const data = this.projectData(project.project_id, actorId);
      const taskCounts: Record<string, number> = {};
      for (const task of data.tasks) taskCounts[task.lifecycle] = (taskCounts[task.lifecycle] ?? 0) + 1;
      return {
        project_id: project.project_id,
        name: project.name,
        goal_statement: project.goal_statement,
        goal_status: project.goal_status,
        task_counts: taskCounts,
        total_tasks: data.tasks.length,
        accepted_tasks: data.acceptance_status.accepted,
        last_event_at: project.updated_at,
      };
    });
    const pendingProposals = [...this.proposals.values()].filter((proposal) => proposal.status === 'proposed');
    return {
      projection_version: this.head,
      actor_id: actorId,
      projects,
      my_actions_count: actions.length,
      recent_activity: this.events
        .filter((event) => event.kind !== 'DevBurstRecorded')
        .slice()
        .reverse()
        .slice(0, 20)
        .map((event) => ({
          seq: event.seq,
          kind: event.kind,
          project_id: event.project_id,
          task_id: (event.payload.task_id as string | null) ?? null,
          occurred_at: event.occurred_at,
          summary: `${event.kind}${event.entity_id ? `（${event.entity_id.slice(0, 12)}）` : ''}`,
        })),
      proposals: {
        pending: pendingProposals.length,
        degraded: pendingProposals.filter((proposal) => proposal.degraded).length,
      },
    };
  }

  // --------------------------------------------------------------------------
  // SSE / 测试仪表
  // --------------------------------------------------------------------------

  streamFrame(event: EventRecord): StreamEventFrame {
    return {
      projection_version: this.head,
      seq: event.seq,
      kind: event.kind,
      stream_id: event.project_id,
      project_id: event.project_id,
      task_id: (event.payload.task_id as string | null) ?? null,
      proposal_id: (event.payload.change_id as string | null) ?? null,
      occurred_at: event.occurred_at,
    };
  }

  /** mock-only：制造一段连续事件，用于背压/慢消费者测试。 */
  emitBurst(count: number, projectId = DEMO.projectId): number {
    const capped = Math.max(1, Math.min(count, 5000));
    for (let index = 0; index < capped; index += 1) {
      this.emit({
        kind: 'DevBurstRecorded',
        project_id: projectId,
        entity_id: `burst-${this.head + 1}`,
        payload: { index },
      });
    }
    return capped;
  }
}
