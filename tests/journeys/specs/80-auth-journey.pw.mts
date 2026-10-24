// J3 未授权拦截旅程（K1-C，E2E 硬门）：第二实例（同库、独立端口、双令牌
// 开启）+ 全新浏览器上下文。
//   ① 无凭据：页面只见入口门（auth-gate 在场），DOM 零业务数据（无项目名、
//      无导航四入口）；
//   ② 错令牌提交 → 仍在门前（auth-gate-error 在场、业务数据仍零）；
//   ③ 对令牌 → 进应用，四入口可用、项目卡片渲染；
//   ④ 裸 HTTP 401 集合：无令牌读面 401、节点令牌打用户面 401、用户令牌打
//      节点面 401、health 豁免 200。
// 主实例（CI 的 8787）保持无令牌口径供其余旅程使用，本 spec 自带实例自清理。
import { test, expect, request as playwrightRequest } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USING_EXTERNAL_SERVICE } from '../journeys.config.mts';
import { startStaticWeb, type StaticWeb } from '../support/static-web.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverMain = path.resolve(here, '../../../server/dist/server/src/main.js');
const PORT = 8897;
const BASE = `http://127.0.0.1:${PORT}`;
const PG_URL = process.env.JOURNEY_PG_URL ?? 'postgres://postgres:postgres@127.0.0.1:55432/xuxing';
const USER_TOKEN = 'j3-user-token-0123456789';
const NODE_TOKEN = 'j3-node-token-0123456789';

let server: ChildProcess | undefined;
let web: StaticWeb;

async function waitHealthy(): Promise<void> {
  const ctx = await playwrightRequest.newContext();
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await ctx.get(`${BASE}/api/health`);
      if (res.ok()) {
        const body = await res.json();
        if (body?.data?.auth_enabled === true) return;
      }
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) throw new Error('J3 第二实例未在 60s 内健康（auth_enabled=true）');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

test.beforeAll(async () => {
  test.skip(!USING_EXTERNAL_SERVICE, 'J3 只在真服务模式运行');
  server = spawn(process.execPath, [serverMain], {
    env: {
      ...process.env,
      XUXING_PG_URL: PG_URL,
      XUXING_PORT: String(PORT),
      XUXING_HOST: '127.0.0.1',
      XUXING_ACCESS_TOKEN: USER_TOKEN,
      XUXING_NODE_TOKEN: NODE_TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitHealthy();
  web = await startStaticWeb(BASE);
});

test.afterAll(async () => {
  await web?.close();
  if (server) {
    server.kill('SIGTERM');
    server = undefined;
  }
});

test('J3：未授权全新上下文只见入口门，对令牌后四入口可用 + 裸 HTTP 401 集合', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  // ① 无凭据：只有入口门，零业务数据
  await page.goto(`${web.origin}/`);
  await expect(page.getByTestId('auth-gate')).toBeVisible();
  await expect(page.getByTestId('home-project-card')).toHaveCount(0);
  await expect(page.getByRole('link', { name: '待我处理', exact: true })).toHaveCount(0);
  const domText = await page.evaluate(() => document.body.innerText);
  expect(domText).not.toContain('客户方案落地');

  // ② 错令牌：仍在门前
  await page.getByTestId('auth-gate-token').fill('wrong-token-000000000000');
  await page.getByTestId('auth-gate-submit').click();
  await expect(page.getByTestId('auth-gate-error')).toBeVisible();
  await expect(page.getByTestId('auth-gate')).toBeVisible();
  await expect(page.getByTestId('home-project-card')).toHaveCount(0);

  // ③ 对令牌：进应用、四入口可用、项目卡片渲染
  await page.getByTestId('auth-gate-token').fill(USER_TOKEN);
  await page.getByTestId('auth-gate-submit').click();
  await expect(page.getByTestId('auth-gate')).toHaveCount(0);
  await expect(page.getByTestId('home-project-card').first()).toBeVisible();
  for (const label of ['首页', '快速捕获', '待我处理', '项目']) {
    await expect(page.getByRole('link', { name: label, exact: true }).first()).toBeVisible();
  }
  expect(pageErrors).toEqual([]);
  await context.close();

  // ④ 裸 HTTP 401 集合（同一实例、不同凭据面）
  const ctx = await playwrightRequest.newContext();
  const noAuth = await ctx.get(`${BASE}/api/projects/proj_demo_oq05`);
  expect(noAuth.status()).toBe(401);
  const nodeOnUser = await ctx.get(`${BASE}/api/home`, { headers: { authorization: `Bearer ${NODE_TOKEN}` } });
  expect(nodeOnUser.status()).toBe(401);
  const userOnNode = await ctx.post(`${BASE}/api/nodes/register`, {
    headers: { authorization: `Bearer ${USER_TOKEN}` },
    data: { display_name: 'x', executor_kinds: ['agent_hands_shell'], max_side_effect_level: 'L1' },
  });
  expect(userOnNode.status()).toBe(401);
  const health = await ctx.get(`${BASE}/api/health`);
  expect(health.status()).toBe(200);
  const userOk = await ctx.get(`${BASE}/api/home`, { headers: { authorization: `Bearer ${USER_TOKEN}` } });
  expect(userOk.status()).toBe(200);
  await ctx.dispose();
});
