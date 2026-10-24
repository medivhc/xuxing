// Mock fetch 拦截路由：把 8 个契约端点接到 MockStore 上。
//
// 纪律（任务书）：
// - 只拦 /api/*；其余请求（Vite HMR、静态资源等）交还原 fetch；
// - 与 api/ 客户端严格分离：客户端只见真实 HTTP 语义（状态码/信封/流）；
// - 全端点统一信封（FIX-ROUND-1 R-2）：成功 {ok:true, data}、失败
//   {ok:false, error:{code,message,request_id,detail}}，health 亦然；
// - 命令 202 + {ok:true, data:receipt}；409 原样透出原因码；GET 失败给 404/400。

import { ulid } from '../lib/ulid';
import { assertCommandShape, handleCapture, handleCommand } from './commands';
import { MockHttpError } from './errors';
import { createMockEventStream } from './sse-stream';
import type { MockStore } from './store';

function heartbeatIntervalMs(): number {
  const raw = import.meta.env.VITE_MOCK_HEARTBEAT_MS;
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 统一成功信封：{ok:true, data}（R-2：全部端点同一形状）。 */
function okResponse(data: unknown, status = 200): Response {
  return jsonResponse({ ok: true, data }, status);
}

function errorResponse(error: MockHttpError): Response {
  return jsonResponse(
    {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        request_id: `mock-req-${ulid()}`,
        detail: error.detail,
      },
    },
    error.status,
  );
}

async function readJsonBody(init?: RequestInit): Promise<unknown> {
  if (!init?.body || typeof init.body !== 'string') return {};
  try {
    return JSON.parse(init.body);
  } catch {
    throw MockHttpError.badRequest('invalid_json', '请求体不是合法 JSON');
  }
}

/** 模拟网络时延（可被 window.__xuxMock.setLatency 调整，便于 e2e 观察 pending 态）。 */
export const mockLatency = { read: 15, command: 40, capture: 30 };

async function route(store: MockStore, url: URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const path = url.pathname;

  if (path === '/api/stream') {
    if (method !== 'GET') throw new MockHttpError(405, 'method_not_allowed', 'stream 只支持 GET');
    const cursorRaw = Number.parseInt(url.searchParams.get('cursor') ?? '0', 10);
    const cursor = Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : 0;
    const stream = createMockEventStream(store, cursor, heartbeatIntervalMs(), init?.signal ?? undefined);
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  if (path === '/api/health' && method === 'GET') {
    await sleep(mockLatency.read);
    // health 亦统一信封：data 内 {ok, db, projection_version}（R-2）
    return okResponse({ ok: true, db: 'ok', projection_version: store.currentSeq() });
  }

  if (path === '/api/home' && method === 'GET') {
    await sleep(mockLatency.read);
    return okResponse(store.homeProjection());
  }

  if (path === '/api/actions' && method === 'GET') {
    await sleep(mockLatency.read);
    return okResponse(store.actionsProjection());
  }

  const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch && method === 'GET') {
    await sleep(mockLatency.read);
    const projection = store.projectProjection(decodeURIComponent(projectMatch[1]));
    if (!projection) throw MockHttpError.notFound('project_not_found', '项目不存在');
    return okResponse(projection);
  }

  const proposalMatch = path.match(/^\/api\/proposals\/([^/]+)$/);
  if (proposalMatch && method === 'GET') {
    await sleep(mockLatency.read);
    const projection = store.proposalProjection(decodeURIComponent(proposalMatch[1]));
    if (!projection) throw MockHttpError.notFound('proposal_not_found', '提议不存在');
    return okResponse(projection);
  }

  if (path === '/api/capture' && method === 'POST') {
    await sleep(mockLatency.capture);
    const body = (await readJsonBody(init)) as { text?: unknown; client_submit_id?: unknown };
    if (typeof body.client_submit_id !== 'string' || body.client_submit_id.trim() === '') {
      throw MockHttpError.badRequest('invalid_capture', 'capture 缺少 client_submit_id（幂等键）');
    }
    return okResponse(
      handleCapture(store, {
        text: typeof body.text === 'string' ? body.text : '',
        client_submit_id: body.client_submit_id,
      }),
    );
  }

  if (path === '/api/commands' && method === 'POST') {
    await sleep(mockLatency.command);
    const command = assertCommandShape(await readJsonBody(init));
    const receipt = handleCommand(store, command);
    // 202 = 已受理（P 层待确认），不表示领域动作已完成（§0.5）
    return okResponse(receipt, 202);
  }

  throw MockHttpError.notFound('route_not_found', `mock 未实现的路由：${method} ${path}`);
}

export function createMockFetch(store: MockStore): typeof fetch {
  const originalFetch = globalThis.fetch.bind(globalThis);
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const url = new URL(rawUrl, globalThis.location?.origin ?? 'http://127.0.0.1:5173');
    if (!url.pathname.startsWith('/api/')) {
      return originalFetch(input as RequestInfo, init);
    }
    // 已中止的请求直接以 AbortError 拒绝（与真实 fetch 语义一致）
    if (init?.signal?.aborted) {
      throw new DOMException('已中止', 'AbortError');
    }
    try {
      return await route(store, url, init);
    } catch (error) {
      if (error instanceof MockHttpError) return errorResponse(error);
      throw error;
    }
  };
}
