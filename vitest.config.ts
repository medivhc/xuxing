import { defineConfig } from 'vitest/config';

// DB 集成测试确定性优先于速度：
// - fileParallelism=false：多个测试文件共用一个 PG 容器/端口时避免端口与 schema 争用
// - testTimeout/hookTimeout：容器启动与 initdb 可能占数秒，hookTimeout 留足 90s
export default defineConfig({
  test: {
    fileParallelism: false,
    // tests/e2e 是 Playwright 骨架（@playwright/test 未安装、UI 未实现），
    // 必须由 vitest 排除，否则默认 include 会扫到 *.spec.ts 并在收集阶段报错。
    // 这里显式重写 exclude，故 vitest 默认项（node_modules/dist）一并列出。
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
});
