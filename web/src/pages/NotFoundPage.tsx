// 404 页（契约 §8 路由兜底）。

import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="rounded-m border border-border bg-surface p-8 text-center shadow-1">
      <h1 className="text-title font-semibold text-text-primary">页面不存在</h1>
      <p className="mt-2 text-body-s text-text-secondary">
        你访问的地址没有对应的入口。四入口为：首页、快速捕获、待我处理、项目。
      </p>
      <Link
        to="/"
        className="mt-4 inline-flex min-h-touch items-center rounded-m bg-accent px-4 text-body-s font-medium text-white transition-colors duration-[var(--motion-feedback)] hover:bg-accent-hover"
      >
        返回首页
      </Link>
    </div>
  );
}
