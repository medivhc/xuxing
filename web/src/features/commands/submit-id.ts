// client_submit_id 生成与复用（契约 §0.5：ULID；重试必须复用同一个值）。
//
// 语义：
// - 「一次用户意图」对应一个幂等键（idemKey，由调用方按语义构造，如
//   `capture` 或 `cmd:task_advance:start:${taskId}`）；
// - 首次提交生成 ULID 并落 localStorage；网络失败/5xx（结果未知）时保留，
//   下次提交复用同一值——服务端按 client_submit_id 去重，避免重复入账；
// - 确定性失败（409 冲突、400 参数错误）后清除，允许用户修正 payload 后
//   以新幂等键重新提交。

import { ulid } from '../../lib/ulid';

const PREFIX = 'xux.submit.';

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // 隐私模式/禁用存储：退化为进程内 Map（刷新丢失，但语义不破）
    return null;
  }
}

const memoryFallback = new Map<string, string>();

export function reuseOrCreateSubmitId(idemKey: string): string {
  const store = storage();
  if (store) {
    const existing = store.getItem(PREFIX + idemKey);
    if (existing) return existing;
    const created = ulid();
    store.setItem(PREFIX + idemKey, created);
    return created;
  }
  const existing = memoryFallback.get(idemKey);
  if (existing) return existing;
  const created = ulid();
  memoryFallback.set(idemKey, created);
  return created;
}

export function peekSubmitId(idemKey: string): string | undefined {
  const store = storage();
  if (store) return store.getItem(PREFIX + idemKey) ?? undefined;
  return memoryFallback.get(idemKey);
}

export function clearSubmitId(idemKey: string): void {
  const store = storage();
  if (store) {
    store.removeItem(PREFIX + idemKey);
    return;
  }
  memoryFallback.delete(idemKey);
}
