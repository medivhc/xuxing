# web/ — 续行 K0 Web 层（车道 B）

Vite + React + TypeScript（strict）+ TanStack Query + Zustand + Tailwind CSS。
行为与状态语义以 `docs/interaction-contract.md`（v0.2 定稿）为准；本目录只实现 Web 层，
不触碰 `src/`（内核）、`server/`、`tests/`、`docs/`、`spec/`。

## 开发

```bash
cd web
npm install
cp .env.example .env   # VITE_API_MOCK=1：启用开发 mock
npm run dev            # http://127.0.0.1:5173
npm run build          # tsc --noEmit && vite build
```

## Mock 开关

| 环境 | 行为 |
|---|---|
| `VITE_API_MOCK=1` | 启用 `src/mock/` 请求拦截层：内存事件存储 + 投影 + 命令处理 + SSE 事件流，四入口与完整旅程离线可跑 |
| 未设置 / 其他值 | 直连真实 `/api`（同源相对路径） |

API 客户端层（`src/api/`）与 mock 严格分离：页面与客户端不 import mock 的任何内部实现，
mock 只通过拦截 `fetch` 生效。

## 目录

| 路径 | 内容 |
|---|---|
| `src/api/` | HTTP 客户端（8 个契约端点）、SSE 客户端（先订阅后快照 / 自管 cursor / 35s 心跳看护）、事件→投影失效映射 |
| `src/mock/` | 可开关开发 mock（种子数据、投影、命令、SSE） |
| `src/pages/` | Home / Capture / My Actions / Project / Proposal |
| `src/components/` | 共享呈现组件（徽标、骨架、错误条、空态、pending 按钮、同步徽标等） |
| `src/state/` | Zustand：P 层连接状态、I 层输入态 |
| `src/styles/` | design tokens（契约 §7） |

## 验证（E2E 旅程）

`VITE_API_MOCK=1 npm run dev` 后，浏览器可走通完整旅程（已用 Chromium 自动化全量验证）：

1. **Home**：投影渲染（项目卡 / lifecycle 计数 / attention 按 rank / recent）；连接徽标 online、同步徽标 fresh。
2. **Capture → 提议**：`__xuxMock.forceNextProposalDegraded()` 后捕获 → 提议页 **降级明示**（role=alert 横幅 + 原因 + 标题「降级解释」+ 接受钮变体「核对后接受…」）→ 二次确认接受 → 跳项目页，新任务（ready，带提议判据）入列。
3. **My Actions**：按 `available_actions` 渲染；决策行 `approved_modified` 置灰（OQ-04=B）；开始/完成任务后投影实时更新（done 离列）。
4. **Project → 逐判据验收**：`awaiting_acceptance` 任务表单默认展开；每条判据独立 `record_criterion_verdict`（passed/failed/not_applicable + 备注 + 证据）；覆盖完整性提示（已判 N/M）；继承锁定（已 passed 改判无证据 → 409 `criterion_locked` 原样呈现）；补证据 supersede 成功；覆盖完整按 verdict 一致性落结论（全 passed → accepted；含 failed → rejected → 迁移矩阵回 defined）。
5. **SSE 三纪律**：订阅先行（main.tsx 渲染前 start）；`__xuxMock.stopHeartbeats()` 后约 35s 看护判定 offline、1s 退避自动重连 online（游标自理补发）；`startHeartbeats()` 恢复。

页面交互用 `data-testid` 标记（`criterion-pass-*`/`my-actions-row`/`proposal-degraded-banner`/`error-conflict` 等），供 e2e 定位。

已知边界：mock 为页面级内存单例，**整页刷新即回种子状态**（SPA 内导航不重置）；命令 `type` 字符串为 web 车道草案（见 `src/mock/README.md` 交卷登记项）。
