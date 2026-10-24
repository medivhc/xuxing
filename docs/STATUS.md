based_on: c8111057d3b790e8c538611b27b55d012c6d1b38

# 续行状态（STATUS）

| 项 | 状态 |
|---|---|
| 基线 | develop/eventstore-batch1 @ ab1504e（FR4 已合入）+ Batch 2 已合入 + Q12 合入中 |
| Batch 2（eventstore 硬化批次） | 已合入 develop（merge c811105；评审 APPROVED） |
| K0-Q12 actor 分离（C6） | 评审 APPROVED（BLOCKER 0），合入 develop 中：REQ-ACC-2 分离拦截 + INV-6 Tool Gateway + actor 写路径校验 |
| 内核能力 | appendBatch 批量追加 · Run 命令层守卫与派发审计 · 事务作用域与 COMMIT 真实性 · 增量消费水位（落库 + 投递幂等） · Scheduler 定时器（REQ-SCH-3） · Acceptance 重算（REQ-ACC-3） · actor 分离守卫 · Tool Gateway |
| 仍留后续批次 | 生产调度循环、生产投影消费者、C1/C1b 租约对账、G1 全旅程、PlanChange 校验流水线 |
| D9 交互契约 | v0.2 已合入 develop（D11 裁决落地） |
| 门禁：根测试（真 PG16） | 合入后复跑回填 |
| 门禁：server 测试 | 合入后复跑回填 |
| 门禁：typecheck | 根 + server 均 0 错（合入后复跑确认） |
| 门禁：web 构建 | 成功（合入后复跑确认） |
| 门禁：journeys | 合入后复跑回填 |
| 门禁：docs-check | 本次刷新后通过（based_on 指向合入前 develop tip） |

决策见 docs/DECISIONS.md
