// 反馈态组件族：骨架、错误条（含 409 原样呈现）、空态、pending 按钮。
// 契约口径：409 原因原样呈现不绕过（§0.5/§0.6）；网络失败走「结果待确认」（§0.7）；
// 禁用必须给原因（§0.4）。

import { ApiError, CommandConflictError, NetworkError } from '../api/http';

export function Skeleton({ lines = 3, testId }: { lines?: number; testId?: string }) {
  return (
    <div data-testid={testId ?? 'skeleton'} className="animate-pulse space-y-3" aria-busy="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="h-4 rounded-s bg-subtle" style={{ width: `${100 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function ErrorBanner({
  error,
  onRetry,
  className = '',
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  if (!error) return null;

  if (error instanceof CommandConflictError) {
    return (
      <div
        data-testid="error-conflict"
        role="alert"
        className={`rounded-m border border-danger/30 bg-danger-subtle p-4 ${className}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-body-s font-medium text-danger">
              冲突：{error.message}
            </p>
            <p className="mt-1 text-caption text-text-secondary">
              最新投影已展示；未执行你的操作。如需继续，请按当前状态重新选择动作。
            </p>
            {error.detail ? (
              <dl className="mt-2 space-y-0.5">
                {Object.entries(error.detail).map(([key, value]) => (
                  <div key={key} className="flex gap-2 text-mono text-caption text-text-secondary">
                    <dt className="text-text-tertiary">{key}</dt>
                    <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
          <span className="shrink-0 rounded-s bg-surface px-2 py-0.5 text-mono text-caption text-danger">
            409 {error.code}
          </span>
        </div>
      </div>
    );
  }

  if (error instanceof NetworkError) {
    return (
      <div
        data-testid="error-network"
        role="alert"
        className={`rounded-m border border-warning/30 bg-warning-subtle p-4 ${className}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-body-s font-medium text-warning">结果待确认</p>
            <p className="mt-1 text-body-s text-text-secondary">
              请求未完成（网络中断或超时）。重试将复用同一 client_submit_id，不会重复入账；
              以投影最终状态为准。
            </p>
          </div>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="min-h-touch shrink-0 rounded-m bg-accent px-4 text-body-s font-medium text-white transition-colors duration-[var(--motion-feedback)] hover:bg-accent-hover"
            >
              重试
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  if (error instanceof ApiError) {
    return (
      <div
        data-testid="error-api"
        role="alert"
        className={`rounded-m border border-danger/30 bg-danger-subtle p-4 ${className}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-body-s font-medium text-danger">{error.message}</p>
            {error.detail ? (
              <p className="mt-1 text-mono text-caption text-text-secondary">
                {Object.entries(error.detail)
                  .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
                  .join(' ')}
              </p>
            ) : null}
          </div>
          <span className="shrink-0 rounded-s bg-surface px-2 py-0.5 text-mono text-caption text-danger">
            {error.status} {error.code}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="error-unknown"
      role="alert"
      className={`rounded-m border border-danger/30 bg-danger-subtle p-4 ${className}`}
    >
      <p className="text-body-s font-medium text-danger">发生未知错误</p>
      <p className="mt-1 text-body-s text-text-secondary">
        {error instanceof Error ? error.message : String(error)}
      </p>
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
  testId = 'empty-state',
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="rounded-m border border-border bg-surface p-8 text-center shadow-1"
    >
      <p className="text-title-s font-semibold text-text-primary">{title}</p>
      {hint ? <p className="mx-auto mt-2 max-w-prose text-body-s text-text-secondary">{hint}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function PendingButton({
  pending,
  children,
  onClick,
  variant = 'primary',
  disabled,
  testId,
  type = 'button',
}: {
  pending?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  testId?: string;
  type?: 'button' | 'submit';
}) {
  const variantClass =
    variant === 'primary'
      ? 'bg-accent text-white hover:bg-accent-hover'
      : variant === 'danger'
        ? 'bg-danger text-white hover:bg-danger/90'
        : 'border border-border-strong bg-surface text-text-primary hover:bg-subtle';
  return (
    <button
      type={type}
      data-testid={testId}
      onClick={onClick}
      disabled={disabled || pending}
      aria-busy={pending ? 'true' : undefined}
      className={[
        'inline-flex min-h-touch items-center justify-center gap-2 rounded-m px-4 text-body-s font-medium',
        'transition-colors duration-[var(--motion-feedback)]',
        'disabled:cursor-not-allowed disabled:opacity-60',
        variantClass,
      ].join(' ')}
    >
      {pending ? (
        <>
          <span
            aria-hidden="true"
            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          处理中…
        </>
      ) : (
        children
      )}
    </button>
  );
}
