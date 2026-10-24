// My Actions（GET /api/actions，契约 §4 M-*）：只展示当前用户真正可执行的
// 事项（REQ-PJ-2）。形状以服务端 server/src/api/views.ts 的 myActionItems
// 为准（FIX-ROUND-4 对齐真投影）：扁平任务列表——task_id / project_name /
// title / lifecycle / wait_state / next_action / available_actions。
//
// 此前本页按 mock 形状消费（kind 联合 + decision 包装 + rank）：真投影的
// 任务项没有 kind 字段，全部被误判为 decision 行、只渲染「决策裁决动作
// 本轮已下线」占位卡，7 条真实任务项一条都没呈现（ACTIONS-EMPTY-1024）。
// 决策待办不经此端点：服务端只产任务项；决策在 Home「需要关注」呈现并
// 跳所属项目页（FIX-ROUND-3 裁决），resolve_decision 本体仍属 K1 契约缺口。
//
// 动作按钮一律由 available_actions 驱动（内核 guard 为准，不前端推断）：
// - task_advance：按钮文案用投影 next_action 标签（内核给的下一步文案）；
// - feedback_submit：行内反馈表单（payload {task_id, content}，服务端
//   REQ-HUM-2 口径，反馈原文先入账）；
// - task_cancel：仅当投影广告该动作时出现。
// 排序由服务端完成（updated_global_seq 升序），前端不重排。

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
import type { ActionItem } from '../api/types';
import { useCommand } from '../features/commands/use-command';
import { LifecycleBadge, SyncBadge, WaitStateBadge } from '../components/Badge';
import { EmptyState, ErrorBanner, PendingButton, Skeleton } from '../components/Feedback';

function TaskActionRow({ item }: { item: ActionItem }) {
  const advance = useCommand({ type: 'task_advance' });
  const cancel = useCommand({ type: 'task_cancel' });
  const feedback = useCommand({ type: 'feedback_submit' });
  const [content, setContent] = useState('');

  const actions = item.available_actions;
  const anyPending = advance.isPending || cancel.isPending || feedback.isPending;
  const trimmed = content.trim();

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
            <LifecycleBadge lifecycle={item.lifecycle} />
            <WaitStateBadge waitState={item.wait_state} />
          </div>
          <p className="mt-1 text-body font-medium text-text-primary">{item.title}</p>
          <p className="mt-0.5 text-caption text-text-tertiary">
            {item.project_name} · <span className="font-mono">{item.task_id}</span>
          </p>
          {item.next_action ? (
            <p className="mt-1 text-caption text-text-secondary">下一步：{item.next_action}</p>
          ) : null}
        </div>
        <Link
          to={`/projects/${item.project_id}`}
          className="shrink-0 text-body-s text-accent hover:underline"
        >
          项目页详情
        </Link>
      </div>

      {actions.includes('task_advance') || actions.includes('task_cancel') ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {actions.includes('task_advance') ? (
            <PendingButton
              pending={advance.isPending}
              disabled={anyPending}
              onClick={() =>
                advance.mutate({
                  idemKey: `cmd:task_advance:${item.task_id}`,
                  payload: { task_id: item.task_id },
                })
              }
              testId="action-task-advance"
            >
              {item.next_action || '推进任务'}
            </PendingButton>
          ) : null}
          {actions.includes('task_cancel') ? (
            <PendingButton
              variant="secondary"
              pending={cancel.isPending}
              disabled={anyPending}
              onClick={() =>
                cancel.mutate({
                  idemKey: `cmd:task_cancel:${item.task_id}`,
                  payload: { task_id: item.task_id },
                })
              }
              testId="action-cancel-task"
            >
              取消任务
            </PendingButton>
          ) : null}
        </div>
      ) : null}

      {actions.includes('feedback_submit') ? (
        <div className="mt-3">
          <label
            htmlFor={`feedback-${item.task_id}`}
            className="text-body-s font-medium text-text-primary"
          >
            执行反馈
          </label>
          <textarea
            id={`feedback-${item.task_id}`}
            data-testid="action-feedback-input"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={3}
            placeholder="填写执行反馈（做了什么、结果如何）"
            className="mt-1 w-full rounded-m border border-border-strong bg-surface px-3 py-2 text-body text-text-primary outline-none transition-colors duration-[var(--motion-feedback)] focus:border-accent"
          />
          <div className="mt-2">
            <PendingButton
              pending={feedback.isPending}
              disabled={anyPending || trimmed === ''}
              onClick={() =>
                feedback.mutate({
                  idemKey: `cmd:feedback_submit:${item.task_id}`,
                  payload: { task_id: item.task_id, content: trimmed },
                })
              }
              testId="action-feedback-submit"
            >
              提交执行反馈
            </PendingButton>
          </div>
        </div>
      ) : null}

      <ErrorBanner error={advance.error} />
      <ErrorBanner error={cancel.error} />
      <ErrorBanner error={feedback.error} />
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

  // 服务端已按 updated_global_seq 升序产出，前端保持原序（FIX-ROUND-4：
  // 真投影无 rank 字段，不再按不存在的字段重排）。
  const items = data?.items ?? [];

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
          hint="可执行的任务会出现在这里。待裁决的决策在首页「需要关注」里，验收类事项在项目页处理。"
        />
      ) : (
        <ul data-testid="my-actions-list" className="space-y-3">
          {items.map((item) => (
            <TaskActionRow key={item.task_id} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}
