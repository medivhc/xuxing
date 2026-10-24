// Project（GET /api/projects/:projectId，契约 §5 P-*）：单项目工作台——
// 概览（目标/计划版本/计数）、任务列表、逐判据验收（P-A5/OQ-03=A）、
// 聚焦子图只读渲染（P-GRAPH/OQ-09=A：固定 1-hop depends_on + data_from，
// 不显示 conflicts_with/supersedes，不允许编辑）。
//
// 验收动作只落在 awaiting_acceptance 任务上（OQ-02=A：不进 My Actions，
// 由 Home attention「待验收」跳转至此）。

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
import type { ProjectTaskRow } from '../api/types';
import { useCommand } from '../features/commands/use-command';
import { CriterionForm } from '../features/acceptance/CriterionForm';
import {
  AcceptanceVerdictBadge,
  LifecycleBadge,
  SyncBadge,
  WaitStateBadge,
} from '../components/Badge';
import { ErrorBanner, PendingButton, Skeleton } from '../components/Feedback';
import { formatAbsolute } from '../lib/time';

function TaskCard({ task }: { task: ProjectTaskRow }) {
  const [expanded, setExpanded] = useState(task.lifecycle === 'awaiting_acceptance');
  // task_advance 一词覆盖开始/完成：按 task.lifecycle 分派渲染（FIX-ROUND-1 R-1）
  const advance = useCommand({ type: 'task_advance' });
  const cancel = useCommand({ type: 'task_cancel' });
  const canStart = task.lifecycle === 'defined' || task.lifecycle === 'ready';

  return (
    <li
      data-testid="project-task-row"
      data-task-id={task.task_id}
      data-lifecycle={task.lifecycle}
      className="rounded-m border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <LifecycleBadge lifecycle={task.lifecycle} />
            <WaitStateBadge waitState={task.wait_state} />
            {task.duplicate_suspect ? (
              <span className="rounded-s bg-warning-subtle px-2 py-0.5 text-caption font-medium text-warning">
                疑似重复
              </span>
            ) : null}
            <span className="text-caption text-text-tertiary">契约 rev {task.current_contract_rev}</span>
          </div>
          <p className="mt-1 text-body font-medium text-text-primary">{task.title}</p>
          <p className="mt-0.5 font-mono text-caption text-text-tertiary">{task.task_id}</p>
          <p className="mt-0.5 text-caption text-text-tertiary">
            {task.assignee ? `执行者 ${task.assignee.actor_id}（${task.assignee.actor_kind}）` : '未指派'}
            {task.active_run ? ` · Run ${task.active_run.run_id} ${task.active_run.state}` : ''}
            {task.last_outcome_id ? ` · 产出 ${task.last_outcome_id}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {task.acceptance_summary.verdict ? (
            <AcceptanceVerdictBadge verdict={task.acceptance_summary.verdict} />
          ) : null}
          {task.acceptance_summary.pending_criteria.length > 0 ? (
            <span className="text-caption text-warning">
              待补 {task.acceptance_summary.pending_criteria.length} 条判据
            </span>
          ) : null}
          <span className="text-caption text-text-tertiary">seq {task.updated_global_seq}</span>
        </div>
      </div>

      {task.available_actions.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {task.available_actions.includes('task_advance') && canStart ? (
            <PendingButton
              pending={advance.isPending}
              onClick={() =>
                advance.mutate({
                  idemKey: `cmd:task_advance:start:${task.task_id}`,
                  payload: { task_id: task.task_id },
                })
              }
              testId="project-action-start-task"
            >
              开始执行
            </PendingButton>
          ) : null}
          {task.available_actions.includes('task_advance') && task.lifecycle === 'active' ? (
            <PendingButton
              pending={advance.isPending}
              onClick={() =>
                advance.mutate({
                  idemKey: `cmd:task_advance:complete:${task.task_id}`,
                  payload: { task_id: task.task_id },
                })
              }
              testId="project-action-complete-task"
            >
              标记完成
            </PendingButton>
          ) : null}
          {task.available_actions.includes('task_cancel') ? (
            <PendingButton
              variant="secondary"
              pending={cancel.isPending}
              onClick={() =>
                cancel.mutate({
                  idemKey: `cmd:task_cancel:${task.task_id}`,
                  payload: { task_id: task.task_id },
                })
              }
              testId="project-action-cancel-task"
            >
              取消
            </PendingButton>
          ) : null}
          {task.lifecycle === 'awaiting_acceptance' ? (
            <PendingButton
              variant="secondary"
              onClick={() => setExpanded((v) => !v)}
              testId="project-toggle-acceptance"
            >
              {expanded ? '收起验收表单' : '展开验收表单'}
            </PendingButton>
          ) : null}
        </div>
      ) : null}

      <ErrorBanner error={advance.error} />
      <ErrorBanner error={cancel.error} />

      {expanded && task.lifecycle === 'awaiting_acceptance' ? (
        <div className="mt-4 border-t border-border pt-4">
          <CriterionForm task={task} />
        </div>
      ) : null}
    </li>
  );
}

export function ProjectPage() {
  const { projectId = '' } = useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: (ctx) => api.project(projectId, ctx.signal),
    enabled: projectId !== '',
  });

  if (isLoading) {
    return <Skeleton lines={6} testId="project-skeleton" />;
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <h1 className="text-title font-semibold text-text-primary">项目</h1>
        <ErrorBanner error={error} />
        <Link to="/" className="text-body-s text-accent hover:underline">
          返回首页
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-title font-semibold text-text-primary">{data.name}</h1>
        <SyncBadge meta={data} />
      </header>

      <section aria-label="目标" className="rounded-m border border-border bg-surface p-5 shadow-1">
        <h2 className="text-title-s font-semibold text-text-primary">目标</h2>
        {data.goal ? (
          <dl className="mt-2 space-y-1 text-body-s">
            <div className="flex gap-2">
              <dt className="shrink-0 text-text-tertiary">陈述</dt>
              <dd className="text-text-primary">{data.goal.statement}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 text-text-tertiary">成功判据</dt>
              <dd className="text-text-secondary">{data.goal.success_criteria}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 text-text-tertiary">停止条件</dt>
              <dd className="text-text-secondary">{data.goal.stop_conditions}</dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="shrink-0 text-text-tertiary">状态</dt>
              <dd>
                <span
                  data-testid="goal-status"
                  data-status={data.goal.status}
                  className="rounded-s bg-info-subtle px-2 py-0.5 text-caption font-medium text-info"
                >
                  {data.goal.status}
                </span>
              </dd>
            </div>
          </dl>
        ) : (
          <p className="mt-2 text-body-s text-text-tertiary">未设定目标。</p>
        )}
        <p className="mt-3 text-caption text-text-tertiary">
          计划版本 rev {data.plan_rev}
          {data.plan_history.length > 0
            ? ` · 最近更新 ${formatAbsolute(data.plan_history[data.plan_history.length - 1].applied_at)}`
            : ''}
        </p>
      </section>

      <section aria-label="任务列表">
        <h2 className="mb-2 text-title-s font-semibold text-text-primary">
          任务（{data.tasks.length}）
        </h2>
        {data.tasks.length === 0 ? (
          <p className="rounded-m border border-border bg-surface px-4 py-3 text-body-s text-text-secondary">
            暂无任务。
          </p>
        ) : (
          <ul data-testid="project-task-list" className="space-y-3">
            {data.tasks.map((task) => (
              <TaskCard key={task.task_id} task={task} />
            ))}
          </ul>
        )}
      </section>

      {data.focused_subgraph ? (
        <section aria-label="聚焦子图" className="rounded-m border border-border bg-surface p-5 shadow-1">
          <h2 className="text-title-s font-semibold text-text-primary">聚焦子图（只读）</h2>
          <p className="mt-1 text-caption text-text-tertiary">
            固定 1-hop depends_on + data_from；不显示 conflicts_with/supersedes，不可编辑。
          </p>
          <ul data-testid="subgraph-nodes" className="mt-3 space-y-1">
            {data.focused_subgraph.nodes.map((node) => (
              <li key={node.task_id} className="flex items-center gap-2 text-body-s">
                <LifecycleBadge lifecycle={node.lifecycle} />
                <span className="text-text-primary">{node.title}</span>
                {node.task_id === data.focused_subgraph?.root_task_id ? (
                  <span className="text-caption text-text-tertiary">（根）</span>
                ) : null}
              </li>
            ))}
          </ul>
          {data.focused_subgraph.edges.length > 0 ? (
            <ul data-testid="subgraph-edges" className="mt-2 space-y-1">
              {data.focused_subgraph.edges.map((edge) => (
                <li key={edge.edge_id} className="font-mono text-caption text-text-secondary">
                  {edge.from_task} → {edge.to_task}（{edge.kind}）
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-caption text-text-tertiary">无关联任务。</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
