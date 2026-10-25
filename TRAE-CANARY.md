# TRAE-CANARY

## 仓库结构概述

- `.github/workflows/`：CI 工作流，`ci.yml` 与 `docs.yml`。
- `spec/`：K0 领域 spec 及其演进版本（`K0-SPEC-FROZEN-v1.0.md`、`K0-SPEC.md`、`K0-SPEC-v0.1.md`、`K0-SPEC-v0.2.md`）、三轮 contract-review 记录（`K0-CONTRACT-REVIEW.md`、`-R2`、`-R3`）、冻结日志 `FREEZE-LOG.md` 与 `V1.1-CANDIDATES.md`。
- `docs/`：项目文档，如决策记录 `DECISIONS.md`、`STATUS.md`、`VISION.md`、`interaction-contract.md`。
- `src/kernel/`：确定性内核，包含事件目录 `events.ts`、Event Store 接口与 PG 实现、迁移矩阵校验 `transition-guard.ts`、Run 事件命令层 `run-events.ts`、调度器 `scheduler.ts`、验收 `acceptance.ts`、执行者守卫 `actor-guard.ts`、工具网关 `tool-gateway.ts` 等。
- `src/domain/`：领域类型定义 `types.ts`。
- `src/proposers/`、`src/executors/`、`src/projections/`：智能层（只产提议）、执行适配层、CQRS 读模型，目前以 README 占位。
- `server/`：HTTP 服务端，含 `src/api/`（路由、视图、静态资源）、`src/auth/`、`src/commands/`、`src/decisions/`、`src/nodes/`、`src/projection/`、`src/proposers/`、`src/sse/`、`src/seed/`，以及入口 `app.ts`、`main.ts`；测试位于 `server/test/`。
- `web/`：前端应用（Vite + React），含 `src/pages/`（Home、Capture、MyActions、Project 等页面）、`src/components/`、`src/features/`、`src/api/`、`src/state/`、`src/styles/`，以及 `src/mock/` 本地模拟层。
- `node-agent/`：执行节点，含 `src/agent.mjs` 与 `src/executors.mjs`。
- `tests/`：根级测试，含 `tests/e2e/`（Playwright）、`tests/journey/`（旅程与投影一致性测试）、`tests/journeys/`（旅程 mock 服务、Playwright specs 与支撑代码）、`tests/support/`，以及根目录下的事件存储、迁移校验、重演、G1 等测试文件。
- `tools/docs-check.mjs`：文档检查脚本。
- 根目录：`package.json`、`package-lock.json`、`tsconfig.json`、`vitest.config.ts`、`.nvmrc`、`AGENTS.md`、`README.md`。

## 如何运行测试

根目录 `package.json` 中的测试相关 script（名称与命令逐字引用）：

```json
"test": "vitest run",
"server:test": "vitest run --config server/vitest.config.ts"
```

配套的数据库容器 script（同样逐字引用）：

```json
"db:up": "docker inspect xuxing-pg-test >/dev/null 2>&1 && docker start xuxing-pg-test || docker run -d --name xuxing-pg-test -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=xuxing_test -p 127.0.0.1:55432:5432 --tmpfs /var/lib/postgresql/data:rw,size=512m postgres:16-alpine",
"db:down": "docker rm -f xuxing-pg-test",
"db:reset": "npm run db:down; npm run db:up"
```

因此运行根级测试使用 `npm test`，运行服务端测试使用 `npm run server:test`。

## 一句话结论

续行（Xuxing）是一个以事件溯源确定性内核为基础、由只产提议的智能层与可插拔执行适配层组成、并配套 Web 前端与 HTTP 服务端的人机协作工作系统。
