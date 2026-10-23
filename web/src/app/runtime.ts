// 应用运行时装配：QueryClient + SSE 客户端 + 连接状态 store。
//
// 关键时序（SSE 纪律 1「先建订阅、再取快照」）：
//   createAppRuntime() 在 React render 之前同步执行；调用方先 sse.start()
//   建立 /api/stream 订阅，再 createRoot().render()——页面的投影拉取
//   （query effects）必然发生在订阅之后。
//
// 游标对齐：任一投影响应成功后，经 QueryCache.onSuccess 把 projection_version
// 喂给 SSE 客户端（noteProjectionVersion），重连游标 = max(事件 seq, 投影版本)。

import { QueryCache, QueryClient } from '@tanstack/react-query';
import { SseClient } from '../api/sse';
import { invalidationTargetsFor } from '../api/invalidation';
import { queryKeys } from '../api/queryKeys';
import { useConnectionStore } from '../state/connection';
import type { StreamEvent } from '../api/types';

export interface AppRuntime {
  queryClient: QueryClient;
  sse: SseClient;
}

function extractProjectionVersion(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const version = (data as { projection_version?: unknown }).projection_version;
  return typeof version === 'number' && Number.isFinite(version) ? version : undefined;
}

export function createAppRuntime(): AppRuntime {
  let noteProjectionVersion: (version: number) => void = () => {};

  const queryCache = new QueryCache({
    onSuccess: (data) => {
      const version = extractProjectionVersion(data);
      if (version !== undefined) noteProjectionVersion(version);
    },
  });

  const queryClient = new QueryClient({
    queryCache,
    defaultOptions: {
      queries: {
        // 只读请求允许 1 次自动重试；写命令一律不自动重试（§6.4）。
        retry: 1,
        staleTime: 5_000,
        refetchOnWindowFocus: false,
      },
    },
  });

  const sse = new SseClient({
    onEvent: (event: StreamEvent) => {
      useConnectionStore.getState().noteEvent(event.seq);
      for (const target of invalidationTargetsFor(event.kind)) {
        switch (target) {
          case 'home':
            void queryClient.invalidateQueries({ queryKey: queryKeys.home });
            break;
          case 'actions':
            void queryClient.invalidateQueries({ queryKey: queryKeys.actions });
            break;
          case 'project':
            void queryClient.invalidateQueries({ queryKey: ['project'] });
            break;
          case 'proposals':
            void queryClient.invalidateQueries({ queryKey: ['proposal'] });
            break;
          case 'all':
            void queryClient.invalidateQueries();
            break;
        }
      }
    },
    onStatus: (status) => {
      useConnectionStore.getState().setStatus(status);
    },
  });

  noteProjectionVersion = (version) => sse.noteProjectionVersion(version);

  return { queryClient, sse };
}
