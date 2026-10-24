import type { ServerResponse } from 'node:http';
import type { EventRecord } from './state.mts';
import { SSE_HEARTBEAT_MS } from '../journeys.config.mts';

// ============================================================================
// SSE Hub：快照-订阅对齐 / cursor 补发 / 三项背压上限。
//
// 关键次序（防丢事件）：连接先注册进 hub，再把 cursor 之后的存量事件入队；
// 因为 Node 单线程且这段没有 await，注册与回放之间不可能插入新事件。
// 之后 publish 的事件按 seq 追加到队尾 —— 于是「订阅已建立、快照尚未返回」
// 期间发生的事件一定在队列里，客户端最终都能看到（可能重复，但绝不漏）。
//
// 背压建模：
//   - 连接数上限：由 server 在 attach 前检查，超限回 429 JSON；
//   - 每连接待发队列上限：enqueue 超限立刻回 event:backpressure 并断开；
//   - 慢消费者超时：队首帧等待超过 slowConsumerTimeoutMs 仍未被发送泵取走，断开。
// 发送泵按 pumpIntervalMs 每拍发一帧（mock 用固定节拍让背压行为可复现；
// 真服务应由 socket backpressure/drain 驱动，测试口径不变：慢连接必须被断开）。
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
  private readonly heartbeatTimer: NodeJS.Timeout;
  private readonly slowTimer: NodeJS.Timeout;

  constructor(hub: SseHub, res: ServerResponse, cursor: number) {
    this.id = nextConnectionId++;
    this.hub = hub;
    this.res = res;
    this.cursor = cursor;
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
    this.res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
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
    const payload = JSON.stringify({ code: 'slow_consumer', reason });
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
   * 建立订阅：注册 → 回放 cursor 之后的事件 → 之后实时。
   * 返回 false 表示连接数已满（调用方回 429）。
   */
  attach(res: ServerResponse, cursor: number, events: EventRecord[], frameOf: (event: EventRecord) => string): boolean {
    if (this.atCapacity()) return false;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const connection = new SseConnection(this, res, cursor);
    this.connections.add(connection);
    res.write('retry: 1000\n\n: connected\n\n');

    for (const event of events) {
      if (event.seq > cursor) connection.enqueue(frameOf(event));
    }
    return true;
  }

  publish(event: EventRecord, frameOf: (event: EventRecord) => string): void {
    const text = frameOf(event);
    for (const connection of this.connections) connection.enqueue(text);
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

/** SSE update 帧（契约：data 含 seq 与 kind）。 */
export function updateFrame(event: EventRecord, frame: unknown): string {
  return `id: ${event.seq}\nevent: update\ndata: ${JSON.stringify(frame)}\n\n`;
}
