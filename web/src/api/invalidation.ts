// 事件 → 投影失效映射（契约 §1.2「事件 → 投影映射（承重事件）」逐行落成代码）。
// 纪律：收到事件帧后按其影响范围失效相关投影缓存（TanStack Query invalidate）触发重拉；
// 心跳帧（kind='heartbeat'）不失效任何投影。

import type { InvalidationTarget } from './queryKeys';

// 契约 §1.2 映射表（Home / MyActions / Project 三列；Capture 投影在 Web 层由
// P 层传输缓冲 + 提议投影承载，故 Feedback* 类事件失效 home/actions/project）。
const EVENT_TO_TARGETS: Record<string, InvalidationTarget[]> = {
  ProjectCreated: ['home', 'project'],
  GoalCreated: ['home', 'project'],
  GoalStatusChanged: ['home', 'project'],

  TaskCaptured: ['home', 'actions', 'project', 'proposals'],
  TaskDefined: ['actions', 'project'],
  ContractUpdated: ['actions', 'project'],
  TaskLifecycleChanged: ['home', 'actions', 'project'],
  TaskWaitStateChanged: ['home', 'actions', 'project'],
  TaskCancelRequested: ['home', 'actions', 'project', 'proposals'],
  TaskCanceled: ['home', 'actions', 'project', 'proposals'],
  TaskDuplicateSuspected: ['home', 'actions', 'project'],
  TaskDuplicateResolved: ['home', 'actions', 'project'],

  AssignmentCreated: ['actions', 'project'],
  AssignmentEnded: ['actions', 'project'],

  RunCreated: ['actions', 'project'],
  RunStarted: ['actions', 'project'],
  RunSucceeded: ['actions', 'project'],
  RunFailed: ['actions', 'project'],
  RunCanceled: ['actions', 'project'],
  RunTimedOut: ['actions', 'project'],
  RunIndeterminate: ['home', 'actions', 'project'],
  RunReconciled: ['home', 'actions', 'project'],

  FeedbackReceived: ['home', 'actions', 'project'],
  FeedbackInterpreted: ['home', 'actions', 'proposals'],
  FeedbackInterpretationFailed: ['home', 'proposals'],
  OutcomeRecorded: ['home', 'actions', 'project'],

  AcceptanceRecorded: ['home', 'project'],
  AcceptanceSuperseded: ['home', 'project'],

  WaitConditionCreated: ['home', 'actions', 'project'],
  WaitConditionSatisfied: ['home', 'actions', 'project'],
  WaitConditionExpired: ['home', 'actions', 'project'],
  WaitConditionCanceled: ['home', 'actions', 'project'],

  DecisionCreated: ['home', 'actions', 'proposals'],
  DecisionResolved: ['home', 'actions', 'proposals'],
  DecisionExpired: ['home', 'actions', 'proposals'],

  PlanChangeProposed: ['home', 'actions', 'project', 'proposals'],
  PlanChangeApplied: ['home', 'project'],
  PlanChangeRejected: ['home', 'project'],
  PlanChangeStatusChanged: ['home', 'actions', 'proposals'],
  PlanRevisionCreated: ['home', 'project'],

  EdgeAdded: ['project'],
  EdgeRemoved: ['project'],
  ReleaseOverrideSet: ['project'],
  ReleaseOverrideInvalidated: ['project'],
  LatestAcceptedPointerMoved: ['project'],

  // 投影重建：丢弃旧快照并重读（§1.1）
  ProjectionRebuilt: ['all'],
};

/** 未知事件类型按全量失效处理（保守：不漏更新；K0 量级下代价可忽略）。 */
export function invalidationTargetsFor(kind: string): InvalidationTarget[] {
  if (kind === 'heartbeat') return [];
  return EVENT_TO_TARGETS[kind] ?? ['all'];
}
