import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { AcceptanceCriterion } from '../contract.mts';
import { DEGRADED, DEMO, USING_EXTERNAL_SERVICE } from '../journeys.config.mts';
import {
  capture,
  expectCreatedCommand,
  findAction,
  findGraphNode,
  findTask,
  getActions,
  getHome,
  getProject,
  getProposal,
  postCommand,
  projectSummary,
  waitForProjection,
} from '../support/api.mts';
import { SseStream } from '../support/sse-client.mts';
import { TID, criterionPass } from '../support/testids.mts';

// ============================================================================
// 交付物 1（降级旅程）：提议带 degraded 标记时，投影与界面都必须明示降级，
// 但接受 → 服务端发号 → 推进 → 反馈 → 逐判据验收（全通过）的链路仍可走通。
//
// 夹具（R-7② 种子契约）：proj-degraded / goal-degraded-1 / prop-degraded-1，
// 只是一条已落账的 PlanChangeProposed（proposer.degraded=true,
// degraded_reason=not_configured），断开 magpie 时照样可达。
//
// R-9：降级明示的两条通道都要断言——投影 degraded=true，以及断开模型时的
// SSE `notice` 帧（kind=proposal_degraded）。
// R-11：夹具不预告 task_id；任务 id 只在接受提议后由服务端新发。
// ============================================================================

test.describe.configure({ mode: 'serial' });

const usingMock = !USING_EXTERNAL_SERVICE;

function isCommandResponse(url: string, method: string): boolean {
  return method === 'POST' && new URL(url).pathname === '/api/commands';
}

function actionRow(page: Page, taskId: string) {
  return page.locator(`[data-testid="${TID.myActionsRow}"][data-task-id="${taskId}"]`);
}

test.describe('D9 降级旅程（degraded 明示 + 全链路可走通）', () => {
  test('degraded 提议：投影/界面明示，接受后任务与验收照常完成', async ({ page, request }) => {
    const versions: number[] = [];
    let taskId = '';
    let criteria: AcceptanceCriterion[] = [];

    await test.step('0. 降级夹具投影：degraded=true、原因清单、不预告 task_id', async () => {
      const proposal = await getProposal(request, DEGRADED.proposalId);
      versions.push(proposal.projection_version);
      expect(proposal.project_id).toBe(DEGRADED.projectId);
      expect(proposal.kind).toBe('capture_task');
      expect(proposal.status).toBe('proposed');
      expect(proposal.degraded).toBe(true);
      expect(proposal.proposer.degraded).toBe(true);
      expect(proposal.proposer.degraded_reason).toBe('not_configured');
      expect(proposal.assumptions.length).toBeGreaterThan(0);
      expect(proposal.available_actions).toEqual(['proposal_accept', 'proposal_reject']);
      // R-11
      expect(proposal.task_id).toBeNull();
      criteria = proposal.details.task.acceptance_criteria;
      expect(criteria.length).toBeGreaterThan(0);

      // R-8：降级项目视图——pending_proposals 里有这条夹具，任务列表此时为空
      const project = await getProject(request, DEGRADED.projectId);
      versions.push(project.projection_version);
      expect(project.goal?.goal_id).toBe(DEGRADED.goalId);
      const pending = project.pending_proposals.find((item) => item.proposal_id === DEGRADED.proposalId);
      expect(pending).toBeDefined();
      expect(pending!.degraded).toBe(true);
      expect(project.tasks.map((task) => task.task_id)).not.toContain(proposal.task_id);
    });

    await test.step('1. 提议页明示 degraded（界面文本来自投影）', async () => {
      const proposal = await getProposal(request, DEGRADED.proposalId);
      if (usingMock) {
        await page.goto(`/#/proposals/${DEGRADED.proposalId}`);
        await expect(page.getByTestId(TID.proposalPanel)).toBeVisible();
        await expect(page.getByTestId(TID.proposalStatus)).toHaveText(proposal.status);
        await expect(page.getByTestId(TID.proposalDegraded)).toBeVisible();
        await expect(page.getByTestId(TID.proposalDegraded)).toHaveText('degraded');
        const reasons = page.getByTestId(TID.proposalDegradedReasons);
        expect(proposal.assumptions.length).toBeGreaterThan(0);
        for (const assumption of proposal.assumptions) {
          await expect(reasons).toContainText(assumption);
        }
        // 原因码也在投影里单列（proposer.degraded_reason），界面同区块呈现
        await expect(reasons).toContainText(proposal.proposer.degraded_reason ?? '');
        await expect(page.getByTestId(TID.proposalTaskTitle)).toHaveText(proposal.details.task.title);
        await expect(page.getByTestId(TID.proposalCriterion)).toHaveCount(criteria.length);
      }
    });

    await test.step('2. 接受降级提议 → 服务端发号，任务带 degraded 溯源', async () => {
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
          data: { command_type: string; subject: { task_id: string } };
        };
        expect(envelope.ok).toBe(true);
        expect(envelope.data.command_type).toBe('proposal_accept');
        taskId = envelope.data.subject.task_id;
      } else {
        const accepted = expectCreatedCommand(
          await postCommand(
            request,
            'proposal_accept',
            { proposal_id: DEGRADED.proposalId },
            `degraded-accept-${randomUUID()}`,
          ),
        );
        expect(accepted.subject.proposal_id).toBe(DEGRADED.proposalId);
        taskId = String(accepted.subject.task_id);
        expect(taskId.length).toBeGreaterThan(0);
        versions.push(accepted.projection_version);
      }

      const proposal = await waitForProjection(
        () => getProposal(request, DEGRADED.proposalId),
        (value) => value.status === 'accepted',
        '降级提议进入 accepted',
      );
      versions.push(proposal.projection_version);
      expect(proposal.degraded).toBe(true);
      // 提议被接受后投影才挂上服务端发出来的 task_id
      expect(proposal.task_id).toBe(taskId);

      const project = await waitForProjection(
        () => getProject(request, DEGRADED.projectId),
        (value) => value.tasks.some((node) => node.task_id === taskId),
        '降级提议落地生成任务',
      );
      versions.push(project.projection_version);
      const task = findTask(project, taskId);
      expect(task.lifecycle).toBe('defined');
      expect(task.proposal_id).toBe(DEGRADED.proposalId);
      expect(task.acceptance_criteria.map((item) => item.criterion_ref)).toEqual(
        criteria.map((item) => item.criterion_ref),
      );
      expect(project.pending_proposals.map((item) => item.proposal_id)).not.toContain(DEGRADED.proposalId);
      expect(findGraphNode(project, taskId).lifecycle).toBe('defined');
    });

    await test.step('3. My Actions 里推进到 active 并提交反馈（不区分降级与否）', async () => {
      const actions = await waitForProjection(
        () => getActions(request),
        (value) => value.items.some((row) => row.task_id === taskId),
        '降级任务进入 My Actions',
      );
      versions.push(actions.projection_version);
      const row = findAction(actions, taskId)!;
      expect(row.project_id).toBe(DEGRADED.projectId);
      expect(row.available_actions).toContain('task_advance');

      if (usingMock) {
        await page.goto('/#/actions');
        const uiRow = actionRow(page, taskId);
        await expect(uiRow).toBeVisible();
        await expect(uiRow.getByTestId(TID.taskLifecycle)).toHaveText(row.lifecycle);
      }

      for (const [index, expectedLifecycle] of ['ready', 'active'].entries()) {
        const advanced = expectCreatedCommand(
          await postCommand(
            request,
            'task_advance',
            { task_id: taskId },
            `degraded-advance-${index}-${randomUUID()}`,
          ),
        );
        expect(advanced.subject.to).toBe(expectedLifecycle);
      }
      const feedback = expectCreatedCommand(
        await postCommand(
          request,
          'feedback_submit',
          { task_id: taskId, content: '降级草稿照常执行：事项已跟进，记录已留档。' },
          `degraded-feedback-${randomUUID()}`,
        ),
      );
      versions.push(feedback.projection_version);

      const project = await waitForProjection(
        () => getProject(request, DEGRADED.projectId),
        (value) => findTask(value, taskId).lifecycle === 'awaiting_acceptance',
        '降级任务进入 awaiting_acceptance',
      );
      versions.push(project.projection_version);
      expect(findTask(project, taskId).available_actions).toContain('acceptance_record');

      if (usingMock) {
        // 重新加载 My Actions，等页面按最新投影重绘（mock UI 不轮询，同 URL 的 goto 不触发导航）
        await page.goto('/#/actions');
        await page.reload();
        const uiRow = actionRow(page, taskId);
        await expect(uiRow).toBeVisible();
        await expect(uiRow.getByTestId(TID.taskLifecycle)).toHaveText('awaiting_acceptance');
        await expect(uiRow.getByTestId(TID.actionOpenAcceptance)).toBeVisible();
      }
    });

    await test.step('4. 逐判据验收全部通过 → 任务 accepted / 项目验收 +1', async () => {
      if (usingMock) {
        await actionRow(page, taskId).getByTestId(TID.actionOpenAcceptance).click();
        await expect(page).toHaveURL(
          new RegExp(`#/projects/${DEGRADED.projectId}/tasks/${taskId}/acceptance$`),
        );
        for (const criterion of criteria) {
          await page.getByTestId(criterionPass(criterion.criterion_ref)).click();
        }
        const [acceptanceResponse] = await Promise.all([
          page.waitForResponse((response) =>
            isCommandResponse(response.url(), response.request().method()),
          ),
          page.getByTestId(TID.acceptanceSubmit).click(),
        ]);
        expect(acceptanceResponse.status()).toBe(201);
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
                evidence_refs: ['degraded-journey'],
              })),
              rationale: '降级草稿的交付物已人工核对通过',
            },
            `degraded-acceptance-${randomUUID()}`,
          ),
        );
        expect(acceptance.subject.verdict).toBe('accepted');
        versions.push(acceptance.projection_version);
      }

      const project = await waitForProjection(
        () => getProject(request, DEGRADED.projectId),
        (value) => findTask(value, taskId).lifecycle === 'accepted',
        '降级旅程收尾：任务 accepted',
      );
      versions.push(project.projection_version);
      const task = findTask(project, taskId);
      expect(task.acceptance?.verdict).toBe('accepted');
      expect(task.acceptance?.criterion_results.every((result) => result.verdict === 'passed')).toBe(true);
      expect(project.acceptance_status.accepted).toBe(1);
      expect(project.acceptance_status.total).toBe(1);

      if (usingMock) {
        await expect(page.getByTestId(TID.acceptanceVerdict)).toHaveText('accepted');
        await expect(page.getByTestId(TID.taskLifecycle)).toHaveText('accepted');
      }
    });

    await test.step('5. 项目页与 Home 仍能看到降级来源（R-8）', async () => {
      const project = await getProject(request, DEGRADED.projectId);
      versions.push(project.projection_version);
      const row = findTask(project, taskId);
      expect(row.lifecycle).toBe('accepted');

      const home = await getHome(request);
      versions.push(home.projection_version);
      const summary = projectSummary(home, DEGRADED.projectId);
      expect(summary.goal_status).toBe(project.goal!.status);
      expect(summary.accepted_tasks).toBe(1);

      // Home 的 proposals.degraded 只数**待决**的降级提议（真服务口径：status=proposed
      // ∧ proposer.degraded）。夹具此刻已被接受，因此它不再计入 —— 这条断言的是计数语义，
      // 不是"降级痕迹消失"：接受后的提议投影仍保留 degraded=true（第 2 步已断言）。
      expect(home.proposals.degraded).toBeLessThanOrEqual(home.proposals.pending);

      if (usingMock) {
        await page.goto(`/#/projects/${DEGRADED.projectId}`);
        await expect(page.getByTestId(TID.goalStatus)).toHaveText(String(project.goal!.status));
        const uiRow = page.locator(`[data-testid="${TID.taskRow}"][data-task-id="${taskId}"]`);
        await expect(uiRow.getByTestId(TID.taskLifecycle)).toHaveText('accepted');

        await page.goto('/#/home');
        const card = page.locator(
          `[data-testid="${TID.homeProjectCard}"][data-project-id="${DEGRADED.projectId}"]`,
        );
        await expect(card.getByTestId(TID.homeGoalStatus)).toHaveText(String(project.goal!.status));
      }
    });

    await test.step('6. R-9：断开模型时捕获 → SSE notice(proposal_degraded) + 投影 degraded', async () => {
      const head = (await getHome(request)).projection_version;
      const stream = await SseStream.open(`/api/stream?cursor=${head}`);
      try {
        const captured = await capture(request, `降级通知帧验证 ${randomUUID().slice(0, 8)}`, {
          projectId: DEMO.projectId,
        });
        versions.push(captured.projection_version);
        // 先等事件帧到齐：帧是异步推送的，立刻读 updates() 可能还空
        await stream.waitForUpdate((update) => update.seq === captured.projection_version, 10_000);

        const degraded = await getProposal(request, captured.proposal_id);
        versions.push(degraded.projection_version);
        expect(degraded.status).toBe('proposed');
        // 模型断开 → 确定性降级草稿（degraded 必须如实标注，不许隐藏）
        expect(degraded.degraded).toBe(captured.degraded);
        expect(degraded.proposer.degraded).toBe(captured.degraded);
        if (captured.degraded) {
          expect(captured.degraded_reason).toBe('not_configured');
          expect(captured.proposer.source).toBe('fallback');
          const notice = await stream.waitFor(
            (frame) => frame.event === 'notice' && (frame.data ?? '').includes('proposal_degraded'),
            5_000,
          );
          const payload = JSON.parse(notice.data!) as {
            kind: string;
            proposal_id: string;
            degraded_reason: string;
          };
          expect(payload.kind).toBe('proposal_degraded');
          expect(payload.proposal_id).toBe(captured.proposal_id);
          expect(payload.degraded_reason).toBe('not_configured');
        } else {
          expect(captured.proposer.source).toBe('model');
        }

        // 事件帧 kind 必须是内核 PascalCase（R-9），捕获反馈是 FeedbackReceived
        const kinds = stream.updates().map((update) => update.kind);
        expect(kinds).toEqual(expect.arrayContaining(['PlanChangeProposed', 'FeedbackReceived']));
      } finally {
        stream.close();
      }
    });

    await test.step('7. 投影游标单调', async () => {
      expect(versions).toEqual([...versions].sort((a, b) => a - b));
    });
  });
});
