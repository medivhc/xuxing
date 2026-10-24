// P 层连接状态（契约 §0.2：P 层由投影游标、读取结果、连接状态三个外部事实唯一决定，
// 组件不得自行写入）。本 store 只承载「连接状态 + 游标对齐事实」，由 SSE 客户端与
// 投影响应写入；组件只读。

import { create } from 'zustand';
import type { ConnectionStatus } from './connection-status';

interface ConnectionStore {
  status: ConnectionStatus;
  /** 已收到的最大事件 seq（SSE） */
  lastEventSeq: number;
  /** 最近一次投影响应的 projection_version（游标对齐） */
  lastProjectionVersion: number;
  setStatus: (status: ConnectionStatus) => void;
  noteEvent: (seq: number) => void;
  noteProjectionVersion: (version: number) => void;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  status: 'connecting',
  lastEventSeq: 0,
  lastProjectionVersion: 0,
  setStatus: (status) => set({ status }),
  noteEvent: (seq) =>
    set((state) => (Number.isFinite(seq) && seq > state.lastEventSeq ? { lastEventSeq: seq } : {})),
  noteProjectionVersion: (version) =>
    set((state) =>
      Number.isFinite(version) && version > state.lastProjectionVersion
        ? { lastProjectionVersion: version }
        : {},
    ),
}));
