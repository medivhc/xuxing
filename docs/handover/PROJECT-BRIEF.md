# PROJECT-BRIEF — 续行是什么（给零上下文的接手者）

## 产品一句话
续行（Xuxing，英文品牌名未定，D6 搁置）是一个**以目标与结果为中心**的产品：人把目标交给系统，系统维护一张动态任务图，由人类与 AI Agent 共同执行、共同验收。不是待办清单，也不是聊天机器人套壳。

## 架构三层（D1–D3 的落地形态）
- **云端内核（TypeScript）**：事件溯源的确定性内核。所有状态变更都是事件；任务/Run/Evidence/Decision 都是内核实体；投影（如「待我处理」）由事件派生，前端不许自建状态。
- **智能层**：只产提议（proposer），不直接改状态。提议经人裁决（Decision）才成为任务——这是产品语义的硬边界。
- **执行适配层**：可插拔执行器。已有：shell 执行器、agent_hands_agent（在本地节点上用 tmux+opencode 跑代码 Agent）。执行节点（node-agent）跑在用户机器上领 Run、执行、回证据。

## 分期
- **K0（已完成，总验收 ACCEPTED WITH FOLLOW-UPS）**：内核脊柱 + Web 四入口（Home/Capture/My Actions/Project）+ 决策闭环 + 双令牌 + 本地执行节点 + Agent 执行器 + 生产部署（tg.bewith.link）。
- **K1 已并入 K0 收官**（决策闭环/节点/令牌原属 K1 范围，提前落地）。
- **K2 及后续（未开工）**：多用户/权限、生产调度循环、生产投影消费者、租约对账、G1 全旅程、PlanChange 校验流水线；产品感打磨（D8 明确不在 K0 范围）。

## 关键语义备忘
- 验收（acceptance）是状态机的一部分，不是 UI 装饰：Run 完成 → awaiting_acceptance → 人验收才闭环。
- actor 分离：提议者、执行者、裁决者的身份在内核层分离校验（Q12），自提自批会被拒——双轨对照时实证过，两支自体验收探针均被正确拒绝且零落盘。
- 副作用分级 L0–L3：L2 按项目逐项授权，L3 永远走决策卡。

## 重要原始文档（按优先级）
1. 仓库 `docs/VISION.md`、`docs/DECISIONS.md`、`docs/STATUS.md`、`docs/interaction-contract.md`、`spec/`（K0 冻结 spec v1.0 + K1 spec）。
2. 本交接包 01–06。
3. 仓库根 `handover-attachments/` 里的协调者文档快照（AUTOPILOT/EXECUTORS/QUEUE/ENGINEERING/DOC-FLOW）——理解「活是怎么派出去的」，但它们是 2026-10-27 快照，执行器可用性与额度以接手时实测为准。
