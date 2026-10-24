import type { ServerResponse } from 'node:http';
import type { EventRecord } from './state.mts';
import type { StreamReadyFrame, StreamNoticeFrame } from '../contract.mts';
import { SSE_HEARTBEAT_MS } from '../journeys.config.mts';

// ============================================================================
// SSE Hub：快照-订阅对齐 / cursor 补发 / 三项背压上限。
//
// 帧形态与真服务逐字对齐（server/src/sse/hub.ts、server/src/sse/connection.ts）：
//   retry: 1000
//   event: event    data = {kind, seq, stream_id, project_id, task_id, proposal_id, occurred_at}
//   event: ready    data = {projection_version, cursor, requested_cursor, replayed, project_id, heartbeat_ms}
//   event: notice   data = {kind: 'proposal_degraded', proposal_id, degraded_reason}（不占 seq）
//   id: <seq> + `: ping <seq>`   心跳（浏览器 EventSource 据此续传）
//
// 关键次序（防丢事件）：连接先注册进 hub，再按 cursor 回放存量事件并写 ready 帧，
// 之后转实时；因为 Node 单线程且这段没有 await，注册与回放之间不可能插入新事件。
// 于是「订阅已建立、快照尚未返回」期间发生的事件一定在队列里，客户端最终都能看到。
//
// 背压建模（R-4，只对齐可观测行为）：
//   - 连接数上限：由 server 在 attach 前检查，超限回 503 unavailable + Retry-After: 5；
//   - 每连接待发队列上限：enqueue 超限立刻回 event: backpressure 并断开；
//   - 慢消费者超时：队首帧等待超过 slowConsumerTimeoutMs 仍未被发送泵取走，断开。
// 发送泵按 pumpIntervalMs 每拍发一帧（mock 用固定节拍让背压行为可复现；
// 真服务由 socket backpressure/drain 驱动，测试口径不变：慢连接必须被断开）。
// ============================================================================

export interface SseLimits {
  maxConnections: number;
  maxPendingPerConnection: number;
  slowConsumerTimeoutMs: number;
  pumpIntervalMs: number;
}

interface QueuedFrame {
  text: string;
  enqueuedAt: number;
}

let nextConnectionId = 1;

export class SseConnection {
  readonly id: number;
  readonly cursor: number;
  private readonly res: ServerResponse;
  private readonly hub: SseHub;
  private readonly queue: QueuedFrame[] = [];
  private closed = false;
  private closeReason: string | null = null;
  private lastWriteAt = Date.now();
  /** 已推到的 seq：心跳收据 `id: <seq>` 与 ready.cursor 都用它。 */
  private lastSeq = 0;
  private readonly heartbeatTimer: NodeJS.Timeout;
  private readonly slowTimer: NodeJS.Timeout;

  constructor(hub: SseHub, res: ServerResponse, cursor: number) {
    this.id = nextConnectionId++;
    this.hub = hub;
    this.res = res;
    this.cursor = cursor;
    this.lastSeq = cursor;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), SSE_HEARTBEAT_MS);
    this.slowTimer = setInterval(() => this.checkSlowConsumer(), Math.max(50, Math.floor(hub.limits.slowConsumerTimeoutMs / 4)));
    this.heartbeatTimer.unref?.();
    this.slowTimer.unref?.();
    res.on('close', () => this.cleanup('client_closed'));
    res.on('error', () => this.cleanup('socket_error'));
  }

  enqueue(frameText: string): void {
    if (this.closed) return;
    this.queue.push({ text: frameText, enqueuedAt: Date.now() });
    if (this.queue.length > this.hub.limits.maxPendingPerConnection) {
      this.closeWithReason('queue_overflow');
    }
  }

  /** 立即写一帧（建连接阶段的 retry/回放/ready，不经发送泵）。 */
  writeNow(frameText: string): void {
    if (this.closed || this.res.writableEnded || this.res.destroyed) return;
    this.res.write(frameText);
    this.lastWriteAt = Date.now();
  }

  /** 记录已推到的 seq（事件帧与心跳收据共用）。 */
  advance(seq: number): void {
    if (seq > this.lastSeq) this.lastSeq = seq;
  }

  get pushedSeq(): number {
    return this.lastSeq;
  }

  /** 每个发送泵节拍取一帧。 */
  pump(): void {
    if (this.closed) return;
    const next = this.queue.shift();
    if (!next) return;
    if (this.res.writableEnded || this.res.destroyed) {
      this.cleanup('socket_gone');
      return;
    }
    this.res.write(next.text);
    this.lastWriteAt = Date.now();
  }

  get pending(): number {
    return this.queue.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get reason(): string | null {
    return this.closeReason;
  }

  get lastWrite(): number {
    return this.lastWriteAt;
  }

  private heartbeat(): void {
    if (this.closed || this.res.writableEnded || this.res.destroyed) return;
    // 与真服务同形：id 让 EventSource 记住位置，注释体回传已推到的 seq。
    this.res.write(`id: ${this.lastSeq}\n: ping ${this.lastSeq}\n\n`);
    this.lastWriteAt = Date.now();
  }

  private checkSlowConsumer(): void {
    if (this.closed || this.queue.length === 0) return;
    const head = this.queue[0];
    if (Date.now() - head.enqueuedAt > this.hub.limits.slowConsumerTimeoutMs) {
      this.closeWithReason('slow_consumer_timeout');
    }
  }

  /** 关闭连接并把原因以 backpressure 帧交给客户端（队列溢出/慢消费者/停机）。 */
  closeWithReason(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    this.hub.forget(this);
    // 背压原因必须以协议帧可见地交出去（客户端可据此重连并带 cursor 补发）。
    const payload = JSON.stringify({ code: 'slow_consumer', reason, last_seq: this.lastSeq });
    try {
      this.res.write(`event: backpressure\ndata: ${payload}\n\n`);
      this.res.end();
    } catch {
      this.res.destroy();
    }
    this.clearTimers();
  }

  private cleanup(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    this.hub.forget(this);
    this.clearTimers();
  }

  private clearTimers(): void {
    clearInterval(this.heartbeatTimer);
    clearInterval(this.slowTimer);
  }
}

export interface AttachOptions {
  /** 投影水位（= 已并入的最大 seq） */
  projectionVersion: number;
  /** 客户端请求的 cursor；null = 新连接，以 projectionVersion 为起点 */
  requestedCursor: number | null;
  frameOf: (event: EventRecord) => string;
}

export class SseHub {
  readonly limits: SseLimits;
  private readonly connections = new Set<SseConnection>();
  private readonly pumpTimer: NodeJS.Timeout;

  constructor(limits: SseLimits) {
    this.limits = limits;
    this.pumpTimer = setInterval(() => {
      for (const connection of this.connections) connection.pump();
    }, Math.max(1, limits.pumpIntervalMs));
    this.pumpTimer.unref?.();
  }

  get activeCount(): number {
    return this.connections.size;
  }

  atCapacity(): boolean {
    return this.connections.size >= this.limits.maxConnections;
  }

  /**
   * 建立订阅：注册 → 回放 cursor 之后的事件 → ready 帧 → 之后实时。
   * 返回 false 表示连接数已满（调用方回 503 + Retry-After）。
   *
   * cursor 语义与真服务一致（server/src/sse/connection.ts）：
   *   未带 cursor → from = projectionVersion（新客户端只关心此后）；
   *   带了 cursor → from = cursor（补发 (cursor, head] 的缺口）。
   */
  attach(res: ServerResponse, events: EventRecord[], options: AttachOptions): boolean {
    if (this.atCapacity()) return false;

    const from = options.requestedCursor ?? options.projectionVersion;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const connection = new SseConnection(this, res, from);
    this.connections.add(connection);
    connection.writeNow('retry: 1000\n\n');

    let replayed = 0;
    for (const event of events) {
      if (event.seq <= from) continue;
      connection.writeNow(options.frameOf(event));
      connection.advance(event.seq);
      replayed += 1;
    }

    const ready: StreamReadyFrame = {
      projection_version: options.projectionVersion,
      cursor: connection.pushedSeq,
      requested_cursor: options.requestedCursor,
      replayed,
      project_id: null,
      heartbeat_ms: SSE_HEARTBEAT_MS,
    };
    connection.writeNow(`event: ready\ndata: ${JSON.stringify(ready)}\n\n`);
    return true;
  }

  publish(event: EventRecord, frameOf: (event: EventRecord) => string): void {
    const text = frameOf(event);
    for (const connection of this.connections) {
      connection.enqueue(text);
      connection.advance(event.seq);
    }
  }

  /** 业务提示帧（不占 seq）：降级提议必须能在此明示（R-9）。 */
  notice(payload: StreamNoticeFrame, projectId: string | null): void {
    const text = `event: notice\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const connection of this.connections) connection.enqueue(text);
    void projectId;
  }

  forget(connection: SseConnection): void {
    this.connections.delete(connection);
  }

  closeAll(): void {
    for (const connection of this.connections) {
      try {
        connection.closeWithReason('server_shutdown');
      } catch {
        // ignore
      }
    }
    this.connections.clear();
    clearInterval(this.pumpTimer);
  }
}

/** 事件帧（契约：event=event，data 含 seq 与 PascalCase kind）。 */
export function updateFrame(event: EventRecord, frame: unknown): string {
  return `id: ${event.seq}\nevent: event\ndata: ${JSON.stringify(frame)}\n\n`;
}
