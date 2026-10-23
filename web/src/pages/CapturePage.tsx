// Capture（POST /api/capture，契约 §3 C-*）：一次请求回执，区分
// 「已记录，整理中」（无 proposal_id）与「已成提议」（跳转提议页）。
// 离线/网络失败走 P 层传输缓冲（OQ-07=A）：本地先行落盘显示「已记录（待同步）」，
// 恢复后重放（复用 client_submit_id），同步失败不回滚、只更新状态（REQ-FB-2）。

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCapture } from '../features/capture/use-capture';
import { NetworkError } from '../api/http';
import { ErrorBanner, PendingButton } from '../components/Feedback';
import { formatRelative } from '../lib/time';

const SYNC_LABEL: Record<string, string> = {
  pending: '待同步',
  syncing: '同步中',
  failed: '同步失败',
  synced: '已同步',
};

export function CapturePage() {
  const [text, setText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const { submit, pending, error, outbox, replaying } = useCapture();
  const navigate = useNavigate();

  const onSubmit = async () => {
    if (text.trim() === '' || pending) return;
    setNotice(null);
    try {
      const outcome = await submit(text);
      if (outcome.kind === 'proposal' && outcome.proposalId) {
        navigate(`/capture/${outcome.proposalId}`);
        return;
      }
      setNotice(`已记录（capture_id: ${outcome.captureId}），整理中…`);
      setText('');
    } catch (cause) {
      if (cause instanceof NetworkError) {
        setNotice('已记录（待同步）：网络不可用，内容已入本地传输缓冲，恢复后自动重放。');
        setText('');
      }
      // 其余错误的呈现交给 ErrorBanner（error 状态）
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-title font-semibold text-text-primary">快速捕获</h1>
      </header>

      <section className="rounded-m border border-border bg-surface p-5 shadow-1">
        <label htmlFor="capture-input" className="text-body-s font-medium text-text-primary">
          记录想法、反馈或待办
        </label>
        <textarea
          id="capture-input"
          data-testid="capture-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          className="mt-2 w-full rounded-m border border-border-strong bg-surface px-3 py-2 text-body text-text-primary outline-none transition-colors duration-[var(--motion-feedback)] focus:border-accent"
          placeholder="例如：把发布检查清单补上回滚口令一栏…"
        />
        <div className="mt-3 flex items-center gap-3">
          <PendingButton
            pending={pending}
            onClick={() => void onSubmit()}
            disabled={text.trim() === ''}
            testId="capture-submit"
          >
            提交捕获
          </PendingButton>
          <span className="text-caption text-text-tertiary">
            提交后生成任务提议；降级提议会明示，需人工确认。
          </span>
        </div>
      </section>

      {notice ? (
        <p
          data-testid="capture-notice"
          role="status"
          className="rounded-m border border-info/30 bg-info-subtle p-4 text-body-s text-info"
        >
          {notice}
        </p>
      ) : null}

      <ErrorBanner error={error} />

      <section aria-label="传输缓冲" className="rounded-m border border-border bg-surface p-5 shadow-1">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-title-s font-semibold text-text-primary">传输缓冲</h2>
          {replaying ? (
            <span data-testid="outbox-replaying" className="text-caption text-warning">
              正在重放…
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-caption text-text-tertiary">
          P 层传输缓冲（append-only）：仅 Capture 离线「已记录（待同步）」；按 client_submit_id
          幂等重放，不同步 Task 结论。
        </p>
        {outbox.length === 0 ? (
          <p className="mt-3 text-body-s text-text-secondary">缓冲为空。</p>
        ) : (
          <ul data-testid="outbox-list" className="mt-3 space-y-2">
            {outbox.map((entry) => (
              <li
                key={entry.client_submit_id}
                data-testid="outbox-entry"
                data-sync-state={entry.sync_state}
                className="flex items-start justify-between gap-3 rounded-m border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-body-s text-text-primary">{entry.text}</p>
                  <p className="mt-0.5 text-mono text-caption text-text-tertiary">
                    {entry.client_submit_id} · {formatRelative(entry.created_at)}
                    {entry.last_error ? ` · ${entry.last_error}` : ''}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-s px-2 py-0.5 text-caption font-medium ${
                    entry.sync_state === 'failed'
                      ? 'bg-danger-subtle text-danger'
                      : entry.sync_state === 'synced'
                        ? 'bg-success-subtle text-success'
                        : 'bg-warning-subtle text-warning'
                  }`}
                >
                  {SYNC_LABEL[entry.sync_state] ?? entry.sync_state}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-caption text-text-tertiary">
        捕获内容将进入「反馈入账 → 解释 → 提议」链路（OQ-01=A），提议在{' '}
        <Link to="/actions" className="text-accent hover:underline">
          待我处理
        </Link>{' '}
        与项目页可见。
      </p>
    </div>
  );
}
