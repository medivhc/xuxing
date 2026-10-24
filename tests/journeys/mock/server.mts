import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  ApiErrorBody,
  CommandResultData,
  DevBurstData,
  HealthResponse,
  SuccessEnvelope,
} from '../contract.mts';
import { CURRENT_ACTOR_ID, DEMO, MOCK_PORT, SSE_HEARTBEAT_MS, SSE_LIMITS } from '../journeys.config.mts';
import { ApiError, badRequest, notFound, unavailable } from './errors.mts';
import { JourneyState } from './state.mts';
import { SseHub, updateFrame } from './sse.mts';

// ============================================================================
// 旅程 mock 服务（tests/journeys/mock）
//
// 只实现协调者定版的 HTTP 契约 + SSE（FIX-ROUND-1 R-2/R-6/R-8）：
//   GET  /api/health              → {ok:true, data:{ok, db, projection_version, limits}}
//   GET  /api/home                → {ok:true, data}
//   GET  /api/actions             → {ok:true, data:{... items}}
//   GET  /api/projects/:projectId → {ok:true, data}（R-8 键集）
//   GET  /api/proposals/:id       → {ok:true, data}（R-11 不预告 task_id）
//   POST /api/capture             → 201 / 重放 200，data 含 capture_id
//   POST /api/commands            → 首次 201 + replayed:false，幂等重放 200 + replayed:true
//   GET  /api/stream?cursor=<seq> → SSE（event / ready / notice / 心跳）
// 失败一律 {ok:false, error:{code,message,detail?}}，code ∈
//   bad_request / not_found / conflict / unavailable（R-5）。
// 另加 mock-only 的 POST /api/dev/burst（背压测试造流）与静态 UI（浏览器旅程用）。
// 真服务集成时把 JOURNEY_BASE_URL 指过去，本文件完全不会被拉起。
// ============================================================================

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const staticFiles = new Map<string, { body: Buffer; type: string }>([
  ['/', { body: readFileSync(`${PUBLIC_DIR}index.html`), type: 'text/html; charset=utf-8' }],
  ['/index.html', { body: readFileSync(`${PUBLIC_DIR}index.html`), type: 'text/html; charset=utf-8' }],
  ['/assets/app.js', { body: readFileSync(`${PUBLIC_DIR}app.js`), type: 'text/javascript; charset=utf-8' }],
  ['/assets/styles.css', { body: readFileSync(`${PUBLIC_DIR}styles.css`), type: 'text/css; charset=utf-8' }],
]);

const hub = new SseHub({
  maxConnections: SSE_LIMITS.maxConnections,
  maxPendingPerConnection: SSE_LIMITS.maxPendingPerConnection,
  slowConsumerTimeoutMs: SSE_LIMITS.slowConsumerTimeoutMs,
  pumpIntervalMs: SSE_LIMITS.pumpIntervalMs,
});

let state: JourneyState;
state = new JourneyState((event) => {
  hub.publish(event, (record) => updateFrame(record, state.streamFrame(record)));
});
state.seedDemoProject();
state.seedDegradedFixture();

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID, x-xuxing-actor');
  res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/** 成功信封（R-2）：{ok:true, data}。 */
function sendOk<T>(res: ServerResponse, status: number, data: T): void {
  const body: SuccessEnvelope<T> = { ok: true, data };
  sendJson(res, status, body);
}

function sendApiError(res: ServerResponse, error: unknown): void {
  if (error instanceof ApiError) {
    for (const [name, value] of Object.entries(error.headers ?? {})) res.setHeader(name, value);
    const body: ApiErrorBody = {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.detail ? { detail: error.detail } : {}),
      },
    };
    sendJson(res, error.status, body);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error('[journey-mock] internal error:', message);
  sendJson(res, 500, {
    ok: false,
    error: { code: 'internal', message: `mock internal: ${message}` },
  } satisfies ApiErrorBody);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_048_576) throw badRequest('请求体超过 1MB 上限');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest('请求体不是合法 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('请求体必须是 JSON object');
  }
  return parsed as Record<string, unknown>;
}

function parseCursor(raw: string | null): number | null {
  if (raw === null || raw === '') return null;
  if (!/^\d+$/.test(raw)) throw badRequest('cursor 必须是非负整数（全局事件序号）');
  return Number(raw);
}

function parseProjectPath(pathname: string): string | null {
  const match = /^\/api\/projects\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

function parseProposalPath(pathname: string): string | null {
  const match = /^\/api\/proposals\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

/** 当前 actor（x-xuxing-actor 头，缺省取种子用户）——与真服务 actorOf 同口径。 */
function actorOf(req: IncomingMessage): string {
  const raw = req.headers['x-xuxing-actor'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value && value.length > 0 ? value : CURRENT_ACTOR_ID;
}

const server = createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  try {
    // ---- health -------------------------------------------------------------
    if (req.method === 'GET' && pathname === '/api/health') {
      const body: HealthResponse = {
        ok: true,
        data: {
          ok: true,
          db: true,
          projection_version: state.head,
          limits: {
            heartbeat_ms: SSE_HEARTBEAT_MS,
            max_connections: SSE_LIMITS.maxConnections,
            max_queue: SSE_LIMITS.maxPendingPerConnection,
          },
        },
      };
      // mock 扩展（不在定版契约内，真服务没有）：streams.active 供本地观测；
      // 慢消费者阈值/发送泵节拍仅供 mock 轮排障阅读。
      sendJson(res, 200, {
        ...body,
        data: {
          ...body.data,
          streams: { active: hub.activeCount },
          mock: {
            slow_consumer_timeout_ms: SSE_LIMITS.slowConsumerTimeoutMs,
            pump_interval_ms: SSE_LIMITS.pumpIntervalMs,
          },
        },
      } as unknown as SuccessEnvelope<Record<string, unknown>>);
      return;
    }

    // ---- 投影 ---------------------------------------------------------------
    if (req.method === 'GET' && pathname === '/api/home') {
      sendOk(res, 200, state.homeData(actorOf(req)));
      return;
    }
    if (req.method === 'GET' && pathname === '/api/actions') {
      sendOk(res, 200, state.actionsData(actorOf(req)));
      return;
    }
    const projectId = parseProjectPath(pathname);
    if (req.method === 'GET' && projectId) {
      sendOk(res, 200, state.projectData(projectId, actorOf(req)));
      return;
    }
    const proposalId = parseProposalPath(pathname);
    if (req.method === 'GET' && proposalId) {
      sendOk(res, 200, state.proposalData(proposalId));
      return;
    }

    // ---- capture（只产提议，不建任务 —— R-11）--------------------------------
    if (req.method === 'POST' && pathname === '/api/capture') {
      const body = await readJson(req);
      const projectId = typeof body.project_id === 'string' && body.project_id.length > 0
        ? body.project_id
        : DEMO.projectId;
      const result = state.capture(String(body.text ?? ''), projectId);
      // 降级提议必须以 notice 帧明示（R-9，与真服务同一语义）
      if (result.degraded) {
        hub.notice(
          {
            kind: 'proposal_degraded',
            proposal_id: result.proposal_id,
            degraded_reason: result.degraded_reason ?? undefined,
          },
          result.project_id,
        );
      }
      sendOk(res, 201, result);
      return;
    }

    // ---- 命令（R-6：首次 201，幂等重放 200 + data.replayed:true）------------
    if (req.method === 'POST' && pathname === '/api/commands') {
      const body = await readJson(req);
      if (body.payload !== undefined && (body.payload === null || typeof body.payload !== 'object' || Array.isArray(body.payload))) {
        throw badRequest('payload 必须是 JSON object');
      }
      const result: CommandResultData = state.executeCommand(
        {
          type: String(body.type ?? ''),
          payload: (body.payload as Record<string, unknown>) ?? {},
          client_submit_id: String(body.client_submit_id ?? ''),
        },
        actorOf(req),
      );
      sendOk(res, result.replayed ? 200 : 201, result);
      return;
    }

    // ---- SSE ----------------------------------------------------------------
    if (req.method === 'GET' && pathname === '/api/stream') {
      const cursor = parseCursor(url.searchParams.get('cursor'));
      // R-4：连接数上限 → 503 unavailable + Retry-After: 5（不进入 hub，不占名额）
      if (hub.atCapacity()) {
        throw unavailable(`SSE 连接数已达上限 ${SSE_LIMITS.maxConnections}`, {
          retry_after_ms: 5_000,
          max_connections: SSE_LIMITS.maxConnections,
        });
      }
      const ok = hub.attach(res, state.events, {
        projectionVersion: state.head,
        requestedCursor: cursor,
        frameOf: (event) => updateFrame(event, state.streamFrame(event)),
      });
      if (!ok) {
        throw unavailable('SSE 连接数已达上限', {
          retry_after_ms: 5_000,
          max_connections: SSE_LIMITS.maxConnections,
        });
      }
      res.socket?.setTimeout(0);
      res.setTimeout(0);
      return;
    }

    // ---- mock-only：背压测试造流 --------------------------------------------
    if (req.method === 'POST' && pathname === '/api/dev/burst') {
      if (process.env.JOURNEY_MOCK_DEV === '0') {
        throw notFound('dev 端点已禁用');
      }
      const body = await readJson(req);
      const count = Number(body.count ?? 0);
      if (!Number.isFinite(count) || count <= 0) throw badRequest('count 必须是正整数');
      const emitted = state.emitBurst(Math.floor(count));
      const data: DevBurstData = { emitted, projection_version: state.head };
      sendOk(res, 202, data);
      return;
    }

    // ---- 静态 UI ------------------------------------------------------------
    if (req.method === 'GET' && staticFiles.has(pathname)) {
      const file = staticFiles.get(pathname)!;
      res.writeHead(200, {
        'Content-Type': file.type,
        'Content-Length': file.body.length,
        'Cache-Control': 'no-store',
      });
      res.end(file.body);
      return;
    }
    if (req.method === 'GET' && pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    throw notFound(`未找到 ${req.method} ${pathname}`);
  } catch (error) {
    if (res.headersSent) {
      // SSE 已开始下流时发生错误：直接断开，客户端会带 cursor 重连。
      res.destroy();
      return;
    }
    sendApiError(res, error);
  }
});

server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 65_000;

server.listen(MOCK_PORT, '0.0.0.0', () => {
  console.log(`[journey-mock] listening on port ${MOCK_PORT} (head=${state.head})`);
});

function shutdown(): void {
  hub.closeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
