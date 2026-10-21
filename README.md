# 续行（Xuxing）

以目标与结果为中心、人与 AI Agent 共同执行的工作系统。

## 文档

- 产品蓝图（目标态）：`~/workspace/user/files/Xuxing_Final_Product_Blueprint_v1.0_1___1__0_ew1d.md`（§0–§10，缺安全/NFR/成本/离线四章，由技术方案先行补齐框架 — D7）
- 评审 + 技术方案 v1：`~/workspace/your_files/xuxing-review-and-tech-plan.md`
- 决策记录：`docs/DECISIONS.md`
- K0 领域 spec：`spec/K0-SPEC.md`（当前阶段：contract-review）

## 已定版决策（2026-10-21，用户拍板全部按评审建议）

D1 云端内核 + 本地执行节点 · D2 内核 TypeScript · D3 K0/K1 不引入 Temporal · D4 第一批真实负载 = nx-pipeline 双轨对照 · D5 副作用 L2 按项目逐项授权 · D6 品牌/英文名搁置 · D7 缺失四章由技术方案补齐框架、细则在 K0 spec 对齐

## 阶段

- **K0 脊柱**（进行中）：Event Store + Task/Run/Feedback/Outcome/Acceptance + PlanChange 校验 + 单个代码 Agent 适配器 + 人类执行者 + Web 四入口最小形态 + 副作用 L0/L1。领域 spec 已冻结 v1.0（2026-10-21，三轮 contract-review APPROVED，见 `spec/FREEZE-LOG.md`）；脚手架已建（src/kernel 事件目录 53 类型与 spec §4 逐字对应、领域类型、EventStore 接口、G1 测试骨架），下一步 develop 第一批：Event Store 的 PG 实现 + 迁移矩阵校验器。
- K1 可信 / K2 协作 / K3 积累：见技术方案 §2.12
