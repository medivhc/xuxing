// K1-B §4：执行节点派发服务。职责：
// - 节点注册/心跳/注销与存活口径（online/stale/offline），NodeRegistered /
//   NodeOffline 事件落 $system 流；
// - 出站长轮询派发：queued executor Run → 能力匹配的节点（ack 租约制）；
// - 租约过期分流（REQ-RUN-4：未启动回 queued；已启动按副作用分界
//   failed / indeterminate）、离线挂起 state_reason=awaiting_node；
// - 结果回报全链（raw-result 走 Outcome 流）、取消确认、副作用记录、
//   probe 对账（REQ-RUN-3 三结论，只处置一次）。
// 领域事实以事件流为准；本服务只维护运维表（见 store.ts）。
import { randomUUID } from 'node:crypto';
import { ulid } from 'ulid';
import type { PgEventStore } from '../../../src/kernel/event-store-pg.js';
import { asProjectId, type EventEnvelope, type EventType } from '../../../src/kernel/events.js';
import type { ProjectionService } from '../projection/service.js';
import type { Proposer } from '../proposers/proposer.js';
import { LEVEL_RANK, NodeStore, type DispatchRow, type NodeRow } from './store.js';

export class NodeApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'NodeApiError';
  }
}

export interface DispatcherConfig {
  staleSec: number;
  offlineSec: number;
  dispatchTimeoutSec: number;
  leaseDurationSec: number;
}

export function dispatcherConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DispatcherConfig {
  const num = (name: string, fallback: number): number => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    staleSec: num('XUXING_NODE_STALE_SEC', 30),
    offlineSec: num('XUXING_NODE_OFFLINE_SEC', 90),
    dispatchTimeoutSec: num('XUXING_DISPATCH_TIMEOUT_SEC', 30),
    leaseDurationSec: num('XUXING_LEASE_SEC', 45),
  };
}

export const TERMINAL_RUN_STATES = new Set(['succeeded', 'failed', 'canceled', 'timed_out']);
const SYSTEM_STREAM = '$system';

export function nodeStatusOf(row: NodeRow, nowMs: number, config: DispatcherConfig): 'online' | 'stale' | 'offline' {
  if (row.deregistered_at !== null) return 'offline';
  const ageSec = (nowMs - Date.parse(row.last_heartbeat_at)) / 1000;
  if (ageSec <= config.staleSec) return 'online';
  if (ageSec <= config.offlineSec) return 'stale';
  return 'offline';
}

function rank(level: string | null | undefined): number {
  return LEVEL_RANK[level ?? 'L1'] ?? 1;
}

export interface DispatchEnvelope {
  run_id: string;
  idempotency_key: string;
  task_id: string;
  assignment_id: string | null;
  task_rev: number | null;
  contract_rev: number | null;
  plan_rev: number | null;
  input_snapshot: Record<string, unknown>;
  policy_snapshot: Record<string, unknown> | null;
  side_effect_level: string;
  executor_kind: string | null;
  lease_duration_sec: number;
}

export class NodeDispatcher {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly events: PgEventStore,
    private readonly projections: ProjectionService,
    private readonly proposer: Proposer,
    private readonly store: NodeStore,
    private readonly config: DispatcherConfig,
  ) {}

  start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        console.error(JSON.stringify({ event: 'dispatcher_tick_failed', message: String(error) }));
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---------- 基础同步 ----------

  /** 投影 executor Run → 派发行；投影终态 → done；取消请求传播。 */
  async syncFromProjection(): Promise<void> {
    const snapshot = this.projections.snapshot();
    const taskProject = new Map(snapshot.tasks.map((t) => [t.task_id, t.project_id]));
    const rows = new Map((await this.store.listDispatch()).map((r) => [r.run_id, r]));
    for (const run of snapshot.runs) {
      if (run.run_kind !== 'executor') continue;
      const row = rows.get(run.run_id);
      if (!row) {
        const projectId = taskProject.get(run.task_id);
        if (!projectId) continue;
        await this.store.insertDispatch({ run_id: run.run_id, project_id: projectId, task_id: run.task_id });
        if (TERMINAL_RUN_STATES.has(run.state)) {
          await this.store.updateDispatch(run.run_id, { state: 'done' });
        }
        continue;
      }
      if (TERMINAL_RUN_STATES.has(run.state) && row.state !== 'done') {
        await this.store.updateDispatch(run.run_id, { state: 'done', state_reason: null });
      } else if (run.state === 'indeterminate' && row.state !== 'indeterminate' && row.state !== 'done') {
        await this.store.updateDispatch(run.run_id, { state: 'indeterminate' });
      }
    }
    // 取消传播：Task 有挂起取消 → 其在飞 Run 的行标 cancel_requested。
    const tasks = new Map(snapshot.tasks.map((t) => [t.task_id, t]));
    for (const row of await this.store.listDispatch()) {
      if (row.state === 'done' || row.cancel_requested) continue;
      if (tasks.get(row.task_id)?.cancel_requested_by) {
        await this.store.updateDispatch(row.run_id, { cancel_requested: true });
      }
    }
    await this.computeStateReasons();
  }

  /** queued 且无能力匹配的 online 节点 → state_reason=awaiting_node（§4.4）。 */
  private async computeStateReasons(): Promise<void> {
    const snapshot = this.projections.snapshot();
    const runs = new Map(snapshot.runs.map((r) => [r.run_id, r]));
    const nodes = await this.store.listNodes();
    const nowMs = Date.now();
    for (const row of await this.store.listDispatch()) {
      if (row.state !== 'queued') continue;
      const run = runs.get(row.run_id);
      if (!run || run.state !== 'queued') {
        if (row.state_reason !== null) await this.store.updateDispatch(row.run_id, { state_reason: null });
        continue;
      }
      const hasCapable = nodes.some(
        (n) =>
          nodeStatusOf(n, nowMs, this.config) === 'online' &&
          n.executor_kinds.includes(run.executor_kind ?? '') &&
          rank(run.side_effect_level) <= rank(n.max_side_effect_level),
      );
      const reason = hasCapable ? null : 'awaiting_node';
      if (row.state_reason !== reason) await this.store.updateDispatch(row.run_id, { state_reason: reason });
    }
  }

  // ---------- 周期维护 ----------

  async tick(): Promise<void> {
    await this.projections.refresh();
    await this.syncFromProjection();
    await this.expireDispatchesAndLeases();
    await this.convergeOfflineNodes();
    await this.computeStateReasons();
  }

  private async expireDispatchesAndLeases(): Promise<void> {
    const now = Date.now();
    const snapshot = this.projections.snapshot();
    const runs = new Map(snapshot.runs.map((r) => [r.run_id, r]));
    for (const row of await this.store.listDispatch()) {
      const run = runs.get(row.run_id);
      if (!run) continue;
      // 派发未 ack 超时：释放占用回 queued（§4.5）。
      if (
        row.state === 'queued' &&
        row.node_id !== null &&
        row.dispatching_at !== null &&
        now - Date.parse(row.dispatching_at) > this.config.dispatchTimeoutSec * 1000
      ) {
        await this.store.updateDispatch(row.run_id, { node_id: null, dispatching_at: null });
        continue;
      }
      // leased 未 started 租约过期 → RunQueued 回队（REQ-RUN-4 分界①）。
      if (row.state === 'leased' && run.state === 'leased' && row.lease_expires_at !== null && now > Date.parse(row.lease_expires_at)) {
        await this.transitionRun(row, {
          type: 'RunQueued',
          from: 'leased',
          to: 'queued',
          facts: { leaseExpired: true, started: false },
          payload: { run_id: row.run_id, reason: 'lease_expired_not_started' },
        });
        await this.store.updateDispatch(row.run_id, { state: 'queued', node_id: null, lease_expires_at: null, dispatching_at: null });
        continue;
      }
      // running 心跳丢失（租约过期）→ REQ-RUN-4 分界②③。
      if (row.state === 'running' && run.state === 'running' && row.lease_expires_at !== null && now > Date.parse(row.lease_expires_at)) {
        const hasSideEffects = row.side_effect_noted || run.side_effect_count > 0;
        if (hasSideEffects || rank(run.side_effect_level) >= rank('L2')) {
          await this.transitionRun(row, {
            type: 'RunIndeterminate',
            from: 'running',
            to: 'indeterminate',
            facts: { heartbeatLost: true },
            payload: { run_id: row.run_id, reason: 'heartbeat_lost' },
          });
          await this.store.updateDispatch(row.run_id, { state: 'indeterminate' });
        } else {
          await this.appendToRun(row, {
            type: 'RunFailed',
            payload: { run_id: row.run_id, reason: 'lease_expired' },
          });
          await this.store.updateDispatch(row.run_id, { state: 'done', state_reason: null });
        }
      }
    }
  }

  /** offline 收敛：超时未通知的节点补发 NodeOffline（§4.3）。 */
  private async convergeOfflineNodes(): Promise<void> {
    const nowMs = Date.now();
    for (const node of await this.store.listNodes()) {
      if (node.deregistered_at !== null || node.offline_notified) continue;
      if (nodeStatusOf(node, nowMs, this.config) !== 'offline') continue;
      await this.appendSystem({
        type: 'NodeOffline',
        payload: {
          node_id: node.node_id,
          reason: 'heartbeat_timeout',
          last_heartbeat_at: node.last_heartbeat_at,
        },
      });
      await this.store.updateNodeRegistration(node.node_id, { offline_notified: true });
    }
  }

  // ---------- 事件落账辅助 ----------

  private opKey(prefix: string, runId?: string): string {
    return `dispatch:${prefix}:${runId ?? 'sys'}:${randomUUID()}`;
  }

  /** 与 wake.ts 同款系统落账信封（actor system / causation 空 / ulid 关联）。 */
  private base(projectId: string) {
    return {
      stream_id: asProjectId(projectId),
      actor_id: 'system',
      actor_kind: 'system' as const,
      causation_id: null,
      correlation_id: `dispatch-${ulid()}`,
    };
  }

  private async appendSystem(input: { type: string; payload: Record<string, unknown> }): Promise<EventEnvelope> {
    const event = await this.events.append({
      ...this.base(SYSTEM_STREAM),
      type: input.type as EventType,
      payload: input.payload,
      idempotency_key: this.opKey('system'),
    });
    await this.projections.refresh();
    return event;
  }

  private async appendToRun(
    row: DispatchRow,
    input: { type: string; payload: Record<string, unknown> },
  ): Promise<EventEnvelope> {
    const event = await this.events.append({
      ...this.base(row.project_id),
      type: input.type as EventType,
      payload: input.payload,
      idempotency_key: this.opKey(input.type, row.run_id),
    });
    await this.projections.refresh();
    return event;
  }

  private async transitionRun(
    row: DispatchRow,
    input: {
      type: string;
      from: string;
      to: string;
      facts: Record<string, unknown>;
      payload: Record<string, unknown>;
    },
  ): Promise<{ emitted: EventEnvelope[] }> {
    const key = this.opKey(input.type, row.run_id);
    const result = await this.events.appendStateTransition({
      ...this.base(row.project_id),
      type: input.type as EventType,
      entity: 'run',
      idempotency_key: key,
      trigger_event_id: `${key}:trigger`,
      from: input.from,
      to: input.to,
      facts: input.facts as never,
      payload: input.payload,
    });
    await this.projections.refresh();
    return { emitted: [result.event] };
  }

  // ---------- 节点生命周期 ----------

  async registerNode(input: {
    node_id?: string;
    display_name: string;
    executor_kinds: string[];
    max_side_effect_level: string;
    agent_version?: string;
  }): Promise<{ node_id: string; status: string; server_time: string }> {
    if (typeof input.display_name !== 'string' || input.display_name.trim() === '') {
      throw new NodeApiError(400, 'schema_invalid', 'display_name 必填非空', { field: 'display_name' });
    }
    if (!Array.isArray(input.executor_kinds) || input.executor_kinds.length === 0 || input.executor_kinds.some((k) => typeof k !== 'string')) {
      throw new NodeApiError(400, 'schema_invalid', 'executor_kinds 必须是非空字符串数组', { field: 'executor_kinds' });
    }
    if (!(input.max_side_effect_level in LEVEL_RANK)) {
      throw new NodeApiError(400, 'schema_invalid', 'max_side_effect_level 必须是 L0..L3', { field: 'max_side_effect_level' });
    }
    const nowIso = new Date().toISOString();
    if (input.node_id) {
      const existing = await this.store.getNode(input.node_id);
      if (existing && existing.deregistered_at === null) {
        // 重注册同 id：只更新行，不重复发 NodeRegistered（§4.3 幂等）。
        await this.store.updateNodeRegistration(input.node_id, {
          display_name: input.display_name,
          executor_kinds: input.executor_kinds,
          max_side_effect_level: input.max_side_effect_level,
          agent_version: input.agent_version ?? existing.agent_version,
          last_heartbeat_at: nowIso,
          offline_notified: false,
        });
        return { node_id: input.node_id, status: 'online', server_time: nowIso };
      }
      if (existing) {
        await this.store.updateNodeRegistration(input.node_id, {
          display_name: input.display_name,
          executor_kinds: input.executor_kinds,
          max_side_effect_level: input.max_side_effect_level,
          agent_version: input.agent_version ?? existing.agent_version,
          last_heartbeat_at: nowIso,
          deregistered_at: null,
          offline_notified: false,
        });
        await this.appendSystem({
          type: 'NodeRegistered',
          payload: {
            node_id: input.node_id,
            display_name: input.display_name,
            executor_kinds: input.executor_kinds,
            max_side_effect_level: input.max_side_effect_level,
            agent_version: input.agent_version ?? null,
            registered_at: nowIso,
          },
        });
        return { node_id: input.node_id, status: 'online', server_time: nowIso };
      }
    }
    const nodeId = input.node_id ?? `node_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    await this.store.insertNode({
      node_id: nodeId,
      display_name: input.display_name,
      executor_kinds: input.executor_kinds,
      max_side_effect_level: input.max_side_effect_level,
      agent_version: input.agent_version ?? null,
      registered_at: nowIso,
      last_heartbeat_at: nowIso,
    });
    await this.appendSystem({
      type: 'NodeRegistered',
      payload: {
        node_id: nodeId,
        display_name: input.display_name,
        executor_kinds: input.executor_kinds,
        max_side_effect_level: input.max_side_effect_level,
        agent_version: input.agent_version ?? null,
        registered_at: nowIso,
      },
    });
    return { node_id: nodeId, status: 'online', server_time: nowIso };
  }

  async heartbeatNode(nodeId: string): Promise<{ status: string; server_time: string }> {
    const node = await this.requireNode(nodeId);
    const nowIso = new Date().toISOString();
    await this.store.updateNodeRegistration(nodeId, { last_heartbeat_at: nowIso, offline_notified: false });
    void node;
    return { status: 'online', server_time: nowIso };
  }

  async deregisterNode(nodeId: string): Promise<{ deregistered: true }> {
    const node = await this.requireNode(nodeId);
    void node;
    const rows = (await this.store.listDispatch()).filter((r) => r.node_id === nodeId && r.state !== 'done');
    const busy = rows.filter((r) => r.state === 'running');
    if (busy.length > 0) {
      throw new NodeApiError(409, 'node_busy', '节点仍有 started 未终态 Run，先等待/处置后再注销', {
        reason: 'node_busy',
        runs: busy.map((r) => r.run_id),
      });
    }
    const snapshot = this.projections.snapshot();
    const runs = new Map(snapshot.runs.map((r) => [r.run_id, r]));
    for (const row of rows.filter((r) => r.state === 'leased')) {
      if (runs.get(row.run_id)?.state === 'leased') {
        await this.transitionRun(row, {
          type: 'RunQueued',
          from: 'leased',
          to: 'queued',
          facts: { leaseExpired: true, started: false },
          payload: { run_id: row.run_id, reason: 'node_deregistered' },
        });
      }
      await this.store.updateDispatch(row.run_id, { state: 'queued', node_id: null, lease_expires_at: null });
    }
    for (const row of rows.filter((r) => r.state === 'queued')) {
      await this.store.updateDispatch(row.run_id, { node_id: null, dispatching_at: null });
    }
    await this.store.updateNodeRegistration(nodeId, { deregistered_at: new Date().toISOString() });
    await this.appendSystem({
      type: 'NodeOffline',
      payload: { node_id: nodeId, reason: 'deregister', last_heartbeat_at: node.last_heartbeat_at },
    });
    await this.computeStateReasons();
    return { deregistered: true };
  }

  async requireNode(nodeId: string): Promise<NodeRow> {
    const node = await this.store.getNode(nodeId);
    if (!node || node.deregistered_at !== null) {
      throw new NodeApiError(404, 'node_not_registered', `节点 ${nodeId} 未注册（或已注销）`, {
        reason: 'node_not_registered',
        node_id: nodeId,
      });
    }
    return node;
  }

  // ---------- 派发长轮询 ----------

  async poll(nodeId: string, waitSec: number): Promise<{ dispatch: DispatchEnvelope | null; cancel_requests: string[]; probe_requests: Array<{ run_id: string; idempotency_key: string }> }> {
    const node = await this.requireNode(nodeId);
    const deadline = Date.now() + Math.max(0, Math.min(waitSec, 30)) * 1000;
    for (;;) {
      await this.projections.refresh();
      await this.syncFromProjection();
      const result = await this.computePoll(node);
      if (result.dispatch || result.cancel_requests.length > 0 || result.probe_requests.length > 0 || Date.now() >= deadline) {
        return result;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private async computePoll(node: NodeRow): Promise<{ dispatch: DispatchEnvelope | null; cancel_requests: string[]; probe_requests: Array<{ run_id: string; idempotency_key: string }> }> {
    const snapshot = this.projections.snapshot();
    const runs = new Map(snapshot.runs.map((r) => [r.run_id, r]));
    const rows = await this.store.listDispatch();
    const cancel_requests = rows
      .filter((r) => r.node_id === node.node_id && r.cancel_requested && (r.state === 'leased' || r.state === 'running'))
      .map((r) => r.run_id);
    const status = nodeStatusOf(node, Date.now(), this.config);
    const probe_requests =
      status === 'online'
        ? rows
            .filter((r) => r.state === 'indeterminate' && r.node_id === node.node_id && !r.probe_disposed)
            .map((r) => ({ run_id: r.run_id, idempotency_key: `probe:${r.run_id}` }))
        : [];
    let dispatch: DispatchEnvelope | null = null;
    if (status === 'online') {
      for (const row of rows) {
        if (row.state !== 'queued' || TERMINAL_RUN_STATES.has(runs.get(row.run_id)?.state ?? '')) continue;
        const run = runs.get(row.run_id);
        if (!run || run.state !== 'queued') continue;
        // 派发占用是排他的：已被某节点占用（待 ack）的 Run 不再重复下发，
        // 直到 ack / nack / 30s 超时释放——否则轮询方会在同一单上打转。
        if (row.node_id !== null) continue;
        if (!node.executor_kinds.includes(run.executor_kind ?? '')) continue;
        if (rank(run.side_effect_level) > rank(node.max_side_effect_level)) continue;
        // 占用（claim）：写 dispatching 标记，ack 前不算租约。
        await this.store.updateDispatch(row.run_id, {
          node_id: node.node_id,
          dispatching_at: new Date().toISOString(),
        });
        dispatch = await this.buildEnvelope(row);
        break;
      }
    }
    return { dispatch, cancel_requests, probe_requests };
  }

  private async buildEnvelope(row: DispatchRow): Promise<DispatchEnvelope> {
    const stream = await this.events.readStream(asProjectId(row.project_id), 1);
    const created = stream.find((e) => e.type === 'RunCreated' && (e.payload as Record<string, unknown>).run_id === row.run_id);
    const p = (created?.payload ?? {}) as Record<string, unknown>;
    return {
      run_id: row.run_id,
      idempotency_key: `run:${row.run_id}`,
      task_id: row.task_id,
      assignment_id: (p.assignment_id as string) ?? null,
      task_rev: (p.task_rev as number) ?? null,
      contract_rev: (p.contract_rev as number) ?? null,
      plan_rev: (p.plan_rev as number) ?? null,
      input_snapshot: (p.input_snapshot as Record<string, unknown>) ?? {},
      policy_snapshot: (p.policy_snapshot as Record<string, unknown>) ?? null,
      side_effect_level: (p.side_effect_level as string) ?? 'L1',
      executor_kind: (p.executor_kind as string) ?? null,
      lease_duration_sec: this.config.leaseDurationSec,
    };
  }

  // ---------- Run 交互 ----------

  /** §4.4：Run 视图层 state_reason 合成（投影 Run + 派发行，只读——
   * 派发行由 tick/poll/命令路径维护，GET 不产生写副作用）。 */
  async dispatchReasons(): Promise<Map<string, string | null>> {
    const map = new Map<string, string | null>();
    for (const row of await this.store.listDispatch()) {
      if (row.state !== 'done') map.set(row.run_id, row.state_reason);
    }
    return map;
  }

  private async requireRow(runId: string): Promise<DispatchRow> {
    await this.projections.refresh();
    await this.syncFromProjection();
    const row = await this.store.getDispatch(runId);
    if (!row) {
      throw new NodeApiError(404, 'not_found', `Run ${runId} 无派发记录`, { reason: 'not_found', run_id: runId });
    }
    return row;
  }

  private runStateOf(runId: string): string | null {
    return this.projections.snapshot().runs.find((r) => r.run_id === runId)?.state ?? null;
  }

  async ack(nodeId: string, runId: string): Promise<{ lease_expires_at: string }> {
    const row = await this.requireRow(runId);
    const state = this.runStateOf(runId);
    if (state !== null && TERMINAL_RUN_STATES.has(state)) {
      throw new NodeApiError(409, 'terminal_state', `Run 已终态（${state}），迟到 ack 拒绝`, { reason: 'terminal_state', run_id: runId, status: state });
    }
    if (row.state === 'leased' && row.node_id === nodeId && row.lease_expires_at) {
      return { lease_expires_at: row.lease_expires_at }; // 幂等重放
    }
    if (row.state !== 'queued' || row.node_id !== nodeId || state !== 'queued') {
      throw new NodeApiError(409, 'precondition_unmet', 'Run 未处于派往本节点的待 ack 状态', { reason: 'precondition_unmet', run_id: runId });
    }
    const leaseExpiresAt = new Date(Date.now() + this.config.leaseDurationSec * 1000).toISOString();
    await this.transitionRun(row, {
      type: 'RunLeased',
      from: 'queued',
      to: 'leased',
      facts: {},
      payload: { run_id: runId, node_id: nodeId, executor_kind: this.projections.snapshot().runs.find((r) => r.run_id === runId)?.executor_kind ?? null, lease_expires_at: leaseExpiresAt },
    });
    await this.store.updateDispatch(runId, { state: 'leased', lease_expires_at: leaseExpiresAt, dispatching_at: null });
    return { lease_expires_at: leaseExpiresAt };
  }

  async nack(nodeId: string, runId: string): Promise<{ released: true }> {
    const row = await this.requireRow(runId);
    if (row.node_id === nodeId && row.state === 'queued') {
      await this.store.updateDispatch(runId, { node_id: null, dispatching_at: null });
    }
    return { released: true };
  }

  async started(nodeId: string, runId: string): Promise<{ started: true; lease_expires_at: string }> {
    const row = await this.requireRow(runId);
    const state = this.runStateOf(runId);
    if (state !== null && TERMINAL_RUN_STATES.has(state)) {
      throw new NodeApiError(409, 'terminal_state', `Run 已终态（${state}）`, { reason: 'terminal_state', run_id: runId, status: state });
    }
    if (row.state === 'running' && row.node_id === nodeId && row.lease_expires_at) {
      return { started: true, lease_expires_at: row.lease_expires_at };
    }
    if (row.state !== 'leased' || row.node_id !== nodeId || state !== 'leased') {
      throw new NodeApiError(409, 'precondition_unmet', 'Run 未处于本节点租约中', { reason: 'precondition_unmet', run_id: runId });
    }
    const leaseExpiresAt = new Date(Date.now() + this.config.leaseDurationSec * 1000).toISOString();
    await this.transitionRun(row, {
      type: 'RunStarted',
      from: 'leased',
      to: 'running',
      facts: {},
      payload: { run_id: runId, started_by: nodeId },
    });
    await this.store.updateDispatch(runId, { state: 'running', heartbeat_at: new Date().toISOString(), lease_expires_at: leaseExpiresAt });
    return { started: true, lease_expires_at: leaseExpiresAt };
  }

  async runHeartbeat(nodeId: string, runId: string): Promise<{ lease_expires_at: string }> {
    const row = await this.requireRow(runId);
    if (row.node_id !== nodeId || (row.state !== 'leased' && row.state !== 'running')) {
      throw new NodeApiError(409, 'precondition_unmet', 'Run 不在本节点执行中', { reason: 'precondition_unmet', run_id: runId });
    }
    const leaseExpiresAt = new Date(Date.now() + this.config.leaseDurationSec * 1000).toISOString();
    await this.store.updateDispatch(runId, { heartbeat_at: new Date().toISOString(), lease_expires_at: leaseExpiresAt });
    return { lease_expires_at: leaseExpiresAt };
  }

  /** Outcome 流共用段（与 feedback_submit / 裁决 executed 同形状）：
   * interpretFeedback 提议 → OutcomeRecorded。返回 outcome_id。 */
  private async recordOutcome(row: DispatchRow, summary: string, proposalId: string): Promise<string> {
    const snapshot = this.projections.snapshot();
    const task = snapshot.tasks.find((t) => t.task_id === row.task_id);
    const { draft, meta } = await this.proposer.interpretFeedback({
      taskTitle: task?.title ?? row.task_id,
      feedback: summary,
      criteria: task?.acceptance_criteria ?? [],
    });
    const outcomeId = `out_${ulid()}`;
    await this.events.append({
      ...this.base(row.project_id),
      type: 'OutcomeRecorded',
      idempotency_key: this.opKey('outcome', row.run_id),
      payload: {
        outcome_id: outcomeId,
        task_id: row.task_id,
        run_id: row.run_id,
        feedback_id: null,
        conclusion_kind: draft.conclusion_kind,
        info_obtained: draft.info_obtained,
        certainty: draft.certainty,
        evidence_sufficiency: draft.evidence_sufficiency,
        blockers: draft.blockers,
        followup_suggestions: draft.followup_suggestions,
        interpreted_by: meta.degraded ? 'outcome_interpreter:fallback' : `outcome_interpreter:${meta.model}`,
        proposal_id: proposalId,
      },
    });
    await this.projections.refresh();
    return outcomeId;
  }

  private async completeTaskAfterOutcome(row: DispatchRow, outcomeId: string): Promise<void> {
    const task = this.projections.snapshot().tasks.find((t) => t.task_id === row.task_id);
    if (!task || task.lifecycle !== 'active') return;
    const key = this.opKey('lc', row.run_id);
    await this.events.appendStateTransition({
      ...this.base(row.project_id),
      type: 'TaskLifecycleChanged',
      entity: 'task',
      idempotency_key: key,
      trigger_event_id: `${key}:trigger`,
      from: 'active',
      to: 'awaiting_acceptance',
      facts: { runOutcomeRecorded: true } as never,
      payload: { task_id: row.task_id, outcome_id: outcomeId },
    });
    await this.projections.refresh();
  }

  async rawResult(
    nodeId: string,
    runId: string,
    input: { client_result_id: string; outcome_hint?: string; raw_result_ref?: string; summary: string },
  ): Promise<Record<string, unknown>> {
    if (typeof input.client_result_id !== 'string' || input.client_result_id === '') {
      throw new NodeApiError(400, 'schema_invalid', 'client_result_id 必填', { field: 'client_result_id' });
    }
    if (typeof input.summary !== 'string') {
      throw new NodeApiError(400, 'schema_invalid', 'summary 必填', { field: 'summary' });
    }
    const stored = await this.store.storedResult(runId, 'raw_result', input.client_result_id);
    if (stored) return stored;
    const row = await this.requireRow(runId);
    if (row.node_id !== nodeId) {
      throw new NodeApiError(409, 'precondition_unmet', 'Run 不归本节点回报', { reason: 'precondition_unmet', run_id: runId });
    }
    const state = this.runStateOf(runId);
    if (state !== null && TERMINAL_RUN_STATES.has(state)) {
      throw new NodeApiError(409, 'terminal_state', `Run 已终态（${state}）`, { reason: 'terminal_state', run_id: runId, status: state });
    }
    if (row.state !== 'running' || state !== 'running') {
      throw new NodeApiError(409, 'precondition_unmet', 'Run 未在运行中，不能回报结果', { reason: 'precondition_unmet', run_id: runId });
    }
    await this.appendToRun(row, {
      type: 'RunRawResultReceived',
      payload: {
        run_id: runId,
        node_id: nodeId,
        client_result_id: input.client_result_id,
        raw_result_ref: input.raw_result_ref ?? null,
        summary: input.summary,
        outcome_hint: input.outcome_hint ?? null,
      },
    });
    let result: Record<string, unknown>;
    if (input.outcome_hint === 'failed') {
      await this.appendToRun(row, { type: 'RunFailed', payload: { run_id: runId, reason: 'executor_reported_failure' } });
      result = { run_state: 'failed', outcome_id: null };
    } else {
      const outcomeId = await this.recordOutcome(row, input.summary, `pc_raw_${input.client_result_id}`);
      await this.appendToRun(row, { type: 'RunSucceeded', payload: { run_id: runId, outcome_id: outcomeId } });
      await this.completeTaskAfterOutcome(row, outcomeId);
      result = { run_state: 'succeeded', outcome_id: outcomeId };
    }
    await this.store.storeResult(runId, 'raw_result', input.client_result_id, result);
    await this.store.updateDispatch(runId, { state: 'done', state_reason: null });
    await this.projections.refresh();
    return result;
  }

  async cancelConfirmed(nodeId: string, runId: string): Promise<Record<string, unknown>> {
    const row = await this.requireRow(runId);
    const state = this.runStateOf(runId);
    if (state !== null && TERMINAL_RUN_STATES.has(state)) {
      return { already_terminal: true, status: state };
    }
    if (row.node_id !== nodeId || !row.cancel_requested) {
      throw new NodeApiError(409, 'precondition_unmet', '该 Run 无待确认的取消请求或不归本节点', { reason: 'precondition_unmet', run_id: runId });
    }
    if (state !== 'leased' && state !== 'running') {
      throw new NodeApiError(409, 'precondition_unmet', `Run 状态 ${state ?? 'unknown'} 不可取消确认`, { reason: 'precondition_unmet', run_id: runId });
    }
    const { emitted } = await this.transitionRun(row, {
      type: 'RunCanceled',
      from: state,
      to: 'canceled',
      facts: { cancellationRequested: true, cancelAcknowledged: true },
      payload: { run_id: runId, confirmed_by: nodeId },
    });
    void emitted;
    await this.store.updateDispatch(runId, { state: 'done', cancel_requested: false });
    // REQ-RUN-6 第③步：Task 挂起取消且其余 Run 全终态 → 推进落账。
    await this.completePendingTaskCancel(row);
    await this.projections.refresh();
    return { canceled: true };
  }

  private async completePendingTaskCancel(row: DispatchRow): Promise<void> {
    const snapshot = this.projections.snapshot();
    const task = snapshot.tasks.find((t) => t.task_id === row.task_id);
    if (!task?.cancel_requested_by) return;
    const othersActive = snapshot.runs.some(
      (r) => r.task_id === row.task_id && r.run_id !== row.run_id && !TERMINAL_RUN_STATES.has(r.state),
    );
    if (othersActive) return;
    const key = this.opKey('cancel-step3', row.run_id);
    const base = this.base(row.project_id);
    const wcs = snapshot.wait_conditions.filter((w) => w.task_id === row.task_id && w.status === 'active');
    for (const wc of wcs) {
      await this.events.append({
        ...base,
        type: 'WaitConditionCanceled',
        payload: { wait_condition_id: wc.wait_condition_id, task_id: row.task_id, reason: 'task_canceled' },
        idempotency_key: `${key}:wc-${wc.wait_condition_id}`,
      });
    }
    if (task.wait_state !== 'none') {
      await this.events.append({
        ...base,
        type: 'TaskWaitStateChanged',
        payload: { task_id: row.task_id, from: task.wait_state, to: 'none', reason: 'task_canceled (INV-11)' },
        idempotency_key: `${key}:ws`,
      });
    }
    await this.events.appendStateTransition({
      ...base,
      type: 'TaskLifecycleChanged',
      entity: 'task',
      idempotency_key: `${key}:lc`,
      trigger_event_id: `${key}:lc:trigger`,
      from: task.lifecycle,
      to: 'canceled' as never,
      facts: { cancelRequested: true, runsTerminated: true } as never,
      payload: { task_id: row.task_id },
    });
  }

  async sideEffectNote(
    nodeId: string,
    runId: string,
    input: { tool_name: string; note: string; client_note_id: string },
  ): Promise<Record<string, unknown>> {
    if (typeof input.client_note_id !== 'string' || input.client_note_id === '') {
      throw new NodeApiError(400, 'schema_invalid', 'client_note_id 必填', { field: 'client_note_id' });
    }
    const stored = await this.store.storedResult(runId, 'side_effect', input.client_note_id);
    if (stored) return stored;
    const row = await this.requireRow(runId);
    if (row.node_id !== nodeId) {
      throw new NodeApiError(409, 'precondition_unmet', 'Run 不归本节点', { reason: 'precondition_unmet', run_id: runId });
    }
    await this.appendToRun(row, {
      type: 'RunSideEffectRecorded',
      payload: {
        run_id: runId,
        node_id: nodeId,
        tool_name: input.tool_name,
        note: input.note,
        client_note_id: input.client_note_id,
        recorded_at: new Date().toISOString(),
      },
    });
    const result = { recorded: true };
    await this.store.storeResult(runId, 'side_effect', input.client_note_id, result);
    await this.store.updateDispatch(runId, { side_effect_noted: true });
    return result;
  }

  async probeResult(
    nodeId: string,
    runId: string,
    input: { idempotency_key: string; result: string; summary?: string; raw_result_ref?: string },
  ): Promise<Record<string, unknown>> {
    if (typeof input.idempotency_key !== 'string' || input.idempotency_key === '') {
      throw new NodeApiError(400, 'schema_invalid', 'idempotency_key 必填', { field: 'idempotency_key' });
    }
    if (input.result !== 'executed' && input.result !== 'not_executed' && input.result !== 'unknown') {
      throw new NodeApiError(400, 'schema_invalid', 'result 必须是 executed / not_executed / unknown', { field: 'result' });
    }
    const stored = await this.store.storedResult(runId, 'probe', input.idempotency_key);
    if (stored) return stored;
    const row = await this.requireRow(runId);
    const state = this.runStateOf(runId);
    if (state !== null && TERMINAL_RUN_STATES.has(state)) {
      throw new NodeApiError(409, 'terminal_state', `Run 已终态（${state}）`, { reason: 'terminal_state', run_id: runId, status: state });
    }
    if (row.node_id !== nodeId || row.state !== 'indeterminate' || state !== 'indeterminate' || row.probe_disposed) {
      throw new NodeApiError(409, 'precondition_unmet', 'Run 不处于待本节点对账状态', { reason: 'precondition_unmet', run_id: runId });
    }
    let result: Record<string, unknown>;
    if (input.result === 'executed') {
      const outcomeId = await this.recordOutcome(row, input.summary ?? '节点对账确认：副作用已执行', `pc_probe_${runId}`);
      await this.transitionRun(row, {
        type: 'RunSucceeded',
        from: 'indeterminate',
        to: 'succeeded',
        facts: { reconciliation: 'completed' },
        payload: { run_id: runId, outcome_id: outcomeId },
      });
      await this.completeTaskAfterOutcome(row, outcomeId);
      result = { result: 'executed', outcome_id: outcomeId, run_state: 'succeeded' };
    } else if (input.result === 'not_executed') {
      await this.transitionRun(row, {
        type: 'RunFailed',
        from: 'indeterminate',
        to: 'failed',
        facts: { reconciliation: 'not_executed' },
        payload: { run_id: runId, reason: 'probe_not_executed' },
      });
      result = { result: 'not_executed', run_state: 'failed' };
    } else {
      const decisionId = `dec_probe_${runId}`;
      await this.events.append({
        ...this.base(row.project_id),
        type: 'DecisionCreated',
        idempotency_key: this.opKey('probe-decision', runId),
        payload: {
          decision_id: decisionId,
          project_id: row.project_id,
          subject_ref: { kind: 'run_reconciliation', id: runId },
          question: `Run ${runId} 心跳丢失后节点对账仍无法判定是否执行，请裁决处置方式`,
          recommendation: 'cancel_run',
          alternatives: ['executed', 'not_executed', 'cancel_run'],
          evidence_refs: [],
          wake_condition: null,
          expires_at: null,
        },
      });
      result = { result: 'unknown', decision_id: decisionId };
    }
    await this.store.storeResult(runId, 'probe', input.idempotency_key, result);
    await this.store.updateDispatch(runId, { probe_disposed: true, state: input.result === 'unknown' ? 'indeterminate' : 'done' });
    await this.projections.refresh();
    return result;
  }

  // ---------- 用户面 ----------

  async listNodesView(): Promise<Array<Record<string, unknown>>> {
    await this.projections.refresh();
    await this.syncFromProjection();
    const rows = await this.store.listDispatch();
    const nowMs = Date.now();
    return (await this.store.listNodes()).map((n) => ({
      node_id: n.node_id,
      display_name: n.display_name,
      executor_kinds: n.executor_kinds,
      max_side_effect_level: n.max_side_effect_level,
      agent_version: n.agent_version,
      status: nodeStatusOf(n, nowMs, this.config),
      registered_at: n.registered_at,
      last_heartbeat_at: n.last_heartbeat_at,
      deregistered: n.deregistered_at !== null,
      active_runs: rows.filter((r) => r.node_id === n.node_id && r.state !== 'done').length,
    }));
  }
}
