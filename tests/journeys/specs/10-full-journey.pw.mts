import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { AcceptanceCriterion } from '../contract.mts';
import { CURRENT_ACTOR_ID, DEMO, USING_EXTERNAL_SERVICE } from '../journeys.config.mts';
import {
  capture,
  expectCreatedCommand,
  findAction,
  findGraphNode,
  findTask,
  getActions,
  getHealth,
  getHome,
  getProject,
  getProposal,
  postCommand,
  projectSummary,
  waitForProjection,
} from '../support/api.mts';
import { TID, criterionPass } from '../support/testids.mts';

// ============================================================================
// 交付物 1：完整旅程（浏览器 + 投影断言）
//
//   捕获输入 → 智能层提议 → 用户接受（服务端发号）→ 生成任务 → 进入 My Actions →
//   推进到 active → 提交反馈 → awaiting_acceptance → 逐判据验收（先部分通过，
//   再补集全通过）→ 任务 accepted（验收席位全程留在 My Actions，R-10）
//
// 口径（FIX-ROUND-1 裁决）：
//   - R-1：available_actions 是 canonical command_type 字符串数组
//     （proposal_accept / task_advance / feedback_submit / acceptance_record / task_cancel）。
//   - R-2：所有响应都从 data 读字段；命令首次 201 + data.replayed=false。
//   - R-7：种子初始 My Actions 不为空、项目图不为空；本旅程「现场建任务」，
//     只断言自己新建的那条 task_id，不假设种子状态为空。
//   - R-8：项目视图读 data.{project,goal,tasks,acceptance_status,graph,pending_proposals}。
//   - R-11：提议不预告 task_id；task_id 只在 proposal_accept 的响应 subject 里出现。
//
// UI 步骤只在 mock 轮执行（真服务 8787 没有同款页面）；真服务轮全部走投影断言。
// ============================================================================

test.describe.configure({ mode: 'serial' });

const usingMock = !USING_EXTERNAL_SERVICE;

function actionRow(page: Page, taskId: string) {
  return page.locator(`[data-testid="${TID.myActionsRow}"][data-task-id="${taskId}"]`);
}

function projectTaskRow(page: Page, taskId: string) {
  return page.locator(`[data-testid="${TID.taskRow}"][data-task-id="${taskId}"]`);
}

function isCommandResponse(url: string, method: string): boolean {
  return method === 'POST' && new URL(url).pathname === '/api/commands';
}

test.describe('D9 完整旅程（Web 车道 C）', () => {
  test('捕获 → 提议 → 接受（发号）→ My Actions → 反馈 → 逐判据验收 → 任务 accepted', async ({
    page,
    request,
  }) => {
    const versions: number[] = [];
    let proposalId = '';
    let captureId = '';
    let taskId = '';
    let criteria: AcceptanceCriterion[] = [];
    const captureText = `把 nx-pipeline 最近一轮 run 导入续行，跑通双轨对照（旅程 ${randomUUID().slice(0, 8)}）`;

    await test.step('0. 健康检查 + 种子基线（R-7 种子契约）', async () => {
      const health = await getHealth(request);
      expect(health.ok).toBe(true);
      expect(health.db).toBe(true);
      expect(health.limits.heartbeat_ms).toBe(15_000);
      expect(health.limits.max_connections).toBeGreaterThan(0);
      expect(health.limits.max_queue).toBeGreaterThan(0);
      versions.push(health.projection_version);

      const home = await getHome(request);
      expect(home.projection_version).toBeGreaterThan(0);
      expect(home.actor_id).toBe(CURRENT_ACTOR_ID);
      versions.push(home.projection_version);

      const project = await getProject(request, DEMO.projectId);
      versions.push(project.projection_version);
      expect(project.project.project_id).toBe(DEMO.projectId);
      expect(project.goal?.goal_id).toBe(DEMO.goalId);
      // R-8：验收摘要是数值键，不是旧的 acceptance.status 字符串
      expect(project.acceptance_status.accepted).toBe(1);
      expect(project.acceptance_status.total).toBe(5);
      // R-7：项目图初始就不为空
      expect(project.graph.nodes.length).toBeGreaterThanOrEqual(5);

      // R-7① 已取消夹具：canceled 且 available_actions=[]
      const canceled = findTask(project, DEMO.canceledTaskId);
      expect(canceled.lifecycle).toBe('canceled');
      expect(canceled.available_actions).toEqual([]);
      expect(findGraphNode(project, DEMO.canceledTaskId).lifecycle).toBe('canceled');

      // R-7：初始 My Actions 不为空（contact / quote / contract 三条 canonical 动作）
      const actions = await getActions(request);
      versions.push(actions.projection_version);
      expect(actions.actor_id).toBe(CURRENT_ACTOR_ID);
      const seedRows = actions.items.filter((row) => row.project_id === DEMO.projectId);
      expect(seedRows.map((row) => row.task_id).sort()).toEqual(
        ['task_demo_contact', 'task_demo_contract', 'task_demo_quote'].sort(),
      );
      expect(findAction(actions, 'task_demo_contact')?.available_actions).toEqual([
        'feedback_submit',
        'task_cancel',
      ]);
      expect(findAction(actions, 'task_demo_quote')?.available_actions).toEqual(['task_advance', 'task_cancel']);
      expect(findAction(actions, 'task_demo_contract')?.available_actions).toEqual([
        'task_advance',
        'task_cancel',
      ]);
      // accepted / canceled 不在 My Actions
      expect(findAction(actions, 'task_demo_kickoff')).toBeUndefined();
      expect(findAction(actions, DEMO.canceledTaskId)).toBeUndefined();

      if (usingMock) {
        await page.goto('/#/home');
        await expect(page.getByTestId(TID.homeProjectCard)).not.toHaveCount(0);
        const card = page.locator(
          `[data-testid="${TID.homeProjectCard}"][data-project-id="${DEMO.projectId}"]`,
        );
        await expect(card.getByTestId(TID.homeGoalStatus)).toHaveText(project.goal!.status);
      }
    });

    await test.step('1. Capture：一句话输入 → PlanChangeProposed + FeedbackReceived（R-9 PascalCase）', async () => {
      if (usingMock) {
        await page.goto('/#/capture');
        await page.getByTestId(TID.captureInput).fill(captureText);

        const [captureResponse] = await Promise.all([
          page.waitForResponse(
            (response) =>
              response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/capture',
          ),
          page.getByTestId(TID.captureSubmit).click(),
        ]);
        expect(captureResponse.status()).toBe(201);
        const body = (await captureResponse.json()) as { ok: boolean; data: Record<string, unknown> };
        // R-2：从 data 读，不读顶层
        expect(body.ok).toBe(true);
        captureId = String(body.data.capture_id);
        proposalId = String(body.data.proposal_id);
        expect(captureId).toBeTruthy();
        expect(proposalId).toBeTruthy();
        versions.push(Number(body.data.projection_version));

        await expect(page).toHaveURL(new RegExp(`#/proposals/${proposalId}$`));
        await expect(page.getByTestId(TID.proposalPanel)).toBeVisible();
      } else {
        const captured = await capture(request, captureText);
        captureId = captured.capture_id;
        proposalId = captured.proposal_id;
        expect(captured.project_id).toBe(DEMO.projectId);
        expect(captured.emitted.map((event) => event.kind)).toEqual([
          'PlanChangeProposed',
          'FeedbackReceived',
        ]);
        versions.push(captured.projection_version);
      }

      const proposal = await getProposal(request, proposalId);
      versions.push(proposal.projection_version);
      expect(proposal.capture_id).toBe(captureId);
      expect(proposal.status).toBe('proposed');
      expect(proposal.degraded).toBe(false);
      expect(proposal.proposer.degraded).toBe(false);
      expect(proposal.available_actions).toEqual(['proposal_accept', 'proposal_reject']);
      // R-11：提议不预告 task_id，只带 draft（标题 + 判据）
      expect(proposal.task_id).toBeNull();
      expect(JSON.stringify(proposal.ops)).not.toContain('task_');
      expect(proposal.details.kind).toBe('capture_task');
      expect(proposal.details.task.title.length).toBeGreaterThan(0);
      criteria = proposal.details.task.acceptance_criteria;
      expect(criteria.length).toBeGreaterThan(0);

      if (usingMock) {
        await expect(page.getByTestId(TID.proposalStatus)).toHaveText(proposal.status);
        await expect(page.getByTestId(TID.proposalTaskTitle)).toHaveText(proposal.details.task.title);
        await expect(page.getByTestId(TID.proposalCriterion)).toHaveCount(criteria.length);
        await expect(page.getByTestId(TID.proposalAccept)).toBeVisible();
      }
    });

    await test.step('2. 接受提议：命令 201 → 服务端发号 → 任务 defined（R-6/R-11）', async () => {
      if (usingMock) {
        const [acceptResponse] = await Promise.all([
          page.waitForResponse((response) =>
            isCommandResponse(response.url(), response.request().method()),
          ),
          page.getByTestId(TID.proposalAccept).click(),
        ]);
        expect(acceptResponse.status()).toBe(201);
        const envelope = (await acceptResponse.json()) as {
          ok: boolean;
          data: { command_type: string; replayed: boolean; subject: { task_id: string } };
        };
        expect(envelope.ok).toBe(true);
        expect(envelope.data.command_type).toBe('proposal_accept');
        expect(envelope.data.replayed).toBe(false);
        taskId = envelope.data.subject.task_id;
        expect(taskId).toBeTruthy();

        await expect(page.getByTestId(TID.proposalStatus)).toHaveText('accepted');
        await expect(page.getByTestId(TID.proposalLinkActions)).toBeVisible();
      } else {
        const accepted = expectCreatedCommand(
          await postCommand(request, 'proposal_accept', { proposal_id: proposalId }, `accept-${randomUUID()}`),
        );
        expect(accepted.command_type).toBe('proposal_accept');
        expect(accepted.subject.proposal_id).toBe(proposalId);
        // R-11：id 由服务端在命令响应里新发
        taskId = String(accepted.subject.task_id);
        expect(taskId.length).toBeGreaterThan(0);
        versions.push(accepted.projection_version);
      }

      const proposal = await waitForProjection(
        () => getProposal(request, proposalId),
        (value) => value.status === 'accepted' && value.available_actions.length === 0,
        '提议进入 accepted 且 available_actions 清空',
      );
      versions.push(proposal.projection_version);

      const project = await waitForProjection(
        () => getProject(request, DEMO.projectId),
        (value) => value.tasks.some((node) => node.task_id === taskId),
        '提议落地后项目里出现新任务',
      );
      versions.push(project.projection_version);
      const task = findTask(project, taskId);
      expect(task.lifecycle).toBe('defined');
      expect(task.proposal_id).toBe(proposalId);
      expect(task.acceptance_criteria.map((criterion) => criterion.criterion_ref)).toEqual(
        criteria.map((criterion) => criterion.criterion_ref),
      );
      expect(task.available_actions).toContain('task_advance');
      // 新任务同时在待处理提议之外（提议已决）与项目图里
      expect(project.pending_proposals.map((item) => item.proposal_id)).not.toContain(proposalId);
      expect(findGraphNode(project, taskId).lifecycle).toBe('defined');
    });

    await test.step('3. 任务出现在 My Actions（available_actions 以投影为准）', async () => {
      const actions = await waitForProjection(
        () => getActions(request),
        (value) => value.items.some((row) => row.task_id === taskId),
        'My Actions 出现新任务',
      );
      versions.push(actions.projection_version);
      const row = findAction(actions, taskId)!;
      expect(row.project_id).toBe(DEMO.projectId);
      expect(row.lifecycle).toBe('defined');
      expect(row.available_actions).toContain('task_advance');

      if (usingMock) {
        await page.getByTestId(TID.proposalLinkActions).click();
        await expect(page).toHaveURL(/#\/actions$/);
        const uiRow = actionRow(page, taskId);
        await expect(uiRow).toBeVisible();
        await expect(uiRow.getByTestId(TID.actionTaskTitle)).toHaveText(row.title);
        await expect(uiRow.getByTestId(TID.taskLifecycle)).toHaveText(row.lifecycle);
      }
    });

    await test.step('4. task_advance ×2 → active（Run 派发）→ feedback_submit → awaiting_acceptance（R-10）', async () => {
      for (const [index, expectedLifecycle] of ['ready', 'active'].entries()) {
        const advanced = expectCreatedCommand(
          await postCommand(request, 'task_advance', { task_id: taskId }, `advance-${index}-${randomUUID()}`),
        );
        expect(advanced.command_type).toBe('task_advance');
        expect(advanced.subject.to).toBe(expectedLifecycle);
        versions.push(advanced.projection_version);
      }

      const activeProject = await waitForProjection(
        () => getProject(request, DEMO.projectId),
        (value) => findTask(value, taskId).lifecycle === 'active',
        '任务推进到 active',
      );
      versions.push(activeProject.projection_version);
      expect(findTask(activeProject, taskId).available_actions).toContain('feedback_submit');

      const feedback = expectCreatedCommand(
        await postCommand(
          request,
          'feedback_submit',
          { task_id: taskId, content: '导入跑通，双轨对照结论已记录，附执行日志。' },
          `feedback-${randomUUID()}`,
        ),
      );
      expect(feedback.command_type).toBe('feedback_submit');
      expect(feedback.emitted.map((event) => event.kind)).toEqual(
        expect.arrayContaining(['FeedbackReceived', 'OutcomeRecorded', 'RunSucceeded']),
      );
      versions.push(feedback.projection_version);

      const project = await waitForProjection(
        () => getProject(request, DEMO.projectId),
        (value) => findTask(value, taskId).lifecycle === 'awaiting_acceptance',
        '任务进入 awaiting_acceptance',
      );
      versions.push(project.projection_version);
      const task = findTask(project, taskId);
      expect(task.last_outcome_id).toBe(String(feedback.subject.outcome_id));
      expect(task.feedback_count).toBe(1);
      expect(task.acceptance).toBeNull();
      // R-10：验收动作在任务自己的 available_actions 里，且任务仍在 My Actions
      expect(task.available_actions).toContain('acceptance_record');

      const actions = await waitForProjection(
        () => getActions(request),
        (value) => (findAction(value, taskId)?.available_actions ?? []).includes('acceptance_record'),
        'My Actions 行带 acceptance_record（R-10 验收席位不消失）',
      );
      versions.push(actions.projection_version);
      const row = findAction(actions, taskId)!;
      expect(row.lifecycle).toBe('awaiting_acceptance');
      expect(row.available_actions).toEqual(expect.arrayContaining(['acceptance_record']));

      if (usingMock) {
        // 页面本身不轮询投影：这里真的重载一次，等它按最新投影重绘后再断言
        // （goto 到相同 URL 不会触发导航，stale DOM 会一直留着）。
        await page.goto('/#/actions');
        await page.reload();
        const uiRow = actionRow(page, taskId);
        await expect(uiRow).toBeVisible();
        await expect(uiRow.getByTestId(TID.taskLifecycle)).toHaveText('awaiting_acceptance');
        await expect(uiRow.getByTestId(TID.actionOpenAcceptance)).toBeVisible();
      }
    });

    await test.step('5. 逐判据验收（第一次：一条不通过 → partially_accepted，任务退回 active 待再执行）', async () => {
      const failedRef = criteria[0].criterion_ref;
      if (usingMock) {
        if (!page.url().endsWith('/actions')) await page.goto('/#/actions');
        await actionRow(page, taskId).getByTestId(TID.actionOpenAcceptance).click();
        await expect(page).toHaveURL(
          new RegExp(`#/projects/${DEMO.projectId}/tasks/${taskId}/acceptance$`),
        );
        await expect(page.getByTestId(TID.criterionRow)).toHaveCount(criteria.length);
        await expect(page.getByTestId(TID.acceptanceVerdict)).toHaveText('not_submitted');
        await page.getByTestId(criterionPass(failedRef)).click();
        for (const criterion of criteria.slice(1)) {
          await page
            .getByTestId(`criterion-fail-${criterion.criterion_ref}`)
            .click();
        }

        const [acceptanceResponse] = await Promise.all([
          page.waitForResponse((response) =>
            isCommandResponse(response.url(), response.request().method()),
          ),
          page.getByTestId(TID.acceptanceSubmit).click(),
        ]);
        expect(acceptanceResponse.status()).toBe(201);
        const envelope = (await acceptanceResponse.json()) as {
          ok: boolean;
          data: { command_type: string };
        };
        expect(envelope.ok).toBe(true);
        expect(envelope.data.command_type).toBe('acceptance_record');
      } else {
        const acceptance = expectCreatedCommand(
          await postCommand(
            request,
            'acceptance_record',
            {
              task_id: taskId,
              criterion_results: criteria.map((criterion, index) => ({
                criterion_ref: criterion.criterion_ref,
                verdict: index === 0 ? 'passed' : 'failed',
                evidence_refs: [],
              })),
              rationale: '部分判据未通过，退回再执行',
            },
            `acceptance-partial-${randomUUID()}`,
          ),
        );
        expect(acceptance.command_type).toBe('acceptance_record');
        expect(acceptance.subject.verdict).toBe('partially_accepted');
        versions.push(acceptance.projection_version);
      }

      const project = await waitForProjection(
        () => getProject(request, DEMO.projectId),
        (value) => findTask(value, taskId).acceptance?.verdict === 'partially_accepted',
        '逐判据验收落账 partially_accepted',
      );
      versions.push(project.projection_version);
      const task = findTask(project, taskId);
      // 内核矩阵：partially_accepted → 退回 active 待再执行（不是停在 awaiting_acceptance）
      expect(task.lifecycle).toBe('active');
      const results = Object.fromEntries(
        (task.acceptance?.criterion_results ?? []).map((result) => [result.criterion_ref, result.verdict]),
      );
      for (const [index, criterion] of criteria.entries()) {
        expect(results[criterion.criterion_ref]).toBe(index === 0 ? 'passed' : 'failed');
      }
      // partially_accepted 不计入 accepted/rejected 两个计数（真服务只数 lifecycle=accepted 与
      // verdict=rejected），逐判据明细从 criterion_summary 读。
      expect(project.acceptance_status.criterion_summary.filter((item) => item.task_id === taskId && item.verdict === 'failed').length)
        .toBe(criteria.length - 1);

      if (usingMock) {
        await expect(page.getByTestId(TID.acceptanceVerdict)).toHaveText('partially_accepted');
        await expect(page.getByTestId(TID.taskLifecycle)).toHaveText('active');
      }
    });

    await test.step('6. 补集后全部通过：任务 accepted（acceptance_status.accepted +1）', async () => {
      // partially_accepted 之后任务退回 active：先提交一条新的执行反馈（active → awaiting_acceptance），
      // 再逐判据重新验收。不去重推 defined→ready→active：那会把任务重新派发成一条新 Run，
      // 也不符合"退回待再执行"的语义。
      const feedback = expectCreatedCommand(
        await postCommand(
          request,
          'feedback_submit',
          { task_id: taskId, content: '按验收意见补齐后重新提交，全部判据可核对。' },
          `re-feedback-${randomUUID()}`,
        ),
      );
      expect(feedback.emitted.map((event) => event.kind)).toEqual(
        expect.arrayContaining(['FeedbackReceived', 'OutcomeRecorded', 'RunSucceeded']),
      );
      versions.push(feedback.projection_version);

      await waitForProjection(
        () => getProject(request, DEMO.projectId),
        (value) => findTask(value, taskId).lifecycle === 'awaiting_acceptance',
        '重新执行后回到 awaiting_acceptance',
      );

      if (usingMock) {
        await page.goto(`/#/projects/${DEMO.projectId}/tasks/${taskId}/acceptance`);
        for (const criterion of criteria) {
          await page.getByTestId(criterionPass(criterion.criterion_ref)).click();
        }
        const [finalResponse] = await Promise.all([
          page.waitForResponse((response) =>
            isCommandResponse(response.url(), response.request().method()),
          ),
          page.getByTestId(TID.acceptanceSubmit).click(),
        ]);
        expect(finalResponse.status()).toBe(201);
      } else {
        const acceptance = expectCreatedCommand(
          await postCommand(
            request,
            'acceptance_record',
            {
              task_id: taskId,
              criterion_results: criteria.map((criterion) => ({
                criterion_ref: criterion.criterion_ref,
                verdict: 'passed',
                evidence_refs: ['journey-verified'],
              })),
              rationale: '全部判据通过',
            },
            `acceptance-final-${randomUUID()}`,
          ),
        );
        expect(acceptance.subject.verdict).toBe('accepted');
        versions.push(acceptance.projection_version);
      }

      const project = await waitForProjection(
        () => getProject(request, DEMO.projectId),
        (value) => findTask(value, taskId).lifecycle === 'accepted',
        '补集后任务 accepted',
      );
      versions.push(project.projection_version);
      const task = findTask(project, taskId);
      expect(task.acceptance?.verdict).toBe('accepted');
      expect(task.acceptance?.criterion_results.every((result) => result.verdict === 'passed')).toBe(true);
      expect(task.available_actions).toEqual([]);
      expect(project.acceptance_status.accepted).toBe(2);
      expect(findGraphNode(project, taskId).lifecycle).toBe('accepted');

      // accepted 的任务离开 My Actions（验收席位在验收落账后才消失）
      const actions = await getActions(request);
      expect(findAction(actions, taskId)).toBeUndefined();

      if (usingMock) {
        await expect(page.getByTestId(TID.acceptanceVerdict)).toHaveText('accepted');
        await expect(page.getByTestId(TID.taskLifecycle)).toHaveText('accepted');
      }
    });

    await test.step('7. 项目页与 Home 投影同步（R-8/R-9）', async () => {
      const project = await getProject(request, DEMO.projectId);
      versions.push(project.projection_version);

      const home = await getHome(request);
      versions.push(home.projection_version);
      const summary = projectSummary(home, DEMO.projectId);
      expect(summary.task_counts.accepted).toBe(project.acceptance_status.accepted);
      expect(summary.accepted_tasks).toBe(project.acceptance_status.accepted);
      expect(summary.total_tasks).toBe(project.acceptance_status.total);

      // R-9：Home 活动 kind 是 PascalCase 内核事件名
      const activityKinds = home.recent_activity.map((item) => item.kind);
      expect(activityKinds.every((kind) => /^[A-Z][A-Za-z]+$/.test(kind))).toBe(true);
      expect(activityKinds).toEqual(
        expect.arrayContaining(['AcceptanceRecorded', 'TaskLifecycleChanged', 'FeedbackReceived']),
      );
      expect(activityKinds.some((kind) => kind.includes('.'))).toBe(false);

      if (usingMock) {
        await page.goto(`/#/projects/${DEMO.projectId}`);
        await expect(page.getByTestId(TID.goalStatus)).toHaveText(project.goal!.status);
        await expect(page.getByTestId(TID.projectAcceptanceStatus)).toHaveText(
          String(project.acceptance_status.accepted),
        );
        await expect(page.getByTestId(TID.projectAcceptedCount)).toHaveText(
          `${project.acceptance_status.accepted}/${project.acceptance_status.total}`,
        );
        const row = projectTaskRow(page, taskId);
        await expect(row.getByTestId(TID.taskLifecycle)).toHaveText('accepted');

        await page.goto('/#/home');
        const card = page.locator(
          `[data-testid="${TID.homeProjectCard}"][data-project-id="${DEMO.projectId}"]`,
        );
        await expect(card.getByTestId(TID.homeGoalStatus)).toHaveText(String(project.goal!.status));
        await expect(page.getByTestId(TID.homeActivityItem).first()).toHaveAttribute(
          'data-kind',
          home.recent_activity[0].kind,
        );
      }
    });

    await test.step('8. 投影游标单调：每一步看到的都是同一条事件流', async () => {
      expect(versions.length).toBeGreaterThanOrEqual(8);
      expect(versions).toEqual([...versions].sort((a, b) => a - b));
    });
  });
});
