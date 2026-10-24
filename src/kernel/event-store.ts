import type { ActorKind, EventEnvelope, EventType, ProjectId } from './events.js';
import type { GuardFacts } from './transition-guard.js';

/**
 * Event Store 接口（spec §2.4/§4）。
 * 实现要求（K0 第一/二批 develop 的验收点）：
 * - append 原子分配 stream 内 seq 与全局 global_seq，并维护哈希链（INV-12）
 * - 同 idempotency_key 重复 append 只入账一次，返回首次事件（INV-13）
 * - 只追加：不提供 update/delete
 * - replay 按 global_seq 全序重演，供投影重建（C5）
 * - appendBatch：同 stream、同事务、哈希链内连续；任一失败整体回滚（Q4 / INV-11）
 */
export interface AppendEventInput {
  stream_id: ProjectId;
  type: EventType;
  actor_id: string;
  actor_kind: ActorKind;
  causation_id: string | null;
  correlation_id: string;
  idempotency_key: string | null;
  payload: unknown;
}

/**
 * 批量条目：普通事件只带信封字段；
 * 带 from/to 的条目按状态迁移处理（与 appendStateTransition 同一套 guard 语义）。
 */
export interface AppendBatchEntryInput extends AppendEventInput {
  entity?: 'task' | 'run';
  from?: string;
  to?: string;
  facts?: GuardFacts;
  trigger_event_id?: string;
}

export interface AppendBatchResult {
  /** 本批次实际写入的事件（含内核自动收尾），按 seq 升序。 */
  events: EventEnvelope[];
}

export interface EventStore {
  append(input: AppendEventInput): Promise<EventEnvelope>;
  appendBatch(entries: AppendBatchEntryInput[]): Promise<AppendBatchResult>;

  readStream(stream_id: ProjectId, from_seq?: number): Promise<EventEnvelope[]>;
  replay(from_global_seq?: number): Promise<EventEnvelope[]>;
}
