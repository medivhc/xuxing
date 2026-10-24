// 提议查看页（GET /api/proposals/:proposalId，契约 §3.2）：
// - 降级提议必须明示（任务书红线）：DegradedBadge + degraded_reason，
//   不接受隐藏/弱化；degraded 时接受按钮需二次确认；
// - 可用动作由投影 available_actions 驱动；409 原样呈现；
// - 接受 → 跳项目页（新任务在 My Actions/Project 可见）；
// - 拒绝 → 离开提议页（封闭事件目录无「提议拒绝」事件，mock 不广播，
//   交卷登记项；界面回到 Capture）；
// - R-11：本页不展示、不预分配任何 task_id——提议只携带 draft（标题 +
//   验收判据），task_id 在提议被接受后由服务端新发（本页与 mock 均无
//   task_id 字段；登记见 web/README.md「已知边界」第 5 条）。

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

  const canAccept = data.available_actions.includes('proposal_accept');
  const canReject = data.available_actions.includes('proposal_reject');

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-title font-semibold text-text-primary">提议</h1>
        <SyncBadge meta={data} />
      </header>

      {data.degraded ? (
        <div
          data-testid="proposal-degraded-banner"
          className="rounded-m border border-warning bg-warning-subtle p-4"
          role="alert"
        >
          <DegradedBadge reason={data.degraded_reason} />
        </div>
      ) : null}

      <section className="rounded-m border border-border bg-surface p-5 shadow-1">
        <h2 className="text-title-s font-semibold text-text-primary">{data.proposed.title}</h2>
        <p className="mt-2 text-body-s text-text-secondary">{data.proposed.description}</p>
        <dl className="mt-3 space-y-1 text-body-s">
          <div className="flex gap-2">
            <dt className="shrink-0 text-text-tertiary">捕获</dt>
            <dd className="font-mono text-caption text-text-tertiary">{data.capture_id}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0 text-text-tertiary">状态</dt>
            <dd className="text-text-primary">{data.status}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0 text-text-tertiary">创建</dt>
            <dd className="text-text-secondary">{formatAbsolute(data.created_at)}</dd>
          </div>
        </dl>
      </section>

      <section className="rounded-m border border-border bg-surface p-5 shadow-1">
        <h2 className="text-title-s font-semibold text-text-primary">验收判据（draft）</h2>
        {data.proposed.acceptance_criteria.length === 0 ? (
          <p className="mt-2 text-body-s text-text-tertiary">无验收判据。</p>
        ) : (
          <ul data-testid="proposal-criteria" className="mt-2 space-y-1">
            {data.proposed.acceptance_criteria.map((criterion) => (
              <li key={criterion.criterion_ref} className="flex items-center gap-2 text-body-s">
                <span className="rounded-s bg-info-subtle px-2 py-0.5 text-caption font-medium text-info">
                  {criterion.kind === 'auto' ? '自动' : '人工'}
                </span>
                <span className="text-text-primary">{criterion.text}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-caption text-text-tertiary">
          判据为提议草稿；任务 id 在提议被接受后由服务端生成（R-11）。
        </p>
      </section>

      {data.status === 'pending' && (canAccept || canReject) ? (
        <section className="rounded-m border border-border bg-surface p-5 shadow-1">
          <div className="flex flex-wrap gap-2">
            {canAccept ? (
              <PendingButton
                pending={accept.isPending}
                onClick={() => setConfirmAccept(true)}
                testId="proposal-action-accept"
              >
                接受提议
              </PendingButton>
            ) : null}
            {canReject ? (
              <PendingButton
                variant="secondary"
                pending={reject.isPending}
                onClick={() =>
                  reject.mutate({
                    idemKey: `cmd:proposal_reject:${data.proposal_id}`,
                    payload: { proposal_id: data.proposal_id },
                  })
                }
                testId="proposal-action-reject"
              >
                拒绝提议
              </PendingButton>
            ) : null}
          </div>

          {confirmAccept && canAccept ? (
            <div className="mt-3 rounded-m border border-warning bg-warning-subtle p-3">
              <p className="text-body-s text-text-primary">
                接受后将生成任务并进入执行/验收流程，是否确认？
              </p>
              <div className="mt-2 flex gap-2">
                <PendingButton
                  pending={accept.isPending}
                  onClick={() =>
                    accept.mutate({
                      idemKey: `cmd:proposal_accept:${data.proposal_id}`,
                      payload: { proposal_id: data.proposal_id },
                    })
                  }
                  testId="proposal-action-accept-confirm"
                >
                  确认接受
                </PendingButton>
                <PendingButton
                  variant="secondary"
                  onClick={() => setConfirmAccept(false)}
                  testId="proposal-action-accept-cancel"
                >
                  再想想
                </PendingButton>
              </div>
            </div>
          ) : null}

          <ErrorBanner error={accept.error} />
          <ErrorBanner error={reject.error} />
        </section>
      ) : null}
    </div>
  );
}
