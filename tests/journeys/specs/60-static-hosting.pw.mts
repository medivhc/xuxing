// 静态托管旅程（A 案，PHASE2）：真服务自托管 web/dist 的浏览器级验证。
//
// 与 spec50 的分工：spec50 在测试内自起静态服务器 + 反代模拟生产 B 案拓扑；
// 本 spec 打的是【服务端自己】的静态托管（A 案）——浏览器直接访问真服务同源
// 地址，不经任何测试内代理/静态垫片。断言口径（E2E 硬门）：在场 + 真状态：
// - 子路径直达 200 且页面真渲染（项目标题在场，不是只回 index.html 壳）；
// - 在子路径上刷新（reload）不 404、内容仍在场；
// - 页面加载期间全部 JS/CSS 资产响应 200（收集 response 事件逐条核）；
// - 同源 /api 真数据在场（首页项目卡来自 /api/home，不是缓存壳）；
// - SSE 同源连通：页面内 fetch /api/stream 读到 ready 帧。
//
// 仅真服务模式运行，且要求被测服务确实处于自托管形态：先探 GET / 的响应
// 是否为 SPA 的 index.html（含 <div id="root">）——不是自托管（纯 API 形态
// 返回 404）时整组跳过并注明，避免对 B 案/纯 API 部署误红。CI 的 journeys
// job 在启动真服务前已构建 web/dist，服务按缺省相对定位自动进入自托管，
// 本 spec 在 CI 里是实跑而非跳过。

import { test, expect } from '@playwright/test';
import { DEMO, JOURNEY_BASE_URL, USING_EXTERNAL_SERVICE } from '../journeys.config.mts';

test.beforeAll(async ({ request }) => {
  test.skip(!USING_EXTERNAL_SERVICE, '静态托管旅程只在真服务模式（JOURNEY_BASE_URL 已设）运行');
  const root = await request.get(`${JOURNEY_BASE_URL}/`);
  const body = root.ok() ? await root.text() : '';
  test.skip(
    !(root.ok() && body.includes('id="root"')),
    '被测服务未处于静态自托管形态（GET / 未返回 SPA index.html），跳过 A 案旅程',
  );
});

test('静态托管旅程：子路径直达真渲染 + 刷新不 404 + 资产全 200 + 同源 API/SSE 真通', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  // 收集页面加载期间的资产响应（JS/CSS），逐条核 200
  const assetResponses: Array<{ url: string; status: number }> = [];
  page.on('response', (res) => {
    const url = res.url();
    if (/\.(js|css)(\?|$)/.test(url)) assetResponses.push({ url, status: res.status() });
  });

  // ① 子路径直达：不经首页跳转，直接打开项目页 URL
  const direct = await page.goto(`${JOURNEY_BASE_URL}/projects/${DEMO.projectId}`);
  expect(direct?.status()).toBe(200);
  // 页面真渲染：项目页标题在场（种子项目名），不是空白壳
  await expect(page.getByRole('heading', { name: /续行演示/ })).toBeVisible();
  await expect(page.getByTestId('project-task-list')).toBeVisible();
  expect(await page.getByTestId('project-task-row').count()).toBeGreaterThan(0);

  // ② 在子路径上刷新：仍 200、内容仍在场（SPA 回退生效，不是 404 页）
  const reloaded = await page.reload();
  expect(reloaded?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: /续行演示/ })).toBeVisible();
  await expect(page.getByTestId('project-task-list')).toBeVisible();

  // ③ 资产全 200：至少有 1 个 JS 与 1 个 CSS，且无非 200
  expect(assetResponses.length).toBeGreaterThan(0);
  expect(assetResponses.some((r) => r.url.endsWith('.js'))).toBe(true);
  expect(assetResponses.some((r) => r.url.endsWith('.css'))).toBe(true);
  for (const r of assetResponses) {
    expect(r.status, `资产 ${r.url} 应为 200`).toBe(200);
  }

  // ④ 同源 /api 真数据：回首页，项目卡来自 /api/home 投影（种子项目在场）
  await page.goto(`${JOURNEY_BASE_URL}/`);
  await expect(page.getByTestId('home-project-card').first()).toBeVisible();
  await expect(
    page.getByTestId('home-project-card').filter({ hasText: '续行' }).first(),
  ).toBeVisible();

  // ⑤ SSE 同源仍通：页面上下文内连 /api/stream，ready 帧含 projection_version
  const sseProbe = await page.evaluate(async (base) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${base}/api/stream`, { signal: controller.signal });
      if (!res.ok || !res.body) return { ok: false, status: res.status, text: '' };
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (!text.includes('ready') && text.length < 64_000) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      return { ok: text.includes('ready') && text.includes('projection_version'), status: res.status, text: text.slice(0, 200) };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }, JOURNEY_BASE_URL);
  expect(sseProbe.status).toBe(200);
  expect(sseProbe.ok, `SSE ready 帧未到达：${sseProbe.text}`).toBe(true);

  expect(pageErrors).toEqual([]);
});

test('静态托管旅程：缺失资产大声 404（JSON），未知 /api 仍 JSON 404', async ({ request }) => {
  const missing = await request.get(`${JOURNEY_BASE_URL}/assets/definitely-missing-zzz.js`);
  expect(missing.status()).toBe(404);
  expect(missing.headers()['content-type']).toContain('application/json');

  const unknownApi = await request.get(`${JOURNEY_BASE_URL}/api/definitely-not-a-route`);
  expect(unknownApi.status()).toBe(404);
  expect(unknownApi.headers()['content-type']).toContain('application/json');
});
