// J2 节点执行旅程（K1-B，E2E 硬门）：真服务 + 真 node-agent 子进程
// （local 传输，CI 无 Docker/ah1；ah1 docker 传输已在 xc 真跑验证）。
// 服务端 proposer 指向 journeys 模型桩（MAGPIE_BASE_URL），capture 恒产
// agent 任务。旅程：
//   ① 拉起 agent → 节点 online 在场（GET /api/nodes）；
//   ② 建 agent Task → task_advance 派发 → 节点真执行 → 回读 Run
//      succeeded + Task awaiting_acceptance；
//   ③ 杀 agent → 再建一单 → Run queued 且 state_reason=awaiting_node
//      （服务端以短阈值启动：XUXING_NODE_STALE_SEC=3/OFFLINE_SEC=8）；
//   ④ 重启 agent（node_id 复用）→ 第二单自动续派完成。
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOURNEY_BASE_URL, USING_EXTERNAL_SERVICE, DEMO } from '../journeys.config.mts';
import { capture, expectCreatedCommand, findAction, getActions, getNodes, getProject, postCommand, waitForProjection } from '../support/api.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const agentEntry = path.resolve(here, '../../../node-agent/src/agent.mjs');
const workDir = mkdtempSync(path.join(tmpdir(), 'k1-j2-'));

let agent: ChildProcess | undefined;
let agentLog = '';

function startAgent(): ChildProcess {
  const child = spawn(process.execPath, [agentEntry], {
    env: {
      ...process.env,
      XUXING_SERVER_URL: JOURNEY_BASE_URL,
      XUXING_NODE_TOKEN: process.env.JOURNEY_NODE_TOKEN ?? 'journey-node-token',
      XUXING_NODE_NAME: 'journey-node',
      XUXING_HANDS_TRANSPORT: 'local',
      XUXING_NODE_ID_FILE: path.join(workDir, 'node-id'),
      XUXING_RECORDS_DIR: path.join(workDir, 'records'),
      XUXING_POLL_WAIT_SEC: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => {
    agentLog += d.toString();
  });
  child.stderr?.on('data', (d) => {
    agentLog += d.toString();
  });
  return child;
}

async function stopAgent(): Promise<void> {
  if (!agent) return;
  const child = agent;
  agent = undefined;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
}

async function makeAgentRun(request: Parameters<typeof capture>[0], commandText: string): Promise<{ taskId: string; runId: string }> {
  const captured = await capture(request, '在节点上执行检查命令');
  const accepted = expectCreatedCommand(
    await postCommand(request, 'proposal_accept', { proposal_id: captured.proposal_id }, `j2-accept-${captured.capture_id}`),
  );
  const taskId = (accepted.subject as { task_id: string }).task_id;
  expectCreatedCommand(await postCommand(request, 'task_advance', { task_id: taskId }, `j2-ready-${taskId}`));
  const active = expectCreatedCommand(
    await postCommand(request, 'task_advance', { task_id: taskId, command: commandText }, `j2-active-${taskId}`),
  );
  const runId = (active.subject as { run_id: string }).run_id;
  expect(runId).toBeTruthy();
  return { taskId, runId };
}

test.beforeAll(async () => {
  test.skip(!USING_EXTERNAL_SERVICE, 'J2 只在真服务模式运行');
});

test.afterAll(async () => {
  await stopAgent();
});

test('J2：节点领活真执行、离线挂起 awaiting_node、回归续派', async ({ request }) => {
  test.setTimeout(180_000);
  agent = startAgent();

  // ① 节点注册并 online 在场
  const nodes = await waitForProjection(
    () => getNodes(request),
    (value) => value.nodes.some((n) => n.display_name === 'journey-node' && n.status === 'online'),
    '节点 journey-node online',
    30_000,
  );
  const nodeId = nodes.nodes.find((n) => n.display_name === 'journey-node')!.node_id;
  expect(nodeId).toBeTruthy();

  // ② 第一单：真执行到 succeeded
  const first = await makeAgentRun(request, 'echo J2_FIRST_OK');
  const project1 = await waitForProjection(
    () => getProject(request, DEMO.projectId),
    (p) => p.runs.some((r) => r.run_id === first.runId && r.state === 'succeeded'),
    '第一单 Run succeeded',
    60_000,
  );
  expect(project1.tasks.find((t) => t.task_id === first.taskId)?.lifecycle).toBe('awaiting_acceptance');
  expect(agentLog).toContain('run_result_reported');

  // ③ 杀节点 → 第二单挂起 awaiting_node（节点先翻 offline/stale 不可派）
  await stopAgent();
  const second = await makeAgentRun(request, 'echo J2_SECOND_OK');
  const project2 = await waitForProjection(
    () => getProject(request, DEMO.projectId),
    (p) => p.runs.some((r) => r.run_id === second.runId && r.state === 'queued' && r.state_reason === 'awaiting_node'),
    '第二单 queued + awaiting_node',
    60_000,
  );
  expect(project2.runs.find((r) => r.run_id === second.runId)?.state).toBe('queued');

  // ④ 重启节点（同一 node_id 文件）→ 自动续派完成；My Actions 中该任务可验收
  agent = startAgent();
  await waitForProjection(
    () => getProject(request, DEMO.projectId),
    (p) => p.runs.some((r) => r.run_id === second.runId && r.state === 'succeeded'),
    '第二单续派 succeeded',
    60_000,
  );
  const actions = await getActions(request);
  expect(findAction(actions, second.taskId)?.available_actions).toContain('acceptance_record');

  await stopAgent();
});
