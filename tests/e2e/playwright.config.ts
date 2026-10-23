import { defineConfig, devices } from '@playwright/test';

// D9 旅程即测试 · Web UI 侧配置（v0 骨架）
//
// 现在不跑：tests/e2e 已从 vitest / tsc 排除，Playwright 也不在 devDependencies 里。
// UI 到位后的启用步骤（README.md「启用清单」）：
//   1. npm i -D @playwright/test && npx playwright install chromium
//   2. 起被测应用：XUXING_WEB_URL=http://127.0.0.1:5173 XUXING_E2E_UI=1 npx playwright test -c tests/e2e/playwright.config.ts
//   3. 逐条删掉 journeys.spec.ts 里的 test.skip 条件（一次一条，绿了再下一条）
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.XUXING_WEB_URL ?? 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
