# 01 当前状态（2026-10-27）

数据来源：打包时一手核验（GitHub ls-remote、xc worktree、仓库 docs/STATUS.md）+ 生产部署记录。冲突时以仓库 `docs/STATUS.md`（based_on 8ed1a7e）与 GitHub 远端为准。

## 已完成
- **K0 内核**：事件溯源确定性内核（Event/Task/Run/Evidence），能力含 appendBatch、Run 守卫/审计、事务作用域、消费水位、Scheduler、Acceptance 重算、actor 分离守卫、Tool Gateway、listStreams、Decision 实体与裁决、节点派发。
- **批次**：Batch 1、Batch 2、Q12（actor 分离）、阶段二（静态托管/杂项）、K1（决策闭环 + 本地执行节点 + 双令牌访问控制）、K0-Q25 Agent 执行器（agent_hands_agent：节点上 tmux+opencode 真执行）——全部合入开发线，各轨独立评审 APPROVED。
- **合并**：develop 已合入 master（PR #9，merge e06f028；远端 master 现 tip bb77df4），master CI 全绿。
- **K0 总验收**：verdict = ACCEPTED WITH FOLLOW-UPS（D8 四项全 green；1 个 yellow 子项见 02-INFLIGHT）。双轨对照完成：真实 nx-pipeline run 导入内核，终态一致、内核真缺陷 0。

## 质量门（最后一次全量，STATUS 正本）
- 根测试（真 PG16）：634 passed / 5 todo / 0 failed
- server 测试：144 passed / 0 failed
- typecheck：根 + server 均 0 错；web 构建成功
- journeys：mock 轮 13 passed；真服务轮 spec50 4 + spec60 2 + K1 五 spec 10 passed
- CI：三 job + docs-check 全绿
- 生产公网 e2e：API 17 PASS、提议闭环状态真变、待我处理 UI 行数与 API 一致、零 pageerror

## 生产形态
- 入口 https://tg.bewith.link ；VPS 上 Docker：`xuxing-app`（镜像 xuxing-web:20261025-1726）+ `xuxing-pg`（postgres:16-alpine），各 192MB 内存上限。
- 服务端自托管前端静态文件（A 案已切换，早期 B 案 Caddy 托管已退役）；Caddy 仅做反代与 SPA 回退。
- 访问控制：双令牌（用户令牌 / 节点令牌分离），在 VPS 本地生成注入，不出 VPS（位置见 05-ACCESS）。
- 执行节点：xc-pc-linux 上 systemd user unit `xuxing-node-agent.service`（enabled、Restart=always、Linger 自恢复），node_id `node_6005a5f6df374481b9dd`，recordsDir `/work/xuxing-node/records`；双执行器在岗（shell + agent_hands_agent）。
