// My Actions（GET /api/actions，契约 §4 M-*）：只展示当前用户真正可执行的
// 事项（REQ-PJ-2）。条目形状以服务端 myActionItems 为准（K1 §3.6 定版）：
// 封闭联合 kind ∈ {task, decision}，同列按服务端 rank 排序，前端不重排。
//
// task 行：扁平字段（title / project_name / next_action 标签），动作按钮由
// available_actions 驱动——task_advance（文案用 next_action）、feedback_submit
// （行内反馈表单）、task_cancel（仅当广告时出现）。
//
// decision 行（K1-A §3.7）：待裁决 Decision 的裁决面——展开见
// question/recommendation/alternatives/evidence_refs；批准/拒绝/暂缓三动作，
// 拒绝必填理由、暂缓必选唤起条件（at_time 必备、on_event 可填事件类型）；
// Run 对账 subject 批准时必选 disposition。client_submit_id 在打开裁决面时
// 生成、重试复用（useCommand 的 idemKey 机制）；成功后条目随投影刷新消失；
// 409 进冲突态展示服务端回传的最新 status（不自动重试）；decision_expired
// 展示「已过期，未执行」。approved_modified 不在本页提供表单（§1.2）。

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
import type { ActionItem } from '../api/types';
import { useCommand } from '../features/commands/use-command';
import { CommandConflictError } from '../api/http';
import { LifecycleBadge, SyncBadge, WaitStateBadge } from '../components/Badge';
import { EmptyState, ErrorBanner, PendingButton, Skeleton } from '../components/Feedback';
import { formatRelative } from '../lib/time';

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
      data-task-id={item.task_id ?? ''}
      className="rounded-m border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {item.lifecycle ? <LifecycleBadge lifecycle={item.lifecycle} /> : null}
            {item.wait_state ? <WaitStateBadge waitState={item.wait_state} /> : null}
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

      {actions.length > 0 ? (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-2">
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
          {actions.includes('feedback_submit') ? (
            <div className="space-y-2">
              <textarea
                data-testid="action-feedback-input"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="填写执行反馈（原文先入账，再由解释器形成结果）"
                rows={3}
                className="w-full rounded-m border border-border bg-canvas px-3 py-2 text-body-s text-text-primary"
              />
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
                提交反馈
              </PendingButton>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mt-2 text-caption text-text-tertiary">暂无可执行动作。</p>
      )}

      <ErrorBanner error={advance.error} />
      <ErrorBanner error={cancel.error} />
      <ErrorBanner error={feedback.error} />
    </li>
  );
}

type Verdict = 'approved' | 'rejected' | 'deferred';

function DecisionActionRow({ item }: { item: ActionItem }) {
  const [expanded, setExpanded] = useState(false);
  const [verdict, setVerdict] = useState<Verdict>('approved');
  const [reason, setReason] = useState('');
  const [wakeKind, setWakeKind] = useState<'at_time' | 'on_event'>('at_time');
  const [wakeAt, setWakeAt] = useState('');
  const [wakeEvent, setWakeEvent] = useState('');
  const [disposition, setDisposition] = useState('');
  const [conflict, setConflict] = useState<Record<string, unknown> | null>(null);
  const [followUp, setFollowUp] = useState<string | null>(null);

  const resolve = useCommand({
    type: 'resolve_decision',
    onAccepted: (receipt) => {
      const subject = (receipt as unknown as { subject?: Record<string, unknown> }).subject;
      const follow = subject?.follow_up_decision_id;
      if (typeof follow === 'string') setFollowUp(follow);
    },
    onConflict: (error: CommandConflictError) => {
      setConflict((error.detail ?? {}) as Record<string, unknown>);
    },
  });

  const isRunReconciliation = item.subject_ref?.kind === 'run_reconciliation';
  const reasonMissing = verdict === 'rejected' && reason.trim() === '';
  const wakeMissing =
    verdict === 'deferred' && (wakeKind === 'at_time' ? wakeAt.trim() === '' : wakeEvent.trim() === '');
  const dispositionMissing = verdict === 'approved' && isRunReconciliation && disposition === '';
  const submitDisabled = resolve.isPending || reasonMissing || wakeMissing || dispositionMissing;

  const submit = () => {
    const payload: Record<string, unknown> = { decision_id: item.decision_id, verdict };
    if (reason.trim() !== '') payload.reason = reason.trim();
    if (verdict === 'deferred') {
      payload.wake_condition =
        wakeKind === 'at_time'
          ? { kind: 'at_time', at: new Date(wakeAt).toISOString() }
          : { kind: 'on_event', event_type: wakeEvent.trim() };
    }
    if (verdict === 'approved' && isRunReconciliation) payload.disposition = disposition;
    resolve.mutate({ idemKey: `cmd:resolve_decision:${item.decision_id}`, payload });
  };

  return (
    <li
      data-testid="my-actions-row"
      data-kind="decision"
      data-decision-id={item.decision_id ?? ''}
      className="rounded-m border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-body-s font-medium text-text-primary">{item.question}</p>
          {item.recommendation ? (
            <p className="mt-1 text-body-s text-text-secondary">建议：{item.recommendation}</p>
          ) : null}
          <p className="mt-0.5 text-caption text-text-tertiary">
            {item.project_name}
            {item.subject_ref ? ` · ${item.subject_ref.kind}:${item.subject_ref.id}` : ''}
            {item.created_at ? ` · ${formatRelative(item.created_at)}` : ''}
          </p>
        </div>
        <button
          data-testid="decision-resolve-toggle"
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 text-body-s text-accent hover:underline"
        >
          {expanded ? '收起裁决面' : '展开裁决面'}
        </button>
      </div>

      {expanded ? (
        <div data-testid="decision-resolve-panel" className="mt-3 space-y-3 border-t border-border pt-3">
          {item.alternatives.length > 0 ? (
            <p className="text-caption text-text-tertiary">备选：{item.alternatives.join(' / ')}</p>
          ) : null}
          {item.evidence_refs.length > 0 ? (
            <p className="font-mono text-caption text-text-tertiary">证据：{item.evidence_refs.join('、')}</p>
          ) : null}

          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="裁决结论">
            {(
              [
                ['approved', '批准'],
                ['rejected', '拒绝'],
                ['deferred', '暂缓'],
              ] as Array<[Verdict, string]>
            ).map(([value, label]) => (
              <button
                key={value}
                data-testid={`decision-verdict-${value}`}
                type="button"
                onClick={() => setVerdict(value)}
                className={[
                  'min-h-touch rounded-m px-3 py-2 text-body-s',
                  verdict === value
                    ? 'bg-accent-subtle font-medium text-accent'
                    : 'text-text-secondary hover:bg-subtle',
                ].join(' ')}
              >
                {label}
              </button>
            ))}
          </div>

          {verdict === 'approved' && isRunReconciliation ? (
            <label className="block">
              <span className="text-caption text-text-tertiary">处置（Run 对账必填）</span>
              <select
                data-testid="decision-disposition"
                value={disposition}
                onChange={(e) => setDisposition(e.target.value)}
                className="mt-1 w-full rounded-m border border-border bg-canvas px-3 py-2 text-body-s text-text-primary"
              >
                <option value="">请选择处置</option>
                <option value="executed">已执行（补录结果）</option>
                <option value="not_executed">未执行（置失败，可新建 Run）</option>
                <option value="cancel_run">取消该 Run（推进挂起的任务取消）</option>
              </select>
            </label>
          ) : null}

          <label className="block">
            <span className="text-caption text-text-tertiary">
              理由{verdict === 'rejected' ? '（拒绝必填）' : '（可选）'}
            </span>
            <textarea
              data-testid="decision-reason-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-m border border-border bg-canvas px-3 py-2 text-body-s text-text-primary"
            />
          </label>

          {verdict === 'deferred' ? (
            <div className="space-y-2">
              <div className="flex gap-2">
                <button
                  type="button"
                  data-testid="decision-wake-kind-at_time"
                  onClick={() => setWakeKind('at_time')}
                  className={wakeKind === 'at_time' ? 'font-medium text-accent' : 'text-text-secondary'}
                >
                  定时唤起
                </button>
                <button
                  type="button"
                  data-testid="decision-wake-kind-on_event"
                  onClick={() => setWakeKind('on_event')}
                  className={wakeKind === 'on_event' ? 'font-medium text-accent' : 'text-text-secondary'}
                >
                  事件唤起
                </button>
              </div>
              {wakeKind === 'at_time' ? (
                <input
                  data-testid="decision-wake-at"
                  type="datetime-local"
                  value={wakeAt}
                  onChange={(e) => setWakeAt(e.target.value)}
                  className="w-full rounded-m border border-border bg-canvas px-3 py-2 text-body-s text-text-primary"
                />
              ) : (
                <input
                  data-testid="decision-wake-event"
                  type="text"
                  placeholder="唤起事件类型（如 PlanChangeProposed）"
                  value={wakeEvent}
                  onChange={(e) => setWakeEvent(e.target.value)}
                  className="w-full rounded-m border border-border bg-canvas px-3 py-2 text-body-s text-text-primary"
                />
              )}
            </div>
          ) : null}

          {reasonMissing ? <p className="text-caption text-warning">拒绝必须填写理由。</p> : null}
          {wakeMissing ? <p className="text-caption text-warning">暂缓必须设置唤起条件。</p> : null}
          {dispositionMissing ? (
            <p className="text-caption text-warning">Run 对账批准必须选择处置。</p>
          ) : null}

          <PendingButton pending={resolve.isPending} disabled={submitDisabled} onClick={submit} testId="decision-submit">
            提交裁决
          </PendingButton>

          {followUp ? (
            <p data-testid="decision-follow-up" className="text-body-s text-text-secondary">
              已按当前版本生成新的待裁决事项（{followUp}），原变更维持待裁决。
            </p>
          ) : null}

          {conflict ? (
            <div data-testid="decision-conflict" className="rounded-m border border-border bg-canvas p-3">
              {conflict.reason === 'decision_expired' ? (
                <p className="text-body-s text-warning">该决策已过期，未执行。</p>
              ) : (
                <p className="text-body-s text-warning">
                  裁决未生效：该决策当前状态为 {String(conflict.status ?? '未知')}
                  {conflict.decided_by ? `（裁决人 ${String(conflict.decided_by)}` : ''}
                  {conflict.decided_at
                    ? `，于 ${formatRelative(String(conflict.decided_at))}）`
                    : conflict.decided_by
                      ? '）'
                      : ''}
                  。请刷新后查看最新状态。
                </p>
              )}
            </div>
          ) : null}

          <ErrorBanner
            error={resolve.error && !(resolve.error instanceof CommandConflictError) ? resolve.error : null}
          />
        </div>
      ) : null}
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
