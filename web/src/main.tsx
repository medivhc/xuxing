import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { createAppRuntime } from './app/runtime';
import { installMockFetch, isMockEnabled } from './mock/install';
import './styles/tokens.css';

// mock 开关（任务书）：VITE_API_MOCK=1 时安装 fetch 拦截；关闭则直连真实 /api。
// 时序：mock 安装 → runtime 装配 → sse.start()（订阅先于任何投影拉取，SSE 纪律 1）。
if (isMockEnabled()) {
  installMockFetch();
}

// VITE_MOCK_WATCHDOG_MS：缩短 SSE 看护阈值，便于 e2e 验证断线重连（默认 35s）。
const watchdogRaw = import.meta.env.VITE_MOCK_WATCHDOG_MS;
const watchdogMs =
  typeof watchdogRaw === 'string' && watchdogRaw.trim() !== '' && Number.isFinite(Number(watchdogRaw))
    ? Number(watchdogRaw)
    : undefined;

// 运行时装配（QueryCache.onSuccess → SSE 游标对齐；事件 → 投影失效映射）。
const runtime = createAppRuntime({ watchdogMs });

// SSE 纪律 1「先建订阅、再取快照」：订阅必须在任何页面投影拉取之前建立，
// 否则订阅建立前的事件窗口内投影可能永久落后。渲染放在 start() 之后。
runtime.sse.start();

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root not found');
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={runtime.queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
