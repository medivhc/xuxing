// SSE 三纪律的传输层实现（任务书 §3 必守必测）：
//
// ① 快照-订阅对齐：每个连接在建立时先"订阅"（进入 hub 的推送名单），再取快照水位
//    snapshot_version 作为 ready 帧；客户端把 ready.projection_version 当 cursor 起点。
//    为避免"订阅了但还没进名单期间提交的事件丢失"，连接建立后先按 cursor 补发（含 ready 之前
//    已提交但未广播的事件），再并入实时；每一帧都带 seq，客户端按 seq 幂等去重。
// ② 游标补发自理：不依赖浏览器 EventSource 重连；客户端带 ?cursor=<seq>，服务端从事件表
//    按 global_seq 补发缺口（跨 project，全局序号），再转实时。
// ③ 背压：连接数上限（超限 503 + Retry-After）、每连接待发队列上限（超限断连并告知
//    retry cursor）、慢连接超时断开（写阻塞超过 slowTimeoutMs）、心跳保活（15s）。

import type { EventEnvelope } from '../../../src/kernel/events.ts';
import { EVENT_TYPES } from '../../../src/kernel/events.ts';

export interface FrameOptions {
  cursor: number | null;
  project_id?: string | null;
}

export interface FrameParseResult {
  ok: boolean;
  cursor: number | null;
  project_id: string | null;
  error?: string;
}

export function parseFrameQuery(query: {
  cursor?: string | null;
  project_id?: string | null;
}): FrameParseResult {
  const raw = query.cursor ?? null;
  let cursor: number | null = null;
  if (raw !== null && raw !== '') {
    if (!/^\d+$/.test(raw)) {
      return { ok: false, cursor: null, project_id: null, error: 'cursor 必须是非负整数（全局事件序号）' };
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) {
      return { ok: false, cursor: null, project_id: null, error: 'cursor 超出安全整数范围' };
    }
    cursor = value;
  }
  const projectRaw = query.project_id ?? null;
  return { ok: true, cursor, project_id: projectRaw === null || projectRaw === '' ? null : projectRaw };
}

/** 事件 → SSE 摘要帧（含 seq 与 kind，§4 契约）。 */
export function toSummaryFrame(event: EventEnvelope): Record<string, unknown> {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  return {
    kind: event.type,
    seq: event.global_seq,
    stream_id: event.stream_id,
    project_id: event.stream_id,
    task_id: typeof payload.task_id === 'string' ? payload.task_id : null,
    proposal_id: typeof payload.change_id === 'string' ? payload.change_id : null,
    occurred_at: event.occurred_at,
  };
}

export interface SseOptions {
  /** 连接数上限 */
  maxConnections: number;
  /** 每连接待发队列上限（超过即判定为慢连接） */
  queueLimit: number;
  /** 慢连接超时：队列有积压且持续超过该时长即断开 */
  slowTimeoutMs: number;
  /** 心跳间隔（契约：15s） */
  heartbeatMs: number;
}

export function sseOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): SseOptions {
  const num = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value ?? '');
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    maxConnections: num(env.XUXING_SSE_MAX_CONNECTIONS, 32),
    queueLimit: num(env.XUXING_SSE_QUEUE_LIMIT, 256),
    slowTimeoutMs: num(env.XUXING_SSE_SLOW_TIMEOUT_MS, 15_000),
    heartbeatMs: num(env.XUXING_SSE_HEARTBEAT_MS, 15_000),
  };
}

export interface SseMetrics {
  connections: number;
  dropped_slow: number;
  dropped_overflow: number;
  rejected_limit: number;
  frames_sent: number;
  heartbeats_sent: number;
}

/**
 * 连接计数（背压纪律③的第一条）：全局上限，超限时由路由回 503 + Retry-After。
 */
export class ConnectionBudget {
  private active = 0;
  readonly metrics: SseMetrics = {
    connections: 0,
    dropped_slow: 0,
    dropped_overflow: 0,
    rejected_limit: 0,
    frames_sent: 0,
    heartbeats_sent: 0,
  };

  constructor(readonly maxConnections: number) {}

  get count(): number {
    return this.active;
  }

  tryAcquire(): boolean {
    if (this.active >= this.maxConnections) {
      this.metrics.rejected_limit += 1;
      return false;
    }
    this.active += 1;
    this.metrics.connections = this.active;
    return true;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.metrics.connections = this.active;
  }
}

let cachedEventTypes: Set<string> | null = null;

/** 事件类型是否在 spec §4 封闭集内（SSE 只透传目录内类型）。 */
export function isKnownEventType(kind: string): boolean {
  if (cachedEventTypes === null) cachedEventTypes = new Set<string>(EVENT_TYPES);
  return cachedEventTypes.has(kind);
}
