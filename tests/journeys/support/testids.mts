// UI 测试锚点命名契约（与 mock/public/app.js 的 data-testid 一一对应）。
//
// 这套名字尽量沿用 tests/e2e/journeys.spec.ts 末尾的 TESTID 骨架：
// capture-input / capture-submit / task-lifecycle / goal-status /
// my-actions-row / criterion-pass-* / criterion-fail-* / acceptance-submit /
// pending-criteria 等；新增的提案与 degraded 锚点在此登记。

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
  actionCompleteTask: 'action-complete-task',
  actionOpenAcceptance: 'action-open-acceptance',
  actionDegraded: 'action-degraded',
  actionsEmpty: 'actions-empty',

  taskRow: 'task-row',
  taskTitle: 'task-title',
  taskLifecycle: 'task-lifecycle',
  taskDegraded: 'task-degraded',
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
  homeDegraded: 'home-degraded',
  homeActivityItem: 'home-activity-item',

  appError: 'app-error',
} as const;

export const criterionPass = (ref: string): string => `criterion-pass-${ref}`;
export const criterionFail = (ref: string): string => `criterion-fail-${ref}`;

/** 旅程里断言的具体判据 id（与 mock/state.mts 的 DEFAULT_CRITERIA 对齐）。 */
export const DEMO_CRITERIA = {
  importMapped: 'c-import-mapped',
  dualTrackReport: 'c-dual-track-report',
} as const;

export const DEGRADED_CRITERIA = {
  leadsExport: 'c-leads-export',
  leadsDedup: 'c-leads-dedup',
} as const;
