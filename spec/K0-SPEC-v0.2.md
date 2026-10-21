# 续行 K0 领域 Spec v0.2（草稿 · 待 contract-review 第二轮）

**范围声明**：本文只定义 K0 脊柱的可判定行为，是 K0 实现的判卷标准。产品目标态见蓝图 v1.0；架构与协议依据见《评审+技术方案 v1》§2；已定版决策 D1–D7 与 K0 spec 裁决 S1–S7 见 `docs/DECISIONS.md`，本文不重复论证、只引用。v0.2 修订依据：`spec/K0-CONTRACT-REVIEW.md`（第一轮，CHANGES_REQUESTED），逐条落实记录见 §10。
**约定**：需求编号 `REQ-*`、不变量 `INV-*`、事件 `EVT-*`、验收 `G*/C*`。凡写"必须"的条目，验收时须能以测试或事件流检查判定真伪；做不到的表述不进本文。

---

## 1. K0 范围与非目标

### 1.1 范围（In）

1. 确定性内核：Event Store（追加 + 哈希链）、Plan Engine（版本化任务图）、Scheduler（ready 计算 + 租约 + 定时器）、Acceptance 重算。
2. 脊柱对象：Project、Goal（轻量）、Task、TaskContract、TaskEdge、Assignment、Run、Feedback、Outcome、Evidence、Artifact（索引）、Acceptance、PlanChange、PlanRevision、Policy（仅 L0/L1 + 项目级授权骨架）、WaitCondition、Decision（仅 L 级不足/冲突时产生）。
3. 智能层 Proposer 三个：Intent Interpreter（输入→Task 草稿/PlanChange 提议）、Outcome Interpreter（RawResult/Feedback→Outcome 提议）、Planner（目标→初始计划提议）。全部只产提议。
4. 执行层两个 Executor：代码 Agent 适配器（一个，适配 opencode 类 CLI Agent）、人类执行者（行动卡 + 反馈入口）。
5. Web 四入口最小形态：Home 投影、Capture、My Actions、Project（概览+任务列表；图视图只做聚焦子图只读渲染）。
6. 副作用分级：L0/L1 完整实现；L2 只留 Policy 字段与分级判定接口，不实际放行（K1 开）；L3 只产生 Decision，不执行。
7. 双轨对照工具（D4）：nx-pipeline 的 run 快照（CHAIN.json + 阶段产物）导入为续行的 Project/Task/Run/Evidence，只读对照，不回写 pipeline。

### 1.2 非目标（Out，防 scope 蔓延）

- 多 Agent 路由/能力画像/冲突摘要（K2）；Template 与知识治理（K3）；GTD/WOOP/番茄（K3 插件）。
- 团队协作与细粒度权限（K2）；K0 仅单用户 + 项目隔离字段预留。
- 离线计划编辑与 CRDT 合并；离线只做 Capture/Feedback 本地先行（见 REQ-FB-2）。
- Temporal 类引擎（D3）；移动原生端；英文品牌（D6）。
- 语义去重的自动合并（只做确定性去重 + 疑似标记，见 REQ-DD-*)。

---

## 2. 领域模型（脊柱）

字段只列语义承重部分；`id` 统一 ULID，时间统一 UTC ISO-8601，所有对象带 `project_id`。

### 2.1 Project / Goal

- `Project { id, name, policy_id, created_by }`：隔离边界（INV-1）。
- `Goal { id, project_id, statement, success_criteria(text), stop_conditions(text), status: active|achieved|abandoned }`：K0 中 Goal 只承载陈述与状态，不做指标量化。

### 2.2 Task 与契约

- `Task { id, project_id, goal_id?, title, description, lifecycle, wait_state, current_contract_rev, plan_rev_introduced, assignee_hint?, duplicate_suspect: boolean = false, cancel_requested_at? }`（`duplicate_suspect` 见 REQ-DD-2；`cancel_requested_at` 为取消意图标记，见 REQ-RUN-6）
  - `lifecycle ∈ {captured, defined, ready, active, awaiting_acceptance, accepted, canceled}`（主维度）
  - `wait_state ∈ {none, waiting_on_person, waiting_until, waiting_on_dependency, blocked, on_hold}`（正交维度，与 lifecycle 分列存储）
- `TaskContract { task_id, rev, inputs(spec), expected_outputs(spec), acceptance_criteria[], required_capabilities[], side_effect_ceiling, run_timeout(时长，running 计时上限，见 REQ-RUN-4), declares_revalidation: boolean = false }`：rev 单调递增；被 Run 引用后不可变（INV-5）。`declares_revalidation=true` 表示本 rev 显式声明先前 rev 的 Acceptance 需重验——这是 S1"Acceptance 跨 rev 有效"的唯一例外通道（见 REQ-ACC-1）。`acceptance_criteria[]` 每条带稳定 `criterion_ref`，供 Acceptance.criterion_results 逐项引用（见 §2.6）。
- 结构化程度规则（REQ-TC-1）：人工执行的 Task 允许仅文本契约；**指派给 Agent Executor 的 Task 必须有结构化 `acceptance_criteria`（至少一条可判定条目）与 `expected_outputs`，否则 Scheduler 不得派发**。

### 2.3 TaskEdge

- `TaskEdge { id, project_id, from_task, to_task, kind, data_mode?, pinned_version?, release_override? }`；`release_override` 仅允许出现在 `depends_on` 边上，结构与规则见 REQ-SCH-5（S2）。
- `kind ∈ {depends_on, data_from, part_of, related_to, conflicts_with, supersedes}`。
- INV-2：只有 `depends_on` 参与 DAG 无环校验与 ready 计算；`data_from` 参与输入可用性校验；其余 kind 不影响调度。其中 `conflicts_with` 与 `supersedes` 在 K0 为**纯记录/展示语义**：`conflicts_with` 不阻止并发派发、不产生提示；`supersedes` 不自动取消被替代 Task，替代生效须与 PlanChange 的 `cancel_task` op 组合使用。任何实现不得为这两类边发明调度行为（P2-2）。
- `data_from` 必须带 `data_mode ∈ {pinned, latest_accepted}`；`pinned` 必须带 `pinned_version`，其类型为封闭联合 `{ target_kind: outcome|artifact, target_id, artifact_version? }`：`target_kind=outcome` 时以 Outcome.id 为版本身份（Outcome 不可变、新解释产生新 Outcome 记录，见 §2.5）；`target_kind=artifact` 时须带 `artifact_version`（Artifact.version 由产生它的 Run 按每个 Artifact 单调递增分配，见 §2.5）。

### 2.4 Assignment / Run

- `Assignment { id, task_id, actor_id, actor_kind: human|agent, role, scope_note, assigned_at, ended_at? }`：指派与权限分离——Assignment 不授予任何工具权限，权限只来自 Policy + Run 级凭据（K1 完整实现，K0 以 Policy 表判定）。
- `ActorProfile { actor_id, actor_kind: human|agent, capabilities[], environments[], max_side_effect_level, liveness_probe: boolean, active: boolean }`：K0 最小能力声明——在册执行者的能力集、可运行环境、可承接的最高副作用级、能否提供子进程存活探针（S6）。未在册或 `active=false` 的 actor 不得被指派（见 REQ-ASG-1、REQ-SCH-4）。
- `Run { id, run_kind: executor|human_light, task_id, assignment_id, task_rev, contract_rev, plan_rev, input_snapshot(jsonb, 不可变), policy_snapshot(jsonb), actor_id, actor_version, idempotency_key, side_effect_level, state, lease_expires_at?, heartbeat_at?, raw_result_ref? }`
  - `state ∈ {created, queued, leased, running, succeeded, failed, canceled, timed_out, indeterminate}`
  - INV-3：`input_snapshot / policy_snapshot` 写入后禁止 UPDATE（DB 权限 + 触发器双保险，验收以直接 SQL 尝试更新失败为准）。
  - INV-4：每次重试 = 新 Run（新 id、新 idempotency_key），禁止复用旧 Run 记录改状态回 `queued`。
  - `run_kind=human_light`（S3）：人类执行尝试的轻量 Run——无租约、无心跳（`lease_expires_at/heartbeat_at` 恒为 null），不适用 REQ-RUN-1/REQ-RUN-4 的租约规则、永不进 `indeterminate/timed_out`，协议见 §5.7。

### 2.5 Feedback / Outcome / Evidence / Artifact

- `Feedback { id, task_id?, project_id, author_id, raw_content, raw_attachments[], received_at, interpretation_status: pending|interpreted|failed }`
  - REQ-FB-1：Feedback 入账与解析解耦——原文落库即回执成功，解析失败置 `failed` 待重试，不丢原文。
  - REQ-FB-2（离线）：客户端本地先行落盘并显示"已记录"，同步后以服务端事件为准；同步失败不回滚本地"已记录"显示，只更新同步徽标状态。
- `Outcome { id, run_id?, feedback_id?, task_id, dimensions(jsonb), interpreted_by, proposal_id, supersedes_id? }`：**Outcome 不可变**——写入后禁止 UPDATE；新的解释/纠正产生新 Outcome 并以 `supersedes_id` 指向旧记录。Outcome.id 即其版本身份（供 `TaskEdge.pinned_version` 与 `Acceptance.subject_outcome_id` 引用）。`dimensions` 必填维度：
  - `info_obtained: boolean`、`conclusion_kind ∈ {achieved, partial, infeasible, no_response, unknown}`、`certainty ∈ {low, med, high}`、`evidence_sufficiency ∈ {sufficient, insufficient, none}`、`blockers: string[]`、`followup_suggestions: string[]`
  - REQ-OC-1：Outcome 只能由 Outcome Interpreter 的提议经内核校验（必填维度齐备 + 引用的 Evidence 存在）后生成；Executor 与人类都不能直接写 Outcome。
  - REQ-OC-2（判定不得解析自由文本，S7 护栏）：内核与 Scheduler 的任何判定**不得解析** `dimensions.blockers` / `dimensions.followup_suggestions` 的自由文本得出结论；这两项只供人阅读与 Planner 参考。`dimensions` 维持封闭集，扩维的唯一触发 = K0 退出评审时积累的"维度不足清单"（有真实条目证明某类任务无法表达才扩），扩维走 spec 修订并附存量 Outcome 的迁移说明；无证据不预防性扩维。
- `Evidence { id, task_id, source_kind, content_ref, content_hash, captured_at, environment(text), verification_status: unverified|verified|refuted, supersedes_id? }`：`verification_status` 在 K0 **仅作信息标注，不参与 Acceptance/Scheduler 的任何判定**（P2-1 顺带处理），其迁移规则留待 K1 证据治理立项。
  - `source_kind ∈ {user_statement, agent_claim, tool_output, external_doc, device_log}`
  - INV-6：`source_kind = tool_output` 的记录只能经 Tool Gateway 通道写入（K0 以独立 DB 角色/凭据实现；Agent 适配器的写入路径无此权限）。K0 定案（S5）：Tool Gateway 为**内核模块 + 专用凭据 + 审计事件**（不做独立服务；模块边界即 K1 抽离为独立服务时的接缝），验收标准不变：用 Agent 凭据尝试写入 `tool_output` 必须失败。
  - 纠错只追加：新 Evidence 以 `supersedes_id` 指向旧记录，旧记录不改不删（INV-7）。
- `Artifact { id, run_id, kind, content_ref(对象存储), content_hash, version }`：只存索引，大文件不进 PG；`version` 由产生该 Artifact 的 Run 分配、按每个 Artifact 单调递增（首版 = 1），新版本产生新 Artifact 记录、不覆盖旧版。

### 2.6 Acceptance

- `Acceptance { id, task_id, contract_rev, subject_outcome_id, acceptor_id, acceptor_kind, verdict: accepted|rejected|partially_accepted, criterion_results[] { criterion_ref, verdict: passed|failed|not_applicable, evidence_refs[] }, evidence_refs[], rationale, supersedes_id?, created_at }`（`subject_outcome_id` = 本次验收的对象 Outcome，显式指向、多 Run 时不靠时间猜，P1-7）
- REQ-ACC-1（按 S1 修订）：Acceptance 必须钉死 `contract_rev` 与 `subject_outcome_id`（记录"按哪一版契约、验的哪份 Outcome"），但**效力跨 rev 有效**：契约换版不使既有有效 Acceptance 失效，Task 达成判定认"最新有效 Acceptance（未被 supersede）"，不以当前 contract_rev 为限。唯一例外：新契约 rev 显式声明 `declares_revalidation=true` 时，该 Task 先前 Acceptance 被标记失效（事件 AcceptanceSuperseded，payload 原因 `revalidation_required`），Task 回 `awaiting_acceptance` 按新契约重新验收。
- REQ-ACC-2：自动验收只适用于契约中声明为 `auto` 的判据（程序检查类）；其余判据必须由人类或独立评审 actor 给出。**执行该 Run 的 actor 不得担任其 Acceptance 的 acceptor**（内核校验 actor 不等）。逐判据结论写入 `criterion_results[]`，顶层 `verdict` 必须与逐项结果一致：全部 passed（或 not_applicable）→ accepted；全部 failed → rejected；其余混合 → partially_accepted（内核校验此一致性，不一致的 Acceptance 不入账）。
- REQ-ACC-3（按 S4 补 partially）：Task 是否达成不存布尔字段，由内核按最新有效 Acceptance 重算：`accepted → lifecycle=accepted`；`rejected → lifecycle=defined`（重新走 ready 判定，wait_state 不因此改动）；`partially_accepted → 停在 awaiting_acceptance`，待补集 = 该 Acceptance `criterion_results` 中 verdict=failed 的判据集；无有效 Acceptance 且已有 Outcome → `awaiting_acceptance`。**已过判据继承锁定**：后续 Acceptance 对已 passed 的判据默认沿用先前结果与证据、不得无故重验回退；推翻已过判据只能通过 supersede 显式声明并附新证据（见 REQ-ACC-4）。待补集全部 passed 且新 Acceptance 整体 verdict=accepted → Task=accepted。
- REQ-ACC-4：推翻验收只能追加新 Acceptance 并 `supersedes` 旧的；重算结果以事件 `AcceptanceSuperseded` 记录，含受影响的下游 Task 列表，并按 REQ-ACC-5 逐态传播。
- REQ-ACC-5（supersede 下游传播，逐态写死）：某 Task 的有效 Acceptance 被 supersede（或因 `declares_revalidation` 失效）后，对每个曾据此 Acceptance 满足 `depends_on` 的下游 Task（受影响集合 = 沿 depends_on 的传递闭包，逐 Task 按其当前状态适用）：① lifecycle ∈ {defined, ready}：撤销其就绪依据，ready → defined，重新走 ready 判定；② lifecycle=active 且有未终态 Run：Run 不自动取消、继续至回报，其 Outcome 入账后 Task 转 `awaiting_acceptance` 并产生 Decision 请人裁决是否采信，不得据旧验收链直接验收通过；③ lifecycle=awaiting_acceptance：维持，验收时必须引用新证据链，并在 Decision 中提示上游验收已变；④ lifecycle=accepted：不自动回滚已发生事实，以 Decision 挂该 Task（subject_ref）请人裁决维持/重验/取消（不改其 wait_state，以免违反 INV-11）。传播动作逐 Task 发事件留痕。

### 2.7 PlanChange / PlanRevision / Policy / WaitCondition / Decision

- `PlanChange { id, client_proposal_id, supersedes_change_id?, project_id, base_plan_rev, ops[], rationale, assumptions[], risk_level(L0|L1|L2|L3，副作用分级枚举，与 Policy.auto_apply_ceiling 同量纲), proposer_id, status: proposed|applied|rejected|needs_decision }`；`client_proposal_id` 为提议方生成的客户端幂等键，与服务端 `id` 分开，唯一约束 `(project_id, proposer_id, client_proposal_id)`（P2-4）；`supersedes_change_id` 见 REQ-PC-5。`ops` 为封闭枚举：`add_task, update_task_text, add_edge, remove_edge, reassign, update_contract, cancel_task, add_wait`。
- `PlanRevision { project_id, rev, change_id, applied_at, diff_summary }`：项目计划版本号 `rev` 单调递增（INV-8）。
- `Policy { id, project_id, auto_apply_ceiling(L0|L1), side_effect_grants[], budget_cap?(K0 恒不拦截、只记账，记账形态见 REQ-PC-6；拦截在 K1), actor_permissions[] }`：Policy 变更只能由人类 actor 发起且走事件（INV-9）。
- `WaitCondition { id, task_id, kind: person|until|dependency|device, target_ref, due_at?, followup_task_id?, status: active|satisfied|expired|canceled }`
  - INV-10：同一 `(task_id, kind, target_ref)` 同时至多一个 `active` WaitCondition，且其 `followup_task_id` 至多一个（DB 唯一偏索引兜底）。
- `Decision { id, project_id, subject_ref, question, recommendation, alternatives[], evidence_refs[], status: pending|approved|approved_modified|rejected|deferred|expired, decided_by?, decided_at? }`
  - REQ-DC-1：`expired` 不等于批准；过期只产生提醒事件，不产生任何执行。

---

## 3. 状态机（迁移矩阵，内核唯一实现）

### 3.1 Task 主生命周期迁移（行=当前，列=目标；✓=合法，触发事件见注）

| from\to | defined | ready | active | awaiting_acceptance | accepted | canceled |
|---|---|---|---|---|---|---|
| captured | ✓ 定义完成 | – | – | – | – | ✓ |
| defined | （自环：契约/文本修订，不算迁移） | ✓ 依赖满足 | – | – | – | ✓ |
| ready | ✓ 依赖回退 | – | ✓ 派发 Run | – | – | ✓ |
| active | – | – | – | ✓ Run 出 Outcome | – | ✓（按 REQ-RUN-6 取消级联：先记取消意图，全部在跑 Run 达终态后才正式 canceled） |
| awaiting_acceptance | ✓ 验收 rejected | – | ✓ 验收 rejected 且需再执行；或 partially_accepted 且未过判据需再执行（范围 = criterion_results 未过项，S4） | – | ✓ 验收 accepted | ✓（同 REQ-RUN-6 级联，无在跑 Run 时直接收尾） |
| accepted | – | – | – | ✓ Acceptance 被 supersede 且新结论未定；或新契约显式声明需重验（declares_revalidation，S1） | – | – |
| canceled | 终态 | | | | | |

- `captured → defined` 要求：有 title；指派 Agent 时另须满足 REQ-TC-1。
- wait_state 维度独立迁移：任一非终态 lifecycle 可叠加/解除 wait_state。**WaitCondition.kind → wait_state 映射表**：`person → waiting_on_person`；`until → waiting_until`；`dependency → waiting_on_dependency`；`device → blocked`（K0 不设独立 device wait_state，设备等待归入 blocked，设备标识写在 WaitCondition.target_ref）。人工直接置位 `blocked/on_hold` 不经 WaitCondition。
- INV-11（终态收尾，可判定表述）：lifecycle 迁移到 `accepted`/`canceled` 时，内核在**同一事务内自动收尾**——先将该 Task 全部 active WaitCondition 置 `canceled`（各发 `WaitConditionCanceled`）、再置 wait_state=`none`、最后完成 lifecycle 迁移。**不拒绝迁移、不要求调用方先行满足前置条件**。验收断言：对处于 `waiting_on_person` 且有 active WaitCondition 的 Task 直接给 Acceptance `accepted`，迁移必须成功且迁移后 WaitCondition=canceled、wait_state=none。
- wait_state ≠ none 时 Scheduler 不派发新 Run（`on_hold`/`blocked` 同理），但不影响已在跑 Run 的回报入账。

### 3.2 Run 状态迁移

| from\to | queued | leased | running | succeeded | failed | canceled | timed_out | indeterminate |
|---|---|---|---|---|---|---|---|---|
| created | ✓ | – | – | – | – | ✓ | – | – |
| queued | – | ✓ 领取 | – | – | – | ✓ | – | – |
| leased | ✓ 租约过期未启动（分界见 REQ-RUN-4） | – | ✓ 启动回报 | – | ✓ | ✓ | – | ✓ 心跳丢失且已可能产生副作用（分界见 REQ-RUN-4） |
| running | – | – | – | ✓ | ✓ | ✓ 取消确认后 | ✓ 超时且确认无副作用残留 | ✓ 心跳丢失/进程崩溃 |
| indeterminate | – | – | – | ✓ 对账确认已完成（补录 RawResult） | ✓ 对账确认未执行或已失败 | ✓ 对账后人工取消 | – | – |
| 终态（succeeded/failed/canceled/timed_out） | 不可再迁移（INV-4） | | | | | | | |

- REQ-RUN-1：`leased/running` 必须有 `lease_expires_at` 与心跳续约；心跳间隔与租约时长为配置项，K0 默认值：心跳 15s、租约 45s（在 S6 前提下保留）。**心跳不是领域事件**：只更新 Run 行的 `heartbeat_at`（可节流采样），不入事件流、不占 `seq` 与哈希链、投影重演时忽略（`RunHeartbeat` 已自 §4 目录移除；量级修正见 §7）。**适配器代发心跳必须绑定被包裹子进程的存活探针（S6）**：子进程退出或探针失联即刻停发，任租约过期走 REQ-RUN-3 对账；不许无条件定时代发。无法提供存活探针的执行类型不得承接 leased 模式 Run（在 ActorProfile 中标注，见 REQ-ASG-1）。
- REQ-RUN-2：进入 `indeterminate` 的 Run，在对账完成前，同一 Task 不得派发同契约范围的新 Run。
- REQ-RUN-3（对账）：对账依据 `idempotency_key` 向 Executor/外部系统查询；三种结论（已执行→补录 RawResult 走正常 Outcome 流；未执行→原 Run 置 failed(原因 `reconciled_not_executed`) 后可新建 Run；无法确定→保持 indeterminate 并产生 Decision 请人裁决）。
- REQ-RUN-4（租约过期分界 + 超时来源，封闭规则）：租约过期时——未启动（无 `RunStarted`）→ 回 `queued`；已启动且 `side_effect_level ∈ {L0, L1}` 且无外部副作用工具调用记录 → 置 `failed`（原因 `lease_expired`），可安全新建 Run；已启动且（`side_effect_level ∈ {L2, L3}` 或已有外部副作用调用记录）→ 转 `indeterminate` 走 REQ-RUN-3。判定只依据（是否已启动、副作用级、副作用调用记录）三项，不依据 Executor 自述。`timed_out` 的计时来源 = `TaskContract.run_timeout`（自 `RunStarted` 起算）：超时且确认无副作用残留 → `timed_out`；超时但副作用状态不明 → `indeterminate`。
- REQ-RUN-6（取消级联，写死）：Task 取消分三步。① **记取消意图**：发 `TaskCancelRequested` 事件、置 `cancel_requested_at`（此后冻结该 Task 的新 Run 派发；lifecycle 暂不变）；同时级联收尾——该 Task 的 pending Decision 全部置 `expired`（原因 `task_canceled`）、active Assignment 置 ended（`AssignmentEnded`）。② **在跑 Run 收尾**：`created/queued/leased` 未启动的 Run 直接置 `canceled`（`RunCanceled`）；`running` 的 Run 由内核向 Executor 发取消请求，Executor 确认后置 `canceled`（取消确认由 Executor 的取消回执给出）；确认超时（配置项，默认 60s）未确认或 Executor 失联 → Run 转 `indeterminate` 走 REQ-RUN-3 对账，**对账结论出来前 Task 保持"取消意图已记、未正式 canceled"**，不先行置 canceled。`human_light` Run 的取消无确认环节、直接置 `canceled`。③ **正式取消**：该 Task 全部 Run 达终态后，内核将全部 active WaitCondition 置 `canceled`（`WaitConditionCanceled`）、wait_state 归 `none`、lifecycle 置 `canceled` 并发 `TaskCanceled`。处于 `captured/defined/ready/awaiting_acceptance` 且无在跑 Run 的 Task 跳过第②步直接执行第③步。取消意图一旦记录不可撤销（反悔只能新建 Task）。

---

## 4. 事件目录 v1（EVT）

事件信封：`{ id(ULID), global_seq, stream_id, seq, type, actor_id, actor_kind, causation_id, correlation_id, idempotency_key, payload, prev_hash, hash, occurred_at, recorded_at }`。`stream_id = project_id`（stream 粒度 = Project，见 INV-12）；`seq` 为 stream 内序号；`global_seq` 为全库单调递增序号（自增列），是跨 stream 的全序锚点。

INV-12：同 stream 内 `seq` 严格递增；跨 stream 顺序以 `global_seq` 为唯一全序，投影重演一律按 `global_seq` 回放；`hash = H(prev_hash ‖ payload ‖ seq)`（`prev_hash` 取同 stream 上一事件的 hash）；任何投影必须能由事件流重演得到（验收 C5）。
INV-13：携带 `idempotency_key` 的外部事件重复投递只入账一次（唯一索引 + 返回首次结果）。

K0 事件类型（封闭集，新增类型须走 spec 修订）：
`ProjectCreated, GoalCreated, TaskCaptured, TaskDefined, ContractUpdated, EdgeAdded, EdgeRemoved, PlanChangeProposed, PlanChangeApplied, PlanChangeRejected, PlanRevisionCreated, AssignmentCreated, AssignmentEnded, RunCreated, RunQueued, RunLeased, RunStarted, RunRawResultReceived, RunSucceeded, RunFailed, RunCanceled, RunTimedOut, RunIndeterminate, RunReconciled, FeedbackReceived, FeedbackInterpreted, OutcomeRecorded, EvidenceAdded, EvidenceSuperseded, AcceptanceRecorded, AcceptanceSuperseded, WaitConditionCreated, WaitConditionSatisfied, WaitConditionExpired, DecisionCreated, DecisionResolved, DecisionExpired, PolicyUpdated, TimerFired, ProjectionRebuilt, GoalStatusChanged, TaskLifecycleChanged, TaskCancelRequested, TaskCanceled, TaskDuplicateSuspected, TaskDuplicateResolved, ReleaseOverrideSet, ReleaseOverrideInvalidated, PlanChangeStatusChanged, WaitConditionCanceled, FeedbackInterpretationFailed, LatestAcceptedPointerMoved`

**派生规则声明（P0-4）**：Task.lifecycle/wait_state、Goal.status、Feedback.interpretation_status、PlanChange.status、WaitCondition.status、Run.state 均为事件派生状态（实体行/投影只是缓存），**每次状态变更必有上表对应事件为源，不存在无事件的状态变更**：lifecycle 每次迁移发 `TaskLifecycleChanged`（payload 带 from/to 与触发事件 id），取消另发 `TaskCancelRequested/TaskCanceled`；Goal 状态变更发 `GoalStatusChanged`；Feedback 解析失败发 `FeedbackInterpretationFailed`；PlanChange 置 needs_decision 及后续状态流转发 `PlanChangeStatusChanged`（见 REQ-PC-5）；WaitCondition 置 canceled 发 `WaitConditionCanceled`；疑似重复标记/解除发 `TaskDuplicateSuspected/TaskDuplicateResolved`。C5 的"逐字段 diff 为零"以本声明的派生规则为判定依据。

---

## 5. 核心协议需求

### 5.1 PlanChange 校验流水线（REQ-PC）

- REQ-PC-1：校验顺序固定且全部通过才应用：Schema → `base_plan_rev` = 当前 rev（不等 → 冲突，返回三方差异基线/当前/提议，不自动重试覆盖）→ 图校验（DAG、边 kind 合法、迁移矩阵）→ Policy（proposer 权限 + `risk_level ≤ auto_apply_ceiling`；`risk_level` 与 `auto_apply_ceiling` 同量纲，均取副作用分级枚举 {L0, L1, L2, L3}、按 L0<L1<L2<L3 序比较，不另设映射表）→ 预算关口（K0 恒通过、只记账，见 REQ-PC-6）→ 幂等（同 `(project_id, proposer_id, client_proposal_id)` 重放返回首次结果）。
- REQ-PC-2：原子性——一个 PlanChange 的 ops 要么全应用并产生恰一个 PlanRevision，要么不应用；不允许部分应用。
- REQ-PC-3：校验不过且属"可由人裁决"类（权限/风险超限、版本冲突）→ 产生 Decision 并置 `needs_decision`；属"结构错误"类 → 置 `rejected` 并记录原因码（封闭枚举：`schema_invalid, base_rev_conflict, dag_cycle, illegal_edge, policy_denied, duplicate, superseded_by_decision, decision_rejected, decision_expired`；`budget_exceeded` 已删除——K1 随预算拦截一并引入，见 REQ-PC-6）。
- REQ-PC-4：已启动 Run 引用的 `plan_rev/task_rev/contract_rev` 不受新 Revision 影响（由 INV-3/INV-5 快照保证）；新 Revision 只影响此后创建的 Run。
- REQ-PC-5（Decision 回路，写死）：PlanChange 置 `needs_decision` 后的出路唯一如下——Decision `approved` → 原 Change 以裁决时刻的当前 rev 为新 base **重走 REQ-PC-1 完整校验**，通过才应用；不过则生成新的版本冲突 Decision（批准不等于绕过校验，不许跳过校验直接应用）；`approved_modified` → 禁止原地改 ops，由裁决者提交新 PlanChange（新 id、`supersedes_change_id` 指向旧 Change），旧 Change 置 `rejected`、原因码 `superseded_by_decision`；`rejected` → Change 置 `rejected`、原因码 `decision_rejected`；`deferred` 必须带重新唤起条件（到期时间或触发事件，写入 Decision），条件满足时 Change 回到 `proposed` 重走校验；`expired` → Change 置 `rejected`、原因码 `decision_expired`（与 REQ-DC-1"过期不等于批准"对齐）。每次状态流转均发 `PlanChangeStatusChanged` 事件。

- REQ-PC-6（预算记账形态，K0）：预算关口恒通过、只记账——每次 Run 达终态时落一条账目 `{ run_id, project_id, estimated, actual, unit: token|money|duration, recorded_at }`，每个已应用的 PlanChange 落一条 `{ change_id, project_id, estimated }`；账本只追加，K1 引入拦截时以此为回溯依据并同步引入 `budget_exceeded` 原因码。K0 任何组件不得以 `budget_cap` 为由拒绝 PlanChange 或 Run。

### 5.2 Scheduler（REQ-SCH）

- REQ-SCH-1：ready 判定 = `lifecycle=defined ∧ depends_on 全部满足（上游 Task 最新有效 Acceptance=accepted（跨 rev 有效，见 REQ-ACC-1），或该 depends_on 边上的 release_override 处于 active（见 REQ-SCH-5））∧ data_from 可用（pinned 版本存在 / latest_accepted 指针非空）∧ wait_state=none ∧ duplicate_suspect=false ∧ 能力可用性满足（见 REQ-SCH-4）∧ Policy 未拦截`。判定逻辑只在内核一处实现，投影与 API 不得各自重算出不同结论（投影可用缓存，但以内核判定事件为准）。
- REQ-SCH-2：`latest_accepted` 指针沿 `data_from` 边定义，主语为**上游**：指针（from_task）= from_task 最新有效 Acceptance 的 `subject_outcome_id` 所指 Outcome 及其 Artifact 产物（不是下游 Task 自身的验收——下游尚未执行、无已验收结果）。指针移动（新 Acceptance 入账、Acceptance 被 supersede、或因重验失效）产生 `LatestAcceptedPointerMoved` 事件（payload 带 `from_outcome_id/to_outcome_id`）并触发下游 ready 重算。
- REQ-SCH-3：定时器全部持久化（WaitCondition.due_at、租约、Decision 过期）；进程重启后 Timer 服务按持久化记录恢复触发，不用内存计时承载业务时间。验收：杀进程重启后到期 WaitCondition 仍被触发（C4）。
- REQ-SCH-4（能力可用性，ready 公式组成项）：存在至少一个在册且 `active` 的 ActorProfile，使其 `capabilities ⊇ contract.required_capabilities` 且 `max_side_effect_level ≥ contract.side_effect_ceiling`。无此 actor 时 Task 不进 ready、停在 `defined`，并在投影中以原因码 `no_capable_actor` 区分展示（不占用 wait_state 维度）。
- REQ-ASG-1（Assignment 产生与结束）：Assignment 的产生路径有且只有两条——(a) 人类在 UI/API 显式指派；(b) PlanChange 的 `reassign`/`add_task` op 应用时由内核按 op 内容创建。Scheduler 与 Proposer 不得绕过这两条路径直接写 Assignment（Proposer 只能以 PlanChange 提议）。INV-14：同一 Task 同时至多一个 active Assignment（`ended_at` 为空者）。Assignment 结束（发 `AssignmentEnded`；触发者封闭枚举：人类改派、PlanChange reassign 应用、Task 取消级联（REQ-RUN-6）、actor 被停用）时，其未终态 Run 归属不变（继续按原 `assignment_id` 回报），新 Run 只从新 Assignment 派发。
- REQ-SCH-5（release_override，S2，四项硬条件缺一不可，缺任一项则该机制不成立、不得实现）：① **字段挂边且绑定上游契约版本**：`release_override { set_by, reason, set_at, upstream_contract_rev }` 挂在 `depends_on` 边上，`upstream_contract_rev` = 置位时上游 Task 的 contract_rev；② **人类-only + 理由必填 + 走事件**：仅人类 actor 可置位（Proposer/系统不得置位），reason 必填，置位发 `ReleaseOverrideSet` 事件；③ **失效条件写死**：上游 contract_rev 变更、或上游产生终局 Acceptance（accepted/rejected）、或人类 actor 显式撤销——任一发生 override 自动失效并发 `ReleaseOverrideInvalidated`；④ **上游最终 rejected 时的下游处置**：被 override 放行的下游 Task 中，未启动 Run 的回退 lifecycle=defined 并撤销就绪依据；已产生 Outcome 的置 wait_state=blocked 并产生 Decision 请人裁决，不自动回滚已发生事实。override 只影响 `depends_on` 满足判定，不影响 `data_from` 可用性判定。

### 5.3 去重（REQ-DD）

- REQ-DD-1（确定性自动）：同 `idempotency_key` 事件、同 WaitCondition 唯一性（INV-10）、同 Feedback 客户端提交 id 重放——自动去重，不产生第二份实体。
- REQ-DD-2（结构指纹）：同 Project + 同 assignee + 标题归一化（去空白/标点/大小写）哈希命中 → 新 Task 置 `duplicate_suspect=true`（字段落点见 §2.2；事件 `TaskDuplicateSuspected`）并挂起——`duplicate_suspect=true` 的 Task 不得进入 ready（REQ-SCH-1 判定含此项），同时产生 Decision 供人确认。裁决后两条出路：① **合并**——被疑 Task 走 REQ-RUN-6 级联置 `canceled`（`TaskCanceled`，原因 `duplicate_merged`），其未决事项以 PlanChange 并入目标 Task；② **放行**——置 `duplicate_suspect=false`（事件 `TaskDuplicateResolved`），Task 恢复正常 ready 判定。`duplicate_suspect` 与 wait_state 正交、不占用 wait 维度（与 INV-11 无冲突）；Task 进终态时该字段保留原值作审计。
- REQ-DD-3（语义相似）：K0 不实现自动语义去重；接口预留，语义判断永不自动合并（原则入 spec，防后续偷工）。

### 5.4 Guidance（K0 最小版，REQ-GD）

- REQ-GD-1：K0 只实现 hard 轨的子集：`require_decision_for[]`（动作类别枚举）、`auto_apply_ceiling`（落在 Policy）、`allowed_actors[]`。soft 自然语言原文只存不执行（进 Planner 上下文属 K1）。
- REQ-GD-2：hard 规则的新增/修改只能由人类 actor 经 PolicyUpdated 事件生效；Proposer 提出的 hard 规则变更一律转 Decision。

### 5.5 上下文组装（K0 最小版，REQ-CX）

- REQ-CX-1：Run 的 `input_snapshot` 由内核组装，内容顺序与来源固定：契约与输入（钉死 rev）> 目标陈述与 hard 规则 > 上游已验收 Outcome/Evidence（带 captured_at 与 environment）> 本 Task 历史 Run 的 RawResult 摘录（最近 3 个；K0 只用确定性摘录 = 原文前 512 字符 + `raw_result_ref` + 原文 `content_hash` 成对出现，并标注产生者 = 内核组装器——模型生成的摘要不进 K0 快照，留待 K1；见 P2-3；被 supersede 的 Evidence 必须显式标注"已推翻"）。
- REQ-CX-2：K0 不做 token 预算裁剪（上下文规模假设见 §7），但组装结果必须完整落快照，事后可复盘"Agent 当时看到了什么"。

### 5.6 双轨对照（D4，REQ-DT）

- REQ-DT-1：导入器读取 pipeline run 的 CHAIN.json 与阶段产物目录，映射：run → Project；phase → Task（`depends_on` 按 phase 顺序）；phase 执行 → Run（actor = 该 phase 的模型/session）；评审 verdict → Acceptance（评审 actor ≠ 执行 actor 时满足 REQ-ACC-2）；阶段产物文件 → Artifact/Evidence（S5 定案：Evidence 一律以 `source_kind=external_doc` 入账，附 `content_hash` 与来源说明（原始 run/phase 与文件路径）；**不给导入器 Tool Gateway 凭据**，导入产物不冒充 `tool_output` 等级）。
- REQ-DT-2：导入只读、幂等（同 run 重复导入不产生重复实体，以 run-id + phase 为幂等键）；对照报告输出"映射成功/无法映射"清单——无法映射的条目就是领域模型的缺陷证据，计入 K0 退出评审。

---

### 5.7 人类执行协议（REQ-HUM，S3）

- REQ-HUM-1：人类执行者对 Task 的一次执行尝试同样创建 Run（`run_kind=human_light`）：无租约（`lease_expires_at=null`）、无心跳、`idempotency_key` 由客户端提交 id 承担；状态只走 `created → running`（人类在 MyActions 点"开始"、或首次提交绑定该 Run 的 Feedback 时）`→ succeeded/failed/canceled`，不出现 leased/indeterminate/timed_out。
- REQ-HUM-2：人类路径的 Outcome 触发与 Agent 路径一致：人类 Feedback 先入账（REQ-FB-1）；绑定 human_light Run 的 Feedback 经 Outcome Interpreter 解释、内核校验后生成 Outcome（`OutcomeRecorded`），该 Run 随之置 `succeeded`（= 执行尝试已完成，与 Outcome 的业务结论无关），Task 随之 `active → awaiting_acceptance`（§3.1 矩阵"Run 出 Outcome"触发对人机两条路径同义）。无绑定的游离 Feedback 只入账并触发解释，不产生 Run、不迁移 Task 状态。
- REQ-HUM-3（跟进产生路径唯一化）：WaitCondition 与跟进 Task **只能经一条路径产生**——Outcome Interpreter/Planner 以 PlanChange 提议（ops 含 `add_wait` + `add_task` + `add_edge`），内核按 REQ-PC 流水线判定：风险级 ≤ `auto_apply_ceiling` 且 Policy 允许 → 自动应用，产生 WaitCondition 与恰一个跟进 Task（跟进 Task id 写入 `WaitCondition.followup_task_id`）；超限 → 转 Decision，批准后按 REQ-PC-5 回路应用。内核不得在 PlanChange 之外自动创建 WaitCondition 或跟进 Task。G1 的事件断言以本条序列为准。

## 6. 投影与入口（最小形态）

- REQ-PJ-1：Home / MyActions / Project 三个投影由事件消费者维护；每个 Task 在投影中带 `available_actions[]`（由内核按 lifecycle/wait_state/actor 角色算出），前端只渲染不自算状态逻辑。
- REQ-PJ-2：MyActions 只含 `actor=当前用户 ∧ (可执行[ready/active 且 wait_state=none] ∨ 待其决策的 Decision)` 的条目；等待他人/Agent 的条目不入此投影。
- REQ-PJ-3：Capture 提交后 1 次请求内返回"已记录"回执（含本地 id 映射），分类/结构化以异步事件补齐，界面以"已记录，整理中"区分于"已成 Task"。

---

## 7. K0 量级假设（标注为假设，非承诺）

单用户、单机内核实例；Project ≤ 20 个活跃；单 Project Task ≤ 500、领域事件总量 ≤ 50 万/年；并发 Run ≤ 8。注：心跳不入事件流（REQ-RUN-1）是本量级成立的前提——若心跳入流，按心跳 15s、并发 8 估算约 4.6 万条/天，一周即击穿本假设，故心跳只更新 Run 行。此假设支撑 REQ-CX-2（不裁剪）与单 PG 选型；超出时先修订 spec 再扩容。

---

## 8. 验收（K0 退出标准）

### 8.1 Golden Scenarios（源自蓝图 §4 旅程）

- **G1（旅程 4.2，第一 conformance，按 REQ-HUM 事件序列重写）**：Task T"联系张三确认方案"（指派人类）→ Assignment 产生 → Run A（`human_light`）created/running → 人类提交联系尝试 Feedback（原文入账）→ Outcome `conclusion_kind=no_response, info_obtained=false` 入账 → Run A `succeeded` → T `active → awaiting_acceptance` → Interpreter 提议 PlanChange（`add_wait` + `add_task` + `add_edge`），经 Policy 判定自动应用 → T 的 wait_state=`waiting_on_person` + 恰一个 active WaitCondition + 恰一个跟进 Task F（且 `WaitCondition.followup_task_id = F`）；同一 Feedback 以同一客户端提交 id 重放 10 次，跟进仍恰一个（REQ-DD-1/INV-10/REQ-HUM-3）。在 F 上提交第二次 Feedback（转述意见）→ 记录为 `user_statement` 来源 Evidence → Outcome `info_obtained=true` → 验收者据此对 T 给出 Acceptance `accepted` → T=`accepted`，且其 WaitCondition 按 INV-11 在终态迁移时自动置 canceled、wait_state 归 none；另行提议的新 Task（联系李四/UDP 实测）以独立 PlanChange 呈现，未经应用不入图。
- **G2（旅程 4.5）**：Run 执行中应用 PlanChange 改计划：在跑 Run 的 `input_snapshot` 哈希前后不变；新 Run 使用新 `plan_rev`；旧 Revision 与旧 Run 历史可完整查回。
- **G3（旅程 4.1 局部）**：模糊输入 → Captured → Interpreter 提议计划草稿（PlanChange）→ 人批准应用 → 派发代码 Agent Run → Run succeeded + Outcome `infeasible`（方案不可行）+ Acceptance accepted 三者同时成立（四分关系试金石）。
- **G4（旅程 4.3）**：Agent Task 产出测试方案后，子 Task 指派人类：MyActions 投影出现该条且带 `available_actions`；人类 Feedback 附日志（Evidence `device_log`）→ 未过判据只重开对应子 Task，已过判据不回退（判据级断言以对应 Acceptance 的 `criterion_results` failed 项为准；"重开"指经 PlanChange 的 `add_task` 新建补充 Task 承接未过判据，原 Task 与已过判据不回退、不重验，见 REQ-ACC-3/S4）。
- **G5（双轨）**：任选 3 个已完成 pipeline run 导入，映射成功率与无法映射清单产出报告（REQ-DT-2）；映射出的 Acceptance 全部满足 actor 分离（REQ-ACC-2），不满足的条目必须在报告中显式列出而非静默跳过。

### 8.2 混沌/不变量测试

- **C1**：Executor 领取 Run 后杀进程 → 租约过期 → Run=indeterminate → 对账（模拟"未执行"）→ 新 Run 派发成功且旧 Run 终态为 failed(`reconciled_not_executed`)。
- **C2**：同一外部事件投递 3 次 → 只入账 1 次（INV-13）。
- **C3**：两个 PlanChange 同 `base_plan_rev` 并发提交 → 恰一个应用成功，另一个得 `base_rev_conflict` + 三方差异。
- **C4**：内核进程在 WaitCondition 到期前重启 → 到期后仍触发 `WaitConditionExpired`（REQ-SCH-3）。
- **C5**：任一投影表清空后由事件流重演重建，与重建前逐字段 diff 为零（INV-12）。
- **C6**：以 Agent 凭据尝试写 `source_kind=tool_output` 的 Evidence → 失败；以 Agent actor 身份尝试验收自己执行的 Run → 被 REQ-ACC-2 拦截。

### 8.3 退出门

G1–G5 全绿 + C1–C6 全绿 + REQ-DT-2 对照报告已评审。三者缺一，K0 不算完成，不进 K1。

---

## 9. 开放问题处理（v0.2：Q1–Q5 全部已裁决，不再开放）

Q1–Q5 已于 2026-10-21 由用户批准 contract-review 第一轮的推荐裁决，记入 `docs/DECISIONS.md` S1–S7，本文按裁决落地：

| # | 裁决 | 出处 | 落点 |
|---|---|---|---|
| Q1 | `partially_accepted` 停在 `awaiting_acceptance`；已过判据继承锁定、不回退，只补未过判据 | S4 | §2.6 REQ-ACC-3、§3.1 矩阵 |
| Q2 | `release_override` 进 K0，附四项硬条件（挂 Edge 绑上游 contract_rev / 人类-only 走事件 / 失效条件 / 上游被拒时下游处置），缺一降级不进 | S2 | §2.3、§5.2 REQ-SCH-5 |
| Q3 | Tool Gateway = 内核模块 + 专用凭据；双轨导入 Evidence 一律降级 `external_doc`，不给导入器网关凭据 | S5 | §2.5 INV-6、§5.6 REQ-DT-1 |
| Q4 | 适配器代发心跳，但必须绑定被包裹子进程的存活探针、不许无条件代发；在此前提下心跳 15s/租约 45s 默认值保留 | S6 | §3.2 REQ-RUN-1 |
| Q5 | `dimensions` 维持封闭集；内核/Scheduler 判定不得解析 `blockers`/`followup_suggestions` 文本；扩维唯一触发 = K0 退出评审的"维度不足清单" | S7 | §2.5 REQ-OC-2 |

### 9.1 v0.2 新开放问题

（无。本轮修订中未发现新的 load-bearing 开放问题；实现期若发现，按修订纪律另行升版并在此登记，不藏进正文。）

---

---

## 10. v0.2 修订记录（contract-review 第一轮分流逐条落实）

依据：`spec/K0-CONTRACT-REVIEW.md`（CHANGES_REQUESTED，P0×6 / P1×10 / P2×4）+ `docs/DECISIONS.md` S1–S7。分流全覆盖：run 15 条 + decision 3 条 + drop 顺带 2 条 = 20 条。

| 条目 | 分流 | 改动章节 | 改法（一句） |
|---|---|---|---|
| P0-1 | run | §2.2、§3.1、§3.2 | 补 REQ-RUN-6 取消级联三步写死：记取消意图（TaskCancelRequested，级联收尾 Decision/Assignment）→ 在跑 Run 确认取消、未确认转 indeterminate 对账 → 全部 Run 终态后才正式 canceled |
| P0-2 | decision（S1） | §2.2、§2.6、§3.1 | REQ-ACC-1 改为 Acceptance 跨 rev 有效（新契约显式 declares_revalidation 为唯一例外）；新增 REQ-ACC-5 定义 supersede 对下游的逐态传播 |
| P0-3 | run | §2.2、§2.6、§3.1、§8 G4 | Acceptance 增 criterion_results[] 逐判据结果并校验顶层 verdict 一致性；REQ-ACC-3 补 partially 重算（停 awaiting_acceptance、已过判据继承锁定，S4）；G4 指明"重开"= PlanChange add_task 新建补充 Task |
| P0-4 | run | §4 | 事件目录补齐 GoalStatusChanged/TaskLifecycleChanged/TaskCancelRequested/TaskCanceled/WaitConditionCanceled/FeedbackInterpretationFailed/PlanChangeStatusChanged/TaskDuplicateSuspected/TaskDuplicateResolved/LatestAcceptedPointerMoved，并加"派生规则声明"：所有状态变更必有事件为源 |
| P0-5 | decision（S2） | §2.3、§4、§5.2 | 补 release_override 字段（挂 depends_on 边）+ 新增 REQ-SCH-5 写死四项硬条件：绑上游 contract_rev、人类-only 理由必填走事件、失效条件、上游 rejected 时下游逐态处置 |
| P0-6 | decision（S3） | §2.4、§5.7、§8 G1 | 新增 §5.7 REQ-HUM 人类执行协议：人类动作建 human_light 轻量 Run（无租约/心跳）；跟进 Task/WaitCondition 产生路径唯一化为 Interpreter 提议 PlanChange → Policy 判定；G1 按新事件序列重写断言 |
| P1-1 | run | §2.7、§5.1 | risk_level 直接取副作用分级枚举 {L0,L1,L2,L3}，与 auto_apply_ceiling 同量纲序比较，不另设映射表 |
| P1-2 | run | §2.7（对象定义）、§3.1 | 补 WaitCondition.kind → wait_state 映射表（device → blocked）；INV-11 改为可判定表述：终态迁移同事务自动收尾 WaitCondition 并归 none，不拒绝迁移，附验收断言 |
| P1-3 | run | §2.2、§3.2 | TaskContract 增 run_timeout 作为 timed_out 计时来源；新增 REQ-RUN-4 写死租约过期分界（未启动回 queued / 已启动按副作用级与副作用记录分 failed 与 indeterminate） |
| P1-4 | run | §3.2、§4、§7 | 心跳移出领域事件流（只更新 Run 行 heartbeat_at，不占 seq/哈希链），事件目录删 RunHeartbeat；§7 量级注明心跳入流约 4.6 万条/天与假设不符故排除 |
| P1-5 | run | §4 | stream 粒度定为 Project（stream_id = project_id）；信封增 global_seq 为跨 stream 全序锚点，INV-12 改为投影按 global_seq 重演 |
| P1-6 | run | §2.2、§4、§5.3 | Task 增 duplicate_suspect 字段落点（与 wait_state 正交）；REQ-DD-2 补标记/解除事件与裁决两条出路（合并置 canceled / 放行恢复 ready 判定） |
| P1-7 | run | §2.3、§2.5、§2.6、§5.2 | Acceptance 增 subject_outcome_id；声明 Outcome 不可变、id 即版本身份，pinned_version 改封闭联合类型、Artifact.version 明确递增规则；REQ-SCH-2 重写指针主语为沿 data_from 边取上游 |
| P1-8 | run | §2.4、§5.2 | 增 ActorProfile 最小能力定义；新增 REQ-SCH-4（能力可用性进 ready 公式，无可用执行者停 defined 并以 no_capable_actor 区分）与 REQ-ASG-1（Assignment 仅两条产生路径 + INV-14 至多一个 active + 结束时在跑 Run 归属不变） |
| P1-9 | run | §2.7、§5.1 | 新增 REQ-PC-5 写死 Decision 裁决后 PlanChange 回路（approved 重走完整校验 / approved_modified 新建 Change 并 supersede / deferred 带唤起条件 / expired 置 rejected），状态流转走 PlanChangeStatusChanged |
| P1-10 | run | §2.7、§5.1 | K0 预算关口恒通过只记账：删 REQ-PC-3 原因码 budget_exceeded（注明 K1 随拦截引入）；新增 REQ-PC-6 定义 Run/Change 两级记账形态 |
| P2-1 | drop（顺带声明） | §2.5 | Evidence 定义处加一句：verification_status 在 K0 仅信息标注、不参与任何判定，迁移规则留待 K1 |
| P2-2 | run | §2.3 | INV-2 增声明：conflicts_with/supersedes 在 K0 为纯记录语义，supersedes 不自动取消、须与 cancel_task op 组合，禁止实现自创调度行为 |
| P2-3 | run | §5.5 | REQ-CX-1 改：快照只放确定性摘录（原文前 512 字符 + raw_result_ref + content_hash 成对、标注产生者），模型摘要不进 K0 快照 |
| P2-4 | drop（顺带对齐） | §2.7、§5.1 | PlanChange 增 client_proposal_id 字段（唯一约束 (project_id, proposer_id, client_proposal_id)），REQ-PC-1 幂等键统一为该字段，删除不存在的 proposal_id 表述 |
| Q 护栏（S5/S6/S7） | decision 落地 | §2.5、§3.2、§5.6 | S5：INV-6 定案网关为内核模块+专用凭据、REQ-DT-1 定案导入 Evidence 降级 external_doc；S6：REQ-RUN-1 定案代发心跳绑子进程存活探针；S7：新增 REQ-OC-2"判定不得解析自由文本"护栏 + 封闭维度集扩维触发 |

---

*本 spec 经 contract-review（独立评审、与作者不同上下文）通过后冻结为 v1.0；修订走版本递增 + 变更记录，不静默改冻结版。v0.1 原文备份于 `spec/K0-SPEC-v0.1.md`。*
