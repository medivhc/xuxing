// 旅程测试的**唯一**地址/种子/上限配置。
//
// 只在这里读取 JOURNEY_* 环境变量：Playwright 配置、SSE 客户端、mock 服务、
// 各个 spec 都从本文件取，集成时把 JOURNEY_BASE_URL 指向真服务即可一键切换。
// 不允许在别处再写死 127.0.0.1 / 端口 / 项目 id。
//
// 默认值 = 服务端种子契约（FIX-ROUND-1 R-7，见 server/README.md「种子契约」）：
// mock 用同一组 ID 播种，因此「默认打 mock」与「JOURNEY_BASE_URL 指向真服务」
// 两种跑法断言一致，不需要为真服务额外覆盖任何种子变量。

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
export const CURRENT_ACTOR_ID = env.JOURNEY_ACTOR_ID ?? 'user_demo';

/**
 * 主旅程的演示项目（R-7 种子契约）。
 * 种子初始即有 5 条任务，其中 3 条在 My Actions（contact/quote/contract）；
 * 「从空开始」的旅程现场走 POST /api/capture 建任务。
 */
export const DEMO = {
  projectId: env.JOURNEY_PROJECT_ID ?? 'proj_demo_oq05',
  goalId: env.JOURNEY_GOAL_ID ?? 'goal_demo_oq05',
  /** R-7① 已取消夹具：available_actions=[]，用于 409 越权测试。 */
  canceledTaskId: env.JOURNEY_SEED_CANCELED_TASK_ID ?? 'task_demo_archived',
} as const;

/**
 * 降级旅程的演示项目（R-7② 夹具）：种子里已有一条 degraded=true 的待决提议。
 * 提议带的是 draft（标题 + 判据），**不预告 task_id**（R-11）——
 * 任务 id 只能在接受提议后从响应/投影里取，所以这里没有 taskId 配置项。
 */
export const DEGRADED = {
  projectId: env.JOURNEY_DEGRADED_PROJECT_ID ?? 'proj-degraded',
  goalId: env.JOURNEY_DEGRADED_GOAL_ID ?? 'goal-degraded-1',
  proposalId: env.JOURNEY_DEGRADED_PROPOSAL_ID ?? 'prop-degraded-1',
} as const;

/**
 * SSE 背压参数。
 *
 * 断言口径（R-4）：一律以 GET /api/health 的 `data.limits` 上报值为准——
 * 真服务是 heartbeat_ms=15000 / max_connections=32 / max_queue=256，mock 由
 * 下面的 EV 变量控制（默认取更小的值，让背压用例在本地几秒内跑完）。
 * 这些值只是 mock 的默认值，绝不用于假设真服务的上限。
 */
export const SSE_LIMITS = {
  /** mock 连接数上限（真服务读 health.limits.max_connections） */
  maxConnections: Number(env.JOURNEY_SSE_MAX_CONNECTIONS ?? '4'),
  /** mock 每连接待发队列上限（真服务读 health.limits.max_queue） */
  maxPendingPerConnection: Number(env.JOURNEY_SSE_MAX_QUEUE ?? '64'),
  /** mock 慢消费者断开阈值（真服务不暴露该值，断言只要求「最终被断开」） */
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
