# 续行（Xuxing）交接包

打包时间：2026-10-27（由原协调者 Muse 整理）
用途：让另一个 Muse（或其他 agent）在**只拿到本仓库**的前提下接续开发续行，不依赖原协调者的私有记忆与工作区。

## 先读顺序
1. 本文件（仓库坐标与状态速览）
2. `01-STATUS.md` — 当前状态与质量门数据
3. `02-INFLIGHT.md` — 在途事项、待用户验收项、未决问题（接手后先看这里决定干什么）
4. `03-DECISIONS.md` — 决策索引（正本在 `docs/DECISIONS.md`，本文件只做导读）
5. `04-PITFALLS.md` — 已付过学费的坑，动手前必读
6. `05-ACCESS.md` — 需要哪些权限、凭据都在哪里（只记位置不记值）
7. `06-WORKFLOW.md` — 开发/评审/合并/部署的工作流与门禁
8. `PROJECT-BRIEF.md` — 产品与项目简报（给没有上下文的读者）
9. `handover-attachments/`（仓库根目录）— 协调者工作区文档的快照（AUTOPILOT/EXECUTORS/QUEUE/ENGINEERING/DOC-FLOW + 自主探索循环 skill），是快照不是正本，正本位置在各文件内注明

## 仓库坐标（2026-10-27 打包时一手核验）
- GitHub：`medivhc/xuxing`（私有仓协作方式：接手方需被加为 collaborator，或用所有者账号连接）
- 主线：`master` = `bb77df4`（含 K0 全部成果，PR #9 合入 + 其后提交；CI 全绿）
- 开发线：`develop/eventstore-batch1` = `0c53b76`（注意：开发分支就叫这个名字，没有单独的 `develop` 分支；它在 master 之后，含 Agent 执行器 Q25）
- 生产：https://tg.bewith.link（VPS Docker 双容器 app+PG；服务端镜像 `xuxing-web:20261025-1726`；执行节点 node-agent 跑在 xc-pc-linux 的 systemd user unit）
- 开发机：xc-pc-linux `/work/xuxing`（主 worktree 在 develop/eventstore-batch1；另有多个历史轨道 worktree 残留，见 02-INFLIGHT 的清理项）
- 仓库内正本：`docs/STATUS.md`（项目状态，带 based_on 锚）、`docs/DECISIONS.md`（决策 D1–D12）、`docs/interaction-contract.md`、`docs/VISION.md`、根目录 `spec/`（K0 冻结 spec v1.0）

## 一句话现状
K0 已总验收通过（ACCEPTED WITH FOLLOW-UPS）：事件溯源确定性内核 + Web 四入口 + 决策闭环 + 本地执行节点 + Agent 执行器全部落地并部署生产。下一步是验收报告的 7 条 follow-up 与 K2 批次（见 02-INFLIGHT 与仓库 STATUS 的「仍留后续批次」）。
