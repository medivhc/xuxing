// Mock 安装器：fetch 补丁 + 开发控制面 window.__xuxMock。
//
// 开关（任务书硬性要求）：
//   VITE_API_MOCK=1  → 安装 mock fetch，所有 /api/* 由内存 mock 应答；
//   其他任意值/未设置 → 不安装，客户端直连真实服务端。
// 安装时机：必须在 runtime.sse.start() 之前（SSE 纪律 1「先建订阅」），
// 否则 /api/stream 会绕过拦截打到真实服务端。
//
// 边界：mock 与 api/ 客户端严格分离——api/ 下任何模块不得 import mock/；
// mock 只在最外层替换 fetch，客户端看到的仍是真实 HTTP 语义。

import { createMockFetch, mockLatency } from './handlers';
import { MockStore } from './store';
import type { LagState } from '../api/types';

declare global {
  interface Window {
    /** 开发控制面（仅 VITE_API_MOCK=1 时存在）：供 e2e / 手动验证驱动 mock。 */
    __xuxMock?: {
      /** 清空事件日志与领域状态，回到种子数据（保留 SSE 订阅者）。 */
      reset(): void;
      /** 下一次 capture 强制返回降级提议（用于验证 degraded 明示）。 */
      forceNextProposalDegraded(value?: boolean): void;
      /** 停止 SSE 心跳（用于验证 35s 看护断线重连）。 */
      stopHeartbeats(): void;
      startHeartbeats(): void;
      /** 注入一条控制面事件（不改变领域状态），如 ProjectionRebuilt。 */
      emit(kind: string, payload?: { project_id?: string; task_id?: string }): void;
      /** 覆盖 lag_state（同步徽标测试）。 */
      setLagState(state: LagState | null): void;
      /** 调整模拟网络时延（ms）。 */
      setLatency(latency: { read?: number; command?: number; capture?: number }): void;
      /** 读取内部快照（调试用）。 */
      snapshot(): {
        seq: number;
        events: number;
        tasks: number;
        proposals: number;
        decisions: number;
        heartbeats: boolean;
        lag_state: LagState | null;
      };
    };
  }
}

let installed = false;
let store: MockStore | null = null;

export function isMockEnabled(): boolean {
  return import.meta.env.VITE_API_MOCK === '1';
}

/** 幂等安装：重复调用只补丁一次。返回安装后的 store（测试可用）。 */
export function installMockFetch(): MockStore {
  if (!store) store = new MockStore();
  if (!installed) {
    globalThis.fetch = createMockFetch(store);
    installed = true;
  }
  installControlPanel(store);
  return store;
}

function installControlPanel(activeStore: MockStore): void {
  if (typeof window === 'undefined') return;
  window.__xuxMock = {
    reset: () => activeStore.reset(),
    forceNextProposalDegraded: (value = true) => activeStore.setNextProposalDegraded(value),
    stopHeartbeats: () => activeStore.setHeartbeats(false),
    startHeartbeats: () => activeStore.setHeartbeats(true),
    emit: (kind, payload) => activeStore.injectEvent(kind, payload),
    setLagState: (state) => activeStore.setLagState(state),
    setLatency: (latency) => {
      if (latency.read !== undefined) mockLatency.read = latency.read;
      if (latency.command !== undefined) mockLatency.command = latency.command;
      if (latency.capture !== undefined) mockLatency.capture = latency.capture;
    },
    snapshot: () => ({
      seq: activeStore.currentSeq(),
      events: activeStore.eventsAfter(0).length,
      tasks: activeStore.tasks.size,
      proposals: activeStore.proposals.size,
      decisions: activeStore.decisions.size,
      heartbeats: activeStore.heartbeatsOn,
      lag_state: activeStore.lagState,
    }),
  };
}

/** 仅供测试：卸载补丁并清空单例（不面向产品代码路径）。 */
export function uninstallMockFetch(): void {
  if (installed) {
    installed = false;
    store = null;
  }
}
