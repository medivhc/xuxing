based_on: f4989e8810d76dd11306412db29046d5c5551be7

# 续行状态（STATUS）

| 项 | 状态 |
|---|---|
| 基线 | develop/eventstore-batch1 @ ab1504e（FR4 已合入）+ Batch 2/Q12/阶段二已合入 + K1 合入中 |
| Batch 2 / Q12 / 阶段二 | 已合入 develop（三轨评审均 APPROVED） |
| K1（决策闭环 + 执行节点 + 双令牌） | 经移植分支 feat/k1-on-ab1504e 合入中（复验 APPROVED + 移植 delta 评审 APPROVED） |
| 内核能力 | appendBatch · Run 守卫/审计 · 事务作用域 · 消费水位 · Scheduler · Acceptance 重算 · actor 分离守卫 · Tool Gateway · listStreams · Decision 实体与裁决 · 节点派发 |
| 仍留后续批次 | 生产调度循环、生产投影消费者、C1/C1b 租约对账、G1 全旅程、PlanChange 校验流水线、多用户/权限（K2） |
| D9 交互契约 | v0.2 已合入 develop（D11 裁决落地）；K1 契约附则 §12 + D12 已登记 |
| 门禁 | 合入后复跑回填 |

决策见 docs/DECISIONS.md
