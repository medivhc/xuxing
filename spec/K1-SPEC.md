# K1 Spec — 决策闭环 / 本地执行节点最小形态 / 基础访问控制

```
artifact: spec
based_on: 80a09c1
sha256: dfaf78ea911955255124fdbb1c9f813100d0c9a93f748ffca2291e057bfd0d7e
verdict: APPROVED（第二轮异构复审，R-01~R-10 全闭环；v0.3 含复审 MINOR 收敛修订，见 §0 修订记录；v0.4 协调者裁决登记版为 K1 develop 执行基线）
counts: K1-A 验收 12 条 / K1-B 验收 12 条 / K1-C 验收 9 条 / e2e 旅程 4 条
producer: Muse（协调者侧 spec 作者会话）+ 依据文件见 §0
```

## 0. 元信息与依据

- 状态：v0.4，2026-10-24，**已通过异构 contract-review（APPROVED）+ 协调者裁决登记（见修订记录 v0.4 条）**，为 K1 develop 执行基线。本文件是 K1 的唯一 spec 正本；实现与验收只认本文件 + 下列依据，冲突时以冻结 K0 spec 的领域语义为准、本文件只在其上增量。
- 修订记录：v0.4 —— 协调者裁决登记（2026-10-24，K1 develop 开工前，经协调者指令落盘）：① **OQ-K1-1 维持**——`approved_modified` 前端不提供改 ops 表单（§1.2 / §3.4 口径不变，K1 只要求 API 可达 + 事件正确）。② **OQ-K1-2 维持**——裁决审计只用冻结目录既有 `DecisionResolved` 事件，不新增 `DecisionRecorded` 平行事件（§3.3 口径不变）。③ **OQ-K1-3 采纳分离**——节点令牌与用户令牌分离：新增环境变量 `XUXING_NODE_TOKEN`（节点令牌），用户令牌 `XUXING_ACCESS_TOKEN` 只护用户面、节点令牌只护节点面（注册 / 心跳 / 注销 / 长轮询与全部 Run 回报端点），**双令牌互不通用**（用户令牌调节点面 → 401、节点令牌调用户面 → 401）；落点 §5.1 / §5.2 / §5.3 / §4.2 / §4.5 / §4.6 / K1C-AC-09 同步修订。④ **OQ-K1-4 维持 spec 明示口径**——deferred 唤起条件 `at_time` 为必备、`on_event` 为可填（§3.2 / §3.7 口径不变，不静默缺失）。§7 四条开放问题自本版起全部关闭。
- 修订记录：v0.3 —— 第二轮复审 APPROVED 后按其 3 条新 MINOR 做收敛修订（无语义扩展，均为评审员建议原文）：N-01 §2 错误码清单交叉引用笔误（§3.6/§5.4 → §3.5/§5.3）；N-02 §4.7 终态迟到回报行合并覆盖 probe-result；N-03 side-effect-note 请求体加 `client_note_id` 幂等键。因本修订在 APPROVED 之后，最终正文 sha 与复审所验 sha（72930b40…）不同，差异即本条所列三处，协调者可按图复核。
- 修订记录：v0.1 初稿 → v0.2 按第一轮异构 contract-review（`K1-SPEC-REVIEW.md`，gemini-3.8-flash，CHANGES_REQUESTED，BLOCKER 2 / MAJOR 4 / MINOR 4）逐条修订：R-01 补 probe 对账通道（poll 下发 `probe_requests` + probe-result 端点，§4.3 第 6 步 / §4.5）；R-02 中间件豁免补 `POST /api/auth/session`（§5.3）；R-03 删除 `kind:"proposal"` 平行通道，待决提案收敛为关联 Decision（§3.6 / K1A-AC-12）；R-04 写死 `Run.state_reason="awaiting_node"` 与节点 401 退避行为（§4.4 / K1C-AC-09）；R-05 `disposition` 入 §3.2 schema 与 §3.5 失败表；R-06 节点事件入 `$system` 流 + payload 写死、side-effect-note 定为 `RunSideEffectRecorded` 事件（§4.2 / §4.4）；R-07 交叉引用笔误修正（§3.2）；R-08 §4.7 补迟到 ack / 终态迟到 raw-result / 注销在跑 Run 三分支；R-09 poll 顶层响应统一对象（§4.3）；R-10 信封改 `lease_duration_sec`、绝对到期时间经 ack 响应下发（§4.3）。
- 依据（均为已定版，不在本文件重议）：
  - 《续行 K0 领域 spec 冻结版 v1.0》（`~/workspace/xuxing/spec/K0-SPEC-FROZEN-v1.0.md`）：Decision 实体 §2.7、REQ-PC-5 决策回路、REQ-DC-1、REQ-RUN-1/3/4、REQ-PJ-1/2、§4 事件目录、INV-13 幂等。
  - 《交互契约 v0.2》（仓库 `docs/interaction-contract.md`，D11 裁决 11 条 OQ 全关闭）：§2.2 Home attention 六类、My Actions §4（M-A4 `resolve_decision` 动作语义已在契约层定义、服务端无对应实现，即本 spec K1-A 的缺口本体）、错误词表。
  - 《三阶段 + K1 并行推进计划》（`goals/k0/hidden_files/PHASES-PLAN-1024.md` 轨道 T5）：范围裁决与 E2E 硬门（真服务、在场 + 可点 + 状态真变、禁 mock 轮交差）。
  - 《评审+技术方案 v1》§2.12：K1 在工程切片中的位置（本 spec 只取其中与 T5 裁决重合的子集，见 §1.2 非范围）。
- 基线：develop `80a09c1`。服务端命令面现状（基线实查）：`POST /api/commands` 信封 `{type, payload, client_submit_id, actor{actor_id, actor_kind}}`，已有命令含 `accept_proposal` / `reject_proposal` / `task_advance` / `task_cancel` 等；**无 `resolve_decision`**；前端 MyActionsPage 中决策行动作入口已下线并标注契约缺口（FIX-ROUND-1 R-1）。

## 1. 范围与非范围

### 1.1 范围（本 spec 全部内容，缺一不可交付）

- **K1-A 决策闭环**：`resolve_decision` 命令（接受 / 拒绝 + 理由）、裁决审计事件、裁决后按 subject 类型产生真实任务图变化、My Actions 收待决事项（Decision；待决提案按 REQ-PC-3 经其关联 Decision 收录，不另设条目类型，见 §3.6）、前端裁决交互。
- **K1-B 本地执行节点最小形态**：执行适配层接口、节点注册 / 心跳、Run 派发 → 节点执行 → 事件回传（首执行器 = agent-hands 容器）、节点离线时 Run 挂起不丢、恢复后续派。
- **K1-C 基础访问控制**：服务端令牌中间件 + 前端入口门、令牌经环境变量注入、未授权拦截口径。令牌为**双令牌按面分离**（v0.4 裁决 OQ-K1-3）：用户令牌护用户面、节点令牌护节点面，互不通用（§5）。

### 1.2 非范围（明确不做，写进 spec 防蔓延）

- 多用户 / 权限矩阵 / 按用户数据隔离（K1-C 是**部署面双令牌**（用户 / 节点按面分离），不是账号体系；actor 仍沿用现有 `actor_id/actor_kind` 字段，不做认证绑定）。
- Temporal 或任何外部工作流引擎（D3 不变）。
- 移动端形态。
- 副作用 L2/L3 放行（Policy 的 L2 判定接口仍不实际放行；K1-B 首执行器只承接 L0/L1，见 §4.2 能力声明）。Budget 拦截、Tool Gateway 抽离为独立服务、上下文组装器完整版——属技术方案 K1 大筐但**不在 T5 裁决范围**，不做。
- `approved_modified` 的前端表单（OQ-04=B 在 K0 的口径延续到 K1-A 前端：不在 UI 提供改 ops 表单；其内核语义按 REQ-PC-5 走 API 提交新 PlanChange，见 §3.4 与开放问题 OQ-K1-1）。

## 2. 通用约定（三项共用）

- **命令信封复用**：K1 新增命令一律走既有 `POST /api/commands` 信封与幂等口径：同 `client_submit_id` 重放返回首次结果、不产生新事件（INV-13）。禁止另开平行写入口（节点面 §4.4 的节点通道是唯一例外，因其调用方是节点进程而非用户/前端，且只承载 Run 协议消息、不承载领域命令）。
- **错误词表复用**：错误响应沿用交互契约既有词表（`precondition_unmet` / `terminal_state` / `base_rev_conflict` / `decision_expired` / `not_found` 等）+ HTTP 状态码口径（409 = 状态冲突类、404 = not_found、401 = 未授权 §5）。K1 新增错误码只许增补进 §3.5/§4.7/§5.3 的封闭清单，不许各端点自创。
- **事件入流口径**：K1 新增的领域事实一律以事件入事件流（可重演、进审计）；心跳类高频信号**不是**领域事件（沿用 REQ-RUN-1 先例：只更新行状态、不占 seq、不进哈希链）。
- **actor 口径**：命令 actor 沿用现状（前端提交 `actor_id/actor_kind`）；K1-C 令牌只证明「持有部署令牌」，不证明 actor 身份——两者不得混同（actor 字段的可信度问题属 actor 分离批 T4 范围，不在 K1）。

## 3. K1-A 决策闭环

### 3.1 现状与缺口

- Decision 实体已在冻结 spec §2.7 定义：`Decision { id, project_id, subject_ref, question, recommendation, alternatives[], evidence_refs[], status: pending|approved|approved_modified|rejected|deferred|expired, decided_by?, decided_at? }`；事件目录已有 `DecisionCreated / DecisionResolved / DecisionExpired`。
- Decision 的**产生**路径已存在（REQ-PC-3 可裁决类校验不过、REQ-RUN-3 对账无法确定、REQ-DD-2 疑似重复、REQ-ACC-5 上游验收失效等）。
- 缺口：① 无 `resolve_decision` 命令，Decision 永远停在 pending；② My Actions 投影不收 Decision 与待决提案（与 REQ-PJ-2 的应然口径不符，属实现缺口）；③ 前端无裁决交互（入口已下线）。

### 3.2 命令：`resolve_decision`

```
POST /api/commands
{ type: "resolve_decision",
  client_submit_id: <string, 必填>,
  actor: { actor_id, actor_kind: "human" },        // 非 human → 403 actor_not_human（§3.5）
  payload: {
    decision_id: <string, 必填>,
    verdict: "approved" | "rejected" | "deferred", // 封闭枚举；approved_modified 不走本命令（§3.4）
    reason: <string>,                               // rejected 必填非空；approved/deferred 可空（deferred 见下）
    wake_condition?: { kind: "at_time", at: <ISO8601> } | { kind: "on_event", event_type: <string> }
                                                    // verdict=deferred 时必填（REQ-PC-5：deferred 必须带唤起条件）
    disposition?: "executed" | "not_executed" | "cancel_run"
                                                    // 仅 subject 为 Run 对账（REQ-RUN-3）且 verdict=approved 时必填，见 §3.4/§3.5
  } }
```

处理顺序（固定，全部通过才落盘）：存在性（decision 不存在 → 404 `not_found`）→ 状态（非 pending → 409，见 §3.5）→ 入参校验（枚举 / reason / wake_condition / disposition，违反 → 400 `schema_invalid`）→ 幂等（同 `client_submit_id` 重放返回首次结果，零新事件）→ 落盘（§3.3）。

### 3.3 裁决落盘与审计

一次成功裁决在**同一事务**内追加：

1. `DecisionResolved` 事件：payload 必须含 `{ decision_id, project_id, verdict, reason, decided_by (=actor_id), subject_ref, resolved_at }`。**本事件即 PHASES-PLAN 所称「DecisionRecorded 入审计」的落点**——裁决事实以 `DecisionResolved` 为唯一审计记录，不另设平行事件（命名对齐问题登记为开放问题 OQ-K1-2）。
2. Decision 投影行更新：`status ← verdict`（deferred → `deferred` 并落 `wake_condition`）、`decided_by/decided_at` 落值。
3. 按 subject 类型的后续效果（§3.4）产生的事件，与上两项同事务提交或全不提交（不许出现「Decision 已裁决但图未变」的半成品状态被投影读到）。

### 3.4 裁决后效果（按 subject_ref 类型封闭枚举）

| subject 类型 | approved | rejected | deferred |
|---|---|---|---|
| PlanChange（`needs_decision`） | 原 Change 以**裁决时刻当前 rev** 为新 base 重走 REQ-PC-1 完整校验：通过 → 应用（`PlanChangeApplied` + ops 落图 + `PlanRevisionCreated`，任务图真变化）；不过（版本冲突类）→ 生成**新** Decision（pending）并说明冲突，原 Change 维持 `needs_decision` | Change 置 `rejected`，原因码 `decision_rejected`，发 `PlanChangeStatusChanged` | Change 维持 `needs_decision`；唤起条件满足时 Change 回 `proposed` 并以唤起时刻当前 rev 重走 REQ-PC-1（REQ-PC-5 口径） |
| Run 对账（REQ-RUN-3「无法确定」） | approved 的语义固定为**按裁决者声明的处置执行**：处置以 payload `disposition` 字段提交（封闭枚举 `executed` / `not_executed` / `cancel_run`，仅此 subject 类型必填，缺失 / 非法 → 400，见 §3.5）；内核按处置补录 RawResult 走正常 Outcome 流（`executed`）/ 置 failed(`reconciled_not_executed`) 后可新建 Run（`not_executed`）/ 置 Run `canceled` 并推进挂起的 Task 取消第③步（`cancel_run`，REQ-RUN-6 P2-1 路径） | rejected = 暂不处置：Run 维持 `indeterminate`，Decision 仍记已裁决（新处置需求须由后续对账轮次产生新 Decision，不复活旧 Decision） | 同 rejected 的维持语义 + 唤起条件（如到期提醒再裁决） |
| 疑似重复（REQ-DD-2） | = 确认重复并合并：被疑 Task 走 REQ-RUN-6 级联置 `canceled`（原因 `duplicate_merged`），其未决事项以 PlanChange 并入目标 Task | = 放行：被疑 Task 置 `duplicate_suspect=false`（`TaskDuplicateResolved`），恢复正常 ready 判定 | 维持 `duplicate_suspect=true` 挂起 + 唤起条件 |
| 其他 subject（验收失效 REQ-ACC-5 ④ 等） | 按各产生路径在冻结 spec 中已写明的裁决出路执行；本 spec 不新造出路。产生路径未写明出路的 Decision，`resolve_decision` 拒绝并返回 409 `subject_not_resolvable_in_k1`（诚实边界，不许静默吞掉） | 同左 | 同左 |

- `approved_modified`：不经本命令。裁决者按 REQ-PC-5 提交**新** PlanChange（新 id、`supersedes_change_id` 指向旧 Change），旧 Change 置 `rejected`（原因码 `superseded_by_decision`），关联 Decision 随旧 Change 的 supersede 置 `approved_modified` 并发 `DecisionResolved`（verdict 字段记 `approved_modified`、reason 必填说明修改点）。该路径 K1 只要求 API 可达 + 事件正确，前端不提供表单（§1.2）。
- `expired`：Decision 过期由既有 Timer 机制产生（`DecisionExpired`）；过期后 `resolve_decision` 一律 409 `decision_expired`，**过期不等于批准**（REQ-DC-1），不得产生任何后续效果。

### 3.5 失败语义（封闭）

| 情形 | 结果 |
|---|---|
| decision_id 不存在 / 不属当前部署数据域 | 404 `not_found`，零事件 |
| Decision 已裁决（approved/rejected/deferred/approved_modified）后再次裁决（不同 client_submit_id） | 409 `terminal_state`，响应体带当前 status 与 decided_by/decided_at，零新事件 |
| Decision 已 expired | 409 `decision_expired`，零新事件、零效果 |
| 同 client_submit_id 重放 | 返回首次结果（200 + 首次响应体），零新事件（INV-13） |
| verdict=rejected 且 reason 空 | 400 `schema_invalid`（字段级指出 reason） |
| verdict=deferred 缺 wake_condition | 400 `schema_invalid` |
| subject 为 Run 对账、verdict=approved 但 disposition 缺失或不在枚举内 | 400 `schema_invalid`（字段级指出 disposition），零事件 |
| actor_kind ≠ human | 403 `actor_not_human`（裁决是人类-only 动作，与 REQ-SCH-5 人类-only 先例同口径） |
| approved 后重走校验撞 base_rev_conflict | **不是命令失败**：命令成功（Decision 已裁决落盘），效果按 §3.4 生成新 Decision；响应体须明示 `follow_up_decision_id` |

### 3.6 投影：My Actions 收待决事项

- `/api/actions` 投影只增补一类条目（条目封闭联合维持交互契约 §4.2 的 `task | decision`，**不新增 kind**）：`kind: "decision"`——每个 `status=pending` 且 subject 归属当前用户的 Decision 一条，字段至少含 `{ decision_id, project_id, subject_ref, question, recommendation, alternatives[], evidence_refs[], created_at, rank, available_actions: ["resolve_decision"] }`（与既有 task 条目同列、由内核 rank 统一排序，前端只渲染不自算）。
- **待决提案的收录口径（与 REQ-PC-3 对齐，不设平行通道）**：需人工确认的 PlanChange 按 REQ-PC-3 置 `needs_decision` 并产生关联 Decision（`subject_ref` 指向该 Change），因此它在 My Actions 中就是上一条的 decision 条目，经 `resolve_decision` 裁决、按 §3.4 第一行回路生效。**不存在** `status=proposed` 停在 actions 里待批的平行状态，也不在 actions 中提供 `accept_proposal / reject_proposal` 通道（该组命令在提议详情面的既有行为不变，与 actions 无关）。
- Home attention 的 `decision_pending` 类与 My Actions 的 decision 条目必须同源同数（同一投影计算，不许两处各算一份）。
- Decision 被裁决 / 过期后，条目在投影重演后消失（SSE 推送刷新）；前端不得本地缓存裁决结果冒充投影。

### 3.7 前端裁决交互

- My Actions 中 decision 条目可展开裁决面：展示 question / recommendation / alternatives / evidence_refs（与交互契约 M5 `M-DECISION` 一致），提供「批准 / 拒绝 / 暂缓」三动作；拒绝必须填理由（空理由前端拦截 + 服务端兜底 400）；暂缓必须选唤起条件（时间型为 K1 必备，事件型可选填 event_type 文本）。
- 提交走 `resolve_decision` 命令 + `client_submit_id`（前端每次打开裁决面生成一个，提交重试复用同一个，保证幂等）。
- 结果呈现：成功 → 条目消失 + 若 §3.4 产生了任务图变化，项目页任务列表 / 任务图在 SSE 刷新后可见变化（e2e 断言口径见 §6 J1）；409 → 进入冲突态展示最新 status（交互契约 M8），不自动重试、不覆盖；`decision_expired` → 展示「已过期，未执行」。
- 项目页 / 提议页既有的决策占位卡（Fix Round 4 处理中的下线占位）在 K1-A 上线时由真实裁决面取代，**不许双轨并存**。

### 3.8 K1-A 验收标准（逐条可判定）

- K1A-AC-01：构造 PlanChange `needs_decision` → Decision pending；调 `resolve_decision(approved)` 成功后，事件流中存在恰一条 `DecisionResolved`（payload 含 verdict/reason/decided_by/subject_ref），且 PlanChange 被应用、目标 Task 在投影中存在（任务图真变化，API 回读断言）。
- K1A-AC-02：同上但 verdict=rejected + reason 非空 → Change `rejected` 原因码 `decision_rejected`，图无变化（Task 计数与裁决前一致）。
- K1A-AC-03：rejected 且 reason 为空 → 400 `schema_invalid`，事件流零新增。
- K1A-AC-04：对已裁决 Decision 用新 client_submit_id 再裁决 → 409 `terminal_state` 且响应带当前 status；同 client_submit_id 重放 → 200 返回首次结果且 `DecisionResolved` 仍恰一条。
- K1A-AC-05：Decision 过期后裁决 → 409 `decision_expired`，且不产生任何应用 / 图变化（REQ-DC-1）。
- K1A-AC-06：actor_kind=agent 提交裁决 → 403 `actor_not_human`，零事件。
- K1A-AC-07：approved 时 base rev 已被其他 Change 推进 → 命令成功、原 Change 未应用、产生新 pending Decision，响应含 `follow_up_decision_id`（批准不绕过校验）。
- K1A-AC-08：deferred 无 wake_condition → 400；带 at_time 唤起 → 到期后 Change 回 proposed 并重走校验（Timer 持久化口径，进程重启后仍触发，对齐 REQ-SCH-3 验收法）。
- K1A-AC-09：Run 对账 Decision 裁决 disposition=cancel_run → Run 置 canceled，挂起的 Task 取消流程推进至正式 canceled（REQ-RUN-6 第③步事件在流中可见）。
- K1A-AC-10：疑似重复 Decision：approved → 被疑 Task canceled（原因 `duplicate_merged`）；另一构造 rejected → `duplicate_suspect=false` 且 Task 可进 ready。
- K1A-AC-11：存在 pending Decision 时 `GET /api/actions` 含对应 `kind=decision` 条目且 `available_actions` 含 `resolve_decision`；裁决后重查条目消失；Home attention `decision_pending` 计数与 actions 中 decision 条目数相等。
- K1A-AC-12：需人工确认的 PlanChange（REQ-PC-3 置 `needs_decision`）在 `/api/actions` 中以其关联 Decision 的 `kind=decision` 条目出现（`subject_ref` 指向该 Change），经 actions 裁决后按 §3.4 回路生效；actions 条目 kind 集合恒为 `task | decision`（负向断言：不存在 `kind=proposal` 条目）。

## 4. K1-B 本地执行节点最小形态

### 4.1 定位与概念

D1 定版形态：内核在云端做事实来源，执行节点在用户侧机器 / 容器内干活。K1-B 做**最小形态**：一个节点进程（node agent）+ 一个执行器（agent-hands 容器），把 K0 已在同进程内跑通的 Run 协议（租约 / 心跳 / 对账）搬到跨进程通道上，语义不新造。

- **Node**：一个执行节点实例。字段：`{ node_id, display_name, executor_kinds[], max_side_effect_level, status: online|stale|offline, registered_at, last_heartbeat_at, agent_version }`。node_id 由节点首次注册时服务端生成并返回，节点持久化保存（节点侧本地文件），重启复用同一 node_id。
- **ExecutorAdapter（执行适配层接口）**：节点内每个执行器实现同一接口，内核与节点协议只认接口不认实现：
  ```
  interface ExecutorAdapter {
    kind: string;                                   // 如 "agent_hands_shell"
    capabilities(): { max_side_effect_level: "L0"|"L1", run_kinds: ["executor"] };
    dispatch(env: DispatchEnvelope): Promise<{ accepted: true } | { accepted: false, reason: string }>;
    cancel(run_id: string): Promise<{ confirmed: boolean }>;
    probe(run_id: string): Promise<"executed" | "not_executed" | "unknown">;   // REQ-RUN-3 对账查询面
  }
  ```
  接口是 K1-B 的接缝：第二个执行器（如本机 opencode）接入只许实现接口 + 注册新 kind，不许改内核派发逻辑。
- **agent-hands 首执行器**：`kind = "agent_hands_shell"`，执行体为 agent-hands 容器（xc 上 ah1，经既有通道可达）：节点 agent 收到派发后在容器内以 tmux 会话执行 Run 的 input_snapshot 指定的命令 / 任务书，产物与输出按 RawResult 回传（大产物只传引用 ref + 摘要，沿用 `raw_result_ref` 口径）。

### 4.2 节点注册与心跳

- 注册：节点启动时 `POST /api/nodes/register` `{ display_name, executor_kinds, capabilities, agent_version, node_id? }`（带 node_id = 重注册 / 恢复）。服务端校验**节点令牌**（§5，`XUXING_NODE_TOKEN`；节点以 Bearer 节点令牌调用节点面全部端点，与用户令牌互不通用）。成功返回 `{ node_id }` 并发 `NodeRegistered` 事件（注册是低频管理事实，入流；重注册同 node_id 只更新行、不重复发事件，幂等）。
- **节点事件的流归属与 payload（写死）**：节点是跨项目基础设施实体，不属任何 project；节点管理事件一律写入固定系统流 **`stream_id = "$system"`**（`$system` 是 K1 引入的保留流名，不得被任何 project 使用；该流不参与项目投影，只供审计与节点读面消费——这是对 INV-12「stream_id = project_id」的显式增补，须在实现时同步登记进契约文档）。`NodeRegistered` payload：`{ node_id, display_name, executor_kinds[], max_side_effect_level, agent_version, registered_at }`；`NodeOffline` payload：`{ node_id, reason: "deregister" | "heartbeat_timeout", at }`（非优雅消失由存活判定在投影层收敛时补发本事件、reason=heartbeat_timeout，保证审计完整）。
- 心跳：节点每 **10s**（配置项 `XUXING_NODE_HEARTBEAT_SEC`，默认 10）`POST /api/nodes/:node_id/heartbeat` `{}`。心跳**不入事件流**（§2 通用约定），只更新 `last_heartbeat_at`。
- 存活判定（服务端计算，投影暴露）：`now - last_heartbeat_at ≤ 30s` → online；`≤ 90s` → stale；`> 90s` → offline。阈值是配置项（`XUXING_NODE_STALE_SEC/ OFFLINE_SEC`），默认值写死如上，验收按默认值判定。
- 节点注销：优雅退出时 `POST /api/nodes/:node_id/deregister` → 立即置 offline 并发 `NodeOffline`（reason=deregister）；非优雅消失由存活判定收敛到 offline 并补发 `NodeOffline`（reason=heartbeat_timeout，见上）。注销时在跑 Run 的处理见 §4.7（leased 未 started 的释放回 queued；已有 started 的拒绝注销）。节点从 offline/stale 恢复心跳 → 自动回 online（无需重注册）。

### 4.3 Run 派发协议（内核 → 节点 → 内核）

通道形态：**节点出站长轮询**（节点主动向服务端拉取，服务端不反向连接节点——节点可在 NAT / 容器后，无入站可达性假设）：

1. 节点循环 `GET /api/nodes/:node_id/dispatch-poll?wait=25`（长轮询）。**顶层响应结构固定为统一对象**（不随内容变形态）：
   ```
   { dispatch: DispatchEnvelope | null,
     cancel_requests: string[],                                  // run_id 列表，见第 5 步
     probe_requests: Array<{ run_id, idempotency_key }> }        // 对账请求，见第 6 步
   ```
   长轮询 25s 内无任何内容时返回 `{ dispatch: null, cancel_requests: [], probe_requests: [] }`。有待派 Run 时 `dispatch` 为：
   ```
   { run_id, idempotency_key, task_id, assignment_id, task_rev, contract_rev, plan_rev,
     input_snapshot, policy_snapshot, side_effect_level, executor_kind, lease_duration_sec }
   ```
   （信封只带租约**时长**：租约在 ack 时才起算，绝对到期时间 `lease_expires_at` 由 ack 响应下发，见第 2 步。）
2. 节点按 executor_kind 路由到本地 adapter `dispatch()`：接受 → `POST /api/nodes/:node_id/runs/:run_id/ack` → 服务端发 `RunLeased`（租约自 ack 时刻起算、时长 = 信封 `lease_duration_sec`、默认 45s，REQ-RUN-1 口径），ack 的 200 响应体为 `{ lease_expires_at }`，同一绝对到期时间同时写入 `RunLeased` 事件 payload；拒绝（能力不符 / 本地忙）→ `POST .../runs/:run_id/nack { reason }` → Run 回 `queued` 等下个节点 / 周期，nack 不算失败、不计重试惩罚。
3. adapter 真正启动执行后回 `POST .../runs/:run_id/started` → `RunStarted`。执行期间节点代发 Run 级心跳 `POST .../runs/:run_id/heartbeat`（间隔 15s、只更新 Run 行 `heartbeat_at` 并续租约，**不入事件流**，REQ-RUN-1）；**心跳必须绑定被包裹执行进程的存活探针**（S6 口径）：执行进程退出 / 探针失联即刻停发，不许无条件定时代发。
4. 执行结束回 `POST .../runs/:run_id/raw-result` `{ client_result_id, outcome_hint?, raw_result_ref?, summary }` → 服务端发 `RunRawResultReceived` 并走既有 Outcome 流（Outcome 仍只由 Outcome Interpreter 提议 + 内核校验产生，节点回传的只是 RawResult，不得直接写 Outcome / Evidence 的 tool_output —— INV-6 口径不变）。
5. 取消：Task 取消（REQ-RUN-6）时服务端经 dispatch-poll 响应的 `cancel_requests[]`（run_id 列表）下发，节点调 adapter `cancel()`，确认后回 `POST .../runs/:run_id/cancel-confirmed` → Run `canceled`；超时未确认（默认 60s）→ `indeterminate` 走对账。
6. 对账（probe 通道）：Run 进 `indeterminate` 且原执行节点恢复 online 后，服务端经 dispatch-poll 响应的 `probe_requests[]` 下发对账请求（`{ run_id, idempotency_key }`）；节点调本地 adapter `probe(run_id)`，结果经 `POST /api/nodes/:node_id/runs/:run_id/probe-result { result: "executed" | "not_executed" | "unknown" }` 回报，服务端据此走 REQ-RUN-3 三结论处置并入流（补录 / 置 failed / 保持 indeterminate 产生 Decision）。probe 请求在节点未回报前于后续 poll 中重复下发（幂等：同一 run 的 probe-result 只处置一次，重复回报返回首次处置结果）。原节点永久不恢复时，对账请求可下发给**任一能力匹配的 online 节点**吗——不可以：probe 只有原执行节点有意义（查的是它的本地执行事实），原节点不恢复则 Run 保持 indeterminate 直至 Decision 人工裁决（REQ-RUN-3 口径）。

幂等：同一 Run 的 ack/started/raw-result 以 `(run_id, 消息类型)` + `client_result_id`（raw-result）去重，重放返回首次处理结果、零重复事件。同一 `idempotency_key` 的 Run 不得被派发给两个节点并发执行：服务端派发即占用（dispatch-poll 取走即标记 `dispatching_to=node_id`，ack 前租约不生效、占用超时 30s 未 ack 自动释放回 queued）。

### 4.4 派发选择与挂起语义（节点离线 Run 不丢）

- Scheduler 既有 ready 计算不变；Run 进入 `queued` 后，派发器只把 Run 派给 **online 且能力匹配**（executor_kind ∈ 节点 executor_kinds ∧ Run.side_effect_level ≤ 节点 max_side_effect_level）的节点。
- **无可用节点时**：Run 停留在 `queued`，不失败、不超时、不产生 Decision；等待原因**写死**为 Run 行字段 **`state_reason = "awaiting_node"`**（Run 处于 queued 且无能力匹配的 online 节点时由派发器置位、派发时清除；验收断言固定查此字段，不接受等价字段）——「挂起不丢」的判定 = 节点恢复 online 后，该 Run 被自动派发续跑（无需人工干预、无需重建 Run）。
- 节点在 Run **leased 未 started** 时离线：租约过期 → 回 `queued`（REQ-RUN-4 / C1b 口径），不进 indeterminate。
- 节点在 Run **started** 后离线（心跳停发）：租约过期后按 REQ-RUN-4 分界——K1-B 节点只承接 L0/L1 且无外部副作用工具调用记录时置 `failed(lease_expired)` 可安全新建 Run；出现副作用调用记录（adapter 以 `POST .../runs/:run_id/side-effect-note` 登记，请求体 `{ tool_name: string, note: string, client_note_id: string }`——`client_note_id` 为节点生成的幂等键，同键重放只落一条，INV-13 口径；落盘为事件 `RunSideEffectRecorded`、写该 Run 所属项目的流（stream_id = 该 Run 的 project_id）、payload `{ run_id, node_id, tool_name, note, recorded_at }`；仅登记事实不开 L2）→ `indeterminate`，节点恢复后内核经 §4.3 第 6 步的 probe 通道对账（REQ-RUN-3 三结论口径不变）。
- 服务端进程重启：queued / leased 状态以 PG 持久化为准，重启后派发器按存活判定恢复工作（对齐 REQ-SCH-3 定时器持久化口径）。

### 4.5 节点面接口清单（全部经 §5 令牌校验：节点面认节点令牌、列表读面认用户令牌）

| 端点 | 用途 | 入事件流 |
|---|---|---|
| `POST /api/nodes/register` | 注册 / 重注册 | `NodeRegistered`（仅首次） |
| `POST /api/nodes/:id/heartbeat` | 节点心跳 | 否 |
| `POST /api/nodes/:id/deregister` | 优雅注销 | `NodeOffline` |
| `GET /api/nodes/:id/dispatch-poll` | 长轮询取派发 + 取消请求 + probe 请求（统一响应对象 §4.3） | 否（取走占用是行状态） |
| `POST /api/nodes/:id/runs/:run_id/ack` / `nack` | 接受 / 拒绝派发 | `RunLeased` / 否 |
| `POST /api/nodes/:id/runs/:run_id/started` | 启动回报 | `RunStarted` |
| `POST /api/nodes/:id/runs/:run_id/heartbeat` | Run 心跳续租 | 否 |
| `POST /api/nodes/:id/runs/:run_id/raw-result` | 结果回传 | `RunRawResultReceived` |
| `POST /api/nodes/:id/runs/:run_id/cancel-confirmed` | 取消确认 | `RunCanceled` |
| `POST /api/nodes/:id/runs/:run_id/side-effect-note` | 副作用调用登记 `{ tool_name, note, client_note_id }`（同键幂等） | `RunSideEffectRecorded`（写该 Run 所属项目流） |
| `POST /api/nodes/:id/runs/:run_id/probe-result` | 对账结果回报 `{ result }`（§4.3 第 6 步） | 按 REQ-RUN-3 处置入流 |
| `GET /api/nodes` | 节点列表 + 存活状态（前端 / 运维读面，走用户面令牌） | — |

### 4.6 节点进程交付形态

- 节点 agent 是一个可独立启动的进程（仓库内 `node-agent/` 或等价目录），启动参数只许来自环境变量 / 命令行：`XUXING_SERVER_URL`、`XUXING_NODE_TOKEN`（§5 节点令牌，节点面专用，与用户令牌互不通用）、`XUXING_NODE_NAME`、执行器配置（agent-hands 容器连接信息）。**令牌与连接信息不许写进仓库文件**。
- 首部署形态：在 xc 上以独立进程运行、执行器指向 ah1 容器（与既有 agent-hands 通道复用，不新开公网入口）。节点 agent 与服务端之间只走 HTTPS/HTTP API，不共享 DB、不共享文件系统。

### 4.7 K1-B 失败语义（封闭增补）

| 情形 | 结果 |
|---|---|
| 节点以失效 / 错误令牌调用节点面 | 401 `unauthorized`（§5），零状态变化 |
| 未注册 node_id 调 heartbeat/poll | 404 `node_not_found` |
| dispatch-poll 取走后 30s 未 ack | 占用释放，Run 回 queued，可被再派发 |
| raw-result 重放（同 client_result_id） | 返回首次结果，零新事件 |
| 节点重复注册（同 node_id） | 幂等成功，更新能力 / 版本字段，不产生第二个节点行 |
| Run 被派给能力不匹配节点 | **不许发生**：派发器选择逻辑保证（§4.4）；验收以负向构造判定（K1B-AC-09） |
| 占用超时（30s）后节点迟到 ack | 409 `precondition_unmet`，Run 状态不变（可能已回 queued 或已重派，以服务端当前状态为准） |
| Run 已达终态后迟到 raw-result / probe-result（与已落盘结果同幂等键的正常重放除外） | 409 `terminal_state`，零新事件；同 client_result_id 重放仍按 §4.3 幂等返回首次结果 |
| 节点 deregister 时有该节点上 started 未终态的 Run | 409 `node_busy`，注销不生效、节点保持原状态；仅 leased 未 started 的 Run 时：释放回 queued（占用清除）后注销照常生效 |

### 4.8 K1-B 验收标准（逐条可判定）

- K1B-AC-01：节点 agent 启动 → `GET /api/nodes` 出现该节点且 status=online、executor_kinds 含 `agent_hands_shell`；事件流有恰一条 `NodeRegistered`。
- K1B-AC-02：停掉节点心跳 → 30s 内 status 变 stale、90s 内变 offline（按 §4.2 默认阈值，允许测试以配置缩短阈值并注明）；恢复心跳 → 回 online，全程无需重注册。
- K1B-AC-03：创建一个指派给 agent 执行的 ready Task → Run 被派发至节点、ah1 容器内真实执行（容器侧留痕：tmux 会话 / 产物文件可查）、RawResult 回传、Outcome 入账、Task 进 `awaiting_acceptance`（全链 API 回读断言）。
- K1B-AC-04：节点 offline 期间创建同上 Task → Run 保持 `queued` 且 Run 行 `state_reason = "awaiting_node"`（固定字段断言），不产生 failed / Decision；节点恢复 online 后 Run 自动被派发并跑通 AC-03 全链（挂起不丢）。
- K1B-AC-05：节点 ack 后、started 前杀节点进程 → 租约过期后 Run 回 `queued`，不进 indeterminate（C1b 口径），节点恢复后可重新领取跑通。
- K1B-AC-06：节点 started 后杀进程且无副作用登记 → 租约过期后 Run `failed(lease_expired)`，可新建 Run 跑通。
- K1B-AC-07：节点 started 后登记一条 side-effect-note 再杀进程 → Run 进 `indeterminate`；节点恢复 online 后，服务端经 dispatch-poll 的 `probe_requests` 下发对账请求、节点经 probe-result 端点回报 `not_executed` → Run `failed(reconciled_not_executed)` 且可新建 Run（REQ-RUN-3 口径，全程走真 HTTP 通道断言）。
- K1B-AC-08：同一 raw-result 以同 client_result_id 提交两次 → `RunRawResultReceived` 恰一条，Outcome 恰一份。
- K1B-AC-09：构造 side_effect_level=L2 的 Run（仅构造、不放行执行）→ 不被派给 max_side_effect_level=L1 的节点，Run 留 queued 等待（负向）。
- K1B-AC-10：Task 取消时其在节点上 running 的 Run → 节点收到 cancel、回确认后 Run `canceled`、Task 按 REQ-RUN-6 正式 canceled（事件序回读断言）。
- K1B-AC-11：服务端进程在 Run queued 期间重启 → 重启后 Run 仍 queued 且被正常派发跑通（持久化口径）。
- K1B-AC-12：节点以错误令牌调用 register / dispatch-poll → 401，节点列表与事件流零变化。

## 5. K1-C 基础访问控制

### 5.1 定位

部署面**双令牌**门禁（v0.4 裁决 OQ-K1-3 采纳分离）：解决「公网裸奔」，不解决「谁是谁」。两把部署级共享凭证按面分离——**用户令牌**（`XUXING_ACCESS_TOKEN`）只护用户面（前端 / API 客户端），**节点令牌**（`XUXING_NODE_TOKEN`）只护节点面（§4.5 节点端点），**互不通用**：任一令牌拿到对方的面一律 401。持有对应面的令牌即放行该面；actor 身份仍走既有字段（§2）。按人令牌 / 权限分级不在 K1（§1.2）。

### 5.2 令牌来源与注入

- 服务端从环境变量 **`XUXING_ACCESS_TOKEN`** 读用户令牌、从 **`XUXING_NODE_TOKEN`** 读节点令牌（部署时经容器 env / 进程 env 注入）。令牌**不入库、不入仓、不进镜像、不写日志**（日志与错误响应中出现任一令牌原文即验收不合格，K1C-AC-07）。
- 令牌长度下限 16 字符（启动时校验，已设置但不足 → 拒绝启动并报明确错误，两把令牌同口径）。
- **fail-closed**：`NODE_ENV=production` 且 `XUXING_ACCESS_TOKEN` 未设置 → 服务端拒绝启动（错误信息明示缺失变量名）。`XUXING_NODE_TOKEN` 在 production 未设置时不拒绝整进程启动（纯 Web 部署可暂不启用节点），但节点面端点一律 401 fail-closed 且启动日志打 WARN 明示「节点令牌未配置、节点面关闭」。非 production 环境任一令牌未设置 → 允许启动但启动日志打 WARN 明示「访问控制未启用」，且 `/api/health` 响应含 `auth_enabled: false` 供巡检识别（不许静默裸奔）。
- 令牌轮换 = 改 env + 重启进程；K1 不做双令牌并行窗口（登记为已知限制，不是缺陷）。节点令牌轮换后节点侧行为见 K1C-AC-09。

### 5.3 服务端中间件口径

- 覆盖面：全部 `/api/*` 路由，豁免仅两条：`GET /api/health`（只返回 `{ ok, auth_enabled }`，不泄露版本 / 数据）与 `POST /api/auth/session`（会话交换端点——浏览器尚无凭据时以请求体提交**用户令牌**换 cookie，若不豁免将自锁；该端点自身即校验点，令牌错误回 401 且不下发 cookie，见下；节点令牌提交到本端点同样 401、不下发 cookie）。其余路由必须校验对应面的令牌：**用户面**（除节点面外的全部 `/api/*`，含 `GET /api/nodes` 读面）认用户令牌 Bearer 或用户会话 cookie；**节点面**（`POST /api/nodes/register`、`/api/nodes/:id/heartbeat`、`/api/nodes/:id/deregister`、`/api/nodes/:id/dispatch-poll`、`/api/nodes/:id/runs/*`）只认节点令牌 Bearer（不认 cookie）。**互不通用**：用户令牌调节点面 → 401；节点令牌调用户面 → 401（响应同形，不给区分提示）。
- 凭据承载（二选一，同一请求任一成立即放行）：
  1. `Authorization: Bearer <token>`（API 客户端 / 节点 agent 用此路）；
  2. 会话 cookie：`POST /api/auth/session { token }` 校验通过后下发 `xuxing_session` cookie（HttpOnly、SameSite=Lax、Path=/；HTTPS 部署下加 Secure），cookie 值为服务端签发的**不透明会话凭证**（不得是令牌原文或其简单哈希），有效期 7 天（配置项）。前端浏览器走此路——理由：SSE 的 EventSource 不能带 Authorization 头，cookie 是唯一能同时覆盖普通请求与 `/api/stream` 的承载。
- 未授权响应：401 `{ error: "unauthorized" }`，不区分「无凭据 / 凭据错误」（不给枚举预言机）；`/api/stream` 同样 401、不建立连接。
- `POST /api/auth/session` 本身是唯一以请求体带令牌的端点：令牌错误 → 401 且不下发 cookie；成功 → 200 + Set-Cookie。登出 `POST /api/auth/logout` 清 cookie（服务端会话凭证作废）。
- 常量时间比较校验令牌（防时序侧信道，最低要求写明，实现报告注明所用方法）。
- Caddy / 反代层不做第二道口径（单一事实源在服务端中间件，防双层规则漂移）；部署步只负责把 env 注入容器。

### 5.4 前端入口

- 前端启动先调 `GET /api/home`（或任一受保护读面）：401 → 渲染**入口门**（只一个令牌输入框 + 提交，不展示任何业务数据 / 项目名 / 计数）；提交 → `POST /api/auth/session` → 成功后 cookie 落盘、重拉数据进正常界面；失败 → 门上提示「令牌不正确」，不泄露更多信息。
- 前端不得把令牌存入 localStorage / sessionStorage / 任何 JS 可读位置（cookie 为 HttpOnly，JS 不接触会话凭证本体，更不接触令牌原文）。
- 已登录状态下任一请求中途 401（如令牌轮换后旧 cookie 失效）→ 自动回入口门并提示重新输入，不白屏、不无限重试。
- 入口门本身不引用任何受保护资源（CSS/JS 静态资源属部署面，不在 `/api/*` 覆盖内，正常加载）。

### 5.5 K1-C 验收标准（逐条可判定）

- K1C-AC-01：生产模式未注入 `XUXING_ACCESS_TOKEN` 启动 → 进程拒绝启动且错误信息含变量名；注入短于 16 字符的令牌 → 同样拒绝启动。
- K1C-AC-02：无凭据访问 `/api/home`、`/api/actions`、`/api/projects/:id`、`POST /api/commands`、`GET /api/stream` → 全部 401 且响应体为 `{error:"unauthorized"}` 同形；`GET /api/health` → 200；`POST /api/auth/session`（豁免端点）以错误令牌提交 → 401 且无 Set-Cookie，以正确令牌提交 → 200 + Set-Cookie（豁免不等于放行）。
- K1C-AC-03：错误令牌访问同上集合 → 全部 401，响应与无凭据时不可区分（同状态码同响应体）。
- K1C-AC-04：`Authorization: Bearer <正确令牌>` 访问读面与命令面 → 正常 200 / 命令成功（与未启用访问控制时行为一致）。
- K1C-AC-05：浏览器路径：入口门输入正确令牌 → 进入应用、四入口与 SSE 均通（SSE 建连成功且能收到补发帧）；输入错误令牌 → 停在入口门且零业务数据渲染（DOM 断言无项目名）。
- K1C-AC-06：已登录后服务端轮换令牌并重启 → 旧 cookie 请求得 401 → 前端自动回入口门（不白屏、无 pageerror 风暴）。
- K1C-AC-07：在服务端日志、错误响应、前端产物（构建 bundle）中 grep 令牌原文 → 零命中。
- K1C-AC-08：`POST /api/auth/session` 错误令牌 → 401 且响应无 Set-Cookie；登出后原 cookie 再访问 → 401。
- K1C-AC-09：节点 agent 以 Bearer **节点令牌**可正常走完 §4.5 全部节点面；以用户令牌调节点面、或以节点令牌调用户面 → 均 401（双令牌互不通用负向断言）；节点令牌被服务端轮换后节点请求得 401，节点行为**写死**为：记录一条含 401 的错误日志 → 暂停派发轮询并指数退避重试（初始 5s、倍增、上限 60s）→ 令牌在节点侧被更新（改 env 重启节点进程或实现注明的热加载方式）后自动恢复正常轮询；进程不退出、无无退避死循环重试（验收以日志时间戳序列断言退避间隔）。

## 6. E2E 旅程清单（真服务口径，PHASES-PLAN 硬门）

通用口径：全部旅程对**真服务端 + 真 PG**运行（Web 旅程加 Playwright 真浏览器）；断言三段式——**在场**（元素 / 条目出现且内容对）+ **可点**（动作可执行）+ **状态真变**（动作后回读 API / 事件流核对状态迁移）；只用 mock 轮的结果不计入验收。

- **J1 决策旅程**（覆盖 K1A-AC-01/04/07/11）：真服务构造一条触发 `needs_decision` 的 PlanChange（如超 Policy ceiling 的提议）→ 浏览器开 My Actions 见 decision 条目在场 → 展开裁决面见 question/recommendation → 点批准 → 回读 API：Decision status=approved、PlanChange applied、目标 Task 在项目投影中出现（任务图真变化）；再构造第二条 Decision 拒绝（填理由）→ 图无变化且 Change rejected 原因码正确。
- **J2 节点执行旅程**（覆盖 K1B-AC-03/04）：节点 agent + ah1 在线 → Web/API 创建 agent 执行型 Task → Run 派发、容器内真执行、回传、Task 到 awaiting_acceptance（API 回读全链事件序）；然后停节点 → 再建一 Task → Run queued + awaiting_node 在场 → 启节点 → 自动续派跑通（挂起不丢全程无人工补单）。
- **J3 未授权拦截旅程**（覆盖 K1C-AC-02/03/05）：全新浏览器上下文（无 cookie）开公网形态部署 → 只见入口门、DOM 无任何业务数据 → 错误令牌提交 → 仍在门前 → 正确令牌 → 进入应用且四入口可用；同旅程以裸 HTTP 客户端复跑 401 集合断言。
- **J4 回归护栏旅程**：K0 既有黄金旅程（捕获 → 提议 → 应用 → 执行 → 验收全闭环 + Fix Round 1–4 的页面级冒烟含在场断言）在 K1 合入后全轮重跑零回归；K1 三项各自的负向用例（§3.5 / §4.7 / §5.5 表）以 API 级 e2e 自动化，不许只靠单测声明。

部署后公网复验：K1 上线部署后 J1/J2/J3 在公网形态各跑一轮全过，才算 K1 收口（PHASES-PLAN 通用硬门）。

## 7. 开放问题（协调者已裁决，v0.4 全部关闭）

- OQ-K1-1：`approved_modified` 的前端形态——本 spec 按 K0 的 OQ-04=B 延续「API 可达、前端不提供表单」。**【v0.4 裁决：维持】** K1 内不补前端改 ops 表单。
- OQ-K1-2：审计事件命名——PHASES-PLAN 用语为「DecisionRecorded 事件」，冻结 spec 事件目录为 `DecisionResolved`。本 spec 裁决为复用 `DecisionResolved` 作唯一审计记录（§3.3）。**【v0.4 裁决：维持】** 不新增 `DecisionRecorded`，不许双事件并存记同一事实。
- OQ-K1-3：节点令牌与用户令牌是否分离——**【v0.4 裁决：采纳分离】** 双令牌按面分离、互不通用，已落 §5.1 / §5.2 / §5.3 / §4.2 / §4.5 / §4.6 / K1C-AC-09（节点令牌 env = `XUXING_NODE_TOKEN`）。
- OQ-K1-4：deferred 的 `on_event` 唤起条件——**【v0.4 裁决：维持 spec 明示口径】** `at_time` 必备、`on_event` 可填（§3.2 / §3.7），实现不得静默缺失。

## 8. 与既有裁决的一致性清单（评审核对用）

| 依据 | 本 spec 的落点 |
|---|---|
| D1 云端内核 + 本地执行节点 | §4 全部（节点出站长轮询、无入站假设） |
| D3 不引入 Temporal | §1.2；派发 / 租约全部自研既有语义 |
| D5 副作用 L2 按项目逐项授权 | §1.2 不放行 L2/L3；§4.4 能力上限 L1、K1B-AC-09 负向 |
| REQ-PC-5 决策回路 | §3.4 表第一行逐态对齐（approved 重走校验 / rejected 原因码 / deferred 唤起后重走） |
| REQ-DC-1 过期≠批准 | §3.4 末行、§3.5、K1A-AC-05 |
| REQ-PJ-2 My Actions 口径 | §3.6（Decision 入 actions 是补齐实现缺口；条目联合维持契约的 `task \| decision` 不扩展，待决提案按 REQ-PC-3 经其关联 Decision 收录） |
| INV-12 stream 归属 | §4.2（项目事件 stream_id=project_id 不变；节点管理事件入保留流 `$system`，为显式增补，须同步登记契约文档） |
| REQ-RUN-1/3/4 租约·对账·分界 | §4.3/§4.4 全量复用，心跳不入流 + 存活探针绑定（S6） |
| INV-6 Outcome/Evidence 写入边界 | §4.3 第 4 步（节点只回 RawResult） |
| INV-13 幂等 | §2、§3.5、§4.3 |
| 交互契约 M-A4 / M5 / M8 | §3.7（裁决面字段与冲突态呈现对齐契约，不新造交互语义） |
| PHASES-PLAN E2E 硬门 | §6（真服务 + 在场/可点/状态真变 + 公网复验） |
