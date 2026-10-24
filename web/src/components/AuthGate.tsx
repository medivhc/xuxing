// K1-C 前端入口门（K1-SPEC v0.4 §5.4）：
// - 启动先查 GET /api/health（豁免端点）的 auth_enabled；未启用 → 直接放行。
// - 启用时探一次受保护读面：401 → 只渲染令牌输入框（零业务数据、零项目名、
//   零计数，门前 DOM 不出现任何应用内容）；成功 → 进应用。
// - 提交走 POST /api/auth/session 换 HttpOnly cookie；令牌只在输入框 state
//   里短暂停留，提交后即清，绝不写 localStorage/sessionStorage/任何
//   JS 可读持久位置（本组件不 import 任何 storage API）。
// - 使用中途任何请求 401（http 层广播 xuxing:unauthorized）→ 自动回入口门，
//   不白屏、不无限重试；重新提交成功后失效全部查询、按 cookie 重新拉取。

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { ApiError, apiPost, UNAUTHORIZED_EVENT } from '../api/http';

type GateState = 'checking' | 'locked' | 'open';

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>('checking');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const authEnabledRef = useRef(false);
  const queryClient = useQueryClient();

  const probe = useCallback(async () => {
    try {
      const health = await api.health();
      if (!health.auth_enabled) {
        authEnabledRef.current = false;
        setState('open');
        return;
      }
      authEnabledRef.current = true;
      try {
        await api.home();
        setState('open');
      } catch (cause) {
        // 401 = 未登录 → 入口门；其余错误（网络/服务端）不锁门，交给页面自身报错。
        setState(cause instanceof ApiError && cause.status === 401 ? 'locked' : 'open');
      }
    } catch {
      // health 本身不可达：不锁门（页面会呈现连接错误），避免把故障误判成未授权。
      setState('open');
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  useEffect(() => {
    const onUnauthorized = () => {
      if (authEnabledRef.current) setState('locked');
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiPost('/api/auth/session', { token });
      setToken('');
      setState('open');
      await queryClient.invalidateQueries();
    } catch {
      setError('令牌不正确或已失效，请重新输入。');
    } finally {
      setSubmitting(false);
    }
  };

  if (state === 'checking') {
    return (
      <div data-testid="auth-gate-checking" className="flex min-h-screen items-center justify-center bg-canvas">
        <p className="text-body-s text-text-tertiary">加载中…</p>
      </div>
    );
  }

  if (state === 'locked') {
    return (
      <div data-testid="auth-gate" className="flex min-h-screen items-center justify-center bg-canvas px-4">
        <form
          onSubmit={submit}
          className="w-full max-w-sm space-y-4 rounded-m border border-border bg-surface p-6"
        >
          <div>
            <h1 className="text-title-s font-semibold text-text-primary">续行</h1>
            <p className="mt-1 text-body-s text-text-secondary">
              本服务已启用访问控制，请输入访问令牌继续。
            </p>
          </div>
          <label className="block">
            <span className="text-caption text-text-tertiary">访问令牌</span>
            <input
              data-testid="auth-gate-token"
              type="password"
              autoComplete="current-password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="mt-1 w-full rounded-m border border-border bg-canvas px-3 py-2 text-body text-text-primary"
            />
          </label>
          {error ? (
            <p data-testid="auth-gate-error" className="text-body-s text-warning">
              {error}
            </p>
          ) : null}
          <button
            data-testid="auth-gate-submit"
            type="submit"
            disabled={submitting || token.trim() === ''}
            className="min-h-touch w-full rounded-m bg-accent px-3 py-2 text-body-s font-medium text-white disabled:opacity-50"
          >
            {submitting ? '验证中…' : '进入'}
          </button>
        </form>
      </div>
    );
  }

  return <>{children}</>;
}
