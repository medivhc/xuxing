# 06 工作流（怎么干活，接手后沿用）

## 开发环路（每个功能/批次）
1. **spec 先行**：先写 spec 草稿 + 列待拍板问题；冻结前过独立的 contract-review（审 spec 本身：完整性/可判定性/独立性/一致性），CHANGES_REQUESTED 就改 spec、不进开发。
2. **develop**：在 xc `/work/xuxing*` 独立 worktree + 独立分支上实现，小步 commit；plan 与 implement 分开跑，任务书自包含（执行者看不到协调者上下文）。
3. **独立评审**：实现完成后必须过独立 review（评审员与实现者不同模型/不同会话）→ 发现问题必须 fix → re-verify → product-review（从用户旅程评价，不只看代码）。这是所有者的铁律，无例外。
4. **门禁全绿才合入**：根测试（真 PG16）、server 测试、typecheck（根+server）、web build、journeys、docs-check；CI 三 job 全绿。沙盒环境跑不了的门禁去 xc 真机跑，不要在沙盒里宣称全绿。
5. **合并与部署**：合入走 PR 到 master（协调者执行合并）；部署 = VPS 构建新镜像（tag 含日期时间）→ 切换容器 → 公网 e2e（API + 关键旅程 + 计数对账）→ 留回滚锚（旧镜像 tag 不删）。

## 模型路由（现行）
- develop/fix：opencode-go/deepseek-v4.1-flash（经 xc opencode 或 magpie 网关）。
- contract-review/review/arbiter：opencode/beam-free（run 目录 cwd 直连）；候选继任 opencode-go/muse-spark-1.3-contributor。
- **Gemini 已停用**，任何文档里的 gemini 路由都是旧文案。
- 网页执行器（Qoder/TRAE/WorkBuddy）只派云端执行 + 免费/已授权模型，细则 ../../handover-attachments/EXECUTORS.md；其交卷摘要不可信，产物以 GitHub API/仓库一手核实。

## 文档纪律
- 同一事实只有一个正本：决策在 `docs/DECISIONS.md`、状态在 `docs/STATUS.md`、spec 在 `spec/`；其他文档只引用不复制。
- 任务书/提示词/脚本先落文件再执行，聊天里只引用文件与结论。
- 文档流转走 DOC-FLOW 协议（../../handover-attachments/DOC-FLOW.md）：带 based_on/sha256/verdict/counts 头，协调者抽查不全量复述。

## 与所有者的协作口径
- 一般事项协调者自决、只报里程碑；新功能范围与 P0 方案先给用户看方案（多角度权衡）再开工；bug 修复方案与执行协调者定。
- 破坏性清理先列清单过目；推送/部署等外向动作做完即报结果（带证据，不带自报）。
