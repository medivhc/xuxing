# 续行（Xuxing）

以目标与结果为中心、人与 AI Agent 共同执行的工作系统。

## 文档

- 产品蓝图（目标态）：`~/workspace/user/files/Xuxing_Final_Product_Blueprint_v1.0_1___1__0_ew1d.md`（§0–§10，缺安全/NFR/成本/离线四章，由技术方案先行补齐框架 — D7）
- 评审 + 技术方案 v1：`~/workspace/your_files/xuxing-review-and-tech-plan.md`
- 决策记录：`docs/DECISIONS.md`
- K0 领域 spec：`spec/K0-SPEC.md`（当前阶段：contract-review）

## 已定版决策（2026-10-21，用户拍板全部按评审建议）

D1 云端内核 + 本地执行节点 · D2 内核 TypeScript · D3 K0/K1 不引入 Temporal · D4 第一批真实负载 = nx-pipeline 双轨对照 · D5 副作用 L2 按项目逐项授权 · D6 品牌/英文名搁置 · D7 缺失四章由技术方案补齐框架、细则在 K0 spec 对齐

## 阶段

- **K0 脊柱**（进行中）：Event Store + Task/Run/Feedback/Outcome/Acceptance + PlanChange 校验 + 单个代码 Agent 适配器 + 人类执行者 + Web 四入口最小形态 + 副作用 L0/L1。领域 spec 已冻结 v1.0（2026-10-21，三轮 contract-review APPROVED，见 `spec/FREEZE-LOG.md`）。develop 第一批：Event Store 的 PG 实现（`src/kernel/event-store-pg.ts`）+ 迁移矩阵校验器（`src/kernel/transition-guard.ts`），C2/C5 以真 PostgreSQL 16 容器验收。develop 第二批：批量追加（`appendBatch`）、Run 事件命令层守卫（`run-events.ts`）、事务作用域/COMMIT 真实性硬化、增量消费水位（`tailing`，水位落库 + 投递幂等）、Scheduler 定时器（REQ-SCH-3）与 Acceptance 重算（REQ-ACC-3）机制。
- K1 可信 / K2 协作 / K3 积累：见技术方案 §2.12

## 开发

固定 Node 24.4.1（见 `.nvmrc`）。DB 集成测试会自动确保容器 `xuxing-pg-test`（`127.0.0.1:55432`，`postgres:16-alpine` 本地镜像）；若 docker 不可用，按失败信息给出的指引设 `XUXING_TEST_PG_URL` 指向外部 PG16。

```
export PATH="$HOME/.nvm/versions/node/v24.4.1/bin:$PATH"
npm install
npm run typecheck
npm test          # 自动确保 PG 容器；docker 不可用会大声失败，绝不 skip
npm run db:down   # 清理测试容器（容器本身可复用，无需每次重建）
```

## 事件存储（Batch 1/2）用法

`stream_id = project_id`（spec §4；传 task_id 不会报错，但会建出错误的流，`assertProjectStreamId` 会拒绝主体 id 撞值）。`migrate(pool)` 需自己调用一次（幂等）；`createPgEventStore(pool)` 不自带迁移。流的第一条事件必须是 `ProjectCreated`（其余事件写新流会被 `ProjectCreatedRequiredError` 拒绝）。

```ts
import { createPgEventStore, migrate } from './src/kernel/event-store-pg.js';

await migrate(pool);
const store = createPgEventStore(pool);

// ⓪ 建项目流：流的第一条事件必须是 ProjectCreated（spec §4 / INV-12）
await store.append({
  stream_id: projectId, type: 'ProjectCreated',
  actor_id, actor_kind: 'human', causation_id: null, correlation_id: corr,
  idempotency_key: projectCreatedKey,
  payload: { name: '示例项目', created_by: actor },
});

// ① 普通事件：payload 形状由事件类型决定
await store.append({
  stream_id: projectId, type: 'TaskCaptured',
  actor_id, actor_kind: 'human', causation_id: null, correlation_id: corr,
  idempotency_key: clientSubmitId, // 同 key 重投只入账一次（INV-13）
  payload: { task_id: taskId, title: '联系张三确认方案' },
});

// ② 状态迁移：guard 判定用顶层 from/to；payload 可省略 from/to（store 补齐），
//    若写了但与顶层矛盾 → TransitionPayloadMismatchError；type 必须与 entity 家族一致。
await store.appendStateTransition({
  stream_id: projectId, type: 'TaskLifecycleChanged', entity: 'task',
  actor_id, actor_kind: 'system', causation_id: null, correlation_id: corr,
  idempotency_key: transitionKey,
  payload: { task_id: taskId }, from: 'ready', to: 'active',
});

// ③ INV-11 accepted：收尾动作 + lifecycle 迁移放进同一个 appendBatch（同事务、同链、原子）。
//    任一事件失败 → 整批回滚、零事件落库；顺序即 spec §3.1 的收尾顺序。
const { events } = await store.appendBatch([
  {
    stream_id: projectId, type: 'WaitConditionCanceled',
    actor_id, actor_kind: 'system', causation_id: null, correlation_id: corr,
    idempotency_key: `${transitionKey}:wc:${waitConditionId}`,
    payload: { wait_condition_id: waitConditionId, task_id: taskId, reason: 'task_accepted' },
  },
  {
    stream_id: projectId, type: 'TaskWaitStateChanged',
    actor_id, actor_kind: 'system', causation_id: null, correlation_id: corr,
    idempotency_key: `${transitionKey}:ws`,
    payload: {
      task_id: taskId, from: 'waiting_on_person', to: 'none',
      reason: 'task_accepted', actor_id, actor_kind: 'system',
    },
  },
  {
    stream_id: projectId, type: 'TaskLifecycleChanged', entity: 'task',
    from: 'awaiting_acceptance', to: 'accepted',
    facts: { acceptanceVerdict: 'accepted' },
    actor_id, actor_kind: 'system', causation_id: null, correlation_id: corr,
    idempotency_key: `${transitionKey}:lc`,
    payload: { task_id: taskId, trigger_event_id: acceptanceId },
  },
]);
// events 恰为 3 条（WaitConditionCanceled → TaskWaitStateChanged → TaskLifecycleChanged）。
// 收尾事件已在批次内显式写出，内核不会再补发第二份。

// ④ 增量消费（S5）：水位落库 + 投递幂等键，进程重启后从水位继续。
const batch = await store.fetchAfterWatermark({ consumer_id: 'projection:home', limit: 200 });
for (const event of batch.events) applyToProjection(event); // 投影由消费方实现
await store.commitDeliveries({
  consumer_id: 'projection:home',
  last_global_seq: batch.watermark,               // 安全水位：不越过未提交事件
  event_ids: batch.events.map((event) => event.id), // 重复提交不会重复入账
});

const check = await store.verifyChain(projectId);
// 不存在的 stream：{ ok: false, stream_exists: false, reason: '流不存在：…（stream_not_found）' }
// 链头（event_streams.last_hash/last_seq）被改乱：ok=false，broken_in='stream_head'，定位到断点
const streams = await store.listStreams(); // 运维巡检：每个流的 last_seq / event_count / last_hash
```

状态迁移还可以走 `withTransaction(async (tx) => …)` 手写多事件事务；但事务内必须只用 `tx`，
用外层 store 写会立刻抛 `TransactionScopeError`（旧行为是等自己的锁而挂起）。

写路径就绪范围：`append` / `appendBatch` / `appendStateTransition` / `withTransaction` / 增量消费水位（`fetchAfterWatermark` + `commitDeliveries`）。Run 状态迁移在命令层统一经 `appendRunCreated` / `appendRunTransition`（审计测试见 `tests/run-dispatch-audit.test.ts`）；`src/kernel/scheduler.ts`（REQ-SCH-3）与 `src/kernel/acceptance.ts`（REQ-ACC-3）已提供机制与测试夹具，生产调度循环与投影消费者仍留后续批次接线。
