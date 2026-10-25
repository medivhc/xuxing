// 页面级冒烟（WHITESCREEN-FIX-1024 补盲区）：真实前端构建产物 × 真服务。
//
// 此前旅程全是 API 级断言 + mock 自带 UI，真实 web/dist 从未在真服务上被浏览器
// 加载过——/api/home 缺 attention 字段让已部署首页整页白屏，正是这样漏到公网的。
// 本 spec 按生产拓扑（静态托管 + /api 反代，即部署 B 案）在测试内起一个静态
// 服务器：web/dist 直出、/api/* 流式反代到 JOURNEY_BASE_URL，然后用真实浏览器
// 加载首页，断言 #root 非空、四入口导航可见、种子项目卡片渲染、
// 「需要关注」「最近活动」两段在场，且全程无未捕获页面错误（pageerror）。
//
// 仅真服务模式有意义：mock 模式服务的是 mock 自带 UI 而非 web/dist，故跳过。
// 前置：web/dist 必须已构建（npm --prefix web run build），缺失时 beforeAll
// 直接报错而不是静默跳过——这条 spec 就是为堵部署前盲区而设。
//
// FIX-ROUND-3 扩充（CLICK-AUDIT 复盘）：
// - 首页断言补 computed-style：Tailwind 工具类曾整批未生成（CSS 入口缺
//   @tailwind），文本断言全过、页面却是裸 HTML——样式必须直接验产物效果；
// - FIX-ROUND-4 新增待我处理页真形状渲染：任务项曾被误判为 decision 行
//   只出下线占位卡（ACTIONS-EMPTY-1024），断言任务项标题/动作按钮在场。
// - K1 移植（feat/k1 → ab1504e）：/api/actions 条目是 K1 §3.6 的封闭联合
//   kind ∈ {task, decision}，故标题断言按 kind 取 title / question，并断言
//   decision 条目的裁决面开关与 decision 条目同数（断言不删不减）。
// - 新增项目页/提议页两条真形状渲染：两页曾按 mock 形状读真投影而崩
//   （acceptance_status / proposed 包装层），种子数据驱动、不依赖 magpie。

import { test, expect } from '@playwright/test';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOURNEY_BASE_URL, USING_EXTERNAL_SERVICE } from '../journeys.config.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, '../../../web/dist');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

let server: Server | undefined;
let origin = '';

test.beforeAll(async () => {
  test.skip(!USING_EXTERNAL_SERVICE, '页面级冒烟只在真服务模式（JOURNEY_BASE_URL 已设）运行');
  if (!existsSync(path.join(distDir, 'index.html'))) {
    throw new Error(`web/dist 未构建：${distDir}（先执行 npm --prefix web run build）`);
  }
  const apiBase = new URL(JOURNEY_BASE_URL);
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://static.local');
    if (url.pathname.startsWith('/api/')) {
      // 流式反代（含 SSE /api/stream 不缓冲直通，与 Caddy flush_interval -1 同口径）
      const proxy = httpRequest(
        {
          hostname: apiBase.hostname,
          port: apiBase.port || undefined,
          path: url.pathname + url.search,
          method: req.method,
          headers: { ...req.headers, host: apiBase.host },
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      proxy.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end('proxy error');
      });
      req.pipe(proxy);
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const filePath = path.join(distDir, rel);
    readFile(filePath)
      .then((body) => {
        res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
        res.end(body);
      })
      .catch(async () => {
        // 前端路由路径（BrowserRouter）回退 index.html；真不存在的资产由 index 兜底亦无碍断言
        try {
          const body = await readFile(path.join(distDir, 'index.html'));
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(body);
        } catch {
          res.writeHead(404);
          res.end();
        }
      });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('静态服务器监听失败');
  origin = `http://127.0.0.1:${addr.port}`;
});

test.afterAll(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve) => server!.close(resolve));
});

test('页面级冒烟：真服务 + 真实构建产物，首页完整渲染不白屏', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await page.goto(`${origin}/`);

  // 种子项目卡片渲染出来 = 数据面（/api/home 投影）与渲染面同时成立
  await expect(page.getByTestId('home-project-card').first()).toBeVisible();
  await expect(
    page.getByTestId('home-project-card').filter({ hasText: '续行' }).first(),
  ).toBeVisible();

  // #root 非空：整树未被渲染异常卸载（白屏的直接判定）
  const rootChildren = await page.evaluate(
    () => document.getElementById('root')?.childElementCount ?? 0,
  );
  expect(rootChildren).toBeGreaterThan(0);

  // 四入口导航文本可见
  for (const label of ['首页', '快速捕获', '待我处理', '项目']) {
    await expect(page.getByRole('link', { name: label, exact: true }).first()).toBeVisible();
  }

  // Home 三段齐：项目（已验卡片）+ 需要关注 + 最近活动
  await expect(page.getByRole('heading', { name: '需要关注' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '最近活动' })).toBeVisible();
  // 「需要关注」段要么有行、要么是空态文案——两种都合法，但不许整段消失
  const attentionRows = await page.getByTestId('home-attention-row').count();
  if (attentionRows === 0) {
    await expect(page.getByText('暂无需要关注的事项。')).toBeVisible();
  }

  // 样式断言（FIX-ROUND-3）：项目卡必须真的吃到 Tailwind 工具类效果——
  // 边框 1px、白底、圆角 8px、阴影非 none；header 布局容器 display 必须为 flex。
  // CSS 未接线时这些全是 0/transparent/none/block，文本断言却照样全过。
  const cardStyle = await page
    .getByTestId('home-project-card')
    .first()
    .evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        borderTopWidth: cs.borderTopWidth,
        backgroundColor: cs.backgroundColor,
        borderRadius: cs.borderRadius,
        boxShadow: cs.boxShadow,
      };
    });
  expect(cardStyle.borderTopWidth).toBe('1px');
  expect(cardStyle.backgroundColor).toBe('rgb(255, 255, 255)');
  expect(cardStyle.borderRadius).toBe('8px');
  expect(cardStyle.boxShadow).not.toBe('none');
  const headerDisplay = await page
    .locator('header .flex')
    .first()
    .evaluate((el) => getComputedStyle(el).display);
  expect(headerDisplay).toBe('flex');

  // 全程无未捕获页面错误（attention 类 TypeError 正是死在这里）
  expect(pageErrors).toEqual([]);
});

// ---------- FIX-ROUND-3：项目页真形状渲染 ----------

interface ApiEnvelope<T> {
  ok: boolean;
  data: T;
}

test('页面级冒烟：项目页按真投影形状渲染（验收计数/任务行/判据汇总）', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  const homeRes = await page.request.get(`${origin}/api/home`);
  expect(homeRes.ok()).toBeTruthy();
  const home = (await homeRes.json()) as ApiEnvelope<{
    projects: Array<{ project_id: string; name: string }>;
  }>;
  expect(home.data.projects.length).toBeGreaterThan(0);
  const project = home.data.projects[0]!;

  await page.goto(`${origin}/projects/${project.project_id}`);

  // 标题 + 验收计数行（真 acceptance_status 四计数）+ 任务行渲染
  await expect(page.getByRole('heading', { name: project.name })).toBeVisible();
  await expect(page.getByText(/已验收 \d+ 项 · 待验收 \d+ 项/)).toBeVisible();
  await expect(page.getByTestId('project-task-list')).toBeVisible();
  expect(await page.getByTestId('project-task-row').count()).toBeGreaterThan(0);

  expect(pageErrors).toEqual([]);
});

test('页面级冒烟：提议页按真形状渲染（details.task 草案与判据）', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  // 从种子项目的待处理提议里找一条（种子驱动，不依赖 magpie 现场生成）
  const homeRes = await page.request.get(`${origin}/api/home`);
  const home = (await homeRes.json()) as ApiEnvelope<{
    projects: Array<{ project_id: string }>;
  }>;
  let proposalId = '';
  for (const project of home.data.projects) {
    const res = await page.request.get(`${origin}/api/projects/${project.project_id}`);
    if (!res.ok()) continue;
    const view = (await res.json()) as ApiEnvelope<{
      pending_proposals: Array<{ proposal_id: string }>;
    }>;
    if (view.data.pending_proposals.length > 0) {
      proposalId = view.data.pending_proposals[0]!.proposal_id;
      break;
    }
  }
  expect(proposalId, '种子数据中应至少有一条待处理提议').not.toBe('');

  const propRes = await page.request.get(`${origin}/api/proposals/${proposalId}`);
  expect(propRes.ok()).toBeTruthy();
  const proposal = (await propRes.json()) as ApiEnvelope<{
    details: { kind: string; task?: { title: string; acceptance_criteria: unknown[] } };
  }>;
  expect(proposal.data.details.kind).toBe('capture_task');

  await page.goto(`${origin}/capture/${proposalId}`);

  // 提议详情标题 + 草案标题 + 判据段（真 details.task 形状）渲染
  await expect(page.getByRole('heading', { name: '提议详情' })).toBeVisible();
  await expect(page.getByText(proposal.data.details.task!.title).first()).toBeVisible();
  await expect(
    page.getByText(new RegExp(`验收判据（${proposal.data.details.task!.acceptance_criteria.length} 条）`)),
  ).toBeVisible();

  expect(pageErrors).toEqual([]);
});

// ---------- FIX-ROUND-4：待我处理页真形状渲染 ----------

test('页面级冒烟：待我处理页按真形状渲染任务项（标题/项目/动作按钮）', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  // 真值以 /api/actions 为准：种子应至少有可执行任务项
  const actionsRes = await page.request.get(`${origin}/api/actions`);
  expect(actionsRes.ok()).toBeTruthy();
  const actions = (await actionsRes.json()) as ApiEnvelope<{
    items: Array<{
      kind: 'task' | 'decision';
      task_id: string | null;
      title: string | null;
      question: string | null;
      available_actions: string[];
    }>;
  }>;
  expect(actions.data.items.length).toBeGreaterThan(0);

  await page.goto(`${origin}/actions`);

  // 行数与接口逐条一致，且不再出现决策下线占位卡（ACTIONS-EMPTY-1024 的
  // 呈现层脱节：任务项被误判为 decision 行、任务一条不渲染）
  await expect(page.getByTestId('my-actions-row')).toHaveCount(actions.data.items.length);
  await expect(page.getByTestId('decision-action-offline')).toHaveCount(0);

  // K1 §3.6 起 items 是封闭联合（kind ∈ {task, decision}）：task 条目的
  // title、decision 条目的 question 都必须真渲染出来（不是「页面不崩」）；
  // decision 条目带可展开的裁决面，故裁决面开关数与 decision 条目数相等。
  const decisionItems = actions.data.items.filter((item) => item.kind === 'decision');
  await expect(page.getByTestId('decision-resolve-toggle')).toHaveCount(decisionItems.length);

  // 种子任务标题在场（种子 active 任务 task_demo_contact）
  await expect(page.getByText('联系张三确认方案')).toBeVisible();
  for (const item of actions.data.items) {
    const label = item.kind === 'task' ? item.title : item.question;
    expect(label, `${item.kind} 条目的展示文案不应为空`).toBeTruthy();
    await expect(page.getByText(label!, { exact: true }).first()).toBeVisible();
  }

  // 动作按钮在场（以接口真值为准，不硬编码构成）：有 feedback_submit 的
  // 任务 → 反馈输入与提交按钮；有 task_advance 的任务 → 推进按钮
  if (actions.data.items.some((i) => i.available_actions.includes('feedback_submit'))) {
    await expect(page.getByTestId('action-feedback-input').first()).toBeVisible();
    await expect(page.getByTestId('action-feedback-submit').first()).toBeVisible();
  }
  if (actions.data.items.some((i) => i.available_actions.includes('task_advance'))) {
    await expect(page.getByTestId('action-task-advance').first()).toBeVisible();
  }

  expect(pageErrors).toEqual([]);
});
