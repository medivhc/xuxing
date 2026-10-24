import { expect, test, type Page } from '@playwright/test';
import type { CommandResponse } from '../contract.mts';
import { DEGRADED } from '../journeys.config.mts';
import {
  findTask,
  getActions,
  getHome,
  getProject,
  getProposal,
  projectSummary,
  waitForProjection,
} from '../support/api.mts';
import { DEGRADED_CRITERIA, TID, criterionPass } from '../support/testids.mts';

// ============================================================================
// 交付物 1（降级旅程）：提议带 degraded 标记时，投影与界面都必须明示降级，
// 但接受 → 生成任务 → 完成 → 逐判据验收 → 项目更新的整条链路仍可走通。
//
// 降级提议由 mock 启动时的种子生成（真实服务集成时用 JOURNEY_DEGRADED_* 指向
// 一条已标记 degraded 的种子提议），因此本文件不依赖主旅程先跑。
// ============================================================================

test.describe.configure({ mode: 'serial' });

function isCommandResponse(url: string, method: string): boolean {
  return method === 'POST' && new URL(url).pathname === '/api/commands';
}

function actionRow(page: Page, taskId: string) {
  return page.locator(`[data-testid="${TID.myActionsRow}"][data-task-id="${taskId}"]`);
}

test.describe('D9 降级旅程（degraded 明示 + 全链路可走通）', () => {
  test('degraded 提议：投影/界面明示，接受后任务与验收照常完成', async ({ page, request }) => {
    const versions: number[] = [];

    await test.step('0. 降级提议投影：degraded=true 且有原因清单', async () => {
      const proposal = await getProposal(request, DEGRADED.proposalId);
      versions.push(proposal.projection_version);
      expect(proposal.degraded).toBe(true);
      expect(proposal.degraded_reasons.length).toBeGreaterThan(0);
      expect(proposal.status).toBe('proposed');
      expect(proposal.available_actions).toContain('accept_proposal');
      expect(proposal.proposed_tasks).toHaveLength(1);
      expect(proposal.proposed_tasks[0].task_id).toBe(DEGRADED.taskId);

      const project = await getProject(request, DEGRADED.projectId);
      versions.push(project.projection_version);
      expect(project.provenance.degraded_proposals).toBeGreaterThanOrEqual(1);
      expect(project.goal.status).toBe('draft');
      expect(project.acceptance.status).toBe('not_started');
    });

    await test.step('1. 提议页明示 degraded（界面文本来自投影）', async () => {
      const proposal = await getProposal(request, DEGRADED.proposalId);
      await page.goto(`/#/proposals/${DEGRADED.proposalId}`);
      await expect(page.getByTestId(TID.proposalPanel)).toBeVisible();
      await expect(page.getByTestId(TID.proposalStatus)).toHaveText(proposal.status);
      await expect(page.getByTestId(TID.proposalDegraded)).toBeVisible();
      await expect(page.getByTestId(TID.proposalDegraded)).toHaveText('degraded');
      for (const reason of proposal.degraded_reasons) {
        await expect(page.getByTestId(TID.proposalDegradedReasons)).toContainText(reason);
      }
      await expect(page.getByTestId(TID.proposalTaskTitle)).toHaveText(
        proposal.proposed_tasks[0].title,
      );
      await expect(page.getByTestId(TID.proposalCriterion)).toHaveCount(
        proposal.proposed_tasks[0].criteria.length,
      );
    });

    await test.step('2. 接受降级提议 → 任务生成且带 degraded 溯源', async () => {
      const [acceptResponse] = await Promise.all([
        page.waitForResponse((response) =>
          isCommandResponse(response.url(), response.request().method()),
        ),
        page.getByTestId(TID.proposalAccept).click(),
      ]);
      expect(acceptResponse.status()).toBe(202);
      const body = (await acceptResponse.json()) as CommandResponse;
      expect(body.receipt.command_type).toBe('accept_proposal');

      const proposal = await waitForProjection(
        () => getProposal(request, DEGRADED.proposalId),
        (value) => value.status === 'accepted',
        '降级提议进入 accepted',
      );
      versions.push(proposal.projection_version);
      expect(proposal.degraded).toBe(true);
      expect(proposal.degraded_reasons.length).toBeGreaterThan(0);

      const project = await waitForProjection(
        () => getProject(request, DEGRADED.projectId),
        (value) => value.task_graph.nodes.some((node) => node.task_id === DEGRADED.taskId),
        '降级提议落地生成任务',
      );
      versions.push(project.projection_version);
      const task = findTask(project, DEGRADED.taskId);
      expect(task.lifecycle).toBe('defined');
      expect(task.degraded).toBe(true);
      expect(task.created_from_proposal).toBe(DEGRADED.proposalId);
      expect(project.provenance.degraded_tasks).toBeGreaterThanOrEqual(1);
      expect(project.goal.status).toBe('in_progress');
    });

    await test.step('3. My Actions 行明示 degraded；完成任务', async () => {
      const actions = await waitForProjection(
        () => getActions(request),
        (value) => value.actions.some((row) => row.task_id === DEGRADED.taskId),
        '降级任务进入 My Actions',
      );
      versions.push(actions.projection_version);
      const row = actions.actions.find((candidate) => candidate.task_id === DEGRADED.taskId)!;
      expect(row.degraded).toBe(true);
      expect(row.available_actions).toEqual(['complete_task']);

      await page.goto('/#/actions');
      const uiRow = actionRow(page, DEGRADED.taskId);
      await expect(uiRow).toBeVisible();
      await expect(uiRow).toHaveAttribute('data-degraded', 'true');
      await expect(uiRow.getByTestId(TID.actionDegraded)).toBeVisible();
      await expect(uiRow.getByTestId(TID.actionDegraded)).toHaveText('degraded');
      await expect(uiRow.getByTestId(TID.taskLifecycle)).toHaveText(row.lifecycle);

      const [completeResponse] = await Promise.all([
        page.waitForResponse((response) =>
          isCommandResponse(response.url(), response.request().method()),
        ),
        uiRow.getByTestId(TID.actionCompleteTask).click(),
      ]);
      expect(completeResponse.status()).toBe(202);

      const project = await waitForProjection(
        () => getProject(request, DEGRADED.projectId),
        (value) => findTask(value, DEGRADED.taskId).lifecycle === 'awaiting_acceptance',
        '降级任务完成进入 awaiting_acceptance',
      );
      versions.push(project.projection_version);
      const task = findTask(project, DEGRADED.taskId);
      expect(task.degraded).toBe(true);
      expect(task.available_actions).toEqual(['record_acceptance']);
      expect(project.acceptance.status).toBe('pending');
    });

    await test.step('4. 逐判据验收全部通过 → 任务/项目/目标同步更新（degraded 仍可见）', async () => {
      await actionRow(page, DEGRADED.taskId).getByTestId(TID.actionOpenAcceptance).click();
      await expect(page).toHaveURL(
        new RegExp(`#/projects/${DEGRADED.projectId}/tasks/${DEGRADED.taskId}/acceptance$`),
      );
      await page.getByTestId(criterionPass(DEGRADED_CRITERIA.leadsExport)).click();
      await page.getByTestId(criterionPass(DEGRADED_CRITERIA.leadsDedup)).click();

      const [acceptanceResponse] = await Promise.all([
        page.waitForResponse((response) =>
          isCommandResponse(response.url(), response.request().method()),
        ),
        page.getByTestId(TID.acceptanceSubmit).click(),
      ]);
      expect(acceptanceResponse.status()).toBe(202);

      const project = await waitForProjection(
        () => getProject(request, DEGRADED.projectId),
        (value) => {
          const node = findTask(value, DEGRADED.taskId);
          return node.lifecycle === 'accepted' && value.goal.status === 'achieved';
        },
        '降级旅程收尾：任务 accepted、目标 achieved',
      );
      versions.push(project.projection_version);
      const task = findTask(project, DEGRADED.taskId);
      expect(task.last_acceptance?.verdict).toBe('accepted');
      expect(task.degraded).toBe(true);
      expect(project.acceptance.status).toBe('accepted');
      expect(project.acceptance.pending_criteria).toEqual([]);
      expect(project.provenance.degraded_tasks).toBeGreaterThanOrEqual(1);

      await expect(page.getByTestId(TID.acceptanceVerdict)).toHaveText('accepted');
      await expect(page.getByTestId(TID.taskLifecycle)).toHaveText('accepted');
    });

    await test.step('5. 项目页与 Home 仍明示 degraded 来源', async () => {
      await page.goto(`/#/projects/${DEGRADED.projectId}`);
      const project = await getProject(request, DEGRADED.projectId);
      versions.push(project.projection_version);
      await expect(page.getByTestId(TID.goalStatus)).toHaveText(project.goal.status);
      await expect(page.getByTestId(TID.projectAcceptanceStatus)).toHaveText(
        project.acceptance.status,
      );
      const row = page.locator(
        `[data-testid="${TID.taskRow}"][data-task-id="${DEGRADED.taskId}"]`,
      );
      await expect(row.getByTestId(TID.taskLifecycle)).toHaveText('accepted');
      await expect(row.getByTestId(TID.taskDegraded)).toBeVisible();
      await expect(row.getByTestId(TID.taskDegraded)).toHaveText('degraded');

      await page.goto('/#/home');
      const home = await getHome(request);
      versions.push(home.projection_version);
      const summary = projectSummary(home, DEGRADED.projectId);
      expect(summary.degraded).toBe(true);
      expect(summary.goal_status).toBe('achieved');
      const card = page.locator(
        `[data-testid="${TID.homeProjectCard}"][data-project-id="${DEGRADED.projectId}"]`,
      );
      await expect(card.getByTestId(TID.homeDegraded)).toBeVisible();
      await expect(card.getByTestId(TID.homeGoalStatus)).toHaveText('achieved');
    });

    await test.step('6. 投影游标单调', async () => {
      expect(versions).toEqual([...versions].sort((a, b) => a - b));
    });
  });
});
