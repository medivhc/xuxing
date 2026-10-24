import type { CommandType } from '../contract.mts';

/**
 * 统一 HTTP 错误：路由层把它序列化成信封 `{ok:false, error:{code,message,detail?}}`。
 *
 * 错误码词表与服务端一致（FIX-ROUND-1 R-5）：
 *   400 bad_request / 404 not_found / 409 conflict / 503 unavailable。
 * 旧码 invalid_request / forbidden / terminal_state / too_many_connections 一律不再出现：
 * 409 类（越权、幂等冲突、提议已决）统一 `conflict`，细节放 error.detail；
 * SSE 连接数超限统一 503 `unavailable` + `Retry-After` 响应头（R-4）。
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: Record<string, unknown>;
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    code: string,
    message: string,
    extra: { detail?: Record<string, unknown>; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = extra.detail;
    this.headers = extra.headers;
  }
}

export function badRequest(message: string, detail?: Record<string, unknown>): ApiError {
  return new ApiError(400, 'bad_request', message, { detail });
}

export function notFound(message: string): ApiError {
  return new ApiError(404, 'not_found', message);
}

/** 契约义务：可用动作不含该命令 / 提议已决 / 幂等键冲突 → 一律 409 conflict。 */
export function conflict(message: string, detail?: Record<string, unknown>): ApiError {
  return new ApiError(409, 'conflict', message, { detail });
}

/** SSE 连接数上限（R-4）：503 + Retry-After，与真服务可观测行为一致。 */
export function unavailable(message: string, detail?: Record<string, unknown>): ApiError {
  return new ApiError(503, 'unavailable', message, { detail, headers: { 'Retry-After': '5' } });
}
