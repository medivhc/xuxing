// HTTP 传输层：fetch 包装 + 错误信封解析。
// 页面/客户端只面对类型化结果与 ApiError；不感知 mock（mock 在更外层拦截 fetch）。

import type { CommandReceipt } from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly detail?: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(params: {
    status: number;
    code: string;
    message: string;
    requestId?: string;
    detail?: Record<string, unknown>;
    retryable?: boolean;
  }) {
    super(params.message);
    this.name = 'ApiError';
    this.status = params.status;
    this.code = params.code;
    this.requestId = params.requestId;
    this.detail = params.detail;
    this.retryable = params.retryable ?? false;
  }
}

/** 409：前置条件/版本冲突。界面进冲突态，展示最新投影，不自动重试覆盖（§0.5/§0.6）。 */
export class CommandConflictError extends ApiError {
  constructor(params: { code: string; message: string; requestId?: string; detail?: Record<string, unknown> }) {
    super({ status: 409, ...params, retryable: false });
    this.name = 'CommandConflictError';
  }
}

/** 网络层失败（fetch reject / 超时）：结果未知，按 §0.7 走「结果待确认」，复用同一 client_submit_id。 */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super('网络请求未完成（结果未知）');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    request_id?: string;
    detail?: Record<string, unknown>;
  };
}

async function parseError(response: Response): Promise<ApiError> {
  let body: ErrorEnvelope = {};
  try {
    body = (await response.json()) as ErrorEnvelope;
  } catch {
    body = {};
  }
  const code = body.error?.code ?? `http_${response.status}`;
  const message = body.error?.message ?? `请求失败（HTTP ${response.status}）`;
  const requestId = body.error?.request_id;
  const detail = body.error?.detail;
  const retryable = response.status >= 500 || response.status === 408;
  if (response.status === 409) {
    return new CommandConflictError({ code, message, requestId, detail });
  }
  return new ApiError({ status: response.status, code, message, requestId, detail, retryable });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch (cause) {
    throw new NetworkError(cause);
  }
  if (!response.ok) {
    throw await parseError(response);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: 'GET', signal });
}

/** 普通 POST（capture 等）：2xx 即返回体。 */
export function apiPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body), signal });
}

/**
 * 命令提交：202 + receipt 表示「已受理」（P 层待确认，不等领域完成）；
 * 409 抛 CommandConflictError（原因原样呈现，不绕过）；其余按 ApiError。
 */
export function apiCommand(path: string, body: unknown, signal?: AbortSignal): Promise<CommandReceipt> {
  return request<CommandReceipt>(path, { method: 'POST', body: JSON.stringify(body), signal });
}
