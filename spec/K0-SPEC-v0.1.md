# 续行 K0 领域 Spec v0.1（草稿 · 待 contract-review）

**范围声明**：本文只定义 K0 脊柱的可判定行为，是 K0 实现的判卷标准。产品目标态见蓝图 v1.0；架构与协议依据见《评审+技术方案 v1》§2；已定版决策 D1–D7 见 `docs/DECISIONS.md`，本文不重复论证、只引用。
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

- `Task { id, project_id, goal_id?, title, description, lifecycle, wait_state, current_contract_rev, plan_rev_introduced, assignee_hint? }`
  - `lifecycle ∈ {captured, defined, ready, active, awaiting_acceptance, accepted, canceled}`（主维度）
  - `wait_state ∈ {none, waiting_on_person, waiting_until, waiting_on_dependency, blocked, on_hold}`（正交维度，与 lifecycle 分列存储）
- `TaskContract { task_id, rev, inputs(spec), expected_outputs(spec), acceptance_criteria[], required_capabilities[], side_effect_ceiling }`：rev 单调递增；被 Run 引用后不可变（INV-5）。
- 结构化程度规则（REQ-TC-1）：人工执行的 Task 允许仅文本契约；**指派给 Agent Executor 的 Task 必须有结构化 `acceptance_criteria`（至少一条可判定条目）与 `expected_outputs`，否则 Scheduler 不得派发**。

### 2.3 TaskEdge

- `TaskEdge { id, project_id, from_task, to_task, kind, data_mode?, pinned_version? }`
- `kind ∈ {depends_on, data_from, part_of, related_to, conflicts_with, supersedes}`。
- INV-2：只有 `depends_on` 参与 DAG 无环校验与 ready 计算；`data_from` 参与输入可用性校验；其余 kind 不影响调度。
- `data_from` 必须带 `data_mode ∈ {pinned, latest_accepted}`；`pinned` 必须带 `pinned_version`（指向具体 Outcome/Artifact 版本）。

### 2.4 Assignment / Run

- `Assignment { id, task_id, actor_id, actor_kind: human|agent, role, scope_note, assigned_at, ended_at? }`：指派与权限分离——Assignment 不授予任何工具权限，权限只来自 Policy + Run 级凭据（K1 完整实现，K0 以 Policy 表判定）。
- `Run { id, task_id, assignment_id, task_rev, contract_rev, plan_rev, input_snapshot(jsonb, 不可变), policy_snapshot(jsonb), actor_id, actor_version, idempotency_key, side_effect_level, state, lease_expires_at?, heartbeat_at?, raw_result_ref? }`
  - `state ∈ {created, queued, leased, running, succeeded, failed, canceled, timed_out, indeterminate}`
  - INV-3：`input_snapshot / policy_snapshot` 写入后禁止 UPDATE（DB 权限 + 触发器双保险，验收以直接 SQL 尝试更新失败为准）。
  - INV-4：每次重试 = 新 Run（新 id、新 idempotency_key），禁止复用旧 Run 记录改状态回 `queued`。

### 2.5 Feedback / Outcome / Evidence / Artifact

- `Feedback { id, task_id?, project_id, author_id, raw_content, raw_attachments[], received_at, interpretation_status: pending|interpreted|failed }`
  - REQ-FB-1：Feedback 入账与解析解耦——原文落库即回执成功，解析失败置 `failed` 待重试，不丢原文。
  - REQ-FB-2（离线）：客户端本地先行落盘并显示"已记录"，同步后以服务端事件为准；同步失败不回滚本地"已记录"显示，只更新同步徽标状态。
- `Outcome { id, run_id?, feedback_id?, task_id, dimensions(jsonb), interpreted_by, proposal_id }`，`dimensions` 必填维度：
  - `info_obtained: boolean`、`conclusion_kind ∈ {achieved, partial, infeasible, no_response, unknown}`、`certainty ∈ {low, med, high}`、`evidence_sufficiency ∈ {sufficient, insufficient, none}`、`blockers: string[]`、`followup_suggestions: string[]`
  - REQ-OC-1：Outcome 只能由 Outcome Interpreter 的提议经内核校验（必填维度齐备 + 引用的 Evidence 存在）后生成；Executor 与人类都不能直接写 Outcome。
- `Evidence { id, task_id, source_kind, content_ref, content_hash, captured_at, environment(text), verification_status: unverified|verified|refuted, supersedes_id? }`
  - `source_kind ∈ {user_statement, agent_claim, tool_output, external_doc, device_log}`
  - INV-6：`source_kind = tool_output` 的记录只能经 Tool Gateway 通道写入（K0 以独立 DB 角色/凭据实现；Agent 适配器的写入路径无此权限）。K0 若 Tool Gateway 未独立成服务（见 Q3），以"网关模块专用凭据 + 审计事件"等价实现，验收标准不变：用 Agent 凭据尝试写入 `tool_output` 必须失败。
  - 纠错只追加：新 Evidence 以 `supersedes_id` 指向旧记录，旧记录不改不删（INV-7）。
- `Artifact { id, run_id, kind, content_ref(对象存储), content_hash, version }`：只存索引，大文件不进 PG。

### 2.6 Acceptance

- `Acceptance { id, task_id, contract_rev, acceptor_id, acceptor_kind, verdict: accepted|rejected|partially_accepted, evidence_refs[], rationale, supersedes_id?, created_at }`
- REQ-ACC-1：Acceptance 必须钉死 `contract_rev`；契约变更后旧 Acceptance 不自动失效，但 Task 达成判定只认**当前 contract_rev 对应的最新有效 Acceptance**（见 REQ-ACC-3）。
- REQ-ACC-2：自动验收只适用于契约中声明为 `auto` 的判据（程序检查类）；其余判据必须由人类或独立评审 actor 给出。**执行该 Run 的 actor 不得担任其 Acceptance 的 acceptor**（内核校验 actor 不等）。
- REQ-ACC-3：Task 是否达成不存布尔字段，由内核按"最新有效 Acceptance（未被 supersede）"重算：`accepted → lifecycle=accepted`；`rejected → lifecycle 回到 defined/active（按 wait 维度另行判定）`；无有效 Acceptance 且已有 Outcome → `awaiting_acceptance`。
- REQ-ACC-4：推翻验收只能追加新 Acceptance 并 `supersedes` 旧的；重算结果以事件 `EVT-AcceptanceSuperseded` 记录，含受影响的下游 Task 列表。

### 2.7 PlanChange / PlanRevision / Policy / WaitCondition / Decision

- `PlanChange { id, project_id, base_plan_rev, ops[], rationale, assumptions[], risk_level, proposer_id, status: proposed|applied|rejected|needs_decision }`；`ops` 为封闭枚举：`add_task, update_task_text, add_edge, remove_edge, reassign, update_contract, cancel_task, add_wait`。
- `PlanRevision { project_id, rev, change_id, applied_at, diff_summary }`：项目计划版本号 `rev` 单调递增（INV-8）。
- `Policy { id, project_id, auto_apply_ceiling(L0|L1), side_effect_grants[], budget_cap?(K0 仅记录不拦截，拦截在 K1), actor_permissions[] }`：Policy 变更只能由人类 actor 发起且走事件（INV-9）。
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
| active | – | – | – | ✓ Run 出 Outcome | – | ✓（须先处理在跑 Run，见 REQ-RUN-6） |
| awaiting_acceptance | ✓ 验收 rejected | – | ✓ 验收 rejected 且需再执行 | – | ✓ 验收 accepted | ✓ |
| accepted | – | – | – | ✓ Acceptance 被 supersede 且新结论未定 | – | – |
| canceled | 终态 | | | | | |

- `captured → defined` 要求：有 title；指派 Agent 时另须满足 REQ-TC-1。
- wait_state 维度独立迁移：任一非终态 lifecycle 可叠加/解除 wait_state；**`accepted`/`canceled` 时 wait_state 必须为 `none`**（INV-11，迁移时内核强制校验）。wait_state ≠ none 时 Scheduler 不派发新 Run（`on_hold`/`blocked` 同理），但不影响已在跑 Run 的回报入账。

### 3.2 Run 状态迁移

| from\to | queued | leased | running | succeeded | failed | canceled | timed_out | indeterminate |
|---|---|---|---|---|---|---|---|---|
| created | ✓ | – | – | – | – | ✓ | – | – |
| queued | – | ✓ 领取 | – | – | – | ✓ | – | – |
| leased | ✓ 租约过期未启动 | – | ✓ 启动回报 | – | ✓ | ✓ | – | ✓ 心跳丢失且已可能产生副作用 |
| running | – | – | – | ✓ | ✓ | ✓ 取消确认后 | ✓ 超时且确认无副作用残留 | ✓ 心跳丢失/进程崩溃 |
| indeterminate | – | – | – | ✓ 对账确认已完成（补录 RawResult） | ✓ 对账确认未执行或已失败 | ✓ 对账后人工取消 | – | – |
| 终态（succeeded/failed/canceled/timed_out） | 不可再迁移（INV-4） | | | | | | | |

- REQ-RUN-1：`leased/running` 必须有 `lease_expires_at` 与心跳续约；心跳间隔与租约时长为配置项，K0 默认值：心跳 15s、租约 45s（假设值，Q4）。
- REQ-RUN-2：进入 `indeterminate` 的 Run，在对账完成前，同一 Task 不得派发同契约范围的新 Run。
- REQ-RUN-3（对账）：对账依据 `idempotency_key` 向 Executor/外部系统查询；三种结论（已执行→补录 RawResult 走正常 Outcome 流；未执行→原 Run 置 failed(原因 `reconciled_not_executed`) 后可新建 Run；无法确定→保持 indeterminate 并产生 Decision 请人裁决）。

---

## 4. 事件目录 v1（EVT）

事件信封：`{ id(ULID), stream_id, seq, type, actor_id, actor_kind, causation_id, correlation_id, idempotency_key, payload, prev_hash, hash, occurred_at, recorded_at }`。

INV-12：同 stream 内 `seq` 严格递增；`hash = H(prev_hash ‖ payload ‖ seq)`；任何投影必须能由事件流重演得到（验收 C5）。
INV-13：携带 `idempotency_key` 的外部事件重复投递只入账一次（唯一索引 + 返回首次结果）。

K0 事件类型（封闭集，新增类型须走 spec 修订）：
`ProjectCreated, GoalCreated, TaskCaptured, TaskDefined, ContractUpdated, EdgeAdded, EdgeRemoved, PlanChangeProposed, PlanChangeApplied, PlanChangeRejected, PlanRevisionCreated, AssignmentCreated, AssignmentEnded, RunCreated, RunQueued, RunLeased, RunStarted, RunHeartbeat, RunRawResultReceived, RunSucceeded, RunFailed, RunCanceled, RunTimedOut, RunIndeterminate, RunReconciled, FeedbackReceived, FeedbackInterpreted, OutcomeRecorded, EvidenceAdded, EvidenceSuperseded, AcceptanceRecorded, AcceptanceSuperseded, WaitConditionCreated, WaitConditionSatisfied, WaitConditionExpired, DecisionCreated, DecisionResolved, DecisionExpired, PolicyUpdated, TimerFired, ProjectionRebuilt`

---

## 5. 核心协议需求

### 5.1 PlanChange 校验流水线（REQ-PC）

- REQ-PC-1：校验顺序固定且全部通过才应用：Schema → `base_plan_rev` = 当前 rev（不等 → 冲突，返回三方差异基线/当前/提议，不自动重试覆盖）→ 图校验（DAG、边 kind 合法、迁移矩阵）→ Policy（proposer 权限 + 风险级 ≤ `auto_apply_ceiling`）→ 预算占位（K0 仅记录）→ 幂等（同 `proposal_id` 重放返回首次结果）。
- REQ-PC-2：原子性——一个 PlanChange 的 ops 要么全应用并产生恰一个 PlanRevision，要么不应用；不允许部分应用。
- REQ-PC-3：校验不过且属"可由人裁决"类（权限/风险超限、版本冲突）→ 产生 Decision 并置 `needs_decision`；属"结构错误"类 → 置 `rejected` 并记录原因码（封闭枚举：`schema_invalid, base_rev_conflict, dag_cycle, illegal_edge, policy_denied, budget_exceeded, duplicate`）。
- REQ-PC-4：已启动 Run 引用的 `plan_rev/task_rev/contract_rev` 不受新 Revision 影响（由 INV-3/INV-5 快照保证）；新 Revision 只影响此后创建的 Run。

### 5.2 Scheduler（REQ-SCH）

- REQ-SCH-1：ready 判定 = `lifecycle=defined ∧ depends_on 全部满足（上游 Task 当前 contract_rev 的 Acceptance=accepted，或 Edge 上显式 `release_override` 由人类置位）∧ data_from 可用（pinned 版本存在 / latest_accepted 指针非空）∧ wait_state=none ∧ Policy 未拦截`。判定逻辑只在内核一处实现，投影与 API 不得各自重算出不同结论（投影可用缓存，但以内核判定事件为准）。
- REQ-SCH-2：`latest_accepted` 指针 = 该 Task 最新有效 Acceptance 对应 Outcome/Artifact；指针移动（新验收或 supersede）产生事件并触发下游 ready 重算。
- REQ-SCH-3：定时器全部持久化（WaitCondition.due_at、租约、Decision 过期）；进程重启后 Timer 服务按持久化记录恢复触发，不用内存计时承载业务时间。验收：杀进程重启后到期 WaitCondition 仍被触发（C4）。

### 5.3 去重（REQ-DD）

- REQ-DD-1（确定性自动）：同 `idempotency_key` 事件、同 WaitCondition 唯一性（INV-10）、同 Feedback 客户端提交 id 重放——自动去重，不产生第二份实体。
- REQ-DD-2（结构指纹）：同 Project + 同 assignee + 标题归一化（去空白/标点/大小写）哈希命中 → 新 Task 自动标记 `duplicate_suspect` 并挂起（不进 ready），产生 Decision 供人确认合并或放行。
- REQ-DD-3（语义相似）：K0 不实现自动语义去重；接口预留，语义判断永不自动合并（原则入 spec，防后续偷工）。

### 5.4 Guidance（K0 最小版，REQ-GD）

- REQ-GD-1：K0 只实现 hard 轨的子集：`require_decision_for[]`（动作类别枚举）、`auto_apply_ceiling`（落在 Policy）、`allowed_actors[]`。soft 自然语言原文只存不执行（进 Planner 上下文属 K1）。
- REQ-GD-2：hard 规则的新增/修改只能由人类 actor 经 PolicyUpdated 事件生效；Proposer 提出的 hard 规则变更一律转 Decision。

### 5.5 上下文组装（K0 最小版，REQ-CX）

- REQ-CX-1：Run 的 `input_snapshot` 由内核组装，内容顺序与来源固定：契约与输入（钉死 rev）> 目标陈述与 hard 规则 > 上游已验收 Outcome/Evidence（带 captured_at 与 environment）> 本 Task 历史 Run 的 RawResult 摘要（最近 3 个；被 supersede 的 Evidence 必须显式标注"已推翻"）。
- REQ-CX-2：K0 不做 token 预算裁剪（上下文规模假设见 §7），但组装结果必须完整落快照，事后可复盘"Agent 当时看到了什么"。

### 5.6 双轨对照（D4，REQ-DT）

- REQ-DT-1：导入器读取 pipeline run 的 CHAIN.json 与阶段产物目录，映射：run → Project；phase → Task（`depends_on` 按 phase 顺序）；phase 执行 → Run（actor = 该 phase 的模型/session）；评审 verdict → Acceptance（评审 actor ≠ 执行 actor 时满足 REQ-ACC-2）；阶段产物文件 → Artifact/Evidence（`source_kind=tool_output` 仅限导入器以网关凭据写入，或降级为 `external_doc`，二选一在实现前定，见 Q3）。
- REQ-DT-2：导入只读、幂等（同 run 重复导入不产生重复实体，以 run-id + phase 为幂等键）；对照报告输出"映射成功/无法映射"清单——无法映射的条目就是领域模型的缺陷证据，计入 K0 退出评审。

---

## 6. 投影与入口（最小形态）

- REQ-PJ-1：Home / MyActions / Project 三个投影由事件消费者维护；每个 Task 在投影中带 `available_actions[]`（由内核按 lifecycle/wait_state/actor 角色算出），前端只渲染不自算状态逻辑。
- REQ-PJ-2：MyActions 只含 `actor=当前用户 ∧ (可执行[ready/active 且 wait_state=none] ∨ 待其决策的 Decision)` 的条目；等待他人/Agent 的条目不入此投影。
- REQ-PJ-3：Capture 提交后 1 次请求内返回"已记录"回执（含本地 id 映射），分类/结构化以异步事件补齐，界面以"已记录，整理中"区分于"已成 Task"。

---

## 7. K0 量级假设（标注为假设，非承诺）

单用户、单机内核实例；Project ≤ 20 个活跃；单 Project Task ≤ 500、事件总量 ≤ 50 万/年；并发 Run ≤ 8。此假设支撑 REQ-CX-2（不裁剪）与单 PG 选型；超出时先修订 spec 再扩容。

---

## 8. 验收（K0 退出标准）

### 8.1 Golden Scenarios（源自蓝图 §4 旅程）

- **G1（旅程 4.2，第一 conformance）**：Task"联系张三确认方案"：Run A 回报联系尝试 → Outcome `conclusion_kind=no_response, info_obtained=false` → Task 进 `waiting_on_person` + 恰一个 active WaitCondition + 恰一个跟进 Task；同 Feedback 重放 10 次，跟进仍恰一个（REQ-DD-1/INV-10）。第二次 Feedback 给出转述意见 → 记录为 `user_statement` 来源 Evidence；Outcome `info_obtained=true`；验收 accepted 后 Task=accepted；系统提议的新 Task（联系李四/UDP 实测）以 PlanChange 呈现，未经应用不入图。
- **G2（旅程 4.5）**：Run 执行中应用 PlanChange 改计划：在跑 Run 的 `input_snapshot` 哈希前后不变；新 Run 使用新 `plan_rev`；旧 Revision 与旧 Run 历史可完整查回。
- **G3（旅程 4.1 局部）**：模糊输入 → Captured → Interpreter 提议计划草稿（PlanChange）→ 人批准应用 → 派发代码 Agent Run → Run succeeded + Outcome `infeasible`（方案不可行）+ Acceptance accepted 三者同时成立（四分关系试金石）。
- **G4（旅程 4.3）**：Agent Task 产出测试方案后，子 Task 指派人类：MyActions 投影出现该条且带 `available_actions`；人类 Feedback 附日志（Evidence `device_log`）→ 未过判据只重开对应子 Task，已过判据不回退。
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

## 9. 开放问题（load-bearing，contract-review 重点看这里）

| # | 问题 | 本文默认假设 | 若假设错的影响 |
|---|---|---|---|
| Q1 | `partially_accepted` 时 Task 的 lifecycle 落点：回 active 还是停在 awaiting_acceptance 等补充？ | 停在 `awaiting_acceptance`，由后续 Acceptance 决定 | 影响 §3.1 矩阵与 G4 断言 |
| Q2 | `release_override`（依赖未验收先放行）是否进 K0？ | 进（人类置位、走事件），否则调研类长链会被验收卡死 | 不进则 Scheduler 逻辑更简，但真实负载（D4）可能大量任务堵在 awaiting |
| Q3 | Tool Gateway 在 K0 是独立服务还是内核模块？双轨导入的 Evidence 来源等级随之定 | 内核模块 + 专用凭据（INV-6 的等价实现） | 独立服务增加部署复杂度，但 K1 抽离成本低 |
| Q4 | 租约/心跳默认值（15s/45s）对 CLI 型 Agent（单次运行可达数小时、进程内无心跳）是否成立？ | 适配器负责代发心跳（包裹层进程存活即心跳） | 若适配器无法代发，长 Run 会被误判 indeterminate，需改"外部进程存活探针"模式 |
| Q5 | Outcome 的 `dimensions` 封闭维度集是否够用（尤其调研类与沟通类之外）？ | K0 先封闭，扩维度走 spec 修订 | 过窄会逼 Interpreter 把信息塞进 blockers 文本，污染后续判定 |

---

*本 spec 经 contract-review（独立评审、与作者不同上下文）通过后冻结为 v1.0；修订走版本递增 + 变更记录，不静默改冻结版。*
