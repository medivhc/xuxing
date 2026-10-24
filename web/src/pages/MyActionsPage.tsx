// My Actions（GET /api/actions，契约 §4 M-*）：只展示当前用户真正可执行的
// 事项（REQ-PJ-2）。awaiting_acceptance 不在此列（OQ-02=A：验收在 Project 页，
// 由 Home attention 跳转）。条目按投影 rank 排序（OQ-08=A：内核计算，UI 只排序）。
//
// 决策行：resolve_decision 四选项；approved_modified 置灰（OQ-04=B：K0 不做
// PlanChange 提案表单，置灰并提示走 API）。
//
// 注：ActionItem 是单一接口（kind 为联合字段而非可区分联合），组件按
// kind 分流后直接访问可选字段（task_lifecycle/decision 等本身可空）。
// ActionItem 投影不含 title（契约投影清单），任务行以 task_id 呈现，
// 标题在 Project 页查看——不发明投影字段。

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
import type { ActionItem } from '../api/types';
import { useCommand } from '../features/commands/use-command';
import { LifecycleBadge, WaitStateBadge } from '../components/Badge';
import { EmptyState, ErrorBanner, PendingButton, Skeleton } from '../components/Feedback';
import { SyncBadge } from '../components/Badge';
import { formatRelative } from '../lib/time';

type Resolution = 'approved' | 'approved_modified' | 'rejected' | 'deferred';

const RESOLUTION_LABEL: Record<Resolution, string> = {
  approved: '批准',
  approved_modified: '批准并修改（置灰）',
  rejected: '否决',
  deferred: '暂缓',
};

function TaskActionRow({ item }: { item: ActionItem }) {
  const start = useCommand({ type: 'start_task' });
  const complete = useCommand({ type: 'complete_task' });
  const cancel = useCommand({ type: 'cancel_task' });

  const actions = item.available_actions;
  const anyPending = start.isPending || complete.isPending || cancel.isPending;

  return (
    <li
      data-testid="my-actions-row"
      data-kind="task"
      data-task-id={item.task_id}
      className="rounded-m border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {item.task_lifecycle ? <LifecycleBadge lifecycle={item.task_lifecycle} /> : null}
            {item.task_wait_state ? <WaitStateBadge waitState={item.task_wait_state} /> : null}
          </div>
          <p className="mt-1 font-mono text-body-s text-text-primary">{item.task_id}</p>
          {item.active_run ? (
            <p className="mt-0.5 text-caption text-text-tertiary">
              Run {item.active_run.run_id} · {item.active_run.run_kind} · {item.active_run.state}
            </p>
          ) : null}
          {item.blocked_reason ? (
            <p className="mt-1 text-caption text-warning">阻塞原因：{item.blocked_reason}</p>
          ) : null}
        </div>
        <Link
          to={`/projects/${item.project_id}`}
          className="shrink-0 text-body-s text-accent hover:underline"
        >
          项目页详情
        </Link>
      </div>

      {actions.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {actions.includes('start_task') ? (
            <PendingButton
              pending={start.isPending}
              disabled={anyPending}
              onClick={() =>
                start.mutate({
                  idemKey: `cmd:start_task:${item.task_id}`,
                  payload: { task_id: item.task_id },
                })
              }
              testId="action-start-task"
            >
              开始执行
            </PendingButton>
          ) : null}
          {actions.includes('complete_task') ? (
            <PendingButton
              pending={complete.isPending}
              disabled={anyPending}
              onClick={() =>
                complete.mutate({
                  idemKey: `cmd:complete_task:${item.task_id}`,
                  payload: { task_id: item.task_id },
                })
              }
              testId="action-complete-task"
            >
              标记完成
            </PendingButton>
          ) : null}
          {actions.includes('cancel_task') ? (
            <PendingButton
              variant="secondary"
              pending={cancel.isPending}
              disabled={anyPending}
              onClick={() =>
                cancel.mutate({
                  idemKey: `cmd:cancel_task:${item.task_id}`,
                  payload: { task_id: item.task_id },
                })
              }
              testId="action-cancel-task"
            >
              取消任务
            </PendingButton>
          ) : null}
        </div>
      ) : (
        <p className="mt-2 text-caption text-text-tertiary">
          暂无可执行动作{item.blocked_reason ? `（${item.blocked_reason}）` : ''}。
        </p>
      )}

      <ErrorBanner error={start.error} />
      <ErrorBanner error={complete.error} />
      <ErrorBanner error={cancel.error} />
    </li>
  );
}

function DecisionActionRow({ item }: { item: ActionItem }) {
  const [choice, setChoice] = useState<Resolution | null>(null);
  const resolve = useCommand({ type: 'resolve_decision' });
  const decision = item.decision;

  const submit = (resolution: Resolution) => {
    if (!item.decision_id) return;
    resolve.mutate({
      idemKey: `cmd:resolve_decision:${item.decision_id}:${resolution}`,
      payload: { decision_id: item.decision_id, resolution },
    });
  };

  return (
    <li
      data-testid="my-actions-row"
      data-kind="decision"
      data-decision-id={item.decision_id}
      className="rounded-m border border-border bg-surface p-4"
    >
      <p className="text-body-s font-medium text-text-primary">{decision?.question}</p>
      {decision?.recommendation ? (
        <p className="mt-1 text-body-s text-text-secondary">建议：{decision.recommendation}</p>
      ) : null}
      {decision && decision.alternatives.length > 0 ? (
        <p className="mt-1 text-caption text-text-tertiary">
          备选：{decision.alternatives.join(' / ')}
        </p>
      ) : null}
      {decision && decision.evidence_refs.length > 0 ? (
        <p className="mt-1 font-mono text-caption text-text-tertiary">
          证据：{decision.evidence_refs.join('、')}
        </p>
      ) : null}
      {decision?.expires_at ? (
        <p className="mt-1 text-caption text-text-tertiary">
          截止：{formatRelative(decision.expires_at)}
          {decision.status === 'expired' ? '（已过期）' : ''}
        </p>
      ) : null}
      {item.blocked_reason ? (
        <p className="mt-1 text-caption text-warning">阻塞原因：{item.blocked_reason}</p>
      ) : null}

      {item.available_actions.includes('resolve_decision') ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {(Object.keys(RESOLUTION_LABEL) as Resolution[]).map((resolution) => {
            const disabled = resolution === 'approved_modified';
            return (
              <button
                key={resolution}
                type="button"
                data-testid={`decision-resolve-${resolution}`}
                disabled={disabled || resolve.isPending}
                aria-pressed={choice === resolution}
                onClick={() => {
                  setChoice(resolution);
                  submit(resolution);
                }}
                title={
                  disabled ? 'K0 不支持在界面修改计划（OQ-04=B），请走 API 提交 PlanChange' : undefined
                }
                className={[
                  'min-h-touch rounded-m border px-3 text-body-s transition-colors duration-[var(--motion-feedback)]',
                  disabled
                    ? 'cursor-not-allowed border-border bg-subtle text-text-disabled'
                    : choice === resolution
                      ? 'border-accent bg-accent-subtle font-medium text-accent'
                      : 'border-border-strong bg-surface text-text-secondary hover:bg-subtle',
                ].join(' ')}
              >
                {RESOLUTION_LABEL[resolution]}
              </button>
            );
          })}
        </div>
      ) : null}

      <ErrorBanner error={resolve.error} className="mt-2" />
    </li>
  );
}

export function MyActionsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.actions,
    queryFn: (ctx) => api.actions(ctx.signal),
  });

  if (isLoading) {
    return <Skeleton lines={5} testId="actions-skeleton" />;
  }

  if (error) {
    return <ErrorBanner error={error} className="mb-4" />;
  }

  const items = [...(data?.items ?? [])].sort((a, b) => a.rank - b.rank);

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-title font-semibold text-text-primary">待我处理</h1>
        <SyncBadge meta={data} />
      </header>

      {items.length === 0 ? (
        <EmptyState
          testId="actions-empty"
          title="暂无待处理事项"
          hint="可执行的任务与待你裁决的决策会出现在这里。验收类事项在项目页处理。"
        />
      ) : (
        <ul data-testid="my-actions-list" className="space-y-3">
          {items.map((item) =>
            item.kind === 'task' ? (
              <TaskActionRow key={item.item_id} item={item} />
            ) : (
              <DecisionActionRow key={item.item_id} item={item} />
            ),
          )}
        </ul>
      )}
    </div>
  );
}
