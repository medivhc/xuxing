// 项目卡片（首页与 /projects 索引页共用）：数据为 Home 投影的项目摘要行，
// 纯呈现 + 跳项目页，不制造写动作（OQ-05=B）。

import { Link } from 'react-router-dom';
import type { HomeProjectSummary, TaskLifecycle } from '../api/types';
import { formatRelative } from '../lib/time';

const LIFECYCLE_COUNT_ORDER: TaskLifecycle[] = [
  'captured',
  'defined',
  'ready',
  'active',
  'awaiting_acceptance',
  'accepted',
  'canceled',
];

export function ProjectCard({ project }: { project: HomeProjectSummary }) {
  return (
    <article
      data-testid="home-project-card"
      className="rounded-m border border-border bg-surface p-5 shadow-1"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-title-s font-semibold text-text-primary">
          <Link to={`/projects/${project.project_id}`} className="hover:text-accent">
            {project.name}
          </Link>
        </h2>
        {project.last_activity_at ? (
          <span className="shrink-0 text-caption text-text-tertiary">
            {formatRelative(project.last_activity_at)}
          </span>
        ) : null}
      </div>
      {project.goal_statement ? (
        <p className="mt-2 text-body-s text-text-secondary">{project.goal_statement}</p>
      ) : (
        <p className="mt-2 text-body-s text-text-tertiary">未设定目标</p>
      )}
      <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
        {LIFECYCLE_COUNT_ORDER.map((lifecycle) => (
          <div key={lifecycle} className="flex items-center gap-1 text-caption">
            <dt className="text-text-tertiary">{lifecycle}</dt>
            <dd className="font-medium tabular-nums text-text-primary">
              {project.task_counts[lifecycle] ?? 0}
            </dd>
          </div>
        ))}
      </dl>
    </article>
  );
}
