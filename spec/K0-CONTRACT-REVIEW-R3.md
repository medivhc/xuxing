# 续行 K0 领域 Spec — Contract Review 第三轮报告

**评审对象**：`spec/K0-SPEC.md` v0.3（文首标注"待 contract-review 第三轮"）
**对照材料**：第二轮报告 `spec/K0-CONTRACT-REVIEW-R2.md`、第一轮报告 `spec/K0-CONTRACT-REVIEW.md`（背景）、`docs/DECISIONS.md` 裁决 S1–S7、蓝图 v1.0 §4/§7/§8
**评审性质**：独立第三轮 contract-review（熔断线内最后一轮），只审 spec 本身，不写实现、不改 spec。本轮评审员与作者、修订者、前两轮评审员均非同一上下文。

---

## Verdict

**APPROVED** — 第二轮 13 项（新 P1×4、新 P2×8、§9.1 纠正）全部已解决且 §10.1 修订记录属实，v0.3 新内容经全文复审无新 P0、无新 P1、无实质分歧，spec 可冻结为 v1.0。

**冻结口径的应用结果**：本轮新发现问题仅 P2 共 4 条，按"无 P0 且 P1 全部闭合时 P2 不阻塞冻结"的口径，全部列入文末冻结后修订候选，不构成 CHANGES_REQUESTED 理由；本报告无仲裁清单（无实质分歧需仲裁）。

---

## 第一部分 · 第二轮 13 项逐条验收

口径：**已解决** = 改法完整落地且可判定；**部分解决** = 主体落地但残余缺口未闭；**未解决** = 未落地或走样。证据章节均指 v0.3 正文；§10.1 修订记录与正文落点逐行核对，结论单列于表后。

| 条目 | 结论 | 证据与核查 |
|---|---|---|
| 新 P1-1 | 已解决 | §2.6 REQ-ACC-2 新增入账校验两条：①覆盖完整性（该 contract_rev 契约全部 criterion_ref 必须出现在 criterion_results，缺项不入账）；②继承锁定校验（已 passed 判据被置 failed/not_applicable 且未 supersede 先前记录或该项未附新证据 → 不入账）。与 REQ-ACC-3 继承锁定、REQ-ACC-4 的 supersede+新证据口径逐字对齐，"锁定"已成内核可判定规则 |
| 新 P1-2 | 已解决 | §4 事件目录封闭集已含 `TaskWaitStateChanged`（全文 4 处引用一致）；派生规则声明写明 wait_state 每次变更均发该事件（payload 含 from/to、置位 actor 与原因），并逐项点名 §3.1 的人工直接置位 blocked/on_hold（不经 WaitCondition）路径。P0-4 残余收尾完成，§4"不存在无事件的状态变更"声明在此路径恢复为真 |
| 新 P1-3 | 已解决 | §2.5 REQ-OC-1 新增"来源限定"：Outcome 只由绑定 Run（executor 或 human_light）的 Feedback/RawResult 产生，游离 Feedback 不生成 Outcome、不得触发 REQ-ACC-3 重算；§5.7 REQ-HUM-2 同步写死：游离 Feedback 的解释只更新 interpretation_status 并产生留待绑定摘录（随 Feedback 记录保存）。两处表述逐项对齐，无第二种读法，R2 指出的与 REQ-ACC-3 的潜在冲突已消除 |
| 新 P1-4 | 已解决 | §8.2 C1 已补前置条件（Run 已启动 + side_effect_level ∈ {L2,L3} 或已有外部副作用调用记录），与 REQ-RUN-4 的 indeterminate 分界字面一致，原字面冲突消除；新增 C1b（leased 未启动被杀 → 回 queued、不走对账），§8.3 退出门已含 C1b。按 R2 改法口径（补前置条件 + 对照用例并存）验收通过；REQ-RUN-4 其余分界支路的用例覆盖另见新 R3-P2-1 |
| 新 P2-1 | 已解决 | §3.2 REQ-RUN-6 末段专文处置"取消请求到达时 Run 已 indeterminate"：取消意图不中断对账、对账仍由内核按 REQ-RUN-3 推进；对账出结论后 Run 置终态再走第③步；"无法确定"转 Decision 后，裁决置 canceled 则第③步随即满足，暂缓则 Task 保持取消意图、派发持续冻结、不存在绕过 Run 终态直接置 Task canceled 的路径。R2 指出的永不满足出路已闭合 |
| 新 P2-2 | 已解决 | §5.2 REQ-SCH-5 ④ 已补第三态：下游 lifecycle=active 且 Run 已启动未出 Outcome 的，Run 不自动取消、续跑至回报，Outcome 入账后置 wait_state=blocked 并产生 Decision。与 REQ-ACC-5 ② 的同口径处理一致，三态齐备 |
| 新 P2-3 | 已解决 | §5.1 REQ-PC-5 已写明 deferred 唤起后以唤起时刻当前 rev 为新 base 重走 REQ-PC-1 完整校验，并明示不以原 base_plan_rev 重走（避免必撞 base_rev_conflict 循环产生新 Decision），与 approved 路径口径一致 |
| 新 P2-4 | 已解决 | §5.7 REQ-HUM-3 写死 add_edge 的 kind = `part_of`（from = 跟进 Task、to = 原 Task，只表归属、不产生调度依赖，跟进 Task 不被该边阻塞）；§8 G1 写明对 T 的 Acceptance 的 subject_outcome_id 锚定 F 上第二次 Feedback 所生 Outcome 的 id（明示不是 T 自身的 Outcome），测试构造唯一 |
| 新 P2-5 | 已解决 | §2.4 ActorProfile 定义处已加声明：environments[] 在 K0 仅作信息标注、无消费方（TaskContract 无 required_environment、REQ-SCH-4 不校验环境），明示任何实现不得据此发明环境匹配行为，并注明与 §2.5 verification_status 同例处理。死字段已声明化 |
| 新 P2-6 | 已解决 | §2.5 Artifact 定义已写明版本分组键：id 为逻辑 Artifact 身份、跨版本稳定；每版本一条记录、(id, version) 唯一、version 按逻辑 Artifact 单调递增（首版 = 1）；pinned 时 target_id 锚逻辑 id、artifact_version 选具体版本，两者缺一不可。与 §2.3 pinned_version 封闭联合表述一致 |
| 新 P2-7 | 已解决 | §10 v0.2 修订记录 P1-2 行的改动章节已更正为"§3.1"（经原文核对：映射表与 INV-11 的实际落点均在 §3.1），审计链恢复准确 |
| 新 P2-8 | 已解决 | §5.1 REQ-PC-1 表述已改：auto_apply_ceiling 是副作用分级枚举 {L0,L1,L2,L3} 的子集 {L0,L1}（§2.7 Policy 定义），并明示不得放开到 L2/L3；§2.7 Policy 定义同步为 (L0|L1)，两处量纲表述一致，比较仍按序可判定 |
| §9.1 纠正 | 已解决 | §9.1 已撤回 v0.2"未发现新的 load-bearing 开放问题"声明，改为如实登记：第二轮新 P1-1..4 的来源（v0.2 新内容）、裁决（= 评审推荐、无用户新裁决项）与落点（指向 §10.1）；并立"此后每轮增记、不再作未发现式声明"的纪律。与 S1–S7 及第二轮 TRIAGE（全 run、无新裁决项）一致 |

**第一部分小结**：13 项中已解决 13、部分解决 0、未解决 0。§10.1 的 13 行修订记录与正文落点逐行核对全部属实（含改动章节标注）；v0.3 新增/改写内容均可溯源至第二轮条目，未发现借修订偷换主干语义，与蓝图 §7/§8、裁决 S1–S7 对照无新冲突。

---

## 第二部分 · 全文复审（四标准，聚焦 v0.3 新内容）

**特别检查一 · REQ-ACC-2 两条新入账校验与既有条目的一致性：通过。** 覆盖完整性与 REQ-ACC-3 的衔接成立：后续 Acceptance 须列全全部 criterion_ref、先前 passed 项以继承值列入，继承锁定校验只拦"无 supersede + 无新证据的回退"，两条校验互补不重叠；与 REQ-ACC-4（推翻只能 supersede 追加）的口径一致。顶层 verdict 一致性规则（全 passed/not_applicable → accepted、全 failed → rejected、混合 → partially）与覆盖完整性合并执行后，R2 指出的"遗漏 failed 判据拼出 accepted"路径已堵死。

**特别检查二 · TaskWaitStateChanged 与事件目录封闭集声明：通过。** 该事件已列入 §4 封闭集本体（不是只在派生声明中提及），封闭集声明与目录内容一致；派生规则声明对 wait_state 的表述已改为"每次变更发 TaskWaitStateChanged"，INV-11 终态自动收尾、REQ-SCH-5 ④ 置 blocked、人工置位三条路径均可由该通用规则覆盖，无新的无事件变更。

**特别检查三 · REQ-OC-1 / REQ-HUM-2 两处写死是否真对齐：通过。** 两处对游离 Feedback 的处置三要素逐项相同——不生成 Outcome、解释只更新 interpretation_status 并留待绑定摘录、不迁移 Task 状态（OC-1 另明示不得触发 REQ-ACC-3 重算，与 HUM-2 的"不迁移"等价）。绑定路径亦一致：Outcome 只源于绑定 Run（executor / human_light）的 Feedback/RawResult。

**特别检查四 · C1/C1b 与 REQ-RUN-4 分界覆盖：主干通过，残余为测试覆盖问题（见 R3-P2-1）。** REQ-RUN-4 的分界按（是否启动 × 副作用条件）计有三支：未启动 → 回 queued（C1b 覆盖）；已启动且 L2/L3 或有副作用记录 → indeterminate（C1 覆盖）；已启动且 L0/L1 且无副作用记录 → failed(lease_expired)（无 C 用例）。另 run_timeout 两支（超时无残留 → timed_out、超时不明 → indeterminate）亦无 C 用例。三支行为本身均已在 REQ-RUN-4 写死、可判定，缺的是验收用例而非语义，故按 P2 处理、不阻塞冻结。

**其余全文扫描**：v0.3 其余改写（REQ-RUN-6 末段、REQ-PC-5 deferred base 口径、REQ-SCH-5 ④、§2.4/§2.5 两处声明、G1 锚定句、§8.3 退出门含 C1b）逐处核对，未发现新悬空引用（REQ 编号引用均有落点）、新矛盾或新的不可判定表述；新增文字均未引入蓝图与 S1–S7 之外的语义。

---

## 第三部分 · 新问题清单（分级 + TRIAGE）

新 P0：**无**。新 P1：**无**。新 P2：4 条，全部 `run`（冻结后修订候选，随 v1.1 修订或实现期补测处理，不阻塞冻结）。

**R3-P2-1 §8.2 / §3.2 REQ-RUN-4 — 分界支路的验收用例未全覆盖**
C1/C1b 只覆盖"未启动 → queued"与"已启动且满足副作用条件 → indeterminate"两支；"已启动且 L0/L1 且无副作用记录 → failed(lease_expired)"与 run_timeout 两支（→ timed_out / → indeterminate）无任何 C 用例。§8.2 C1b 注文"覆盖 REQ-RUN-4 全部分界"的表述严格说只覆盖（已启动/未启动）二分，对已启动内部的副作用分界言过其实。行为已写死、可判定，属测试覆盖与表述精度问题。改法：补 C1c（已启动 L0/L1 无记录被杀 → failed(lease_expired) 后可新建 Run）与 C1d（run_timeout 超时两支对照），并把 C1b 注文改为"覆盖已启动/未启动二分"。

**R3-P2-2 §2.6 REQ-ACC-2 / §2.2 REQ-TC-1 — 空判据集时 verdict 一致性校验真空成立**
REQ-TC-1 允许人工 Task 仅文本契约，其 acceptance_criteria[] 可为空集。此时 REQ-ACC-2 的一致性规则中"全部 passed"与"全部 failed"同时真空成立，顶层 verdict 应判 accepted 还是 rejected 无唯一口径，覆盖完整性校验亦恒真。G 系列用例均用结构化判据，不影响 K0 退出门，但实现者会各自发明口径。改法：补一句"acceptance_criteria 为空时，顶层 verdict 由 acceptor 直接给出、一致性与覆盖校验不适用"。

**R3-P2-3 §2.4 ActorProfile / §5.2 REQ-ASG-1 — actor 停用无事件与入口定义**
REQ-ASG-1 把"actor 被停用"列为 AssignmentEnded 的触发者之一，但 ActorProfile.active 的变更（由谁、以何入口、是否留痕）在 spec 中无定义，事件目录亦无对应事件。此点不与 §4 派生规则声明字面矛盾（该声明的覆盖清单未含 ActorProfile），但停用这一管理动作的审计留痕缺位，实现期易被随意处理。改法：补 ActorProfile 变更的管理入口与事件（或声明"停用走 PolicyUpdated 同级的管理事件并留痕"），与 AssignmentEnded 触发链对齐。

**R3-P2-4 §3.1 矩阵 / §8 G4 — partially 后同 Task 再执行的触发机制未写**
§3.1 矩阵允许 awaiting_acceptance → active（partially_accepted 且未过判据需再执行），但 Run 的产生路径只有 REQ-SCH-1 的 ready 判定（限 lifecycle=defined）与 G4 写明的"经 PlanChange add_task 新建补充 Task"一条；同一 Task 直接新建 Run 补未过判据由谁、以何 op 触发，两条补救路径（同 Task 再执行 / 新建补充 Task）的选用条件均未写。G4 主路径已可判定、K0 退出门不受影响，故列 P2。改法：二选一写明——或删矩阵该触发注、统一走补充 Task 路径；或补同 Task 再执行的 PlanChange op 与触发者定义。

| 条目 | 分流 | 理由（一句） |
|---|---|---|
| R3-P2-1 | run（冻结后） | 补 C1c/C1d 用例并修正 C1b 注文，属测试覆盖补全，行为语义不动 |
| R3-P2-2 | run（冻结后） | 补空判据集的校验不适用声明，一句级修订 |
| R3-P2-3 | run（冻结后） | 补 actor 停用的管理入口/事件声明，管理面留痕补漏 |
| R3-P2-4 | run（冻结后） | 二选一写明 partially 补救路径，同 Task 再执行与补充 Task 不再并存含糊 |

---

## 第四部分 · 冻结后修订候选清单

以下 4 条即第三部分 R3-P2-1..4，随 spec 冻结后的 v1.1 修订或实现期补测一并处理，**不阻塞本次冻结**：

1. **R3-P2-1**：补 C1c（已启动 L0/L1 无副作用记录 → failed(lease_expired)）与 C1d（run_timeout 两支）用例；C1b 注文改"覆盖已启动/未启动二分"。
2. **R3-P2-2**：REQ-ACC-2 补空 acceptance_criteria 时一致性/覆盖校验不适用的声明。
3. **R3-P2-3**：补 ActorProfile 停用的管理入口与事件留痕定义。
4. **R3-P2-4**：写明 partially_accepted 后的补救路径选用（同 Task 再执行 vs 新建补充 Task）。

---

*报告完：第三轮 Verdict = APPROVED；第二轮 13 项验收：已解决 13、部分解决 0、未解决 0；新问题 P0 0 条、P1 0 条、P2 4 条（全部列入冻结后修订候选，不阻塞冻结）。*
