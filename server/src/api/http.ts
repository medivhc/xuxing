// HTTP 契约信封约定（任务书 §4）。所有投影类响应必带 projection_version ——
// 即"该投影已并入的最大 global_seq"，与 SSE 的 cursor 同量纲，客户端据此对齐快照与订阅。

/** 所有成功响应的外层包装。 */
export interface ApiEnvelope<T> {
  ok: true;
  data: T;
}

/** 投影类数据：projection_version = 快照计算时事件流的最大 global_seq。 */
export interface ProjectionMeta {
  /**
   * 快照投影版本（= 已并入的最大 global_seq；空库为 0）。
   * 客户端规则（SSE 纪律 1）：先建订阅、再取快照；把本字段当 cursor 的起点，
   * 之后收到 seq <= projection_version 的帧可直接忽略（幂等），缺口靠 cursor 补发。
   */
  projection_version: number;
}

/** SSE 背压参数的对外投影（FIX-ROUND-1 R-3）：数值一律来自 SseOptions，不另起常量。 */
export interface RuntimeLimits {
  heartbeat_ms: number;
  max_connections: number;
  max_queue: number;
}

/** GET /api/health 的 data（FIX-ROUND-1 R-2：health 也走 {ok:true,data} 信封）。 */
export interface HealthData extends ProjectionMeta {
  /** 运行时可用性：DB 连得上才算 ok */
  ok: boolean;
  db: boolean;
  limits: RuntimeLimits;
  /**
   * K1-C：用户面访问控制是否启用（K1-SPEC §5.3）。前端入口门据此决定是否
   * 先探受保护读面。health 保持既有字段为超集（journeys/CI 依赖 limits 与
   * db），只增补本字段、不泄漏任何业务数据，豁免口径不变。
   */
  auth_enabled: boolean;
}

/** 错误响应：code 机器可读，message 人类可读，detail 附可判定依据。 */export interface ApiError {
  ok: false;
  error: {
    code: string;
    message: string;
    detail?: unknown;
  };
}

export const ERROR_CODES = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  range_not_satisfiable: 416,
  unavailable: 503,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export function ok<T>(data: T): ApiEnvelope<T> {
  return { ok: true, data };
}

export function fail(code: ErrorCode, message: string, detail?: unknown): ApiError {
  return { ok: false, error: detail === undefined ? { code, message } : { code, message, detail } };
}
