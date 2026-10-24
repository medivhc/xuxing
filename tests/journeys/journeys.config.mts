// 旅程测试的**唯一**地址/种子/上限配置。
//
// 只在这里读取 JOURNEY_* 环境变量：Playwright 配置、SSE 客户端、mock 服务、
// 各个 spec 都从本文件取，集成时把 JOURNEY_BASE_URL 指向真服务即可一键切换。
// 不允许在别处再写死 127.0.0.1 / 端口 / 项目 id。

const env = process.env;

const mockPort = Number(env.JOURNEY_MOCK_PORT ?? '4173');

/**
 * 被测服务基址。
 * - 未设 JOURNEY_BASE_URL：默认指向本目录 mock（Playwright webServer 会自动拉起）。
 * - 设了 JOURNEY_BASE_URL：不再启动 mock，直接打外部服务（车道 A/B 真服务集成）。
 */
export const JOURNEY_BASE_URL = (
  env.JOURNEY_BASE_URL ?? `http://127.0.0.1:${mockPort}`
).replace(/\/+$/, '');

/** true = 打外部真服务；false = 打本地 mock。 */
export const USING_EXTERNAL_SERVICE = typeof env.JOURNEY_BASE_URL === 'string' && env.JOURNEY_BASE_URL.length > 0;

/** mock 监听端口（仅本地 mock 使用）。 */
export const MOCK_PORT = mockPort;

/** 当前用户：旅程里所有 available_actions / My Actions 都以这个 actor 计算。 */
export const CURRENT_ACTOR_ID = env.JOURNEY_ACTOR_ID ?? 'actor-human-1';

/** 主旅程的演示项目（mock 启动时种子化；真服务集成时用 env 指向已种子的项目）。 */
export const DEMO = {
  projectId: env.JOURNEY_PROJECT_ID ?? 'proj-demo',
  goalId: env.JOURNEY_GOAL_ID ?? 'goal-demo',
  /** 种子里的历史任务：已取消，任何 actor 都无可用动作（用于 409 越权测试）。 */
  canceledTaskId: env.JOURNEY_SEED_CANCELED_TASK_ID ?? 'task-demo-legacy',
} as const;

/** 降级旅程的演示项目：种子中已有一条 degraded 提议。 */
export const DEGRADED = {
  projectId: env.JOURNEY_DEGRADED_PROJECT_ID ?? 'proj-degraded',
  proposalId: env.JOURNEY_DEGRADED_PROPOSAL_ID ?? 'prop-degraded-1',
  taskId: env.JOURNEY_DEGRADED_TASK_ID ?? 'task-degraded-1',
} as const;

/**
 * SSE 背压上限（mock 的默认值，也可被 env 覆盖用于集成）。
 * 契约义务：连接数上限、每连接待发队列上限、慢消费者超时断开。
 * 测试从 GET /api/health 读服务端实际生效值；接口没给时回落到这里。
 */
export const SSE_LIMITS = {
  maxConnections: Number(env.JOURNEY_SSE_MAX_CONNECTIONS ?? '4'),
  maxPendingPerConnection: Number(env.JOURNEY_SSE_MAX_QUEUE ?? '64'),
  slowConsumerTimeoutMs: Number(env.JOURNEY_SSE_SLOW_TIMEOUT_MS ?? '1000'),
  /**
   * mock 的发送泵节拍：每 N ms 从待发队列取一帧。见 README「背压如何可测」。
   * 默认 30ms：64 帧队列约 1.9s 才能排空，明显长于 1s 的慢消费者阈值，
   * 让 slow_consumer_timeout 的触发窗口稳定可测（真服务由 socket drain 驱动）。
   */
  pumpIntervalMs: Number(env.JOURNEY_SSE_PUMP_MS ?? '30'),
} as const;

/** 契约固定心跳 15s（不提供压低覆盖：这是协议义务，不是测试调参项）。 */
export const SSE_HEARTBEAT_MS = 15_000;

/** 轮询投影接口的默认节奏/上限。 */
export const POLL_INTERVAL_MS = 100;
export const POLL_TIMEOUT_MS = 8_000;
