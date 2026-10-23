# server/ — Web 车道 A（Hono 服务端）

与内核同进程：直接 `import` 仓库根 `src/kernel` 的事件存储与迁移矩阵校验器，零接口翻译。
本目录只做"命令层 + 投影 + HTTP/SSE 传输"，不重写任何内核判定。

## 结构

| 路径 | 一句话 |
|---|---|
| `src/main.ts` | 进程入口：读环境变量 → 连 PG → migrate → 起 Hono（node-server） |
| `src/app.ts` | 组装 Hono 应用（注入 `pool` / 时钟 / 提议器 / SSE 配置） |
| `src/api/http.ts` | 响应信封 `{ok,data}` / `{ok,error}`，投影响应必带 `projection_version` |
| `src/api/routes.ts` | §4 全部端点 |
| `src/projection/` | 事件投影（Home / MyActions / Project / 提议），可由 `replay(0)` 全量重演 |
| `src/commands/` | 统一命令入口：available_actions 复核 + client_submit_id 幂等（OQ-07） |
| `src/sse/` | SSE 三纪律：快照-订阅对齐 / cursor 补发 / 背压与心跳 |
| `src/proposers/` | 提议层：magpie 网关（OpenAI 兼容）+ 确定性降级（degraded） |
| `src/seed/` | 演示项目种子脚本（OQ-05 口径） |

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
| `XUXING_SSE_MAX_CONNECTIONS` / `XUXING_SSE_QUEUE_LIMIT` / `XUXING_SSE_SLOW_TIMEOUT_MS` / `XUXING_SSE_HEARTBEAT_MS` | SSE 背压参数（缺省 32 / 256 / 15000 / 15000） |
