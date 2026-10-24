import type { CommandType } from '../contract.mts';

/** 统一 HTTP 错误：路由层只负责把它序列化成 {error:{code,message,...}}。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly available_actions?: CommandType[];
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    extra: { available_actions?: CommandType[]; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.available_actions = extra.available_actions;
    this.details = extra.details;
  }
}

export function badRequest(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(400, 'invalid_request', message, { details });
}

export function notFound(message: string): ApiError {
  return new ApiError(404, 'not_found', message);
}

/** 契约义务：可用动作不含该命令就必须 409，并回显服务端认定的 available_actions。 */
export function forbidden(message: string, availableActions: CommandType[]): ApiError {
  return new ApiError(409, 'forbidden', message, { available_actions: availableActions });
}

export function terminalState(message: string): ApiError {
  return new ApiError(409, 'terminal_state', message, { available_actions: [] });
}
