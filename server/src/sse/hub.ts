// SSE Hub：全局事件扇出 + 每连接背压（纪律③）。
//
// 数据源 = 事件表（真相源）。Hub 只做"按 seq 幂等去重后写帧"，不缓存业务状态；
// 连接建立时的对齐（纪律①②）由 routes 调用 store 补发 + 投影服务通知完成。

import type { EventEnvelope } from '../../../src/kernel/events.ts';
import { ConnectionBudget, toSummaryFrame, type SseOptions } from './protocol.ts';

export interface SseWriter {
  /**
   * 写一帧。返回 false = 写端未落地（对端没在消费），本帧仍在背压窗口里，
   * 计入慢连接判定；返回 true / void = 已代表对端可继续接收。
   */
  write(chunk: string): boolean | void;
  /** 下游把已写出的数据消化掉了（如 Node 的 drain）：归还背压窗口。可缺省。 */
  settled?(): void;
  /** 对端存活探针（Hono 的 abort signal / 测试替身） */
  isAlive(): boolean;
  close(): void;
}

/** 背压窗口：同时未落地的写帧上限（超了队列积压，慢连接判定接手）。 */
export const MAX_OUTSTANDING_WRITES = 8;

export function frame(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 心跳兼收据：`id: <seq>` 让浏览器 EventSource 记住位置（重连自动带 Last-Event-ID），
 * 注释体回传已推到的 seq —— 客户端据此判断"心跳到达 = 序号之前的帧都已收到"。
 */
export function heartbeatFrame(seq: number): string {
  return `id: ${seq}\n: ping ${seq}\n\n`;
}

/** 心跳帧（含 id: 行）的判定，供路由与测试共用。 */
export function isHeartbeat(chunk: string): boolean {
  return chunk.includes(': ping ');
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
  private buffered = false;
  private flushing = false;
  private closed = false;
  private released = false;
  /** 已交给 writer、Promise 尚未落地的帧数（背压窗口） */
  private outstanding = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  private blockedSince: number | null = null;
  private progressTimer: NodeJS.Timeout | null = null;
  /** 等待消费的实时事件（按 seq 升序；缓冲模式下的积压，边等 IO 边发） */
  private pendingEvents: EventEnvelope[] = [];
  /** 已推送最大 seq（续传提示 / 幂等去重 / 测试断言） */
  lastSeq: number;
  /** 写端一句"对端已消化到第几帧"，用于背压窗口记账（可能滞后于实际写出）。 */
  confirmWrites: (count: number) => void = () => undefined;
  dropped: 'slow' | 'overflow' | 'closed' | null = null;
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

  /** 缓冲模式：此期间的帧先入队不写，等补发完成再一次性放开（纪律①订阅先于快照）。 */
  buffer(): void {
    this.buffered = true;
  }

  /** 让写端再冲刷一次队列（调用方拉取后催一把，避免等待下一个定时器）。 */
  pumpPending(): void {
    this.flush();
  }

  /** 退出缓冲：把缓冲期积攒的事件按 seq 顺序写出去。 */
  unbuffer(): void {
    if (!this.buffered) return;
    this.buffered = false;
    this.pump();
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

  /**
   * 收实时事件：比 lastSeq 旧的丢弃（幂等去重）；与 project 过滤同时生效。
   * 缓冲期只排队不写（补发要先进去）；否则立即写。
   */
  deliver(event: EventEnvelope): boolean {
    if (this.closed) return false;
    if (event.global_seq <= this.lastSeq) return true;
    if (this.config.project_id !== null && event.stream_id !== this.config.project_id) return true;
    if (this.buffered) {
      if (this.pendingEvents.length >= this.config.options.queueLimit) {
        this.drop('overflow');
        return false;
      }
      this.pendingEvents.push(event);
      return true;
    }
    return this.emitNow(event);
  }

  /** 立即写一条事件摘要帧（补发用）。seq <= lastSeq 的丢弃。 */
  emitImmediate(event: EventEnvelope): boolean {
    if (this.closed) return false;
    if (event.global_seq <= this.lastSeq) return true;
    if (this.config.project_id !== null && event.stream_id !== this.config.project_id) {
      this.lastSeq = Math.max(this.lastSeq, event.global_seq);
      return true;
    }
    return this.emitNow(event);
  }

  /** 批量补发；返回实际推送条数。 */
  pushEvents(events: EventEnvelope[]): number {
    let sent = 0;
    for (const event of events) {
      if (!this.emitImmediate(event)) break;
      sent += 1;
    }
    return sent;
  }

  /** 兼容旧接口名（= deliver，缓冲期只排队）。 */
  pushEvent(event: EventEnvelope): boolean {
    return this.deliver(event);
  }

  /**
   * 写端反馈：一次阻塞的写落地说明对端仍在消费（拿回背压窗口）。
   * 未落地时 flush 不再往 writer 里塞新帧，队列开始积压 → 慢连接判定生效。
   * 对端一直不消费（TCP 缓冲填满）时队列不积压、背压窗口耗尽，同样判为慢连接。
   */
  approveWrite(ok: boolean): void {
    this.outstanding = Math.max(0, this.outstanding - 1);
    if (!ok) {
      this.drop('closed');
      return;
    }
    this.blockedSince = null;
    this.flush();
  }

  private emitNow(event: EventEnvelope): boolean {
    // 事件帧同样受队列上限约束：积压超限即断连（慢连接/溢出两条判定都算数）
    if (this.queue.length >= this.config.options.queueLimit) {
      this.drop('overflow');
      return false;
    }
    this.queue.push(frame('event', toSummaryFrame(event)));
    this.lastSeq = event.global_seq;
    this.flush();
    return !this.closed;
  }

  private pump(): void {
    while (!this.buffered && this.pendingEvents.length > 0 && !this.closed) {
      const next = this.pendingEvents.shift()!;
      if (next.global_seq <= this.lastSeq) continue;
      if (this.config.project_id !== null && next.stream_id !== this.config.project_id) continue;
      this.emitNow(next);
    }
  }

  /** 纪律③：心跳保活 + 慢连接判定。 */
  startTimers(now: () => number = Date.now): void {
    const { heartbeatMs, slowTimeoutMs } = this.config.options;
    this.progressTimer = setInterval(() => {
      if (this.closed) return;
      // 两处都要判定：队列积压（帧还没交给写端）或背压窗口被写满（写端一直没落地）
      const backedUp = this.queue.length > 0 || this.outstanding >= MAX_OUTSTANDING_WRITES;
      if (!backedUp) {
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
    // 背压窗口：上一个写还没落地就继续塞新帧，等于把内存当缓冲池。满了就停下来等 approveWrite。
    if (this.outstanding >= MAX_OUTSTANDING_WRITES) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0 && !this.closed && this.outstanding < MAX_OUTSTANDING_WRITES) {
        const chunk = this.queue.shift()!;
        // 写端说"满了"（如 Node http res.write 返回 false）→ 占住背压窗口，等 approveWrite 放行
        if (this.writer.write(chunk) === false) this.outstanding += 1;
        this.budget.metrics.frames_sent += 1;
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

  private releaseBudgetOnce(): void {
    if (this.released) return;
    this.released = true;
    this.budget.release();
  }

  /**
   * 写端主动告别：断开连接但**不**在 writer 内部重入 close（避免与 close() 递归）。
   * 预算照常归还；路由层的 stream 回调会在下一拍看到 isClosed 收尾。
   */
  requestClose(): void {
    this.closeInternal(true);
  }

  close(): void {
    this.closeInternal(true);
  }

  /** 断开并归还预算（可重复调用，预算只归还一次）。 */
  private closeInternal(releaseBudget: boolean): void {
    if (this.closed) {
      if (releaseBudget) this.releaseBudgetOnce();
      return;
    }
    this.closed = true;
    for (const timer of [this.progressTimer, this.heartbeatTimer, this.livenessTimer]) {
      if (timer) clearInterval(timer);
    }
    this.progressTimer = null;
    this.heartbeatTimer = null;
    this.livenessTimer = null;
    this.queue.length = 0;
    this.pendingEvents.length = 0;
    this.outstanding = 0;
    // 先发预算、再报到：onClose 里的计数断言与后续建连都不依赖 writer 的清理
    if (releaseBudget) this.releaseBudgetOnce();
    this.writer.close();
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
  /** 挂入连接但暂不启动定时器（缓冲模式下由 establish 完成后转实时）。 */
  attachBuffered(connection: SseConnection): void;
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
  /** 轮转起点：多条连接时公平起步，避免固定顺序下的饿死。 */
  let rotateStart = 0;

  return {
    budget,
    attach(connection) {
      connections.set(connection.id, connection);
      connection.onClose = () => connections.delete(connection.id);
      connection.startTimers();
    },
    attachBuffered(connection) {
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
      // 每条事件先写全部连接，再写下一事件（单连接积压不阻塞其它连接）
      for (const event of events) {
        const order = [...connections.values()];
        if (order.length === 0) return;
        rotateStart = (rotateStart + 1) % order.length;
        for (let i = 0; i < order.length; i += 1) {
          const connection = order[(i + rotateStart) % order.length]!;
          connection.deliver(event);
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
