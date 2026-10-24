// P 层传输缓冲（契约 §0.3 / OQ-07=A；M2 起由「outbox」改称「传输缓冲」）。
//
// 口径（docs/interaction-contract.md）：
// - append-only 客户端投影：{ client_submit_id, text, created_at, sync_state }；
// - 按 client_submit_id 幂等、可重放；条目携带 client_submit_id 使服务端
//   FeedbackReceived 回执可关联审计；
// - 只支撑 C-LOCAL（Capture/Feedback 离线「已记录（待同步）」），不支撑任何
//   Task 结论，也禁止被 available_actions 与内核判定消费；
// - 同步失败不回滚本地已记录显示，只更新同步徽标状态。
//
// K0 落地：仅 Capture 走传输缓冲（命令有 202 回执，§0.5 幂等键另管）。

export type OutboxSyncState = 'pending' | 'syncing' | 'failed' | 'synced';

export interface OutboxEntry {
  client_submit_id: string;
  text: string;
  created_at: string;
  sync_state: OutboxSyncState;
  last_error?: string;
}

const STORAGE_KEY = 'xux.outbox.v1';

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readRaw(): OutboxEntry[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is OutboxEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as OutboxEntry).client_submit_id === 'string' &&
        typeof (entry as OutboxEntry).text === 'string' &&
        typeof (entry as OutboxEntry).created_at === 'string' &&
        typeof (entry as OutboxEntry).sync_state === 'string',
    );
  } catch {
    return [];
  }
}

function writeRaw(entries: OutboxEntry[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // 配额溢出：丢弃最旧的 synced 条目后重试一次
    const trimmed = entries.filter((e) => e.sync_state !== 'synced').slice(-50);
    try {
      store.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      // 仍失败：放弃持久化（内存态照常工作）
    }
  }
}

export function loadOutbox(): OutboxEntry[] {
  return readRaw();
}

/** append-only：同 client_submit_id 只入队一次（幂等）。 */
export function appendOutbox(entry: OutboxEntry): void {
  const entries = readRaw();
  if (entries.some((e) => e.client_submit_id === entry.client_submit_id)) return;
  entries.push(entry);
  writeRaw(entries);
}

export function updateOutboxState(
  clientSubmitId: string,
  state: OutboxSyncState,
  lastError?: string,
): void {
  const entries = readRaw();
  let touched = false;
  for (const entry of entries) {
    if (entry.client_submit_id !== clientSubmitId) continue;
    entry.sync_state = state;
    if (lastError !== undefined) entry.last_error = lastError;
    touched = true;
  }
  if (touched) writeRaw(entries);
}

/** 待重放：pending + failed（syncing 是崩溃前残留，也允许重放——幂等键保证不重复入账）。 */
export function replayableEntries(): OutboxEntry[] {
  return readRaw().filter((e) => e.sync_state !== 'synced');
}
