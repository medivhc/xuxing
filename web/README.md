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
