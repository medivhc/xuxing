// Project（GET /api/projects/:projectId，契约 §5 P-*）：单项目工作台——
// 概览（目标/验收摘要/待处理提议）、任务列表、逐判据验收（P-A5/OQ-03=A）。
//
// 投影键集以服务端 ProjectView 为准（FIX-ROUND-3 对齐真形状）：
// {project, goal, tasks, acceptance_status{accepted, awaiting, rejected, total,
// criterion_summary}, graph, pending_proposals}。此前按 mock 形状读
// acceptance_status.awaiting_task_ids / outstanding 与 task.acceptance_summary，
// 真投影无此二键，项目页一读即崩（CLICK-AUDIT §2-2）。
//
// 已知契约缺口（登记，不前端造字段）：
// - 任务行无 Run 信息（mock 有 active_run，真 taskSummary 未给）——本页不展示 Run；
// - graph 服务端现口径为「全项目任务节点 + edges 恒空」，P-GRAPH 的 1-hop
//   聚焦子图（depends_on/data_from）未在服务端实现，本页按真形状只读呈现。
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
  CriterionVerdictBadge,
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
  // 待补判据：已有有效验收（部分判定）时，判据清单中尚无结果的条数；
  // 从未判定过的任务不在此冒充「待补」（其覆盖进度在验收表单内呈现）。
  const recordedRefs = new Set((task.acceptance?.criterion_results ?? []).map((r) => r.criterion_ref));
  const pendingCriteriaCount = task.acceptance
    ? task.acceptance_criteria.filter((c) => !recordedRefs.has(c.criterion_ref)).length
    : 0;

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
            {task.cancel_requested ? (
              <span className="rounded-s bg-warning-subtle px-2 py-0.5 text-caption font-medium text-warning">
                已请求取消
              </span>
            ) : null}
            <span className="text-caption text-text-tertiary">契约 rev {task.current_contract_rev}</span>
          </div>
          <p className="mt-1 text-body font-medium text-text-primary">{task.title}</p>
          <p className="mt-0.5 font-mono text-caption text-text-tertiary">{task.task_id}</p>
          <p className="mt-0.5 text-caption text-text-tertiary">
            执行者类型 {task.assignee_kind === 'agent' ? 'Agent' : '人类'}
            {task.assigned_by ? ` · 由 ${task.assigned_by} 指派` : ''}
            {task.last_outcome_id ? ` · 产出 ${task.last_outcome_id}` : ''}
            {task.feedback_count > 0 ? ` · 反馈 ${task.feedback_count} 条` : ''}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {task.acceptance?.verdict ? (
            <AcceptanceVerdictBadge verdict={task.acceptance.verdict} />
          ) : null}
          {pendingCriteriaCount > 0 ? (
            <span className="text-caption text-warning">待补 {pendingCriteriaCount} 条判据</span>
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

  const taskTitleById = new Map(data.tasks.map((t) => [t.task_id, t.title]));

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-title font-semibold text-text-primary">{data.project.name}</h1>
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
          验收为本页操作落点（OQ-02=A）：待验收动作只出现在 awaiting_acceptance 任务上。
        </p>
      </section>

      <section aria-label="验收摘要" className="rounded-m border border-border bg-surface p-5 shadow-1">
        <h2 className="text-title-s font-semibold text-text-primary">验收</h2>
        <p className="mt-2 text-body-s text-text-secondary">
          已验收 {data.acceptance_status.accepted} 项 · 待验收 {data.acceptance_status.awaiting} 项 ·
          已拒绝 {data.acceptance_status.rejected} 项 · 共 {data.acceptance_status.total} 项任务
        </p>
        {data.acceptance_status.criterion_summary.length > 0 ? (
          <ul data-testid="acceptance-criterion-summary" className="mt-2 space-y-1">
            {data.acceptance_status.criterion_summary.map((item) => (
              <li
                key={`${item.task_id}:${item.criterion_ref}`}
                className="flex flex-wrap items-center gap-2 text-caption text-text-secondary"
              >
                <span>
                  {taskTitleById.get(item.task_id) ?? item.task_id}（{item.criterion_ref}）
                </span>
                <CriterionVerdictBadge verdict={item.verdict} />
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {data.pending_proposals.length > 0 ? (
        <section aria-label="待处理提议" className="rounded-m border border-border bg-surface p-5 shadow-1">
          <h2 className="text-title-s font-semibold text-text-primary">
            待处理提议（{data.pending_proposals.length}）
          </h2>
          <ul data-testid="project-pending-proposals" className="mt-2 space-y-2">
            {data.pending_proposals.map((proposal) => (
              <li key={proposal.proposal_id} className="flex items-center justify-between gap-2">
                <Link
                  to={`/capture/${proposal.proposal_id}`}
                  className="min-w-0 truncate text-body-s text-accent hover:underline"
                >
                  {proposal.rationale}
                </Link>
                {proposal.degraded ? (
                  <span className="shrink-0 rounded-s bg-warning-subtle px-2 py-0.5 text-caption font-medium text-warning">
                    降级提议
                  </span>
                ) : null}
                <span className="shrink-0 text-caption text-text-tertiary">
                  {formatAbsolute(proposal.created_at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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

      {data.graph ? (
        <section aria-label="聚焦子图" className="rounded-m border border-border bg-surface p-5 shadow-1">
          <h2 className="text-title-s font-semibold text-text-primary">任务关系（只读）</h2>
          <p className="mt-1 text-caption text-text-tertiary">
            服务端当前仅提供项目任务节点清单（关系边未实现，见页首契约缺口登记）；不可编辑。
          </p>
          <ul data-testid="subgraph-nodes" className="mt-3 space-y-1">
            {data.graph.nodes.map((node) => (
              <li key={node.id} className="flex items-center gap-2 text-body-s">
                <LifecycleBadge lifecycle={node.lifecycle} />
                <span className="text-text-primary">{node.title}</span>
              </li>
            ))}
          </ul>
          {data.graph.edges.length > 0 ? (
            <ul data-testid="subgraph-edges" className="mt-2 space-y-1">
              {data.graph.edges.map((edge, index) => (
                <li key={`${edge.from}-${edge.to}-${edge.kind}-${index}`} className="font-mono text-caption text-text-secondary">
                  {edge.from} → {edge.to}（{edge.kind}）
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-caption text-text-tertiary">暂无关系边。</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
