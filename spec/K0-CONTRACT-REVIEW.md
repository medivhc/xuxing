# 续行 K0 领域 Spec — Contract Review 报告

**评审对象**：`spec/K0-SPEC.md` v0.1 草稿
**参照物**：产品蓝图 v1.0（§4/§7/§8）、《评审+技术方案 v1》§2、`docs/DECISIONS.md`（D1–D7 已定版）
**评审性质**：独立 contract-review，只审 spec 本身（完整性 / 可判定性 / 独立性 / 一致性），不审实现，不改 spec。

---

## Verdict

**CHANGES_REQUESTED** — 骨架与语义方向成立，但存在 6 条 P0：第一验收用例 G1 本身无法按现文无歧义实现（人类执行路径、跟进任务的产生权威未定义），且事件目录覆盖不了 spec 自己定义的迁移矩阵（Task 取消无事件源），冻结前必须修订。

总体判断：这份 spec 的可判定意识明显高于一般草稿（INV 多数带验收方式、量级假设标注为假设、开放问题集中在 §9 而非散落正文）。问题集中在**边角语义未闭合**而非主干错误：主干（四分关系、快照不可变、PlanChange 原子性、对账三结论）与蓝图 §7/§8、技术方案 §2、D1–D7 均一致，未发现方向性冲突。

---

## 问题清单

### P0（阻塞冻结）

**P0-1 §3.1 / §5（缺失）— 被取消 Task 的在跑 Run 处理只有悬空引用**
§3.1 矩阵 `active → canceled` 注明"须先处理在跑 Run，见 REQ-RUN-6"，但全文只有 REQ-RUN-1/2/3，**REQ-RUN-6 不存在**。连带未定义：`running` 的 Run 取消确认由谁给出、Executor 不确认/失联时取消是否转 `indeterminate`、queued/leased 的 Run 与 Assignment、该 Task 的 active WaitCondition、pending Decision 在取消时如何收尾。
改法：补 REQ-RUN-6（及必要的 REQ-TSK 取消条目）：明确取消顺序（先置 Task 取消意图 → 向 Run 发取消 → 确认后 Run=canceled；超时未确认 → Run=indeterminate 走 REQ-RUN-3 对账，Task 保持"取消中"还是先行 canceled 必须二选一写死）；同时定义 WaitCondition/Assignment/Decision 的级联收尾。

**P0-2 §2.6 REQ-ACC-1 vs REQ-ACC-3 — 契约换版后旧 Acceptance 的效力自相矛盾，且 supersede 无下游传播语义**
REQ-ACC-1 说达成判定"只认当前 contract_rev 对应的最新有效 Acceptance"；REQ-ACC-3 的重算规则却只说"最新有效 Acceptance（未被 supersede）"，没有 contract_rev 限定。按 ACC-1 字面：一次 `update_contract`（rev+1）会让已 accepted 的 Task 立刻失去有效验收、应跌回 `awaiting_acceptance`——但 §3.1 矩阵中 `accepted` 只有一条出边（supersede 触发），没有"契约换版"这条出边，两条 REQ 与矩阵三方对不上。另外 REQ-ACC-4 只要求在事件里记录"受影响的下游 Task 列表"，**没有定义影响本身**：靠该验收放行的下游 Task 若已 ready/active、甚至已产生 Run/Outcome，验收被推翻后是回退、冻结还是不管？只记名单不定义行为，等于没定义。
改法：二选一并写死——(a) contract rev 变更不影响旧 Acceptance 效力（删 ACC-1 中"只认当前 rev"的表述，改为"最新有效 Acceptance，跨 rev 有效，除非新契约显式声明需重验"）；或 (b) 换版即需重验（矩阵补 `accepted → awaiting_acceptance` 的契约换版触发，并说明在跑下游的处理）。同时补 supersede 传播 REQ：下游未启动 Run 的回退、已启动 Run 的继续/对账策略，逐态列明。

**P0-3 §2.6 / §3.1 / G4 — `partially_accepted` 没有数据表示，REQ-ACC-3 干脆没提这个 verdict**
Acceptance 只有单个 `verdict`，没有逐判据结果（criterion_results）。后果有二：① REQ-ACC-3 的重算规则只写了 accepted/rejected/无验收三种情况，`partially_accepted` 的落点仅靠 Q1 的默认假设口头存在，正文无条目；② G4 断言"未过判据只重开对应子 Task，已过判据不回退"——没有逐判据结果，这个断言**无法写成测试**（系统里没有任何字段能指出"哪条判据未过"）。
改法：Acceptance 增 `criterion_results[] { criterion_ref, verdict, evidence_refs[] }`；REQ-ACC-3 补 partially 的重算规则（与 Q1 裁决联动，见下）；G4 的"重开"指明走 PlanChange 的哪个 op。

**P0-4 §4 — 事件目录覆盖不了 spec 自己定义的迁移**
事件集自称封闭、且 INV-12 要求投影可由事件流重演，但下列迁移/状态在目录中**没有任何事件源**：
- Task 取消（矩阵中 5 个状态可 → canceled，却只有 `RunCanceled`、无 Task 级取消事件）——投影重演时 canceled 态无从产生，C5 必挂；
- Task 的 `defined → ready`、`ready → active`、`→ awaiting_acceptance` 等生命周期迁移（若意图是由 AcceptanceRecorded/RunStarted 等事件派生，必须明说派生规则；现文未说，C5 的"逐字段 diff 为零"无判定依据）；
- `Goal.status` 变更（只有 GoalCreated）、WaitCondition 的 canceled（有 `WaitConditionCreated/Satisfied/Expired`，独缺 Canceled，与其 status 枚举对不上）、PlanChange 置 `needs_decision`、Feedback 解析置 `failed`（interpretation_status 的 failed 态无事件）、REQ-DD-2 的疑似重复标记。
改法：二选一——补齐事件（TaskCanceled、TaskReady/或统一 TaskLifecycleChanged、WaitConditionCanceled、FeedbackInterpretationFailed 等），或在 §4 明确写出"哪些实体状态是派生而非事件、派生规则是什么"。封闭集声明保留，但封闭的是修订后的全集。

**P0-5 §5.2 REQ-SCH-1 / Q2 — `release_override` 被引用但不存在于模型中**
REQ-SCH-1 的 ready 判定依赖"Edge 上显式 `release_override` 由人类置位"，但 §2.3 TaskEdge 的字段清单里**没有这个字段**；§4 事件目录没有置位事件；没有定义置位 actor、理由、有效期（上游契约换版后 override 是否失效）、以及 override 放行的下游在其上游最终被 rejected 时的处置。Q2 默认假设说"进 K0"，但按现文这个机制不可实现、不可测。
改法：见 Q2 裁决——进 K0 可以，但必须同时补字段（挂 Edge、绑定上游 contract_rev）、事件、人类-only 约束与失效条件；补不齐就降为不进。

**P0-6 §2.4/§2.5 / G1 — 人类执行路径未定义，G1 无法无歧义实现**
G1 是第一 conformance，卻有三处无定义：① 人类执行者做一次"联系尝试"到底产不产生 Run？§2.4 的 Run 模型（lease/heartbeat/idempotency_key）是按 Executor 设计的，而 §2.5 又允许 Feedback 直接挂 task_id 且 Outcome 可只挂 feedback_id——两条路径并存，谁触发 `active → awaiting_acceptance`（矩阵注为"Run 出 Outcome"）在人类路径下无答案；② G1 断言 Task 进 `waiting_on_person` 后出现"恰一个跟进 Task"，这个跟进 Task 由谁产生——Outcome Interpreter 提议 PlanChange 经应用？还是内核按 WaitCondition 自动建？前者要过 `auto_apply_ceiling` 校验、后者绕过 PlanChange，两条路的事件序列完全不同，G1 无法写成唯一断言；③ G1 后段"系统提议的新 Task 以 PlanChange 呈现，未经应用不入图"与②若取自动路径直接冲突。
改法：在 §2.5 或 §5 增人类执行协议条目：明说人类动作是否建 Run（建议：建轻量 Run，无租约、心跳为 n/a，理由是四分关系与审计统一）；明说跟进 Task/WaitCondition 的产生路径唯一化（建议：Interpreter 提议 → PlanChange → 按 Policy 判定自动应用或 Decision，全程与 G1 的事件断言对齐重写）。

### P1（应改，不改会在实现期返工或产生不可判定验收）

**P1-1 §5.1 REQ-PC-1 — `risk_level` 无枚举，"风险级 ≤ auto_apply_ceiling"不可判定**
PlanChange 的 `risk_level` 没有取值定义；Policy 的 `auto_apply_ceiling` 是 `L0|L1`。两个不同量纲如何比较没有映射表。改法：`risk_level` 直接复用副作用分级枚举（L0/L1/L2/L3），或给出 risk_level → L 级的封闭映射。

**P1-2 §2.7 / §3.1 — WaitCondition 的 `device` 类没有对应的 wait_state；INV-11 的"强制校验"语义含糊**
WaitCondition.kind 有 `device`，wait_state 枚举（person/until/dependency/blocked/on_hold）没有 device 的落点，映射表缺失。另外 INV-11 说 `accepted/canceled` 时 wait_state 必须为 none 且"迁移时内核强制校验"——是**拒绝**迁移还是**自动清零**？若拒绝：G1 中 Task 处于 `waiting_on_person`、WaitCondition 尚 active 时，第二次反馈的验收 accepted 将被卡住，先后顺序无定义。改法：补 kind → wait_state 映射表；INV-11 改为可判定表述（如"终态迁移自动把 active WaitCondition 置 canceled 并发事件，wait_state 归 none"，或明确前置条件由调用方先满足并给事件顺序）。

**P1-3 §3.2 — `timed_out` 没有超时来源；leased 过期回 queued 与转 indeterminate 的分界不可判定**
Run/Contract 里没有 `run_timeout` 字段，`running → timed_out` 的"超时"无从计时。另：leased 租约过期可回 `queued`（未启动）也可转 `indeterminate`（"已可能产生副作用"），分界标准没给（技术方案 §2.5 的口径是副作用级 ≥L2 才进 indeterminate，spec 未吸收）。改法：TaskContract 或 Run 创建参数增 `run_timeout`；分界写死为按 `side_effect_level` 的封闭规则。

**P1-4 §3.2 REQ-RUN-1 / §4 / §7 — RunHeartbeat 进事件流与量级假设冲突**
心跳 15s 一次、并发 Run ≤ 8，全量入哈希链事件流：仅心跳约 8×4×60×24 ≈ 4.6 万条/天，§7"事件总量 ≤ 50 万/年"的假设一周内被心跳击穿；且 C5 重演要逐条回放无业务语义的心跳。改法：明确心跳不是领域事件（只更新 Run 行 + 可选节流采样），或心跳事件不入 seq/哈希链并声明投影重演时忽略。

**P1-5 §4 INV-12 — `stream_id` 的聚合粒度未定义，C5 的确定性重演缺全局序**
INV-12 只保证"同 stream 内 seq 递增"，但 stream 是 Project、Task 还是全局，未定义；跨 stream 事件的全局顺序（投影重演的交错顺序）没有锚点（recorded_at 精度不足以作全序）。改法：定义 stream 粒度，并指定全局序来源（如单调全局序号列），C5 才可判定。

**P1-6 §5.3 REQ-DD-2 — `duplicate_suspect` 在 Task 模型里没有落点**
Task 字段清单无此标记字段；"挂起（不进 ready）"靠什么机制实现未说（借 wait_state=on_hold？独立 flag？）；标记/解除的事件缺失（见 P0-4）。Decision 的产生时机（二选一的"合并或放行"裁决后 Task 如何恢复）也没写完。改法：Task 增字段（或明确借用 wait 维度并写清与 INV-11 的关系），补标记产生与 Decision 裁决后的两条出路。

**P1-7 §5.2 REQ-SCH-2 / §2.3 — `latest_accepted` 指针主语含糊；Outcome 没有版本号，`pinned` 指不
...[truncated 6531 chars]
<!-- 补全轮次：原报告在此处截断，以下 P1-7 起为补全评审，与前文同一评审标准 -->

**P1-7 §5.2 REQ-SCH-2 / §2.3 — `latest_accepted` 指针主语含糊；Outcome 没有版本号，`pinned` 指不到对象**
REQ-SCH-2 定义指针为"该 Task 最新有效 Acceptance 对应 Outcome/Artifact"，但主语含糊：`data_from` 边连接上游 `from_task` 与下游 `to_task`，指针理应指上游，现文也可读成下游自身的验收，下游尚未执行哪来已验收结果，两种读法写出的 ready 判定完全不同。更深一层，这个"对应"在模型里根本不存在：Acceptance（§2.6）字段只有 `task_id / contract_rev / evidence_refs[]`，**没有指向 Outcome 或 Run 的字段**；一个 Task 有多个 Run、多份 Outcome 时，"最新有效 Acceptance 对应哪份 Outcome"无从计算。再看 `pinned`：§2.3 要求 `pinned_version` 指向"具体 Outcome/Artifact 版本"，但 Outcome（§2.5）**没有 version 字段**，也未声明 Outcome 不可变、以 id 为版本身份；Artifact 虽有 `version`，却没有递增规则与产生者。于是两种 `data_mode` 一个算不出、一个指不到。
改法：① Acceptance 增 `subject_outcome_id`（验收对象显式化，多 Run 时不靠时间猜）；② REQ-SCH-2 重写为"沿 `data_from` 边取 `from_task` 最新有效 Acceptance 的 `subject_outcome_id` 及其产物"，指针移动事件 payload 带 from/to 目标 id；③ `pinned_version` 改为封闭联合 `{ target_kind: outcome|artifact, target_id, artifact_version? }`，并声明 Outcome 不可变、id 即版本身份，新解释产生新 Outcome 记录而非原地修改。
**P1-8 §5.2 REQ-SCH-1 / §2.2 REQ-TC-1 / §2.4 — ready 判定不含能力匹配，Assignment 的产生规则整段缺失**
TaskContract 有 `required_capabilities[]`，REQ-TC-1 还把结构化契约设为 Agent 派发的前置门，但 REQ-SCH-1 的 ready 公式里既没有能力匹配项，也没有任何执行者可用性条件；`assignee_hint` 只是"hint"，由谁、在何时把 hint 变成正式 Assignment，全文没有条目：PlanChange 的 `reassign` op 能改派，但初始 Assignment 的产生者（Scheduler 自动？人类指定？Planner 提议经 PlanChange？）未定义；"同一 Task 同时至多一个 active Assignment"这样的基本不变量也不存在，`AssignmentEnded` 的触发者与触发条件同样空白。后果可判定地坏：一个没有任何在册执行者具备所需能力的 Task 会正常进入 `ready`，投影 `available_actions` 与 MyActions 都会把它当作可执行事项呈现，直到派发那一刻才无路可走——而 spec 没有定义派发失败的落点状态。
改法：补 REQ-SCH-4 与 REQ-ASG-1：明确 Assignment 唯一产生路径与 actor、同一 Task 至多一个 active Assignment 的不变量、Assignment 结束/改派时在跑 Run 的归属；能力匹配的位置二选一写死——进 ready 公式（无可用执行者则不 ready，并给出可区分的 wait/能力缺失落点），或保留 ready 纯计划语义、另设派发阶段的封闭失败原因码并在投影中区分"就绪待派发"与"无执行者"。

**P1-9 §5.1 REQ-PC-3 / §2.7 — PlanChange 置 `needs_decision` 后没有回路：Decision 裁决完，Change 去哪**
REQ-PC-3 只定义了校验不过时"产生 Decision 并置 `needs_decision`"，但 PlanChange 的 status 枚举（proposed|applied|rejected|needs_decision）在此之后没有出路：Decision 被 `approved` 后，是原 Change 直接应用、还是必须重走一遍六道校验流水线？若重走，此时 `base_plan_rev` 大概率已前进（等待裁决期间图可被其他 Change 修改），按 REQ-PC-1 应判 `base_rev_conflict`——那"批准"到底批准了什么？`approved_modified` 更悬空：修改由谁以什么形态落地（原 Change 原地改 ops 会破坏提议留痕；生成新 Change 又与旧 Change 的 supersede 关系未定义）；`deferred` 之后靠什么重新唤起、Decision `expired` 后 Change 是永久搁置还是转 rejected，也全无条目。结果是 K0 第一条人机裁决闭环在 spec 层断裂，验收侧无法对"批准一个超限 PlanChange 后图最终如何变化"写出唯一断言。
改法：补 REQ-PC-5 写死回路：`approved` → 原 Change 以裁决时刻的当前 rev 重走完整校验，通过才应用、不过则生成新的版本冲突 Decision（不许跳过校验直接应用）；`approved_modified` → 禁止原地改 ops，由裁决者提交新 Change（新 id、`supersedes_change_id` 指向旧 Change），旧 Change 置 rejected 并注明原因码 `superseded_by_decision`；`deferred` 必须带重新唤起条件（时间或事件）；`expired` → Change 置 rejected、原因码 `decision_expired`，与 REQ-DC-1"过期不等于批准"对齐。

**P1-10 §2.7 Policy / §5.1 REQ-PC-1、REQ-PC-3 — 预算在 K0"只记录不拦截"，流水线却备有 `budget_exceeded` 拒绝码，这一关不可判定**
三处表述互相打架：§2.7 说 `budget_cap` "K0 仅记录不拦截，拦截在 K1"；REQ-PC-1 把预算列为校验流水线一环又注明"占位（K0 仅记录）"；REQ-PC-3 的封闭原因码里却有 `budget_exceeded`，且按其分类预算超限不属于"可由人裁决"类，而是走 `rejected` 的结构错误类。于是实现者无从判定：预算超限的 PlanChange 在 K0 到底是照常应用只记账、还是以 `budget_exceeded` 被拒？若永远不触发，这个原因码就是死代码，测试无法覆盖；若会触发，则与 §2.7 的定版表述（与 DECISIONS 中预算账本 K1 拦截的方向）直接冲突。另外"仅记录"的记录形态也没定义：记在 PlanChange 上、Run 上还是独立账本条目，K1 接拦截时靠什么数据回溯，同样空白。
改法：二选一写死，建议取前者——K0 预算关口恒通过、只记账，从 REQ-PC-3 原因码中删除 `budget_exceeded` 并注明 K1 随拦截一并引入；同时定义记账最小形态（每次 Run 与每次已应用 Change 的预估/实际消耗落账到 Run 与 Project 两级）。若坚持 K0 即拦截，则删 §2.7"不拦截"表述并补超限时的裁决分类，二者不可并存。

### P2（建议级，可随修订轮顺带处理或明确延后）

**P2-1 §2.5 — Evidence 的 `verification_status` 没有迁移规则，也没有任何 REQ 消费它**
`unverified|verified|refuted` 三态只有枚举：谁有权置 verified/refuted、依据什么、置 refuted 与 `supersedes_id` 纠错是什么关系，全无条目；Acceptance 与 Scheduler 的判定条件里也从未引用该字段。死字段的危险在于实现者会各自猜测它是否影响验收。建议：K0 在 spec 中一句话写死"该字段仅作信息标注，不参与 Acceptance/Scheduler 判定"，迁移规则留待 K1 证据治理时再立；或者干脆给出最小迁移（人类或独立评审 actor 可置，附理由入事件）——但不要保持现在的悬空状态。

**P2-2 §2.3 — `conflicts_with` 与 `supersedes` 两类边只有枚举、没有行为，也没有"无行为"的声明**
INV-2 只说其余 kind"不影响调度"，于是两条 `conflicts_with` 的 Task 可以被同时派发且系统连提示都没有，与蓝图 §7.5"互斥或争议关系，需协调"的语义落差未被声明为 K0 有意取舍；`supersedes` 与 PlanChange 的 `cancel_task` op、被替代 Task 的生命周期之间是什么关系（建 supersedes 边是否自动取消旧 Task）也未写。建议：K0 明确两类边均为纯记录/展示语义，`supersedes` 不自动触发取消、需与 `cancel_task` 组合使用，并把这句写进 INV-2 的注脚，避免实现期有人替它发明调度行为。

**P2-3 §5.5 REQ-CX-1 — 历史 Run"RawResult 摘要"的产生者与口径未定义，摘要本身无出处**
REQ-CX-1 要求快照纳入"最近 3 个历史 Run 的 RawResult 摘要"，但摘要由谁生成没写：内核确定性截断、Outcome Interpreter 提议、还是 Executor 自带？摘要既不是 Evidence 也不是 Artifact，没有原文引用要求；若由模型生成，摘要的错误会静默进入后续 Run 的输入快照，与 REQ-CX-2"事后可复盘 Agent 当时看到了什么"的立意相悖——复盘时分不清 Agent 看错的是原文还是摘要。建议：K0 规定快照中摘要必须与 `raw_result_ref` 成对出现并标注产生者与版本，或 K0 干脆只放确定性摘录（原文前 N 字符 + 全文引用），模型摘要留待 K1 上下文裁剪时连同评测一起引入。

**P2-4 §5.1 REQ-PC-1 — 幂等条款用的 `proposal_id` 在 PlanChange 模型里不存在**
PlanChange 字段是 `id` 与 `proposer_id`，REQ-PC-1 的幂等却写"同 `proposal_id` 重放返回首次结果"。若 `proposal_id` 就是服务端 `id`，重放方在首次提交前无从持有该 id，幂等无从谈起；若它是提议方生成的客户端提交键，则模型缺该字段、缺唯一性作用域（全局唯一还是 per-proposer 唯一）定义。建议：统一术语——客户端幂等键单列字段 `client_proposal_id`，唯一约束 `(project_id, proposer_id, client_proposal_id)`，服务端 `id` 与之分开；这纯属文字与字段对齐，修订轮顺带处理即可。

---

## TRIAGE（分流表）

分流口径：`decision` → 上看板待决策（本报告已附推荐，见条目改法与 Q1–Q5 裁决）；`run` → 建 spec 修订任务（runs/ TASK.md stub）待排期执行；`drop` → 本轮不处理，理由写明。

| 条目 | 分流 | 理由（一句） |
|---|---|---|
| P0-1 | run | 改法已明确（补 REQ-RUN-6 与级联收尾），修订轮直接执行，冻结前必落地 |
| P0-2 | decision | 契约换版后旧 Acceptance 效力是语义二选一，推荐取 (a) 跨 rev 有效，裁定后连同 supersede 传播规则一并修订 |
| P0-3 | run | 补 `criterion_results[]` 与 partially 重算规则路径唯一，落点随 Q1 裁决写入 |
| P0-4 | run | 补齐事件或写明派生规则，两条路都已列清，修订轮执行即可 |
| P0-5 | decision | `release_override` 进不进 K0 由 Q2 裁决（推荐进、附四项条件），裁定后转 run 修订 |
| P0-6 | decision | 人类动作是否建 Run 是领域根决策，推荐建轻量 Run，确认后按其重写 G1 事件断言 |
| P1-1 | run | `risk_level` 对齐副作用分级枚举，纯字段修订 |
| P1-2 | run | 补 kind→wait_state 映射与 INV-11 可判定表述，路径明确 |
| P1-3 | run | 补 `run_timeout` 与按副作用级的过期分界，默认值细节随 Q4 一并定 |
| P1-4 | run | 心跳移出领域事件流是量级算术结论，无需再议 |
| P1-5 | run | 补 stream 粒度与全局序来源，C5 可判定性依赖它 |
| P1-6 | run | 补 `duplicate_suspect` 落点字段与裁决后两条出路，路径明确 |
| P1-7 | run | 补 Acceptance 验收对象字段并重写指针定义，属模型修订 |
| P1-8 | run | 补 Assignment 产生规则与能力匹配落点，Scheduler 完整性依赖它 |
| P1-9 | run | 补 Decision 裁决后 PlanChange 回路（REQ-PC-5），改法已写死可直接修订 |
| P1-10 | run | 删 K0 `budget_exceeded` 死代码并定义记账形态，按推荐的前者执行 |
| P2-1 | drop | K0 判定链不消费 `verification_status`，只需在修订时补一句"仅信息标注"声明，迁移规则留待 K1 证据治理再立项 |
| P2-2 | run | 两类边"纯记录语义"是一句声明级修订，顺带落地防实现期各自发明行为 |
| P2-3 | run | 摘要出处要求（与原文引用成对）属快照可复盘性底线，随修订轮一并写入 REQ-CX-1 |
| P2-4 | drop | 纯术语/字段命名对齐，无独立语义缺口，不单独立项，随修订轮文字对齐时顺带处理 |

---

## 开放问题 Q1–Q5 推荐裁决

**Q1（`partially_accepted` 的 lifecycle 落点）— 推荐：采纳默认假设，停在 `awaiting_acceptance`，附两条修正。**
理由：partially 意味着判据部分达成，既不能算 accepted，也不能视同 rejected 全量重跑；停在 `awaiting_acceptance` 保住"尚未达成"的真实状态，回到 active 则会让 Scheduler 误以为可常规派发、且丢失"哪些判据已过"的语境。修正一：§3.1 矩阵 `awaiting_acceptance → active` 的触发标注扩为"验收 rejected，或 partially 且未过判据需再执行"，再执行范围由 P0-3 要求补的 `criterion_results` 未过项决定，而不是整个 Task 重跑。修正二：已通过的判据在后续 Acceptance 中默认继承锁定，不得无故重验回退，推翻只能走 supersede 显式声明——G4 的"已过判据不回退"靠这一条才可判定。

**Q2（`release_override` 是否进 K0）— 推荐：进 K0，附四项硬条件；补不齐则降级不进，不许带病冻结。**
理由：D4 的真实负载是调研类长链，上游验收常卡在人工或独立评审这类慢变量上；没有受控的先行放行，整条链会堵在 awaiting，用户最终会绕到系统外口头放行，反而丢了留痕——留一个有审计的后门好过逼出一个没审计的正门。四项条件（与 P0-5 联动）：字段挂在 Edge 上并绑定上游 `contract_rev`，上游契约换版自动失效；仅人类 actor 可置位、理由必填、走事件；置位与失效都产生事件进哈希链；被 override 放行的下游在其上游最终 rejected 时，未启动的 Run 回退 `defined`、已产生 Outcome 的置 blocked 并产生 Decision，不自动回滚已发生事实。

**Q3（Tool Gateway 形态与双轨 Evidence 来源等级）— 推荐：采纳默认假设，K0 做内核模块 + 专用凭据；双轨导入的 Evidence 一律降级为 `external_doc`。**
理由：K0 是单用户、单机量级（spec §7），独立服务只增加部署与对账成本而不增加任何判定能力；INV-6 的验收标准是"Agent 凭据写 `tool_output` 必须失败"，模块 + 独立 DB 角色/凭据已等价满足，模块边界（专用凭据 + 审计事件）就是 K1 抽成独立服务时的现成接缝，不欠债。导入器不发网关凭据：pipeline 阶段产物虽源自真实工具输出，但经导入器转手后已是二手材料，给 `tool_output` 等级等于撑大网关凭据的持有面、且污染来源等级的语义（C6 的拦截就失去意义）；以 `external_doc` + `content_hash` 入账、来源说明注明原始 run/phase 与文件路径，对双轨对照的用途已经足够。

**Q4（租约/心跳默认值对 CLI 型 Agent 是否成立）— 推荐：采纳"适配器代发心跳"，附一条硬条件：心跳必须绑定被包裹子进程的存活探针，不许无条件定时代发。**
理由：CLI 型 Agent 单次运行数小时、协议内无心跳是事实，内核若只认原生心跳，长 Run 会被系统性误判 indeterminate，租约机制反而成为故障源；适配器包裹层代发是唯一现实解。但无条件代发的心跳只证明"看守还在"，不证明"执行者还活着"——子进程已死而包裹层照发心跳，会把 indeterminate/对账机制整个架空，这是我们在线上吃过的"进程假活、看门狗报成功"的同构错误，不能在新系统里复刻。条件：子进程退出或探针失联即刻停发心跳、任租约过期走 REQ-RUN-3 对账；适配器无法做存活探针的执行类型须在能力声明中标注，此类 Run 的租约策略（延长租约或派发时人工确认）在实现前二选一写进适配器契约。在此前提下 15s/45s 默认值可保留。

**Q5（Outcome `dimensions` 封闭维度集是否够用）— 推荐：采纳默认假设，K0 维持封闭集、扩维走 spec 修订，附一条护栏与一个复议触发点。**
理由：`dimensions` 是 Outcome Interpreter 提议与内核校验之间的契约面，一旦开放自由维度，下游所有判定（Acceptance、Scheduler、统计口径）都失去可判定性，封闭的代价（个别信息没处放）远小于开放的代价（处处靠解析文本猜语义）；现有六维对沟通类（G1）与调研类（G3）已经够用，没有证据表明还缺维度。护栏：内核与 Scheduler 的任何判定**不得解析 `blockers` / `followup_suggestions` 的文本得出结论**，这两项只供人阅读与 Planner 参考——默认假设里担心的"Interpreter 把信息塞进文本污染判定"，靠这条从机制上堵死，而不是靠提示词自觉。复议触发点：K0 退出评审时，以双轨对照（REQ-DT-2）与 Golden Scenarios 执行中积累的"维度不足清单"为唯一扩维依据，有真实条目证明某类任务无法表达，才在 v1.1 修订中扩，单次扩维须同时给出存量 Outcome 的迁移说明；无证据不预防性扩维。
