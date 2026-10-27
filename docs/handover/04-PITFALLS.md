# 04 坑位（都是付过学费的，动手前读完）

## 内核/数据
- **乐观并发别用错条件**：`UPDATE … WHERE version=$expected RETURNING` 必须在同一条语句里校验版本；先 SELECT 再 UPDATE 会在并发下破防（K0 Batch 1 F2 实证）。
- **部分唯一索引要带状态谓词**：如 `lower(name)` 唯一索引必须限定未删除行，否则删除后同名重建撞唯一约束（Batch 1 F3）。全面排查时用表驱动测试枚举同类点。
- **投影 UI 计数不能靠列表长度近似**：生产曾出现「待我处理 UI 行数 vs API 行数」靠 e2e 逐个对账才可信；服务端派生字段（如 isNew）与前端启发式推导并存时，以服务端为准，启发式是技术债。

## 前端/部署
- **前端字段形状以服务端 canonical 为准**：曾因前端用错字段形状（如 `/api/captures → {data:[]}` 的假设）导致整页「0/空」，根因是形状漂移不是数据丢。改前端前先真实 curl 一次接口看原始 JSON。
- **CI web build 必须显式装依赖并保持 lock 一致**：每个 job 都要有 pnpm install 步骤、lock 与 package.json 同步；本地绿不等于 CI 绿（TS 找不到模块、vitest 版本与 DOM 环境不匹配都栽过）。
- **Tailwind v4 只认 CSS-first**：`@import "tailwindcss"` + `@theme`，不要写 JS 版 tailwind.config；v4 也没有 @tailwind base/components/utilities 指令。配偶色走 token 类名（bg-accent 等），不要滥用 arbitrary values。
- **生产静态托管已切到服务端自托管（A 案）**：不要再按 Caddy 托管静态的老方案改部署；Caddy 只剩反代 + SPA fallback。
- **e2e 验收标准**：元素「在场 + 可点 + 点后状态真变化（API/投影可查）」三者齐才算过；「API 200」不算旅程通过。测试计数逐个清点，禁止约数。

## 执行器/节点
- **agent 执行器的产物只 commit 不 push**：每 Run 独立 worktree + 分支 `xu-agent/<run尾12位>`；验收由人做，不要让执行器自己合入。
- **并发派发时 git fetch 有锁竞态**（生产 e2e 逼出来的，已 fix2）：在节点侧加新并发逻辑时先想锁。
- **服务端加执行器路由只许动一处**：`createExecutorRun` 的路由（显式 kind > command → shell > 缺省 agent），快照组装同步跟上；多处分叉会漂移。

## 流程
- **长任务 wrapper 以完成标记判终态**：opencode run 退出但日志尾无 `NX_PHASE_COMPLETE` = 中断，要自动续跑，不要当完成汇报；「0 assistant 消息」也可能是抓取通道坏了，先直查 session 再定性。
- **评审必须异构/独立**：实现者与评审员不能是同一模型/同一会话；评审结论只认证据锚点（file:line），不认自报摘要——云端 agent 的交卷摘要出现过整段编造，产物一律以仓库/API 一手核实为准。
- **文档与代码一致性靠机制**：仓库有 docs-check（引用可达 + STATUS 的 based_on 必须是 HEAD 祖先且不过期）；改完代码记得刷 STATUS 并更新 based_on。
