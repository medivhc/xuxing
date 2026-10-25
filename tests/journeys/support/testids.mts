// UI 测试锚点命名契约（与 mock/public/app.js 的 data-testid 一一对应）。
//
// mock UI 是「投影渲染器」：每个锚点只渲染投影字段。旅程只在 mock 轮断言 UI；
// 真服务轮（JOURNEY_BASE_URL 指向 8787）没有同款 UI，UI 步骤自动跳过，
// 领域断言仍全部走投影接口（见各 spec 的 usingMock 判定）。

export const TID = {
  navHome: 'nav-home',
  navCapture: 'nav-capture',
  navActions: 'nav-actions',

  captureInput: 'capture-input',
  captureSubmit: 'capture-submit',

  proposalPanel: 'proposal-panel',
  proposalStatus: 'proposal-status',
  proposalDegraded: 'proposal-degraded',
  proposalDegradedReasons: 'proposal-degraded-reasons',
  proposalTask: 'proposal-task',
  proposalTaskTitle: 'proposal-task-title',
  proposalCriterion: 'proposal-criterion',
  proposalAccept: 'proposal-accept',
  proposalReject: 'proposal-reject',
  proposalLinkActions: 'proposal-link-actions',

  myActionsRow: 'my-actions-row',
  actionTaskTitle: 'action-task-title',
  actionAdvanceTask: 'action-advance-task',
  actionSubmitFeedback: 'action-submit-feedback',
  actionOpenAcceptance: 'action-open-acceptance',
  actionsEmpty: 'actions-empty',

  taskRow: 'task-row',
  taskTitle: 'task-title',
  taskLifecycle: 'task-lifecycle',
  projectTitle: 'project-title',
  goalStatus: 'goal-status',
  projectAcceptanceStatus: 'project-acceptance-status',
  projectAcceptedCount: 'project-accepted-count',
  projectPendingCriteria: 'project-pending-criteria',
  projectCriterion: 'project-criterion',
  projectOpenAcceptance: 'project-open-acceptance',

  acceptanceSubmit: 'acceptance-submit',
  acceptanceVerdict: 'acceptance-verdict',
  acceptancePendingCriteria: 'acceptance-pending-criteria',
  criterionRow: 'criterion-row',

  homeProjectCard: 'home-project-card',
  homePendingCount: 'home-pending-count',
  homeGoalStatus: 'home-goal-status',
  homeActivityItem: 'home-activity-item',

  appError: 'app-error',
} as const;

export const criterionPass = (ref: string): string => `criterion-pass-${ref}`;
export const criterionFail = (ref: string): string => `criterion-fail-${ref}`;

/**
 * 现场捕获（capture → 提议）生成任务的判据 ref（mock 的确定性提议固定给这两条）。
 *
 * 真服务（magpie 开）由模型自由给 ref（实测 c1/c2/c3），所以旅程的判据断言一律
 * **以提议投影里的 acceptance_criteria 为准**，不假设 ref；这两个常量只用于 mock 轮的
 * UI 点击锚点（mock 提议在 support/testids.mts 里是唯一来源）。
 */
export const JOURNEY_CRITERIA = {
  primary: 'c-journey-1',
  secondary: 'c-journey-2',
} as const;
