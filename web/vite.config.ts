import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 续行 Web 层 dev server。
// - mock 开关：VITE_API_MOCK=1 时启用 web/src/mock 的请求拦截（见 src/mock/README）。
// - 关闭（默认）时直连真实 /api（同源代理或绝对地址由 API 基址决定，见 src/api/client.ts）。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
});
