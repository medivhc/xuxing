```
artifact: review
based_on: 80a09c1
sha256: 70e25fee7d235a355dcb762411ad54bd57cbb8e26f96f67806e7069db9f0d102
verdict: CHANGES_REQUESTED
counts: BLOCKER 2 / MAJOR 4 / MINOR 4
producer: gemini-3.8-flash via opencode google provider（沙盒 gemini-relay 中继 18888）
```

# Contract Review Report — K1 Spec

本评审依据 `REVIEW-TASK.md` 规定的 contract-review 口径，对 `K1-SPEC.md`（基线 `80a09c1`，正文 sha256 `70e25fee7d235a355dcb762411ad54bd57cbb8e26f96f67806e7069db9f0d102`）进行独立异构评审。评审对照基准文件为：
- `K0-SPEC-FROZEN-v1.0.md`（冻结领域 spec v1.0）
- `interaction-contract.md`（交互契约 v0.2 定稿）
- `PHASES-PLAN-1024.md`（三阶段 + K1 并行推进计划）

---

## 一、评审维度通查总结

### 1. 完整性（Completeness）
- **查验范围**：T5 裁决三项（K1-A 决策闭环、K1-B 本地执行节点、K1-C 访问控制）展开情况；是否遗漏端点、字段、协议消息或事件 payload。
- **查验结论**：发现 2 项 BLOCKER（R-01、R-02）及 3 项 MAJOR（R-03、R-05、R-06）。
  - 在 K1-B 中，内核通过本地适配器 `adapter.probe()` 对账的 HTTP 线路与端点完全缺失（R-01）；
  - 在 K1-C 中，认证中间件声明「唯一豁免 `/api/health`」，导致会话交换端点 `POST /api/auth/session` 被自身阻断（R-02）；
  - `NodeRegistered` / `NodeOffline` 事件的流归属与 payload schema 缺失（R-06）；
  - `disposition` 入参在 `resolve_decision` 请求 schema 中缺失（R-05）。

### 2. 可判定性（Decidability）
- **查验范围**：逐条检查 K1A-AC-01~12、K1B-AC-01~12、K1C-AC-01~09 及 §6 E2E 旅程（J1~J4）的客观可验证性、数值时限封闭性及措辞确定性。
- **查验结论**：发现 1 项 MAJOR（R-04）及 1 项 MINOR（R-09）。
  - K1B-AC-04 出现「或实现注明的等价字段」及 §4.4「口径二选一」模糊表述，导致自动化验收无法固定断言路径；
  - K1C-AC-09 对节点遇 401 出现「退出或暂停轮询，实现报告注明行为」，未封闭行为分支；
  - §4.3 长轮询响应结构模糊，未能封闭无派发仅取消时的响应结构。

### 3. 一致性（Consistency）
- **查验范围**：对照 K0 冻结 spec（REQ-PC-5、REQ-DC-1、REQ-RUN-1、REQ-RUN-3、REQ-RUN-4、REQ-PJ-2、INV-6、INV-13）、交互契约（M-A4、M5、M8）、架构裁决（D1、D3、D5）以及被审 spec 内部章节引用与 §8 清单。
- **查验结论**：发现 1 项 MAJOR（R-03）、2 项 MINOR（R-07、R-10）。
  - §3.6 引入 `kind: "proposal"` 及 `accept_proposal/reject_proposal`，与 `interaction-contract.md` 的 `MyActionsProjection` 封闭联合类型（只含 `task | decision`）及 K0 REQ-PJ-2、REQ-PC-3 冲突，且 §8 一致性表声明不实（R-03）；
  - `DispatchEnvelope` 在节点 ack 前即下发 `lease_expires_at`，与 §4.3「租约自 ack 起算」自相矛盾（R-10）；
  - §3.2 错误码内部章节交叉引用错误（R-07）；
  - 确认 D1、D3、D5 原则本身未被违背，REQ-DC-1、INV-13 语义保持一致。

### 4. 失败语义封闭性（Failure Semantics Closure）
- **查验范围**：检查 §3.5、§4.7、§5 的失败矩阵及并发、重放、节点离线、租约过期、任务取消与注销等边界条件。
- **查验结论**：发现 1 项 MAJOR（R-05）及 1 项 MINOR（R-08）。
  - §3.5 遗漏 Run 对账 Decision 审批缺失 `disposition` 时的失败码（R-05）；
  - §4.7 遗漏派发超时后节点迟到 ack、Run 已终态后迟到 raw-result、以及节点优雅注销时在跑任务的处理规则（R-08）。

---

## 二、逐条问题清单（Findings）

### R-01 [BLOCKER] §4.1 / §4.3 / §4.4 / §4.5 / K1B-AC-07：跨网络 probe 对账协议与 HTTP 端点完全缺失
- **问题**：
  §4.1 定义了本地执行器接口 `probe(run_id: string): Promise<"executed" | "not_executed" | "unknown">`，并在 §4.4 规定「节点恢复后内核以 adapter probe() 对账（REQ-RUN-3 三结论口径不变）」，K1B-AC-07 亦将 probe 对账作为验收条件。
  但根据 D1 与 §4.3 定位，内核部署在云端，节点运行在用户机器/容器内且处于 NAT/容器后，仅能向云端发起**出站长轮询**（「服务端不反向连接节点——无入站可达性假设」）。在 §4.5 节点面接口清单以及 §4.3 通信流程中，**完全没有定义服务端如何向节点下发 probe 请求，也没有定义节点向服务端回报 probe 结果的 HTTP 端点**（既无 `probe_requests` 协议字段，也无 `POST .../probe-result` 端点）。导致云端内核在网络层面物理上无法触发远端节点的 `probe()`，跨进程/跨网络对账协议断裂，K1B-AC-07 无法通过真服务 HTTP API 闭环。
- **建议修法**：
  在 `GET /api/nodes/:node_id/dispatch-poll` 响应中增加 `probe_requests: Array<{ run_id: string, idempotency_key: string }>` 字段，并在 §4.5 增补节点回报端点 `POST /api/nodes/:id/runs/:run_id/probe-result { result: "executed" | "not_executed" | "unknown" }`。

---

### R-02 [BLOCKER] §5.3：认证中间件豁免范围过窄导致 `POST /api/auth/session` 无法访问
- **问题**：
  §5.3 第 1 条声明：「覆盖面：全部 `/api/*` 路由，**唯一豁免** `GET /api/health`（只返回 `{ ok, auth_enabled }`，不泄露版本 / 数据）。」
  然而，同节第 250 行与第 252 行规定前端浏览器通过 `POST /api/auth/session { token }` 提交令牌以换取 `xuxing_session` cookie。若中间件按字面规定只豁免 `GET /api/health`，则尚未持有 cookie 或 Bearer 令牌的浏览器调用 `POST /api/auth/session` 时将被中间件直接拦截返回 401，导致正常登录换取 cookie 的流程发生死锁，前端入口门永远无法建立会话。
- **建议修法**：
  将 §5.3 豁免路由修正为「覆盖全部 `/api/*` 路由，豁免 `GET /api/health` 与会话交换端点 `POST /api/auth/session`，其余路由必须校验 Bearer 令牌或会话 cookie」。

---

### R-03 [MAJOR] §3.6 / K1A-AC-12 / §8：My Actions 引入 `kind: "proposal"` 违反交互契约与冻结领域模型
- **问题**：
  §3.6 声明 `/api/actions` 投影增补 `kind: "proposal"`（「每个待用户决定的提案（PlanChange status=proposed 且 Policy 判定需人工确认的 PlanChange 本体）一条，available_actions 为既有 accept_proposal / reject_proposal」），并在 K1A-AC-12 中列为验收项。
  这引发了三重冲突：
  1. 与依据文件 `interaction-contract.md` §4.2 冲突：交互契约严格定义 `MyActionsProjection.items` 的封闭联合类型只允许 `kind: 'task' | 'decision'`，§4.3 M2 状态亦写死 MyActions 「只显示『可执行任务』与『待你裁决』两类」；
  2. 与依据文件 `K0-SPEC-FROZEN-v1.0.md` REQ-PJ-2 冲突：「MyActions 只含 `actor=当前用户 ∧ (可执行[ready/active 且 wait_state=none] ∨ 待其决策的 Decision)` 的条目」；且按 K0 REQ-PC-3，PlanChange 校验若属 Policy 需人工确认，状态直接迁往 `needs_decision` 并创建关联 Decision，进入 `kind: "decision"` 通道，领域模型中根本不存在 `status=proposed` 却停在 actions 待批的平行状态；
  3. §8 一致性清单声明「REQ-PJ-2 My Actions 口径：§3.6（Decision 入 actions 是补齐实现缺口，非改口径）」，该声明与正文擅自扩展 `kind: "proposal"` 的事实不符。
- **建议修法**：
  收敛待决提案口径至 K0 既有领域模型：待决提案一律按 REQ-PC-3 产生关联 Decision（`subject_ref=PlanChange`），在 My Actions 中统一作为 `kind: "decision"` 展示并经 `resolve_decision` 裁决；删除 §3.6 和 K1A-AC-12 中的 `kind: "proposal"` 及 `accept_proposal / reject_proposal` 平行通道。

---

### R-04 [MAJOR] §4.4 / §4.8 K1B-AC-04 / §5.5 K1C-AC-09：关键验收断言出现二选一与含糊措辞导致不可客观判定
- **问题**：
  1. §4.4 声明「任务投影须暴露可观测的等待原因 `awaiting_node`（Task 行派生字段或 Run 行 state_reason，口径二选一并在实现报告中注明）」，并在 K1B-AC-04 中写为「Run 保持 queued 且投影可见 awaiting_node（或实现注明的等价字段）」。该措辞允许实现方自创字段名和挂载实体，使自动化测试无法确定固定的 JSON 响应路径，违反了契约的可判定性要求。
  2. §5.5 K1C-AC-09 规定节点 agent 遇 401「须显式报错并退出或暂停轮询，实现报告注明行为」，将「退出进程崩溃」与「暂停轮询」作为二选一模糊处理，退避时限与恢复条件未封闭，使测试脚本无法客观断言预期行为。
- **建议修法**：
  消除所有二选一模糊表述：在 §4.4 和 K1B-AC-04 中写死字段路径为 `Run.state_reason = "awaiting_node"`（删除「等价字段」和「口径二选一」）；将 K1C-AC-09 明确封闭为「记录 401 错误日志后暂停派发轮询，进入指数退避重试（初始 5s、最大 60s），不得退出进程退出，亦不得无退避死循环重试」。

---

### R-05 [MAJOR] §3.2 / §3.4 / §3.5：`disposition` 字段定义自相矛盾且遗漏在命令 Schema 与失败矩阵之外
- **问题**：
  1. §3.2 定义的 `POST /api/commands`（`resolve_decision`）请求 payload 仅包含 `{ decision_id, verdict, reason, wake_condition? }`，未声明 `disposition`。
  2. 但在 §3.4 表格第二行（Run 对账）又规定：「裁决者须在 reason 中声明处置（executed / not_executed / cancel_run）——三选一封闭枚举放 payload disposition 字段，仅此 subject 类型必填」。这不仅在同一句话中产生内部矛盾（「在 reason 中声明」vs「放 payload disposition 字段」），而且直接违背了 §3.2 的请求 schema。
  3. §3.5 失败表与 §3.2 校验流水线完全未覆盖 Run 对账 Decision 审批时若缺失 `disposition` 或取值非法的失败响应码（如缺少 400 `schema_invalid`）。
- **建议修法**：
  在 §3.2 的 payload schema 中补充声明 `disposition?: "executed" | "not_executed" | "cancel_run"`；修正 §3.4 表述统一为「放 payload disposition 字段」；在 §3.2 和 §3.5 中增加「当 subject 为 Run 对账且 verdict=approved 时，disposition 字段必填且须在三项枚举内，否则返回 400 schema_invalid（指明 disposition）」。

---

### R-06 [MAJOR] §4.2 / §4.5 / §4.8 K1B-AC-01：节点管理事件的 stream 归属及 payload 未定义，`side-effect-note` 契约不完整
- **问题**：
  1. §4.2 规定节点注册与优雅注销时发出 `NodeRegistered` 与 `NodeOffline` 事件入事件流。然而依据文件 `K0-SPEC-FROZEN-v1.0.md` §4 与 INV-12 严格规定 `stream_id = project_id`（以项目为流隔离边界）。节点作为跨项目的基础设施实体，并不从属于特定 `project_id`。K1-SPEC 未定义此类事件写入何种流（例如未声明全局系统流命名），亦未定义两个事件的 payload schema。
  2. §4.5 增补了 `POST /api/nodes/:id/runs/:run_id/side-effect-note` 端点，但在入事件流列写为「EvidenceAdded 之外的审计行（实现报告注明落点）」，既无请求体 schema，也未说明具体的审计存储结构或领域事件，违反了 §2「K1 新增领域事实一律以事件入事件流」的通用原则，且留有「实现报告注明落点」占位符。
- **建议修法**：
  在 §4.2 明确节点事件的流命名规则（如固定 `stream_id = "$system"`）并给出 `NodeRegistered` 与 `NodeOffline` 的 payload schema 字段；为 `side-effect-note` 补充完整请求体 schema `{ note: string, tool_name?: string }`，并指定其入流事件 `RunSideEffectRecorded` 或固定数据表结构。

---

### R-07 [MINOR] §3.2 line 59 / §3.5：命令注释中的内部章节交叉引用错误
- **问题**：
  §3.2 第 59 行在命令入参代码块中注释写道：`// 非 human → 403 actor_not_human（§3.6）`。
  但 §3.6 的标题是「3.6 投影：My Actions 收待决事项」，错误码 `actor_not_human` 的定义位置实际在 §3.5「3.5 失败语义（封闭）」第 101 行，存在内部章节交叉引用笔误。
- **建议修法**：
  将 §3.2 第 59 行的引用修正为 `（§3.5）`。

---

### R-08 [MINOR] §4.2 / §4.3 / §4.7：长轮询占用超时、迟到回报与节点注销等边缘失败分支未封闭
- **问题**：
  1. **占用超时后迟到 ack**：§4.3 规定「占用超时 30s 未 ack 自动释放回 queued」，但 §4.7 失败表中未定义若节点在第 30s 之后提交迟到的 `POST .../ack`（此时 Run 可能已重派或已回队）服务端的响应语义（应明确为 409 `precondition_unmet`）。
  2. **Run 终态后迟到 raw-result**：节点 started 离线导致租约过期被服务端置为 `failed(lease_expired)` 后，若节点网络恢复并提交 `raw-result`，§4.7 仅规定了同 client_result_id 的正常重放，未定义 Run 已处终态时的拒绝语义（应明确为 409 `terminal_state`）。
  3. **优雅注销在跑 Run**：§4.2 允许节点调 `POST /api/nodes/:node_id/deregister`，但未定义该节点上正在 `leased` 或 `running` 的 Run 的行为（是直接拒绝注销、等待其自然结束，还是同事务释放未启动 Run 并对已启动 Run 标记 indeterminate）。
- **建议修法**：
  在 §4.7 补齐边界规则：对超时未 ack 的迟到 ack 返回 409 `precondition_unmet`；对已达终态 Run 的 raw-result 返回 409 `terminal_state`；节点注销时若有 running Run，服务端返回 409 `node_busy` 或声明自动将其未 started 的 Run 释放回 queued、已 started 的 Run 触发取消。

---

### R-09 [MINOR] §4.3 line 165-173：长轮询端点响应 Envelope 结构不闭合
- **问题**：
  §4.3 第 1 步称「服务端有待派 Run 时返回一个 DispatchEnvelope」，第 5 步又称「Task 取消时服务端在 dispatch-poll 响应或独立字段中下发 cancel_requests[]」。
  这导致 `GET /api/nodes/:node_id/dispatch-poll` 的顶层返回结构不闭合：在无 Run 派发但存在取消请求时，返回何种 JSON；在两者均有时，响应体顶层是对象还是 Envelope？
- **建议修法**：
  将长轮询接口顶层响应规范化为统一对象：`{ dispatch: DispatchEnvelope | null, cancel_requests: string[] }`，长轮询 25s 超时无事件返回 `{ dispatch: null, cancel_requests: [] }`。

---

### R-10 [MINOR] §4.3 line 168 vs line 170 / line 175：`DispatchEnvelope` 中的 `lease_expires_at` 字段时序早产
- **问题**：
  §4.3 第 1 步在 `DispatchEnvelope` 定义中包含了 `lease_expires_at` 字段。
  但第 2 步（line 170）与第 175 行明确规定「ack 前租约不生效...租约自 ack 起算，默认 45s」。在长轮询返回给节点至节点调用 ack 之间存在最多 30s 的占用等待期，此时租约尚未生效，因此在长轮询响应中下发 `lease_expires_at` 在时序上是矛盾的。
- **建议修法**：
  将 `DispatchEnvelope` 中的 `lease_expires_at` 改为 `lease_duration_sec: number`；真实的绝对到期时间 `lease_expires_at` 在节点提交 `POST .../runs/:run_id/ack` 成功后的 200 响应体中下发，并作为 `RunLeased` 事件的 payload 字段。

---

## 三、结构一致性检查（Structural Consistency Check）

通读被审 `K1-SPEC.md` 全文，对章节组织、验收标准、事件目录与错误码清单进行交叉引用闭合性核对：
1. **验收标准编号连续性**：
   - K1A-AC-01 ~ K1A-AC-12 连续，共 12 条；
   - K1B-AC-01 ~ K1B-AC-12 连续，共 12 条；
   - K1C-AC-01 ~ K1C-AC-09 连续，共 9 条；
   - E2E 旅程 J1 ~ J4 连续，共 4 条。
   头部 `counts` 声明（12 / 12 / 9 / 4）与正文条目总数完全吻合。
2. **事件名称核对**：
   - 正文复用 K0 既有事件：`DecisionResolved`, `DecisionExpired`, `RunLeased`, `RunStarted`, `RunRawResultReceived`, `RunCanceled`, `PlanChangeApplied`, `PlanRevisionCreated`, `PlanChangeStatusChanged`, `TaskDuplicateResolved`，均在 K0 §4 封闭目录中；
   - 正文新增 2 个管理事件：`NodeRegistered`, `NodeOffline`。但因未定义其全局 stream 归属及 payload schema，导致与 K0 事件模型闭合性存在缺口（见 R-06）。
3. **错误码封闭性核对**：
   - §3.5 列出：`not_found`, `terminal_state`, `decision_expired`, `schema_invalid`, `actor_not_human`, `subject_not_resolvable_in_k1`；
   - §4.7 列出：`unauthorized`, `node_not_found`；
   - §5.3 列出：`unauthorized`。
   除 R-05（遗漏 disposition 校验错误）、R-08（遗漏超时后 ack 及终态 raw-result 错误码）外，已声明错误码均对齐既有错误词表规范。
4. **内部交叉引用**：
   - §3.2 line 59 引用 `（§3.6）` 存在笔误，实际应为 `§3.5`（见 R-07）；其余内部引用如 §5 令牌引用均闭合。
5. **一致性清单（§8）核对**：
   - §8 声称 REQ-PJ-2 「非改口径」，但正文 §3.6 擅自引入了超出 K0 范围与交互契约范围的 `kind: "proposal"`（见 R-03），该声明失实，需按建议修法纠正。

---

## 四、评审结论

依据 `REVIEW-TASK.md` 纪律，存在 BLOCKER（2 项）及 MAJOR（4 项），本次 contract review 裁决为 **CHANGES_REQUESTED**。
被审 spec 骨架完备、与 D1/D3/D5 大方向契合，在完成上述 R-01 ~ R-06 的修补及 R-07 ~ R-10 的细节收敛后，可快速重新提交复审。
