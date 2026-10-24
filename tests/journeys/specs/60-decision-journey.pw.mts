// J1 决策旅程（K1-A，E2E 硬门）：真服务 + 真实前端构建产物。
// 种子夹具（server/src/seed/demo.ts）：proj-degraded 内两条 pending Decision
// （dec-degraded-1 → prop-degraded-decision，dec-degraded-2 →
// prop-degraded-decision-2）。旅程在「待我处理」页真点裁决：
//   ① 批准 dec-degraded-1 → 回读：Change applied、任务图新增任务、
//      decision 条目从 My Actions 消失；
//   ② 拒绝 dec-degraded-2（必填理由）→ 回读：Change rejected、任务图无新增、
//      条目消失。断言口径：在场 + 可点 + 状态真变（API 回读为准）。
import { test, expect } from '@playwright/test';
import { JOURNEY_BASE_URL, USING_EXTERNAL_SERVICE } from '../journeys.config.mts';
import { findDecisionAction, getActions, getProject, getProposal, postCommand } from '../support/api.mts';
import { startStaticWeb, type StaticWeb } from '../support/static-web.mts';

const PROJECT_ID = 'proj-degraded';
const DECISION_1 = 'dec-degraded-1';
const CHANGE_1 = 'prop-degraded-decision';
const DECISION_2 = 'dec-degraded-2';
const CHANGE_2 = 'prop-degraded-decision-2';

let web: StaticWeb;

test.beforeAll(async () => {
  test.skip(!USING_EXTERNAL_SERVICE, 'J1 只在真服务模式运行');
  web = await startStaticWeb(JOURNEY_BASE_URL);
});

test.afterAll(async () => {
  await web?.close();
});

test('J1：待我处理页裁决两条种子决策，批准落图、拒绝留痕', async ({ page, request }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  const before = await getProject(request, PROJECT_ID);
  const taskCountBefore = before.tasks.length;

  // 两条 decision 条目在场且广告 resolve_decision（API 与页面同源）
  const actions = await getActions(request);
  for (const id of [DECISION_1, DECISION_2]) {
    const item = findDecisionAction(actions, id);
    expect(item, `actions 应含 ${id}`).toBeTruthy();
    expect(item!.available_actions).toEqual(['resolve_decision']);
    expect(item!.kind).toBe('decision');
  }

  await page.goto(`${web.origin}/actions`);
  const rows = page.getByTestId('my-actions-row');
  // decision 行的判别特征是裁决面开关（批准落图的新任务标题与问题同名，
  // 只按文本过滤会把新任务行误算进来）。
  const decisionRow = (text: string) =>
    rows.filter({ hasText: text }).filter({ has: page.getByTestId('decision-resolve-toggle') });
  await expect(decisionRow('整理客户回访清单')).toHaveCount(1);
  await expect(decisionRow('归档旧版合同模板')).toHaveCount(1);

  // ① 批准 dec-degraded-1
  const row1 = decisionRow('整理客户回访清单');
  await row1.getByTestId('decision-resolve-toggle').click();
  await expect(row1.getByTestId('decision-resolve-panel')).toBeVisible();
  await row1.getByTestId('decision-verdict-approved').click();
  await row1.getByTestId('decision-submit').click();
  await expect(decisionRow('整理客户回访清单')).toHaveCount(0);

  // 回读：Change 已 applied、任务图 +1、actions 条目消失
  const change1 = await getProposal(request, CHANGE_1);
  expect(change1.status).toBe('applied');
  const afterApprove = await getProject(request, PROJECT_ID);
  expect(afterApprove.tasks.length).toBe(taskCountBefore + 1);
  const actionsAfterApprove = await getActions(request);
  expect(findDecisionAction(actionsAfterApprove, DECISION_1)).toBeUndefined();
  expect(findDecisionAction(actionsAfterApprove, DECISION_2)).toBeTruthy();

  // ② 拒绝 dec-degraded-2：空理由时提交按钮呈 disabled 态（前端拦截的
  // 实现形态，B-01 口径）——断言 disabled + 面板在场 + Decision 仍 pending
  // （API 回读，无请求发出）；服务端 400 兜底以同 payload 的 API 级断言
  // 在本旅程内补验；填理由后按钮启用再提交。
  const row2 = decisionRow('归档旧版合同模板');
  await row2.getByTestId('decision-resolve-toggle').click();
  await row2.getByTestId('decision-verdict-rejected').click();
  const submit2 = row2.getByTestId('decision-submit');
  await expect(submit2).toBeDisabled();
  await expect(row2.getByTestId('decision-resolve-panel')).toBeVisible();
  expect(findDecisionAction(await getActions(request), DECISION_2)).toBeTruthy();
  const badResolve = await postCommand(
    request,
    'resolve_decision',
    { decision_id: DECISION_2, verdict: 'rejected' },
    `j1-empty-reason-${Date.now()}`,
  );
  expect(badResolve.status).toBe(400);
  expect((badResolve.body as { error: { detail: unknown } }).error.detail).toMatchObject({
    reason: 'schema_invalid',
    field: 'reason',
  });
  expect(findDecisionAction(await getActions(request), DECISION_2)).toBeTruthy(); // 400 零效果
  await row2.getByTestId('decision-reason-input').fill('范围重复，归档另行立项');
  await expect(submit2).toBeEnabled();
  await submit2.click();
  await expect(decisionRow('归档旧版合同模板')).toHaveCount(0);

  const change2 = await getProposal(request, CHANGE_2);
  expect(change2.status).toBe('rejected');
  const afterReject = await getProject(request, PROJECT_ID);
  expect(afterReject.tasks.length).toBe(taskCountBefore + 1); // 拒绝不落图
  const actionsFinal = await getActions(request);
  expect(findDecisionAction(actionsFinal, DECISION_2)).toBeUndefined();

  expect(pageErrors).toEqual([]);
});
