import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { JOURNEY_BASE_URL, USING_EXTERNAL_SERVICE } from './journeys.config.mts';

// ============================================================================
// 旅程测试的 Playwright 配置。
//
// 一键流程（在 tests/journeys/ 下）：
//   npm install && npx playwright install chromium && npm test
//
// - 默认：webServer 拉起 tests/journeys/mock/server.mts，测试完自动关；
//   reuseExistingServer=false 保证每次从种子状态开始（可重复、互不污染）。
// - 集成：设 JOURNEY_BASE_URL=https://... 后不再启动 mock，全部请求打真服务。
//   （真服务的种子项目/actor/SSE 上限用 JOURNEY_* 变量对齐，见 journeys.config.mts）
// ============================================================================

const here = fileURLToPath(new URL('.', import.meta.url));

const launchOptions: Record<string, unknown> = {};
if (process.env.JOURNEY_CHROMIUM_EXECUTABLE) {
  launchOptions.executablePath = process.env.JOURNEY_CHROMIUM_EXECUTABLE;
}
if (process.env.JOURNEY_NO_SANDBOX === '1') {
  launchOptions.args = ['--no-sandbox'];
}

export default defineConfig({
  testDir: '.',
  // 用 *.pw.mts 而不是 *.spec.mts：根仓库 vitest 的默认 include 会扫
  // **/*.spec.mts；改名可确保 tests/journeys 不干扰根 `npm test`。
  testMatch: ['specs/**/*.pw.mts'],
  outputDir: 'test-results',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  use: {
    baseURL: JOURNEY_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: USING_EXTERNAL_SERVICE
    ? undefined
    : {
        command: 'node --experimental-strip-types mock/server.mts',
        cwd: here,
        url: `${JOURNEY_BASE_URL}/api/health`,
        reuseExistingServer: false,
        timeout: 30_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
