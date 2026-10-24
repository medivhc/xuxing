// 事件目录 v1 —— 与冻结 spec K0-SPEC v1.0 §4 逐字对应（封闭集，新增类型须走 spec 修订）。
// 本文件由 spec §4 目录生成，勿手工增删类型名。

export const EVENT_TYPES = [
  'ProjectCreated',
  'GoalCreated',
  'TaskCaptured',
  'TaskDefined',
  'ContractUpdated',
  'EdgeAdded',
  'EdgeRemoved',
  'PlanChangeProposed',
  'PlanChangeApplied',
  'PlanChangeRejected',
  'PlanRevisionCreated',
  'AssignmentCreated',
  'AssignmentEnded',
  'RunCreated',
  'RunQueued',
  'RunLeased',
  'RunStarted',
  'RunRawResultReceived',
  'RunSucceeded',
  'RunFailed',
  'RunCanceled',
  'RunTimedOut',
  'RunIndeterminate',
  'RunReconciled',
  'FeedbackReceived',
  'FeedbackInterpreted',
  'OutcomeRecorded',
  'EvidenceAdded',
  'EvidenceSuperseded',
  'AcceptanceRecorded',
  'AcceptanceSuperseded',
  'WaitConditionCreated',
  'WaitConditionSatisfied',
  'WaitConditionExpired',
  'DecisionCreated',
  'DecisionResolved',
  'DecisionExpired',
  'PolicyUpdated',
  'TimerFired',
  'ProjectionRebuilt',
  'GoalStatusChanged',
  'TaskLifecycleChanged',
  'TaskWaitStateChanged',
  'TaskCancelRequested',
  'TaskCanceled',
  'TaskDuplicateSuspected',
  'TaskDuplicateResolved',
  'ReleaseOverrideSet',
  'ReleaseOverrideInvalidated',
  'PlanChangeStatusChanged',
  'WaitConditionCanceled',
  'FeedbackInterpretationFailed',
  'LatestAcceptedPointerMoved',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type ActorKind = 'human' | 'agent' | 'system' | 'external';

declare const projectIdBrand: unique symbol;

/**
 * §4 / INV-12：事件流恒为 Project，stream_id === project_id。
 * 品牌类型把「Project id」与 task_id / run_id 等主体 id 在编译期区分开，
 * 防止把主体 id 误当 stream_id 传入。
 */
export type ProjectId = string & { readonly [projectIdBrand]: 'ProjectId' };

/** 运行时构造 ProjectId：拒绝空串/纯空白（存在性由 ProjectCreated 事实与写入流保证）。 */
export function asProjectId(value: string): ProjectId {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('stream_id 必须是非空 project_id（spec §4 / INV-12）');
  }
  return value as ProjectId;
}

/** 事件信封（spec §4）：stream = Project（stream_id = project_id），global_seq 为跨 stream 全序锚点（INV-12）。 */
export interface EventEnvelope<P = unknown> {
  id: string; // ULID
  stream_id: ProjectId; // project_id（§4 / INV-12：stream = Project）
  seq: number; // 流内序号，严格递增
  global_seq: number; // 全局单调序号，投影按此重演
  type: EventType;
  actor_id: string;
  actor_kind: ActorKind;
  causation_id: string | null;
  correlation_id: string;
  idempotency_key: string | null;
  payload: P;
  prev_hash: string;
  hash: string;
  occurred_at: string; // UTC ISO-8601
  recorded_at: string;
}
