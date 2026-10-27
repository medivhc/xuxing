# 续行 K0 — 执行器注册表

循环只派发不执行。每条任务在 QUEUE.md 里必须指名一个执行器。
结果统一回写 `~/workspace/goals/k0/hidden_files/results/<任务id>-<简述>.md`，规划者下一轮 harvest。

| 执行器 | 干什么 | 调用方式 | 异步结果 | 已知限制 |
|---|---|---|---|---|
| opencode-xc | 写代码、改代码、跑测试（K0 全部实现类工作） | 在 xc-pc-linux `/work/xuxing` 按 nx-pipeline 派发（TASK.md + phase 模板，develop/fix 用 deepseek-v4.1-flash），沙盒只编排 | run 目录产物 + commit；完成标记 `NX_PHASE_COMPLETE` | **多实例不能并行**（DB 锁），必须串行，一个完全结束再起下一个；长任务用 setsid/nohup 脱离 SSH 会话；判活用 session 直查 + git log，不信 wrapper 的 RUNNING。**细化（2026-10-24 opencode-api-research 实证）**：opencode v2 API 的 service 内多 session（多目录/多模型）并行已无问题——"不能并行"的是编排层 nx-chain 单 run 串行 + 共享测试 DB，多轨道并行需 coordinator 并行拉起多个 nx-api-run；隔离边界仍是 directory（一轨道一 worktree） |
| reviewer-subagent | 独立评审、复验、契约评审 | 子代理，干净上下文、单向信息流、盲评；评审员与作者不同模型（Gemini 3.8 Flash 优先） | 评审报告落 run 目录或 spec/ | 同一对象评审轮次上限按既有铁律（TDD 测试评审 ≤2 轮，contract-review ≤3 轮转 arbiter） |
| probe-k0-state | 摸状态（只读） | `bash ~/workspace/goals/k0/hidden_files/tools/probe-k0-state.sh` | stdout 快照 | 只读，不算执行器产出、算规划者的探针；每轮必跑 |
| ask-chatgpt | 向 ChatGPT 网页版（Plus）提问，拿外部第二意见 | **待建**（见 QUEUE K0-Q7）：载体已定（2026-10-23 用户拍板）——用户电脑上单独开一个 Chrome、专用 profile 目录持久保存登录态，用户只登录一次；CDP 端口只绑本机、经 mesh 转发进沙盒，程序按需 attach 操作，平时可关。首次探索路径后抽象为程序登记于此 | 程序把问答全文写入 results/ | 独立 profile、不碰日常浏览器（CDP 铁律）；网页版有风控风险，频率保持常人量级；同机先例：SH-YF 上 mimo_ask.py 已跑通「发问→等待→取答」全环（Tabbit/Chromium）。**持久登录两条件（用户 2026-10-23 强调）**：① 登录态靠 profile 里的 cookie 持久化，后续调用免密免验证码；② **位置必须恒定**——永远同一台机器、同一 profile、同一出口 IP 操作，站点按「同设备+同地点」认可信设备才不弹验证；不许把 profile 拷到别处、不许换机器/换网络跑同一账号。仍可能被打破的情况：cookie 自然过期（周/月级）、站点全站安全事件、用户改密码——届时才需用户重新登录一次 |
| qoder-web | 在线 agent（Qoder CN），适合派探索/审查/开发类活；两种形态：本机任务（在 SH-YF-CX-PC 上执行）与**云端任务（选 Cloud，用户 2026-10-24 指定为默认形态）** | **已打通登录（2026-10-24）**：SH-YF 专用 Chrome（profile `C:\chrome-auto\profile`，CDP 9231，计划任务拉起）+ 阿里云 SSO 短信登录（用户已完成一次，登录态持久化已验证）；操作手册 `~/workspace/qoder-auto/NOTES.md`，`qoder_ask` 程序待固化。云端任务：新建页执行器选 Cloud；模型在右下 "Auto"→Choose Model 选，**DeepSeek-Flash 0x 免费**（首选）。**本机任务禁用（2026-10-24 用户否决：授权请求会推到用户手机 App）**；云端任务全程零批准已实测通过。云端沙箱实测（报告 `results/2026-10-24-qoder-cloud-probe.txt`）：Ubuntu 22.04、4vCPU/8G/15G、git/node22/py3.12/go1.22/rust1.98/gcc13/java21 + chromium/playwright，无 Docker，单命令前台上限 ~300s，产物经 DeliverArtifacts 下载，沙箱跨任务持久化无法确认，无任何 GitHub 凭据（公开仓库匿名只读、私有需预置 token、不能 push）；模型无法自证（对外身份 Qoder default），以 UI 所选为准。**新增约束（2026-10-24 canary `qs_01m5mtjp95w5k2dvqw1y2wq73p` 实测）**：沙箱到 github.com:443 出站被阻，`git clone` 会超时失败——读仓库改走 codeload tarball 或 GitHub REST API（api.github.com 可达）；push 仍经任务指令内授权 PAT 配置 remote（token 不落文件/记忆） | 结果回 results/（待 qoder_ask 建成后规范）；共开发回路已通（2026-10-24）：代码交换面 = GitHub 公开仓库 `medivhc/xuxing`（xc 已推 master+develop/eventstore-batch1）；用户授权经典 PAT 直接写进任务指令供它 push（token 不落文件/记忆，仅限其 remote URL 使用）；任务纪律：只许推 `qoder/` 前缀分支，产出经协调者评审后合入；**工程卓越总则：`qoder/*` 分支合入后立即删除**。完成通知：hook `qoder-session-watch` 每 120s 经 qoder_watch.py 监视会话 tab，done 才唤醒 harvest，不再人工轮询。已派任务：探查云端 `qs_01m5ms3t57k7z736pmp49s25sd`（完成验收）、本机 `qs_01m5mrj6dmpsc7rd4g0r8k7008`（完成，本机形态停用）、共开发 codev-001 `qs_01m5msx3qbjk63bgxtkm0dg7tx`（CI 引导+全量测试，**done**，结果 `results/codev-001-CI-bootstrap与全量测试-2026-10-24-qs01m5msx3q.md`）、review-batch1 `qs_01m5mtm8tb` + `qs_01m5mtm8tb420rk1mn6sag1h91`（Batch 1 独立代码审查，两份均 CHANGES_REQUESTED，已 harvest，见 K0-Q15）、D9-A `qs_01m5mtt8dw307099drj6ggvaz1`（契约草案，分支 `qoder/interaction-contract` @ `f4bbc4f` 已 push）、D9-B `qs_01m5mttk0563t4s6arz2z3hpjq`（旅程测试，运行中） | 操作必须走真实鼠标事件 + 截图定位校准；短信表单在跨域 iframe；链路用 SSH 隧道 12234（EasyTier 直转假活；VM 替换会冲掉 /root/.ssh/known_hosts 里的 12225 密钥行，从 /home/hatch 副本重贴）；成本纪律：探索一次、固化程序、只回小结果；额度纪律见 `~/workspace/qoder-auto/quota-ledger.md`（限流即停派该模型）；**平台能力自查实证（2026-10-24 `results/2026-10-24_qs_01m5mxrqj6h3wj8s71ek4j1mbc_harvest.txt`，四节盲测）**：① 网页云端会话**不自动读 AGENTS.md/.qoder/rules/.cursorrules**（子执行器盲测：三个标记均未出现）——约定必须内联进任务指令，或点名"先读 <路径>/AGENTS.md 并遵守"；② 内置技能仅 deep-research/docx/pdf/pptx/xlsx 五个办公向，自定义技能热加载**无法确认**；③ **上下文自动压缩**（无 /clear；早期工具结果会被清）——长会话/session 复用必须把状态落盘做锚点；④ 无 GitHub MCP/连接器（见派活铁律）；⑤ **Qoder Action（GitHub 官方通道，待试点）**：`QoderAI/qoder-action` 可在 Actions 里对 PR 自动评审、Issue/PR 里 `@qoder` 派活，评审规则由仓库 AGENTS.md 定义——与网页会话互为冗余的第二条官方 GitHub 通道；⑥ 模型口径（2026-10-24 02:31 用户修正）：**Hy3 可用但上下文小**——只能新会话起用、派短小自包含的活，**禁止从其他模型的长会话中途切入**（上下文装不下必出问题）；质量面弱（评审召回低），**不兼评审**；大上下文模型之间可任意互切 |
| user | 拍板（范围、方案、不可逆动作） | 在主聊天/旁聊发决策卡 | 用户回复 | 只有 decision 类任务派给 user；不许把能自己判的事推给用户 |
| workbuddy-cloud | WorkBuddy/CodeBuddy 云端执行器（农场的 GitHub 写入通道；推送方案 A 案：平台侧认证直推 + Qoder patch 回收兜底） | 待固化（探查会话已验证登录与任务派发路径；调用方式见 `~/workspace/qoder-auto/NOTES.md` 同类流程，workbuddy 侧待补） | 结果回 results/（待规范） | **探查实证（2026-10-24 `results/2026-10-24-workbuddy-probe.txt`）**：腾讯云 KVM Ubuntu 24.04（32vCPU/123G），工具链全（git/node22/py3.11/rust1.93/go1.21/**Docker 27.5.1**/java20/cmake）；**内置 GitHub MCP，已用 medivhc 认证，约 30 工具含写操作**（读 xuxing 已实测：默认分支 develop/eventstore-batch1 @ fd0e347、4 分支；写操作审批未实测）；只读操作免批准；工作区 /workspace 沙箱内持久、跨任务复用不保证；模型 Step-5-Preview（夜间免费模型 Hy4 可纳入夜间轮换，见派活铁律）；派活铁律：**选云端执行、选免费模型**（Qoder DeepSeek-Flash / Qwen3.8-Flash 0x；WorkBuddy Hy4 夜间免费），**Hy3（混元）只派短小自包含任务（新会话起用）、不兼评审**，本机执行禁用 |
| trae-work | TRAE Work 云端 Agent 任务平台（work.trae.cn；写回路径 = trae/agent-* 分支 → 文件审查 →「AI 创建 PR」，三家里闭环最完整） | **访问已打通（2026-10-25）**：登录态在 SH-YF-CX-PC **主 Chrome**（区别于 Qoder 专用 profile），经沙盒 `127.0.0.1:12227` → SH-YF:9224 CDP 转发开自己的新标签页操作（脚本 `~/workspace/trae-auto/probe_trae.py`，须用 `~/workspace/qoder-auto/venv/bin/python` 跑）；只动自己的标签页、毕后关闭。账号 Medivhc/Pro，GitHub 已连 medivhc。余额查法：账号菜单 ⚡ + 页面上下文直调 `GET api.trae.cn/trae/api/v2/pay/web_user_ent_usage`（脚本 `trae_api.py`，JWT 不出页面）。会话面 REST：`work.trae.cn/api/remote/v1/`（chat_sessions/messages/git/repositories/models）。操作手册 `~/workspace/trae-auto/NOTES.md`，探查正本 `~/workspace/trae-auto/PROBE-1024.md` | 结果经 GitHub 分支/PR 独立核实（GitHub API 查 head 与 diff） | **金丝雀已完成（2026-10-25，两轮）**：首轮阻塞——**DeepSeek-V4.1-Flash 的 Max 模式被持久化偏好置为 ON**（localStorage `AI.agent.model.max_mode_by_agent_model` 中 deepseek-v4.1-flash/glm-5.3/mimo-v2.6-pro 均 true，应为用户此前设置），且 **work.trae.cn 网页端无任何关闭入口**（模型菜单纯列表、trigger label/徽标点击只开菜单、全 DOM 无 switch 元素），按「Max 不开」停手零燃烧。续跑按裁决走路径 ② 换 **MiMo-V2.6-Flash（0.06x，Max 偏好 map 中无此键、trigger 无 Max 徽标，派发前双证）**：会话 `6addb605a0201d0612d689f3` 耗时 1m59s 到终态（完成信号 = chat_sessions `status` 3→**5**）；产出经 GitHub API 独立核实全过——分支 `trae/agent-AG98sP` @ `a04f5cb`、仅新增 `docs/protocols/AVAILABILITY.md`（+43/-0）、内容与 MATRIX verdict 逐项一致、**PR #26 已建（open、未合并）**。**核心结论：「AI 创建 PR」由 agent 自主完成、无需操作端点按**（派发后我方零 UI 操作；PR created_at 早于会话终态；agent finish 报告含 PR 链接）→ TRAE 可无人值守回收，条件是任务书写明「建 PR、只建不合并」。**燃烧首样本：2.8 积分/单**（派发前 remaining 10085.1 → 后 10082.3，扣费按包 FIFO 从最早到期签到包扣）；到期结构包级实算：11-05 16:29 CST 前到期共 6300（Pro 4000 + 月赠 500@10-31 + 9 个签到包 ×200），扣已消耗后约 **6082 待用**，按真实代码任务 20–50× 本样本估算可排约 43–108 单，积分非瓶颈（代码任务燃烧待首个真实单校准）。模型倍率会浮动，派发时以菜单实价为准（2026-10-25 实测 DeepSeek-V4.1-Flash 0.06x 会员限时优惠）；模型菜单是 Radix Select 虚拟列表，鼠标点击易被弹窗裁切，**用键盘 ArrowDown 移焦 + Enter 选中**（打开菜单时焦点在当前项）。**第二仓复核（2026-10-25 16:30，正本 `trae-auto/CANARY-1025.md`）**：换 DeepSeek-V4.1-Flash（Max 偏好 ON，按 16:10 裁决的默认口径）对 medivhc/xuxing 派 TRAE-CANARY.md 任务，会话 `6addbe1c63efd7eb03eb0661` 约 2m04s 到终态；GitHub 独立核实全过——分支 `trae/agent-dlyH01` @ `ddb7d04`、PR #10（open 未合并、仅新增 TRAE-CANARY.md +39/-0、三节与真实目录及 package.json scripts 逐字核对属实）、PR created_at 早于会话终态（agent 自主建 PR 二次实证）；燃烧 **2.19 积分**（consumed 217.7→219.89）。模型菜单 ArrowDown 不绕回（到底钳制），反向用 `key_nav_up.py`（ArrowUp） |

## 模型与密钥（2026-10-23 用户定）

K0 需要真实模型调用的地方（Proposer/Interpreter 的测试、代码 Agent 适配器联调等）**一律复用 opencode 已配置的 provider 与 key**，不自建密钥管理、不向用户另要 key、不把 key 写进 xuxing 仓库或测试代码。内核本体是确定性的，不直接调模型；这条只管智能层与适配层。

xc-pc-linux opencode 当前配置（2026-10-23 实查，`~/.config/opencode/opencode.json`）：
- `unisound/u2-flash`（默认）— maas-api.unisound.com
- `google/gemini-3.8-flash`、`gemini-3.1-pro-preview` — 经沙盒中继 127.0.0.1:18888，key 在 `~/.config/opencode/.gemini-env`（600）
- `opencode-console/space-bunny-free` — 免费额度，有 rate limit，勿用于批量测试

调用方式优先级：① 直接以 opencode 为执行器跑（`opencode run --model <provider/model>`）；② 程序内读取同一份 opencode 配置/环境拿 baseURL 与 key。测试产生真实计费时保持常人量级，大批量跑量先报用户。

## 派发任务书最小格式

目标一句话 / 输入材料（路径） / 范围与非范围 / 完成判定（逐条可核） / 结果写回路径。
缺完成判定的任务书不许派发。

## 探针补充（2026-10-25 round18）

- 单会话带超时 CDP 探针：`hidden_files/tools/qoder_session_probe.py <session_id> [--timeout 30]`，
  只查一个会话、evaluate 设硬超时，超时本身即结论（tab 层 wedged），不挂死调用方。
- 调用口径（2026-10-25 round19 实测）：上述探针与 `qoder_harvest.py` 必须用
  `~/workspace/qoder-auto/venv/bin/python` 跑——系统 python3 无 websockets 模块
 （ModuleNotFoundError）；脚本首行 `#!/usr/bin/env python3` 在沙盒 exec 环境下
  不保证命中 venv。
- 背景：`qoder_watch.py` 全量检查无 recv 超时，任一 tab evaluate 挂死即挂死整轮
  （round18 实证：canary3 tab websocket 能连、evaluate 30s 无响应，全量检查 300s+ 无输出；
  sessions.json 自 2026-10-24 18:13 起失真）。`qoder_watch.py` 仍缺 recv 超时与单 tab
  故障隔离，待 coordinator 侧排期修；在此之前，分诊一律走单会话探针。

## 派发调度纪律：预估时间 + 到点查询（2026-10-24 用户立规）

起因（同日双实证）：① Web 旅程 fix 第 2 轮 11:11 已交卷，产物在 Qoder 产物区躺了约 2.4 小时无人回收——watcher 状态错误且无人主动查；② Q14 修稿从未真正派发，却被记成 dispatched 误报十几轮。

规则：
1. **派发必带预估时长**：按同类任务实测校准（Qoder 云端小活实测多在 5–40 分钟；opencode 真机活按任务体量估），预估与派发时间、会话/进程标识一并记进状态文件或队列。
2. **到点必查**：达到预估时间仍未收到结果，协调者主动查一手状态——网页平台走其 API（Qoder 同源 REST 的 session_status/events/artifacts；WorkBuddy 同理），本地进程查进程与日志；**watcher/DOM 状态只作参考，不作结论**。
3. **查后分诊**：已完成 → 立即 harvest 落地；仍在跑且有进展 → 更新预估（顺延一个周期）继续等；无进展/挂死 → 本地接管或续派，不继续干等；限流/报错 → 按限流纪律停派并记台账。
4. **dispatched 必须真实**：只有真执行了派发动作（拿到会话 ID、进程号等证据）才许标 dispatched；计划中要派的活标 ready 或"待派"，不许提前记成已派发。
