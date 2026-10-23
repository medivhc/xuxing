# 车道 A（server）交卷

> 任务书：`TASK-WEB-SERVER.md`。本文件只记录**做了什么、验证到哪一步、还差什么**；契约冲突见第 6 节。

## 1. 分支与 HEAD

| 项 | 值 |
|---|---|
| 分支 | `web/server` |
| HEAD | `ff8d9b9` docs(server): 交卷文档补上最终 HEAD |
| 基线 | `github/develop/eventstore-batch1`（`362972d`） |
| 提交 | `be1786d` 脚手架 → `e25d031` 投影 → `bfac952` 提议层 → `033912d` 路由/命令层/种子 → `974524a` 全命令 → `6c0982c` 事件广播与 SSE 背压 → `ad689c8` 运行时编译 → `dbedf55` 交卷文档 → `ff8d9b9` 补 HEAD |

未推 `develop` / `master`，未使用 `--no-verify`。

## 2. §4 端点

全部在 `server/src/api/routes.ts`；响应统一 `{ ok: true, data }` / `{ ok: false, error }`，投影类响应都带 `projection_version`（= 已并入的最大 `global_seq`，与 SSE `cursor` 同量纲）。

| 端点 | 行为 |
|---|---|
| `GET /api/health` | 进程 + DB 连通性 + `projection_version` |
| `GET /api/home` | 项目列表、任务计数、最近活动、`my_actions_count` |
| `GET /api/projects/:projectId` | 项目目标 + 任务 + Run；不存在 → 404 |
| `GET /api/actions` | My Actions：任务 + `available_actions`（由内核 `guardTransition` / `guardWaitStateChange` 推出，REQ-PJ-1） |
| `POST /api/capture` | 提议层出猜测 → `PlanChangeProposed`（`kind=capture_task`）+ `FeedbackReceived`；`client_submit_id` 幂等（重放 200）；响应带 `degraded` / `emitted[]` |
| `GET /api/proposals/:proposalId` | 提议视图（含 `degraded`、`proposer`、`assumptions`、`status`） |
| `POST /api/commands` | accept/reject 提议、逐判据验收、推进/完成、提交反馈、取消任务；写前复核 `available_actions` → 409；`client_submit_id` 幂等去重（D11 / OQ-07） |
| `GET /api/stream?cursor=` | SSE：`ready` → 补发 → 实时；`project_id` 可过滤；心跳 15s（`id: <seq>` + `: ping <seq>`） |

命令 `type` 取值：`proposal_accept` / `proposal_reject` / `task_advance` / `feedback_submit` / `acceptance_record` / `task_cancel`。

### SSE 三纪律的落地方式

1. **快照-订阅对齐**：预算检查 → `hub.attachBuffered`（先订阅、写帧先进缓冲）→ 取 `snapshotVersion` → 按 cursor 补发 → `unbuffer()` → 发 `ready{projection_version, cursor, replayed}`。订阅与快照之间不存在无主窗口。
2. **游标补发**：`cursor` 必须是 `global_seq`（非负整数），非法 → 400（不静默从 0 重放）；补发按全局序号跨项目进行，`project_id` 只做过滤；`seq <= lastSeq` 一律丢弃（重连不重复）。
3. **背压**：连接数上限（超限 → 503 + `Retry-After: 5`）；每连接队列上限 → 立即断连；慢连接超时（队列积压**或**背压窗口耗尽超过 `slowTimeoutMs`）→ 断连；心跳 15s 保活；断线归还预算、停掉全部定时器。

## 3. 测试与验证证据

| 命令 | 结果 |
|---|---|
| `npm run server:test` | 7 个文件、**54 passed**（api-read 9 / api-commands 9 / proposer 8 / projection 8 / sse 10 / sse-http 8 / bootstrap 2） |
| `npm run server:typecheck` | 通过 |
| `npm test`（全仓） | 10 个文件 passed、1 skipped；**267 passed**，5 todo（`tests/g1-contact-followup.test.ts` 为既有 skip） |
| `npm run typecheck` / `npm run build` | 通过（未改动 `src/`） |
| `node tools/docs-check.mjs` | 本分支 **1 项失败：[b] HEAD 领先 `based_on fd0e3479` 共 14 个提交（上限 10）**。这是分叉漂移，不是本次引入：分支基点是 `362972d`（其 `docs/STATUS.md` 为 `based_on: 63b3e8e`，通过），上游之后把 `based_on` 回退到 `fd0e3479` 并新增 4 个提交。本分支未改 `docs/`；请协调者在合并时刷新 `docs/STATUS.md` 的 `based_on`（本车道不碰 `docs/`）。 |

SSE 证据分两层：`server/test/sse.test.ts`（10 条，含慢连接两条路径：队列积压、写端 `write() === false` 的背压窗口耗尽）与 `server/test/sse-http.test.ts`（8 条，真 HTTP 中转 + fetch 读流，覆盖三纪律、503 + Retry-After、断线归还预算）。

### 真实进程冒烟（非演示库 `xuxing_smoke`，PG16 容器 `127.0.0.1:55432`）

- `npm run seed:demo` → `{"event":"seeded","tasks":4,"projection_version":34}`
- `npm run server` → `/api/health` `db:true`；`/api/home`、`/api/projects/*`、`/api/actions` 正常；未知项目 404
- `POST /api/capture`：**真实 magpie 调用成功**（`source:"model"`，`latency_ms` 约 1.6s，返回 3 条判据的任务草稿）
- `POST /api/commands` 接受提议 → 201，6 条事件；同 `client_submit_id` 重放 → 200 `replayed:true`；同 id 不同内容 → 409 `idempotency_key_conflict`；重复接受 → 409 `proposal_not_proposed`
- `GET /api/stream`：实时收到后续事件；`?cursor=42` 补发 43/44 两条后 `ready.replayed=2`；心跳 `: ping`
- **降级链路**：去掉 `MAGPIE_API_KEY` 起服务 → `configured:false`，捕获返回 `degraded:true, degraded_reason:"not_configured"`、`proposer.source:"fallback"`、固定占位草稿；`GET /api/proposals/*` 同样带 `degraded:true`；SSE 推 `proposal_degraded` 通知帧
- 服务日志中无 key / Bearer / `api_key` 字样（`grep` 为空）

## 4. 根 `package.json` 的追加（append-only，已在 `be1786d` 声明）

```json
"server":          "npm --prefix server start",
"server:test":     "vitest run --config server/vitest.config.ts",
"server:typecheck": "npm --prefix server run typecheck",
"seed:demo":       "npm --prefix server run seed"
```

只新增了这 4 条，未改动既有脚本。

## 5. 待办 / 已知限界

1. **运行时是"先编译再跑"**：Node 24.4.1 的 `--experimental-strip-types`（含 `--experimental-transform-types`）只剥类型、不把 `./x.js` 改写成 `./x.ts`，而内核源码 import 写的是 `.js`，直接跑 `.ts` 会 `ERR_MODULE_NOT_FOUND`。`server/package.json` 的 `start` / `seed` 改成先 `tsc -p tsconfig.build.json` 再跑 `dist/`，产物在 `server/dist/`（已 gitignore）。
2. **内核没有增量尾部读**（batch 2 的限界）：写入后按 `store.replay(watermark)` 过滤 `global_seq > current` 并入投影；`replay(from)` 是 `>=`，必须显式过滤，否则边界事件重复应用。
3. **单进程投影**：`XuxingProjection` 存在进程内存里，启动全量重演。多实例部署需要把投影换成读模型表（CQRS 持久化），当前形状不支持多进程写入。
4. **K0 无 actor 注册表**：`human_light` 派发跳过能力声明校验；同一个人执行又验收时以 `self_acceptance: true` 诚实记录（REQ-ACC-2 的单用户限界），不做假分离。
5. **`GET /api/stream` 的 `project_id` 过滤与 cursor 语义**：过滤掉的事件不推帧，但 `lastSeq` 仍按其 `global_seq` 前进（客户端续传用的是全局序号，不是该项目的条数）。
6. 未实现：多项目写入端点、鉴权/多用户（K2）、SSE 的 `Last-Event-ID` 头回退（目前只认 `?cursor=`，心跳帧已带 `id:` 供浏览器自动重连使用）。

## 6. 契约与内核的冲突（按任务书要求：不改契约、不绕内核，在此登记）

1. **`FeedbackCaptured` 不存在**：契约写的是 `FeedbackCaptured`，内核封闭事件目录只有 `FeedbackReceived`。服务端一律发 `FeedbackReceived`（原文先入账，REQ-FB-1），未新增事件类型。
2. **提议没有独立实体**：契约的 `/api/capture` 说"触发提议流程"，但内核目录里没有 Proposal 表/事件。提议复用 `PlanChangeProposed`（`kind ∈ {capture_task, human_light_run, wait_condition}`），`proposal_id` = `payload.change_id`；捕获不直接建 Task，Task 只在用户接受提议后生成（守住"事件是唯一真相源"）。
3. **`PlanChangeApplied` 复用为命令回执**：命令幂等需要一条可查的回执事件，目录里没有对应类型。做法：`PlanChangeApplied` + `payload.command_receipt = 'command_receipt'`，投影跳过这类事件，不会污染计划视图。
4. **命令类型是推断出来的**：本分支上没有 `docs/interaction-contract.md` 的 D10/D11 正文（在上游 `qoder/interaction-contract`），命令集合按任务书 §4 的动词 + 内核 `available_actions` 反推。合并时请对照 D10/D11 校正命令名与字段名。
5. **契约的 409 细节与内核 guard 的差异**：`available_actions` 一律以内核 guard 为准（HTTP 与命令层共用同一个函数）；若契约列举的动作集与 guard 结果不一致，以 guard 为准并在响应 `detail` 里给出可判定依据（`reason` / `lifecycle` / `available_actions`）。

## 7. 目录速览

```
server/src/main.ts            进程入口（迁移 → 重演 → 起 Hono；日志不含 key）
server/src/app.ts             装配（store / projection / proposer / hub / routes）
server/src/api/routes.ts      §4 端点 + SSE 路由 + 写后广播
server/src/api/views.ts       投影 → 响应视图
server/src/commands/          命令层（available_actions 复核、幂等回执、INV-11 收尾）与捕获编排
server/src/projection/        事件投影、available_actions、ProjectionService
server/src/proposers/         magpie 网关（OpenAI 兼容）+ 确定性降级
server/src/sse/               协议/预算、Hub 与连接（缓冲、背压、心跳）、建立流程
server/src/seed/              演示项目种子 + CLI
server/test/                  7 个套件（真 PG16，不 mock、不 skip）
```
