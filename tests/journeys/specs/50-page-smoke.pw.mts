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

  // 全程无未捕获页面错误（attention 类 TypeError 正是死在这里）
  expect(pageErrors).toEqual([]);
});
