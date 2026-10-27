# 02 在途与未决（接手后先处理这里）

## 等用户动作的（不要代办，只能提醒）
1. **待我处理里有 4 条 awaiting_acceptance**：Agent 执行器 e2e 产生的任务产物（Q23/F4 相关），产物分支只在 xc 的 agent-hands 克隆内（`xu-agent/<run尾12位>`，未 push）——等用户在生产「待我处理」里验收。接手者不要自行 accept/reject。
2. **resolve_decision 公网直验待补**：K0 验收的 yellow 子项——生产种子数据无 pending Decision，实质已由同合并树 J1 真点裁决证明；等生产出现首个真实 pending Decision 后补一次公网直验即可关闭。

## 验收 follow-up（7 条，正本在原协调者验收报告 K0-ACCEPTANCE-1025）
- 逐条归属已在验收报告内标注；接手者如拿不到原报告，以仓库 `docs/STATUS.md` 的「仍留后续批次」为准推进，两者冲突时先问用户。
- 仍留后续批次（STATUS 正本口径）：生产调度循环、生产投影消费者、C1/C1b 租约对账、G1 全旅程、PlanChange 校验流水线、多用户/权限（K2）。

## 已知待办/欠账
- **生产 E2E 标记任务清理未决**：2026-10-25 生产 e2e 留下数条 E2E-1025 标记任务，是否清理当时未定，接手前先问用户。
- **xc 历史 worktree 残留**：/work 下有 xuxing-batch2、xuxing-deploy(detached)、xuxing-fix4、xuxing-k1、xuxing-k1dev、xuxing-k1spec、xuxing-phase2、xuxing-q12、xuxing-q14、xuxing-q15、xuxing-web-integration 等已合并轨道的 worktree，确认对应分支都已合入后应清理（删 worktree 前逐个查未推送 commit；本机还有一笔 stash@{0}=0573d99 是 2026-10-24 陈旧检出的留证，不要误删前先看内容）。
- **自主探索循环处于停用**：cron `k0-autopilot-loop` 已禁用（用户 2026-10-25 决定）；唤醒条件 = 推进 Q14 或触发 Q21。QUEUE 快照见 ../../handover-attachments/QUEUE.md（2026-10-27 版），恢复前先与用户确认。
- **评审员路由已变更**：Gemini 已于 2026-10-25 永久停用（付费原因）。当前 contract-review/review 走 opencode 的 `opencode/beam-free`（注意启动形态：run 目录 cwd 直连 `opencode run` 才稳），后续候选 `opencode-go/muse-spark-1.3-contributor`。仓库与技能文档里若还有 gemini 路由文字，属待同步的旧文案，不要照着派 Gemini。
- **proposer 能力边界**：生产 proposer 一次只产单任务提议，自动多任务拆分不在现契约内（2026-10-25 实证）——做自动拆分属新课题，不要以为已支持。

## 安全提醒
- 曾有一份 WorkBuddy 产出的 SOTA 副本（不在本仓库）在其 `.env` 里带真实 API key（云知声 MaaS dev 配置）。任何副本/打包/推送前先查 `.env`，严禁带进仓库或交接包。本交接包已做密钥模式扫描，无命中。
- 生产双令牌与节点令牌只记位置（05-ACCESS），接手者需所有者重新发放，不要从旧机器拷贝令牌文件到新环境后不轮换。
