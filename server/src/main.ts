// 进程入口：读环境 → 连 PG → 迁移（幂等）→ 重演投影 → 起 Hono（@hono/node-server）。
// 日志里只打印监听地址、模型名与降级状态；绝不打印网关 key（key 只进请求头）。

import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { migrate } from '../../src/kernel/event-store-pg.ts';
import { buildApp, DEFAULT_ACTOR_ID, DEFAULT_PROJECT_ID } from './app.ts';
import { proposerConfigFromEnv } from './proposers/proposer.ts';
import { DEFAULT_PG_URL } from './seed/demo.ts';

const connectionString = process.env.XUXING_PG_URL ?? DEFAULT_PG_URL;
const port = Number(process.env.XUXING_PORT ?? '8787');
const hostname = process.env.XUXING_HOST ?? '127.0.0.1';
const proposerConfig = proposerConfigFromEnv();

const pool = new Pool({ connectionString, max: 8 });
await migrate(pool);

const { app, config } = await buildApp({ pool, defaultProjectId: DEFAULT_PROJECT_ID, defaultActorId: DEFAULT_ACTOR_ID });

// K1-A：deferred 唤起/过期扫描（缺省 5s；XUXING_DECISION_WAKE_MS=0 关闭）。
const wakeMs = Number(process.env.XUXING_DECISION_WAKE_MS ?? '5000');
if (Number.isFinite(wakeMs) && wakeMs > 0) config.decisionWake.start(wakeMs);

// K1-B：派发维护 tick（租约过期/离线收敛/state_reason；缺省 2s，=0 关闭）。
const dispatchMs = Number(process.env.XUXING_DISPATCH_MS ?? '2000');
if (Number.isFinite(dispatchMs) && dispatchMs > 0) config.dispatcher.start(dispatchMs);

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(
    JSON.stringify({
      event: 'listening',
      url: `http://${info.address}:${info.port}`,
      projection_version: config.projection.version(),
      proposer: {
        model: proposerConfig.model,
        configured: proposerConfig.apiKey !== null,
        base_url: proposerConfig.baseUrl,
      },
      sse: config.sse,
    }),
  );
});

async function shutdown(signal: string): Promise<void> {
  console.log(JSON.stringify({ event: 'shutdown', signal }));
  config.decisionWake.stop();
  config.dispatcher.stop();
  config.hub.closeAll();
  server.close();
  await pool.end().catch(() => undefined);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
