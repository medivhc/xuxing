# 05 权限与凭据（只记位置与发放方式，绝不记值）

接手者需要所有者（用户）逐项发放；本文件列清单，逐项打勾后再开工。

## 代码
- [ ] GitHub `medivhc/xuxing` 协作权限（或用所有者账号连接）。注意该仓默认分支是 `develop/eventstore-batch1`，核对文件时指明分支/ref。
- [ ] GitHub 写操作口径（所有者现行规定）：走 token/gh/SSH 通道直接执行并报结果，**不要用 GitHub MCP 逐次弹审核卡**。

## 开发机 xc-pc-linux
- [ ] SSH 登录（用户 appen，沙盒/agent 公钥加入 authorized_keys）。工作区 `/work/xuxing`、节点记录目录 `/work/xuxing-node/records`。
- [ ] 构建注意：该机根盘曾满，worktree 一律放 `/work`；各轨道用独立 `CARGO_TARGET_DIR`，共享 sccache（`/work/nexus-dev/sccache`，给 Nexus 用的；xuxing 是 TS 项目不涉及 cargo，仅在借用机器时注意别占满盘）。
- [ ] 模型通道：xc 上 opencode 已配多 provider（unisound u2-flash、opencode-go、magpie 网关），真实模型 API 一律复用这些现成配置，不另要 key、不自建密钥管理、不把 key 写进仓库。细则见 handover-attachments/EXECUTORS.md（仓库根）。

## 生产 VPS（tg.bewith.link 所在机）
- [ ] SSH 访问（经所有者的 mesh/跳板发放）。Docker 操作权限（构建/切换 `xuxing-app` 镜像）。
- [ ] 双令牌（用户令牌/节点令牌）在 VPS 本地生成与注入，接手运维时重新生成并同步节点侧，不要跨环境拷贝旧令牌文件长期使用。
- [ ] 节点令牌在 xc 侧为机对机文件（600 权限），路径以节点部署记录为准。

## 不在交接范围
- 原协调者的个人记忆、其他项目（Nexus 等）的凭据、各云端执行器平台（Qoder/TRAE/WorkBuddy）的账号登录态——接手者如需用网页执行器农场，由所有者另行授权登录。
- 生产 E2E 标记数据与 awaiting_acceptance 产物的人工验收权在用户本人。
