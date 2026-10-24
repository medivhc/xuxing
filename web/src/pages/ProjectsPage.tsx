// 项目索引（GET /api/home 的 projects 段）：四入口之「项目」的落点。
// 此前 /projects 路由是写死的 NotFoundPage 占位（CLICK-AUDIT §2-4），
// 本页复用首页项目卡组件列全部项目；数据走既有 Home 投影，不新增后端端点。

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
import { ProjectCard } from '../components/ProjectCard';
import { EmptyState, ErrorBanner, Skeleton } from '../components/Feedback';
import { SyncBadge } from '../components/Badge';

export function ProjectsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.home,
    queryFn: (ctx) => api.home(ctx.signal),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton lines={2} testId="projects-skeleton" />
        <Skeleton lines={4} />
      </div>
    );
  }

  if (error) {
    return <ErrorBanner error={error} className="mb-4" />;
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-title font-semibold text-text-primary">项目</h1>
        <SyncBadge meta={data} />
      </header>

      {!data || data.projects.length === 0 ? (
        <EmptyState
          testId="projects-empty"
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
      ) : (
        <section aria-label="项目列表" className="grid gap-4 tablet:grid-cols-2">
          {data.projects.map((project) => (
            <ProjectCard key={project.project_id} project={project} />
          ))}
        </section>
      )}
    </div>
  );
}
