// Mock HTTP 错误：与真实服务端错误信封同构（{error:{code,message,request_id,detail}}），
// 由 handlers.ts 捕获后转成对应状态码的 Response。

export class MockHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'MockHttpError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  /** 409：前置条件/状态冲突（§0.5/§0.6：原样呈现，不自动重试覆盖）。 */
  static conflict(code: string, message: string, detail?: Record<string, unknown>): MockHttpError {
    return new MockHttpError(409, code, message, detail);
  }

  static notFound(code: string, message: string): MockHttpError {
    return new MockHttpError(404, code, message);
  }

  static badRequest(code: string, message: string): MockHttpError {
    return new MockHttpError(400, code, message);
  }
}
