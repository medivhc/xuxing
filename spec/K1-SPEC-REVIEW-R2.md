```
artifact: review-r2
based_on: 80a09c1
sha256: 72930b40cbc13ca14f821487478beae54e817db1b96b92931a8d57a7b3f82731
verdict: APPROVED
counts: 未闭环 0 条（R-xx） / 新发现 BLOCKER 0 / MAJOR 0 / MINOR 3
producer: gemini-3.8-flash via opencode google provider（沙盒 gemini-relay 中继 18888）
```

# Contract Review Report R2 — K1 Spec 第二轮复审（增量复审）

本报告依据 `REVIEW-TASK-R2.md` 规定的 contract-review 复审口径，对 `K1-SPEC.md`（v0.2，based_on 基线 `80a09c1`，正文 sha256 `72930b40cbc13ca14f821487478beae54e817db1b96b92931a8d57a7b3f82731`）进行第二轮独立异构复审。复审对照第一轮报告 `K1-SPEC-REVIEW.md` 的 R-01~R-10 条目及建议修法，核对正文落地闭环情况，并对本轮修订及全文展开回归扫描。

对照依据文件为：
- `K0-SPEC-FROZEN-v1.0.md`（冻结领域 spec v1.0）
- `interaction-contract.md`（交互契约 v0.2 定稿）
- `PHASES-PLAN-1024.md`（三阶段 + K1 并行推进计划）

---

## 一、R-01~R-10 闭环核对表

### 1. 逐条一行汇总

| 编号 | 原级别 | 判定 | 证据位置（章节 / 行） |
|---|---|---|---|
| R-01 | BLOCKER | CLOSED | §4.3 line 173, 185; §4.5 line 211; §4.8 line 241 |
| R-02 | BLOCKER | CLOSED | §5.3 line 261-263, 268; §5.5 line 282 |
| R-03 | MAJOR | CLOSED | §1.1 line 27; §3.6 line 110-111; §3.8 line 135; §8 line 318 |
| R-04 | MAJOR | CLOSED | §4.4 line 192; §4.8 line 238; §5.5 line 289 |
| R-05 | MAJOR | CLOSED | §3.2 line 67-68, 72; §3.4 line 87; §3.5 line 104 |
| R-06 | MAJOR | CLOSED | §4.2 line 160; §4.4 line 194; §4.5 line 210; §8 line 319 |
| R-07 | MINOR | CLOSED | §3.2 line 60 |
| R-08 | MINOR | CLOSED | §4.2 line 163; §4.7 line 229-231 |
| R-09 | MINOR | CLOSED | §4.3 line 169-174; §4.5 line 204 |
| R-10 | MINOR | CLOSED | §4.3 line 178-181 |

---

### 2. 逐条展开核对结论

#### R-01 [BLOCKER] 跨网络 probe 对账协议与 HTTP 端点缺失
- **核对正文位置**：
  1. §4.3 第 1 步（line 171-173）：`dispatch-poll` 顶层响应中包含 `probe_requests: Array<{ run_id, idempotency_key }>`。
  2. §4.3 第 6 步（line 185）：正文写死 probe 通道交互流程——`服务端经 dispatch-poll 响应的 probe_requests[] 下发对账请求（{ run_id, idempotency_key }）；节点调本地 adapter probe(run_id)，结果经 POST /api/nodes/:node_id/runs/:run_id/probe-result { result: "executed" | "not_executed" | "unknown" } 回报，服务端据此走 REQ-RUN-3 三结论处置并入流`。
  3. §4.5 节点面清单（line 211）：表格增补端点 `POST /api/nodes/:id/runs/:run_id/probe-result`，说明为「对账结果回报 `{ result }`（§4.3 第 6 步）」，入流列为「按 REQ-RUN-3 处置入流」。
  4. §4.8 验收标准（line 241，K1B-AC-07）：明确断言`节点恢复 online 后，服务端经 dispatch-poll 的 probe_requests 下发对账请求、节点经 probe-result 端点回报 not_executed → Run failed(reconciled_not_executed) 且可新建 Run（REQ-RUN-3 口径，全程走真 HTTP 通道断言）`。
- **对照结论**：第一轮报告建议的 poll 响应 `probe_requests` 字段与 `POST .../probe-result` 回报端点完全落实，跨网络对账线路闭环。判定 **CLOSED**。

---

#### R-02 [BLOCKER] 认证中间件豁免过窄导致 `POST /api/auth/session` 无法访问
- **核对正文位置**：
  1. §5.3 中间件口径（line 261-263）：明确修正为`覆盖面：全部 /api/* 路由，豁免仅两条：GET /api/health（只返回 { ok, auth_enabled }，不泄露版本 / 数据）与 POST /api/auth/session（会话交换端点——浏览器尚无凭据时以请求体提交令牌换 cookie，若不豁免将自锁；该端点自身即校验点，令牌错误回 401 且不下发 cookie，见下）。其余路由必须校验 Bearer 令牌或会话 cookie。`
  2. §5.3 端点职责（line 268）：明示`POST /api/auth/session 本身是唯一以请求体带令牌的端点：令牌错误 → 401 且不下发 cookie；成功 → 200 + Set-Cookie。`
  3. §5.5 验收标准（line 282，K1C-AC-02）：写明`POST /api/auth/session（豁免端点）以错误令牌提交 → 401 且无 Set-Cookie，以正确令牌提交 → 200 + Set-Cookie（豁免不等于放行）。`
- **对照结论**：会话交换端点豁免已精确补齐，自锁问题消除，且保持 fail-closed 语义。判定 **CLOSED**。

---

#### R-03 [MAJOR] My Actions 引入 `kind: "proposal"` 违反交互契约与冻结模型
- **核对正文位置**：
  1. §1.1 范围定义（line 27）：`My Actions 收待决事项（Decision；待决提案按 REQ-PC-3 经其关联 Decision 收录，不另设条目类型，见 §3.6）`。
  2. §3.6 投影口径（line 110-111）：写死`/api/actions 投影只增补一类条目（条目封闭联合维持交互契约 §4.2 的 task | decision，不新增 kind）：kind: "decision"`，并专条阐述待决提案收录口径——`需人工确认的 PlanChange 按 REQ-PC-3 置 needs_decision 并产生关联 Decision（subject_ref 指向该 Change），因此它在 My Actions 中就是上一条的 decision 条目，经 resolve_decision 裁决、按 §3.4 第一行回路生效。不存在 status=proposed 停在 actions 里待批的平行状态，也不在 actions 中提供 accept_proposal / reject_proposal 通道`。
  3. §3.8 验收标准（line 135，K1A-AC-12）：改为`需人工确认的 PlanChange（REQ-PC-3 置 needs_decision）在 /api/actions 中以其关联 Decision 的 kind=decision 条目出现（subject_ref 指向该 Change），经 actions 裁决后按 §3.4 回路生效；actions 条目 kind 集合恒为 task | decision（负向断言：不存在 kind=proposal 条目）。`
  4. §8 一致性表（line 318）：对齐 REQ-PJ-2 说明`Decision 入 actions 是补齐实现缺口；条目联合维持契约的 task | decision 不扩展，待决提案按 REQ-PC-3 经其关联 Decision 收录`。
- **对照结论**：平行通道与非法 kind 已彻底删除，待决提案完全收敛至 K0 REQ-PC-3 与交互契约 §4.2 规定的关联 Decision 机制。判定 **CLOSED**。

---

#### R-04 [MAJOR] 关键验收断言出现二选一与含糊措辞导致不可客观判定
- **核对正文位置**：
  1. §4.4 挂起语义（line 192）：写死`等待原因写死为 Run 行字段 state_reason = "awaiting_node"（Run 处于 queued 且无能力匹配的 online 节点时由派发器置位、派发时清除；验收断言固定查此字段，不接受等价字段）`。
  2. §4.8 验收标准（line 238，K1B-AC-04）：删除「等价字段」字样，写死`Run 保持 queued 且 Run 行 state_reason = "awaiting_node"（固定字段断言），不产生 failed / Decision`。
  3. §5.5 验收标准（line 289，K1C-AC-09）：写死节点 401 后的退避行为——`节点行为写死为：记录一条含 401 的错误日志 → 暂停派发轮询并指数退避重试（初始 5s、倍增、上限 60s）→ 令牌在节点侧被更新（改 env 重启节点进程或实现注明的热加载方式）后自动恢复正常轮询；进程不退出、无无退避死循环重试（验收以日志时间戳序列断言退避间隔）。`
- **对照结论**：二选一含糊与不确定措辞全部消除，字段名、实体位置及节点退避时序均已写死，验收具有完全客观判定性。判定 **CLOSED**。

---

#### R-05 [MAJOR] `disposition` 字段定义自相矛盾且遗漏在命令 Schema 与失败矩阵之外
- **核对正文位置**：
  1. §3.2 命令 Schema（line 67-69）：代码块内正式补入`disposition?: "executed" | "not_executed" | "cancel_run"`，并注释`// 仅 subject 为 Run 对账（REQ-RUN-3）且 verdict=approved 时必填，见 §3.4/§3.5`。
  2. §3.2 校验流水线（line 72）：明确入参校验包含 `disposition`，违反返回 400 `schema_invalid`。
  3. §3.4 效果表（line 87）：表述统一为`处置以 payload disposition 字段提交（封闭枚举 executed / not_executed / cancel_run，仅此 subject 类型必填，缺失 / 非法 → 400，见 §3.5）`，消除了「在 reason 中声明」的内部矛盾。
  4. §3.5 失败矩阵（line 104）：增补专用失败行`subject 为 Run 对账、verdict=approved 但 disposition 缺失或不在枚举内 | 400 schema_invalid（字段级指出 disposition），零事件`。
- **对照结论**：Schema、语义表述与失败矩阵三处完全对齐并闭合。判定 **CLOSED**。

---

#### R-06 [MAJOR] 节点管理事件的 stream 归属及 payload 未定义，`side-effect-note` 契约不完整
- **核对正文位置**：
  1. §4.2 节点管理事件（line 160）：明确写入保留系统流`stream_id = "$system"`（声明其为跨项目基础设施流、供审计与读面消费、并显式指明是对 INV-12 的增补），并给出完整 payload：
     - `NodeRegistered`：`{ node_id, display_name, executor_kinds[], max_side_effect_level, agent_version, registered_at }`；
     - `NodeOffline`：`{ node_id, reason: "deregister" | "heartbeat_timeout", at }`。
  2. §4.4 副作用登记事件（line 194）：明确定义`adapter 以 POST .../runs/:run_id/side-effect-note 登记，请求体 { tool_name: string, note: string }，落盘为事件 RunSideEffectRecorded、写该 Run 所属项目的流（stream_id = 该 Run 的 project_id）、payload { run_id, node_id, tool_name, note, recorded_at }；仅登记事实不开 L2`。
  3. §4.5 接口清单（line 210）：`POST /api/nodes/:id/runs/:run_id/side-effect-note` 明确入流为 `RunSideEffectRecorded`（写该 Run 所属项目流）。
  4. §8 一致性表（line 319）：登记了 `$system` 流与 INV-12 的关系说明。
- **对照结论**：流边界清晰、事件 payload 完整、`side-effect-note` 契约落实为规范的领域事件。判定 **CLOSED**。

---

#### R-07 [MINOR] 命令注释中的内部章节交叉引用错误
- **核对正文位置**：
  - §3.2 line 60：原注释 `// 非 human → 403 actor_not_human（§3.6）` 已准确修正为 `// 非 human → 403 actor_not_human（§3.5）`。
- **对照结论**：笔误已纠正。判定 **CLOSED**。

---

#### R-08 [MINOR] 长轮询占用超时、迟到回报与节点注销等边缘失败分支未封闭
- **核对正文位置**：
  1. §4.7 失败矩阵（line 229）：增补`占用超时（30s）后节点迟到 ack | 409 precondition_unmet，Run 状态不变（可能已回 queued 或已重派，以服务端当前状态为准）`。
  2. §4.7 失败矩阵（line 230）：增补`Run 已达终态后迟到 raw-result（与已落盘结果同 client_result_id 的正常重放除外） | 409 terminal_state，零新事件；同 client_result_id 重放仍按 §4.3 幂等返回首次结果`。
  3. §4.2（line 163）与 §4.7 失败矩阵（line 231）：增补`节点 deregister 时有该节点上 started 未终态的 Run | 409 node_busy，注销不生效、节点保持原状态；仅 leased 未 started 的 Run 时：释放回 queued（占用清除）后注销照常生效`。
- **对照结论**：迟到 ack、终态后 raw-result 及注销在跑 Run 的三处边缘场景全部封闭。判定 **CLOSED**。

---

#### R-09 [MINOR] 长轮询端点响应 Envelope 结构不闭合
- **核对正文位置**：
  1. §4.3 第 1 步（line 169-174）：写死顶层响应结构为统一对象：
     ```json
     { "dispatch": DispatchEnvelope | null,
       "cancel_requests": string[],
       "probe_requests": Array<{ run_id, idempotency_key }> }
     ```
     并规定超时无事件时返回 `{ dispatch: null, cancel_requests: [], probe_requests: [] }`。
  2. §4.5 清单（line 204）：注明长轮询端点返回「统一响应对象 §4.3」。
- **对照结论**：长轮询顶层数据结构规范化，各分支下字段集合恒定且闭合。判定 **CLOSED**。

---

#### R-10 [MINOR] `DispatchEnvelope` 中的 `lease_expires_at` 字段时序早产
- **核对正文位置**：
  1. §4.3 第 1 步（line 178-180）：信封字段改为 `lease_duration_sec`，并注明`信封只带租约时长：租约在 ack 时才起算，绝对到期时间 lease_expires_at 由 ack 响应下发，见第 2 步`。
  2. §4.3 第 2 步（line 181）：写死`ack 的 200 响应体为 { lease_expires_at }，同一绝对到期时间同时写入 RunLeased 事件 payload`。
- **对照结论**：租约起算点与绝对到期时间的生成时序恢复逻辑自洽。判定 **CLOSED**。

---

## 二、回归扫描与新发现

### 1. 重点专项扫描（已查范围与核验结论）

1. **Probe 通道专项**：
   - 查验范围：长轮询下发 `probe_requests`、`POST .../probe-result` 端点定义、幂等去重规则、原节点专属约束、未恢复节点出路。
   - 查验结论：已查。§4.3 第 6 步与 §4.5 端点闭合；明确「probe 只有原执行节点有意义，原节点不恢复则 Run 保持 indeterminate 直至 Decision 人工裁决（REQ-RUN-3）」，未引入跨节点滥派或非原节点 probe；重复回报幂等返回首次结果。发现 1 项边缘未显式列出情形，见 N-02（MINOR）。

2. **`$system` 流专项**：
   - 查验范围：系统流命名保留规则、与 K0 INV-12（`stream_id = project_id`）的关系说明、投影隔离性与审计消费口径。
   - 查验结论：已查。§4.2 明确声明 `$system` 为保留流，不参与项目投影，仅供审计与节点读面消费，并在 §8 显式登记为对 INV-12 的必要增补。全库全序依赖 `global_seq` 回放，未破坏 INV-12 投影重演不变量。

3. **`disposition` Schema 专项**：
   - 查验范围：§3.2 请求体 Schema、§3.4 效果分派表、§3.5 失败矩阵三处字段名、类型与枚举值一致性。
   - 查验结论：已查。三处枚举严格收敛为 `"executed" | "not_executed" | "cancel_run"`，且一致限定为「仅 subject 为 Run 对账且 verdict=approved 时必填，缺失或非法报 400 `schema_invalid`」。完全自洽。

4. **Poll 统一顶层响应专项**：
   - 查验范围：`dispatch`、`cancel_requests`、`probe_requests` 三字段在有任务、无任务（超时）、仅取消、仅对账等不同场景下的结构闭合性。
   - 查验结论：已查。顶层形态固定为包含上述三字段的 JSON 对象，空载时分别填 `null`、`[]`、`[]`，不存在字段缺失或顶层类型漂移。完全闭合。

5. **中间件双豁免专项**：
   - 查验范围：`GET /api/health` 与 `POST /api/auth/session` 豁免后是否存在未授权数据泄露面或中间件自锁。
   - 查验结论：已查。`GET /api/health` 仅返回 `{ ok, auth_enabled }`；`POST /api/auth/session` 自身即为凭据校验端点（校验失败返回 401 且不下发 cookie），未引入任何业务读面/写面的放行漏洞；其余 `/api/*` 全部严密拦截。

6. **`lease_duration_sec` 与 `lease_expires_at` 时序专项**：
   - 查验范围：信封下发、ack 交互、`RunLeased` 事件落地、心跳续约的时序流水线。
   - 查验结论：已查。派发信封带相对时长 `lease_duration_sec`；ack 触发租约起算，绝对时间 `lease_expires_at` 同步返回给节点并入 `RunLeased` 事件 payload，时序前后无矛盾。

7. **`side-effect-note` 与 `RunSideEffectRecorded` 事件流归属专项**：
   - 查验范围：端点入参 Schema、落盘事件名、事件流归属（`stream_id`）及与 REQ-RUN-4 分界判定的联动。
   - 查验结论：已查。写入对应 Run 所属项目流（`stream_id = project_id`），payload 完整（`run_id, node_id, tool_name, note, recorded_at`）。发现 1 项关于网络重试幂等键的微小建议，见 N-03（MINOR）。

8. **依据文件全局扫描**：
   - 查验范围：K0 spec（REQ-PC-5 决策流转、REQ-DC-1 过期≠批准、REQ-RUN-1/3/4/6 租约/对账/分界/取消、REQ-PJ-2 Actions 范围、INV-6 结果写入、INV-13 幂等）；交互契约（M-A4、M5、M8 与 `kind: 'task' | 'decision'` 封闭联合）；PHASES-PLAN（T5 范围及 E2E 硬门）。
   - 查验结论：已查。修订内容与上述依据完全契合，无越界扩张，无新语义冲突。

---

### 2. 新发现清单（New Findings）

#### N-01 [MINOR] §2 line 42 错误码封闭清单内部交叉引用残留笔误
- **位置**：`K1-SPEC.md` §2 通用约定，第 42 行。
- **问题**：
  正文写道：`K1 新增错误码只许增补进 §3.6/§4.7/§5.4 的封闭清单，不许各端点自创。`
  然而：
  - K1-A 的错误码清单位于 **§3.5**（「3.5 失败语义（封闭）」），§3.6 为「投影：My Actions 收待决事项」；
  - K1-C 的错误响应与未授权规则位于 **§5.3**（「5.3 服务端中间件口径」）及 §5.5，§5.4 为「前端入口」。
  此处引用章节号在 v0.1 中即存在偏差，在 v0.2 修正了 §3.2 line 60 的笔误后，§2 line 42 未同步订正，属编辑性交叉引用遗留笔误。
- **建议修法**：
  将 §2 line 42 的 `§3.6/§4.7/§5.4` 修正为 `§3.5/§4.7/§5.3`。
- **为何不阻塞**：
  属于纯编辑性笔误，错误码实际定义在对应小节标题中极易定位，不影响协议可执行性与实现理解。

---

#### N-02 [MINOR] §4.7 失败矩阵未显式覆盖 Run 已终态时迟到 `probe-result` 的 409 分支
- **位置**：`K1-SPEC.md` §4.7 表格与 §4.3 第 6 步。
- **问题**：
  §4.3 第 6 步指出「原节点不恢复则 Run 保持 indeterminate 直至 Decision 人工裁决（REQ-RUN-3 口径）」。若人工裁决已执行（Run 已转为 terminal 态或已被 cancel），随后原节点网络恢复并提交了迟到的 `POST /api/nodes/:id/runs/:run_id/probe-result`：
  §4.3 line 185 虽规定了「同一 run 的 probe-result 只处置一次，重复回报返回首次处置结果」，但 §4.7 失败矩阵在已显式补入「Run 已达终态后迟到 raw-result → 409 terminal_state」的同时，未对迟到 probe-result 显式给出状态码（按 §2 通用词表应为 409 `terminal_state` 或 `precondition_unmet`）。
- **建议修法**：
  在 §4.7 失败表格中增补一行，或在既有终态行中合并表述：`Run 已达终态后迟到 raw-result / probe-result（正常幂等重放除外） → 409 terminal_state`。
- **为何不阻塞**：
  §2 通用约定已写明错误词表复用规则（状态冲突类一律 409），且 §4.3 第 6 步已明确幂等返回首次结果，不影响正常主流程与自动化测试断言。

---

#### N-03 [MINOR] `side-effect-note` 请求 Schema 未显式声明客户端幂等标识
- **位置**：`K1-SPEC.md` §4.4 第 194 行、§4.5 第 210 行。
- **问题**：
  正文定义 `adapter 以 POST .../runs/:run_id/side-effect-note 登记，请求体 { tool_name: string, note: string }`，成功后追加 `RunSideEffectRecorded` 领域事件入项目流。
  若节点端由于 HTTP 响应丢包发生网络重试，因请求体未带 `client_note_id` 或 `idempotency_key`，且 §4.3 line 187 的去重规则仅列举了 `ack/started/raw-result`，未点名 `side-effect-note`，可能导致在项目流中写入两条重复事件，与 INV-13（重复投递只入账一次）存在微小表述张力。
- **建议修法**：
  在 §4.4 / §4.5 的请求体中允许可选 `idempotency_key?: string`，或在 §4.3 line 187 中补充说明「`side-effect-note` 以 `(run_id, tool_name, note)` 幂等去重，重试不产生重复事件」。
- **为何不阻塞**：
  在领域语义上，只要存在 ≥1 条 `RunSideEffectRecorded` 事件即触发 `indeterminate` 分界，重复事件不破坏领域判定结果；且 K1-B 节点为首执行器受控环境，暂不构成功能阻塞。

---

## 三、结构一致性检查

1. **验收标准编号与连续性**：
   - K1-A：K1A-AC-01 ~ K1A-AC-12 连续，共 12 条；
   - K1-B：K1B-AC-01 ~ K1B-AC-12 连续，共 12 条；
   - K1-C：K1C-AC-01 ~ K1C-AC-09 连续，共 9 条；
   - E2E 旅程：J1 ~ J4 连续，共 4 条；
   - 头部 `counts` 声明（12 / 12 / 9 / 4）与正文完全一致。

2. **事件名称与流归属闭合性**：
   - 复用 K0 既有事件：`DecisionResolved`（裁决与审计唯一记录）、`DecisionExpired`、`RunLeased`、`RunStarted`、`RunRawResultReceived`、`RunCanceled`、`PlanChangeApplied`、`PlanRevisionCreated`、`PlanChangeStatusChanged`、`TaskDuplicateResolved`，均在 K0 §4 目录内；
   - K1 新增事件（共 3 个，均写死 payload 与流归属）：
     - `NodeRegistered`（流：`$system`，payload 已写死）；
     - `NodeOffline`（流：`$system`，payload 已写死）；
     - `RunSideEffectRecorded`（流：对应 Run 的 `project_id` 项目流，payload 已写死）。

3. **错误码与状态码闭合性**：
   - §3.5 失败矩阵：`not_found` (404), `terminal_state` (409), `decision_expired` (409), `schema_invalid` (400), `actor_not_human` (403), `subject_not_resolvable_in_k1` (409)；
   - §4.7 失败矩阵：`unauthorized` (401), `node_not_found` (404), `precondition_unmet` (409), `terminal_state` (409), `node_busy` (409)；
   - §5.3 / §5.5 中间件：`unauthorized` (401)；
   - 除 N-01 内部引用号笔误外，所用错误码全部严密收敛于契约既有词表。

4. **内部交叉引用**：
   - §3.2 第 60 行成功修正为 `（§3.5）`；
   - §4.3、§4.4、§4.5 相互引用（第 1/2/5/6 步与端点清单）闭合；
   - §8 一致性表与正文现文保持一致（REQ-PJ-2、INV-12、D1/D3/D5 等声明真实无虚假）。

---

## 四、评审结论

**VERDICT: APPROVED**

**理由**：
第一轮异构评审所列 R-01~R-10 共 10 项问题（含 2 项 BLOCKER 与 4 项 MAJOR）已在 `K1-SPEC.md` v0.2 正文中**全部严格落实并闭环**；本轮全量回归扫描未发现任何新引入的 BLOCKER 或 MAJOR 问题；新发现的 3 项问题（N-01、N-02、N-03）均为 MINOR 级别，属编辑性引用笔误与极端边缘场景的微小完备性增补，已在报告中详细论证其不阻塞实现与测试。

Spec 正文严谨自洽，接口协议、数据结构、验收断言及错误语义均已封闭，达到开工基线标准。
