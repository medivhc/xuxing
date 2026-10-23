// SSE Hub：全局事件扇出 + 每连接背压（纪律③）。
//
// 数据源 = 事件表（真相源）。Hub 只做"按 seq 幂等去重后写帧"，不缓存业务状态；
// 连接建立时的对齐（纪律①②）由 routes 调用 store 补发 + 投影服务通知完成。

import type { EventEnvelope } from '../../../src/kernel/events.ts';
import { ConnectionBudget, toSummaryFrame, type SseOptions } from './protocol.ts';

export interface SseWriter {
  write(chunk: string): void;
  /** 对端存活探针（Hono 的 abort signal / 测试替身） */
  isAlive(): boolean;
  close(): void;
}

export function frame(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function heartbeatFrame(seq: number): string {
  return `: ping ${seq}\n\n`;
}

export function retryFrame(retryMs: number): string {
  return `retry: ${retryMs}\n\n`;
}

export interface SseConnectionConfig {
  options: SseOptions;
  /** null = 全部项目；非空 = 只推该流 */
  project_id: string | null;
}

export class SseConnection {
  private queue: string[] = [];
  private flushing = false;
  private closed = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  private blockedSince: number | null = null;
  private progressTimer: NodeJS.Timeout | null = null;
  /** 已推送最大 seq（续传提示 / 幂等去重 / 测试断言） */
  lastSeq: number;
  dropped: 'slow' | 'overflow' | 'closed' | null = null;
  /** 写阻塞模拟点（测试替身可覆盖） */
  onClose: (() => void) | null = null;

  constructor(
    readonly id: string,
    private readonly writer: SseWriter,
    readonly config: SseConnectionConfig,
    readonly budget: ConnectionBudget,
    lastSeq: number,
  ) {
    this.lastSeq = lastSeq;
  }

  /** 入队一帧；返回 false = 队列溢出（调用方应断开该连接）。 */
  push(chunk: string): boolean {
    if (this.closed) return false;
    if (this.queue.length >= this.config.options.queueLimit) {
      this.drop('overflow');
      return false;
    }
    this.queue.push(chunk);
    this.flush();
    return true;
  }

  /** 入队事件摘要帧（seq <= lastSeq 的丢弃 = 幂等）。返回 false 表示应断开。 */
  pushEvent(event: EventEnvelope): boolean {
    if (this.closed) return false;
    if (event.global_seq <= this.lastSeq) return true;
    if (this.config.project_id !== null && event.stream_id !== this.config.project_id) return true;
    const ok = this.push(frame('event', toSummaryFrame(event)));
    if (ok) this.lastSeq = event.global_seq;
    return ok;
  }

  /** 纪律③：心跳保活 + 慢连接判定。 */
  startTimers(now: () => number = Date.now): void {
    const { heartbeatMs, slowTimeoutMs } = this.config.options;
    this.progressTimer = setInterval(() => {
      if (this.closed) return;
      if (this.queue.length === 0) {
        this.blockedSince = null;
        return;
      }
      const nowMs = now();
      if (this.blockedSince === null) {
        this.blockedSince = nowMs;
        return;
      }
      if (nowMs - this.blockedSince >= slowTimeoutMs) {
        this.drop('slow');
      }
    }, Math.max(10, Math.floor(heartbeatMs / 3)));

    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return;
      this.budget.metrics.heartbeats_sent += 1;
      this.push(heartbeatFrame(this.lastSeq));
    }, heartbeatMs);

    this.livenessTimer = setInterval(() => {
      if (this.closed) return;
      if (!this.writer.isAlive()) this.drop('closed');
    }, Math.max(20, Math.floor(heartbeatMs / 2)));

    for (const timer of [this.progressTimer, this.heartbeatTimer, this.livenessTimer]) timer.unref?.();
  }

  private flush(): void {
    if (this.flushing || this.closed) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const chunk = this.queue.shift()!;
        this.writer.write(chunk);
        this.budget.metrics.frames_sent += 1;
        this.blockedSince = null;
      }
    } finally {
      this.flushing = false;
    }
  }

  private drop(reason: 'slow' | 'overflow' | 'closed'): void {
    if (this.closed) return;
    if (reason === 'slow') this.budget.metrics.dropped_slow += 1;
    if (reason === 'overflow') this.budget.metrics.dropped_overflow += 1;
    this.dropped = reason;
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of [this.progressTimer, this.heartbeatTimer, this.livenessTimer]) {
      if (timer) clearInterval(timer);
    }
    this.progressTimer = null;
    this.heartbeatTimer = null;
    this.livenessTimer = null;
    this.queue.length = 0;
    this.writer.close();
    this.budget.release();
    this.onClose?.();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

export interface HubNotice {
  kind: string;
  [key: string]: unknown;
}

export interface Hub {
  budget: ConnectionBudget;
  attach(connection: SseConnection): void;
  detach(connection: SseConnection): void;
  broadcast(events: EventEnvelope[]): void;
  /** 业务提示帧（不占 seq；客户端只当建议，真相仍以事件帧为准）。 */
  notice(payload: HubNotice, project_id: string | null): void;
  connections(): SseConnection[];
  closeAll(): void;
}

export function createHub(options: SseOptions): Hub {
  const budget = new ConnectionBudget(options.maxConnections);
  const connections = new Map<string, SseConnection>();

  return {
    budget,
    attach(connection) {
      connections.set(connection.id, connection);
      connection.onClose = () => connections.delete(connection.id);
      connection.startTimers();
    },
    detach(connection) {
      connections.delete(connection.id);
      connection.onClose = null;
      connection.close();
    },
    broadcast(events) {
      if (events.length === 0) return;
      for (const connection of [...connections.values()]) {
        for (const event of events) {
          if (!connection.pushEvent(event)) break;
        }
      }
    },
    notice(payload, project_id) {
      for (const connection of [...connections.values()]) {
        if (project_id !== null && connection.config.project_id !== null && connection.config.project_id !== project_id) {
          continue;
        }
        connection.push(frame('notice', payload));
      }
    },
    connections: () => [...connections.values()],
    closeAll() {
      for (const connection of [...connections.values()]) connection.close();
      connections.clear();
    },
  };
}
