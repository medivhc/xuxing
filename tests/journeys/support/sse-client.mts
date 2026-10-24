import { setTimeout as sleep } from 'node:timers/promises';
import { JOURNEY_BASE_URL } from '../journeys.config.mts';

// ============================================================================
// 极简 SSE 客户端（协议级测试用；不依赖浏览器 EventSource）。
//
// - open({paused:true}) 只拿响应头、不读 body —— 用来构造「慢消费者」；
// - startReading() 之后按 chunk 解析 event/id/data/comment；
// - waitFor / waitForUpdate / waitForClosed 给测试确定性的等待点。
// ============================================================================

export interface SseFrame {
  id: string | null;
  event: string;
  data: string | null;
  comment: string | null;
}

export interface ParsedUpdate {
  seq: number;
  kind: string;
  type: string;
  project_id: string;
  entity_id: string;
  summary: string;
  degraded: boolean;
  occurred_at: string;
}

export class SseOpenError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`SSE 打开失败：HTTP ${status} ${body.slice(0, 300)}`);
    this.name = 'SseOpenError';
    this.status = status;
    this.body = body;
  }
}

interface Waiter {
  predicate: (frame: SseFrame) => boolean;
  resolve: (frame: SseFrame) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function parseBlock(block: string): SseFrame | null {
  let event = 'message';
  let id: string | null = null;
  const dataLines: string[] = [];
  const commentLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) {
      commentLines.push(line.slice(1).trimStart());
      continue;
    }
    const index = line.indexOf(':');
    const field = index === -1 ? line : line.slice(0, index);
    const rawValue = index === -1 ? '' : line.slice(index + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') dataLines.push(value);
    // retry / 未知字段忽略
  }
  const data = dataLines.length > 0 ? dataLines.join('\n') : null;
  const comment = commentLines.length > 0 ? commentLines.join('\n') : null;
  if (data === null && comment === null && event === 'message') return null;
  return { id, event, data, comment };
}

export class SseStream {
  private readonly response: Response;
  private readonly controller: AbortController;
  private readonly decoder = new TextDecoder();
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private buffer = '';
  private readonly frameList: SseFrame[] = [];
  private readonly waiters = new Set<Waiter>();
  private readingStarted = false;
  private endedFlag = false;
  private aborted = false;
  private readError: unknown = null;
  private resolveClosed!: () => void;
  private readonly closedPromise: Promise<void>;

  private constructor(response: Response, controller: AbortController) {
    this.response = response;
    this.controller = controller;
    this.closedPromise = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  static async open(path: string, options: { paused?: boolean } = {}): Promise<SseStream> {
    const url = path.startsWith('http') ? path : `${JOURNEY_BASE_URL}${path}`;
    const controller = new AbortController();
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-store' },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      controller.abort();
      throw new SseOpenError(response.status, body);
    }
    const stream = new SseStream(response, controller);
    if (!options.paused) stream.startReading();
    return stream;
  }

  get status(): number {
    return this.response.status;
  }

  get headers(): Headers {
    return this.response.headers;
  }

  get frames(): readonly SseFrame[] {
    return this.frameList;
  }

  get ended(): boolean {
    return this.endedFlag;
  }

  get closed(): Promise<void> {
    return this.closedPromise;
  }

  get error(): unknown {
    return this.readError;
  }

  startReading(): void {
    if (this.readingStarted) return;
    this.readingStarted = true;
    if (!this.response.body) {
      this.endedFlag = true;
      this.resolveClosed();
      throw new Error('SSE response 没有 body');
    }
    this.reader = this.response.body.getReader();
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    try {
      while (!this.aborted) {
        const { done, value } = await this.reader!.read();
        if (done) break;
        if (value) {
          this.buffer += this.decoder.decode(value, { stream: true });
          this.parseBuffer();
        }
      }
    } catch (error) {
      if (!this.aborted) this.readError = error;
    } finally {
      try {
        this.buffer += this.decoder.decode();
        this.parseBuffer();
      } catch {
        // ignore
      }
      this.endedFlag = true;
      this.resolveClosed();
      this.failWaitersOnClose();
    }
  }

  private parseBuffer(): void {
    // SSE 以空行分帧；兼容 CRLF。
    this.buffer = this.buffer.replace(/\r\n/g, '\n');
    const blocks = this.buffer.split('\n\n');
    this.buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      if (block.trim().length === 0) continue;
      const frame = parseBlock(block);
      if (!frame) continue;
      this.frameList.push(frame);
      this.notify(frame);
    }
  }

  private notify(frame: SseFrame): void {
    for (const waiter of [...this.waiters]) {
      let matched = false;
      try {
        matched = waiter.predicate(frame);
      } catch {
        matched = false;
      }
      if (matched) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(frame);
      }
    }
  }

  private failWaitersOnClose(): void {
    const tail = this.frameList
      .slice(-5)
      .map((frame) => `${frame.event}:${frame.data ?? frame.comment ?? ''}`)
      .join(' | ');
    for (const waiter of [...this.waiters]) {
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.reject(
        new Error(
          `SSE 已关闭但未等到目标帧（readError=${this.readError instanceof Error ? this.readError.message : 'none'}）；最近帧：${tail}`,
        ),
      );
    }
  }

  waitFor(predicate: (frame: SseFrame) => boolean, timeoutMs = 8_000): Promise<SseFrame> {
    for (const frame of this.frameList) {
      if (predicate(frame)) return Promise.resolve(frame);
    }
    if (this.endedFlag) {
      return Promise.reject(new Error('SSE 已关闭，目标帧不会再来'));
    }
    return new Promise<SseFrame>((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`等待 SSE 帧超时（${timeoutMs}ms）；已收到 ${this.frameList.length} 帧`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  async waitForUpdate(predicate: (update: ParsedUpdate) => boolean, timeoutMs = 8_000): Promise<ParsedUpdate> {
    const frame = await this.waitFor((candidate) => {
      if (candidate.event !== 'update' || !candidate.data) return false;
      try {
        return predicate(JSON.parse(candidate.data) as ParsedUpdate);
      } catch {
        return false;
      }
    }, timeoutMs);
    return JSON.parse(frame.data!) as ParsedUpdate;
  }

  updates(): ParsedUpdate[] {
    const result: ParsedUpdate[] = [];
    for (const frame of this.frameList) {
      if (frame.event !== 'update' || !frame.data) continue;
      try {
        result.push(JSON.parse(frame.data) as ParsedUpdate);
      } catch {
        // 非 JSON update 帧不参与序号断言
      }
    }
    return result;
  }

  updateSeqs(): number[] {
    return this.updates().map((update) => update.seq);
  }

  backpressureFrame(): { code: string; reason: string } | null {
    const found = this.frameList.find((frame) => frame.event === 'backpressure' && frame.data);
    if (!found) return null;
    try {
      return JSON.parse(found.data!) as { code: string; reason: string };
    } catch {
      return null;
    }
  }

  async waitForClosed(timeoutMs = 8_000): Promise<void> {
    if (this.endedFlag) return;
    const timeout = sleep(timeoutMs).then(() => {
      throw new Error(`等待 SSE 关闭超时（${timeoutMs}ms）`);
    });
    await Promise.race([this.closedPromise, timeout]);
  }

  close(): void {
    if (this.aborted) return;
    this.aborted = true;
    try {
      this.controller.abort();
    } catch {
      // ignore
    }
    if (this.reader) {
      try {
        // abort 之后 cancel 可能以 AbortError 拒绝；属预期，显式吞掉，
        // 否则 Node 会把它当成未处理拒绝并让 Playwright 判失败。
        void this.reader.cancel().catch(() => {
          // ignore
        });
      } catch {
        // ignore
      }
    } else {
      // paused 流还没拿 reader：cancel 底层 body，避免 abort 后留下未处理拒绝。
      try {
        void this.response.body?.cancel().catch(() => {
          // ignore
        });
      } catch {
        // ignore
      }
    }
    if (!this.endedFlag) {
      this.endedFlag = true;
      this.resolveClosed();
      this.failWaitersOnClose();
    }
  }
}
