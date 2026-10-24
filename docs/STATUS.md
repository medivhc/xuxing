based_on: ab1504eab2f2c7278f37f8014fce575e7ff95203

# 续行状态（STATUS）

| 项 | 状态 |
|---|---|
| 基线 | develop/eventstore-batch1 @ ab1504e（FR4 待我处理页修复已合入；K1 在本分支 feat/k1-on-ab1504e 移植） |
| Batch1 复审 fix 波次 | 两轮进行中 |
| D9 交互契约 | 已评审，按 D10 裁决修订中 |
| D9 旅程测试 | 开发中 |
| K0 Web | 四入口已上线；CI 三 job 全绿为合入门 |
| K1（决策闭环 / 执行节点 / 访问控制） | 已实现：resolve_decision 全形态、node-agent 长轮询派发 + probe 对账、双令牌 fail-closed；旅程 J1–J4 进 CI 真服务轮 |
| 门禁 | 根测试 + server 测试全绿、双 typecheck + journeys typecheck、web 构建、docs-check（详见各批次报告） |
| 门禁：沙箱测试 | 165 passed / 48 skipped / 5 todo；PG 集成待 CI 复跑 |
| 门禁：fix 波次自装 PG16 环境 | 251 passed / 0 failed |

决策见 docs/DECISIONS.md（K1 裁决集 = D12）
