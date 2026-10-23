import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import type { Pool } from 'pg';
import { ulid } from 'ulid';
import { fail, ok } from './http.ts';
import { actionsView, homeView, projectView, proposalView } from './views.ts';
import type { ProjectionService } from '../projection/service.ts';
import type { Proposer } from '../proposers/proposer.ts';
import type { PgEventStore } from '../../../src/kernel/event-store-pg.ts';
import type { EventEnvelope } from '../../../src/kernel/events.ts';
import type { Hub } from '../sse/hub.ts';
import {
  CommandDeniedError,
  CommandValidationError,
  IdempotencyConflictError,
  runCommand,
  type CommandActor,
} from '../commands/commands.ts';
import { CaptureValidationError, runCapture } from '../commands/capture.ts';
import type { SseOptions } from '../sse/protocol.ts';
import { establishSseConnection } from '../sse/connection.ts';

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
}

/** 当前用户（K0 单用户；多用户/权限属 K2，不在这里发明）。 */
function actorOf(header: string | undefined, fallback: string): CommandActor {
  const value = header?.trim();
  return { actor_id: value && value.length > 0 ? value : fallback, actor_kind: 'human' };
}

function errorResponse(error: unknown): Response {
  if (error instanceof CommandDeniedError) {
    return Response.json(fail('conflict', error.message, error.detail), { status: 409 });
  }
  if (error instanceof IdempotencyConflictError) {
    return Response.json(
      fail('conflict', error.message, { reason: 'idempotency_key_conflict', retryable: false }),
      { status: 409 },
    );
  }
  if (error instanceof CommandValidationError || error instanceof CaptureValidationError) {
    return Response.json(fail('bad_request', error.message, error.detail), { status: 400 });
  }
  const message = error instanceof Error ? error.message : String(error);
  return Response.json(fail('internal', message), { status: 500 });
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

  // ---- GET /api/health ----
  app.get('/api/health', async (c) => {
    let db = false;
    try {
      await ctx.pool.query('select 1');
      db = true;
    } catch {
      db = false;
    }
    return c.json({ ok: true, db, projection_version: ctx.projection.version() });
  });

  // ---- GET /api/home ----
  app.get('/api/home', (c) => {
    const actor = actorOf(c.req.header('x-xuxing-actor'), ctx.defaultActorId);
    return c.json(ok(homeView(ctx.projection.snapshot(), actor)));
  });

  // ---- GET /api/projects/:projectId ----
  app.get('/api/projects/:projectId', (c) => {
    const actor = actorOf(c.req.header('x-xuxing-actor'), ctx.defaultActorId);
    const project_id = c.req.param('projectId');
    const view = projectView(ctx.projection.snapshot(), project_id, actor);
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
      if (result.degraded) {
        ctx.hub.notice(
          { kind: 'proposal_degraded', proposal_id: result.proposal_id, degraded_reason: result.degraded_reason },
          result.project_id,
        );
      }
      return c.json(ok(result), result.replayed ? 200 : 201);
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
    const actor = actorOf(c.req.header('x-xuxing-actor'), ctx.defaultActorId);
    try {
      const before = ctx.projection.version();
      const result = await runCommand(ctx, {
        type: typeof body.type === 'string' ? body.type : '',
        payload: body.payload ?? {},
        client_submit_id: body.client_submit_id,
        actor,
      });
      if (!result.replayed) {
        const committed = await committedSince(ctx, before);
        ctx.projection.ingest(committed);
        ctx.hub.broadcast(committed);
      }
      return c.json(ok(result), result.replayed ? 200 : 201);
    } catch (error) {
      return errorResponse(error);
    }
  });

  // ---- GET /api/stream（SSE：补发 + 对齐 + 背压）----
  app.get('/api/stream', (c) => {
    const query = { cursor: c.req.query('cursor') ?? null, project_id: c.req.query('project_id') ?? null };
    return stream(c, async (s) => {
      c.header('Content-Type', 'text/event-stream; charset=utf-8');
      c.header('Cache-Control', 'no-cache, no-store');
      c.header('Connection', 'keep-alive');
      c.header('X-Accel-Buffering', 'no');

      const abort = new AbortController();
      c.req.raw.signal.addEventListener('abort', () => abort.abort(), { once: true });
      let established = false;

      const result = await establishSseConnection({
        pool: ctx.pool,
        projection: ctx.projection,
        hub: ctx.hub,
        options: ctx.sse,
        query,
        connectionId: `sse_${ulid()}`,
        writer: {
          write: (chunk: string) => {
            void s.write(chunk).catch(() => abort.abort());
          },
          isAlive: () => !abort.signal.aborted,
          close: () => {
            if (established) void s.close();
          },
        },
      });

      if (!result.ok) {
        if (result.status === 503) c.header('Retry-After', '5');
        await s.write(JSON.stringify({ ok: false, error: result.error }));
        await s.close();
        return;
      }

      established = true;
      await new Promise<void>((resolve) => {
        const finish = (): void => resolve();
        abort.signal.addEventListener('abort', finish, { once: true });
        // 背压断开（慢连接/队列溢出/对端关闭）时 hub 会 close 连接，这里同步收尾
        const timer = setInterval(() => {
          if (result.connection.isClosed) {
            clearInterval(timer);
            finish();
          }
        }, 50);
      });
      ctx.hub.detach(result.connection);
    });
  });

  return app;
}

async function committedSince(ctx: AppContext, after: number): Promise<EventEnvelope[]> {
  const events = await ctx.store.replay(after + 1);
  return events.filter((event) => event.global_seq > after);
}
