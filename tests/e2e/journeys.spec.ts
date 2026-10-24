import { expect, test } from '@playwright/test';

// ============================================================================
// D9 质量门 · 旅程即测试（Web UI 版骨架，v0）
//
// 现状：Web UI 尚未实现（K0 本波只做到内核/API 级）。同一份旅程已在
//   tests/journey/d8-full-journey.test.ts 里以真 PostgreSQL 事件流跑通（该文件 51 例；连同 guardrails 25 例、projection-consistency 13 例，三件套共 89 例），
// 本文件把同样的步骤落到浏览器上，全部 test.skip，等 UI 到位后逐条启用。
//
// 启用条件（三条同时满足才解除 skip，见 README.md 的映射表）：
//   E1 前端路由可用：Capture 页 / Project 页 / Task 详情 / MyActions 验收面板
//      由 src/web 或独立前端仓提供，且 npm run web:serve 能在 CI 里起来；
//   E2 后端 API 面可用：capture / plan-changes / assignments / runs / feedback /
//      acceptance 六组写入口已实现（内核 appendStateTransition 之上的 HTTP 层，
//      目前 src/ 只有内核，没有 HTTP 面）；
//   E3 稳定测试锚点：上述界面按 data-testid 命名契约打点（见文件末尾 TESTID）。
//   满足后：设 XUXING_E2E_UI=1 运行本文件，并把对应 test.skip 条件删掉。
//
// 纪律：本骨架不假装能跑。每条 test 的断言意图写清楚（与 tests/journey 的事件流
//       断言一一对应），locator 用命名契约占位；启用前不允许改成 expect(true)。
// ============================================================================

const UI_READY = process.env.XUXING_E2E_UI === '1';
const PROJECT_ID = process.env.XUXING_E2E_PROJECT ?? 'proj-d8';

test.describe.configure({ mode: 'serial' });

test.describe('D8 完整旅程（浏览器级）：Capture → 计划 → 派活 → 反馈 → 产出 → 验收', () => {
  test('① Capture：一句话目标入图，页面回显 Task 卡', async ({ page }) => {
    test.skip(!UI_READY, 'E1/E2/E3 未就绪：Capture 页与 capture API 未实现');
    await page.goto(`/capture`);
    await page.getByTestId(TESTID.captureInput).fill(
      '帮我把上次 nx-pipeline 那轮 run 导进续行，看看双轨对照能不能跑通',
    );
    await page.getByTestId(TESTID.captureSubmit).click();

    // 断言意图（内核级等价：ProjectCreated + GoalCreated + TaskCaptured，seq 1..3）
    await expect(page.getByTestId(TESTID.capturedTaskCard)).toHaveCount(1);
    await expect(page.getByTestId(TESTID.taskLifecycle)).toHaveText('captured');
    // 幂等：重复点提交不得产生第二张卡（INV-13 / C2）
    await page.getByTestId(TESTID.captureSubmit).click();
    await expect(page.getByTestId(TESTID.capturedTaskCard)).toHaveCount(1);
  });

  test('② 计划：草稿呈现 → 人批准 → 计划生效（REQ-PC-1..5）', async ({ page }) => {
    test.skip(!UI_READY, 'E1/E2/E3 未就绪：PlanChange 审批面板未实现');
    await page.goto(`/projects/${PROJECT_ID}/plan/draft`);
    await expect(page.getByTestId(TESTID.planOpRow)).not.toHaveCount(0);
    await page.getByTestId(TESTID.planApprove).click();

    // 断言意图：PlanChangeProposed → PlanChangeApplied → n×TaskCaptured/EdgeAdded → PlanRevisionCreated
    //          rev 单调 +1，且恰有一条 Revision（REQ-PC-2 原子性）；
    //          结构错误类负例在 UI 上必须显式列出原因码（schema_invalid/dag_cycle…），
    //          越权提议转 Decision（REQ-PC-3/5），陈旧 base 报 base_rev_conflict + 三方差异（C3）。
    await expect(page.getByTestId(TESTID.planRevision)).toHaveText('1');
    await expect(page.getByTestId(TESTID.rejectedReason)).toHaveCount(0);
  });

  test('③ 派活给代码 Agent：Assignment → Run 走到 running', async ({ page, request }) => {
    test.skip(!UI_READY, 'E1/E2/E3 未就绪：派活按钮与 Run 详情页未实现');
    await page.goto(`/projects/${PROJECT_ID}/tasks/import`);
    await page.getByTestId(TESTID.assignExecutor).click();
    await expect(page.getByTestId(TESTID.taskLifecycle)).toHaveText('active');

    // 断言意图：ready→active 迁移事件 + RunCreated/Queued/Leased/Started；
    //          Run 详情显示 lease_ttl=45s、side_effect_level=L1、contract_rev 钉在派发值。
    const runRow = page.getByTestId(TESTID.runRow).first();
    await expect(runRow).toContainText('running');
    const detail = await request.get(`/api/runs/import-run-1`);
    expect((await detail.json()).input_snapshot.assembled_by).toBe('kernel-context-assembler');
  });

  test('④ 人类反馈：原文入账 + 解析解耦，重复投递只算一次（REQ-FB-1/DD-1/C2）', async ({ page }) => {
    test.skip(!UI_READY, 'E1/E2/E3 未就绪：Run 详情反馈框未实现');
    await page.goto(`/projects/${PROJECT_ID}/runs/import-run-1`);
    const box = page.getByTestId(TESTID.feedbackInput);
    await box.fill('端到端跑通了，但无法映射字段还没给清单');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.getByTestId(TESTID.feedbackSubmit).click(); // 同一 client_submit_id
    }
    // 断言意图：FeedbackReceived 恰 1 条 → FeedbackInterpreted 1 条 → 有绑定 Run 才可能出 Outcome
    await expect(page.getByTestId(TESTID.feedbackCard)).toHaveCount(1);
    await expect(page.getByTestId(TESTID.feedbackStatus)).toHaveText('interpreted');
    // 游离 Feedback（未绑定 Run）不生成 Outcome：新 P1-3
    await expect(page.getByTestId(TESTID.outcomeCard)).toHaveCount(0);
  });

  test('⑤ 产出：Outcome 入账 → Run succeeded → Task awaiting_acceptance', async ({ page }) => {
    test.skip(!UI_READY, 'E1/E2/E3 未就绪：Outcome 面板未实现');
    await page.goto(`/projects/${PROJECT_ID}/runs/import-run-1`);
    // 断言意图：四分关系（G3 试金石）——Run=succeeded、Outcome.conclusion_kind=partial、
    //          Task=awaiting_acceptance 三者同时成立；Executor 直写 Outcome 的入口在 UI 上不存在。
    await expect(page.getByTestId(TESTID.runState)).toHaveText('succeeded');
    await expect(page.getByTestId(TESTID.outcomeConclusion)).toHaveText('partial');
    await expect(page.getByTestId(TESTID.taskLifecycle)).toHaveText('awaiting_acceptance');
  });

  test('⑥ 验收：判据逐项打点 → partially_accepted 留待补集 → 补集后 accepted（REQ-ACC-1..4 / S4）', async ({
    page,
  }) => {
    test.skip(!UI_READY, 'E1/E2/E3 未就绪：验收面板与判据打点未实现');
    await page.goto(`/projects/${PROJECT_ID}/tasks/import/acceptance`);
    await page.getByTestId(TESTID.criterionPass(D8_CRITERION_ROUNDTRIP)).click();
    await page.getByTestId(TESTID.criterionFail(D8_CRITERION_UNMAPPED)).click();
    await page.getByTestId(TESTID.acceptancePartially).click();

    // 断言意图：partially_accepted 不发 lifecycle 事件，Task 仍 awaiting_acceptance，
    //          待补集显示为未过判据（S4）；执行该 Run 的 actor 在 UI 上无验收按钮（REQ-ACC-2/C6）。
    await expect(page.getByTestId(TESTID.taskLifecycle)).toHaveText('awaiting_acceptance');
    await expect(page.getByTestId(TESTID.pendingCriteria)).toContainText(D8_CRITERION_UNMAPPED);
    await expect(page.getByTestId(TESTID.acceptanceSubmit)).toHaveCount(0);

    // 补集：第二次 Feedback → 新 Outcome（supersedes）→ 新 Acceptance=accepted
    await page.getByTestId(TESTID.acceptanceAccepted).click();
    // INV-11：终态迁移同事务收尾 —— UI 上三件事必须同时可见，不允许「已验收但仍在等人」
    await expect(page.getByTestId(TESTID.taskLifecycle)).toHaveText('accepted');
    await expect(page.getByTestId(TESTID.waitConditionActive)).toHaveCount(0);
    await expect(page.getByTestId(TESTID.goalStatus)).toHaveText('achieved');
    // REQ-SCH-1/ACC-1：下游 report 因上游 accepted 而 ready（跨 rev 有效）
    await page.goto(`/projects/${PROJECT_ID}/tasks/report`);
    await expect(page.getByTestId(TESTID.taskLifecycle)).toHaveText('ready');
  });

  test('⑦ 人在环轻执行路径（human_light）：G1 的等待与跟进唯一化', async ({ page }) => {
    test.skip(!UI_READY, 'E1/E2/E3 未就绪；另需先解掉 FINDING D9-J2（§3.2 无 created→running 格）');
    await page.goto(`/projects/${PROJECT_ID}/my-actions`);
    await expect(page.getByTestId(TESTID.myActionsRow)).not.toHaveCount(0);
    // 断言意图（G1）：add_wait + add_task + add_edge 一次 PlanChange 完成；
    //          wait_state=waiting_on_person，恰一个 active WaitCondition，
    //          其 followup_task_id 指向恰一个跟进 Task（REQ-HUM-3 / INV-10）。
    await expect(page.getByTestId(TESTID.followupTaskLink)).toHaveCount(1);
  });
});

test.describe('混沌与不变量（UI 侧观察面，对应 §8.2 C1–C6）', () => {
  test('C1/C1b 租约过期分界在 Run 列表上可读', async () => {
    test.skip(!UI_READY, 'E1/E2/E3 未就绪：需要 Executor 侧杀进程的测试钩子');
    // 断言意图：已启动+L2/L3 → indeterminate → 对账 → failed(reconciled_not_executed)；
    //          仅 leased 未启动 → 回 queued，不进 indeterminate。
  });

  test('C4 WaitCondition 到期跨重启仍触发', async () => {
    test.skip(!UI_READY, 'E1/E2/E3 未就绪：需要内核重启钩子与 Timer 事件读取面');
  });

  test('C5 投影重建后页面数据不变', async ({ page }) => {
    test.skip(!UI_READY, 'E1/E2/E3 未就绪：需要投影重建管理入口');
    const before = await page.locator('body').innerText();
    await page.getByTestId(TESTID.rebuildProjection).click();
    await expect(page.locator('body')).toHaveText(before);
  });
});

/** data-testid 命名契约：前端实现按此打点，届时只改本常量表。 */
const TESTID = {
  captureInput: 'capture-input',
  captureSubmit: 'capture-submit',
  capturedTaskCard: 'captured-task-card',
  taskLifecycle: 'task-lifecycle',
  planOpRow: 'plan-op-row',
  planApprove: 'plan-approve',
  planRevision: 'plan-revision',
  rejectedReason: 'plan-rejected-reason',
  assignExecutor: 'assign-executor',
  runRow: 'run-row',
  runState: 'run-state',
  feedbackInput: 'feedback-input',
  feedbackSubmit: 'feedback-submit',
  feedbackCard: 'feedback-card',
  feedbackStatus: 'feedback-status',
  outcomeCard: 'outcome-card',
  outcomeConclusion: 'outcome-conclusion',
  criterionPass: (ref: string) => `criterion-pass-${ref}`,
  criterionFail: (ref: string) => `criterion-fail-${ref}`,
  acceptancePartially: 'acceptance-partially',
  acceptanceAccepted: 'acceptance-accepted',
  acceptanceSubmit: 'acceptance-submit',
  pendingCriteria: 'acceptance-pending-criteria',
  waitConditionActive: 'wait-condition-active',
  goalStatus: 'goal-status',
  myActionsRow: 'my-actions-row',
  followupTaskLink: 'followup-task-link',
  rebuildProjection: 'admin-rebuild-projection',
} as const;

// 与 tests/journey/support/journey-script.ts 的判据 id 对齐（UI 打点用同一对象 id）
const D8_CRITERION_ROUNDTRIP = 'c-roundtrip:auto';
const D8_CRITERION_UNMAPPED = 'c-unmapped-list';
