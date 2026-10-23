# AGENTS.md — 续行（Xuxing）仓库指南

> 面向后续 AI agent 的短版指南。行为判卷标准是 `spec/K0-SPEC-FROZEN-v1.0.md`；本文与 spec 冲突时以 spec 为准。

## 1. 项目定位

续行（Xuxing）：**事件溯源确定性内核 + 只产提议的智能层 + 可插拔执行适配层**，Web 四入口（Home / Capture / MyActions / Project）最小形态。当前阶段 **K0 脊柱**，语言 TypeScript（Node），内核事实来源为 PostgreSQL。

## 2. 目录地图

| 路径 | 一句话 |
|---|---|
| `src/kernel/` | 确定性内核：`events.ts` 事件目录、`event-store.ts` 接口、`event-store-pg.ts` PG 实现、`transition-guard.ts` 迁移矩阵校验、`index.ts` 出口 |
| `src/domain/` | 领域类型 `types.ts`：只放枚举与实体形状，行为一律在 kernel |
| `src/proposers/` | 智能层（Intent Interpreter / Planner / Outcome Interpreter）：只产提议、无写内核通道（README 占位） |
| `src/executors/` | 执行层：代码 Agent 适配器 + 人类执行者，统一 RunProtocol（README 占位） |
| `src/projections/` | CQRS 读模型：Home / MyActions / Project 投影，可由事件流按 `global_seq` 重演（README 占位） |
| `tests/` | 测试：`event-store-pg.test.ts`、`transition-guard.test.ts`、`replay-c5.test.ts`、`g1-contact-followup.test.ts` |
| `tests/support/` | 测试支撑：`pg.ts`（PG 容器）、`minimal-projection.ts` |
| `docs/` | 决策记录 `DECISIONS.md`（D1–D7 与 spec 裁决 S1–S7） |
| `spec/` | K0 领域 spec 冻结版 + 三轮 contract-review + `FREEZE-LOG.md`、`V1.1-CANDIDATES.md` |
| 根目录 | `README.md`、`package.json`、`tsconfig.json`、`vitest.config.ts`、`.nvmrc`（Node 24.4.1） |

## 3. 常用命令

固定 Node 24.4.1（`.nvmrc`）。依赖安装 `npm install`（README 给出的准备步骤）；以下为 `package.json` 的 scripts 原样：

| 命令 | 实际执行 |
|---|---|
| `npm run build` | `tsc -p tsconfig.json` |
| `npm test` | `vitest run` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:up` | 起/复用测试容器 `xuxing-pg-test`（`postgres:16-alpine`，`127.0.0.1:55432`） |
| `npm run db:down` | `docker rm -f xuxing-pg-test` |
| `npm run db:reset` | `npm run db:down; npm run db:up` |

`npm test` 会自动确保 PG 容器；docker 不可用会大声失败，**绝不 skip**（可按失败指引设 `XUXING_TEST_PG_URL` 指向外部 PG16）。容器可复用，无需每次重建。

## 4. 硬约定

1. **事件是唯一真相源**：Task lifecycle / wait_state、Run state 等均为事件派生状态，每次变更必有对应事件为源，不存在无事件的状态变更（spec §4 派生规则、INV-12）。
2. **智能层只提议、不落库**：proposers 输出带类型 Proposal，经内核校验（REQ-PC 流水线）才入账；executors 只回报 RawResult，不得直接写 Outcome（REQ-OC-1）。
3. **内核确定性**：`src/kernel` 不得直接读系统时间或随机源（`Date.now()` / `Math.random()`），时间戳与 ULID 由上层命令层/driver 注入，保证同输入可重演（C5：投影重演逐字段 diff 为零）。
4. **只追加**：事件不可 update/delete；纠错以 `supersedes_id` 追加新记录（INV-7）；重试建新 Run，不复用旧 Run（INV-4）。
5. **不发明行为**：spec 明示“K0 仅信息标注 / 纯记录语义”的字段与边（`verification_status`、`environments[]`、`conflicts_with`、`supersedes`）不得据其自创调度或判定逻辑。
6. **流粒度**：`stream_id = project_id`（spec §4）；`migrate(pool)` 需自行调用一次（幂等），`createPgEventStore(pool)` 不自带迁移。

## 5. 测试纪律

- 新行为先写测试再写实现；断言挂到 spec 的 `REQ-*` / `INV-*` / `G*` / `C*` 编号，不自造判据。
- 涉及 PG 的测试必须有**真实 PostgreSQL 16** 证据，不接受 mock 或 skip；docker 不可用按失败指引改指外部 PG16。
- 验收门：G1–G5 与 C1–C6（含 C1b 对照用例）全绿 + `REQ-DT-2` 对照报告评审通过，三者缺一 K0 不算完成。

## 6. 协作约定

- **不直接推 `develop` / `master`**：一律走特性分支 + PR。
- 分支命名带前缀：`qoder/*` 或 `workbuddy/*`。
- 提交信息一句话说清改了什么；改动 spec 走版本递增 + 变更记录，不静默改冻结版。
- 不要为了“看起来完整”臆造命令、目录或字段；不确定先查 spec 与 README。

## 7. 文档索引

- `docs/DECISIONS.md` — 已定版决策 D1–D7 与 K0 spec 裁决 S1–S7（编号 / 决策 / 依据 / 日期 / 状态）。
- `spec/K0-SPEC-FROZEN-v1.0.md` — K0 领域 spec 冻结版：领域模型、迁移矩阵、事件目录、REQ/INV、G1–G5 与 C1–C6 验收门。
- `spec/FREEZE-LOG.md` — v1.0 冻结经过与三轮 contract-review 结论。
- `README.md` — 阶段现状、本地开发步骤与 Event Store（Batch 1）用法示例。
