// 事件源 + 投影服务。
//
// 投影不是持久表，而是"事件流按 global_seq 重演"得到的进程内快照：
// - 这满足任务书红线（投影状态一律由事件派生），并天然满足内核 C5 口径（清空重演 diff 为零）；
// - projection_version = 已并入的最大 global_seq，与 SSE cursor 同量纲（SSE 纪律 1）；
// - 写入后按 global_seq 排序增量并入（见 refresh）；不能只读单个 stream，
//   因为 global_seq 是全局序号，别的流先提交会留洞，而水位必须连续推进。

import type { Pool } from 'pg';
import type { EventEnvelope } from '../../../src/kernel/events.ts';
import type { PgEventStore } from '../../../src/kernel/event-store-pg.ts';
import { XuxingProjection, type ProjectionSnapshot } from './projection.ts';

export interface ProjectionService {
  /** 当前快照（同步、零 IO；调用方拿到的是拷贝）。 */
  snapshot(): ProjectionSnapshot;
  /** projection_version（= 已并入最大 global_seq）。 */
  version(): number;
  /** 全量重演重建（启动 / 崩溃恢复；确定性：同样事件 → 同样投影）。 */
  rebuild(): Promise<ProjectionSnapshot>;
  /** 并入已提交事件（按 global_seq 升序、幂等）；返回本次实际并入的条数。 */
  ingest(events: EventEnvelope[]): number;
  /** 从事件表读"水位之后"的尾部并并入（提交序与 global_seq 都可能乱，由 ingest 排序去重）。 */
  refresh(): Promise<number>;
  /** 每次水位前进后触发（SSE 广播钩子）。 */
  onAdvance(listener: (snapshot: ProjectionSnapshot, merged: EventEnvelope[]) => void): () => void;
  /** 该 project 流内 seq 大于给定值的事件（供 SSE 快照-订阅对齐用）。 */
  streamSince(stream_id: string, after_seq: number): Promise<EventEnvelope[]>;
}

export function createProjectionService(pool: Pool, store: PgEventStore): ProjectionService {
  let projection = new XuxingProjection();
  const listeners = new Set<(snapshot: ProjectionSnapshot, merged: EventEnvelope[]) => void>();

  function rebuild(): Promise<ProjectionSnapshot> {
    return store.replay(0).then((events) => {
      projection = new XuxingProjection();
      projection.applyAll(events);
      return projection.snapshot();
    });
  }

  /**
   * 并入事件：只接受 global_seq 严格大于当前水位的；
   * 同一批内乱序先排序（readStream 已保证 stream 内序，跨 stream 由调用方排序）。
   */
  function ingest(events: EventEnvelope[]): number {
    const current = projection.version();
    const pending = events
      .filter((event) => event.global_seq > current)
      .sort((a, b) => a.global_seq - b.global_seq);
    if (pending.length === 0) return 0;

    for (const event of pending) projection.apply(event);

    const snapshot = projection.snapshot();
    for (const listener of listeners) listener(snapshot, pending);
    return pending.length;
  }

  /**
   * 读尾部：只做读取（不写库），读到的事件按 global_seq 排序后并入。
   * 用写后读的强一致通道（同一连接池的串行 SELECT）保证刚提交的事务可见。
   */
  async function refresh(): Promise<number> {
    const current = projection.version();
    const tail = (await store.replay(current)).filter((event) => event.global_seq > current);
    return ingest(tail);
  }

  return {
    snapshot: () => projection.snapshot(),
    version: () => projection.version(),
    rebuild,
    ingest,
    refresh,
    onAdvance(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async streamSince(stream_id, after_seq) {
      return store.readStream(stream_id, after_seq + 1);
    },
  };
}
