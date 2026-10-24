// HTTP 传输层：fetch 包装 + 响应信封单点解包（FIX-ROUND-1 R-2）。
// 页面/客户端只面对类型化结果与 ApiError；不感知 mock（mock 在更外层拦截 fetch）。
//
// 信封约定（服务端全部端点统一，health 亦然）：
//   成功 {ok:true, data}          → 本层解包，业务代码只拿 data
//   失败 {ok:false, error:{code,message,request_id,detail}} → 本层抛错
// 单点解包：所有请求都经 request() 一个入口解包；任何按裸响应读字段的
// 写法都不允许存在（避免各处重复解包导致漂移）。

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

// ---------- 信封类型（R-2） ----------

/** 成功信封：{ok:true, data}。data 缺失按 undefined 处理（正常端点不会出现）。 */
interface SuccessEnvelope {
  ok: true;
  data?: unknown;
}

/** 失败信封：{ok:false, error:{...}}。 */
interface FailureEnvelope {
  ok: false;
  error?: {
    code?: string;
    message?: string;
    request_id?: string;
    detail?: Record<string, unknown>;
  };
}

type ResponseEnvelope = SuccessEnvelope | FailureEnvelope;

function isResponseEnvelope(body: unknown): body is ResponseEnvelope {
  return (
    typeof body === 'object' &&
    body !== null &&
    'ok' in body &&
    typeof (body as { ok?: unknown }).ok === 'boolean'
  );
}

/** 失败信封 → ApiError（409 → CommandConflictError；5xx/408 记 retryable）。 */
function toApiError(response: Response, envelope: FailureEnvelope): ApiError {
  const code = envelope.error?.code ?? `http_${response.status}`;
  const message = envelope.error?.message ?? `请求失败（HTTP ${response.status}）`;
  const requestId = envelope.error?.request_id;
  const detail = envelope.error?.detail;
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
    // AbortError 是「调用方取消」而非「结果未知」：原样重抛，
    // 让 TanStack Query / 调用方按取消语义处理（不走 §0.7 待确认路径）。
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      throw cause;
    }
    throw new NetworkError(cause);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  // 响应体解析失败（空体/非 JSON）按 undefined 进入信封判定，
  // 由下面的 malformed_envelope 分支统一报错，不把裸体误当 data。
  const body: unknown = await response.json().catch(() => undefined);

  if (isResponseEnvelope(body)) {
    if (body.ok) {
      // 成功：单点解包，业务只拿 data
      return (body as SuccessEnvelope).data as T;
    }
    // 失败：按信封 error 抛（原因码原样保留，409 → CommandConflictError）
    throw toApiError(response, body as FailureEnvelope);
  }

  // 非信封响应（服务端应全部统一信封；代理层 HTML 错误页等会落到这里）：
  // 保守按失败处理，绝不忍住吞掉——避免把非信封体当 data 传给业务代码。
  throw new ApiError({
    status: response.status,
    code: 'malformed_envelope',
    message: `响应不符合统一信封（缺少 ok 布尔字段）：${path}`,
    retryable: response.status >= 500,
  });
}

export function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: 'GET', signal });
}

/** 普通 POST（capture 等）：信封解包后返回 data。 */
export function apiPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body), signal });
}

/**
 * 命令提交：{ok:true, data:receipt}（202 = 已受理，P 层待确认，不等领域完成）；
 * {ok:false} 且 409 抛 CommandConflictError（原因原样呈现，不绕过）；其余按 ApiError。
 */
export function apiCommand(path: string, body: unknown, signal?: AbortSignal): Promise<CommandReceipt> {
  return request<CommandReceipt>(path, { method: 'POST', body: JSON.stringify(body), signal });
}
