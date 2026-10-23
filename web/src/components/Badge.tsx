// 徽标组件族（契约 §7.4：颜色不得单独承载状态，必须配文字标签）。
// lifecycle 徽标色板来自契约定稿表；Tailwind JIT 需完整类名，故用显式映射
// （动态拼接 `text-lifecycle-${x}` 不会被扫描，禁止那么写）。

import type {
  AcceptanceVerdict,
  CriterionVerdict,
  LagState,
  TaskLifecycle,
  TaskWaitState,
} from '../api/types';
import { useProjectionFreshness } from '../api/projection';

const LIFECYCLE_LABEL: Record<TaskLifecycle, string> = {
  captured: '已捕获',
  defined: '已定义',
  ready: '可开始',
  active: '进行中',
  awaiting_acceptance: '待验收',
  accepted: '已通过',
  canceled: '已取消',
};

// §7.4 lifecycle 徽标配色（文字/背景成对）
const LIFECYCLE_CLASS: Record<TaskLifecycle, string> = {
  captured: 'text-lifecycle-captured bg-lifecycle-captured',
  defined: 'text-lifecycle-defined bg-lifecycle-defined',
  ready: 'text-lifecycle-ready bg-lifecycle-ready',
  active: 'text-lifecycle-active bg-lifecycle-active',
  awaiting_acceptance: 'text-lifecycle-awaiting_acceptance bg-lifecycle-awaiting_acceptance',
  accepted: 'text-lifecycle-accepted bg-lifecycle-accepted',
  canceled: 'text-lifecycle-canceled bg-lifecycle-canceled',
};

const WAIT_LABEL: Record<TaskWaitState, string> = {
  none: '无等待',
  waiting_on_person: '等待他人',
  waiting_until: '等待时限',
  waiting_on_dependency: '等待依赖',
  blocked: '已阻塞',
  on_hold: '已暂停',
};

const VERDICT_LABEL: Record<AcceptanceVerdict, string> = {
  accepted: '验收通过',
  rejected: '验收驳回',
  partially_accepted: '部分通过',
};

const VERDICT_CLASS: Record<AcceptanceVerdict, string> = {
  accepted: 'bg-success-subtle text-success',
  rejected: 'bg-danger-subtle text-danger',
  partially_accepted: 'bg-warning-subtle text-warning',
};

const CRITERION_VERDICT_LABEL: Record<CriterionVerdict, string> = {
  passed: '通过',
  failed: '未通过',
  not_applicable: '不适用',
};

function BadgeBase({ className, children, testId }: { className: string; children: React.ReactNode; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className={[
        'inline-flex items-center rounded-s px-2 py-0.5 text-caption font-medium',
        'transition-colors duration-[var(--motion-state)]',
        className,
      ].join(' ')}
    >
      {children}
    </span>
  );
}

export function LifecycleBadge({ lifecycle, testId }: { lifecycle: TaskLifecycle; testId?: string }) {
  return (
    <BadgeBase className={LIFECYCLE_CLASS[lifecycle]} testId={testId ?? 'task-lifecycle'}>
      {LIFECYCLE_LABEL[lifecycle]}
    </BadgeBase>
  );
}

export function lifecycleLabel(lifecycle: TaskLifecycle): string {
  return LIFECYCLE_LABEL[lifecycle];
}

export function WaitStateBadge({ waitState }: { waitState: TaskWaitState }) {
  if (waitState === 'none') return null;
  return <BadgeBase className="bg-warning-subtle text-warning">{WAIT_LABEL[waitState]}</BadgeBase>;
}

export function waitStateLabel(waitState: TaskWaitState): string {
  return WAIT_LABEL[waitState];
}

export function AcceptanceVerdictBadge({
  verdict,
  testId,
}: {
  verdict: AcceptanceVerdict;
  testId?: string;
}) {
  return (
    <BadgeBase className={VERDICT_CLASS[verdict]} testId={testId ?? 'acceptance-verdict'}>
      {VERDICT_LABEL[verdict]}
    </BadgeBase>
  );
}

export function acceptanceVerdictLabel(verdict: AcceptanceVerdict): string {
  return VERDICT_LABEL[verdict];
}

export function CriterionVerdictBadge({ verdict }: { verdict: CriterionVerdict }) {
  const cls =
    verdict === 'passed'
      ? 'bg-success-subtle text-success'
      : verdict === 'failed'
        ? 'bg-danger-subtle text-danger'
        : 'bg-subtle text-text-secondary';
  return <BadgeBase className={cls}>{CRITERION_VERDICT_LABEL[verdict]}</BadgeBase>;
}

export function DegradedBadge() {
  return (
    <BadgeBase className="bg-warning-subtle text-warning" testId="proposal-degraded">
      降级提议
    </BadgeBase>
  );
}

const LAG_LABEL: Record<LagState, string> = {
  fresh: '已同步',
  catching_up: '追赶中',
  rebuilding: '重建中',
};

/**
 * 同步徽标（P 层新鲜度，契约 §1.1 F-011）：由投影 meta + 连接状态推导，
 * 组件不得自行写入。stale 时常显；fresh 时弱化（仍可访问，a11y 不隐藏）。
 */
export function SyncBadge({
  meta,
  testId = 'sync-badge',
}: {
  meta: { projection_version: number; head_global_seq?: number; lag_state?: LagState } | undefined;
  testId?: string;
}) {
  const freshness = useProjectionFreshness(meta);
  const lagState = meta?.lag_state;
  if (!freshness.stale) {
    return (
      <span
        data-testid={testId}
        data-stale="false"
        className="inline-flex items-center gap-1 text-caption text-text-tertiary"
        title={`投影版本 ${freshness.debug.projectionVersion}`}
      >
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-success" />
        已同步
      </span>
    );
  }
  const label = freshness.rebuilding
    ? '投影重建中'
    : lagState === 'catching_up'
      ? '追赶中'
      : '同步中';
  return (
    <span
      data-testid={testId}
      data-stale="true"
      className="inline-flex items-center gap-1 text-caption text-warning"
      title={`投影版本 ${freshness.debug.projectionVersion}，已收事件 ${freshness.debug.lastEventSeq}`}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-warning" />
      {label}
    </span>
  );
}

export function lagLabel(state: LagState): string {
  return LAG_LABEL[state];
}
