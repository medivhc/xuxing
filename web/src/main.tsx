import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { createAppRuntime } from './app/runtime';
import './styles/tokens.css';

// 运行时装配（QueryCache.onSuccess → SSE 游标对齐；事件 → 投影失效映射）。
const runtime = createAppRuntime();

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
