import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type {
  CaptureResponse,
  CommandResponse,
} from '../contract.mts';
import { CURRENT_ACTOR_ID, DEMO } from '../journeys.config.mts';
import {
  findTask,
  getActions,
  getHealth,
  getHome,
  getProject,
  getProposal,
  projectSummary,
  waitForProjection,
} from '../support/api.mts';
import { DEMO_CRITERIA, TID, criterionFail, criterionPass } from '../support/testids.mts';

// ============================================================================
// 交付物 1：完整旅程（浏览器 + 投影断言）
//
//   捕获输入 → 智能层提议 → 用户接受 → 生成任务 → 任务进入 My Actions →
//   完成任务 → 逐判据验收（先 partially_accepted 补集，再 accepted）→
//   项目状态更新（goal achieved / acceptance accepted / 待办清零）
//
// 断言口径：
//   - 领域状态一律先读投影接口（home / project / actions / proposal），再断言
//     UI 文本等于投影字段；不读取 mock 内部状态、不根据 DOM 反推领域事实。
//   - 每一步都校验 projection_version 单调不减，证明 UI 看到的是同一条投影游标。
// ============================================================================

test.describe.configure({ mode: 'serial' });

function actionRow(page: Page, taskId: string) {
  return page.locator(`[data-testid="${TID.myActionsRow}"][data-task-id="${taskId}"]`);
}

function projectTaskRow(page: Page, taskId: string) {
  return page.locator(`[data-testid="${TID.taskRow}"][data-task-id="${taskId}"]`);
}

function criterionRow(page: Page, ref: string) {
  return page.locator(`[data-testid="${TID.criterionRow}"][data-criterion-ref="${ref}"]`);
}

function isCommandResponse(url: string, method: string): boolean {
  return method === 'POST' && new URL(url).pathname === '/api/commands';
}

test.describe('D9 完整旅程（Web 车道 C）', () => {
  test('捕获 → 提议 → 接受 → My Actions → 完成 → 逐判据验收 → 项目更新', async ({ page, request }) => {
    const versions: number[] = [];
    let proposalId = '';
    let taskId = '';
    const captureText = `把 nx-pipeline 最近一轮 run 导入续行，跑通双轨对照（旅程 ${randomUUID().slice(0, 8)}）`;

    await test.step('0. 健康检查 + 种子基线（投影）', async () => {
      const health = await getHealth(request);
      expect(health.ok).toBe(true);
      expect(health.limits.heartbeat_ms).toBe(15_000);

      const home = await getHome(request);
      expect(home.projection_version).toBeGreaterThan(0);
      versions.push(home.projection_version);

      const project = await getProject(request, DEMO.projectId);
      versions.push(project.projection_version);
      expect(project.goal.status).toBe('draft');
      expect(project.acceptance.status).toBe('not_started');
      const seedTask = findTask(project, DEMO.canceledTaskId);
      expect(seedTask.lifecycle).toBe('canceled');
      expect(seedTask.available_actions).toEqual([]);

      const actions = await getActions(request);
      expect(actions.actor_id).toBe(CURRENT_ACTOR_ID);
      expect(actions.actions.filter((row) => row.project_id === DEMO.projectId)).toEqual([]);

      await page.goto('/#/home');
      await expect(page.getByTestId(TID.homeProjectCard)).not.toHaveCount(0);
      const card = page.locator(
        `[data-testid="${TID.homeProjectCard}"][data-project-id="${DEMO.projectId}"]`,
      );
      await expect(card.getByTestId(TID.homeGoalStatus)).toHaveText(project.goal.status);
    });

    await test.step('1. Capture：一句话输入 → feedback.captured + 智能层提议', async () => {
      await page.goto('/#/capture');
      await page.getByTestId(TID.captureInput).fill(captureText);

      const [captureResponse] = await Promise.all([
        page.waitForResponse(
          (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/capture',
        ),
        page.getByTestId(TID.captureSubmit).click(),
      ]);
      expect(captureResponse.status()).toBe(201);
      const captured = (await captureResponse.json()) as CaptureResponse;
      expect(captured.capture_id).toBeTruthy();
      expect(captured.proposal_id).toBeTruthy();
      proposalId = captured.proposal_id!;
      versions.push(captured.projection_version);

      // Capture 页提交成功后会跳到提议页；UI 必须能直接读投影渲染出提议。
      await expect(page).toHaveURL(new RegExp(`#/proposals/${proposalId}$`));
      await expect(page.getByTestId(TID.proposalPanel)).toBeVisible();

      const proposal = await getProposal(request, proposalId);
      versions.push(proposal.projection_version);
      expect(proposal.capture_id).toBe(captured.capture_id);
      expect(proposal.status).toBe('proposed');
      expect(proposal.degraded).toBe(false);
      expect(proposal.degraded_reasons).toEqual([]);
      expect(proposal.proposed_tasks).toHaveLength(1);
      expect(proposal.available_actions).toEqual(
        expect.arrayContaining(['accept_proposal', 'reject_proposal']),
      );
      taskId = proposal.proposed_tasks[0].task_id;

      await expect(page.getByTestId(TID.proposalStatus)).toHaveText(proposal.status);
      await expect(page.getByTestId(TID.proposalDegraded)).toHaveCount(0);
      await expect(page.getByTestId(TID.proposalTaskTitle)).toHaveText(
        proposal.proposed_tasks[0].title,
      );
      await expect(page.getByTestId(TID.proposalCriterion)).toHaveCount(
        proposal.proposed_tasks[0].criteria.length,
      );
      await expect(page.getByTestId(TID.proposalAccept)).toBeVisible();
    });

    await test.step('2. 接受提议：命令 202 → 提议 accepted → 任务生成', async () => {
      const [acceptResponse] = await Promise.all([
        page.waitForResponse((response) =>
          isCommandResponse(response.url(), response.request().method()),
        ),
        page.getByTestId(TID.proposalAccept).click(),
      ]);
      expect(acceptResponse.status()).toBe(202);
      const acceptBody = (await acceptResponse.json()) as CommandResponse;
      expect(acceptBody.receipt.command_type).toBe('accept_proposal');
      expect(acceptBody.receipt.duplicate).toBe(false);

      const proposal = await waitForProjection(
        () => getProposal(request, proposalId),
        (value) => value.status === 'accepted' && value.available_actions.length === 0,
        '提议进入 accepted 且 available_actions 清空',
      );
      versions.push(proposal.projection_version);

      await expect(page.getByTestId(TID.proposalStatus)).toHaveText('accepted');
      await expect(page.getByTestId(TID.proposalAccept)).toHaveCount(0);
      await expect(page.getByTestId(TID.proposalLinkActions)).toBeVisible();

      const project = await waitForProjection(
        () => getProject(request, DEMO.projectId),
        (value) => value.task_graph.nodes.some((node) => node.task_id === taskId),
        '提议落地后项目里出现新任务',
      );
      versions.push(project.projection_version);
      const task = findTask(project, taskId);
      expect(task.lifecycle).toBe('defined');
      expect(task.created_from_proposal).toBe(proposalId);
      expect(task.degraded).toBe(false);
      expect(task.criteria.map((criterion) => criterion.criterion_ref)).toEqual([
        DEMO_CRITERIA.importMapped,
        DEMO_CRITERIA.dualTrackReport,
      ]);
      expect(task.available_actions).toEqual(['complete_task']);
      expect(project.goal.status).toBe('in_progress');
      expect(project.plan_rev).toBeGreaterThanOrEqual(1);
    });

    await test.step('3. 任务出现在 My Actions（可用动作以投影为准）', async () => {
      const actions = await waitForProjection(
        () => getActions(request),
        (value) => value.actions.some((row) => row.task_id === taskId),
        'My Actions 出现新任务',
      );
      versions.push(actions.projection_version);
      const row = actions.actions.find((candidate) => candidate.task_id === taskId)!;
      expect(row.project_id).toBe(DEMO.projectId);
      expect(row.available_actions).toEqual(['complete_task']);
      expect(row.degraded).toBe(false);

      await page.getByTestId(TID.proposalLinkActions).click();
      await expect(page).toHaveURL(/#\/actions$/);
      const uiRow = actionRow(page, taskId);
      await expect(uiRow).toBeVisible();
      await expect(uiRow.getByTestId(TID.actionTaskTitle)).toHaveText(row.title);
      await expect(uiRow.getByTestId(TID.taskLifecycle)).toHaveText(row.lifecycle);
      await expect(uiRow.getByTestId(TID.actionCompleteTask)).toBeVisible();
      await expect(uiRow.getByTestId(TID.actionOpenAcceptance)).toHaveCount(0);
    });

    await test.step('4. 完成任务：awaiting_acceptance + available_actions 切到逐判据验收', async () => {
      const [completeResponse] = await Promise.all([
        page.waitForResponse((response) =>
          isCommandResponse(response.url(), response.request().method()),
        ),
        actionRow(page, taskId).getByTestId(TID.actionCompleteTask).click(),
      ]);
      expect(completeResponse.status()).toBe(202);
      const completeBody = (await completeResponse.json()) as CommandResponse;
      expect(completeBody.receipt.command_type).toBe('complete_task');

      const project = await waitForProjection(
        () => getProject(request, DEMO.projectId),
        (value) => findTask(value, taskId).lifecycle === 'awaiting_acceptance',
        '任务完成进入 awaiting_acceptance',
      );
      versions.push(project.projection_version);
      const task = findTask(project, taskId);
      expect(task.outcome?.conclusion_kind).toBe('achieved');
      expect(task.available_actions).toEqual(['record_acceptance']);
      expect(project.acceptance.status).toBe('pending');
      expect(project.goal.status).toBe('in_progress');

      const actions = await waitForProjection(
        () => getActions(request),
        (value) => (value.actions.find((row) => row.task_id === taskId)?.available_actions ?? []).includes('record_acceptance'),
        'My Actions 行切换为 record_acceptance',
      );
      versions.push(actions.projection_version);
      const row = actions.actions.find((candidate) => candidate.task_id === taskId)!;
      expect(row.lifecycle).toBe('awaiting_acceptance');

      const uiRow = actionRow(page, taskId);
      await expect(uiRow.getByTestId(TID.taskLifecycle)).toHaveText(row.lifecycle);
      await expect(uiRow.getByTestId(TID.actionOpenAcceptance)).toBeVisible();
      await expect(uiRow.getByTestId(TID.actionCompleteTask)).toHaveCount(0);
    });

    await test.step('5. 逐判据验收（第一次：一过一不过 → partially_accepted，留待补集）', async () => {
      await actionRow(page, taskId).getByTestId(TID.actionOpenAcceptance).click();
      await expect(page).toHaveURL(
        new RegExp(`#/projects/${DEMO.projectId}/tasks/${taskId}/acceptance$`),
      );
      await expect(page.getByTestId(TID.criterionRow)).toHaveCount(2);
      for (const ref of [DEMO_CRITERIA.importMapped, DEMO_CRITERIA.dualTrackReport]) {
        await expect(criterionRow(page, ref)).toBeVisible();
      }
      await expect(page.getByTestId(TID.acceptanceVerdict)).toHaveText('not_submitted');

      await page.getByTestId(criterionPass(DEMO_CRITERIA.importMapped)).click();
      await page.getByTestId(criterionFail(DEMO_CRITERIA.dualTrackReport)).click();

      const [acceptanceResponse] = await Promise.all([
        page.waitForResponse((response) =>
          isCommandResponse(response.url(), response.request().method()),
        ),
        page.getByTestId(TID.acceptanceSubmit).click(),
      ]);
      expect(acceptanceResponse.status()).toBe(202);
      const acceptanceBody = (await acceptanceResponse.json()) as CommandResponse;
      expect(acceptanceBody.receipt.command_type).toBe('record_acceptance');

      const project = await waitForProjection(
        () => getProject(request, DEMO.projectId),
        (value) => findTask(value, taskId).last_acceptance?.verdict === 'partially_accepted',
        '逐判据验收得出 partially_accepted',
      );
      versions.push(project.projection_version);
      const task = findTask(project, taskId);
      expect(task.lifecycle).toBe('awaiting_acceptance');
      expect(task.last_acceptance?.verdict).toBe('partially_accepted');
      expect(
        Object.fromEntries(
          task.criterion_results.map((result) => [result.criterion_ref, result.verdict]),
        ),
      ).toEqual({
        [DEMO_CRITERIA.importMapped]: 'passed',
        [DEMO_CRITERIA.dualTrackReport]: 'failed',
      });
      expect(project.acceptance.status).toBe('partially_accepted');
      expect(project.acceptance.pending_criteria).toContainEqual({
        task_id: taskId,
        criterion_ref: DEMO_CRITERIA.dualTrackReport,
      });
      expect(project.goal.status).toBe('in_progress');

      // partially_accepted 不迁移 lifecycle；界面必须明示仍待补集。
      await expect(page.getByTestId(TID.acceptanceVerdict)).toHaveText('partially_accepted');
      await expect(page.getByTestId(TID.acceptancePendingCriteria)).toContainText(
        DEMO_CRITERIA.dualTrackReport,
      );
      await expect(page.getByTestId(TID.taskLifecycle)).toHaveText('awaiting_acceptance');
    });

    await test.step('6. 补集后全部通过：task accepted / acceptance accepted / goal achieved', async () => {
      await page.getByTestId(criterionPass(DEMO_CRITERIA.dualTrackReport)).click();
      const [finalResponse] = await Promise.all([
        page.waitForResponse((response) =>
          isCommandResponse(response.url(), response.request().method()),
        ),
        page.getByTestId(TID.acceptanceSubmit).click(),
      ]);
      expect(finalResponse.status()).toBe(202);

      const project = await waitForProjection(
        () => getProject(request, DEMO.projectId),
        (value) => {
          const node = findTask(value, taskId);
          return node.lifecycle === 'accepted' && value.acceptance.status === 'accepted';
        },
        '补集后任务 accepted、项目 acceptance accepted',
      );
      versions.push(project.projection_version);
      const task = findTask(project, taskId);
      expect(task.last_acceptance?.verdict).toBe('accepted');
      expect(task.criterion_results.every((result) => result.verdict === 'passed')).toBe(true);
      expect(task.available_actions).toEqual([]);
      expect(project.acceptance.accepted_tasks).toBe(1);
      expect(project.acceptance.active_tasks).toBe(1);
      expect(project.acceptance.pending_criteria).toEqual([]);
      expect(project.goal.status).toBe('achieved');

      await expect(page.getByTestId(TID.acceptanceVerdict)).toHaveText('accepted');
      await expect(page.getByTestId(TID.taskLifecycle)).toHaveText('accepted');
      await expect(page.getByTestId(TID.acceptancePendingCriteria)).toHaveText('none');

      const actions = await getActions(request);
      expect(actions.actions.find((row) => row.task_id === taskId)).toBeUndefined();
    });

    await test.step('7. 项目页与 Home 投影同步更新', async () => {
      await page.goto(`/#/projects/${DEMO.projectId}`);
      const project = await getProject(request, DEMO.projectId);
      versions.push(project.projection_version);

      await expect(page.getByTestId(TID.goalStatus)).toHaveText(project.goal.status);
      await expect(page.getByTestId(TID.projectAcceptanceStatus)).toHaveText(
        project.acceptance.status,
      );
      await expect(page.getByTestId(TID.projectAcceptedCount)).toHaveText(
        `${project.acceptance.accepted_tasks}/${project.acceptance.active_tasks}`,
      );
      await expect(page.getByTestId(TID.projectPendingCriteria)).toHaveText('none');
      const row = projectTaskRow(page, taskId);
      await expect(row.getByTestId(TID.taskLifecycle)).toHaveText('accepted');
      await expect(row.getByTestId(TID.taskDegraded)).toHaveCount(0);

      await page.goto('/#/home');
      const home = await getHome(request);
      versions.push(home.projection_version);
      const summary = projectSummary(home, DEMO.projectId);
      expect(summary.goal_status).toBe('achieved');
      expect(summary.acceptance_status).toBe('accepted');
      expect(summary.task_summary.accepted_tasks).toBe(1);
      expect(summary.pending_actions_count).toBe(0);
      expect(home.pending_actions_count).toBe(0);

      const activityKinds = home.recent_activity.map((item) => item.kind);
      expect(activityKinds).toEqual(
        expect.arrayContaining(['acceptance.recorded', 'task.accepted', 'goal.status_changed']),
      );

      await expect(page.getByTestId(TID.homePendingCount)).toHaveText('0');
      const card = page.locator(
        `[data-testid="${TID.homeProjectCard}"][data-project-id="${DEMO.projectId}"]`,
      );
      await expect(card.getByTestId(TID.homeGoalStatus)).toHaveText(summary.goal_status);
      await expect(page.getByTestId(TID.homeActivityItem).first()).toHaveAttribute(
        'data-kind',
        'goal.status_changed',
      );
    });

    await test.step('8. 投影游标单调：每一步看到的都是同一条事件流', async () => {
      expect(versions.length).toBeGreaterThanOrEqual(8);
      expect(versions).toEqual([...versions].sort((a, b) => a - b));
    });
  });
});
