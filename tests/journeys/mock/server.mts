import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ApiErrorBody, HealthResponse } from '../contract.mts';
import {
  CURRENT_ACTOR_ID,
  MOCK_PORT,
  SSE_HEARTBEAT_MS,
  SSE_LIMITS,
  USING_EXTERNAL_SERVICE,
} from '../journeys.config.mts';
import { ApiError, badRequest, notFound } from './errors.mts';
import { JourneyState } from './state.mts';
import { SseHub, updateFrame } from './sse.mts';

// ============================================================================
// 旅程 mock 服务（tests/journeys/mock）
//
// 只实现协调者定版的 HTTP 契约 + SSE：
//   GET  /api/health
//   GET  /api/home
//   GET  /api/projects/:projectId
//   GET  /api/actions
//   POST /api/capture
//   GET  /api/proposals/:proposalId
//   POST /api/commands
//   GET  /api/stream?cursor=<seq>
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
state.seedDegradedProposal();

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID');
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

function sendApiError(res: ServerResponse, error: unknown): void {
  if (error instanceof ApiError) {
    const body: ApiErrorBody = {
      error: {
        code: error.code,
        message: error.message,
        ...(error.available_actions ? { available_actions: error.available_actions } : {}),
        ...(error.details ? { details: error.details } : {}),
      },
      projection_version: state.head,
    };
    sendJson(res, error.status, body);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error('[journey-mock] internal error:', message);
  sendJson(res, 500, {
    error: { code: 'internal', message: USING_EXTERNAL_SERVICE ? message : `mock internal: ${message}` },
    projection_version: state.head,
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

function parseCursor(raw: string | null): number {
  if (raw === null || raw === '') return 0;
  if (!/^\d+$/.test(raw)) throw badRequest('cursor 必须是非负整数');
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
        service: 'xuxing-journey-mock',
        mock: true,
        limits: {
          max_connections: SSE_LIMITS.maxConnections,
          max_pending_per_connection: SSE_LIMITS.maxPendingPerConnection,
          slow_consumer_timeout_ms: SSE_LIMITS.slowConsumerTimeoutMs,
          pump_interval_ms: SSE_LIMITS.pumpIntervalMs,
          heartbeat_ms: SSE_HEARTBEAT_MS,
        },
        streams: { active: hub.activeCount },
      };
      sendJson(res, 200, body);
      return;
    }

    // ---- 投影 ---------------------------------------------------------------
    if (req.method === 'GET' && pathname === '/api/home') {
      sendJson(res, 200, state.homeProjection(CURRENT_ACTOR_ID));
      return;
    }
    if (req.method === 'GET' && pathname === '/api/actions') {
      sendJson(res, 200, state.actionsProjection(CURRENT_ACTOR_ID));
      return;
    }
    const projectId = parseProjectPath(pathname);
    if (req.method === 'GET' && projectId) {
      sendJson(res, 200, state.projectProjection(projectId, CURRENT_ACTOR_ID));
      return;
    }
    const proposalId = parseProposalPath(pathname);
    if (req.method === 'GET' && proposalId) {
      sendJson(res, 200, state.proposalProjection(proposalId));
      return;
    }

    // ---- capture ------------------------------------------------------------
    if (req.method === 'POST' && pathname === '/api/capture') {
      const body = await readJson(req);
      const result = state.capture(String(body.text ?? ''));
      sendJson(res, 201, result);
      return;
    }

    // ---- 命令 ---------------------------------------------------------------
    if (req.method === 'POST' && pathname === '/api/commands') {
      const body = await readJson(req);
      if (body.payload !== undefined && (body.payload === null || typeof body.payload !== 'object' || Array.isArray(body.payload))) {
        throw badRequest('payload 必须是 JSON object');
      }
      const result = state.executeCommand({
        type: String(body.type ?? ''),
        payload: (body.payload as Record<string, unknown>) ?? {},
        client_submit_id: String(body.client_submit_id ?? ''),
      });
      sendJson(res, 202, result);
      return;
    }

    // ---- SSE ----------------------------------------------------------------
    if (req.method === 'GET' && pathname === '/api/stream') {
      const cursor = parseCursor(url.searchParams.get('cursor'));
      if (cursor > state.head) {
        throw new ApiError(400, 'invalid_cursor', `cursor=${cursor} 超出当前 head=${state.head}`, {
          details: { head: state.head },
        });
      }
      if (hub.atCapacity()) {
        throw new ApiError(429, 'too_many_connections', `SSE 连接数已达上限 ${SSE_LIMITS.maxConnections}`, {
          details: { max_connections: SSE_LIMITS.maxConnections },
        });
      }
      const ok = hub.attach(res, cursor, state.events, (event) =>
        updateFrame(event, state.streamFrame(event)),
      );
      if (!ok) {
        throw new ApiError(429, 'too_many_connections', 'SSE 连接数已达上限', {
          details: { max_connections: SSE_LIMITS.maxConnections },
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
      sendJson(res, 202, { emitted, projection_version: state.head });
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
