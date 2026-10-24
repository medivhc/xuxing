# tests/e2e — 旅程即测试（Web UI 侧骨架 v0）

D9 质量门要求「完整旅程必须是一条可执行测试」。本目录是它的 **UI 侧半成品**：
步骤、断言意图、启用条件都已写死在 `journeys.spec.ts` 里，但全部 `test.skip`，
因为 Web UI 尚未实现（K0 这一波只做到内核/API 级）。

**同一份旅程的内核级版本已经在跑，且是真 PostgreSQL 事件流**：

| 文件 | 内容 | 本波状态 |
| --- | --- | --- |
| `tests/journey/d8-full-journey.test.ts` | D8 完整旅程 18 步，逐步断言「事件流新增什么 + 投影变成什么」 | 已跑通（50 例） |
| `tests/journey/d8-guardrails.test.ts` | 在同一条旅程流上做非法写入，断言 typed 拒绝 + 零落库 | 已跑通（25 例） |
| `tests/journey/d9-projection-consistency.test.ts` | D9 纪律：状态只从事件派生（重放等价、分段水位、逐事件状态痕迹） | 已跑通（13 例） |
| `tests/e2e/journeys.spec.ts` | 同旅程的浏览器级版本 | **未跑**（UI 不存在，全 skip） |

---

## 1. 旅程步骤 → spec 章节 → 退出门（§8.3）映射

| e2e 步骤 | 内核级断言所在 | spec 出处 | 覆盖的退出门条目 |
| --- | --- | --- | --- |
| ① Capture 一句话目标入图 | `d8-full-journey` 步骤① | §2.1/§2.2、REQ-PJ-3、§4 | G3 前半（模糊输入→Captured）；C2（capture 幂等重放） |
| ② 计划草稿→批准→生效 | 步骤②a/②b/②c/②d | §5.1 REQ-PC-1..6、§2.7 | G3；C3（同 `base_plan_rev` 冲突 + 三方差异）；REQ-PC-2 原子性 |
| ③ 派活给代码 Agent，Run 到 running | 步骤③a/③b/③c | §3.1、§3.2、REQ-RUN-1/4、REQ-SCH-1..4、REQ-TC-1、REQ-ASG-1/INV-14 | G2（在跑 Run 快照哈希不变）；REQ-SCH-1 就绪判定 |
| ④ 人类反馈入账/解析解耦 | 步骤④a/④b/④c | §5.7 REQ-HUM-1/2、REQ-FB-1、REQ-DD-1、§2.5、INV-13 | C2（同客户端提交 id 重放 11 次仍 +1）；新 P1-3（游离 Feedback 不产 Outcome） |
| ⑤ 产出 Outcome→Run succeeded→awaiting_acceptance | 步骤⑤ | §2.5 REQ-OC-1/2、§3.1、§8.1 G3 | G3 试金石（四分关系）；REQ-PC-6 账目 |
| ⑥ 验收（判据打点→待补集→accepted） | 步骤⑥a/⑥b/⑥c/⑥d/⑥e | §2.6 REQ-ACC-1..5、§3.1、INV-11、REQ-SCH-2 | G1 收尾（INV-11 自动取消 WaitCondition）；C6（actor 分离，自验被拦）；S4（partially 留待补集）；REQ-ACC-1 跨 rev 解锁下游 |
| ⑦ human_light 人在环路径 + 跟进唯一化 | 步骤附（当前登记为缺口） | §5.7 REQ-HUM-1/3、INV-10、§8.1 G1 | **G1 尚未全绿**：见下方 FINDING D9-J2 |
| C1/C1b 租约过期分界 | 内核矩阵与 facts 已断言（`d8-guardrails`），剧本未跑 | §3.2 REQ-RUN-3/4、§8.2 | C1、C1b —— 需 Executor 侧进程钩子，UI 与真实适配器到位后补 |
| C4 WaitCondition 到期跨重启 | 未覆盖 | §5.2 REQ-SCH-3 | C4 —— 需内核重启钩子 + `WaitConditionExpired` |
| C5 投影重建 | `d9-projection-consistency` D9-1/D9-2 已覆盖（含与 `MinimalProjection` 交叉核对） | §8.2 C5、INV-12 | C5 ✅（内核级）；UI 侧待 `admin-rebuild-projection` 入口 |

退出门（§8.3）三项：**G1–G5 全绿 + C1–C6 全绿 + REQ-DT-2 对照报告已评审**。
当前内核级覆盖到 G2/G3/G5-局部与 C2/C3/C5/C6；**G1 与 C1/C1b/C4 未全绿**（原因见 §3）。

## 2. 解除 skip 的三条启用条件（同时满足）

- **E1 前端路由可用**：Capture 页、Project 页、Task 详情、Run 详情、验收面板、MyActions
  六面齐备，且能在 CI 里以 `XUXING_WEB_URL` 起服务。
- **E2 后端写入口可用**：capture / plan-changes / assignments / runs / feedback / acceptance
  六组 HTTP 面。目前 `src/` 只有内核（`src/kernel/event-store-pg.ts` 的
  `append` / `appendStateTransition` / `withTransaction`），没有任何 HTTP 层，
  所以 e2e 即便有 UI 也没有可打的接口面。
- **E3 测试锚点**：界面按 `journeys.spec.ts` 末尾 `TESTID` 命名契约打点。

启用步骤写在 `playwright.config.ts` 顶部注释里（一次解一条 skip，绿了再解下一条）。

## 3. 本波发现、且必须由 spec/实现侧解决的阻塞项

| 编号 | 现象 | 影响 | 证据位置 |
| --- | --- | --- | --- |
| FINDING D9-J2 | REQ-HUM-1 要求 `human_light` Run 走 `created→running`，但 §3.2 实现矩阵该格是 `–`（「未经租约不可启动」），内核写路径直接拒 | **G1 无法在内核级走通**；旅程只发 `RunCreated` 并把拒绝登记为断言，不伪造合法迁移 | `d8-full-journey` 末段；`d8-guardrails` §3.2 第 4 条 |
| FINDING D9-J3 | §3.1 的 `→captured` 列（7 格）与 §3.2 的 `→created` 列（9 格）在矩阵里没有格，`isMatrixCellAllowed` 按「缺格是编程错误」大声抛 `transition matrix incomplete` | 任何「是否可回到初始态」的查询会抛错而非返回拒绝；旅程未触发（合法路径不写初始列） | `d8-guardrails`「FINDING D9-J3」条（枚举出 16 格） |
| FINDING D9-J4 | `isTerminal('task', …)` 只认 `canceled`，`accepted` 的拒绝理由标签是 `illegal_transition`，而矩阵格注写的是「accepted 为终态」 | 结论一致、归因不同；对审计与前端文案有影响 | `d8-guardrails` §3.1 第 2 条 |
| REQ-SCH-4 无事件类型 | `ActorProfile` 在 §4 封闭事件目录里没有对应事件类型，能力/在册状态无法「只从事件派生」 | 旅程把执行者当种子夹具（`D8_ACTOR_PROFILES`），并在 `journey-rules.ts` 头部标注这是测试侧编码 | `tests/journey/support/journey-rules.ts` |
