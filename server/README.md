# server/ — Web 车道 A（Hono 服务端）

与内核同进程：直接 `import` 仓库根 `src/kernel` 的事件存储与迁移矩阵校验器，零接口翻译。
本目录只做"命令层 + 投影 + HTTP/SSE 传输"，不重写任何内核判定。

## 结构

| 路径 | 一句话 |
|---|---|
| `src/main.ts` | 进程入口：读环境变量 → 连 PG → migrate → 起 Hono（node-server） |
| `src/app.ts` | 组装 Hono 应用（注入 `pool` / 时钟 / 提议器 / SSE 配置） |
| `src/api/http.ts` | 响应信封 `{ok,data}` / `{ok,error}`，投影响应必带 `projection_version`（health 同样走信封） |
| `src/api/routes.ts` | §4 全部端点 |
| `src/projection/` | 事件投影（Home / MyActions / Project / 提议），可由 `replay(0)` 全量重演 |
| `src/commands/` | 统一命令入口：available_actions 复核 + client_submit_id 幂等（OQ-07） |
| `src/sse/` | SSE 三纪律：快照-订阅对齐 / cursor 补发 / 背压与心跳 |
| `src/proposers/` | 提议层：magpie 网关（OpenAI 兼容）+ 确定性降级（degraded） |
| `src/seed/` | 演示项目种子脚本（OQ-05 口径 + R-7 夹具，契约见下节） |

## 响应形态要点（FIX-ROUND-1 定版）

- **信封**：全部端点（含 `/api/health`）统一 `{ok:true,data}` / `{ok:false,error}`；health 的 `data` = `{ok, db, projection_version, limits}`。
- **`available_actions`**：canonical `command_type` **字符串数组**，词表 `proposal_accept / proposal_reject / task_advance / feedback_submit / acceptance_record / task_cancel`（不再发 `{id, command_type}` 对象）。
- **My Actions=待我处理**：`ready` / `defined` / `captured` / 本人 `active`（`human_light` Run 在跑）以及 **`awaiting_acceptance`**（验收动作 `acceptance_record` 就在这条上）都会留在 `/api/actions`；`accepted` / `canceled` 不在。

## 命令

```bash
npm --prefix server install      # 装 server 自己的依赖（hono）
npm run server:typecheck         # server 车道类型检查
npm run server:test              # server 车道测试（真 PG16，docker 口径同内核）
XUXING_PG_URL=postgres://postgres:postgres@127.0.0.1:55432/xuxing npm run seed:demo
npm run server                   # 起服务（默认 127.0.0.1:8787）
```

环境变量（全部只在服务端，绝不进浏览器/仓库/日志）：

| 变量 | 用途 |
|---|---|
| `XUXING_PG_URL` | 运行时 PG 连接串（缺省 `postgres://postgres:postgres@127.0.0.1:55432/xuxing`） |
| `XUXING_PORT` / `XUXING_HOST` | 监听端口 / 地址（缺省 8787 / 127.0.0.1） |
| `MAGPIE_BASE_URL` | magpie 网关 OpenAI 兼容口（缺省 `http://10.144.144.3:3425/v1`） |
| `MAGPIE_API_KEY` | 网关 key，仅由运行环境注入；**代码不读取、不打印、不落日志** |
| `XUXING_PROPOSER_MODEL` | 模型，缺省免费模型 `workbuddy-ai/deepseek-v4.1-flash` |
| `XUXING_SSE_MAX_CONNECTIONS` / `XUXING_SSE_QUEUE_LIMIT` / `XUXING_SSE_SLOW_TIMEOUT_MS` / `XUXING_SSE_HEARTBEAT_MS` | SSE 背压参数（缺省 32 / 256 / 15000 / 15000）；`GET /api/health` 的 `data.limits` 直接反映这四个值（单点来源，无第二份常量） |
| `XUXING_WEB_DIST` | A 案静态自托管的 web/dist 目录；未设时按缺省相对定位自动探测（源码/构建两种布局 + cwd），探不到则纯 API 形态；显式指定但目录无 `index.html` 时启动直接报错 |

## 部署形态（A 案：服务端静态自托管）

服务端可直接托管 web 构建产物（`web/dist`），部署形态回归 **app 容器自包含**：
静态资源与 SPA 回退由服务端出，/api 与 SSE 行为不变（`/api/*` 永远优先，
未知 /api 路径仍是 JSON 404，绝不回退 index.html；带扩展名的缺失资产大声
404，不拿 index.html 冒充）。

- 启用条件：`resolveWebDist()` 解析到含 `index.html` 的目录（`XUXING_WEB_DIST`
  显式指定，或缺省相对定位命中仓库 `web/dist`）。
- 启动日志的 `web_dist` 字段即最终口径：路径 = 已托管；`null` = 纯 API 形态。
- SPA 回退只对无扩展名路径生效（BrowserRouter 直达/刷新）；`/assets/`
  内容哈希资产长缓存 immutable，index.html 与回退响应 no-store。

从 B 案（Caddy 托管静态 + 仅反代 /api）切换到 A 案的步骤（只写文档，执行归部署轨）：

1. 构建镜像时把 `web/dist` 一并打进 app 镜像（与 server 同一发布单元），
   容器内 `XUXING_WEB_DIST` 指向镜像内 dist 路径（或放仓库相对位置走缺省定位）。
2. 先在预发/本地按 `server/test/static-hosting.test.ts` 与 journeys spec60
   口径验：子路径直达 200、刷新不 404、资产 200、/api 与 SSE 不变。
3. 部署新镜像，公网先直验 app 端口（或经临时域名）：`GET /` 与
   `GET /projects/<id>` 均回 index.html、`/api/health` 信封正常、SSE ready 帧到达。
4. 改 Caddy：该站点从「静态 root + /api 反代」改为**整站反代**到 app
   （`reverse_proxy 127.0.0.1:8787`，保留 SSE 所需 `flush_interval -1`），
   reload 后跑公网 e2e 全轮。
5. 回滚：还原 Caddyfile 备份并 reload 即回到 B 案（app 的静态托管闲置无害，
   B 案下 Caddy 不把非 /api 流量转给 app）。

## 种子契约（FIX-ROUND-1 R-7 成文）

`npm run seed:demo` 写入的是**事件**（不直写投影表），全部带固定幂等键 `seed:<project_id>:…`，可重复执行
（重复执行不新增事件、水位不动）。种子必须先于服务端启动执行（投影单例，R-12）。ID 一律固定，前端/旅程测试按 ID 对齐。

### 1. 演示项目 `proj_demo_oq05`

| 项 | 值 |
|---|---|
| 项目 | `proj_demo_oq05` ·「续行演示 · 客户方案落地」· `policy_id=policy_demo` · 创建者 `user_demo` |
| 目标 | `goal_demo_oq05`：把「张三方案确认 → 报价 → 合同」这条客户落地链路跑通并完成验收 |
| actor | `user_demo`（K0 单用户；请求头 `x-xuxing-actor` 缺省即此值） |

任务清单（4 条跨生命周期 canonical 任务 + 1 条已取消夹具）：

| task_id | 生命周期 | Run / 反馈 | My Actions |
|---|---|---|---|
| `task_demo_contact` 联系张三确认方案 | `active` | `human_light` Run 运行中 | 在；`available_actions=["feedback_submit"]` |
| `task_demo_quote` 整理报价单 | `ready` | — | 在；`["task_advance","task_cancel"]` |
| `task_demo_contract` 起草合同附件 | `defined` | — | 在；`["task_advance","task_cancel"]` |
| `task_demo_kickoff` 确认客户启动会时间 | `accepted` | Run succeeded + 验收 `accepted` | 不在 |
| `task_demo_archived` 复核旧版报价模板 | `canceled` | Run 已取消（INV-11 收尾） | 不在 |

验收状态：`accepted=1`、`total=5`（第 5 条即下面第①件夹具）。`task_demo_archived` 是 **R-7① 已取消任务夹具**：
`TaskCancelRequested → RunCanceled → TaskLifecycleChanged(→canceled) → TaskCanceled`，`available_actions=[]`。

### 2. 夹具②：降级场景 `proj-degraded`

| 项 | 值 |
|---|---|
| 项目 | `proj-degraded` ·「续行演示 · 降级场景」 |
| 目标 | `goal-degraded-1` |
| 提议 | `prop-degraded-1`（`kind=capture_task`、`status=proposed`、`proposer.degraded=true`、`degraded_reason=not_configured`） |
| 可达性 | **断开 magpie（不设 `MAGPIE_API_KEY`）时照样可达**：它只是一条已落账的 `PlanChangeProposed`，服务端只读投影，不回源模型 |
| 界面口径 | `/api/proposals/prop-degraded-1` 与 `/api/projects/proj-degraded` 均带 `degraded:true`；`/api/home` 的 `proposals.degraded` 计入它 |

### 与前端/旅程测试的约定

- 初始 `/api/actions` **不为空**（上表 3 条），初始项目图也**不为空**；"从空开始"的旅程请现场走 `POST /api/capture` 建。
- 提议**不预告 `task_id`**（`proposal_view.task_id=null`）：任务只在 `proposal_accept` 后由服务端发号（R-11）。
