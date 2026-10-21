# 续行 K0 领域 Spec — Contract Review 第二轮报告

**评审对象**：`spec/K0-SPEC.md` v0.2（文首标注"待 contract-review 第二轮"）
**对照材料**：第一轮报告 `spec/K0-CONTRACT-REVIEW.md`、`docs/DECISIONS.md` 裁决 S1–S7、v0.1 原稿 `spec/K0-SPEC-v0.1.md`、蓝图 v1.0 §4/§7/§8
**评审性质**：独立第二轮 contract-review，只审 spec 本身，不写实现、不改 spec。本轮评审员与作者、第一轮评审员、修订执行者均非同一上下文。

---

## Verdict

**CHANGES_REQUESTED** — 第一轮 20 条中 19 条已解决、1 条部分解决（P0-4），修订忠实于 S1–S7、与 v0.1 对照主干未走样；但修订新内容自身产生 4 条新 P1（含 C1 与 REQ-RUN-4 的字面冲突、人工置位 wait_state 仍无事件源），且 §9.1"无新开放问题"声明不成立，冻结前需一轮小修。

---

## 第一部分 · 第一轮 20 条逐条验收

口径：**已解决** = 改法完整落地且可判定；**部分解决** = 主体落地但残余缺口未闭；**未解决** = 未落地或走样。证据章节均指 v0.2 正文。

| 条目 | 结论 | 证据与核查 |
|---|---|---|
| P0-1 | 已解决 | §3.2 REQ-RUN-6 三步写死：①记取消意图（`TaskCancelRequested` + `cancel_requested_at`，§2.2 已补字段；冻结新派发；pending Decision 置 expired、Assignment 置 ended）；②未启动 Run 直接 canceled，running 经 Executor 取消确认、默认 60s 未确认/失联转 indeterminate 走 REQ-RUN-3，Task 不先行 canceled；③全部 Run 终态后才 `TaskCanceled` 并收尾 WaitCondition。`human_light` 直接 canceled。R1 要求二选一已选定且可判定 |
| P0-2 | 已解决 | §2.6 REQ-ACC-1 改跨 rev 有效，唯一例外 = 新契约 `declares_revalidation`（§2.2 契约字段）触发 `AcceptanceSuperseded`（原因 `revalidation_required`）回 awaiting_acceptance；§3.1 矩阵 accepted 出边已含 supersede 与重验两触发，三方一致。新增 REQ-ACC-5 逐态传播（ready→defined / active 续跑+Decision / awaiting 维持+提示 / accepted 不回滚挂 Decision），与 S1 一致 |
| P0-3 | 已解决 | §2.6 Acceptance 增 `criterion_results[]`（`criterion_ref` 锚 §2.2 契约稳定 ref），REQ-ACC-2 增顶层 verdict 与逐项一致性校验、不一致不入账；REQ-ACC-3 补 partially 落点（停 awaiting_acceptance、待补集 = failed 项、已过判据继承锁定，S4）；§8 G4 指明"重开" = PlanChange `add_task` 新建补充 Task。残余校验缺口见新 P1-1 |
| P0-4 | 部分解决 | §4 目录补入 12 个事件并加派生规则声明，R1 点名的六处缺口（Task 取消 / 生命周期迁移 / Goal 状态 / WaitCondition canceled / needs_decision / 解析失败 / 疑似标记）均有事件源。残余：§3.1 允许"人工直接置位 blocked/on_hold 不经 WaitCondition"，此路径的 wait_state 变更无任何事件源，与 §4"每次状态变更必有上表对应事件为源"的声明相抵，C5 在该路径不可判定 → 新 P1-2 |
| P0-5 | 已解决 | §2.3 TaskEdge 增 `release_override` 字段（仅 depends_on 边）；§5.2 REQ-SCH-5 四项硬条件齐备：绑 `upstream_contract_rev` / 人类-only + 理由必填 + `ReleaseOverrideSet` 事件 / 失效三条件 + `ReleaseOverrideInvalidated` / 上游 rejected 时下游逐态处置；并明示不影响 `data_from` 判定。与 S2 一致 |
| P0-6 | 已解决 | §5.7 REQ-HUM-1/2/3 + §2.4 `human_light`：人类尝试建轻量 Run（无租约/心跳、永不 indeterminate/timed_out）；绑定 Feedback→Outcome→Run succeeded→Task awaiting_acceptance 路径唯一；跟进产生唯一路径 = Interpreter 提议 PlanChange → Policy 判定（REQ-HUM-3）；§8 G1 已按该序列重写为唯一断言。与 S3 一致。残余两处未明示见新 P2-4 |
| P1-1 | 已解决 | §2.7 `risk_level` 取副作用分级枚举 {L0,L1,L2,L3}；§5.1 REQ-PC-1 明示与 `auto_apply_ceiling` 同量纲按序比较、不另设映射表 |
| P1-2 | 已解决 | §3.1 补 kind→wait_state 映射表（device→blocked，设备标识入 target_ref）；INV-11 改为同事务自动收尾、不拒绝迁移、附可判定验收断言 |
| P1-3 | 已解决 | §2.2 契约增 `run_timeout`（自 RunStarted 起算）；§3.2 REQ-RUN-4 以（是否已启动、副作用级、副作用调用记录）三因素写死过期分界与 timed_out 来源 |
| P1-4 | 已解决 | §3.2 REQ-RUN-1 明示心跳非领域事件、不入 seq/哈希链；§4 目录已无 RunHeartbeat；§7 量级注记含 4.6 万条/天的排除算术 |
| P1-5 | 已解决 | §4 定 stream 粒度 = Project（stream_id = project_id）、增 `global_seq` 全序锚点；INV-12 改为投影按 global_seq 重演 |
| P1-6 | 已解决 | §2.2 Task 增 `duplicate_suspect` 字段且与 wait_state 正交；§5.3 REQ-DD-2 补标记/解除事件与合并（级联 canceled）/放行两条出路；REQ-SCH-1 已含该判定项 |
| P1-7 | 已解决 | §2.6 Acceptance 增 `subject_outcome_id`；§2.5 Outcome 不可变、id 即版本身份；§2.3 `pinned_version` 改封闭联合；§2.5 Artifact.version 递增规则与产生者写明；§5.2 REQ-SCH-2 指针主语改沿 data_from 边取上游，`LatestAcceptedPointerMoved` 带 from/to |
| P1-8 | 已解决 | §2.4 增 ActorProfile 最小能力定义；§5.2 REQ-SCH-4 能力匹配进 ready 公式（无可用执行者停 defined + `no_capable_actor` 区分展示）；REQ-ASG-1 写死 Assignment 仅两条产生路径 + INV-14 至多一个 active + 结束时在跑 Run 归属不变。取 R1 改法二选一中的前者，已写死 |
| P1-9 | 已解决 | §5.1 REQ-PC-5 五种裁决出路全写死（approved 重走完整校验 / approved_modified 新建 Change 并 supersede / rejected / deferred 必带唤起条件 / expired 置 rejected），与 REQ-PC-3 新增原因码对齐，状态流转走 `PlanChangeStatusChanged` |
| P1-10 | 已解决 | §5.1 REQ-PC-6 定义 Run/Change 两级记账形态且预算关口恒通过；REQ-PC-3 删除 `budget_exceeded` 并注明 K1 随拦截引入；§2.7 Policy 表述同步 |
| P2-1 | 已解决（drop 顺带） | §2.5 Evidence 定义处写明 `verification_status` 在 K0 仅信息标注、不参与 Acceptance/Scheduler 任何判定，迁移规则留待 K1 — 与 R1 建议一致 |
| P2-2 | 已解决 | §2.3 INV-2 增声明：`conflicts_with`/`supersedes` 为纯记录语义，前者不阻止派发不产生提示，后者不自动取消、须与 `cancel_task` op 组合，禁止实现自创调度行为 |
| P2-3 | 已解决 | §5.5 REQ-CX-1 改为确定性摘录（原文前 512 字符 + `raw_result_ref` + `content_hash` 成对、标注产生者 = 内核组装器），模型摘要明确不进 K0 快照、留待 K1 |
| P2-4 | 已解决（drop 顺带） | §2.7 PlanChange 增 `client_proposal_id` 及 `(project_id, proposer_id, client_proposal_id)` 唯一约束；§5.1 REQ-PC-1 幂等统一以该键，旧 `proposal_id` 表述已清除 |

**第一部分小结**：已解决 19 条 / 部分解决 1 条（P0-4）/ 未解决 0 条。§10 修订记录与正文落点逐条核对基本属实（一处章节标注偏差见新 P2-7）；与 v0.1 对照，四分关系、快照不可变、PlanChange 原子性、对账三结论等主干语义未走样，新增内容均可溯源至 R1 条目或 S1–S7 裁决；与蓝图 §7/§8 对照未发现新冲突。

---

## 第二部分 · 全文复审新问题

新 P0：**无**。新 P1：4 条。新 P2：8 条（见后）。

**新 P1-1 §2.6 REQ-ACC-2 / REQ-ACC-3 — `criterion_results` 覆盖完整性与继承锁定均无内核入账校验**
REQ-ACC-2 只校验"已列出的逐项结果与顶层 verdict 一致"，未要求契约 `acceptance_criteria[]` 的每个 `criterion_ref` 必须在 `criterion_results` 中出现——验收者遗漏一条 failed 判据、只列 passed 项，即可拼出通过一致性校验的 `accepted`，G4 的判据级断言可被不完整 Acceptance 绕过。REQ-ACC-3 的继承锁定只有"默认沿用""不得无故重验回退"的 actor 侧表述，没有写内核在新 Acceptance 入账时比对先前已 passed 判据、无 supersede + 新证据时拒绝其回退的校验规则，"锁定"不可判定。
改法：REQ-ACC-2 加入账校验两条——①覆盖完整性（契约全部 criterion_ref 必须出现，缺项不入账）；②继承锁定校验（已 passed 判据在后续 Acceptance 中被置 failed/not_applicable 且该 Acceptance 未 supersede 先前记录或未附新证据 → 不入账）。

**新 P1-2 §4 派生规则声明 / §3.1 — 人工置位 wait_state 无事件源（P0-4 残余）**
§3.1 明示"人工直接置位 `blocked`/`on_hold` 不经 WaitCondition"，但 §4 事件目录没有任何事件承载这类变更，派生规则声明也只逐项点名了 lifecycle、Goal、Feedback、PlanChange、WaitCondition、疑似标记，未包含 wait_state 人工置位。后果与 P0-4 原问题同构：投影重演时该 wait_state 值无源可溯，C5"逐字段 diff 为零"在此路径不可判定，§4"不存在无事件的状态变更"的总声明在此为假。
改法：二选一写死——增 `TaskWaitStateChanged` 事件（payload 带 from/to 与置位 actor/原因），或明示 `TaskLifecycleChanged` 同时承载 wait_state 的 from/to 并把该句写进派生规则声明。

**新 P1-3 §5.7 REQ-HUM-2 / §2.5 / §2.6 REQ-ACC-3 — 游离 Feedback 是否生成 Outcome 未写死，与重算规则潜在冲突**
REQ-HUM-2 对无绑定 Feedback 只说"只入账并触发解释，不产生 Run、不迁移 Task 状态"。但 Outcome 模型留有 `feedback_id` 入口，REQ-OC-1 又只说 Outcome 由 Interpreter 提议经校验生成，未区分绑定/游离。若游离 Feedback 也生成 Outcome，则按 REQ-ACC-3"无有效 Acceptance 且已有 Outcome → awaiting_acceptance"，Task 状态必然被迁移，与 HUM-2 直接冲突；若不生成，"解释"的产物形态（仅 `interpretation_status` 流转？结构化摘录存于何处、后续如何被绑定）全未明示。两种读法实现分叉，验收无法写唯一断言。
改法：二选一写死。推荐前者：游离 Feedback 不生成 Outcome，其解释只更新 `interpretation_status` 并留待绑定摘录；Outcome 只由绑定 Run（executor 或 human_light）的 Feedback/RawResult 产生。若取后者，须在 REQ-ACC-3 为游离 Outcome 加显式例外条款。

**新 P1-4 §8.2 C1 / §3.2 REQ-RUN-4 — C1 场景字面与租约过期分界相抵**
C1 写"Executor 领取 Run 后杀进程 → 租约过期 → Run=indeterminate → 对账"。但按本轮新增的 REQ-RUN-4 封闭分界：leased 且未启动（无 `RunStarted`）的 Run 租约过期应回 `queued`，只有已启动且（`side_effect_level ∈ {L2,L3}` 或已有外部副作用调用记录）才转 indeterminate。C1 未注明这些前置条件，按字面执行（领取后、未启动即被杀）结论恰好相反，测试不可判定。这是修订新规则与未同步更新的旧验收用例之间的不一致。
改法：C1 补齐前置条件（Run 已启动 + 副作用级/记录满足 indeterminate 条件），或另加一条"leased 未启动被杀 → 回 queued"的对照用例，两条并存才算覆盖 REQ-RUN-4 全部分界。

### 新 P2（建议级，随下一轮修订顺带处理）

- **新 P2-1 §3.2 REQ-RUN-6**：取消级联步骤②只列 created/queued/leased/running，未覆盖取消请求到达时已处于 `indeterminate` 的 Run——其对账由谁推进、对账结论"无法确定"转 Decision 后 Task 的取消如何收场，均未写；步骤③"全部 Run 达终态"在该情形下可能永不满足而无出路说明。
- **新 P2-2 §5.2 REQ-SCH-5 ④**：上游最终 rejected 时下游逐态处置只写了"未启动 Run"与"已产生 Outcome"两态，缺下游 lifecycle=active 且 Run 已启动未出 Outcome 的落点（REQ-ACC-5 ②有对应规则，此处不对称）。
- **新 P2-3 §5.1 REQ-PC-5**：deferred 唤起后"回到 proposed 重走校验"未明示 base 口径；approved 路径已明示以裁决时刻当前 rev 为新 base，deferred 路径沉默——按原 `base_plan_rev` 重走必撞 `base_rev_conflict` 并循环产生新 Decision。
- **新 P2-4 §5.7 REQ-HUM-3 / §8 G1**：两处未明示——`add_edge` 未指定边 kind（part_of / depends_on 影响 F 与 T 的调度关系）；G1 第二次 Feedback 记在跟进 Task F 上，而对 T 的 Acceptance 的 `subject_outcome_id` 指向 F 的 Outcome 还是 T 的 Outcome，未写，G1 测试构造 Acceptance 时无唯一依据。
- **新 P2-5 §2.4 ActorProfile**：`environments[]` 无任何消费方——TaskContract 无 `required_environment` 字段，REQ-SCH-4 能力判定也不校验环境。该字段与 R1 的 P2-1 同类（死字段），但未像 P2-1 那样声明"仅信息标注"，实现者可能自行为其发明匹配行为。
- **新 P2-6 §2.5 Artifact / §2.3**：版本分组键未明示——"新版本产生新 Artifact 记录"与"`version` 按每个 Artifact 单调递增"之间，Artifact 的 `id` 是否跨版本稳定未写；`pinned_version` 的 `target_id` 以何为锚（逻辑 Artifact 还是某一版本记录）随之不唯一。
- **新 P2-7 §10 修订记录**：P1-2 一行标注改动章节为"§2.7（对象定义）"，实际落点（映射表与 INV-11）均在 §3.1，§2.7 本轮未因 P1-2 改动。属修订记录准确性问题，不影响正文语义，但审计链应更正。
- **新 P2-8 §5.1 REQ-PC-1 / §2.7**：量纲表述小不一致——REQ-PC-1 称 `risk_level` 与 `auto_apply_ceiling`"均取副作用分级枚举 {L0,L1,L2,L3}"，而 §2.7 Policy 定义 ceiling 取值域为 (L0|L1)。比较本身仍可判定，表述应改为 ceiling 是该枚举的子集，以免实现者放开 ceiling 到 L2/L3。

### §9 开放问题声明核查

§9 的 Q1–Q5 落点表逐条属实（S4→REQ-ACC-3/矩阵、S2→REQ-SCH-5、S5→INV-6/REQ-DT-1、S6→REQ-RUN-1、S7→REQ-OC-2 均已核对原文）。但 §9.1"本轮修订中未发现新的 load-bearing 开放问题"的声明**不成立**：新 P1-2、P1-3、P1-4 均源于或暴露于本轮新内容（REQ-RUN-4、REQ-HUM、§4 派生声明）。下一轮修订应撤回或改写 §9.1，并按修订纪律把本报告新 P1 登记为开放问题及裁决结果。

---

## TRIAGE（新问题分流）

| 条目 | 分流 | 理由（一句） |
|---|---|---|
| 新 P1-1 | run | 补 REQ-ACC-2 入账校验两条（覆盖完整性 + 继承锁定校验），路径唯一，修订轮直接执行 |
| 新 P1-2 | run | 补 wait_state 变更事件或收窄 §4 派生声明，二选一已列清，属 P0-4 残余收尾 |
| 新 P1-3 | run | 按推荐（游离 Feedback 不生成 Outcome）写死即可；若作者取另一读法则加 REQ-ACC-3 例外条款，二者不可并存 |
| 新 P1-4 | run | C1 补前置条件或加对照用例，纯文字修订 |
| 新 P2-1 ～ P2-8 | run | 均为声明/文字级补漏，随第三轮修订顺带落地，不单独立项 |

---

*报告完：第二轮 Verdict = CHANGES_REQUESTED；第一轮 20 条已解决 19、部分解决 1、未解决 0；新问题 P0 0 条、P1 4 条、P2 8 条。*
