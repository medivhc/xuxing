// 提议查看页（GET /api/proposals/:proposalId，契约 §3.2）：
// - 降级提议必须明示（任务书红线）：DegradedBadge + degraded_reason，
//   不接受隐藏/弱化；degraded 时接受按钮需二次确认；
// - 可用动作由投影 available_actions 驱动；409 原样呈现；
// - 接受 → 跳项目页（新任务在 My Actions/Project 可见）；
// - 拒绝 → 离开提议页（封闭事件目录无「提议拒绝」事件，mock 不广播，
//   交卷登记项；界面回到 Capture）；
// - R-11：task_id 在提议被接受后由服务端新发；投影 task_id 未接受时恒 null，
//   本页不预分配、不展示。
// - 形状（FIX-ROUND-3）：草案读 data.details.task.*（capture_task），降级原因
//   读 data.proposer.degraded_reason，待处理判定为 status === 'proposed'。

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
import { useCommand } from '../features/commands/use-command';
import { DegradedBadge, SyncBadge } from '../components/Badge';
import { ErrorBanner, PendingButton, Skeleton } from '../components/Feedback';
import { formatAbsolute } from '../lib/time';

export function ProposalPage() {
  const { proposalId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmAccept, setConfirmAccept] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.proposal(proposalId),
    queryFn: (ctx) => api.proposal(proposalId, ctx.signal),
    enabled: proposalId !== '',
  });

  const accept = useCommand({
    type: 'proposal_accept',
    onAccepted: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.actions });
      if (data) navigate(`/projects/${data.project_id}`);
      else navigate('/');
    },
  });

  const reject = useCommand({
    type: 'proposal_reject',
    onAccepted: () => {
      navigate('/capture');
    },
  });

  if (isLoading) {
    return <Skeleton lines={5} testId="proposal-skeleton" />;
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <h1 className="text-title font-semibold text-text-primary">提议</h1>
        <ErrorBanner error={error} />
        <Link to="/capture" className="text-body-s text-accent hover:underline">
          返回捕获
        </Link>
      </div>
    );
  }

  const isPending = data.status === 'proposed';
  // 草案在 details（按 kind 分派）：capture_task 才有 task 草案与判据（FIX-ROUND-3）
  const taskDraft = data.details.kind === 'capture_task' ? data.details.task : null;

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-title font-semibold text-text-primary">提议详情</h1>
        <SyncBadge meta={data} />
      </header>

      {data.degraded ? (
        <div
          data-testid="proposal-degraded-banner"
          role="alert"
          className="rounded-m border border-warning/40 bg-warning-subtle p-4"
        >
          <div className="flex items-center gap-2">
            <DegradedBadge />
            <p className="text-body-s font-medium text-warning">
              这是降级提议：解释器未能高置信度理解该捕获，接受前请人工核对。
            </p>
          </div>
          {data.proposer.degraded_reason ? (
            <p className="mt-2 text-body-s text-text-secondary">
              原因：{data.proposer.degraded_reason}
            </p>
          ) : null}
        </div>
      ) : null}

      <section className="rounded-m border border-border bg-surface p-5 shadow-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-title-s font-semibold text-text-primary">
            {taskDraft ? taskDraft.title : '提议详情'}
          </h2>
          <span className="text-caption text-text-tertiary">
            {formatAbsolute(data.created_at)} · 状态 {data.status}
            {data.status_reason ? `（${data.status_reason}）` : ''}
          </span>
        </div>
        {data.rationale ? (
          <p className="mt-2 text-body-s text-text-secondary">{data.rationale}</p>
        ) : null}

        {data.details.kind === 'capture_task' ? (
          <>
            <dl className="mt-3 space-y-1 text-body-s">
              <div className="flex gap-2">
                <dt className="shrink-0 text-text-tertiary">标题</dt>
                <dd className="text-text-primary">{data.details.task.title}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 text-text-tertiary">描述</dt>
                <dd className="text-text-secondary">{data.details.task.description}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 text-text-tertiary">建议执行者</dt>
                <dd className="text-body-s text-text-secondary">
                  {data.details.task.assignee_kind === 'agent' ? 'Agent' : '人类'}
                </dd>
              </div>
            </dl>

            <h3 className="mt-4 text-body-s font-medium text-text-primary">
              验收判据（{data.details.task.acceptance_criteria.length} 条）
            </h3>
            <ul className="mt-1 space-y-1">
              {data.details.task.acceptance_criteria.map((criterion) => (
                <li key={criterion.criterion_ref} className="flex gap-2 text-body-s">
                  <span className="font-mono text-caption text-text-tertiary">
                    {criterion.criterion_ref}
                  </span>
                  <span className="text-text-secondary">{criterion.text}</span>
                  <span className="shrink-0 text-caption text-text-tertiary">
                    {criterion.auto ? '自动' : '人工'}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : data.details.kind === 'human_light_run' ? (
          <dl className="mt-3 space-y-1 text-body-s">
            <div className="flex gap-2">
              <dt className="shrink-0 text-text-tertiary">类型</dt>
              <dd className="text-text-secondary">轻量执行建议（human_light）</dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 text-text-tertiary">关联任务</dt>
              <dd className="font-mono text-body-s text-text-secondary">{data.details.task_id}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 text-text-tertiary">下一步</dt>
              <dd className="text-text-secondary">{data.details.next_action}</dd>
            </div>
          </dl>
        ) : (
          <dl className="mt-3 space-y-1 text-body-s">
            <div className="flex gap-2">
              <dt className="shrink-0 text-text-tertiary">类型</dt>
              <dd className="text-text-secondary">等待条件建议</dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 text-text-tertiary">关联任务</dt>
              <dd className="font-mono text-body-s text-text-secondary">{data.details.task_id}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 text-text-tertiary">等待对象</dt>
              <dd className="text-text-secondary">
                {data.details.wait.kind} · {data.details.wait.target_ref}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 text-text-tertiary">原因</dt>
              <dd className="text-text-secondary">{data.details.wait.reason}</dd>
            </div>
          </dl>
        )}
      </section>

      {isPending ? (
        <section className="flex flex-wrap items-center gap-3">
          {data.available_actions.includes('proposal_accept') ? (
            confirmAccept ? (
              <div className="flex flex-wrap items-center gap-2 rounded-m border border-border bg-subtle p-3">
                <span className="text-body-s text-text-secondary">
                  {data.degraded ? '降级提议：确认已人工核对后接受？' : '确认接受该提议并生成任务？'}
                </span>
                <PendingButton
                  pending={accept.isPending}
                  onClick={() =>
                    accept.mutate({
                      idemKey: `cmd:proposal_accept:${data.proposal_id}`,
                      payload: { proposal_id: data.proposal_id },
                    })
                  }
                  testId="proposal-accept-confirm"
                >
                  确认接受
                </PendingButton>
                <PendingButton
                  variant="secondary"
                  onClick={() => setConfirmAccept(false)}
                  testId="proposal-accept-cancel"
                >
                  取消
                </PendingButton>
              </div>
            ) : (
              <PendingButton
                onClick={() => setConfirmAccept(true)}
                testId="proposal-accept"
              >
                {data.degraded ? '核对后接受…' : '接受提议'}
              </PendingButton>
            )
          ) : null}
          {data.available_actions.includes('proposal_reject') ? (
            <PendingButton
              variant="secondary"
              pending={reject.isPending}
              onClick={() =>
                reject.mutate({
                  idemKey: `cmd:proposal_reject:${data.proposal_id}`,
                  payload: { proposal_id: data.proposal_id },
                })
              }
              testId="proposal-reject"
            >
              拒绝
            </PendingButton>
          ) : null}
        </section>
      ) : (
        <p data-testid="proposal-terminal" className="rounded-m border border-border bg-subtle p-4 text-body-s text-text-secondary">
          该提议已处理（{data.status}）。
        </p>
      )}

      <ErrorBanner error={accept.error} />
      <ErrorBanner error={reject.error} />

      <Link to="/capture" className="inline-block text-body-s text-accent hover:underline">
        返回捕获
      </Link>
    </div>
  );
}
