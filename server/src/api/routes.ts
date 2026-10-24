import { Hono } from 'hono';
import type { Pool } from 'pg';
import { ulid } from 'ulid';
import { fail, ok, type HealthData, type RuntimeLimits } from './http.ts';
import { actionsView, homeView, projectView, proposalView } from './views.ts';
import type { ProjectionService } from '../projection/service.ts';
import type { Proposer } from '../proposers/proposer.ts';
import type { PgEventStore } from '../../../src/kernel/event-store-pg.ts';
import type { EventEnvelope } from '../../../src/kernel/events.ts';
import { MAX_OUTSTANDING_WRITES, type Hub, type SseConnection } from '../sse/hub.ts';
import {
  CommandDeniedError,
  CommandForbiddenError,
  CommandNotFoundError,
  CommandValidationError,
  IdempotencyConflictError,
  runCommand,
  runEvidenceCommand,
  type CommandActor,
} from '../commands/commands.ts';
import { ActorValidationError, ToolOutputChannelError } from '../../../src/kernel/actor-guard.ts';
import { CaptureValidationError, runCapture } from '../commands/capture.ts';
import type { SseOptions } from '../sse/protocol.ts';
import { establishSseConnection } from '../sse/connection.ts';
import { registerStaticHosting } from './static.ts';
import {
  clearedCookieHeader,
  createAuthMiddleware,
  sessionCookieHeader,
  sessionCookieOf,
  tokensEqual,
  type AuthService,
} from '../auth/auth.ts';
import { registerNodeRoutes } from './nodes-routes.ts';
import type { NodeDispatcher } from '../nodes/dispatcher.ts';

export interface AppContext {
  pool: Pool;
  store: PgEventStore;
  projection: ProjectionService;
  proposer: Proposer;
  hub: Hub;
  sse: SseOptions;
  clock: () => Date;
  defaultProjectId: string;
  defaultActorId: string;
  /** A 案静态自托管的 web/dist 目录；null/未设 = 纯 API 形态，不注册静态兜底。 */
  webDist?: string | null;
  /** K1-C 访问控制（双令牌 + 会话存储）。 */
  auth: AuthService;
  /** K1-B 执行节点派发服务。 */
  dispatcher: NodeDispatcher;
}

/**
 * health 对外暴露的背压参数（FIX-ROUND-1 R-3）：唯一来源是注入的 SSE 配置（app.ts 里由
 * sseOptionsFromEnv / 测试显式传入），这里不做任何兜底常量，避免出现第二份硬编码。
 */
export function limitsOf(sse: SseOptions): RuntimeLimits {
  return {
    heartbeat_ms: sse.heartbeatMs,
    max_connections: sse.maxConnections,
    max_queue: sse.queueLimit,
  };
}

/** 当前用户（K0 单用户；多用户/权限属 K2，不在这里发明）。 */
/** Q12：actor_kind 可由 x-xuxing-actor-kind 头声明（机器通道/测试），形状合法性由命令入口统一校验。 */
function actorOf(header: string | undefined, fallback: string, kindHeader?: string): CommandActor {
  const value = header?.trim();
  const kind = kindHeader?.trim();
  return {
    actor_id: value && value.length > 0 ? value : fallback,
    actor_kind: (kind && kind.length > 0 ? kind : 'human') as CommandActor['actor_kind'],
  };
}

/**
 * 命令信封 actor（K1 §3.2）：body.actor 若带合法 actor_id/actor_kind 则以其
 * 为准（resolve_decision 的 actor_not_human 校验据此）；缺省回落请求头口径。
 * 其余命令不读 body.actor，行为不变。
 */
function envelopeActorOf(body: Record<string, unknown>, header: string | undefined, fallback: string, kindHeader?: string): CommandActor {
  const raw = body.actor;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    const kind = record.actor_kind;
    const id = record.actor_id;
    if ((kind === 'human' || kind === 'agent' || kind === 'system') && typeof id === 'string' && id.trim() !== '') {
      return { actor_id: id, actor_kind: kind };
    }
  }
  return actorOf(header, fallback, kindHeader);
}

function errorResponse(error: unknown): Response {
  if (error instanceof CommandForbiddenError) {
    return Response.json(fail('forbidden', error.message, error.detail), { status: 403 });
  }
  if (error instanceof CommandNotFoundError) {
    return Response.json(fail('not_found', error.message, error.detail), { status: 404 });
  }
  if (error instanceof CommandDeniedError) {
    return Response.json(fail('conflict', error.message, error.detail), { status: 409 });
  }
  if (error instanceof IdempotencyConflictError) {
    return Response.json(
      fail('conflict', error.message, { reason: 'idempotency_key_conflict', retryable: false }),
      { status: 409 },
    );
  }
  if (error instanceof CommandValidationError || error instanceof CaptureValidationError || error instanceof ActorValidationError) {
    return Response.json(fail('bad_request', error.message, error.detail), { status: 400 });
  }
  if (error instanceof ToolOutputChannelError) {
    return Response.json(fail('conflict', error.message, error.detail), { status: 409 });
  }
  const message = error instanceof Error ? error.message : String(error);
  return Response.json(fail('internal', message), { status: 500 });
}

/**
 * 在响应返回前广播本次写入真正落账的事件（写入返回即可推）。
 *
 * 广播的是写入方自己交出的事件信封，而不是"写后再读尾部"：写入路径已在返回前把
 * 同一批事件并入投影，此时水位已越过它们，再读尾部只会读到空集。
 */
function commitAndBroadcast(ctx: AppContext, events: EventEnvelope[]): void {
  ctx.hub.broadcast(events);
}

async function readJsonObject(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return null;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

export function createApp(ctx: AppContext): Hono {
  const app = new Hono();


  app.use('*', async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  });

  // K1-C：访问控制中间件覆盖全部 /api/*（豁免 health 与 auth/session，见 auth.ts）。
  app.use('/api/*', createAuthMiddleware(ctx.auth, ctx.clock));

  // ---- GET /api/health ----
  // 信封与全部端点一致（FIX-ROUND-1 R-2）：外层 ok 表示"服务在应答"，data 里再区分运行时状态。
  app.get('/api/health', async (c) => {
    let db = false;
    try {
      await ctx.pool.query('select 1');
      db = true;
    } catch {
      db = false;
    }
    return c.json(
      ok<HealthData>({
        ok: db,
        db,
        projection_version: ctx.projection.version(),
        limits: limitsOf(ctx.sse),
        auth_enabled: ctx.auth.userAuthEnabled,
      }),
    );
  });

  // ---- POST /api/auth/session（K1-C §5.2）----
  // 以请求体提交用户令牌换会话 cookie。节点令牌提交到这里同样 401、不下发
  // cookie（双令牌互不通用）。失败一律 401 同形，不区分错令牌/无令牌。
  app.post('/api/auth/session', async (c) => {
    const body = await readJsonObject(c);
    const token = body !== null && typeof body.token === 'string' ? body.token : null;
    const { config } = ctx.auth;
    if (config.accessToken === null) {
      // 未启用访问控制（非 production）：无会话可换，前端入口门不会出现。
      return c.json(ok({ auth_enabled: false }));
    }
    if (token === null || !tokensEqual(token, config.accessToken)) {
      return c.json(fail('unauthorized', 'unauthorized'), 401);
    }
    const { sessionId } = ctx.auth.sessions.issue(ctx.clock());
    const secure = config.cookieSecure || new URL(c.req.url).protocol === 'https:';
    c.header('Set-Cookie', sessionCookieHeader(sessionId, config, secure));
    return c.json(ok({ auth_enabled: true }));
  });

  // ---- POST /api/auth/logout（K1-C §5.2）----
  // 清 cookie 并作废服务端会话凭证（中间件已先行校验凭据）。
  app.post('/api/auth/logout', (c) => {
    ctx.auth.sessions.revoke(sessionCookieOf(c));
    c.header('Set-Cookie', clearedCookieHeader());
    return c.json(ok({ logged_out: true }));
  });

  // ---- K1-B 节点面 + 节点列表（§4.5；令牌面隔离在 auth 中间件）----
  registerNodeRoutes(app, { dispatcher: ctx.dispatcher, auth: ctx.auth });

  // ---- GET /api/home ----
  app.get('/api/home', (c) => {
    const actor = actorOf(c.req.header('x-xuxing-actor'), ctx.defaultActorId);
    return c.json(ok(homeView(ctx.projection.snapshot(), actor)));
  });

  // ---- GET /api/projects/:projectId ----
  app.get('/api/projects/:projectId', async (c) => {
    const actor = actorOf(c.req.header('x-xuxing-actor'), ctx.defaultActorId);
    const project_id = c.req.param('projectId');
    // K1-B §4.4：Run 视图合成派发行 state_reason（只读映射）。
    const reasons = await ctx.dispatcher.dispatchReasons();
    const view = projectView(ctx.projection.snapshot(), project_id, actor, reasons);
    if (view === null) return c.json(fail('not_found', `项目 ${project_id} 不存在`), 404);
    return c.json(ok(view));
  });

  // ---- GET /api/actions（My Actions 投影）----
  app.get('/api/actions', (c) => {
    const actor = actorOf(c.req.header('x-xuxing-actor'), ctx.defaultActorId);
    return c.json(ok(actionsView(ctx.projection.snapshot(), actor)));
  });

  // ---- POST /api/capture ----
  app.post('/api/capture', async (c) => {
    const body = await readJsonObject(c);
    if (body === null) return c.json(fail('bad_request', '请求体必须是 JSON 对象'), 400);
    const actor = actorOf(c.req.header('x-xuxing-actor'), ctx.defaultActorId);
    try {
      const result = await runCapture(
        {
          store: ctx.store,
          projection: ctx.projection,
          proposer: ctx.proposer,
          clock: ctx.clock,
          defaultProjectId: ctx.defaultProjectId,
        },
        {
          text: body.text,
          project_id: body.project_id,
          client_submit_id: body.client_submit_id,
          actor_id: actor.actor_id,
        },
      );
      const { events, ...view } = result;
      if (!result.replayed) commitAndBroadcast(ctx, events);
      if (result.degraded) {
        ctx.hub.notice(
          { kind: 'proposal_degraded', proposal_id: result.proposal_id, degraded_reason: result.degraded_reason },
          result.project_id,
        );
      }
      return c.json(ok(view), result.replayed ? 200 : 201);
    } catch (error) {
      return errorResponse(error);
    }
  });

  // ---- GET /api/proposals/:proposalId ----
  app.get('/api/proposals/:proposalId', (c) => {
    const proposal_id = c.req.param('proposalId');
    const view = proposalView(ctx.projection.snapshot(), proposal_id);
    if (view === null) return c.json(fail('not_found', `提议 ${proposal_id} 不存在`), 404);
    return c.json(ok(view));
  });

  // ---- POST /api/commands ----
  app.post('/api/commands', async (c) => {
    const body = await readJsonObject(c);
    if (body === null) return c.json(fail('bad_request', '请求体必须是 JSON 对象'), 400);
    const actor = envelopeActorOf(body, c.req.header('x-xuxing-actor'), ctx.defaultActorId, c.req.header('x-xuxing-actor-kind'));
    try {
      const execution = await runCommand(ctx, {
        type: typeof body.type === 'string' ? body.type : '',
        payload: body.payload ?? {},
        client_submit_id: body.client_submit_id,
        actor,
      });
      commitAndBroadcast(ctx, execution.events);
      const result = execution.result;
      return c.json(ok(result), result.replayed ? 200 : 201);
    } catch (error) {
      return errorResponse(error);
    }
  });

  // ---- POST /api/evidence（Q12：Evidence 写入；tool_output 走 Tool Gateway 不经此口）----
  app.post('/api/evidence', async (c) => {
    const body = await readJsonObject(c);
    if (body === null) return c.json(fail('bad_request', '请求体必须是 JSON 对象'), 400);
    const actor = actorOf(c.req.header('x-xuxing-actor'), ctx.defaultActorId, c.req.header('x-xuxing-actor-kind'));
    try {
      const execution = await runEvidenceCommand(ctx, {
        payload: body.payload ?? {},
        client_submit_id: body.client_submit_id,
        actor,
      });
      commitAndBroadcast(ctx, execution.events);
      return c.json(ok(execution.result), execution.result.replayed ? 200 : 201);
    } catch (error) {
      return errorResponse(error);
    }
  });

  // ---- GET /api/stream（SSE：补发 + 对齐 + 背压）----
  //
  // 不用 hono/streaming 的 stream()：它会 new Request(url, request) 重新包一层请求，
  // c.req.raw.signal 不再是客户端连接（断线不可见）。这里直接用 ReadableStream，
  // 断线由 cancel()（客户端断开）与 enqueue 抛错（写端已关）两条路感知，二者都走 closeOnce。
  app.get('/api/stream', async (c) => {
    const query = { cursor: c.req.query('cursor') ?? null, project_id: c.req.query('project_id') ?? null };

    // 建立（预算/参数/订阅/补发/ready）必须在返回 Response 之前完成：
    // 这样 400/503 仍是普通 JSON 响应（带 Retry-After），而不是已经开始的 SSE 流。
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const encoder = new TextEncoder();
    const pending: string[] = [];
    let connection: SseConnection | null = null;
    let closedOnce = false;
    /** 已写出、但调用方还没拉走的帧数（背压窗口）；pull 时由 confirmWrites 归还 */
    let awaitingDrain = 0;
    /** 对端是否已断开（只有 cancel() 能置 true；服务端主动关闭不算） */
    let peerGone = false;
    const closeOnce = (): void => {
      if (closedOnce) return;
      closedOnce = true;
      if (connection !== null) ctx.hub.detach(connection);
      // 建连接阶段（stream 还没交给调用方）出错时，流尚未被消费，直接把流关掉
      if (connection === null && controller !== null) {
        try {
          controller.close();
        } catch {
          // 已关闭/已取消
        }
      }
    };

    const result = await establishSseConnection({
      pool: ctx.pool,
      projection: ctx.projection,
      hub: ctx.hub,
      options: ctx.sse,
      query,
      connectionId: `sse_${ulid()}`,
      writer: {
        // 返回 false = 写端过载：占住背压窗口，等对端消化（drain）再继续，不无限堆内存
        write: (chunk: string) => {
          awaitingDrain += 1;
          if (controller === null) {
            // 建立阶段：流还没被调用方拉取，帧先排队（同样受背压窗口约束）
            pending.push(chunk);
            return awaitingDrain < MAX_OUTSTANDING_WRITES;
          }
          try {
            controller.enqueue(encoder.encode(chunk));
            return awaitingDrain < MAX_OUTSTANDING_WRITES;
          } catch {
            // 流已取消/关闭：写不进去了，直接判对端不可用
            peerGone = true;
            return false;
          }
        },
        isAlive: () => !peerGone,
        close: () => closeOnce(),
      },
    });

    if (!result.ok) {
      if (result.status === 503) c.header('Retry-After', '5');
      const code = result.error.code === 'sse_capacity_exhausted' ? 'unavailable' : 'bad_request';
      return c.json(fail(code, result.error.message, result.error.detail), result.status);
    }

    connection = result.connection;
    // 背压记账回到连接：调用方拉走的那几帧视为已消化，归还对应窗口
    connection.confirmWrites = (count: number) => {
      if (count <= 0) return;
      awaitingDrain = 0;
      for (let i = 0; i < count; i += 1) connection?.approveWrite(true);
    };
    c.header('Content-Type', 'text/event-stream; charset=utf-8');
    c.header('Cache-Control', 'no-cache, no-store');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    // pull() = 调用方要下一块：此刻把"已写出未收回"的帧记为对端已消化。这是请求驱动的真背压：
    // 对端不拉，pull 就不发生，窗口不归还，慢连接判定才会触发（而不是无限排队到内存里）。
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        controller = ctrl;
        for (const chunk of pending.splice(0)) ctrl.enqueue(encoder.encode(chunk));
        if (connection !== null) connection.confirmWrites(awaitingDrain);
      },
      pull() {
        if (connection !== null) connection.confirmWrites(awaitingDrain);
        // 建立阶段积压的帧还没进流 → 催一把，不等到下一拍定时器
        if (connection !== null && pending.length > 0) connection.pumpPending();
      },
      cancel() {
        peerGone = true;
        closeOnce();
      },
    });

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });

  // ---- A 案静态自托管（兜底，必须最后注册；/api 行为不变）----
  if (ctx.webDist) registerStaticHosting(app, ctx.webDist);

  return app;
}
