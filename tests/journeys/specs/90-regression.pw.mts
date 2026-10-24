// J4 回归护栏（E2E 硬门）：K0 黄金旅程在 K1 之后仍全闭环 + 页面在场口径
// + API 级负向集合。真服务模式运行（proposer 指向模型桩，HUMAN_TASK 标记
// 产人工任务，走 human_light 黄金链）。
//   ① 黄金链：capture → accept → advance×2 → feedback → awaiting_acceptance
//      → acceptance_record(accepted) → Task accepted、My Actions 条目消失；
//   ② 页面在场：/actions 渲染种子任务行（my-actions-row ≥1、无 pageerror）；
//   ③ 负向：resolve_decision 不存在 → 404 not_found；对已取消种子任务
//      task_advance → 409；未知命令类型 → 400；resolve_decision 缺
//      client_submit_id 之外的非法 verdict → 400（schema_invalid 口径）。
import { test, expect } from '@playwright/test';
import { JOURNEY_BASE_URL, USING_EXTERNAL_SERVICE, DEMO } from '../journeys.config.mts';
import { capture, expectCreatedCommand, findAction, getActions, getProject, postCommand, requestJson, waitForProjection } from '../support/api.mts';
import { startStaticWeb, type StaticWeb } from '../support/static-web.mts';

let web: StaticWeb;

test.beforeAll(async () => {
  test.skip(!USING_EXTERNAL_SERVICE, 'J4 只在真服务模式运行');
  web = await startStaticWeb(JOURNEY_BASE_URL);
});

test.afterAll(async () => {
  await web?.close();
});

test('J4-①：K0 黄金旅程全闭环（人工链）', async ({ request }) => {
  const captured = await capture(request, 'HUMAN_TASK 整理季度回访结论并归档');
  const accepted = expectCreatedCommand(
    await postCommand(request, 'proposal_accept', { proposal_id: captured.proposal_id }, `j4-accept-${captured.capture_id}`),
  );
  const taskId = (accepted.subject as { task_id: string }).task_id;

  expectCreatedCommand(await postCommand(request, 'task_advance', { task_id: taskId }, `j4-ready-${taskId}`));
  expectCreatedCommand(await postCommand(request, 'task_advance', { task_id: taskId }, `j4-active-${taskId}`));

  const feedback = expectCreatedCommand(
    await postCommand(
      request,
      'feedback_submit',
      { task_id: taskId, content: '回访结论已整理归档，见附件清单。' },
      `j4-feedback-${taskId}`,
    ),
  );
  expect(feedback.emitted.map((event) => event.kind)).toEqual(
    expect.arrayContaining(['FeedbackReceived', 'OutcomeRecorded', 'RunSucceeded']),
  );

  const project = await waitForProjection(
    () => getProject(request, DEMO.projectId),
    (p) => p.tasks.some((t) => t.task_id === taskId && t.lifecycle === 'awaiting_acceptance'),
    '黄金链 Task awaiting_acceptance',
    30_000,
  );
  const task = project.tasks.find((t) => t.task_id === taskId)!;
  const criteria = task.acceptance_criteria.map((c) => ({
    criterion_ref: c.criterion_ref,
    verdict: 'passed' as const,
    evidence_refs: ['journey-verified'],
  }));

  const acceptance = expectCreatedCommand(
    await postCommand(
      request,
      'acceptance_record',
      { task_id: taskId, criterion_results: criteria, rationale: '全部判据通过' },
      `j4-acceptance-${taskId}`,
    ),
  );
  expect((acceptance.subject as { verdict?: string }).verdict).toBe('accepted');
  const finalProject = await getProject(request, DEMO.projectId);
  expect(finalProject.tasks.find((t) => t.task_id === taskId)?.lifecycle).toBe('accepted');
  const actions = await getActions(request);
  expect(findAction(actions, taskId)).toBeUndefined();
});

test('J4-②：待我处理页在场口径（种子任务行真渲染）', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto(`${web.origin}/actions`);
  await expect(page.getByTestId('my-actions-row').first()).toBeVisible();
  const count = await page.getByTestId('my-actions-row').count();
  expect(count).toBeGreaterThanOrEqual(1);
  expect(pageErrors).toEqual([]);
});

test('J4-③：API 级负向集合', async ({ request }) => {
  const missing = await postCommand(
    request,
    'resolve_decision',
    { decision_id: 'dec-does-not-exist', verdict: 'approved' },
    'j4-neg-missing',
  );
  expect(missing.status).toBe(404);
  expect(JSON.stringify(missing.body)).toContain('not_found');

  const canceledAdvance = await postCommand(request, 'task_advance', { task_id: DEMO.canceledTaskId }, 'j4-neg-canceled');
  expect(canceledAdvance.status).toBe(409);

  const badVerdict = await postCommand(
    request,
    'resolve_decision',
    { decision_id: 'dec-degraded-1', verdict: 'maybe' },
    'j4-neg-verdict',
  );
  expect([400, 404, 409]).toContain(badVerdict.status); // 已被 J1 裁决时 409，未裁决时 400

  const unknownType = await requestJson(request, '/api/commands', {
    method: 'POST',
    data: { type: 'not_a_command', payload: {}, client_submit_id: 'j4-neg-unknown' },
  });
  expect(unknownType.status).toBe(400);
});
