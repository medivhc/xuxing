// K1-B §4.5：节点面端点装配（节点令牌面，auth 中间件已隔离）。
// 路由保持薄层：解析信封 → dispatcher → ok/fail 信封；NodeApiError 统一映射。
import type { Hono } from 'hono';
import { fail, ok, type ErrorCode } from './http.js';
import { NodeApiError, type NodeDispatcher } from '../nodes/dispatcher.js';
import type { AuthService } from '../auth/auth.js';

interface NodeRoutesContext {
  dispatcher: NodeDispatcher;
  auth: AuthService;
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    /* fallthrough */
  }
  return {};
}

function errorResponse(c: any, error: unknown) {
  if (error instanceof NodeApiError) {
    // 与命令层同口径：HTTP 粗分类 code + detail.reason 细原因。
    const code: ErrorCode =
      error.status === 400 ? 'bad_request' : error.status === 404 ? 'not_found' : error.status === 409 ? 'conflict' : 'internal';
    const detail: Record<string, unknown> = { ...error.detail };
    if (detail.reason === undefined) detail.reason = error.reason;
    return c.json(fail(code, error.message, detail), error.status as never);
  }
  throw error;
}

export function registerNodeRoutes(app: Hono, ctx: NodeRoutesContext): void {
  const d = ctx.dispatcher;

  app.post('/api/nodes/register', async (c) => {
    try {
      const body = await readJson(c);
      const result = await d.registerNode({
        node_id: typeof body.node_id === 'string' ? body.node_id : undefined,
        display_name: body.display_name as string,
        executor_kinds: body.executor_kinds as string[],
        max_side_effect_level: body.max_side_effect_level as string,
        agent_version: typeof body.agent_version === 'string' ? body.agent_version : undefined,
      });
      return c.json(ok(result));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post('/api/nodes/:id/heartbeat', async (c) => {
    try {
      return c.json(ok(await d.heartbeatNode(c.req.param('id'))));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post('/api/nodes/:id/deregister', async (c) => {
    try {
      return c.json(ok(await d.deregisterNode(c.req.param('id'))));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get('/api/nodes/:id/dispatch-poll', async (c) => {
    try {
      const wait = Number(c.req.query('wait') ?? '0');
      return c.json(ok(await d.poll(c.req.param('id'), Number.isFinite(wait) ? wait : 0)));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  const runAction = (fn: (nodeId: string, runId: string, body: Record<string, unknown>) => Promise<unknown>) => async (c: any) => {
    try {
      const body = await readJson(c);
      return c.json(ok(await fn(c.req.param('id'), c.req.param('runId'), body)));
    } catch (error) {
      return errorResponse(c, error);
    }
  };

  app.post('/api/nodes/:id/runs/:runId/ack', runAction(async (nodeId, runId) => d.ack(nodeId, runId)));
  app.post('/api/nodes/:id/runs/:runId/nack', runAction(async (nodeId, runId) => d.nack(nodeId, runId)));
  app.post('/api/nodes/:id/runs/:runId/started', runAction(async (nodeId, runId) => d.started(nodeId, runId)));
  app.post('/api/nodes/:id/runs/:runId/heartbeat', runAction(async (nodeId, runId) => d.runHeartbeat(nodeId, runId)));
  app.post(
    '/api/nodes/:id/runs/:runId/raw-result',
    runAction(async (nodeId, runId, body) =>
      d.rawResult(nodeId, runId, {
        client_result_id: body.client_result_id as string,
        outcome_hint: typeof body.outcome_hint === 'string' ? body.outcome_hint : undefined,
        raw_result_ref: typeof body.raw_result_ref === 'string' ? body.raw_result_ref : undefined,
        summary: body.summary as string,
      }),
    ),
  );
  app.post('/api/nodes/:id/runs/:runId/cancel-confirmed', runAction(async (nodeId, runId) => d.cancelConfirmed(nodeId, runId)));
  app.post(
    '/api/nodes/:id/runs/:runId/side-effect-note',
    runAction(async (nodeId, runId, body) =>
      d.sideEffectNote(nodeId, runId, {
        tool_name: body.tool_name as string,
        note: body.note as string,
        client_note_id: body.client_note_id as string,
      }),
    ),
  );
  app.post(
    '/api/nodes/:id/runs/:runId/probe-result',
    runAction(async (nodeId, runId, body) =>
      d.probeResult(nodeId, runId, {
        idempotency_key: body.idempotency_key as string,
        result: body.result as string,
        summary: typeof body.summary === 'string' ? body.summary : undefined,
        raw_result_ref: typeof body.raw_result_ref === 'string' ? body.raw_result_ref : undefined,
      }),
    ),
  );

  // 用户面：节点列表（用户令牌/会话，中间件按面放行）。
  app.get('/api/nodes', async (c) => c.json(ok({ nodes: await d.listNodesView() })));
}
