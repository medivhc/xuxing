// SSE 连接建立流程（纪律①②的落地），顺序本身就是纪律：
//
//   1. 预算检查（纪律③）：超上限 → 503 + Retry-After，不建连接；
//   2. 先订阅：连接立刻进 hub 推送名单，但写帧先缓冲（buffer 模式）——订阅之后提交的事件只进缓冲，不会漏；
//   3. 再取快照水位 snapshot_version = 投影已并入最大 global_seq；
//   4. 按 cursor 补发：cursor 为 null 时以 snapshot_version 为起点（新客户端只关心此后）；否则从事件表
//      按 global_seq 补发缺口（纪律②）。补发帧直接写，且与缓冲帧按 seq 去重（seq <= lastSeq 丢弃）；
//   5. 释放缓冲转实时（缓冲里的帧 seq 都 > 补发水位，客户端按 seq 幂等去重）；
//   6. 发 ready 帧：{projection_version, cursor, replayed, last_seq}，放在补发之后、缓冲之前，
//      客户端以 ready.cursor 为起点续传。
//
// 这样"订阅"与"快照"之间不存在无主窗口：任何在步骤 2 之后提交的事件要么出现在补发里，要么在缓冲里。

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
  writer: { write(chunk: string): boolean | void; isAlive(): boolean; close(): void; settled?(): void };
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

  // ③ 连接预算（先于任何挂载，避免超限连接占住 hub 名额）
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

  let connection: SseConnection | null = null;
  try {
    // ② 先订阅（缓冲模式）：订阅开始之后提交的事件都会进缓冲
    connection = new SseConnectionImpl(
      input.connectionId,
      input.writer,
      { options: input.options, project_id: parsed.project_id },
      input.hub.budget,
      parsed.cursor ?? 0,
    );
    connection.buffer();
    input.hub.attachBuffered(connection);

    // ① 再取快照水位（此刻已订阅，水位之后的事件都在缓冲里或有 seq）
    const snapshotVersion = input.projection.version();
    const from = parsed.cursor ?? snapshotVersion;
    connection.lastSeq = from;

    // ② 补发 cursor 之后的事件（直接写，不占队列；与缓冲帧由 seq 去重）
    const backlog = await replayFromPool(input.pool, from, parsed.project_id);
    const replayed = connection.pushEvents(backlog);

    // 4. 补发完成 → 释放缓冲（缓冲帧 seq 必然 > from，安全）
    connection.unbuffer();
    connection.push(frame('ready', {
      projection_version: snapshotVersion,
      cursor: connection.lastSeq,
      requested_cursor: parsed.cursor,
      replayed,
      project_id: parsed.project_id,
      heartbeat_ms: input.options.heartbeatMs,
    }));

    if (connection.isClosed) {
      input.hub.detach(connection);
      return {
        ok: false,
        status: 503,
        error: {
          code: 'sse_backlog_too_large',
          message: 'connection dropped while replaying backlog',
          detail: { from, project_id: parsed.project_id },
        },
      };
    }

    return {
      ok: true,
      connection,
      cursor: connection.lastSeq,
      replayed,
      projection_version: snapshotVersion,
    };
  } catch (error) {
    if (connection !== null) input.hub.detach(connection);
    else input.hub.budget.release();
    throw error;
  }
}
