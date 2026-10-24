// K1-B §4.3/§4.5：节点注册表与派发状态（PG 运维表，非事件流）。
// 状态权威：节点存活/占用/租约/去重集都只在这里；领域事实（RunLeased /
// RunStarted / 结果 / 探活结论）仍以事件流为准。state_reason 是派发行
// 状态（与内核 Run 的 heartbeat_at/lease_expires_at 非事件字段同先例）。
import type { Pool } from 'pg';

export const LEVEL_RANK: Record<string, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };

export interface NodeRow {
  node_id: string;
  display_name: string;
  executor_kinds: string[];
  max_side_effect_level: string;
  agent_version: string | null;
  registered_at: string;
  last_heartbeat_at: string;
  deregistered_at: string | null;
  offline_notified: boolean;
}

export interface DispatchRow {
  run_id: string;
  project_id: string;
  task_id: string;
  node_id: string | null;
  state: 'queued' | 'leased' | 'running' | 'indeterminate' | 'done';
  dispatching_at: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  state_reason: string | null;
  cancel_requested: boolean;
  probe_disposed: boolean;
  side_effect_noted: boolean;
}

const DDL = `
CREATE TABLE IF NOT EXISTS node_agents (
  node_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  executor_kinds JSONB NOT NULL DEFAULT '[]'::jsonb,
  max_side_effect_level TEXT NOT NULL DEFAULT 'L1',
  agent_version TEXT,
  registered_at TIMESTAMPTZ NOT NULL,
  last_heartbeat_at TIMESTAMPTZ NOT NULL,
  deregistered_at TIMESTAMPTZ,
  offline_notified BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS run_dispatch (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  node_id TEXT,
  state TEXT NOT NULL DEFAULT 'queued',
  dispatching_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  state_reason TEXT,
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  probe_disposed BOOLEAN NOT NULL DEFAULT false,
  side_effect_noted BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS dispatch_results (
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  client_key TEXT NOT NULL,
  result JSONB NOT NULL,
  PRIMARY KEY (run_id, kind, client_key)
);
`;

export async function migrateNodeTables(pool: Pool): Promise<void> {
  await pool.query(DDL);
}

/** pg 驱动把 TIMESTAMPTZ 读成 Date；统一归一为 ISO 字符串（事件 payload
 * 只接受 plain 值，Date 会被内核规范化拒绝）。 */
function normalizeRow<T>(row: T): T {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const [k, v] of Object.entries(out)) {
    if (v instanceof Date) out[k] = v.toISOString();
  }
  return out as T;
}

export class NodeStore {
  constructor(private readonly pool: Pool) {}

  async getNode(nodeId: string): Promise<NodeRow | null> {
    const r = await this.pool.query<NodeRow>('SELECT * FROM node_agents WHERE node_id=$1', [nodeId]);
    return r.rows[0] ? normalizeRow(r.rows[0]) : null;
  }

  async listNodes(): Promise<NodeRow[]> {
    const r = await this.pool.query<NodeRow>('SELECT * FROM node_agents ORDER BY registered_at, node_id');
    return r.rows.map((row) => normalizeRow(row));
  }

  async insertNode(node: Omit<NodeRow, 'deregistered_at' | 'offline_notified'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO node_agents (node_id, display_name, executor_kinds, max_side_effect_level, agent_version, registered_at, last_heartbeat_at)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7)`,
      [
        node.node_id,
        node.display_name,
        JSON.stringify(node.executor_kinds),
        node.max_side_effect_level,
        node.agent_version,
        node.registered_at,
        node.last_heartbeat_at,
      ],
    );
  }

  async updateNodeRegistration(nodeId: string, patch: Partial<NodeRow>): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (col: string, v: unknown) => {
      values.push(v);
      sets.push(`${col}=$${values.length}`);
    };
    if (patch.display_name !== undefined) push('display_name', patch.display_name);
    if (patch.executor_kinds !== undefined) push('executor_kinds', JSON.stringify(patch.executor_kinds));
    if (patch.max_side_effect_level !== undefined) push('max_side_effect_level', patch.max_side_effect_level);
    if (patch.agent_version !== undefined) push('agent_version', patch.agent_version);
    if (patch.last_heartbeat_at !== undefined) push('last_heartbeat_at', patch.last_heartbeat_at);
    if (patch.deregistered_at !== undefined) push('deregistered_at', patch.deregistered_at);
    if (patch.offline_notified !== undefined) push('offline_notified', patch.offline_notified);
    if (sets.length === 0) return;
    values.push(nodeId);
    await this.pool.query(`UPDATE node_agents SET ${sets.join(', ')} WHERE node_id=$${values.length}`, values);
  }

  async getDispatch(runId: string): Promise<DispatchRow | null> {
    const r = await this.pool.query<DispatchRow>('SELECT * FROM run_dispatch WHERE run_id=$1', [runId]);
    return r.rows[0] ? normalizeRow(r.rows[0]) : null;
  }

  async listDispatch(): Promise<DispatchRow[]> {
    const r = await this.pool.query<DispatchRow>('SELECT * FROM run_dispatch ORDER BY run_id');
    return r.rows.map((row) => normalizeRow(row));
  }

  async insertDispatch(row: { run_id: string; project_id: string; task_id: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO run_dispatch (run_id, project_id, task_id) VALUES ($1,$2,$3) ON CONFLICT (run_id) DO NOTHING`,
      [row.run_id, row.project_id, row.task_id],
    );
  }

  async updateDispatch(runId: string, patch: Partial<DispatchRow>): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (col: string, v: unknown) => {
      values.push(v);
      sets.push(`${col}=$${values.length}`);
    };
    for (const col of ['node_id', 'state', 'dispatching_at', 'lease_expires_at', 'heartbeat_at', 'state_reason', 'cancel_requested', 'probe_disposed', 'side_effect_noted'] as const) {
      if (patch[col] !== undefined) push(col, patch[col]);
    }
    if (sets.length === 0) return;
    values.push(runId);
    await this.pool.query(`UPDATE run_dispatch SET ${sets.join(', ')} WHERE run_id=$${values.length}`, values);
  }

  async storedResult(runId: string, kind: string, clientKey: string): Promise<Record<string, unknown> | null> {
    const r = await this.pool.query<{ result: Record<string, unknown> }>(
      'SELECT result FROM dispatch_results WHERE run_id=$1 AND kind=$2 AND client_key=$3',
      [runId, kind, clientKey],
    );
    return r.rows[0]?.result ?? null;
  }

  async storeResult(runId: string, kind: string, clientKey: string, result: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `INSERT INTO dispatch_results (run_id, kind, client_key, result) VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (run_id, kind, client_key) DO NOTHING`,
      [runId, kind, clientKey, JSON.stringify(result)],
    );
  }
}
