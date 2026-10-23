// SSE 连接建立流程（纪律①②的落地）：
//
//   1. 预算检查（纪律③）：超上限 → 503 + Retry-After，不建连接；
//   2. 先订阅：把连接挂进 hub（此后所有提交都会被广播）；
//   3. 再取快照水位 snapshot_version = 投影已并入最大 global_seq；
//   4. 按 cursor 补发：cursor 为 null 时以 snapshot_version 为起点（新客户端只关心此后）；
//      cursor 落后时从事件表按 global_seq 补发（跨 project 缺口，纪律②）；
//   5. 发 ready 帧：{projection_version, cursor, replayed, last_seq}；客户端以 ready.cursor 为起点；
//   6. 转实时；每帧带 seq，客户端按 seq 幂等去重（重复订阅窗口内的重叠由 seq 丢弃）。

import type { Pool } from 'pg';
import type { EventEnvelope } from '../../../src/kernel/events.ts';
import type { ProjectionService } from '../projection/service.ts';
import type { Hub, SseConnection } from './hub.ts';
import { parseFrameQuery, type SseOptions } from './protocol.ts';
import { frame, SseConnection as SseConnectionImpl } from './hub.ts';

export interface EstablishInput {
  pool: Pool;
  projection: ProjectionService;
  hub: Hub;
  options: SseOptions;
  query: { cursor?: string | null; project_id?: string | null };
  writer: { write(chunk: string): void; isAlive(): boolean; close(): void };
  connectionId: string;
}

export type EstablishResult =
  | { ok: true; connection: SseConnection; cursor: number; replayed: number; projection_version: number }
  | { ok: false; status: 400 | 503; error: { code: string; message: string; detail?: unknown } };

/** 从事件表按 global_seq 补发（跨 project；project_id 只做过滤，不改变序号语义）。 */
export async function replayFromPool(pool: Pool, after_seq: number, project_id: string | null): Promise<EventEnvelope[]> {
  const { rows } = await pool.query(
    `SELECT global_seq, id, stream_id, seq, type, actor_id, actor_kind, causation_id, correlation_id,
            idempotency_key, payload_canonical, prev_hash, hash, occurred_at, recorded_at
     FROM events
     WHERE global_seq > $1 ${project_id === null ? '' : 'AND stream_id = $2'}
     ORDER BY global_seq ASC`,
    project_id === null ? [after_seq] : [after_seq, project_id],
  );
  return rows.map((row) => ({
    id: row.id as string,
    stream_id: row.stream_id as string,
    seq: Number(row.seq),
    global_seq: Number(row.global_seq),
    type: row.type,
    actor_id: row.actor_id as string,
    actor_kind: row.actor_kind,
    causation_id: row.causation_id,
    correlation_id: row.correlation_id as string,
    idempotency_key: row.idempotency_key,
    payload: JSON.parse(row.payload_canonical as string),
    prev_hash: row.prev_hash as string,
    hash: row.hash as string,
    occurred_at: new Date(row.occurred_at).toISOString(),
    recorded_at: new Date(row.recorded_at).toISOString(),
  })) as EventEnvelope[];
}

export async function establishSseConnection(input: EstablishInput): Promise<EstablishResult> {
  const parsed = parseFrameQuery(input.query);
  if (!parsed.ok) {
    return { ok: false, status: 400, error: { code: 'bad_request', message: parsed.error ?? 'cursor 非法' } };
  }

  // ① 快照水位（订阅前先取：作为"无 cursor"时的起点）
  const snapshotVersion = input.projection.version();

  // ③ 连接预算
  if (!input.hub.budget.tryAcquire()) {
    return {
      ok: false,
      status: 503,
      error: {
        code: 'sse_capacity_exhausted',
        message: `SSE 连接数已达上限 ${input.options.maxConnections}`,
        detail: { retry_after_ms: 5_000, max_connections: input.options.maxConnections },
      },
    };
  }

  const from = parsed.cursor ?? snapshotVersion;
  let connection: SseConnection;
  try {
    // ② 先补发 cursor 之后的事件（含订阅窗口之前已提交的），再发 ready
    const backlog = await replayFromPool(input.pool, from, parsed.project_id);
    connection = new SseConnectionImpl(
      input.connectionId,
      input.writer,
      { options: input.options, project_id: parsed.project_id },
      input.hub.budget,
      from,
    );
    for (const event of backlog) {
      if (!connection.pushEvent(event)) break;
    }
    // 先订阅（此后实时事件不会漏），再声明 ready：ready 之前的帧都是补发
    input.hub.attach(connection);
    connection.push(frame('ready', {
      projection_version: snapshotVersion,
      cursor: connection.lastSeq,
      requested_cursor: parsed.cursor,
      replayed: backlog.length,
      project_id: parsed.project_id,
      heartbeat_ms: input.options.heartbeatMs,
    }));
    return {
      ok: true,
      connection,
      cursor: connection.lastSeq,
      replayed: backlog.length,
      projection_version: snapshotVersion,
    };
  } catch (error) {
    input.hub.budget.release();
    throw error;
  }
}
