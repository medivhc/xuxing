// 应用装配：把 PG 事件存储、投影服务、提议层、SSE hub 与 HTTP 路由组装成一个 Hono 应用。
// 与内核同进程：store 就是 src/kernel 的 PgEventStore；本项目不重写任何内核判定。

import { Pool } from 'pg';
import { createPgEventStore, type PgEventStore } from '../../src/kernel/event-store-pg.ts';
import { createProjectionService, type ProjectionService } from './projection/service.ts';
import { createProposer, proposerConfigFromEnv, type Proposer, type ProposerConfig } from './proposers/proposer.ts';
import { createHub, type Hub } from './sse/hub.ts';
import { sseOptionsFromEnv, type SseOptions } from './sse/protocol.ts';
import { createApp, type AppContext } from './api/routes.ts';
import {
  authConfigFromEnv,
  createAuthService,
  validateAuthConfig,
  type AuthConfig,
  type AuthService,
} from './auth/auth.ts';
import { createDecisionWakeService, type DecisionWakeService } from './decisions/wake.ts';
import {
  NodeDispatcher,
  dispatcherConfigFromEnv,
  type DispatcherConfig,
} from './nodes/dispatcher.ts';
import { NodeStore, migrateNodeTables } from './nodes/store.ts';

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
  /** K1-C 访问控制服务（双令牌 + 会话）。 */
  auth: AuthService;
  /** K1-A deferred 唤起/过期扫描服务（main 负责 start，测试直接 tick）。 */
  decisionWake: DecisionWakeService;
  /** K1-B 节点注册/派发运维表存取。 */
  nodeStore: NodeStore;
  /** K1-B 执行节点派发服务（main 负责 start，测试直接 tick/调用）。 */
  dispatcher: NodeDispatcher;
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
  /** K1-C：访问控制配置（缺省从 env 读；校验失败抛错拒启，fail-closed）。 */
  auth?: AuthConfig;
  /** K1-B：派发服务配置覆盖（缺省从 env 读）。 */
  dispatcherConfig?: Partial<DispatcherConfig>;
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

  // K1-C：访问控制装配。validateAuthConfig 硬错误直接抛（fail-closed 拒启）；
  // WARN 只打布尔态与变量名，绝不打令牌原文。
  const authConfig = options.auth ?? authConfigFromEnv();
  const authWarnings = validateAuthConfig(authConfig);
  for (const warning of authWarnings) {
    console.warn(JSON.stringify({ event: 'auth_warning', message: warning }));
  }
  const auth = createAuthService(authConfig);
  console.log(
    JSON.stringify({
      event: 'auth_configured',
      user_auth_enabled: auth.userAuthEnabled,
      node_auth_enabled: auth.nodeAuthEnabled,
      production: authConfig.production,
    }),
  );

  const decisionWake = createDecisionWakeService({ store, projection, clock });

  // K1-B：节点/派发运维表（幂等建表）+ 派发服务装配。
  await migrateNodeTables(options.pool);
  const nodeStore = new NodeStore(options.pool);
  const dispatcher = new NodeDispatcher(store, projection, proposer, nodeStore, {
    ...dispatcherConfigFromEnv(),
    ...(options.dispatcherConfig ?? {}),
  });

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
    auth,
    decisionWake,
    nodeStore,
    dispatcher,
  };

  if (options.rebuild !== false) await projection.rebuild();
  const app = createApp(config);
  return { app, config };
}

export type { AppContext };
