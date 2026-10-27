# 续行 K0 — 任务队列（自主探索循环）

唯一事实来源。状态：proposed / ready / dispatched / blocked / done / dropped。
每条必须带证据、完成判定与执行器（注册表 `EXECUTORS.md`）；循环只派发不执行，结果回 `hidden_files/results/` 后验收才标 done。章程见 `AUTOPILOT.md`。

## ready

（K0-Q2 已于 2026-10-24 round7 验收为 done，见 done 节；K0-Q3 已于 00:40 验收为 done，见 done 节；K0-Q13 已于 2026-10-24 round9 验收为 done，见 done 节。）

### K0-Q18 Q17-hands-canary3 到点分诊（逾期）— done（2026-10-25 round21：API 证据定锤会话 09:38 已完成，round18「无法定性」结论被取代，见补充结论）
- 为什么：Q17 part ②（tmux 长会话验证）2026-10-24 09:35 派 qoder-web 云端 DeepSeek-Flash（session `qs_01m5nrqvjbckz6evwt693ed80e`），至本轮已逾期约 14h45m，远超同类小活 5–40 分钟实测窗口。
- 内容：查会话一手状态（done / running 有进展 / 挂死 / watcher 失效），查后分诊：已完成→立即 harvest 落地；仍在跑且有进展→更新预估顺延；无进展/挂死→本地接管或续派；限流/报错→停派记台账。
- 完成判定：分诊结论落结果文件（含一手状态证据与下一步）；Q17 part ②状态随之更新（done 或续派）。
- 执行器：coordinator（qoder-watch 路径）；本循环不直接操作浏览器。
- **round17 证据补记（本轮一手核查，非最终分诊）**：`~/workspace/qoder-auto/sessions.json`（mtime 2026-10-24 18:13，已滞后约 6h）中 canary3 条目仍为 `state: unknown, rounds: 1`；`watch.lock` mtime 2026-10-25 00:19（watcher 近期有活动）但 sessions.json 未随之更新——watcher 本身对该会话持续无法定性，分诊须走一手会话查询、不信 watcher 状态。依赖：无。
- **round18 分诊结论（2026-10-25 01:2x–01:4x，一手 CDP 探针）**：见 `hidden_files/results/K0-Q18-triage.md`。CDP 链路正常（Chrome/154，26 targets，canary3 tab 在场），但该 tab websocket 能连、`Runtime.evaluate` 30s 无响应——tab 层 wedged，无法判定 done/running；`qoder_watch.py` 全量检查无 recv 超时、被 wedged tab 挂死 300s+（已终止），sessions.json 自 18:13 起失真即由此致。Q17 part ②不标 done、不标续派（证据不足），继续 dispatched（逾期约 16h）；Q18 转 blocked——卡点：tab wedged + watcher 无超时；解法人：coordinator（① CDP 重载该 tab 后用单会话探针复查一次；② 仍无响应则按挂死以新会话续派 canary4）。单会话带超时探针已沉淀为 `hidden_files/tools/qoder_session_probe.py`，EXECUTORS.md 已登记。
- **round20 注记（2026-10-25 03:2x）**：无新进展；canary3 仍 unknown（sessions 03:18），分诊卡点与解法人不变。Q18 继续 blocked。
- **round21 注记（2026-10-25 04:2x）**：无新进展；sessions 03:50 canary3 仍 unknown；分诊卡点（tab wedged + watcher 无超时）与解法人（coordinator 侧 tab 重载复查或续派 canary4）不变。Q18 继续 blocked。
- **round21 补充结论（2026-10-25 04:2x，本循环一手核验，推翻 round18 结论）**：coordinator 侧 API 核查正本 `hidden_files/web-run/qoder-status-1024.md`（2026-10-24 上午）早已定锤——canary3 会话 `session_status: idle`，09:34:55 创建 → 09:38:10 产物交付 → 09:38:15 结束，全程 3.5 分钟；事件流 seq114 artifact.delivered → seq138 idle → seq142 结论报告 → seq143 状态变更三重印证。round18 探针挂死的是会话列表页 tab 的假死 CDP 通道（该报告 §3.2 已实证列表页 evaluate 超时、会话自身 tab 秒回），不是会话本身；"逾期 18h"实为回收滞后（产物 09:38 已交付，web-run/ 落档 15:37，本循环此前各轮只查了 results/ 预期文件名、漏查 web-run/ 落点）。补充结论落档 `hidden_files/results/K0-Q18-triage-supplement.md`；Q17 part ②随之 done，canary4 续派取消。工具债（qoder_watch.py 无超时/无隔离）仍成立，待 coordinator 侧排期修。Q18 标 done。

### K0-Q20 K1 spec（先 spec 后 develop）— dropped（2026-10-25 round26：已被协调者侧已定稿并已交付的 K1 spec + K1 实现 supersede，见 round26 注记）
- 为什么：用户 23:00–23:12 拍板 K1 并行启动、范围裁决归协调者；K1 范围已裁决：A 决策闭环（resolve_decision + 待办收待决 + 裁决交互）、B 本地执行节点最小形态（适配层 + 注册心跳 + Run 派发，首执行器 agent-hands）、C 基础访问控制（部署面令牌）；不做多用户/Temporal/移动端/品牌。
- 内容：先写 K1 spec，经异构评审（contract-review 口径）+ 协调者批准后转 develop；spec 内写明三条 e2e 口径（决策旅程：提议→裁决→任务真生成；节点执行旅程：派发→执行→回报→验收；未授权拦截旅程）。
- 完成判定：spec 经异构评审通过 + 协调者批准开工（develop 本体另行派发，不在本条内）。
- 执行器：spec 起草 qoder-web/workbuddy-cloud（免费模型）→ reviewer-subagent（异构评审）。
- 依赖：spec 本身无依赖；develop 依赖 spec 批准 + 合并顺序（T1/T4 之后）。
- **round17 派发前置（dispatch-ready 任务书已落盘）**：任务书 `hidden_files/k1-spec-brief-2026-10-25.md`（范围/e2e/交付/约束齐全，基线远端 tip `80a09c1` 已核验）；**派发动作暂缓**：CDP 隧道 12234 监听缺失（本轮 `ss` 核查），须按 `~/workspace/qoder-auto/NOTES.md` 文档化流程重建并验证后方可派发；opencode-xc 串行正被 Batch 2 占用，但 qoder-web 云端与之不冲突。Q20 标 ready 不标 dispatched——无会话 ID 的派发不算派发。
- **round18 派发（2026-10-25 01:26 CST，本轮唯一一格）**：12234 监听已恢复（`ss` + CDP `/json/version` Chrome/154 双重验证），派发前置解除；经注册表路径 `qoder_ask.py`（派发子代理执行，CDP 12234）派往 Qoder 云端 DeepSeek-Flash 0x，一次成功：会话 `qs_01m5qf66af4057b7vkkj3xe4dm`（`https://qoder.cn/m/session/qs_01m5qf66af4057b7vkkj3xe4dm`），sessions.json 已核验新增条目 state=running。Agent 侧任务书 `hidden_files/k1-spec-prompt-2026-10-25.md`（自包含：codeload 取仓口径、范围/e2e/交付、无凭据交付方式——云端无推送凭据，patch 经平台产物交付、协调者侧回收推送，不索要 PAT）；预估 1–3h，到点无回写按派发调度纪律分诊。Q20 由 ready→dispatched；spec 草案交付后另派 reviewer-subagent 异构评审，评审 APPROVED + 协调者批准开工后 Q20 才标 done。
- **round19 注记（2026-10-25 02:2x，本循环 harvest）**：会话侧已停（单会话探针 `running: false`、tools 6），页文本已 harvest（`results/2026-10-25_qs_01m5qf66af4057b7vkkj3xe4dm_harvest.txt`）：自报分支 `qoder/k1-spec` @ `b363ccf`、草案 `spec/K1-SPEC-DRAFT.md`、patch `k1-spec-draft.patch` 693 行、自查四项全过、OQ 需裁决 4 条 + 可推出 5 条、基线远端 `ab1504e` 内容一致。但页文本不含草案正文，全 workspace 无该 patch 文件、无产物下载脚本——**评审派发被产物回收卡住**，无正文不派评审（防假评审）。Q20 继续 dispatched；下一步为 coordinator 侧从会话产物区下载 patch 落盘，落盘后本循环派 reviewer-subagent 异构评审。
- **round20 注记（2026-10-25 03:2x，本循环一手核查）**：workspace 全量检索仍无 `k1-spec-draft.patch`（仅任务书 brief/prompt 两件）；`sessions.json` 03:18 更新后 Q20 仍 `state: unknown`（watcher 失能残留，非会话真值）；评审派发继续卡住，不派假评审。Q20 继续 dispatched。
- **round21 注记（2026-10-25 04:2x，本循环一手核查）**：goals/k0 + qoder-auto 定向检索仍无 `k1-spec-draft.patch`（仅 QUEUE/探索日志/旧 harvest 提及）；sessions.json 03:50 更新后 Q20 仍 unknown。评审派发继续卡住，不派假评审。Q20 继续 dispatched；产物回收仍属 coordinator 侧（Qoder 产物区下载路径见 Q15-RECOVERY-1024.md §1 同类流程）。
- **round22 注记（2026-10-25 05:2x，本循环到点分诊）**：单会话探针（venv python，60s 超时）返回 `running: false, tools: 6`，尾部确认 spec 草案已交付、协调者侧可执行 `git am k1-spec-draft.patch` 后推 `qoder/k1-spec`——**会话已结束**（派发 01:26，预估 1–3h，现 4h 到点分诊结论：完成待回收，非挂死）；但全量检索仍无 patch 落盘，评审派发继续卡住，不派假评审。sessions.json 04:22 仍 unknown（watcher 失能，探针为准）。Q20 继续 dispatched；下一步唯一动作是 coordinator 侧下载 patch 落盘，落盘即派 reviewer-subagent 异模型评审。
- **round23 注记（2026-10-25 06:2x，本循环一手核查）**：单会话探针复查仍 `running: false, tools: 6`，尾部交付语与 round22 一致（`git am k1-spec-draft.patch` 后推 `qoder/k1-spec`）；全量检索仍无 patch 落盘（web-run/ 最新仍是 04:29 总验收报告，无新增）；sessions.json 06:14 已刷新但 Q20 仍 `unknown`（watcher 持续失能，探针为准）。Q20 继续 dispatched，评审派发继续卡住，不派假评审。
- **round24 注记（2026-10-25 07:2x，本循环一手核查）**：单会话探针复查仍 `running: false, tools: 6`，尾部交付语与 round22/23 一致；全量检索仍无 patch 落盘；sessions.json 07:14 已刷新但 Q20 仍 `unknown`（watcher 持续失能，探针为准）。Q20 继续 dispatched，评审派发继续卡住，不派假评审。
- **round26 注记（2026-10-25 09:2x，本循环一手核验，Q20 转 dropped）**：单会话探针复查仍 `running: false, tools: 6`，尾部交付语不变（`git am k1-spec-draft.patch` 后推 `qoder/k1-spec`），patch 仍未落盘——但本轮核查发现 Q20 的任务目标本身已被 supersede：`goals/k0/files/K1-SPEC.md` v0.4（mtime 2026-10-24 23:48，早于 Q20 派发 01:26）头部已载明「APPROVED（第二轮异构复审，R-01~R-10 全闭环；v0.4 协调者裁决登记版为 K1 develop 执行基线）」，且 K1 实现已按此 spec 走完 develop→评审→fix→合入（`f4989e8`）→部署（镜像 20261025-0333）→K0 总验收 ACCEPTED 全链。Q20 完成判定（spec 经异构评审通过 + 协调者批准开工）所求的路径，协调者侧 spec 已全部走完且产物已交付；Qoder 草案 patch 即便此刻落盘也只能是一份滞后对照，不再是 K1 的 spec 正本，继续等回收 + 另派评审属无效返工。故 Q20 由 dispatched→dropped（superseded），不再等待 patch 落盘、不再派评审；Qoder 会话本身已结束，无需外部取消动作。附带教训：round18 派发前未核查 files/ 是否已有 K1-SPEC.md——今后派发"起草类"任务前须先查正本是否已存在。
- **round25 注记（2026-10-25 08:2x，本循环一手核查）**：单会话探针复查仍 `running: false, tools: 6`，尾部交付语与 round22–24 一致（`git am k1-spec-draft.patch` 后推 `qoder/k1-spec`）；全量检索仍无 patch 落盘；sessions.json 08:10 已刷新但 Q20 仍 `unknown`（watcher 持续失能，探针为准）。本轮首探曾报 CDP Connection refused（12234 监听在场），数分钟后重探即恢复（Chrome/154、探针正常）——判为瞬时转发抖动，非状态变化，不修。Q20 继续 dispatched，评审派发继续卡住，不派假评审；下一步唯一动作仍是 coordinator 侧从 Qoder 产物区下载 patch 落盘。

### K0-Q4 Batch 2 批次规划（命令层 + 4 个已分流 stub）— done（2026-10-25 round20：评审 APPROVED + 已合入 develop/eventstore-batch1，批次闭环）
- 内容：把已有 stub 收成一个可派发批次——appendBatch（INV-11 同事务多事件 + reverify-R1 from/to 设防）、canonicalJson F3、Run guard 接入（含 re-verify F1/F2 + product-F1 type↔state 互校）、事务完整性（product-F3 事务外写拒绝 / product-F4 事务内误用外层 store 报错 / reverify-R2 COMMIT tag 检查）、增量消费水位保护；外加 Batch 2 命令层（Scheduler 落地 + Acceptance 重算）。
- 计划文档（自包含，可直接派 develop）：`hidden_files/batch2-plan-2026-10-24.md`。含编号对照（re-verify F1/F2、reverify-R1/R2、product-F1–F8 三套编号来源不同、不得互换）与 K0-Q15 fix 波次的去重对账要求。
- **开工前置（P1 口径，待用户确认）**：① S1–S6 范围是否齐；② S3b（C6 actor 分离是否并入）；③ Q15 去重对账责任人（默认 coordinator）。**硬停线：范围确认前不派发 develop。**
- 完成判定：plan 文档已产出 ✓；用户范围确认后派 opencode-xc develop。
- 执行器：规划由循环完成（plan 文档 ✓）；实现派 opencode-xc（用户确认后）；范围确认派 user。
- 依赖：K0-Q2（Batch 1 闭环）✓ 已满足。
- **round11 注记（2026-10-24 09:20）**：用户范围确认仍未到达；硬停线，本轮未派发。
- **round12 注记（2026-10-24 10:20）**：用户范围确认仍未到达；硬停线，本轮未派发。
- **round13 注记（2026-10-24 11:25）**：用户范围确认仍未到达；硬停线，本轮未派发。
- **round14 注记（2026-10-24 12:22）**：用户范围确认仍未到达；硬停线，本轮未派发。
- **round15 注记（2026-10-24 13:20）**：用户范围确认仍未到达；硬停线，本轮未派发。连续第四轮无新结果且无可派发 ready，章程"停循环报用户"条件仍成立，详见 round15 探索日志。
- **round16 注记（2026-10-24 23:20，本循环一手核验）**：硬停线解除——用户 23:00–23:12 拍板三阶段全执行 + K1 并行（正本 `hidden_files/PHASES-PLAN-1024.md`）；Batch 2 develop 已于 23:06:41 开工（xc `~/bin/nx-api-run.py`，模型 `magpie/workbuddy-ai/deepseek-v4.1-flash`，session `ses_e918cde0effeuXFdsgNpBLZpKP`，worktree `/work/xuxing-batch2`，分支 `feat/eventstore-batch2`，基线远端 tip `80a09c1`；23:20 直查 `develop.status` = RUNNING/ATTEMPT=1/prompting，预估 2–3h）。Q4 由 ready→dispatched；派发动作属协调者 Batch 2 轨道，本循环登记、不重复派发。
- **round17 注记（2026-10-25 00:20，本循环一手核验）**：`develop.status` 仍 RUNNING/ATTEMPT=1/prompting（开工后 1h14m，预估 2–3h 内，不干预）；batch2 worktree 仍 @ `80a09c1`、工作区干净（首批提交未出，正常）；远端 tip 仍 `80a09c1`；远端新增 `fix/actions-page` @ `9293e2f`（T2 Fix Round 4 进行中，与 Batch 2 基线不冲突）。Q4 继续 dispatched。
- **round18 注记（2026-10-25 01:2x，本循环一手核验；round17 注记已过期）**：Batch 2 develop 已换通道重跑——Attempt 1（magpie/workbuddy-ai，23:06）生成楔住 81 分钟无完成步、Attempt 2（同通道，00:43）首条生成即楔住，magpie 通道 01:10 判定不可用并切换；**Attempt 3（opencode-go/deepseek-v4.1-flash，01:10:26，session `ses_e911b9183ffejsuenA5DA6moAK`，timeout 240 分钟）进行中且已产出**：首提交 `e426d03`（S1 appendBatch）+ 工作区在改（event-store-pg.ts 等 4 文件），状态文件 `develop3.status` RUNNING/prompting。详见 `hidden_files/batch2-run/DEVELOP-1024.md` §3。Q4 继续 dispatched；后续 Batch 2 的 review/fix 通道选型应避开 magpie/workbuddy-ai 或先小流量验证。另：远端 tip 已推进至 `ab1504e`（PR #8 Fix Round 4 合入），Q20 任务书里的 `80a09c1` 基线注记随之过期（spec 起草以冻结 spec 为准，不影响）。
- **round19 注记（2026-10-25 02:2x，本循环一手核验）**：Attempt 3 已于 02:02 STATUS=DONE（coordinator 侧 DEVELOP-1024 §4 独立核对：marker 正常、50 条消息、完整交卷 + `NX_PHASE_COMPLETE`；分支 `feat/eventstore-batch2` @ `a7b8cfc`，10 提交，worktree 干净；独立全量复跑根 523 passed / 5 todo / 0 failed、server 72/72、spec50 真服务轮 3/3）。未 push、未 merge，等协调者后续环（review/fix）。Q4 继续 dispatched——develop DONE ≠ 批次闭环，不标 done。
- **round20 注记（2026-10-25 03:2x，本循环一手核验）**：Batch 2 评审闭环 + 合入完成，批次闭环，Q4 标 done。评审 `hidden_files/batch2-run/REVIEW-1024.md`（02:55）→ **APPROVED**（BLOCKER 0 / MAJOR 0 / MINOR 2；Gemini 3.8 Flash 盲评；评审员独立全量复跑根 523 / server 72 / spec50 3 passed 与 develop 复跑逐项一致；TRIAGE 3 项全落地）；合入 `c811105`（`web-run/deploy/MERGE-DEPLOY-1024.md` §1，门禁根 523 / server 72 / spec50 4 passed 全绿）。develop 合 master 不在本轮，属后续主线步骤，不影响本条 done。

## proposed

### K0-Q16 回收并推送 qoder/repo-docs（VISION/STATUS/docs-check 落库）— done（2026-10-24 round6）
- 为什么：用户 2026-10-24 明确"项目资产进仓库 + 唯一真相 + 文档代码强制一致"——qoder-web 云端 DeepSeek-Flash 已按此交付 `docs/VISION.md`（逐字正文）、`docs/STATUS.md`（首行 `based_on: fd0e3479`）、`tools/docs-check.mjs`（四项检查：引用存在性/based_on 祖先+D编号不重复/STATUS-DECISIONS 查重，本地真跑通过且做过负向自证）、`.github/workflows/docs.yml`（push/PR 跑 docs-check）；分支 `qoder/repo-docs`（06e222d，src/tests/spec 零改动）已本地提交但**未能推送**（云端无凭据）；产物 `qoder-repo-docs.zip` / `qoder-repo-docs.bundle` 已交付。
- **round6 验收（一手证据）**：`git show HEAD:docs/VISION.md`（标题"续行愿景锚点"）、`docs/STATUS.md`（首行 `based_on: fd0e3479`）、`tools/docs-check.mjs`、`.github/workflows/docs.yml` 均已在 `develop/eventstore-batch1` @ `63b3e8e` 落位（合并提交 `d1d2aa1` workbuddy/repo-docs + `63b3e8e` 恢复协调者正本，合并时修正执行器两处擅改=人工评审落定）。upstream 无 `qoder/repo-docs` 分支（从未推送，无需删分支）。原 qoder/repo-docs 推送路径被 workbuddy 通道 **supersede**，目标（VISION/STATUS/docs-check 落库）已等价达成，故按 done 验收；完成判定中"分支推送/删分支"按原路径书写，偏差如实记录。
- 注意两处事实缺口（云端 agent 已上报，未自改）：VISION 引用的 D8/D9 在仓库 DECISIONS.md 尚不存在（只有 D1–D7）；STATUS 写的 qoder/fix-batch1-review 与 qoder/journey-tests 在远端尚不存在（后者本轮已推送，前者仍待回收）。
- 证据：`hidden_files/results/2026-10-24_qs_01m5mx4m40_harvest.txt`；一手核验见 `hidden_files/explorations/2026-10-24-round6.md` §2。

### K0-Q17 SSH 手补完：deploy key + 网页 agent 实操验通 — done（2026-10-25 round21：三部分全闭环，见 round21 注记）
- 为什么：Web 三车道派发时协调者漏评估 SSH 手通道（用户点名质询后立项）。容器 ah1 今晚已验（测试 165/165、PG 43/43），但缺 GitHub deploy key、且网页 agent 经 SSH+tmux 实操从未验过，它就还不是完整通道。
- 内容：① 给 ah1 加限 medivhc/xuxing 的 deploy key（写权限），容器内 git push 实测一笔小提交；② 派一个网页 agent（Qoder 或 WorkBuddy 云端）按 `~/workspace/agent-hands/BRIEFING.md` 经 SSH 手完成一单自包含小活（有时限命令 + tmux 长会话的配合方式如实记录）；③ 结果沉淀：BRIEFING.md 修订 + 派单 checklist 增加「是否评估过 SSH 手」。
- 完成判定：deploy key 推送实测成功；网页 agent 小活交卷且回收链路（容器→协调者）跑通；BRIEFING.md 更新落盘。
- 执行器：key 配置由 coordinator（经 xc）；实操小活派 qoder-web 或 workbuddy-web（免费模型）。
- 依赖：无（ah1 与隧道现行可用；DOCKER-USER 隔离规则重启会掉，动手前先核在不在）。
- **round11 注记（2026-10-24 09:35，本循环派发）**：开工条件（用户批准+证据/判定/执行器齐全）满足，proposed→ready→dispatched 同轮走完。拆分派发：part ②（tmux 长会话验证）已派 qoder-web 云端 DeepSeek-Flash（session `qs_01m5nrqvjbckz6evwt693ed80e`，label K0-Q17-hands-canary3，预期回写 `hidden_files/results/K0-Q17-hands-canary3.md`）；派发前发现 12234 CDP 隧道已死，已按 NOTES.md 文档化流程重建并验证 CDP 正常；key 仅进 --prompt 参数、未落盘。part ①（deploy key 配置+push 实测）与 part ③（BRIEFING.md 修订+派单 checklist）为 coordinator 侧工作，待认领。Q17 保持 dispatched 直到三部分全闭环。
- **round12 注记（2026-10-24 10:28）**：hands-canary3（`qs_01m5nrqvjbckz6evwt693ed80e`）sessions 状态仍 `running`，预期回写文件尚未出现；派发仅 45 分钟，正常窗口内，不干预。part ①/③ 仍待 coordinator 侧认领。
- **round13 注记（2026-10-24 11:25）**：hands-canary3 watcher 状态仍 `running`（派发后 1h45m，正常窗口内，不干预），预期回写文件未出现。part ①/③ 仍待 coordinator 侧认领。
- **round14 注记（2026-10-24 12:22）**：hands-canary3（派发后约 2h55m）预期回写文件仍未出现；part ①/③ 仍待 coordinator 侧认领。
- **round15 注记（2026-10-24 13:20）**：预期回写文件仍未出现（派发后约 3h45m），watcher 持续监控，不干预；part ①/③ 仍待 coordinator 侧认领。
- **round16 注记（2026-10-24 23:20）**：预期回写文件仍未出现（派发后约 13h45m），远超 Qoder 云端小活 5–40 分钟实测窗口，不再记"正常窗口内"，转为逾期；分诊新立 K0-Q18（proposed），Q17 本体继续 dispatched；part ①/③ 仍待 coordinator 侧认领。
- **round17 注记（2026-10-25 00:20）**：预期回写文件仍未出现（派发后约 14h45m）；watcher 侧一手证据见 Q18 round17 补记（sessions.json 滞后 6h、canary3 持续 unknown）——分诊任务 Q18 已由 proposed 晋升 ready，待 coordinator 走 qoder-watch 一手查询路径分诊；part ①/③ 仍待 coordinator 侧认领。
- **round18 注记（2026-10-25 01:4x）**：分诊已出（见 Q18 round18 注记与 `results/K0-Q18-triage.md`）：canary3 tab 层 wedged、无法定性，part ②继续 dispatched（逾期约 16h），待 coordinator 侧 tab 重载复查或续派 canary4；part ①/③ 仍待 coordinator 侧认领。
- **round20 注记（2026-10-25 03:2x）**：`sessions.json` 03:18 更新后 canary3 仍 `state: unknown`（watcher 持续无法定性）；预期回写仍未出现（派发后约 17h50m）。part ②继续 dispatched，part ①/③ 仍待 coordinator 侧认领。
- **round21 注记（2026-10-25 04:2x，本循环一手核验）**：part ①/③ 已闭环——coordinator 报告 `hidden_files/web-run/Q17-COORD-PARTS-1024.md`：deploy key（GitHub id 167501551、标题 ah1-agent-hands、写权限、verified）+ 容器内探针推送（分支 ah1/deploy-key-probe @ aed5f4c、沙盒侧独立读回一致，未合入、待删）；BRIEFING.md 三份 md5 一致（ef0d002a…，含派单前 checklist 第 1 条「是否评估过 SSH 手」）。附带未尽：ah1→ah-pg 隔离误伤（DOCKER-USER 过宽）待授权修规则、探针分支待删。part ②仍 pending：sessions.json 03:50 canary3 仍 unknown、预期回写仍未出现（派发后约 18h50m）。Q17 继续 dispatched（须三部分全闭环才 done）。
- **round21 harvest（2026-10-25 04:2x，本循环一手核验，Q17 闭环）**：part ② 报告本轮在 web-run/ 找回并 harvest——`hidden_files/web-run/hands-canary-3-report.md`（10247 B，与 Qoder 产物区 artifact `size_bytes: 10247` 逐字节一致，已归档 `hidden_files/results/K0-Q17-hands-canary3.md`，cmp BYTE-IDENTICAL）；API 三重证据（detail idle + 事件流 artifact.delivered/idle/结论 + 末条 assistant 全链路通过）见 Q18 补充结论。完成判定三项全满足：① deploy key 推送实测成功 ✓；② 网页 agent 小活交卷且回收链路跑通 ✓（SSH 登录 + tmux 长会话 + 轮询取输出 + 清理无残留，gotcha 清单与三套模板已沉淀进报告）；③ BRIEFING.md 更新落盘 ✓。Q17 标 done。残留（不属完成判定）：ah1→ah-pg 隔离误伤待授权修、探针分支待删，见 Q17-COORD-PARTS 未尽事项。

### K0-Q6 Batch 3 生产投影 + C5 实时消费者基线
- 内容：第一个生产投影消费者落地时补「边追加边 apply vs replay 重建逐字段 diff 为零」基线（复验 F4）；在此之前不得声称生产投影已验证。
- 完成判定：基线用例落库且绿；stub run `xuxing-k0-batch3-projection-live-consumer` 转正。
- 执行器：opencode-xc。
- 依赖：K0-Q4（投影消费机制设计）。

### K0-Q7 建 ask-chatgpt 执行器（首个「探索 → 程序」样例）
- 为什么：用户 2026-10-23 举的原型例子 — 需要外部建议时，与其每次人工开网页问 ChatGPT，不如第一次探索通浏览器操作路径、抽象成可异步调用的程序，之后循环直接调用、结果回收件箱。建成后它本身就是 K0 及其他目标的通用执行器（第二意见、方案对照），也验证「探索→程序」模式可复制。
- 探索要点（第一次）：用独立浏览器 profile 打开 ChatGPT 网页版（用户是 Plus），走通登录态 → 提问 → 等待生成 → 取回全文的完整路径；记录选择器/等待条件/失败形态（登录过期、限流、改版）。
- 完成判定：① 程序可命令行调用（输入问题文件，异步运行，问答全文落 `hidden_files/results/` 指定文件）；② 用一个 K0 真实问题实测一次成功（如请它对 Q5 差距盘点提外部视角）；③ 调用方式与限制登记进 `EXECUTORS.md`；④ 全程不碰用户日常浏览器 profile。
- 执行器：探索由循环亲自做（分钟级实验口径），沉淀后它自己成为执行器。
- 依赖：无。注意：网页自动化的风控评估此前在旁聊「网页自动化」有上下文，动手前先读那边的结论。

### K0-Q8 REQ-DT-2 双轨对照报告（G5 + 退出门第三项）
- 为什么：退出门要求「REQ-DT-2 对照报告已评审」，当前零证据；G5（任选 3 个已完成 pipeline run 导入）是 K0 验收的双轨验证，独立于代码实现、可早做。
- 完成判定：① 任选 3 个已完成 pipeline run 导入，产出映射成功率 + 无法映射清单；② 映射出的 Acceptance 逐条核对 actor 分离（REQ-ACC-2），不满足的显式列出、不静默跳过；③ 报告经独立评审（verdict 明确）后落 `~/workspace/xuxing/` 指定位置。
- 执行器：opencode-xc（导入脚本/映射）+ reviewer-subagent（报告评审）。
- 依赖：无。

### K0-Q9 PlanChange 校验流水线 + C3 并发冲突 + G2 plan_rev 机制（REQ-PC）
- 为什么：差距表确认 REQ-PC 未实现，C3（同 base_plan_rev 并发提交恰一个成功 + base_rev_conflict + 三方差异）与 G2（运行中改计划：input_snapshot 哈希不变、新 Run 用新 plan_rev、旧 Revision 可查回）同源缺失。
- 完成判定：① REQ-PC 校验流水线实现；② C3 混沌用例绿；③ G2 golden 用例绿（含 input_snapshot 哈希前后不变断言）。
- 执行器：opencode-xc。
- 依赖：K0-Q4（Batch 2 plan 批准 + 用户范围确认后方可实现）。

### K0-Q10 Run 租约/对账 + Scheduler/WaitCondition（C1/C1b/C4，REQ-RUN-4/REQ-SCH-3）
- 为什么：C1（已启动 Run 被杀→租约过期→indeterminate→对账 reconciled_not_executed）、C1b（leased 未启动被杀→回 queued）、C4（WaitCondition 到期前重启→到期仍触发）均无实现；Scheduler 本体未建。
- 完成判定：① REQ-RUN-4 租约/对账实现；② C1/C1b/C4 混沌用例全绿；③ Scheduler 落地（含 REQ-SCH-3）。
- 执行器：opencode-xc。
- 依赖：K0-Q4。

### K0-Q11 G1 全旅程实现（REQ-HUM / Acceptance / INV-11 / REQ-DD-1）
- 为什么：G1 目前只有测试夹具；全旅程需人类执行协议（Feedback 原文入账→Outcome→Run succeeded→awaiting_acceptance）、Interpreter 提议 PlanChange 经 Policy 自动应用、WaitCondition 在终态按 INV-11 自动 cancel、同一 Feedback 10 次重放仍恰一个跟进 Task。
- 完成判定：G1 golden 用例全绿（含 10 次重放幂等断言与 WaitCondition 自动 cancel 断言）。
- 执行器：opencode-xc。
- 依赖：K0-Q4（命令层 plan 先行）。

### K0-Q12 C6 actor 分离与凭据拦截（REQ-ACC-2 / INV-6）— done（2026-10-25 round20：评审 APPROVED + 已合入 develop/eventstore-batch1）
- 为什么：C6（Agent 凭据写 source_kind=tool_output 的 Evidence 失败；Agent 验收自己执行的 Run 被拦截）无实现。
- 完成判定：C6 混沌用例绿（两条拦截路径各有正反用例）。
- 执行器：opencode-xc。
- 依赖：K0-Q4（由 Q4 plan 裁决：独立实现，或并入 Batch 2 的 run-guard-wiring）。
- **round20 注记（2026-10-25 03:2x，本循环一手核验）**：评审 `hidden_files/web-run/Q12-REVIEW-1024.md` → **APPROVED**（BLOCKER 0，P2×3/P3×3 不阻塞合入）；合入 `c4e2f85`（MERGE-DEPLOY §2，门禁根 561 / server 85 / spec50 全绿）。与 Q13 done 口径一致（合入 + 异模型评审通过），Q12 标 done。
- **round16 注记（2026-10-24 23:20）**：PHASES-PLAN T4 映射即本条——独立 worktree `feat/actor-separation`，合并顺序排 T1（Batch 2）之后；e2e 为 actor 校验负向用例全覆盖。仍 proposed，待 T1 串行空位与合并顺序到达再派。

### K0-Q21 公网 resolve_decision 直验（待生产首个 pending Decision）— proposed（2026-10-25 round21 由 Q19 残留项立项）
- 为什么：MERGE-DEPLOY-1024.md §7：四轨部署后公网 e2e 唯一部分项——生产数据由 K1 之前种子生成、无 pending Decision，公网只能验端点存活（未知 decision_id 对 human/agent 均 404 not_found、无信息泄漏）；pending→resolved 完整状态真变已在同一合并树本地真服务轮 J1（3/3）+ CI 绿轮中证明。
- 内容：生产首个 pending Decision 出现后，对 https://tg.bewith.link 做一次 resolve_decision 公网直验（human 令牌裁决 → API 回读 status=resolved + 派生任务/状态真变）。
- 完成判定：公网直验记录落档（含 decision_id、裁决前后状态回读），或经核查确认该路径已由后续公网旅程覆盖。
- 执行器：coordinator / Web 轨 e2e 脚本（public-e2e-api.sh 同类口径）。
- 依赖：生产首个 pending Decision（触发条件，未到不派发、不催促）。

### K0-Q22 验收 F3：J2 其余日志类断言一并轮询化 — proposed（2026-10-25 round22 由总验收 follow-up 立项）
- 为什么：`K0-ACCEPTANCE-1025.md` follow-up F3——总验收轮只修了实锤一处（J2 agent 日志断言改轮询等待），其余同类日志断言仍是一次性读，仍有 flaky 残留。
- 内容：把真服务轮中其余日志类断言一并改为轮询等待（stdout 累积晚于服务端落账的同类时序问题），复跑真服务轮确认零 flaky。
- 完成判定：同类断言清单 + 轮询化改动落库；真服务轮复跑通过。
- 执行器：opencode-xc 或 coordinator 侧（测试硬化小项，合并顺序由 coordinator 定）。
- 依赖：develop 合 master 节奏（用户点击后）由 coordinator 排序；不阻塞 K0 交付。

### K0-Q23 验收 F4：命令回执事件类型卫生 — proposed（2026-10-25 round22 由总验收 follow-up 立项）
- 为什么：`K0-ACCEPTANCE-1025.md` follow-up F4（源自 DUAL-TRACK O-1）——命令回执借用 PlanChangeApplied 类型入账，统计口径含混。
- 内容：给回执独立事件类型，或在统计口径中注记剔除（二选一，取改动面小的方案）。
- 完成判定：回执不再混入 PlanChangeApplied 统计（或口径注记落文档）；相关测试绿。
- 执行器：opencode-xc（内核卫生，低优先）。
- 依赖：无；不阻塞 K0 交付。

### K0-Q24 验收 F7：K1 spec 修订待办 m-04/m-05 — proposed（2026-10-25 round22 由总验收 follow-up 立项）
- 为什么：`K0-ACCEPTANCE-1025.md` follow-up F7——K1 spec 修订待办 2 条：m-04 注销后重注册落字、m-05 §5.3 附注。
- 内容：按总验收报告口径把两条修订落进 K1 spec 文档（文档小修，不动实现）。
- 完成判定：m-04/m-05 两条在 spec 文档中可查；docs-check 通过。
- 执行器：coordinator 侧文档修订（或 qoder-web 短活）。
- 依赖：K1 spec 评审态（Q20 评审闭环后顺手做，不单独派发长活）。

### K0-Q25 Agent 执行器（agent_hands_agent）— done（2026-10-25 当日交卷，总墙钟 ~1h44m）
- 为什么：K1 上线后断点明确——拆分产出的子任务是「人话」形态，节点只会执行预置 shell 命令，「拆分 → 自动执行」不闭环。方案正本 `goals/k0/files/AGENT-EXECUTOR-PLAN-1025.md`（五面扫描 + 推荐切片），用户 2026-10-25 看方案后拍板开工。
- 内容：节点新增执行器 `agent_hands_agent`（ExecutorAdapter 四方法，ah1 内 tmux 跑 opencode，模型 opencode-go/deepseek-v4.1-flash，定级 L1，每 Run 独立 worktree，30 分钟可配上限）；服务端只动派发一处（createExecutorRun 路由：无 command → agent kind；快照增补 instruction/project/workspace/timeout_ms）；ah1 provisioning（装 opencode + 最小化 auth 拷贝）脚本化；生产 e2e 目标取 K0-Q23。
- 完成判定：评审 APPROVED 合入 develop + 部署（服务端镜像 + 节点切换，留回滚锚）+ 生产 e2e 硬门逐项过（真拆分 ≥3 子任务、Agent 类子任务节点自动执行全程一条、产物过真测试、超时判败、离线续派、一条停 awaiting_acceptance 待用户验收）。交卷正本 `hidden_files/web-run/AGENT-EXEC-REPORT-1025.md`。
- 执行器：本轨 coordinator（develop opencode-xc / 评审 Gemini 盲评 / e2e coordinator 一手）。
- 任务书：`hidden_files/web-run/AGENT-EXEC-1025.md`。
- **收官（2026-10-25 18:10）**：合入 develop（主合并 `15af832` + 竞态 fix2 `8ed1a7e` + STATUS 刷新 `0c53b76`，CI + docs-check 全绿）；部署生产（镜像 `xuxing-web:20261025-1726` + 节点双 kind 注册，回滚锚齐）；评审三轮全 APPROVED（首评 MINOR 5 → fix 后 0/0/0；fix2 复验 0/0/0）。生产 e2e 硬门全过：3 子任务（Q23/F4）节点自动执行、主任务产物经协调者真 PG 独立复跑 27/27、超时判败、离线续派，4 条任务停 awaiting_acceptance 待用户验收（产物分支在 ah1 内未 push，清单见交卷报告 §5）。e2e 逼出的并发 fetch 竞态已修且生产复测消除。交卷正本：`hidden_files/web-run/AGENT-EXEC-REPORT-1025.md`。

### K0-Q13 D9 交互契约（四入口状态机 + 质感清单）— dispatched（2026-10-24 00:50）
- 为什么：D9 质量门要求 Web 实现前先有经评审的交互契约（见 `~/workspace/xuxing/docs/DECISIONS.md` D9）。
- 派发：qoder-web（云端 DeepSeek-Flash）会话 `qs_01m5mtt8dw307099drj6ggvaz1`，分支 `qoder/interaction-contract`，交付 docs/interaction-contract.md + D9 追加进仓库 DECISIONS。
- 完成判定：契约文件合入后，另派**异模型契约评审**（contract-review 模式，评审员≠起草模型）通过才算 done；Open Questions 需用户拍板的单独上报。
- 执行器：qoder-web（起草）→ reviewer-subagent（评审）。
- **round3 注记（2026-10-24 01:30）**：草案已 push，GitHub API 核验分支 `qoder/interaction-contract` @ `f4bbc4f`（父 `fd0e347`，commit 信息与草案一致）。原始会话日志中的授权 PAT 已脱敏（`[REDACTED-GHP]`）。顺序微调（coordinator 裁决）：先在分支上做异模型契约评审，APPROVED 后再合入（终态"合入+评审通过"不变，develop 不先吸入未审文档）。异模型契约评审已派发（2026-10-24 01:35，reviewer-subagent，Gemini 3.8 Flash 经沙盒 relay；预期回写 `hidden_files/results/K0-Q13-契约评审.md`）。合入后按工程卓越总则删分支。
- **round3 补记（2026-10-24 01:49，评审提前回传）**：评审报告已 harvest（`hidden_files/results/K0-Q13-契约评审.md`，11KB，文件头/自检齐全，评审模型 gemini-3.8-flash 经沙盒 relay，盲评）→ verdict **CHANGES_REQUESTED**。发现：M1 Capture 领域落点事件链断裂（缺 PlanChange 提议→应用序列）、M2 本地 outbox 被包装为"投影"（术语与 D9 定义冲突）、M3 Home 未获批写动作 create_project、M4 P-A5 rejected 路径与 Spec §3.1 矩阵不一致、M5 人工置位 blocked/on_hold 无对应动作；m1–m3 MINOR。引用准确性程序化核验：14 个 Spec §x 引用 + 27 个 REQ-/INV- 编号全部真实存在、零编造。11 条 Open Questions 中 **4 条真需用户拍板**（OQ-01 Capture 落点、OQ-02 待验收是否进 My Actions、OQ-04 approved_modified 提案 UI、OQ-05 项目创建入口），7 条打回（可由 Spec 直接推出）。下一步：修稿派回 qoder-web（同分支），OQ-01/02/04/05 需用户先裁决（修稿依赖其中部分答案）；M4 涉及 spec 内 REQ-ACC-3 与矩阵的张力，同步记一笔澄清。Q13 保持 dispatched（修稿中），done 条件不变（合入 + 评审 APPROVED）。
- **round4 注记（2026-10-24 02:30）**：修稿 round2 已回传（`hidden_files/results/2026-10-24_qs_01m5mtt8dw307099drj6ggvaz1_harvest.txt`）：D10 四条裁决（用户授权协调者定）+ M1–M5 全修订已追加为本地提交——§3.2/§3.3 C5/C6/§3.4 事件链按"OQ-01=A"重写（FeedbackReceived(task_id=null)→Interpreter 提议→PlanChangeProposed→校验→PlanChangeApplied→TaskCaptured）、outbox 全文改称"本地 outbox（P 层传输缓冲）"、create_project 移出 Home 状态机（指向种子/CLI）、P-A5 采用 §3.1 矩阵口径（rejected 需再执行直接转 active）、人工 blocked/on_hold 动作补齐（走 TaskWaitStateChanged）；被打回的 7 条 OQ 按 spec 结论写死进正文；DECISIONS.md 追加 D10 条目。自查通过（Mermaid 4 张、30 表格块无列异常、引用无缺失、patch git apply --check 通过）。推送仍因云端无凭据未成，完整 patch `D10-interaction-contract.patch`（142+/92-）已交付待回收。遗留：REQ-ACC-3 正文与 §3.1 矩阵的口径差异已登记，待 spec 维护者澄清。下一步（coordinator 侧）：回收 patch 并推送到 `qoder/interaction-contract` → 本循环再派异模型契约评审 round2（verdict APPROVED 后合入）。Q13 保持 dispatched。
- **round5 注记（2026-10-24 03:20，第二份 contract-review harvest）**：报告 `hidden_files/results/2026-10-24-D9A-contract-review.md`（评审模型 Muse Spark fallback——原计划 Gemini 经 xc relay，但 02:00–03:00 relay 持续 502 + 12222 隧道间歇断连；与起草 DeepSeek-Flash 异构 ✓，盲审）。评审对象是 v0.1 原稿（D10 patch 之前）→ verdict **CHANGES_REQUESTED**：P0=0、P1=4（F-001 D10 已决四条 OQ 未同步标记——D10 patch 已覆盖，round2 逐项对账；F-002 `text-disabled #B3BBC6` 对比度 1.94:1 与 §8.E 矛盾；F-003 OQ-07 未决、契约不能转正；F-004 §0.5 等 Spec 未规定项未按 §9 标注[交互层定义]）、P2=8。**pending decision（契约转正前置）**：OQ-03（验收表单 vs 效率，建议默认 A 逐判据表单）与 OQ-07（outbox 与 D9 字面冲突，建议 A + 三项加固：client_submit_id 可审计、available_actions 不得消费 outbox、K1 日落条款）仍需用户拍板；修稿本身不依赖这两条答案，Q13 仍 dispatched。round2 评审任务书按"逐项对账"模式写（评审员结论：F-001~F-004 修复 + OQ-03/OQ-07 裁决落地可转 APPROVED，无需第二轮全文复审），附两份评审报告。
- **round6 注记（2026-10-24 04:20）**：用户 03:44 授权 D11（OQ-03=A 逐判据表单、OQ-07=A+三项加固、OQ-08=A、OQ-09=A、OQ-10=A、OQ-11=C，交互契约 11 条 OQ 全关闭）——pending decision 门解除，修稿任务书需显式含 D11 裁决。但**一手核验漂移**：`docs/DECISIONS.md` @ HEAD（63b3e8e）仅含 2026-10-21 裁决节，**无 D10、D11 条目**（D10 条目在 interaction-contract 分支待合入 patch 里；D11 的仓库落点当前不可见）。`docs/STATUS.md` 已承认"按 D10 裁决修订中"。D10/D11 随 Q13 合入路径落库，不另立项。Q13 仍 dispatched。
- **round8 注记（2026-10-24 06:20，coordinator 侧对账报告）**：`hidden_files/results/2026-10-24-contract-v02-reconciliation.md`（coordinator 侧 Muse Spark 子代理，对账非重审）确认分支已推进到 `e396102`（D10 修稿 patch 已推送），对账 verdict「修后合入」——P1 4/4、D11 六条 6/6、M1–M5 5/5 落实；残留 P2 两项一行级（F-011、F-012）。DECISIONS D11 1/1 落地（另有 1 处清单外追加，见报告 §4）。done 条件仍未满足（合入 develop + 异模型评审 APPROVED），Q13 继续 dispatched。
- **round9 注记（2026-10-24 07:20，本循环一手核验）**：GitHub 远端 `qoder/interaction-contract` 分支已消失（两次 ls-remote 确认）；`develop/eventstore-batch1` tip 推进 `63b3e8e → 362972d`：e396102（v0.2 收官）+ daa21e6（F-011/F-012 补修）+ 合入 2bedd03「merge: contract v0.2」+ 362972d（docs-check 维护）。一手核验：`docs/interaction-contract.md`（1020 行，标题 v0.2 定稿、"已转正"、11 条 OQ 全关闭）与 D11 条目已在 tip；D10 仅落在契约 §11 内、DECISIONS.md 未单独立条（按对账报告口径处理，不另立项）。**done 条件后半（异模型评审 APPROVED）仍未满足**：前两份评审均 CHANGES_REQUESTED，对账报告是「对账非重审」、不是 verdict——本轮已派 reviewer-subagent 做 round2 契约评审（逐项对账模式，Gemini 3.8 Flash 经沙盒中继盲评；评审对象 tip 文件已逐字取到 `hidden_files/review/contract-v0.2-merged.md`；预期回写 `results/K0-Q13-契约评审-round2.md`）。Q13 继续 dispatched。

### K0-Q14 D9 旅程即测试 v0（内核级旅程 + Playwright 骨架）— done（2026-10-25 收口：修稿早已由 PR #2 合入、M1–M3+m1–m5 内容级核验全在场、合并后真机重跑归档，完成判定满足，见收口注记）
- 为什么：D9 要求完整旅程成为可执行测试；Web UI 未建，先落内核/API 级旅程 + E2E 骨架占位。
- 派发：qoder-web（云端 Qwen3.8-Flash）会话 `qs_01m5mttk0563t4s6arz2z3hpjq`，分支 `qoder/journey-tests`，交付 tests/journey/ + tests/e2e/ 骨架（只新增、不改 src/ 与现有 tests/）。
- 完成判定：分支合入 + 旅程测试在真机基建下真跑结果归档（沙箱无 PG 的未跑项须如实标注）；与 K0-Q11（G1 全旅程实现）关系：本条是测试资产先行，实现仍归 Q11。
- 执行器：qoder-web。
- **round3 注记（2026-10-24 01:30）**：GitHub API 查 `qoder/journey-tests` 分支 404 → 尚未 push，会话仍在跑，继续 dispatched。
- **round4 注记（2026-10-24 02:30）**：分支 `qoder/journey-tests` 已推送，GitHub API 核验 @ `e4fa2f4`（author 崔翔；commit 信息"test(d9): 把 D8 完整旅程做成可执行测试（内核/API 级 v0）"）。内容：tests/journey/（d8-full-journey 18 步 538 行、d8-guardrails 526 行、d9-projection-consistency 298 行、support 3 文件 2600 行）+ tests/e2e/（journeys.spec.ts 骨架 188 行 + README 旅程↔spec 映射 + playwright.config.ts）；tsconfig.json（+1）、vitest.config.ts（+4）小改（纳入 tests/journey）。会话日志 `qs_01m5mttk05_d9b_journey-test_20261024.txt` 在"Write File"处截断、无最终数字——最终结论以分支内容为准。**本轮已派独立评审**（reviewer-subagent，Gemini 3.8 Flash vs 起草 DeepSeek/Qwen 异模型盲评；预期回写 `hidden_files/results/K0-Q14-旅程测试评审.md`）。
- **评审回传（2026-10-24 02:44，harvest 通过）**：报告 `hidden_files/results/K0-Q14-旅程测试评审.md`（13KB，头/自检齐全，末行 REVIEW_COMPLETE）→ verdict **CHANGES_REQUESTED**。交付完整性 ✅（三项交付物齐全，零 src/ 改动，e2e 如实标注未绿项）；spec 引用核验 ✅（REQ-/INV-/§ 逐条核对无编造，EVENT_TYPES 53 项与 spec §4 程序化比对零差异）；**3 MAJOR 均可小修**：M1（②c 的 Decision approved 走了 spec 不存在的第三条路——`resolution='approved'` 却新建 Change、无 `supersedes_change_id`、原 Change 永悬 `needs_decision`；不符合 REQ-PC-5 的 approved/approved_modified 两条法定路径，且偏离被 baked 进断言——D9 质量门要防的"错误的神谕"）、M2（journey-rules.ts:479 actor 分离校验取 Task 全部 Run 执行者集合，spec REQ-ACC-2 只禁"执行该 Run 的 actor"，多 Run 下误拒）、M3（同文件 :486 非 auto 判据只允许 human 结论，spec 允许"人类或独立评审 actor"，把独立评审 agent 也拒了）；5 MINOR（②a 标题 dag_cycle 名实不符、e2e"88 例"误标、D8_INTERPRETERS 多含、computeReady 缺项、NON_STATE_EVENT_TYPES 注释欠准）。评审员注：修完 M1–M3 可转 APPROVED，只复核改动点、无需重审全分支。
- 下一步：修稿派回 qoder-web（coordinator 侧，session 复用模式；评审报告即任务书）。**合入排序有张力，记两边**：round4 曾记"fix wave 先合、旅程测试对合并后重验"；评审员建议**反过来——journey-tests 先于 F1–F17 fix wave 合入**（D9-J2/J3/J4 是按当前基线 pin 的 tripwire，fix wave 先合它们会变红；若 fix 引入 trigger_event_id 强制非空，journey-script 三处 transitionTask 需同步更新）。最终排序由 coordinator 裁决。
- Q14 保持 dispatched，done 条件不变（合入 + 真机真跑归档）。
- **round10 注记（2026-10-24 08:20，本循环一手核验）**：远端 `qoder/journey-tests` 仍 @ `e4fa2f4`，无新提交；修稿（M1–M3）仍未回传，继续 dispatched。
- **round11 注记（2026-10-24 09:22，本循环一手核验）**：远端 `qoder/journey-tests` 仍 @ `e4fa2f4`，无新提交；修稿（M1–M3）仍未回传，继续 dispatched。
- **round12 注记（2026-10-24 10:25，本循环一手核验）**：远端 `qoder/journey-tests` 仍 @ `e4fa2f4`，无新提交；修稿（M1–M3）仍未回传，继续 dispatched。
- **round13 注记（2026-10-24 11:25，本循环一手核验）**：远端 `qoder/journey-tests` 仍 @ `e4fa2f4`，无新提交；修稿（M1–M3）仍未回传，继续 dispatched。
- **round14 注记（2026-10-24 12:22，本循环一手核验）**：远端 `qoder/journey-tests` 仍 @ `e4fa2f4`，无新提交；修稿（M1–M3）仍未回传，继续 dispatched。
- **round15 注记（2026-10-24 13:20，本循环一手核验）**：远端 `qoder/journey-tests` 仍 @ `e4fa2f4`，无新提交；修稿（M1–M3）仍未回传，继续 dispatched。
- **round16 注记（2026-10-24 23:20，本循环一手核验）**：远端分支表已只剩 2 条（develop/eventstore-batch1 @ `80a09c1`、master），`qoder/journey-tests` 分支消失；远端 tip 临时 clone 含 `tests/journey/`（d8-full-journey / d8-guardrails / d9-projection-consistency / support）——旅程测试内容已进主线、分支按工程卓越总则删除。M1 修复在场（②c 已走 `approved_modified` 法定路径，`supersedes_change_id` 指向旧 Change、旧 Change 置 rejected）。未证实：M2/M3 是否同在合入版、合入版在真机基建下的真跑归档——完成判定后半仍缺，**不标 done**，继续 dispatched，待 Batch 2 串行空位后验。
- **round21 注记（2026-10-25 04:2x，本循环一手核验）**：本地接管修稿报告 `hidden_files/web-run/Q14-LOCAL-FIX-1024.md`：M1–M3 + 5 MINOR 全落实（分支 `qoder/journey-tests-fix` @ `912ac04`，未 push；tests/journey 88→89 passed、全仓 302/5 todo、typecheck 0；仅动 tests/journey 与 e2e 注释，src 零改动）。M2/M3 在修稿版已证实；剩余：推分支 + 对合并后代码（Q15 已合入，前置满足）重跑本套 + 合入——安排归 coordinator 侧排序（报告未尽项 1–3：trigger_event_id 同步点、三条 tripwire、M2 放行方向无旅程内正例）。Q14 继续 dispatched，不提前标 done。
- **round22 注记（2026-10-25 05:2x，本循环一手核查）**：`/work/xuxing-q14` HEAD 已由 `912ac04` 推进至 `9c77dd7`（fix(journey): D8.project 收口为 asProjectId 品牌类型，F13 合并后 typecheck 对齐）——coordinator 侧排序进行中。推分支/重跑/合入仍待 coordinator 安排，本循环不重复派发。Q14 继续 dispatched。
- **round23 注记（2026-10-25 06:2x，本循环一手核查）**：`/work/xuxing-q14` HEAD 仍 `9c77dd7`（与 round22 一致，无推进；仅多 untracked `node_modules` 噪音）。推分支/重跑/合入仍待 coordinator 侧排序，本循环不重复派发。Q14 继续 dispatched。
- **round24 注记（2026-10-25 07:2x，本循环一手核查）**：`/work/xuxing-q14` HEAD 仍 `9c77dd7`（与 round22/23 一致，无推进）。推分支/重跑/合入仍待 coordinator 侧排序，本循环不重复派发。Q14 继续 dispatched。
- **round26 注记（2026-10-25 09:2x，本循环一手核查）**：经 xc 直查 `/work/xuxing-q14` HEAD 仍 `9c77dd7`（与 round22–25 一致，无推进；仅 untracked `node_modules` 噪音）。推分支/重跑/合入仍待 coordinator 侧排序，本循环不重复派发。Q14 继续 dispatched。
- **round25 注记（2026-10-25 08:2x，本循环一手核查，方法纠正）**：经 xc 直查 `/work/xuxing-q14` HEAD 仍 `9c77dd7`（与 round22–24 一致，无推进；仅多 untracked `node_modules` 噪音）。注：本轮初查误用沙盒本地路径 `/work/xuxing-q14`（不存在）——该 worktree 在 xc 上，核查须走 xc 直查，已纠正，结论不变。推分支/重跑/合入仍待 coordinator 侧排序，本循环不重复派发。Q14 继续 dispatched。
- **round5 注记（2026-10-24 03:20，第二份独立评审 harvest）**：报告 `hidden_files/results/20261024_review-journey_qs_01m5n0bxjadx2xkqp2xj1b9zwk.txt`（Qoder 盲评，任务指令禁用推送）→ verdict **APPROVED**（0 BLOCKER/0 MAJOR/3 MINOR：常量放文件底部、engines node>=24 声明与实测环境不一致、PlanChange/Acceptance 校验为测试侧编码但已诚实声明）。**实跑数字**（PG14.24 + Node v22.23.2）：journey 88 passed；全仓 300 passed / 1 failed——基线 fd0e347 对照跑同一失败用例，确认为既有 PG16 版本闸门 `assertPostgres16()`，非本次引入；e2e 骨架 skip 干净。与 Gemini 评审（CHANGES_REQUESTED，M1–M3）的结论分歧是**检查维度不同**（诚实性/实跑 vs oracle-vs-spec 语义一致性），不矛盾：M1（②c approved 第三条路）、M2（actor 全集合误拒）、M3（非 auto 判据只认 human）是实质的 oracle-spec 偏差，修稿仍按原计划（coordinator 侧 session 复用，**任务书附两份评审报告**），3 MINOR 随修稿顺手处理。
- **收口注记（2026-10-25，主协调验收标 done）**：收口轮一手核验推翻本条 round16–26 的长期状态漂移——修稿分支并非「从未推送」：PR #2（head `qoder/journey-tests-fix` @ `9c77dd7`）已于 2026-10-24 merged（merge commit `3f2b92e` 在 develop 历史内），远端无分支系合入后按卫生纪律删除；`merge-base --is-ancestor 9c77dd7 34f5096` 主协调复核为真。M1–M3 + m1–m5 在 develop tip `34f5096` 内容级核验全在场（M2/M3 所在 rules 文件与修稿版逐字节一致），需搬增量 0 条，主线在 journey 范围反而领先（PR #2 后 S3/Q12/K1 演进）。合并后真机重跑已归档（xc 真 PG16 @34f5096：journey 89/89、typecheck 0、根全量 634 passed / 5 todo / 0 failed，日志 `web-run/q14-closeout/` 三份；第 2 跑 1 条失败因截断日志例名不可考、定性负载 flaky，有总验收同 tip 独立复跑互证——留痕缺陷已登记）。Q15 复审保留项（未独立重跑）由本次重跑顺带补证。修稿内容已随 develop 经 PR #9 进 master。正本 `hidden_files/web-run/Q14-CLOSEOUT-1025.md`。保留观察项：M2 放行方向仍无旅程内正例（单 Run Task 不可构造），未来旅程扩多 Run Task 时补，不阻塞 done。教训：分支不存在 ≠ 未推送，状态核查须含 PR/merge 记录（与 Q18 harvest 教训同族）。

### K0-Q19 阶段二：收尾杂项 + A 案服务端静态自托管 — done（2026-10-25 round21：四轨合入 + 攒批部署 + 公网 e2e 全轮通过，见 MERGE-DEPLOY-1024.md §6–§8）
- 为什么：用户 23:00–23:12 拍板三阶段全执行；阶段二 = 收尾杂项组（对账文件 pF7/pF8 余项）+ A 案（服务端托管 dist + SPA 回退，部署形态回归单容器自包含）。
- **round20 注记（2026-10-25 03:2x，本循环一手核验）**：阶段二评审 `hidden_files/web-run/PHASE2-REVIEW-1024.md` → **APPROVED（可合并）**；合入 `d3092a8`（MERGE-DEPLOY §3，门禁根 587 / server 97 / spec50 + spec60 全绿，A 案静态托管在合并树上成立）。剩余：部署切换 + 公网 e2e 全轮复验（MERGE-DEPLOY 文档止于 §3，尚未落档），故 Q19 标 dispatched 不标 done。
- **round21 注记（2026-10-25 04:2x，本循环一手核验）**：MERGE-DEPLOY-1024.md 已补至 §8：四轨合入 develop `34f5096`、CI 三 job 全绿；攒批部署 §6（镜像 xuxing-web:20261025-0333、K1 双令牌、A 案 Caddy 整站反代、回滚锚齐全）；公网 e2e §7 除 resolve_decision 公网直验（生产无 pending Decision、数据条件不具备，合并树本地真服务轮 J1 3/3 已证）外全部通过。完成判定三项（对账余项闭环、静态托管旅程 e2e、部署切换后公网全轮复验）实质满足，Q19 标 done；残留 resolve_decision 公网直验另立 K0-Q21（proposed，触发条件=生产首个 pending Decision 出现）。
- 内容：对账余项闭环；服务端补静态托管与 SPA 回退；Caddy 侧改纯反代属部署步，与 T2 重部署协调顺序（T2 先行、T3 合入后第二次重部署切换）。
- 完成判定：对账余项闭环；静态托管旅程 e2e 全过（直达子路径、刷新不 404、资源 200）；部署切换后公网 e2e 全轮复验。
- 执行器：opencode-xc（串行，排 T1 之后）+ Web 轨。
- 依赖：T1 Batch 2；合并顺序 T2→T1→T4→T3→T5。

## blocked / done / dropped

### K0-Q13 D9 交互契约 v0.2（经独立评审转正）— done（2026-10-24 round9）
- 验收：① 契约已合入 `develop/eventstore-batch1`（tip `362972d`：e396102 收官 + daa21e6 F-011/F-012 补修 + 合入 2bedd03 + 362972d docs-check 维护；分支 `qoder/interaction-contract` 已删，符合工程卓越总则）；`docs/interaction-contract.md`（1020 行）+ DECISIONS.md D11 条目在 tip。② 第二轮异模型契约评审（逐项对账，Gemini 3.8 Flash 经沙盒中继盲评）`hidden_files/results/K0-Q13-契约评审-round2.md` → **VERDICT: APPROVED**（M1–M5 5/5、F-001~F-004 4/4、F-005~F-012 8/8 落实；§11 11 条 OQ 裁决索引齐全、D11 与仓库逐字一致；引用抽查 5/5、无语义回退）。完成判定两项全满足。
- 残留 MINOR 3 个（m1 §1.2 ProjectionRebuilt 未单列系统信令、m3 §9 REQ-FB-1 落点残留、F-011/F-012 误标标签残留 L139/L751/L1000 注记）——文档级，随下轮文档顺手修，不另入队。
- 里程碑含义：D9 质量门第一项（经独立评审的交互契约）转正，Web 实现开工条件满足；`web/frontend` 另一轨道已按契约开工。

### K0-Q2 fix 换人复验（re-verify 2）+ evidence 归档 — done（2026-10-24 round7）
- 验收（2026-10-24 05:20 探针 + run 目录一手核验）：`~/workspace/pipeline/runs/xuxing-k0-eventstore/` STATUS.md 确认
  product-review 2 复审 Verdict **SHIP**（2026-10-24 ~02:59 watcher 确认，交卷已恢复、末行 NX_PHASE_COMPLETE）；
  `evidence.reports_synced`：沙盒 run 目录与真机 `/home/appen/xuxing-runs/xuxing-k0-eventstore/` 双边齐全
  （plan/implement/review/re-verify/product-review/fix/re-verify2/product-review2 + 各阶段 prompt）。
  完成判定两项全满足：re-verify 2 报告 ✓（02:20 APPROVED）+ evidence 归档完成 ✓。
- **Batch 1 闭环**：B1/B2/F-a/F-b 全部"修好了"；两条非阻塞残留（append 无 from/to 设防、withTransaction 不检查 COMMIT tag）与
  product-review2 的 F1–F8（F1/F3/F4 优先）已并入 Batch 2（K0-Q4 plan）。
- 遗留（非本条）：分支 `develop/eventstore-batch1` 待合入 master——按 pipeline 合并流程"用户点合并"执行，coordinator 侧跟踪。
- 历史：re-verify-2 于 02:20 APPROVED（换人新 session；typecheck 0 error；npm test 213 passed / 5 todo / 0 failed；
  真 PG16 独立探针 B1 6 个/B2 12 个/F-a 3000 组不变量 0 违例/F-b 5 场景/并发全过）；launcher"0 消息 INTERRUPTED"误报
  （消息抓取通道故障，与 UnicodeDecodeError 不同根因）未根治——pipeline infra 事，coordinator 侧跟踪。

### K0-Q1 收尾 Batch 1 fix 的流程状态（状态漂移修复）— done（2026-10-24 round4）
- 验收：coordinator 于 2026-10-24 01:36 经 session 直查恢复 fix 交卷（develop-fix.md，末行 NX_PHASE_COMPLETE 完整），CHAIN.json/STATUS.md 已更新为 fix done；fix watcher 自删；换人复验 re-verify-2 于 02:20 APPROVED（B1/B2/F-a/F-b 全"修好了"）。完成判定 4 项全满足。证据链：`~/workspace/pipeline/runs/xuxing-k0-eventstore/`（develop-fix.md、develop-reverify2.md、STATUS.md）。
- 备注：本条"收尾"指的是 pipeline 自身 fix 轮（B1/B2/F-a/F-b）的流程状态；独立评审发现的 F1–F17 第二轮修复在 K0-Q15 另行跟踪，Q1 的 done 不得被误读为"fix 已终结"。
- 历史：round1 探针发现状态漂移（fix 实际已交卷但 CHAIN/STATUS/watcher 停在 RUNNING 近 46 小时）；round2/round3 因 opencode-xc 串行占用顺延；最终由 coordinator 经 session 直查恢复交卷闭环。

### K0-Q15 Batch 1 fix 第二轮（独立评审 F1–F17 修复）— done（2026-10-25 round21 补记：异模型复审 APPROVED，见 round21 补记）
- 为什么：两份独立只读评审（Qoder 云端异模型，会话 `qs_01m5mtm8tb` 与 `qs_01m5mtm8tb420rk1mn6sag1h91`，结论一致）对 `develop/eventstore-batch1` tip `fd0e347` 的 verdict 均为 **CHANGES_REQUESTED**。Batch 1 闭环前必须修完，否则 Q2 的换人复验无从谈起。
- 证据：`hidden_files/results/2026-10-24_qs_01m5mtm8tb_harvest.txt`、`hidden_files/results/2026-10-24_qs_01m5mtm8tb420rk1mn6sag1h91_harvest.txt`（F1–F17 全清单，含文件行号与 spec 依据）。
- 进展（2026-10-24，用户下放"bug 修复方案与执行由协调者定"后开工）：
  - 第一轮（F1–F9）：qoder-web 云端 DeepSeek-Flash，分支 `qoder/fix-batch1-review`（基线 fd0e347，先并入 qoder/ci-bootstrap），提交 d77c81b；自装 PG16 全量真跑 **251 passed / 0 failed / 5 todo**；推送因云端无凭据未成（已交付 patch 产物 `batch1-review-fixes.patch` / `batch1-review-fixes-src-tests.patch`）。
  - 第二轮（F10–F17，session 复用 rounds=2）：提交 1b9456f；F10–F17 全修（F13 取"编译期 brand + 运行期主体 id 拒绝 + project_id 一致性"封 INV-12，F15 取"严格比较 type+payload+actor+关联链"——均为云端 agent 的取舍，已记录）；tsc 0 error；真 PG16 **299 passed / 0 failed / 5 todo（304）**；完整 patch `batch1-review-fixes-full.patch`（fd0e347..1b9456f，9 文件，4834 行，200KB，sha256 ee8be517…a4040b36）已交付；推送仍因无凭据未成。
- 卡点：patch 尚未回收到我方（coordinator 经 SSH 通道回收中）；回收推送后派 Gemini 异模型复审（reviewer-subagent）→ verdict APPROVED 才可合入 develop/eventstore-batch1。注意 spec/ 与 docs/DECISIONS.md 零改动（fix 波次纪律）。
- **round10 注记（2026-10-24 08:20，本循环一手核验）**：远端仍无 `qoder/fix-batch1-review` 分支，patch 回收仍卡在 coordinator 侧，继续 dispatched。
- **round11 注记（2026-10-24 09:22，本循环一手核验）**：远端仍无 `qoder/fix-batch1-review` 分支，patch 回收仍卡在 coordinator 侧，继续 dispatched。
- **round12 注记（2026-10-24 10:25，本循环一手核验）**：远端仍无 `qoder/fix-batch1-review` 分支，patch 回收仍卡在 coordinator 侧，继续 dispatched。
- **round13 注记（2026-10-24 11:25，本循环一手核验）**：远端仍无 `qoder/fix-batch1-review` 分支，patch 回收仍卡在 coordinator 侧，继续 dispatched。
- **round14 注记（2026-10-24 12:22，本循环一手核验）**：远端仍无 `qoder/fix-batch1-review` 分支，patch 回收仍卡在 coordinator 侧，继续 dispatched。
- **round15 注记（2026-10-24 13:20，本循环一手核验）**：远端仍无 `qoder/fix-batch1-review` 分支，patch 回收仍卡在 coordinator 侧，继续 dispatched。
- **round16 注记（2026-10-24 23:20，本循环一手核验）**：远端仍无 `qoder/fix-batch1-review` 分支，但出现 discrepancy——Batch 2 任务书多处把 Q15 波次当作已落地基线引用（`86f1d01` 引入 `guardTransitionReplay`、`9df4d20` 叠其上）。两种可能：① Q15 内容已随 Web 轨 PR #4–#7 合入、仅缺复审 verdict ④；② 任务书引用的是局部已合入子集。完成判定④（异模型复审 APPROVED）无文件证据，继续 dispatched，提请协调者确认 ④ 是否已满足或仍欠；本循环不擅自消解该 discrepancy。
- **round21 注记（2026-10-25 04:2x，本循环一手核验，discrepancy 消解）**：Q15 内容并未随 Web 轨合入，而是经回收路径正名合入——`qoder/fix-batch1-review` @ `86f1d01` 已合入 develop（PR #1，合并提交 `aad471e`，GitHub API 核验 state=closed/merged），远端 `qoder/*` 分支已清零（卫生纪律删分支），86f1d01 为 tip `34f5096` 祖先。①②③ 随合入与门禁全绿落地；④ 本轮已派 reviewer-subagent 异模型复审（评审模型 Gemini 3.8 Flash 经沙盒中继，中继 04:2x 实测进程在跑、8888 监听、GET / 回 404 即活；评审对象=12a2a45..86f1d01 diff + PR #1 合并态；预期回写 `hidden_files/results/K0-Q15-复审.md`，预估 1–3h）。复审 APPROVED 后 Q15 才标 done，在此之前继续 dispatched。另：Q14 的"等 Q15 落地"前置条件随本次合入满足，但 Q14 推分支/合入安排仍归 coordinator 侧排序，本循环不擅自派发。
- **round21 补记（2026-10-25 04:2x 后，评审子代理回传，本循环一手核验）**：复审报告 `hidden_files/results/K0-Q15-复审.md`（9075 B，文件头齐全）→ **VERDICT: APPROVED** + `REVIEW_COMPLETE`。评审模型 gemini-3.8-flash 经沙盒中继（MODEL_OK 探针验证），盲评三组（transition-guard / event-store / tests+ci）均为 PART_VERDICT: APPROVED，无新发现；harness 一手核对：diff 9 文件无 spec/docs 改动、PR #1 合入 aad471e、86f1d01 为 tip 34f5096 祖先、合入后同批文件改动（ef56430/ab80655/f5652f9）均为对齐/扩展、无撤销。完成判定四项全满足（①②③ 落地验证见 Q15-RECOVERY-1024.md：真 PG16 299/5/0、typecheck 0；④ 本复审 APPROVED），Q15 标 done。保留说明（不阻塞）：本复审未独立重跑测试，299/5/0 系引用落地报告；如需"测试通过"独立证据，另在 PG16 重跑一次（Q14 合并重跑时可顺带覆盖）。
- 完成判定：① F1/F2 修复；② F3–F9 修复或有明确延期裁决；③ tsc + 相关测试绿（含新增负向测试）；④ 复审 verdict APPROVED（与原评审员异模型或原评审复核）。
- 执行器：qoder-web（云端 DeepSeek-Flash）→ reviewer-subagent（Gemini 异模型复审）。
- 与 Q1 协调：Q1 已标 fix done，但指的是 pipeline 自身 fix 轮（B1/B2/F-a/F-b）；本条是独立的第二轮，Q1 的 done 不得被误读为"fix 已终结"。
- 历史：round3 按 body 硬停线曾标 blocked（待用户确认 fix 范围）；用户下放授权后开工，转 dispatched。

### K0-Q3 异构模型复审背书 — done（2026-10-24 00:40，验收通过）
- 验收：复审报告 `~/workspace/xuxing/spec/K0-SPEC-REVIEW-HETEROGENEOUS-gemini-3.8-flash.md`（7537 bytes），verdict **APPROVED**，P0 清单（无）、P1×2、P2×3；评审模型 gemini-3.8-flash 经沙盒 relay，与作者/前三轮 contract-review 模型异构，满足"评审员与作者不同模型"要求。
- 结果回写：`hidden_files/results/K0-Q3-异构复审.md`（文件头 + 逐条自检齐全）。无 P0 冲突，无需入队新任务、无需报用户。

### K0-Q5 退出门差距盘点 — done（2026-10-24 round2）
- 差距表：`hidden_files/exit-gate-gap-2026-10-24.md`；缺口转入 K0-Q8–Q12（proposed）。G3/G4 暂缓单独入队：依赖智能层与 Web 入口，待 K0-Q4 定命令层边界后再拆（本轮 5 条新增上限已用满）。
（注：原" K0-Q15 Batch 1 独立复审 fix 波次（F1–F9）— 进行中"条目已于 round4 并入上方唯一的 K0-Q15 条目，消除重复。）
- **round5 补记（第二份退出门盘点佐证）**：独立只读盘点 `hidden_files/results/2026-10-24_qs_01m5mtmk99k6b5m26mwfrqmy58_harvest.txt`（4 测试文件+2 夹具全文读完）结论与本条一致——已覆盖 1（C2）、部分 3（C1/C1b/C5）、无覆盖 8；REQ-DT-2 报告评审无覆盖。优先级供 K0-Q4 拆批参考：G1 > C3 > C6 > G5+DT-2 > C4 > C1/C1b > G2 > G3/G4 > C5（C5 是"已有强机制、只欠正确对象"、回归风险最低）。
