// Mock SSE 流：GET /api/stream?cursor=<seq> 的 ReadableStream 实现。
//
// 与服务端契约一致的行为：
// - 连接即补发 cursor 之后的事件（重连补发，配合客户端自管游标）；
// - 之后转实时广播（store.appendEvent → 所有订阅流）；
// - 15s 一帧心跳（data 帧携带当前 seq，客户端据此对齐游标）；
// - 控制面 stopHeartbeats() 后不再发任何帧 → 客户端 35s 看护超时判定断线，
//   用于 e2e 验证「35s 无帧重连」纪律；
// - 监听 AbortSignal：客户端 abort 时立即收流，避免僵尸订阅。

import type { MockEventRecord, MockStore } from './store';

const encoder = new TextEncoder();

export function formatEventFrame(event: {
  seq: number;
  kind: string;
  project_id?: string;
  task_id?: string;
  proposal_id?: string;
  decision_id?: string;
  summary?: string;
}): string {
  const payload: Record<string, unknown> = { seq: event.seq, kind: event.kind };
  if (event.project_id) payload.project_id = event.project_id;
  if (event.task_id) payload.task_id = event.task_id;
  if (event.proposal_id) payload.proposal_id = event.proposal_id;
  if (event.decision_id) payload.decision_id = event.decision_id;
  if (event.summary) payload.summary = event.summary;
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function formatHeartbeatFrame(seq: number): string {
  return formatEventFrame({ seq, kind: 'heartbeat' });
}

export function createMockEventStream(
  store: MockStore,
  cursor: number,
  heartbeatMs: number,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => {
        closed = true;
        if (timer) clearInterval(timer);
        timer = null;
        unsubscribe?.();
        unsubscribe = null;
      };
      const send = (frame: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          // 流已关闭：忽略
        }
      };

      if (signal) {
        if (signal.aborted) {
          cleanup();
          controller.close();
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            cleanup();
            try {
              controller.close();
            } catch {
              // 已关闭：忽略
            }
          },
          { once: true },
        );
      }

      // 1) 连接即来一帧（客户端看护立即重置，无需等 15s）
      send(formatHeartbeatFrame(store.currentSeq()));
      // 2) 补发 cursor 之后的存量事件
      for (const event of store.eventsAfter(cursor)) {
        send(formatEventFrame(event));
      }
      // 3) 实时广播
      unsubscribe = store.subscribe((event: MockEventRecord) => send(formatEventFrame(event)));
      // 4) 心跳（控制面可整体停发，模拟连接假死）
      timer = setInterval(() => {
        if (store.heartbeatsOn) send(formatHeartbeatFrame(store.currentSeq()));
      }, heartbeatMs);
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
    },
  });
}
