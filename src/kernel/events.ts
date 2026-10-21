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

/** 事件信封（spec §4）：stream = Project（stream_id = project_id），global_seq 为跨 stream 全序锚点（INV-12）。 */
export interface EventEnvelope<P = unknown> {
  id: string; // ULID
  stream_id: string; // project_id
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
