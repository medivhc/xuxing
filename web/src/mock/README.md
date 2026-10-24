# web/src/mock — 开发用内存 mock

任务书要求：`web/` 内提供可开关的 mock（拦截层等价 MSW），`VITE_API_MOCK=1` 启用；
API 客户端与 mock 严格分离。本目录即该 mock 的完整实现——**手写 fetch 拦截层**（未引入
MSW：MSW 的 Service Worker 会接管 SSE 长连接，无法按 35s 看护/断线重连语义精确模拟
`/api/stream`，且 e2e 下多一层注册时序不可控）。

## 开关

| 方式 | 效果 |
| --- | --- |
| `VITE_API_MOCK=1`（`.env` / `.env.local` / 命令行前缀） | 安装 mock fetch，所有 `/api/*` 由内存 mock 应答 |
| 未设置 / `0` | 不安装，客户端直连真实服务端（同源相对路径） |

辅助变量（见 `.env.example`）：

- `VITE_MOCK_HEARTBEAT_MS`：mock SSE 心跳间隔，默认 `15000`（与契约一致）。
- `VITE_MOCK_WATCHDOG_MS`：SSE 看护阈值，默认 `35000`；e2e 验证断线重连时调小（如 `3000`）。

```bash
VITE_API_MOCK=1 npm run dev        # 带 mock 的开发服务器
VITE_API_MOCK=1 npm run build      # mock 编入 bundle（仅开发联调用，勿上生产）
```

## 安装时序（SSE 纪律 1）

`main.tsx` 中顺序固定为：`installMockFetch()` → `createAppRuntime()` →
`sse.start()` → `createRoot().render()`。mock 必须装在订阅之前，否则 `/api/stream`
绕过拦截打到真实服务端。

## 边界（任务书红线）

- `api/` 下任何模块**不得** import `mock/`；mock 只在最外层替换 `globalThis.fetch`，
  客户端（`api/client.ts`）看到的仍是真实 HTTP 语义：状态码、统一信封
  （成功 `{ok:true, data}` / 失败 `{ok:false, error:{code,message,request_id,detail}}`，FIX-ROUND-1 R-2）、
  202 + receipt、SSE 帧格式。
- mock 不修改内核事件目录：广播的事件 `kind` 全部来自内核封闭集（`src/kernel/events.ts`）。
- 非 `/api/*` 请求（Vite HMR、静态资源）交还原 fetch。

## 控制面 `window.__xuxMock`

仅 `VITE_API_MOCK=1` 时存在，供 e2e 与手动验证：

| 方法 | 用途 |
| --- | --- |
| `reset()` | 清空事件日志与领域状态，回到种子数据 |
| `forceNextProposalDegraded(v?)` | 下一次 capture 强制降级提议（验证「降级提议」明示） |
| `stopHeartbeats()` / `startHeartbeats()` | 停/齐心跳（验证 35s 看护断线重连） |
| `emit(kind, payload?)` | 注入控制面事件（如 `ProjectionRebuilt`），不改变领域状态 |
| `setLagState(state \| null)` | 覆盖 `lag_state`（同步徽标：`fresh`/`lagging`/`stale`） |
| `setLatency({read?, command?, capture?})` | 调整模拟时延（ms），放大可观察 pending 态 |
| `snapshot()` | 读内部计数（seq/events/tasks/proposals/decisions/heartbeats/lag_state） |

浏览器 Console 示例：

```js
__xuxMock.forceNextProposalDegraded();   // 下次 capture 出降级提议
__xuxMock.stopHeartbeats();              // 40s 后连接徽标应转为「重连中」
__xuxMock.setLagState('lagging');        // 同步徽标显示 lagging
__xuxMock.snapshot();                    // { seq: 15, events: 14, ... }
```

## Actor 模型（REQ-ACC-2 执行/验收分离）

| actor | 角色 |
| --- | --- |
| `human-user` | 当前人类用户：执行 human_light Run（start/complete）、接受提议 |
| `human-reviewer` | 验收者：提交判据 verdict（`acceptance_record`） |
| `agent-exec-1` | agent 执行者：seed-2 的 Run 由它执行 |

mock 对「验收 actor == 执行 actor」返回 409 `forbidden`；seed-2 的 `executed_by` 为
`agent-exec-1`、`acceptance.recorded_by` 为 `human-reviewer`，两者不同，与规约一致。

## 种子数据

- 项目 `proj-d8`（`SEED_PROJECT_ID`），goal `active`；
- 任务：`task-seed-1`（active，agent 执行中）、`task-seed-2`（awaiting_acceptance，3 判据已记 1 条
  partially_accepted）、`task-seed-3`（captured，无指派）；
- 1 条 pending decision（`decision-dec-1`，发布窗口）；14 条种子事件
  （ProjectCreated → DecisionCreated）。

## 已知简化（交卷登记项，与契约/内核的张力）

1. **逐判据命令**：任务书要求逐判据提交，但冻结内核事件目录只有
   `AcceptanceRecorded`/`AcceptanceSuperseded`（无逐判据事件），且规约要求覆盖完整性。
   mock 折中：逐条提交累积判论 → 覆盖完整时才落最终 `AcceptanceRecorded`（verdict
   一致性 + 迁移矩阵在 `mock/commands.ts` 实现）。
2. **提议拒绝**：封闭事件目录无「提议被拒」事件类型，mock 不广播，界面拒绝后离开提议页。
3. 命令 `type` 已对齐服务端 canonical 词表（FIX-ROUND-1 R-1，6 词：
   `proposal_accept`/`proposal_reject`/`task_advance`/`feedback_submit`/`acceptance_record`/`task_cancel`）；
   K0 界面入口 5 词（`feedback_submit` 无界面入口，捕获走 `/api/capture`）。
   原 web 车道 7 动词映射：`accept_proposal→proposal_accept`、`reject_proposal→proposal_reject`、
   `start_task`/`complete_task→task_advance`、`record_criterion_verdict→acceptance_record`、
   `cancel_task→task_cancel`；原 `resolve_decision` 无服务端对应、已下线（契约缺口见
   `web/README.md`「已知边界」）。`task_advance` 的开始/完成分派口径为 mock 模拟，待服务端车道确认。
4. `[web 层补充]` 投影字段（`acceptance_criteria`/`criterion_results`/`acceptance`）：
   服务端未提供时页面须降级渲染（见任务书交卷要求）。

## 文件地图

| 文件 | 职责 |
| --- | --- |
| `types.ts` | mock 内部类型 + actor 常量 |
| `seed.ts` | 种子项目/任务/提议/决策/事件 |
| `store.ts` | 内存事件日志、幂等回执、投影构建、控制面状态 |
| `commands.ts` | 命令处理（canonical 词表 5 个界面入口；`task_advance` 按生命周期分派开始/完成）+ capture 处理（409 原因码、覆盖完整性、继承锁定、迁移矩阵） |
| `sse-stream.ts` | SSE 帧格式化、游标补发、心跳、abort 清理 |
| `handlers.ts` | 8 端点路由、统一信封（`{ok,data}`/`{ok:false,error}`）、模拟时延 |
| `errors.ts` | `MockHttpError`（409/404/400 静态构造） |
| `install.ts` | fetch 补丁 + `window.__xuxMock` 控制面 + `isMockEnabled()` |
