# 续行 K0 — 自主探索循环章程（试点）

2026-10-23 用户拍板：以续行 K0 为试点目标，试行「长期目标 + 自主探索 + 任务队列自循环」机制。
机制说明见 skill `autonomous-explore-loop`；队列见同目录 `QUEUE.md`；每轮探索日志在 `hidden_files/explorations/`。

## 长期目标

按冻结 spec v1.0 建成续行 K0 脊柱：事件溯源确定性内核（Event/Task/Run/Feedback/Outcome/Acceptance/PlanChange）、单个代码 Agent 适配器、人类执行者与 Web 四入口最小形态；云端内核 + 本地执行节点，内核 TypeScript（D1/D2），首批真实负载用 nx-pipeline 双轨对照（D4）。

## 验收形态（D8，2026-10-23 用户对齐确认）

K0 结束时交付的是最小形态：Web 四入口（Home/Capture/My Actions/Project，单用户、朴素）+ 一条完整旅程真实跑通 + 代码 Agent 真派活 + 双轨对照报告。不追求发布/演示级产品感。

## 退出标准（= spec §8.3，不另设）

G1–G5 全绿 + C1–C6（含 C1b）全绿 + REQ-DT-2 双轨对照报告已评审。三者缺一，K0 不算完成，不进 K1。

## 角色分工（2026-10-23 用户明确）

- **本循环只做探索与规划，不执行具体的事。** 具体执行一律派给执行器（注册表 `EXECUTORS.md`）：写代码/跑测试 → 真机 opencode（走 nx-pipeline）；外部建议 → 浏览器咨询程序（如 `ask-chatgpt`，待建）；评审 → 独立子代理。
- 执行全部异步：派发后标 `dispatched` 不等待；结果回写 `hidden_files/results/`，下一轮先收结果、按完成判定验收，再决定下一步。
- 遇到新类型的活，第一次由循环亲自探索路径，成功后抽象成可直接调用的程序登记进注册表，之后只调用、不再探索。
- 执行走既有 nx-pipeline：独立评审 → 修复 → 复验，评审员与作者不同模型、不同 session；TDD 评审 ≤2 轮。
- bug fix 先与用户一起看方案再修；新批次（Batch）开工属 P1 级，先报用户确认范围再派发。
- 不可逆 / 对外 / 花钱动作：停下报用户。本循环只在 `/work/xuxing`（真机）与沙盒 pipeline 目录内工作。
- 测试需要真实模型调用时，复用 opencode 已配置的 provider/key（见 `EXECUTORS.md` 模型与密钥一节），不另要 key、不自建密钥管理。
- 每轮：先跑探针 `hidden_files/tools/probe-k0-state.sh`，只推进一格，新增任务 ≤5 条。
- 连续 2 轮无变化且队列无 ready → 停循环报用户，不空转。

## 节奏

- 定时循环 `k0-autopilot-loop` 每小时一轮，静默为默认。
- 只在三种情况报用户：需要拍板、blocked、里程碑 done。
