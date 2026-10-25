based_on: 8ed1a7e1a4b4fa5e25ad4bf051f33e4c7fc77e22

# 续行状态（STATUS）

| 项 | 状态 |
|---|---|
| 基线 | develop/eventstore-batch1 四轨合入完成（Batch 2 / Q12 / 阶段二 / K1，基线 ab1504e） |
| Batch 2 / Q12 / 阶段二 | 已合入 develop（三轨评审均 APPROVED；同名收尾项双实现已按超集口径拼接） |
| K1（决策闭环 + 执行节点 + 双令牌） | 已合入 develop（移植分支 feat/k1-on-ab1504e；复验 APPROVED + 移植 delta 评审 APPROVED） |
| K0-Q25 Agent 执行器（agent_hands_agent） | 已合入 develop 并部署生产（服务端镜像 20261025-1726 + 节点新执行器）；生产 e2e 主任务已到 awaiting_acceptance，并发竞态 fix2 已合入（8ed1a7e） |
| 内核能力 | appendBatch · Run 守卫/审计 · 事务作用域 · 消费水位 · Scheduler · Acceptance 重算 · actor 分离守卫 · Tool Gateway · listStreams · Decision 实体与裁决 · 节点派发 |
| 仍留后续批次 | 生产调度循环、生产投影消费者、C1/C1b 租约对账、G1 全旅程、PlanChange 校验流水线、多用户/权限（K2） |
| D9 交互契约 | v0.2 已合入 develop（D11 裁决落地）；K1 契约附则 §12 + D12 已登记 |
| 门禁：根测试（真 PG16） | 634 passed / 5 todo / 0 failed |
| 门禁：server 测试 | 144 passed / 0 failed |
| 门禁：typecheck | 根 + server 均 0 错 |
| 门禁：web 构建 | 成功 |
| 门禁：journeys | mock 轮 13 passed；真服务轮 spec50 4 passed + spec60 2 passed + K1 五 spec 10 passed |
| 门禁：docs-check | 本次刷新后通过 |

决策见 docs/DECISIONS.md
