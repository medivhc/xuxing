import { randomUUID } from 'node:crypto';
import type {
  AcceptanceVerdict,
  ActionRow,
  ActionsProjection,
  CaptureResponse,
  CommandReceipt,
  CommandResponse,
  CommandType,
  Criterion,
  CriterionResult,
  HomeProjection,
  ProjectProjection,
  ProjectTaskNode,
  ProposalProjection,
  ProposedTask,
  StreamEventFrame,
} from '../contract.mts';
import { COMMAND_TYPES } from '../contract.mts';
import { CURRENT_ACTOR_ID, DEMO, DEGRADED } from '../journeys.config.mts';
import { ApiError, badRequest, forbidden, notFound, terminalState } from './errors.mts';

// ============================================================================
// mock 的领域存储：append-only 事件日志 + 由事件 apply 出来的最小实体集。
//
// 纪律对应：
//   - 投影只从事件 apply 得到（home/project/actions/proposal 都是纯读）；
//   - 每个投影带 projection_version = 已并入的最大全局 seq；
//   - 命令先过 available_actions 复核，再追加事件；
//   - client_submit_id 幂等：同 id 重放不追加事件，回首次回执。
//
// 这是**测试用 mock**，不实现 Run/Assignment/Policy，也不做 actor 分离
// （record_acceptance 允许完成任务的那个人提交）。真服务集成由车道 A/B 替换。
// ============================================================================

export interface EventRecord {
  seq: number;
  kind: string;
  type: string;
  project_id: string;
  entity_id: string;
  summary: string;
  degraded: boolean;
  occurred_at: string;
  payload: Record<string, unknown>;
}

interface ProjectRecord {
  project_id: string;
  title: string;
  goal_id: string;
  goal_text: string;
  goal_status: 'draft' | 'in_progress' | 'achieved';
  plan_rev: number;
  created_at: string;
  updated_at: string;
}

interface TaskRecord {
  task_id: string;
  project_id: string;
  title: string;
  lifecycle: ProjectTaskNode['lifecycle'];
  wait_state: string;
  intended_assignee_id: string;
  assignee_kind: 'human' | 'agent';
  current_contract_rev: number;
  criteria: Criterion[];
  criterion_results: CriterionResult[];
  degraded: boolean;
  created_from_proposal: string | null;
  outcome: ProjectTaskNode['outcome'];
  last_acceptance: ProjectTaskNode['last_acceptance'];
  acceptance_seq: number;
  created_at: string;
}

interface ProposalRecord extends Omit<ProposalProjection, 'projection_version' | 'available_actions'> {
  /** 记录 accept/reject 的事件序号，用于排序/诊断。 */
  decided_seq: number | null;
}

interface CaptureRecord {
  capture_id: string;
  project_id: string;
  text: string;
  proposal_id: string | null;
  created_at: string;
}

interface StoredReceipt {
  fingerprint: string;
  body: CommandResponse;
}

export interface ExecuteCommandInput {
  type: string;
  payload: Record<string, unknown>;
  client_submit_id: string;
}

export type EventListener = (event: EventRecord) => void;

const DEFAULT_CRITERIA: Criterion[] = [
  { criterion_ref: 'c-import-mapped', kind: 'auto', label: '导入映射字段齐全（自动核对）' },
  { criterion_ref: 'c-dual-track-report', kind: 'manual', label: '双轨对照结论已给出（人工判定）' },
];

const DEGRADED_CRITERIA: Criterion[] = [
  { criterion_ref: 'c-leads-export', kind: 'auto', label: '手机端线索导出完整（自动核对）' },
  { criterion_ref: 'c-leads-dedup', kind: 'manual', label: '重复线索已人工合并（人工判定）' },
];

const TERMINAL_LIFECYCLES = new Set<TaskRecord['lifecycle']>(['accepted', 'canceled']);

function copyCriteria(criteria: Criterion[]): Criterion[] {
  return criteria.map((criterion) => ({ ...criterion }));
}

function copyProposedTasks(tasks: ProposedTask[]): ProposedTask[] {
  return tasks.map((task) => ({ ...task, criteria: copyCriteria(task.criteria) }));
}

/** 当前 actor 对一条 Task 的可用动作（前端只渲染，服务端复核用同一函数）。 */
export function availableActionsFor(task: TaskRecord, actorId: string): CommandType[] {
  if (task.lifecycle === 'defined' && task.wait_state === 'none' && task.intended_assignee_id === actorId) {
    return ['complete_task'];
  }
  if (
    task.lifecycle === 'awaiting_acceptance' &&
    task.assignee_kind === 'human' &&
    task.intended_assignee_id === actorId
  ) {
    return ['record_acceptance'];
  }
  return [];
}

function proposeActionsFor(proposal: ProposalRecord): CommandType[] {
  return proposal.status === 'proposed' ? ['accept_proposal', 'reject_proposal'] : [];
}

function computeVerdict(results: CriterionResult[]): AcceptanceVerdict {
  const passed = results.filter((r) => r.verdict === 'passed').length;
  if (passed === results.length) return 'accepted';
  if (passed === 0) return 'rejected';
  return 'partially_accepted';
}

export class JourneyState {
  readonly events: EventRecord[] = [];
  readonly projects = new Map<string, ProjectRecord>();
  readonly tasks = new Map<string, TaskRecord>();
  readonly proposals = new Map<string, ProposalRecord>();
  readonly captures = new Map<string, CaptureRecord>();

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
    type: string;
    kind: string;
    project_id: string;
    entity_id: string;
    summary: string;
    degraded?: boolean;
    payload?: Record<string, unknown>;
  }): EventRecord {
    const occurredAt = new Date().toISOString();
    const event: EventRecord = {
      seq: ++this.head,
      kind: input.kind,
      type: input.type,
      project_id: input.project_id,
      entity_id: input.entity_id,
      summary: input.summary,
      degraded: input.degraded === true,
      occurred_at: occurredAt,
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

    switch (event.type) {
      case 'ProjectCreated': {
        this.projects.set(event.project_id, {
          project_id: event.project_id,
          title: String(payload.title ?? event.project_id),
          goal_id: '',
          goal_text: '',
          goal_status: 'draft',
          plan_rev: 0,
          created_at: event.occurred_at,
          updated_at: event.occurred_at,
        });
        break;
      }
      case 'GoalCreated': {
        if (!project) throw new Error(`GoalCreated before ProjectCreated: ${event.project_id}`);
        project.goal_id = String(payload.goal_id);
        project.goal_text = String(payload.text);
        break;
      }
      case 'FeedbackReceived': {
        this.captures.set(String(payload.capture_id), {
          capture_id: String(payload.capture_id),
          project_id: event.project_id,
          text: String(payload.text),
          proposal_id: null,
          created_at: event.occurred_at,
        });
        break;
      }
      case 'PlanChangeProposed': {
        const proposedTasks = copyProposedTasks((payload.proposed_tasks as ProposedTask[]) ?? []);
        this.proposals.set(String(payload.proposal_id), {
          proposal_id: String(payload.proposal_id),
          project_id: event.project_id,
          capture_id: String(payload.capture_id),
          status: 'proposed',
          degraded: payload.degraded === true,
          degraded_reasons: (payload.degraded_reasons as string[]) ?? [],
          summary: String(payload.summary ?? ''),
          rationale: String(payload.rationale ?? ''),
          proposed_tasks: proposedTasks,
          created_at: event.occurred_at,
          decided_at: null,
          decided_seq: null,
        });
        const capture = this.captures.get(String(payload.capture_id));
        if (capture) capture.proposal_id = String(payload.proposal_id);
        break;
      }
      case 'PlanChangeApplied': {
        const proposal = this.proposals.get(String(payload.proposal_id));
        if (!proposal) throw new Error(`PlanChangeApplied without proposal: ${String(payload.proposal_id)}`);
        proposal.status = 'accepted';
        proposal.decided_at = event.occurred_at;
        proposal.decided_seq = event.seq;
        if (project) project.plan_rev = Number(payload.plan_rev ?? project.plan_rev + 1);
        break;
      }
      case 'PlanChangeRejected': {
        const proposal = this.proposals.get(String(payload.proposal_id));
        if (!proposal) throw new Error(`PlanChangeRejected without proposal: ${String(payload.proposal_id)}`);
        proposal.status = 'rejected';
        proposal.decided_at = event.occurred_at;
        proposal.decided_seq = event.seq;
        break;
      }
      case 'PlanRevisionCreated': {
        if (project) project.plan_rev = Number(payload.plan_rev ?? project.plan_rev);
        break;
      }
      case 'TaskCaptured': {
        this.tasks.set(String(payload.task_id), {
          task_id: String(payload.task_id),
          project_id: event.project_id,
          title: String(payload.title ?? ''),
          lifecycle: (payload.lifecycle as TaskRecord['lifecycle']) ?? 'defined',
          wait_state: String(payload.wait_state ?? 'none'),
          intended_assignee_id: String(payload.assignee_id ?? ''),
          assignee_kind: (payload.assignee_kind as 'human' | 'agent') ?? 'human',
          current_contract_rev: Number(payload.contract_rev ?? 1),
          criteria: copyCriteria((payload.criteria as Criterion[]) ?? []),
          criterion_results: [],
          degraded: payload.degraded === true,
          created_from_proposal: (payload.created_from_proposal as string | null) ?? null,
          outcome: null,
          last_acceptance: null,
          acceptance_seq: 0,
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
      case 'OutcomeRecorded': {
        const task = this.tasks.get(String(payload.task_id));
        if (!task) throw new Error(`OutcomeRecorded without task: ${String(payload.task_id)}`);
        task.outcome = {
          outcome_id: String(payload.outcome_id),
          conclusion_kind: String(payload.conclusion_kind ?? 'unknown'),
          recorded_at: event.occurred_at,
        };
        break;
      }
      case 'AcceptanceRecorded': {
        const task = this.tasks.get(String(payload.task_id));
        if (!task) throw new Error(`AcceptanceRecorded without task: ${String(payload.task_id)}`);
        task.criterion_results = (payload.criterion_results as CriterionResult[]).map((result) => ({
          criterion_ref: result.criterion_ref,
          verdict: result.verdict,
          evidence_refs: [...result.evidence_refs],
        }));
        task.last_acceptance = {
          acceptance_id: String(payload.acceptance_id),
          verdict: payload.verdict as AcceptanceVerdict,
          recorded_at: event.occurred_at,
        };
        task.acceptance_seq = event.seq;
        break;
      }
      case 'GoalStatusChanged': {
        if (project) project.goal_status = payload.status as ProjectRecord['goal_status'];
        break;
      }
      case 'DevBurstRecorded': {
        // mock-only 负载，不派生任何领域状态。
        break;
      }
      default:
        throw new Error(`mock apply 不认识事件类型：${event.type}`);
    }
  }

  // --------------------------------------------------------------------------
  // 种子
  // --------------------------------------------------------------------------

  /** 一个演示项目 + 一条历史任务（已取消，无可用动作），任务图从空开始。 */
  seedDemoProject(): void {
    const projectId = DEMO.projectId;
    this.emit({
      type: 'ProjectCreated',
      kind: 'project.created',
      project_id: projectId,
      entity_id: projectId,
      summary: '演示项目已创建',
      payload: { title: 'nx-pipeline 导入与双轨对照' },
    });
    this.emit({
      type: 'GoalCreated',
      kind: 'goal.created',
      project_id: projectId,
      entity_id: DEMO.goalId,
      summary: '目标：把 nx-pipeline 最近一轮 run 导入续行并跑通双轨对照',
      payload: {
        goal_id: DEMO.goalId,
        text: '把 nx-pipeline 最近一轮 run 导入续行，跑通双轨对照并给出结论',
      },
    });
    this.emit({
      type: 'TaskCaptured',
      kind: 'task.created',
      project_id: projectId,
      entity_id: DEMO.canceledTaskId,
      summary: '历史任务：旧版导入脚本试跑',
      payload: {
        task_id: DEMO.canceledTaskId,
        title: '旧版导入脚本试跑',
        assignee_id: 'actor-agent-legacy',
        assignee_kind: 'agent',
        contract_rev: 1,
        criteria: [{ criterion_ref: 'c-legacy-smoke', kind: 'auto', label: '旧脚本冒烟通过' }],
        created_from_proposal: null,
        degraded: false,
      },
    });
    this.emit({
      type: 'TaskCanceled',
      kind: 'task.canceled',
      project_id: projectId,
      entity_id: DEMO.canceledTaskId,
      summary: '历史任务已取消（改用新导入路径）',
      payload: { task_id: DEMO.canceledTaskId, reason: '改用新导入路径' },
    });
  }

  /** 降级演示项目：种子中已有一条带 degraded 标记的提议。 */
  seedDegradedProposal(): void {
    const projectId = DEGRADED.projectId;
    this.emit({
      type: 'ProjectCreated',
      kind: 'project.created',
      project_id: projectId,
      entity_id: projectId,
      summary: '降级演示项目已创建',
      payload: { title: '手机端线索导入（降级链路）' },
    });
    this.emit({
      type: 'GoalCreated',
      kind: 'goal.created',
      project_id: projectId,
      entity_id: `${DEGRADED.projectId}-goal`,
      summary: '目标：把手机端收集的线索导入续行',
      payload: {
        goal_id: `${DEGRADED.projectId}-goal`,
        text: '把手机端收集的线索导入续行并完成去重',
      },
    });
    this.emit({
      type: 'TaskCaptured',
      kind: 'task.created',
      project_id: projectId,
      entity_id: `${DEGRADED.projectId}-legacy`,
      summary: '历史任务：手工线索表整理',
      payload: {
        task_id: `${DEGRADED.projectId}-legacy`,
        title: '手工线索表整理',
        assignee_id: 'actor-agent-legacy',
        assignee_kind: 'agent',
        contract_rev: 1,
        criteria: [{ criterion_ref: 'c-legacy-leads', kind: 'manual', label: '手工表已核对' }],
        created_from_proposal: null,
        degraded: false,
      },
    });
    this.emit({
      type: 'TaskCanceled',
      kind: 'task.canceled',
      project_id: projectId,
      entity_id: `${DEGRADED.projectId}-legacy`,
      summary: '历史任务已取消（转入降级链路）',
      payload: { task_id: `${DEGRADED.projectId}-legacy`, reason: '转入降级链路' },
    });
    this.emit({
      type: 'FeedbackReceived',
      kind: 'feedback.captured',
      project_id: projectId,
      entity_id: 'cap-degraded-1',
      summary: '捕获：手机端线索待导入（降级解析）',
      degraded: true,
      payload: { capture_id: 'cap-degraded-1', text: '把手机端收集的线索导入续行（降级解析）' },
    });
    this.emit({
      type: 'PlanChangeProposed',
      kind: 'proposal.created',
      project_id: projectId,
      entity_id: DEGRADED.proposalId,
      summary: '降级提议：整理手机端线索清单（规则模板 + 人工确认）',
      degraded: true,
      payload: {
        proposal_id: DEGRADED.proposalId,
        capture_id: 'cap-degraded-1',
        summary: '整理手机端线索清单并完成去重',
        rationale: '意图解析器不可用，按规则模板生成提议；所有动作仍需人工确认。',
        degraded: true,
        degraded_reasons: [
          'intent_interpreter_unavailable:fallback_rule_template',
          'plan_engine_fallback:no_llm_plan',
        ],
        proposed_tasks: [
          {
            task_id: DEGRADED.taskId,
            title: '整理手机端线索清单并合并重复项',
            assignee_id: CURRENT_ACTOR_ID,
            assignee_kind: 'human',
            criteria: copyCriteria(DEGRADED_CRITERIA),
          },
        ],
      },
    });
  }

  // --------------------------------------------------------------------------
  // Capture / 提议
  // --------------------------------------------------------------------------

  capture(text: string): CaptureResponse {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw badRequest('capture.text 必须是非空字符串');
    }
    if (text.length > 2000) throw badRequest('capture.text 超过 2000 字符上限');

    const captureId = `cap-${randomUUID()}`;
    const proposalId = `prop-${randomUUID()}`;
    const taskId = `task-${randomUUID()}`;
    const degraded = /\[degraded\]|降级/i.test(text);
    const reasons = degraded
      ? ['capture_marked_degraded', 'intent_interpreter_unavailable:fallback_rule_template']
      : [];
    const title = `整理并提交：${text.trim().slice(0, 48)}`;

    this.emit({
      type: 'FeedbackReceived',
      kind: 'feedback.captured',
      project_id: DEMO.projectId,
      entity_id: captureId,
      summary: `捕获输入：${text.trim().slice(0, 40)}`,
      degraded,
      payload: { capture_id: captureId, text: text.trim() },
    });
    this.emit({
      type: 'PlanChangeProposed',
      kind: 'proposal.created',
      project_id: DEMO.projectId,
      entity_id: proposalId,
      summary: `智能层产出提议：${title}`,
      degraded,
      payload: {
        proposal_id: proposalId,
        capture_id: captureId,
        summary: title,
        rationale: degraded
          ? '智能层不可用，按规则模板产出提议；提议可接受但标记 degraded。'
          : '把输入收敛为一条可验收任务，交由当前用户完成并逐判据验收。',
        degraded,
        degraded_reasons: reasons,
        proposed_tasks: [
          {
            task_id: taskId,
            title,
            assignee_id: CURRENT_ACTOR_ID,
            assignee_kind: 'human',
            criteria: copyCriteria(DEFAULT_CRITERIA),
          },
        ],
      },
    });

    return { capture_id: captureId, proposal_id: proposalId, projection_version: this.head };
  }

  // --------------------------------------------------------------------------
  // 命令（统一入口，available_actions 复核 + client_submit_id 幂等）
  // --------------------------------------------------------------------------

  executeCommand(input: ExecuteCommandInput, actorId = CURRENT_ACTOR_ID): CommandResponse {
    if (typeof input.client_submit_id !== 'string' || input.client_submit_id.length === 0) {
      throw badRequest('client_submit_id 必填（幂等键）');
    }
    if (typeof input.type !== 'string' || input.type.length === 0) {
      throw badRequest('命令 type 必填');
    }
    const fingerprint = JSON.stringify({ type: input.type, payload: input.payload });
    const existing = this.receipts.get(input.client_submit_id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ApiError(409, 'idempotency_conflict', '同一 client_submit_id 被用于不同命令内容', {
          details: { client_submit_id: input.client_submit_id },
        });
      }
      return {
        receipt: { ...existing.body.receipt, duplicate: true },
        projection_version: existing.body.projection_version,
      };
    }

    if (!(COMMAND_TYPES as readonly string[]).includes(input.type)) {
      throw badRequest(`未知命令 type=${input.type}`, { allowed_types: [...COMMAND_TYPES] });
    }
    const type = input.type as CommandType;
    let emitted: EventRecord[];
    switch (type) {
      case 'accept_proposal':
        emitted = this.acceptProposal(String(input.payload.proposal_id ?? ''), actorId);
        break;
      case 'reject_proposal':
        emitted = this.rejectProposal(
          String(input.payload.proposal_id ?? ''),
          String(input.payload.reason ?? '用户拒绝提议'),
        );
        break;
      case 'complete_task':
        emitted = this.completeTask(String(input.payload.task_id ?? ''), actorId);
        break;
      case 'record_acceptance':
        emitted = this.recordAcceptance(input.payload, actorId);
        break;
      default:
        throw badRequest(`未实现的命令 type=${type}`);
    }

    const body: CommandResponse = {
      receipt: {
        client_submit_id: input.client_submit_id,
        command_type: type,
        accepted_at: new Date().toISOString(),
        seq: emitted.length > 0 ? emitted[emitted.length - 1].seq : this.head,
        projection_version: this.head,
        duplicate: false,
      },
      projection_version: this.head,
    };
    this.receipts.set(input.client_submit_id, { fingerprint, body });
    return { receipt: { ...body.receipt }, projection_version: body.projection_version };
  }

  private acceptProposal(proposalId: string, actorId: string): EventRecord[] {
    const proposal = this.requireProposal(proposalId);
    const actions = proposeActionsFor(proposal);
    if (proposal.status !== 'proposed') {
      throw terminalState(`提议 ${proposalId} 已是 ${proposal.status}，不可再次接受`);
    }
    if (!actions.includes('accept_proposal')) {
      throw forbidden('当前 actor 不可接受该提议：available_actions 不含 accept_proposal', actions);
    }
    if (proposal.proposed_tasks.length === 0) {
      throw badRequest('提议没有可落地的任务');
    }
    const project = this.projects.get(proposal.project_id);
    if (!project) throw notFound(`Project ${proposal.project_id} 不存在`);

    const nextRev = project.plan_rev + 1;
    const emitted: EventRecord[] = [];
    emitted.push(
      this.emit({
        type: 'PlanChangeApplied',
        kind: 'proposal.accepted',
        project_id: proposal.project_id,
        entity_id: proposal.proposal_id,
        summary: `提议已接受：${proposal.summary}`,
        degraded: proposal.degraded,
        payload: {
          proposal_id: proposal.proposal_id,
          accepted_by: actorId,
          plan_rev: nextRev,
          degraded: proposal.degraded,
        },
      }),
    );
    for (const proposed of proposal.proposed_tasks) {
      emitted.push(
        this.emit({
          type: 'TaskCaptured',
          kind: 'task.created',
          project_id: proposal.project_id,
          entity_id: proposed.task_id,
          summary: `任务生成：${proposed.title}`,
          degraded: proposal.degraded,
          payload: {
            task_id: proposed.task_id,
            title: proposed.title,
            assignee_id: proposed.assignee_id,
            assignee_kind: proposed.assignee_kind,
            contract_rev: 1,
            criteria: copyCriteria(proposed.criteria),
            created_from_proposal: proposal.proposal_id,
            degraded: proposal.degraded,
          },
        }),
      );
    }
    emitted.push(
      this.emit({
        type: 'PlanRevisionCreated',
        kind: 'plan.revised',
        project_id: proposal.project_id,
        entity_id: proposal.proposal_id,
        summary: `计划修订 rev=${nextRev}`,
        degraded: proposal.degraded,
        payload: { plan_rev: nextRev },
      }),
    );
    const goalEvent = this.syncGoalStatus(proposal.project_id);
    if (goalEvent) emitted.push(goalEvent);
    return emitted;
  }

  private rejectProposal(proposalId: string, reason: string): EventRecord[] {
    const proposal = this.requireProposal(proposalId);
    const actions = proposeActionsFor(proposal);
    if (proposal.status !== 'proposed') {
      throw terminalState(`提议 ${proposalId} 已是 ${proposal.status}，不可再次拒绝`);
    }
    if (!actions.includes('reject_proposal')) {
      throw forbidden('当前 actor 不可拒绝该提议：available_actions 不含 reject_proposal', actions);
    }
    return [
      this.emit({
        type: 'PlanChangeRejected',
        kind: 'proposal.rejected',
        project_id: proposal.project_id,
        entity_id: proposal.proposal_id,
        summary: `提议已拒绝：${reason}`,
        degraded: proposal.degraded,
        payload: { proposal_id: proposal.proposal_id, reason },
      }),
    ];
  }

  private completeTask(taskId: string, actorId: string): EventRecord[] {
    const task = this.tasks.get(taskId);
    if (!task) throw notFound(`Task ${taskId} 不存在`);
    if (TERMINAL_LIFECYCLES.has(task.lifecycle)) {
      throw terminalState(`Task ${taskId} 已是终态 ${task.lifecycle}`);
    }
    const actions = availableActionsFor(task, actorId);
    if (!actions.includes('complete_task')) {
      throw forbidden(
        `当前 actor 不可完成 Task ${taskId}：available_actions=${JSON.stringify(actions)}`,
        actions,
      );
    }
    const outcomeId = `out-${randomUUID()}`;
    const emitted: EventRecord[] = [];
    emitted.push(
      this.emit({
        type: 'OutcomeRecorded',
        kind: 'task.outcome_recorded',
        project_id: task.project_id,
        entity_id: task.task_id,
        summary: `任务产出已入账：${task.title}`,
        degraded: task.degraded,
        payload: {
          outcome_id: outcomeId,
          task_id: task.task_id,
          conclusion_kind: 'achieved',
          recorded_by: actorId,
        },
      }),
    );
    emitted.push(
      this.emit({
        type: 'TaskLifecycleChanged',
        kind: 'task.awaiting_acceptance',
        project_id: task.project_id,
        entity_id: task.task_id,
        summary: `任务完成，等待验收：${task.title}`,
        degraded: task.degraded,
        payload: { task_id: task.task_id, from: task.lifecycle, to: 'awaiting_acceptance' },
      }),
    );
    const goalEvent = this.syncGoalStatus(task.project_id);
    if (goalEvent) emitted.push(goalEvent);
    return emitted;
  }

  private recordAcceptance(payload: Record<string, unknown>, actorId: string): EventRecord[] {
    const taskId = String(payload.task_id ?? '');
    const task = this.tasks.get(taskId);
    if (!task) throw notFound(`Task ${taskId} 不存在`);
    if (task.lifecycle !== 'awaiting_acceptance') {
      throw terminalState(`Task ${taskId} 当前 ${task.lifecycle}，不在 awaiting_acceptance，不能验收`);
    }
    const actions = availableActionsFor(task, actorId);
    if (!actions.includes('record_acceptance')) {
      throw forbidden(
        `当前 actor 不可验收 Task ${taskId}：available_actions=${JSON.stringify(actions)}`,
        actions,
      );
    }

    const rawResults = payload.criterion_results;
    if (!Array.isArray(rawResults) || rawResults.length === 0) {
      throw badRequest('record_acceptance.criterion_results 必须是非空数组');
    }
    const results: CriterionResult[] = [];
    for (const raw of rawResults as Record<string, unknown>[]) {
      const ref = String(raw.criterion_ref ?? '');
      const verdict = String(raw.verdict ?? '');
      if (verdict !== 'passed' && verdict !== 'failed') {
        throw badRequest(`criterion ${ref} 的 verdict 必须是 passed/failed`);
      }
      const evidence = Array.isArray(raw.evidence_refs) ? raw.evidence_refs.map(String) : [];
      results.push({ criterion_ref: ref, verdict, evidence_refs: evidence });
    }

    const expectedRefs = task.criteria.map((criterion) => criterion.criterion_ref);
    const reportedRefs = results.map((result) => result.criterion_ref);
    const duplicateRefs = reportedRefs.filter((ref, index) => reportedRefs.indexOf(ref) !== index);
    if (duplicateRefs.length > 0) {
      throw new ApiError(409, 'duplicate_criterion_ref', `判据重复提交：${duplicateRefs.join(',')}`, {
        details: { duplicate_refs: duplicateRefs },
      });
    }
    const missing = expectedRefs.filter((ref) => !reportedRefs.includes(ref));
    if (missing.length > 0) {
      throw new ApiError(409, 'coverage_incomplete', `验收缺判据：${missing.join(',')}`, {
        details: { pending_criteria: missing },
      });
    }
    const unknown = reportedRefs.filter((ref) => !expectedRefs.includes(ref));
    if (unknown.length > 0) {
      throw new ApiError(409, 'criterion_ref_unknown', `未知判据：${unknown.join(',')}`, {
        details: { unknown_refs: unknown },
      });
    }

    const verdict = computeVerdict(results);
    const acceptanceId = `acc-${randomUUID()}`;
    const emitted: EventRecord[] = [];
    emitted.push(
      this.emit({
        type: 'AcceptanceRecorded',
        kind: 'acceptance.recorded',
        project_id: task.project_id,
        entity_id: task.task_id,
        summary: `验收 ${verdict}：${task.title}`,
        degraded: task.degraded,
        payload: {
          acceptance_id: acceptanceId,
          task_id: task.task_id,
          verdict,
          criterion_results: results,
          rationale: String(payload.rationale ?? ''),
          acceptor_id: actorId,
        },
      }),
    );

    const targetLifecycle =
      verdict === 'accepted' ? 'accepted' : verdict === 'rejected' ? 'defined' : 'awaiting_acceptance';
    if (targetLifecycle !== task.lifecycle) {
      emitted.push(
        this.emit({
          type: 'TaskLifecycleChanged',
          kind: targetLifecycle === 'accepted' ? 'task.accepted' : 'task.reopened',
          project_id: task.project_id,
          entity_id: task.task_id,
          summary:
            targetLifecycle === 'accepted'
              ? `任务验收通过：${task.title}`
              : `任务验收未通过，回到 ${targetLifecycle}：${task.title}`,
          degraded: task.degraded,
          payload: { task_id: task.task_id, from: task.lifecycle, to: targetLifecycle },
        }),
      );
    }
    const goalEvent = this.syncGoalStatus(task.project_id);
    if (goalEvent) emitted.push(goalEvent);
    return emitted;
  }

  /** 任务集变化后重算 goal.status；只有变化时才追加 GoalStatusChanged。 */
  private syncGoalStatus(projectId: string): EventRecord | null {
    const project = this.projects.get(projectId);
    if (!project) return null;
    const active = [...this.tasks.values()].filter(
      (task) => task.project_id === projectId && task.lifecycle !== 'canceled',
    );
    const accepted = active.filter((task) => task.lifecycle === 'accepted').length;
    const next =
      active.length === 0 ? 'draft' : accepted === active.length ? 'achieved' : 'in_progress';
    if (next === project.goal_status) return null;
    return this.emit({
      type: 'GoalStatusChanged',
      kind: 'goal.status_changed',
      project_id: projectId,
      entity_id: project.goal_id,
      summary: `目标状态：${project.goal_status} → ${next}`,
      payload: { status: next, accepted_tasks: accepted, active_tasks: active.length },
    });
  }

  private requireProposal(proposalId: string): ProposalRecord {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw notFound(`Proposal ${proposalId} 不存在`);
    return proposal;
  }

  // --------------------------------------------------------------------------
  // 投影
  // --------------------------------------------------------------------------

  proposalProjection(proposalId: string): ProposalProjection {
    const proposal = this.requireProposal(proposalId);
    return {
      projection_version: this.head,
      proposal_id: proposal.proposal_id,
      project_id: proposal.project_id,
      capture_id: proposal.capture_id,
      status: proposal.status,
      degraded: proposal.degraded,
      degraded_reasons: [...proposal.degraded_reasons],
      summary: proposal.summary,
      rationale: proposal.rationale,
      proposed_tasks: copyProposedTasks(proposal.proposed_tasks),
      available_actions: proposeActionsFor(proposal),
      created_at: proposal.created_at,
      decided_at: proposal.decided_at,
    };
  }

  projectProjection(projectId: string, actorId = CURRENT_ACTOR_ID): ProjectProjection {
    const project = this.projects.get(projectId);
    if (!project) throw notFound(`Project ${projectId} 不存在`);
    const tasks = [...this.tasks.values()]
      .filter((task) => task.project_id === projectId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.task_id.localeCompare(b.task_id));

    const active = tasks.filter((task) => task.lifecycle !== 'canceled');
    const accepted = active.filter((task) => task.lifecycle === 'accepted');
    const awaiting = active.filter((task) => task.lifecycle === 'awaiting_acceptance');
    const partial = active.filter(
      (task) => task.last_acceptance?.verdict === 'partially_accepted' && task.lifecycle === 'awaiting_acceptance',
    );
    let status: ProjectProjection['acceptance']['status'];
    if (active.length === 0) status = 'not_started';
    else if (accepted.length === active.length) status = 'accepted';
    else if (partial.length > 0) status = 'partially_accepted';
    else if (accepted.length > 0) status = 'in_progress';
    else if (awaiting.length > 0) status = 'pending';
    else status = 'not_started';

    const pendingCriteria: { task_id: string; criterion_ref: string }[] = [];
    for (const task of active) {
      for (const result of task.criterion_results) {
        if (result.verdict === 'failed') {
          pendingCriteria.push({ task_id: task.task_id, criterion_ref: result.criterion_ref });
        }
      }
    }

    let latestAcceptance: ProjectProjection['acceptance']['last_acceptance'] = null;
    let latestSeq = -1;
    for (const task of tasks) {
      if (task.last_acceptance && task.acceptance_seq > latestSeq) {
        latestSeq = task.acceptance_seq;
        latestAcceptance = {
          acceptance_id: task.last_acceptance.acceptance_id,
          task_id: task.task_id,
          verdict: task.last_acceptance.verdict,
          recorded_at: task.last_acceptance.recorded_at,
        };
      }
    }

    const nodes: ProjectTaskNode[] = tasks.map((task) => ({
      task_id: task.task_id,
      title: task.title,
      lifecycle: task.lifecycle,
      wait_state: task.wait_state,
      intended_assignee_id: task.intended_assignee_id,
      assignee_kind: task.assignee_kind,
      current_contract_rev: task.current_contract_rev,
      criteria: copyCriteria(task.criteria),
      criterion_results: task.criterion_results.map((result) => ({
        ...result,
        evidence_refs: [...result.evidence_refs],
      })),
      available_actions: availableActionsFor(task, actorId),
      degraded: task.degraded,
      created_from_proposal: task.created_from_proposal,
      outcome: task.outcome ? { ...task.outcome } : null,
      last_acceptance: task.last_acceptance ? { ...task.last_acceptance } : null,
    }));

    return {
      projection_version: this.head,
      project_id: project.project_id,
      title: project.title,
      plan_rev: project.plan_rev,
      goal: { goal_id: project.goal_id, text: project.goal_text, status: project.goal_status },
      task_graph: { nodes, edges: [] },
      acceptance: {
        status,
        accepted_tasks: accepted.length,
        active_tasks: active.length,
        total_tasks: tasks.length,
        canceled_tasks: tasks.length - active.length,
        awaiting_tasks: awaiting.length,
        pending_criteria: pendingCriteria,
        last_acceptance: latestAcceptance,
      },
      provenance: {
        degraded_proposals: [...this.proposals.values()].filter(
          (proposal) => proposal.project_id === projectId && proposal.degraded,
        ).length,
        degraded_tasks: tasks.filter((task) => task.degraded).length,
      },
    };
  }

  actionsProjection(actorId = CURRENT_ACTOR_ID): ActionsProjection {
    const rows: ActionRow[] = [];
    for (const task of [...this.tasks.values()].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      const available = availableActionsFor(task, actorId);
      if (available.length === 0) continue;
      rows.push({
        action_id: `act-${task.task_id}`,
        project_id: task.project_id,
        task_id: task.task_id,
        title: task.title,
        lifecycle: task.lifecycle,
        available_actions: available,
        blocked_reasons: [],
        pending_criteria: task.criterion_results
          .filter((result) => result.verdict === 'failed')
          .map((result) => result.criterion_ref),
        degraded: task.degraded,
      });
    }
    return { projection_version: this.head, actor_id: actorId, actions: rows };
  }

  homeProjection(actorId = CURRENT_ACTOR_ID): HomeProjection {
    const allActions = this.actionsProjection(actorId).actions;
    const projects = [...this.projects.values()].map((project) => {
      const projection = this.projectProjection(project.project_id, actorId);
      return {
        project_id: project.project_id,
        title: project.title,
        goal_text: project.goal_text,
        goal_status: project.goal_status,
        task_summary: {
          active_tasks: projection.acceptance.active_tasks,
          accepted_tasks: projection.acceptance.accepted_tasks,
          awaiting_acceptance: projection.acceptance.awaiting_tasks,
          canceled_tasks: projection.acceptance.canceled_tasks,
        },
        acceptance_status: projection.acceptance.status,
        pending_actions_count: allActions.filter((row) => row.project_id === project.project_id).length,
        degraded: projection.provenance.degraded_proposals > 0,
        updated_at: project.updated_at,
      };
    });
    return {
      projection_version: this.head,
      pending_actions_count: allActions.length,
      projects,
      recent_activity: this.events
        .filter((event) => event.type !== 'DevBurstRecorded')
        .slice(-12)
        .reverse()
        .map((event) => ({
          seq: event.seq,
          kind: event.kind,
          type: event.type,
          project_id: event.project_id,
          summary: event.summary,
          degraded: event.degraded,
          occurred_at: event.occurred_at,
        })),
    };
  }

  // --------------------------------------------------------------------------
  // SSE / 测试仪表
  // --------------------------------------------------------------------------

  streamFrame(event: EventRecord): StreamEventFrame {
    return {
      seq: event.seq,
      kind: event.kind,
      type: event.type,
      project_id: event.project_id,
      entity_id: event.entity_id,
      summary: event.summary,
      degraded: event.degraded,
      occurred_at: event.occurred_at,
    };
  }

  /** mock-only：制造一段连续事件，用于背压/慢消费者测试。 */
  emitBurst(count: number, projectId = DEMO.projectId): number {
    const capped = Math.max(1, Math.min(count, 5000));
    for (let i = 0; i < capped; i += 1) {
      this.emit({
        type: 'DevBurstRecorded',
        kind: 'dev.burst',
        project_id: projectId,
        entity_id: `burst-${this.head + 1}`,
        summary: `背压测试事件 #${i + 1}`,
        payload: { index: i },
      });
    }
    return capped;
  }
}
