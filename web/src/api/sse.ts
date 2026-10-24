// SSE 客户端（GET /api/stream?cursor=<seq>）。
//
// 三条纪律（任务书红线）：
// 1. 先建订阅、再取快照：本客户端在应用渲染前同步 start()（见 main.tsx），
//    投影拉取发生在订阅之后；响应 projection_version 经 noteProjectionVersion
//    与已收事件 seq 对齐（cursor = max(lastEventSeq, projectionVersion)），
//    避免「事件已提交、界面永久漏更新」。
// 2. 游标续传自理：不使用浏览器 EventSource 的自带重连语义；自持最后收到的 seq，
//    断线重连时以最新 cursor 重新请求 /api/stream?cursor=<seq>，由服务端先补发
//    cursor 之后的事件摘要再转实时。
// 3. 心跳看护：服务端 15s 一帧心跳；任一帧（事件或心跳）都重置看护计时，
//    超过 watchdogMs（默认 35s）无任何帧到达即判定断线并重连。

import type { ConnectionStatus } from '../state/connection-status';
import type { StreamEvent } from './types';

export interface SseClientOptions {
  onEvent: (event: StreamEvent) => void;
  onStatus: (status: ConnectionStatus) => void;
  /** 看护阈值：无任何帧超过该时长判定断线。服务端 15s 心跳 → 默认 35s。 */
  watchdogMs?: number;
  /** 重连退避序列（循环取用） */
  reconnectDelaysMs?: number[];
  /** 测试注入 */
  streamUrlBuilder?: (cursor: number) => string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_WATCHDOG_MS = 35_000;
const DEFAULT_RECONNECT_DELAYS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

export class SseClient {
  private readonly onEvent: (event: StreamEvent) => void;
  private readonly onStatus: (status: ConnectionStatus) => void;
  private readonly watchdogMs: number;
  private readonly reconnectDelaysMs: number[];
  private readonly streamUrlBuilder: (cursor: number) => string;
  private readonly fetchImpl: typeof fetch;

  private stopped = true;
  private controller: AbortController | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private lastEventSeq = 0;
  private projectionVersion = 0;

  constructor(options: SseClientOptions) {
    this.onEvent = options.onEvent;
    this.onStatus = options.onStatus;
    this.watchdogMs = options.watchdogMs ?? DEFAULT_WATCHDOG_MS;
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS;
    this.streamUrlBuilder = options.streamUrlBuilder ?? ((cursor) => `/api/stream?cursor=${cursor}`);
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  /** 当前游标：max(最后事件 seq, 已知投影版本)。快照游标对齐用。 */
  get cursor(): number {
    return Math.max(this.lastEventSeq, this.projectionVersion);
  }

  getLastEventSeq(): number {
    return this.lastEventSeq;
  }

  /**
   * 投影对齐：投影响应的 projection_version 可能领先于已收事件（快照先于订阅拿到），
   * 此时以 projection_version 作为重连游标，避免补发已入快照的事件。
   */
  noteProjectionVersion(version: number): void {
    if (Number.isFinite(version) && version > this.projectionVersion) {
      this.projectionVersion = version;
    }
  }

  /** 开始订阅（幂等守护：重复调用先停旧连接）。 */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.openConnection();
  }

  stop(): void {
    this.stopped = true;
    this.teardown();
    this.onStatus('offline');
  }

  // ---------- 内部 ----------

  private teardown(): void {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private openConnection(): void {
    if (this.stopped) return;
    this.teardown();
    this.onStatus('connecting');
    const controller = new AbortController();
    this.controller = controller;
    void this.pump(controller);
  }

  private async pump(controller: AbortController): Promise<void> {
    const url = this.streamUrlBuilder(this.cursor);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || this.stopped) return;
      this.handleDisconnect();
      return;
    }
    if (this.stopped || controller.signal.aborted) return;
    if (!response.ok || !response.body) {
      this.handleDisconnect();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE 帧以空行分隔；兼容 \n\n 与 \r\n\r\n
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          this.handleFrame(frame);
          if (this.stopped || controller.signal.aborted) return;
        }
      }
    } catch (error) {
      if (controller.signal.aborted || this.stopped) return;
      this.handleDisconnect();
      return;
    } finally {
      reader.releaseLock?.();
    }
    // 流正常结束（服务端关闭）：按断线重连处理（游标自理）
    if (!this.stopped && !controller.signal.aborted) {
      this.handleDisconnect();
    }
  }

  /** 任一帧到达：重置看护；连接存活即在线；解析出事件帧则更新游标并回调。 */
  private handleFrame(frame: string): void {
    this.resetWatchdog();
    if (frame.trim() === '') return;
    // 收到任何帧（事件或心跳）都说明连接存活
    this.onStatus('online');
    this.reconnectAttempt = 0;
    const event = parseSseFrame(frame);
    if (!event) return; // 心跳/注释帧或不可解析帧
    if (Number.isFinite(event.seq) && event.seq > this.lastEventSeq) {
      this.lastEventSeq = event.seq;
    }
    this.onEvent(event);
  }

  private resetWatchdog(): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      // 超过 watchdogMs 无任何帧：判定断线，abort 当前流并按游标重连
      this.handleDisconnect();
    }, this.watchdogMs);
  }

  private handleDisconnect(): void {
    if (this.stopped) return;
    this.teardown();
    this.onStatus('offline');
    const delay = this.reconnectDelaysMs[Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      if (this.stopped) return;
      this.openConnection();
    }, delay);
  }
}

/**
 * 解析一个 SSE 帧：
 * - `data: <json>` → StreamEvent（可多行 data，按 \n 连接）
 * - `: comment` / 空行 → null（心跳；调用方已重置看护）
 * - JSON 解析失败 → null（不崩溃、不漏看护）
 */
export function parseSseFrame(frame: string): StreamEvent | null {
  const dataLines: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '' || line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return null;
  try {
    const parsed = JSON.parse(dataLines.join('\n')) as StreamEvent;
    if (typeof parsed?.kind !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}
