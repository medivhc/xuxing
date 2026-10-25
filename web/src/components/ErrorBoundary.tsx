// 顶层渲染错误边界：任何页面渲染期异常（如投影字段缺失导致的 TypeError）
// 只降级为错误占位，绝不整页白屏——2026-10-24 白屏事故的防御层
// （正道修复在服务端补齐契约字段，本组件只是保险，见 WHITESCREEN-FIX-1024）。

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 只留控制台证据；不吞错、不自动重试写操作。
    console.error('ErrorBoundary caught render error:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          data-testid="app-error-boundary"
          role="alert"
          className="mx-auto max-w-content px-4 py-10"
        >
          <div className="rounded-m border border-danger/30 bg-danger-subtle p-5">
            <h1 className="text-title-s font-semibold text-danger">页面出错了</h1>
            <p className="mt-2 text-body-s text-text-secondary">
              渲染时发生异常，已停止展示以免呈现错误数据。错误信息：{this.state.error.message}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 min-h-touch rounded-m border border-border-strong bg-surface px-4 text-body-s text-accent transition-colors duration-[var(--motion-feedback)] hover:bg-subtle"
            >
              重新加载
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
