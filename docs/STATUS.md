based_on: 5aa5aa6840c7bb33fa2cba563fb5cf221d3ca886

# 续行状态（STATUS）

| 项 | 状态 |
|---|---|
| 基线 | develop/eventstore-batch1 @ ab1504e（FR4 已合入）+ Batch 2/Q12 已合入 + 阶段二合入中 |
| Batch 2（eventstore 硬化批次） | 已合入 develop（评审 APPROVED） |
| K0-Q12 actor 分离（C6） | 已合入 develop（评审 APPROVED） |
| 阶段二（收尾杂项 + A 案自托管） | 合入 develop 中：服务端静态自托管（static.ts + SPA 回退）+ pF7/pF8 余项；与 Batch2 杂-1/杂-2 同名项已按超集口径拼接（见合入记录） |
| 内核能力 | appendBatch · Run 守卫/审计 · 事务作用域 · 消费水位 · Scheduler · Acceptance 重算 · actor 分离守卫 · Tool Gateway · listStreams |
| 仍留后续批次 | 生产调度循环、生产投影消费者、C1/C1b 租约对账、G1 全旅程、PlanChange 校验流水线 |
| D9 交互契约 | v0.2 已合入 develop（D11 裁决落地） |
| 门禁 | 合入后复跑回填 |

决策见 docs/DECISIONS.md
