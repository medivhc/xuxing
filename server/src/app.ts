// 应用装配：把 PG 事件存储、投影服务、提议层、SSE hub 与 HTTP 路由组装成一个 Hono 应用。
// 与内核同进程：store 就是 src/kernel 的 PgEventStore；本项目不重写任何内核判定。

import { Pool } from 'pg';
import { createPgEventStore, type PgEventStore } from '../../src/kernel/event-store-pg.ts';
import { createProjectionService, type ProjectionService } from './projection/service.ts';
import { createProposer, proposerConfigFromEnv, type Proposer, type ProposerConfig } from './proposers/proposer.ts';
import { createHub, type Hub } from './sse/hub.ts';
import { sseOptionsFromEnv, type SseOptions } from './sse/protocol.ts';
import { createApp, type AppContext } from './api/routes.ts';
import { resolveWebDist } from './api/static.ts';

export interface AppConfig {
  pool: Pool;
  store: PgEventStore;
  projection: ProjectionService;
  proposer: Proposer;
  hub: Hub;
  sse: SseOptions;
  clock: () => Date;
  defaultProjectId: string;
  defaultActorId: string;
  /** A 案静态自托管的 web/dist 目录（resolveWebDist 的结果）；null = 纯 API 形态。 */
  webDist: string | null;
}

export interface BuildOptions {
  /** 已迁移的 pool（调用方负责 migrate）。 */
  pool: Pool;
  store?: PgEventStore;
  proposer?: Proposer;
  proposerConfig?: ProposerConfig;
  sse?: SseOptions;
  clock?: () => Date;
  defaultProjectId?: string;
  defaultActorId?: string;
  /** 启动时是否全量重演投影（默认 true）。 */
  rebuild?: boolean;
  /**
   * A 案静态自托管：undefined = 按环境解析（XUXING_WEB_DIST / 缺省相对定位）；
   * 显式 null = 强制纯 API 形态；字符串 = 指定 dist 目录。
   */
  webDist?: string | null;
}

/** 默认演示项目 id（种子脚本写入；与 seed/demo.ts 同源常量）。 */
export const DEFAULT_PROJECT_ID = 'proj_demo_oq05';
export const DEFAULT_ACTOR_ID = 'user_demo';

export async function buildApp(options: BuildOptions): Promise<{ app: ReturnType<typeof createApp>; config: AppConfig }> {
  const clock = options.clock ?? (() => new Date());
  const store = options.store ?? createPgEventStore(options.pool, { clock });
  const projection = createProjectionService(options.pool, store);
  const proposer = options.proposer ?? createProposer(options.proposerConfig ?? proposerConfigFromEnv());
  const sse = options.sse ?? sseOptionsFromEnv();
  const hub = createHub(sse);

  // 投影变化 → SSE 广播（写入路径在命令层 ingest 之后手动广播；这里兜住种子脚本等旁路写入）
  const config: AppConfig = {
    pool: options.pool,
    store,
    projection,
    proposer,
    hub,
    sse,
    clock,
    defaultProjectId: options.defaultProjectId ?? DEFAULT_PROJECT_ID,
    defaultActorId: options.defaultActorId ?? DEFAULT_ACTOR_ID,
    webDist: options.webDist === undefined ? resolveWebDist() : options.webDist,
  };

  if (options.rebuild !== false) await projection.rebuild();
  const app = createApp(config);
  return { app, config };
}

export type { AppContext };
