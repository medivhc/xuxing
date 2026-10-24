// Home（GET /api/home，契约 §2.1 H-*）：跨项目聚合入口，纯投影只读
// （OQ-05=B：项目/目标由种子/CLI 创建，本页不提供创建写动作）。
// 不制造待办：attention 为空时只展示项目与活动（REQ-PJ-1）。

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
import type { AttentionItem } from '../api/types';
import { formatRelative } from '../lib/time';
import { EmptyState, ErrorBanner, Skeleton } from '../components/Feedback';
import { SyncBadge } from '../components/Badge';
import { ProjectCard } from '../components/ProjectCard';

const ATTENTION_LABEL: Record<AttentionItem['kind'], string> = {
  decision_pending: '待裁决决策',
  acceptance_due: '待验收任务',
  run_indeterminate: '执行状态待确认',
  duplicate_suspect: '疑似重复',
  wait_expired: '等待已过期',
  cancel_pending: '取消待确认',
};

function AttentionRow({ item }: { item: AttentionItem }) {
  // decision_pending 落点裁决（FIX-ROUND-3）：resolve_decision 已下线（K1 契约
  // 缺口），/actions 里没有可操作项，不再把用户往死路引——改跳其所属项目页；
  // 其余 kind 维持原落点（带 task_id 的跳项目页）。
  const target =
    item.kind === 'decision_pending'
      ? `/projects/${item.project_id}`
      : item.task_id
        ? `/projects/${item.project_id}`
        : '/';
  return (
    <li
      data-testid="home-attention-row"
      data-kind={item.kind}
      className="flex items-center justify-between gap-3 rounded-m border border-border bg-surface px-4 py-3"
    >
      <div className="min-w-0">
        <p className="text-body-s font-medium text-text-primary">{ATTENTION_LABEL[item.kind]}</p>
        <p className="mt-0.5 text-mono text-caption text-text-tertiary">
          {item.task_id ?? item.decision_id ?? item.project_id}
        </p>
      </div>
      <Link
        to={target}
        className="shrink-0 rounded-m border border-border-strong bg-surface px-3 py-1.5 text-body-s text-accent transition-colors duration-[var(--motion-feedback)] hover:bg-subtle"
      >
        前往处理
      </Link>
    </li>
  );
}

export function HomePage() {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.home,
    queryFn: (ctx) => api.home(ctx.signal),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton lines={2} testId="home-skeleton" />
        <Skeleton lines={4} />
      </div>
    );
  }

  if (error) {
    return <ErrorBanner error={error} className="mb-4" />;
  }

  if (!data || data.projects.length === 0) {
    return (
      <div className="space-y-4">
        <PageHeader />
        <EmptyState
          testId="home-empty"
          title="还没有项目"
          hint="项目与目标由种子数据或 CLI 创建。你可以先用「快速捕获」记录第一条反馈。"
          action={
            <Link
              to="/capture"
              className="inline-flex min-h-touch items-center rounded-m bg-accent px-4 text-body-s font-medium text-white transition-colors duration-[var(--motion-feedback)] hover:bg-accent-hover"
            >
              去捕获
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader meta={data} />

      <section aria-label="项目" className="grid gap-4 tablet:grid-cols-2">
        {data.projects.map((project) => (
          <ProjectCard key={project.project_id} project={project} />
        ))}
      </section>

      <section aria-label="需要关注">
        <h2 className="mb-2 text-title-s font-semibold text-text-primary">需要关注</h2>
        {(data.attention ?? []).length === 0 ? (
          <p className="rounded-m border border-border bg-surface px-4 py-3 text-body-s text-text-secondary">
            暂无需要关注的事项。
          </p>
        ) : (
          <ul className="space-y-2">
            {[...(data.attention ?? [])]
              .sort((a, b) => a.rank - b.rank)
              .map((item) => (
                <AttentionRow key={item.attention_id} item={item} />
              ))}
          </ul>
        )}
      </section>

      <section aria-label="最近活动">
        <h2 className="mb-2 text-title-s font-semibold text-text-primary">最近活动</h2>
        {data.recent.length === 0 ? (
          <p className="text-body-s text-text-tertiary">暂无最近活动。</p>
        ) : (
          <ul data-testid="home-recent" className="space-y-1">
            {data.recent.map((activity) => (
              <li
                key={activity.event_id}
                className="flex items-baseline justify-between gap-3 rounded-m px-2 py-1.5 text-body-s"
              >
                <span className="min-w-0 truncate text-text-secondary">{activity.summary}</span>
                <span className="shrink-0 text-caption text-text-tertiary">
                  {formatRelative(activity.occurred_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PageHeader({ meta }: { meta?: { projection_version: number } }) {
  return (
    <header className="flex items-center justify-between gap-3">
      <h1 className="text-title font-semibold text-text-primary">首页</h1>
      <SyncBadge meta={meta} />
    </header>
  );
}
