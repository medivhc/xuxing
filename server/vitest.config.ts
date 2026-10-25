import { defineConfig } from 'vitest/config';

// server 车道测试口径与根配置一致（PG 集成测试确定性优先于速度），
// root 指到 server/，保证 vitest 按 server 自己的依赖解析启动。
export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
});
