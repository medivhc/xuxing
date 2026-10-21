import type { EventEnvelope, EventType } from './events.js';

/**
 * Event Store 接口（spec §2.4/§4）。
 * 实现要求（K0 第一批 develop 的验收点）：
 * - append 原子分配 stream 内 seq 与全局 global_seq，并维护哈希链（INV-12）
 * - 同 idempotency_key 重复 append 只入账一次，返回首次事件（INV-13）
 * - 只追加：不提供 update/delete
 * - replay 按 global_seq 全序重演，供投影重建（C5）
 */
export interface EventStore {
  append(input: {
    stream_id: string;
    type: EventType;
    actor_id: string;
    actor_kind: EventEnvelope['actor_kind'];
    causation_id: string | null;
    correlation_id: string;
    idempotency_key: string | null;
    payload: unknown;
  }): Promise<EventEnvelope>;

  readStream(stream_id: string, from_seq?: number): Promise<EventEnvelope[]>;
  replay(from_global_seq?: number): Promise<EventEnvelope[]>;
}
