# K0 Web 车道 C：旅程测试 + SSE 协议级测试

本目录是**自包含**的 Playwright 旅程包：默认拉起本目录内的 mock 服务，跑通
「捕获 → 提议 → 接受（服务端发号）→ 生成任务 → My Actions → 执行反馈 →
逐判据验收 → accepted」的完整链路（含 degraded 分支），并用协议级客户端验证
SSE 的快照对齐、cursor 补发与背压行为。

- 全部文件都在 `tests/journeys/` 内；不改根 `package.json` / `tsconfig.json` /
  `vitest.config.ts`，也不改 `server/`、`web/`、`src/`。
- 是否打真服务只由 `JOURNEY_BASE_URL` 一个开关决定。
- 领域断言只读投影（`/api/home`、`/api/actions`、`/api/projects/:id`、
  `/api/proposals/:id`）；UI 只用于验证「投影被如实渲染 + 点击命令链路」。

本轮按协调者裁决 **R-1 至 R-12** 对齐到真服务契约（实测记录见
「契约映射」与「已知限制」）。

## 一键运行

```bash
cd tests/journeys
npm install
npx playwright install chromium     # 首次需要；版本见「Playwright 与 Chromium 版本对齐」

npm test                            # 默认：打本目录 mock
npm run typecheck                   # 只做类型检查

# 打真服务（不再自动起 mock）
JOURNEY_BASE_URL=http://127.0.0.1:8787 npm test
```

`npm test` 由 `playwright.config.mts` 自动拉起
`node --experimental-strip-types mock/server.mts`，health 通过后开跑，结束时自动关；
`reuseExistingServer: false` 保证每轮从种子状态开始。

手工调试 mock：

```bash
npm run mock                                       # 终端 A，监听 4173
JOURNEY_BASE_URL=http://127.0.0.1:4173 npm test     # 终端 B（不再拉 mock）
```

## Playwright 与 Chromium 版本对齐

本包的 Playwright 版本在 `package.json` 里**精确锁定**（无 `^` / `~`）：

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| `@playwright/test` | `1.63.0` | 锁死；升级必须同步跑两轮实跑（mock + 真服务） |
| Chromium（由 Playwright 管理） | `chromium-1140` | Playwright 1.63.0 对应的 revision，`npx playwright install chromium` 会装到 `~/.cache/ms-playwright/chromium-1140` |

为什么必须对齐：Playwright 的 CDP 交互依赖它自己 `browsers.json` 里登记的那个
revision。`@playwright/test` 与已装浏览器 revision 不匹配时，启动会直接报
`Executable doesn't exist at …/chromium-<rev>/chrome-linux/chrome`，或更隐蔽地
在 `--no-sandbox`、network idle 等新参数上出现行为差异。

对齐步骤（升级时照做）：

1. `npm install`（锁文件决定 Playwright 版本，不要手改）；
2. `npx playwright install chromium`（按当前版本的 `browsers.json` 装对应 revision）；
3. `npx playwright --version` 与 `ls ~/.cache/ms-playwright` 交叉核对 revision；
4. 跑一遍 `npm test` 与一轮真服务实跑。

本机绕行（缓存里只有旧 revision 时，**只用于本地跑通，不写进 CI**）：
本仓库验证环境缓存的是 `chromium-1140`，与 `1.63.0` 一致，因此常规安装即可。
若某台机器上只有系统 Chromium 或别的 revision：

```bash
JOURNEY_CHROMIUM_EXECUTABLE=/home/appen/.cache/ms-playwright/chromium-1140/chrome-linux/chrome \
JOURNEY_NO_SANDBOX=1 npm test
```

`JOURNEY_CHROMIUM_EXECUTABLE` 直接覆盖 `launchOptions.executablePath`，
`JOURNEY_NO_SANDBOX=1` 追加 `--no-sandbox`（容器/root 下必需）。这两个变量只影响
浏览器进程，不影响任何契约断言；缺了它们而 revision 又不匹配时，是**启动失败**，
不会被当作 skip。

## 目录

| 路径 | 作用 |
| --- | --- |
| `journeys.config.mts` | **唯一**地址 / 种子 id / SSE 上限 / 轮询参数；只在这里读 `JOURNEY_*` |
| `contract.mts` | HTTP 契约 DTO 与封闭命令枚举（R-1/R-2/R-8/R-9 的代码映射） |
| `playwright.config.mts` | Playwright 配置、Chromium 启动参数、mock `webServer` |
| `package.json` / `package-lock.json` | 嵌套 npm 包（不污染根依赖） |
| `tsconfig.json` | 嵌套 TS 配置（NodeNext + `.mts`） |
| `specs/10-full-journey.pw.mts` | 完整旅程（8 步，UI + 投影双断言） |
| `specs/20-degraded-journey.pw.mts` | degraded 提议的明示、全链路可走通、notice 帧 |
| `specs/30-sse-protocol.pw.mts` | SSE 三纪律 + 心跳（7 个协议级用例） |
| `specs/40-command-guards.pw.mts` | 幂等（201/200）、越权 409、未知命令/缺幂等键 400 |
| `support/api.mts` | 投影/命令客户端；**唯一**信封解包点 + 轮询断言 |
| `support/sse-client.mts` | 基于 fetch 的 SSE 客户端（支持 paused 慢消费者） |
| `support/testids.mts` | `data-testid` 命名契约与 mock 判据 ref 常量 |
| `mock/server.mts` | HTTP 路由、静态 UI、SSE 接入、mock-only `/api/dev/burst` |
| `mock/state.mts` | append-only 事件日志、种子（R-7）、命令、投影 |
| `mock/sse.mts` | SSE hub：注册→回放→ready→实时、队列、慢消费者、心跳 |
| `mock/errors.mts` | 统一错误 `{ok:false, error:{code,message,detail?}}` |
| `mock/public/*` | 无框架 UI（只渲染投影字段，testid 与 `support/testids.mts` 对齐） |

> spec 后缀用 `*.pw.mts` 而不是 `*.spec.mts`：根 Vitest 的默认 include 会扫描
> `**/*.spec.mts`，改名可确保本目录不会在根 `npm test` 里被误收集。

## 单一地址开关与变量

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `JOURNEY_BASE_URL` | 空 → mock `http://127.0.0.1:4173` | 设置后打外部服务，不再拉 mock |
| `JOURNEY_ACTOR_ID` | `user_demo` | 当前用户（请求头 `x-xuxing-actor`） |
| `JOURNEY_PROJECT_ID` / `JOURNEY_GOAL_ID` | `proj_demo_oq05` / `goal_demo_oq05` | 主旅程项目/目标 |
| `JOURNEY_SEED_CANCELED_TASK_ID` | `task_demo_archived` | 越权测试用的终态任务（R-7①） |
| `JOURNEY_DEGRADED_PROJECT_ID` / `_GOAL_ID` / `_PROPOSAL_ID` | `proj-degraded` / `goal-degraded-1` / `prop-degraded-1` | 降级旅程（R-7②） |
| `JOURNEY_SSE_MAX_CONNECTIONS` / `_MAX_QUEUE` / `_SLOW_TIMEOUT_MS` / `_PUMP_MS` | `4` / `64` / `1000` / `30` | **只影响 mock** |
| `JOURNEY_MOCK_PORT` / `JOURNEY_MOCK_DEV` | `4173` / 空 | mock 端口；`JOURNEY_MOCK_DEV=0` 关掉 `/api/dev/burst` |
| `JOURNEY_CHROMIUM_EXECUTABLE` / `JOURNEY_NO_SANDBOX` | 空 | 见上一节 |

真服务轮**不需要**覆盖任何种子变量：默认值就是服务端种子契约。SSE 上限一律从
`GET /api/health` 的 `data.limits` 读（真服务：`heartbeat_ms=15000`、
`max_connections=32`、`max_queue=256`），测试不假设 mock 的默认值。

## 种子契约（R-7）

与 `server/README.md`「种子契约」同源；mock 用同一组 ID 播种，故两种跑法断言一致。

| 项目 | 目标 | 内容 |
| --- | --- | --- |
| `proj_demo_oq05` | `goal_demo_oq05` | 5 条任务：`task_demo_contact`（active）、`task_demo_quote`（ready）、`task_demo_contract`（defined）、`task_demo_kickoff`（accepted）、`task_demo_archived`（canceled，`available_actions=[]`）；验收状态 `accepted=1`、`total=5` |
| `proj-degraded` | `goal-degraded-1` | 一条已落账的降级提议 `prop-degraded-1`（`proposer.degraded=true`、`degraded_reason=not_configured`），任务要等接受后才发号 |

初始 `/api/actions` **不为空**（contact / quote / contract 三条），项目图也不为空；
"从空开始"的旅程现场走 `POST /api/capture`。**提议不预告 `task_id`**（R-11）：
`task_id` 只在 `proposal_accept` 之后由服务端发出（响应 `data.subject.task_id`）。

## 契约映射（按实测真服务写）

| 方法与路径 | 成功响应 | 要点 |
| --- | --- | --- |
| `GET /api/health` | `{ok:true,data:{ok,db,projection_version,limits:{heartbeat_ms,max_connections,max_queue}}}` | R-2：health 也走信封；`data.ok` 才是运行时状态 |
| `GET /api/home` | `data.{actor_id,projects,my_actions_count,recent_activity,proposals:{pending,degraded}}` | 活动 `kind` 为 PascalCase；`proposals.degraded` 只数**待决**的降级提议 |
| `GET /api/actions` | `data.items[]` | `next_action` 是**中文标签**，`available_actions` 才是 canonical 命令串 |
| `GET /api/projects/:id` | `data.{project,goal,tasks,acceptance_status,graph,pending_proposals}` | R-8 键集；`graph.nodes` 只有 `{id,title,lifecycle}`；`goal.status` 为 `active` |
| `GET /api/proposals/:id` | `data.{…,details:{kind,task:{title,description,assignee_kind,acceptance_criteria}},available_actions}` | R-11：`task_id` 在提议阶段为 `null` |
| `POST /api/capture` | `201 {ok:true,data.{capture_id,proposal_id,replayed:false,…}}` | 只产提议；`emitted` = `PlanChangeProposed` + `FeedbackReceived` |
| `POST /api/commands` | 首次 `201` + `data.replayed:false`；重放 `200` + `data.replayed:true` | `data.{command_type,client_submit_id,replayed,emitted,subject,receipt_event_id}` |
| 失败 | `{ok:false,error:{code,message,detail?}}` | 码表：`bad_request`/`not_found`/`conflict`/`unavailable` |
| `GET /api/stream?cursor=<seq>` | `text/event-stream` | 帧：`event: event`（data 含 `seq` 与 PascalCase `kind`）、`event: ready`、`event: notice`（如 `proposal_degraded`，不占 seq）、`id: <seq>` + `: ping <seq>` 心跳 |
| `POST /api/dev/burst` | **mock-only** `202 {ok:true,data:{emitted,projection_version}}` | 造流用；真服务没有该端点 |

命令词表（R-1，封闭）：`proposal_accept` / `proposal_reject` / `task_advance` /
`feedback_submit` / `acceptance_record` / `task_cancel`。
越权（动作不在 `available_actions`）、幂等键冲突、提议已决 → `409 conflict`
（`error.detail.reason` 给出 `not_in_available_actions` / `idempotency_key_conflict` /
`proposal_not_proposed`）；未知 `type`、缺 `client_submit_id` → `400 bad_request`。

## 旅程口径（R 编号）

- **R-1** `available_actions` 是 canonical `command_type` 字符串数组。
- **R-2** 全部响应统一信封，客户端只从 `data` 读（`support/api.mts` 是唯一解包点）。
- **R-4** 背压只看可观测行为：连接数超限 → `503 unavailable` + `Retry-After: 5`，
  断线后名额归还；慢消费者 → 服务端断开。
- **R-6** 命令首次 `201`/重放 `200`，以 `data.replayed` 区分，不再看 `duplicate`。
- **R-7** 种子如上；`task_demo_archived` 是越权用例的终态任务。
- **R-8** 项目视图键集如上；任务行、图节点、验收摘要都从 `data` 读。
- **R-9** 事件 `kind` = 内核 PascalCase；降级提议必须由 `notice` 帧明示。
- **R-10** 验收动作挂在任务自己的 `available_actions` 里（`awaiting_acceptance`
  时含 `acceptance_record`），任务在验收落账前一直留在 My Actions。
- **R-11** 提议不预告 `task_id`，接受时才发号。
- **R-12** 种子先于服务端启动（投影单例）。

验收部分通过（`partially_accepted`）时内核矩阵把任务**退回 `active`**（不是停在
`awaiting_acceptance`）。因此旅程第 5 步断言 `partially_accepted` + `lifecycle=active`，
第 6 步再走 `feedback_submit`（active → awaiting_acceptance）后重新验收全通过；
不再重推 `defined→ready→active`（那会重复派发 Run）。
`acceptance_status.rejected` 只数 `verdict='rejected'`，`partially_accepted` 不计入，
逐判据明细从 `acceptance_status.criterion_summary` 读。

## SSE 三纪律如何测

1. **快照-订阅对齐**
   - `1a`：先用快照水位作 cursor 建订阅，再注入 capture，然后取快照；
     断言收到的 seq 恰为 `cursor+1 … snapshot.projection_version`，连续、无重复，
     且含 `PlanChangeProposed` / `FeedbackReceived`（`proposal_id` 对得上）。
   - `1b`：先取快照，再以 `projection_version` 订阅；静置后无旧事件补发，
     之后只收新事件。
2. **cursor 补发**：断线后连续 capture 3 次，用断线前 cursor 重连，
   断言补发序列恰为 `cursor+1 … finalHead`、无重复、`ready.replayed` 与区间长度一致；
   追平后重连不收到任何 update。
3. **背压（R-4）**
   - 连接数：打开 `health.limits.max_connections` 条后，下一条得
     `503` + `Retry-After` + `error.code='unavailable'`；关闭后名额归还。
   - 慢消费者（mock 轮）：`paused` 客户端不读 body，`POST /api/dev/burst`
     写入 `health.limits.max_queue` 条，服务端在阈值内断开该连接。
   - 心跳：新连接在 `heartbeat_ms`（+5s 容差）内收到含 `ping` 的注释帧。

**背压如何可测**：mock 的发送泵每 `JOURNEY_SSE_PUMP_MS`（默认 30ms）取一帧，
`64 × 30ms ≈ 1.9s` 明显长于 1s 阈值，慢消费者窗口稳定；真服务由 socket
backpressure/drain 驱动，测试口径不变（慢连接必须被断开）。

## 真服务轮的裁剪（不是放宽断言）

`USING_EXTERNAL_SERVICE=true` 时：

- **全部 UI 步骤跳过**：8787 只提供 API/SSE，没有本目录 mock UI 的 testid 契约。
  同一批领域状态在两步里都有**投影断言**，UI 只是额外的一层渲染核对。
- **`/api/dev/burst` 相关用例跳过**（规范 30 的「慢消费者」用例）：该端点不在定版
  契约内，真服务没有；连接数上限（3a）与心跳两条照跑。
- **mock 扩展字段不读**：`health.data.streams.active`、`health.data.mock` 只在 mock
  轮存在，读取时按可选处理。

## 已知限制与契约缺口

1. **真服务未暴露的字段**：`/api/projects/:id` 的任务行没有 `degraded` /
   `degraded_reason`，降级信息只经提议投影与 `notice` 帧表达；`duplicate_suspect`、
   `beyond_wait` 等 spec 可选字段真服务未输出。旅程不据此断言。
2. **`/api/actions` 的 `next_action` 是中文标签**，不是命令串；判定可用动作一律看
   `available_actions`。
3. **`acceptance_status.rejected` 不含 `partially_accepted`**（见「旅程口径」）。
4. **`/api/dev/burst` 不存在于真服务**，慢消费者用例真服务轮跳过（见上）。
5. **health 无 `streams`** 字段，连接数只能通过「第 N+1 条被 503」间接观测。
6. mock 是旅程用参考实现：不实现 Run/Assignment/Policy 全量判定、多 actor 分离、
   任务图边；验收允许执行者本人提交（真服务以 `self_acceptance` 诚实记录）。
7. 心跳用例要真等约 15s，是整套里最慢的一条。

## 实测

```text
# mock 轮（默认）
Running 13 tests using 1 worker
  ✓ 10-full-journey      ✓ 20-degraded-journey
  ✓ 30-sse-protocol      1a / 1b / cursor 补发 / 连接数 503 / 慢消费者 / 心跳
  ✓ 40-command-guards    幂等 201→200 / 冲突 409 / 越权 409 / 未知 400 / 缺键 400 / 回执形状
  13 passed

# 真服务轮（JOURNEY_BASE_URL=http://127.0.0.1:8787）
  见交卷记录：11 passed + 1 skipped（/api/dev/burst 慢消费者）
```
