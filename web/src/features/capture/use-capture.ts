// Capture 提交 hook（契约 §3 / REQ-PJ-3 / REQ-FB-2 / OQ-07=A）：
// - 一次提交 = 一次用户意图：idemKey 按文本构造（`capture:${text}`），
//   首次生成 client_submit_id 落盘；网络失败重试复用同值（服务端去重）；
// - 离线/网络失败：先落 P 层传输缓冲（append-only），界面显示「已记录（待同步）」，
//   不同步不回滚本地显示，只更新同步徽标（REQ-FB-2）；
// - 恢复后重放缓冲条目（复用同一 client_submit_id），成功置 synced；
// - 回执区分「已记录，整理中」（无 proposal_id）与「已成提议」（有 proposal_id）；
// - R-11：捕获/提议链路上不出现 task_id——CaptureResponse 只有 capture_id 与
//   proposal_id；任务 id 只在提议被接受后由服务端新发（登记见
//   web/README.md「已知边界」第 5 条）。

import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { ApiError, NetworkError } from '../../api/http';
import { queryKeys } from '../../api/queryKeys';
import type { CaptureResponse } from '../../api/types';
import { clearSubmitId, reuseOrCreateSubmitId } from '../commands/submit-id';
import {
  appendOutbox,
  loadOutbox,
  replayableEntries,
  updateOutboxState,
  type OutboxEntry,
} from '../commands/outbox';

export type CaptureOutcome =
  | { kind: 'proposal'; captureId: string; proposalId: string }
  | { kind: 'recorded'; captureId: string; proposalId?: string };

export interface UseCaptureResult {
  submit: (text: string) => Promise<CaptureOutcome>;
  pending: boolean;
  error: unknown;
  outbox: OutboxEntry[];
  /** 重放进行中（恢复同步） */
  replaying: boolean;
}

export function useCapture(): UseCaptureResult {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [outbox, setOutbox] = useState<OutboxEntry[]>(() => loadOutbox());
  const [replaying, setReplaying] = useState(false);

  const refreshOutbox = useCallback(() => setOutbox(loadOutbox()), []);

  const post = useCallback(
    async (text: string, clientSubmitId: string): Promise<CaptureResponse> => {
      return api.capture({ text, client_submit_id: clientSubmitId });
    },
    [],
  );

  const submit = useCallback(
    async (text: string): Promise<CaptureOutcome> => {
      const trimmed = text.trim();
      setPending(true);
      setError(null);
      const idemKey = `capture:${trimmed}`;
      const clientSubmitId = reuseOrCreateSubmitId(idemKey);
      try {
        const receipt = await post(trimmed, clientSubmitId);
        clearSubmitId(idemKey);
        // 传输缓冲中同 idemKey 的旧条目（若此前离线入过队）标记 synced
        updateOutboxState(clientSubmitId, 'synced');
        refreshOutbox();
        void queryClient.invalidateQueries({ queryKey: queryKeys.home });
        if (receipt.proposal_id) {
          return { kind: 'proposal', captureId: receipt.capture_id, proposalId: receipt.proposal_id };
        }
        return { kind: 'recorded', captureId: receipt.capture_id };
      } catch (cause) {
        if (cause instanceof NetworkError || (cause instanceof ApiError && cause.retryable)) {
          // 结果未知/离线：落传输缓冲，保留幂等键（重试复用同一 client_submit_id）
          appendOutbox({
            client_submit_id: clientSubmitId,
            text: trimmed,
            created_at: new Date().toISOString(),
            sync_state: 'pending',
            last_error: cause instanceof Error ? cause.message : String(cause),
          });
          refreshOutbox();
          setError(cause);
          throw cause;
        }
        // 确定性失败（400 等）：清除幂等键，允许修正后重提
        clearSubmitId(idemKey);
        setError(cause);
        throw cause;
      } finally {
        setPending(false);
      }
    },
    [post, queryClient, refreshOutbox],
  );

  // 挂载时重放传输缓冲（恢复同步）：复用条目 client_submit_id，服务端去重
  useEffect(() => {
    let cancelled = false;
    const replay = async () => {
      const entries = replayableEntries();
      if (entries.length === 0) return;
      setReplaying(true);
      for (const entry of entries) {
        if (cancelled) break;
        updateOutboxState(entry.client_submit_id, 'syncing');
        refreshOutbox();
        try {
          await post(entry.text, entry.client_submit_id);
          updateOutboxState(entry.client_submit_id, 'synced');
          void queryClient.invalidateQueries({ queryKey: queryKeys.home });
        } catch (cause) {
          updateOutboxState(
            entry.client_submit_id,
            'failed',
            cause instanceof Error ? cause.message : String(cause),
          );
        }
        refreshOutbox();
      }
      if (!cancelled) setReplaying(false);
    };
    void replay();
    return () => {
      cancelled = true;
    };
  }, [post, queryClient, refreshOutbox]);

  return { submit, pending, error, outbox, replaying };
}
