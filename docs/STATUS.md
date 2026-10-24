based_on: bfe9c80

# 续行状态（STATUS）

| 项 | 状态 |
|---|---|
| 基线 | develop/eventstore-batch1 @ 80a09c1（Batch 2 起点） |
| Batch 2（eventstore 硬化批次） | 实现完成，待独立评审 / 复验 |
| 内核能力 | appendBatch 批量追加 · Run 命令层守卫与派发审计 · 事务作用域与 COMMIT 真实性 · 增量消费水位（落库 + 投递幂等） · Scheduler 定时器（REQ-SCH-3） · Acceptance 重算（REQ-ACC-3） |
| 仍留后续批次 | 生产调度循环、生产投影消费者、C1/C1b 租约对账、G1 全旅程、PlanChange 校验流水线 |
| D9 交互契约 | 已评审，按 D10 裁决修订中 |
| 门禁：根测试（真 PG16） | 522 passed / 5 todo / 0 failed |
| 门禁：server 测试 | 72 passed / 0 failed |
| 门禁：typecheck | 根 + server 均 0 错 |
| 门禁：web 构建 | 成功（tsc --noEmit + vite build） |
| 门禁：journeys | mock 轮 13 passed / 3 skipped（spec50 真服务轮单跑 3 passed） |
| 门禁：docs-check | 本次刷新后通过（based_on 指向 Batch 2 末次代码提交） |

决策见 docs/DECISIONS.md
