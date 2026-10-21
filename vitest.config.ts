import { defineConfig } from 'vitest/config';

// DB 集成测试确定性优先于速度：
// - fileParallelism=false：多个测试文件共用一个 PG 容器/端口时避免端口与 schema 争用
// - testTimeout/hookTimeout：容器启动与 initdb 可能占数秒，hookTimeout 留足 90s
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
});
