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
3. **My Actions**：按 `available_actions`（canonical 词表，FIX-ROUND-1 R-1）渲染；`task_advance` 按任务生命周期分派（defined/ready → 开始执行；active → 标记完成）、`task_cancel` 取消；开始/完成后投影实时更新（done 离列）。**K1 起决策行可裁决**：展开裁决面选 approved/rejected/deferred（rejected 必填理由、deferred 填唤起条件）提交 `resolve_decision`（契约 §12.1/§12.2）；冲突（409）原样呈现不自动重试。
4. **Project → 逐判据验收**：`awaiting_acceptance` 任务表单默认展开；每条判据独立 `acceptance_record`（passed/failed/not_applicable + 备注 + 证据）；覆盖完整性提示（已判 N/M）；继承锁定（已 passed 改判无证据 → 409 `criterion_locked` 原样呈现）；补证据 supersede 成功；覆盖完整按 verdict 一致性落结论（全 passed → accepted；含 failed → rejected → 迁移矩阵回 defined）。
5. **SSE 三纪律**：订阅先行（main.tsx 渲染前 start）；`__xuxMock.stopHeartbeats()` 后约 35s 看护判定 offline、1s 退避自动重连 online（游标自理补发）；`startHeartbeats()` 恢复。

页面交互用 `data-testid` 标记（`criterion-pass-*`/`my-actions-row`/`proposal-degraded-banner`/`error-conflict` 等），供 e2e 定位。

## 已知边界

1. **resolve_decision 契约缺口已由 K1 关闭（2026-10-25）**：服务端命令词表增补第 7 词 `resolve_decision`，Decision 成为独立投影实体、My Actions 决策行恢复裁决入口（契约 §12 附则）。`approved_modified` 仍不提供前端表单（OQ-K1-1 裁决）：走 `proposal_accept` 的 `supersedes_change_id` + `decision_reason` 旁路（API 层）。
6. **访问控制入口门（K1-C）**：服务端启用令牌时（`XUXING_USER_TOKEN`），应用先渲染令牌门（`auth-gate`），输入用户令牌换会话 cookie 后才挂载业务界面；令牌只驻内存、不落 Web Storage；任一业务请求 401 广播回锁。mock 模式不启用门。
2. **命令词表映射（web 车道 → canonical）**：`accept_proposal→proposal_accept`、`reject_proposal→proposal_reject`、`start_task`/`complete_task→task_advance`、`record_criterion_verdict→acceptance_record`、`cancel_task→task_cancel`。界面 `type` 与 `available_actions` 一律以服务端词表为准，不许自造动作；`task_advance` 的开始/完成分派口径为 web 车道模拟（按任务生命周期分派），待服务端车道确认。
3. **mock 为页面级内存单例**：整页刷新即回种子状态（SPA 内导航不重置）。
4. **mock 交卷登记项**：见 `src/mock/README.md`「已知简化」（逐判据命令折中、提议拒绝无事件类型、`[web 层补充]` 投影字段服务端未提供时降级等）。
5. **提议只含 draft（R-11）**：提议投影仅携带 draft（标题 + 验收判据），不展示、不预分配任何 task_id——任务只在提议被接受后由服务端生成并新发 id（mock 的 `acceptProposal` 同口径）。
