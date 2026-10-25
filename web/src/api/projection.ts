// 投影新鲜度推导（P 层）：由三个外部事实唯一决定——投影游标、SSE 已收事件、连接状态。
// 契约 §1.1（F-011）：lag_state=catching_up 与 as_of<head 同样显示同步徽标；
// rebuilding additionally 丢弃旧快照并重读（TanStack 重拉即等效）。
// 任务书投影必带 projection_version；head_global_seq/lag_state 为可选补充字段。

import type { LagState, ProjectionMeta } from './types';
import { useConnectionStore } from '../state/connection';

export interface ProjectionFreshness {
  /** 是否应显示同步徽标（不同步到当前） */
  stale: boolean;
  /** 投影是否标记为重建中（应丢弃旧快照重读） */
  rebuilding: boolean;
  /** 开发模式可查看的游标信息（生产默认隐藏，契约 §8.A） */
  debug: { projectionVersion: number; lastEventSeq: number; lagState?: LagState };
}

export function computeFreshness(
  meta: Pick<ProjectionMeta, 'projection_version'> & Partial<ProjectionMeta>,
  conn: { status: 'connecting' | 'online' | 'offline'; lastEventSeq: number },
): ProjectionFreshness {
  const projectionVersion = meta.projection_version ?? 0;
  const lagState = meta.lag_state;
  const stale =
    conn.status === 'offline' ||
    lagState === 'catching_up' ||
    lagState === 'rebuilding' ||
    (typeof meta.head_global_seq === 'number' && projectionVersion < meta.head_global_seq) ||
    projectionVersion < conn.lastEventSeq;
  return {
    stale,
    rebuilding: lagState === 'rebuilding',
    debug: { projectionVersion, lastEventSeq: conn.lastEventSeq, lagState },
  };
}

/** 组件侧 hook：传入投影 meta，得到 P 层新鲜度。 */
export function useProjectionFreshness(
  meta: Pick<ProjectionMeta, 'projection_version'> & Partial<ProjectionMeta> | undefined,
): ProjectionFreshness {
  const status = useConnectionStore((s) => s.status);
  const lastEventSeq = useConnectionStore((s) => s.lastEventSeq);
  if (!meta) {
    return { stale: status !== 'online', rebuilding: false, debug: { projectionVersion: 0, lastEventSeq } };
  }
  return computeFreshness(meta, { status, lastEventSeq });
}
