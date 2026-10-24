based_on: d166f3d270b9d76566fbe3a505f4fc98b5d85fbf

# 续行状态（STATUS）

| 项 | 状态 |
|---|---|
| 基线 | develop/eventstore-batch1 @ 80a09c1（本轨分支 feat/k1，未 push） |
| K0 Web | 四入口已上线；CI 三 job 全绿为合入门 |
| K1（决策闭环 / 执行节点 / 访问控制） | 已实现：resolve_decision 全形态、node-agent 长轮询派发 + probe 对账、双令牌 fail-closed；旅程 J1–J4 进 CI 真服务轮 |
| 门禁 | 根测试 + server 测试全绿、双 typecheck + journeys typecheck、web 构建、docs-check（详见各批次报告） |

决策见 docs/DECISIONS.md（K1 裁决集 = D12）
