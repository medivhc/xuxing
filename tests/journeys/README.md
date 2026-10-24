# K0 Web 车道 C：旅程测试 + SSE 协议级测试

本目录是**自包含**的 Playwright 旅程测试包：默认拉起本目录内的 mock 服务，
跑通「捕获 → 提议 → 接受 → 生成任务 → My Actions → 完成 → 逐判据验收 →
项目/目标更新」的完整链路，并用协议级客户端验证 SSE 的快照对齐、cursor 补发
与背压行为。

- 全部文件都在 `tests/journeys/` 内，不改根 `package.json` / `tsconfig.json` /
  Vitest 配置，也不改 `src/`。
- 是否打真服务只由 `JOURNEY_BASE_URL` 一个开关决定。
- 领域状态断言只读投影接口（`/api/home`、`/api/projects/:id`、`/api/actions`、
  `/api/proposals/:id`）；UI 只用于验证「投影字段被如实渲染 + 点击命令链路」。

## 一键运行

```bash
cd tests/journeys
npm install

# 有 Playwright 管理版 Chromium 时：
npm test

# 沙箱/CI 只有系统 Chromium 时（本次验证即如此）：
JOURNEY_CHROMIUM_EXECUTABLE=/usr/bin/chromium JOURNEY_NO_SANDBOX=1 npm test

# 只做类型检查
npm run typecheck
```

`npm test` 会按 `playwright.config.mts` 自动拉起
`node --experimental-strip-types mock/server.mts`，健康检查通过后开始跑；
结束时自动关掉，`reuseExistingServer: false` 保证每轮从种子状态开始。

需要手工调试 mock 时：

```bash
npm run mock                                  # 终端 A，监听 4173
JOURNEY_BASE_URL=http://127.0.0.1:4173 npm test   # 终端 B（不再自动起 mock）
```

## 目录

| 路径 | 作用 |
| --- | --- |
| `journeys.config.mts` | **唯一**地址/种子 id/SSE 上限/轮询参数配置；只在这里读 `JOURNEY_*` |
| `contract.mts` | HTTP 契约 DTO 与封闭命令枚举；mock 与测试共用 |
| `playwright.config.mts` | Playwright 配置、Chromium 启动参数、mock `webServer` |
| `package.json` / `package-lock.json` | 嵌套 npm 包（不污染根依赖） |
| `tsconfig.json` | 嵌套 TS 配置（NodeNext + `.mts`） |
| `specs/10-full-journey.pw.mts` | 完整旅程（8 步，UI + 投影双断言） |
| `specs/20-degraded-journey.pw.mts` | degraded 提议的明示与全链路可走通 |
| `specs/30-sse-protocol.pw.mts` | SSE 三纪律 + 心跳（7 个协议级用例） |
| `specs/40-command-guards.pw.mts` | 幂等、越权 409、未知命令/缺幂等键 400 |
| `support/api.mts` | 投影/命令 HTTP 客户端、轮询断言、health 等待 |
| `support/sse-client.mts` | 基于 fetch 的 SSE 解析客户端（支持 paused 慢消费者） |
| `support/testids.mts` | `data-testid` 命名契约与判据 id 常量 |
| `mock/server.mts` | HTTP 路由、静态 UI、SSE 接入、mock-only `/api/dev/burst` |
| `mock/state.mts` | append-only 事件日志、种子、命令处理、投影计算 |
| `mock/sse.mts` | SSE 连接 hub：注册→回放→实时、队列、慢消费者、心跳 |
| `mock/errors.mts` | 统一 `{error:{code,message,available_actions?}}` |
| `mock/public/*` | 无框架 UI（只渲染投影字段，testid 与 `support/testids.mts` 对齐） |

> spec 后缀用 `*.pw.mts` 而不是 `*.spec.mts`：根仓库 Vitest 的默认 include
> 会扫描 `**/*.spec.mts`，改名可确保本目录不会在根 `npm test` 里被误收集。
> 文件仍用 `.mts`，避免落进根 `tsconfig.json` 的 `tests/**/*.ts`。

## 单一地址开关

`journeys.config.mts` 是唯一地址来源：

- `JOURNEY_BASE_URL`（例如 `https://xuxing.example.com`）：设置后
  `USING_EXTERNAL_SERVICE=true`，Playwright **不启动** mock，所有 HTTP/SSE
  请求打该地址。
- 不设置：默认 `http://127.0.0.1:${JOURNEY_MOCK_PORT ?? 4173}`，自动拉起 mock。

集成真服务时还需要用 `JOURNEY_*` 对齐种子与 actor（均有默认值）：

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `JOURNEY_ACTOR_ID` | `actor-human-1` | 当前用户 |
| `JOURNEY_PROJECT_ID` / `JOURNEY_GOAL_ID` | `proj-demo` / `goal-demo` | 主旅程项目/目标 |
| `JOURNEY_SEED_CANCELED_TASK_ID` | `task-demo-legacy` | 越权测试用的终态任务 |
| `JOURNEY_DEGRADED_PROJECT_ID` / `_PROPOSAL_ID` / `_TASK_ID` | `proj-degraded` / `prop-degraded-1` / `task-degraded-1` | 降级旅程 |
| `JOURNEY_SSE_MAX_CONNECTIONS` | `4` | 每服务 SSE 连接数上限 |
| `JOURNEY_SSE_MAX_QUEUE` | `64` | 每连接待发队列上限 |
| `JOURNEY_SSE_SLOW_TIMEOUT_MS` | `1000` | 慢消费者断开阈值 |
| `JOURNEY_SSE_PUMP_MS` | `30` | mock 发送泵节拍（见「背压如何可测」） |
| `JOURNEY_CHROMIUM_EXECUTABLE` | 空 | 指定系统 Chromium 可执行文件 |
| `JOURNEY_NO_SANDBOX` | 空 | `1` 时给 Chromium 加 `--no-sandbox` |

测试从 `GET /api/health` 读取服务端实际生效的 `limits`，因此真服务不必与
mock 的默认上限相同，只要行为符合上报值。

## 种子与隔离

mock 启动时同步写入 10 条事件（`head=10`），不依赖时钟或随机数：

- `proj-demo`：项目 + 目标 + 一条已取消的 agent 任务 `task-demo-legacy`
  （`available_actions=[]`，用于 409 越权测试）。任务图从空开始，主旅程
  捕获后才生成第一条活动任务。
- `proj-degraded`：项目 + 目标 + 已取消历史任务 + `FeedbackReceived` +
  一条 **degraded** 提议 `prop-degraded-1`（含两条 `degraded_reasons`），
  提议里已含 `task-degraded-1`，但任务要等用户接受后才落库。

主旅程只用 `proj-demo`，降级旅程只用 `proj-degraded`；SSE 用例只做
capture（产生提议，不产生任务）；守卫用例只拒绝提议或对终态任务发命令。
因此各 spec 互不污染，换顺序也能跑；每轮 `npm test` 都是全新进程、全新种子。

## 契约映射

| 方法与路径 | 行为 |
| --- | --- |
| `GET /api/health` | `{ok:true, service, mock, limits, streams:{active}}`（mock 扩展字段） |
| `GET /api/home` | 项目摘要 + `pending_actions_count` + 最近 12 条活动（排除 `DevBurstRecorded`） |
| `GET /api/projects/:projectId` | 目标、任务图、逐判据验收状态、`provenance`、`pending_criteria` |
| `GET /api/actions` | 当前 actor 的 My Actions，行内带 `available_actions` 与 `pending_criteria` |
| `POST /api/capture` | `{text}` → `{capture_id, proposal_id, projection_version}`；追加 `FeedbackReceived` + `PlanChangeProposed` |
| `GET /api/proposals/:proposalId` | 提议投影（含 `degraded` / `degraded_reasons` / 拟生成任务 / 可用动作） |
| `POST /api/commands` | `{type,payload,client_submit_id}`；允许 `accept_proposal` / `reject_proposal` / `complete_task` / `record_acceptance` |
| `GET /api/stream?cursor=<seq>` | 先补发 `seq > cursor`，转实时；update 帧 data 含 `seq`、`kind`；15s 心跳注释 |
| `POST /api/dev/burst` | **mock-only**，同步追加 N 条 `DevBurstRecorded` 造流，用于背压测试 |

所有投影响应都带 `projection_version`（已并入的最大全局 seq）。命令成功返回
202 + receipt；`client_submit_id` 重复且内容一致时返回首次回执并标
`duplicate:true`，内容不一致返回 409 `idempotency_conflict`；`available_actions`
不含目标动作（或任务已终态）返回 409，并回显服务端动作集。

## SSE 三纪律如何测

1. **快照-订阅对齐**
   - `1a`：先 `open(/api/stream?cursor=snapshot_version)` 建立订阅，再注入
     capture，然后才取 home 快照；断言 stream 收到的 seq 恰为
     `cursor+1 … snapshot.projection_version`，连续、无重复，且包含该
     `capture_id` 的 `feedback.captured`。
   - `1b`：先取快照，再以 `snapshot.projection_version` 为 cursor 订阅；
     静置 400ms 断言没有旧事件补发，之后的新事件恰好是 `cursor+1/2`。
2. **cursor 补发**
   - 建立并断开连接后，连续 capture 3 次（每次恰好两条事件）；用断线前
     cursor 重连，断言补发序列等于 `cursor+1 … finalHead` 的完整区间、
     无重复，且 3 个 `capture_id` 全部出现；追平后再次重连不收到任何帧。
3. **背压**
   - 连接数：打开 `health.limits.max_connections` 条流后，下一条返回
     429 `too_many_connections`，且不占名额。
   - 队列上限：`paused` 客户端不读 body，`POST /api/dev/burst`
     写入 `max_pending_per_connection + 32` 条；同步入队使队列越界，服务端
     发 `event: backpressure` `{code:'slow_consumer', reason:'queue_overflow'}`
     后断开。
   - 慢消费者：paused 后恰好写入 `max_pending_per_connection` 条（不触发
     溢出），发送泵逐帧排空期间队首等待超过 `slow_consumer_timeout_ms`，
     服务端发 `reason:'slow_consumer_timeout'` 并断开。
   - 心跳：新连接在 15s（+5s 容差）内收到 `: heartbeat ...` 注释帧。

**背压如何可测**：mock 的发送泵每 `JOURNEY_SSE_PUMP_MS`（默认 30ms）才从
每连接队列取一帧。`64 × 30ms ≈ 1.9s` 明显长于 1s 超时阈值，因此慢消费者
用例有稳定触发窗口；burst 是一次同步入队，因此队列溢出在 burst 返回前就
已发生。真服务应由 socket backpressure/drain 驱动，测试口径不变（慢连接
必须被断开，且原因以协议帧可见）。

## 基线说明与改动

- 已取得基线 `qoder/journey-tests`（tip `e4fa2f4`），并以其 worktree 工作。
- **该分支上没有 `tests/journeys/` 目录**；实际存在的是
  `tests/e2e/journeys.spec.ts`（全部 `test.skip`）与 kernel 级
  `tests/journey/*`。本目录**没有改写** `tests/e2e`，而是沿用了骨架里的
  testid 命名与旅程语义（`capture-input`、`my-actions-row`、
  `task-lifecycle`、`criterion-pass-*`、`acceptance-submit` 等），在
  `tests/journeys/` 下从零实现。
- 未修改 `tests/journeys/` 以外的任何文件（根 `package.json`、`tsconfig.json`、
  `vitest.config.ts`、`src/` 均未动）。
- 用嵌套 `package.json` + `.mts` + `*.pw.mts`，让根 `tsc`/Vitest 不会误收集；
  这是对「只能写 tests/journeys/」约束的取舍，已在目录表中说明。

## 已知限制与契约冲突

1. **`FeedbackCaptured` vs `FeedbackReceived`**：任务指令要求 capture 落
   `FeedbackCaptured`，但内核封闭事件目录（`src/kernel/events.ts`）只有
   `FeedbackReceived`。mock 的 domain `type` 用 `FeedbackReceived`，SSE
   `kind` 用契约语义 `feedback.captured`；未改契约、未改内核。集成真服务时
   以真服务的投影为准，测试只断言 `kind` 与投影字段。
2. mock 是**旅程用参考实现**，不实现 Run/Assignment/Policy、多 actor 分离、
   任务图边、策略校验等内核能力；`record_acceptance` 允许完成任务的同一
   actor 提交。真服务集成应替换 mock，但保持同一 HTTP/SSE 契约。
3. `/api/dev/burst` 与 `/api/health` 的 `limits/streams` 是 mock 扩展；
   外部真服务集成时，队列溢出/慢消费者用例会跳过，其余用例按 health 上报
   的 limits 运行。心跳契约固定 15s。
4. 背压用固定发送泵节拍模拟，便于确定性复现；不是对真实 socket 缓冲的
   精确仿真。
5. UI 是 mock 自带的静态页面；对真服务做 Web 旅程时，需要真服务在
   `JOURNEY_BASE_URL` 提供同样的 testid 契约，否则 UI 断言需要按真服务
   前端适配（协议级 SSE 与投影 API 测试不受影响）。
6. 心跳用例需要真实等待约 15s，是整套测试里最慢的一条。

## 实测

```text
Running 13 tests using 1 worker
  ✓ 10-full-journey …… (1.6s)
  ✓ 20-degraded-journey …… (1.1s)
  ✓ 30-sse-protocol：1a / 1b / cursor 补发 / 连接数 / 队列溢出 / 慢消费者 / 心跳
  ✓ 40-command-guards：幂等 / 越权 409 / 未知命令 400 / 缺幂等键 400
  13 passed (22.1s)
```
