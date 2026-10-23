// 连接徽标（Header 常驻）：连接状态来自 P 层 connection store（组件只读，
// 契约 §0.2）。SSE 断线时由看护逻辑置 offline；重连路径先经 connecting
// （SseClient 重连前统一置 connecting），故 UI 三态即覆盖「重连中」语义。
// 与同步徽标互补：连接徽标答「订阅在不在」，同步徽标答「投影新不新」。

import { useConnectionStore } from '../state/connection';
import type { ConnectionStatus } from '../state/connection-status';

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: '连接中',
  online: '已连接',
  offline: '已断线',
};

const STATUS_CLASS: Record<ConnectionStatus, string> = {
  connecting: 'text-text-tertiary',
  online: 'text-success',
  offline: 'text-danger',
};

const DOT_CLASS: Record<ConnectionStatus, string> = {
  connecting: 'bg-text-tertiary',
  online: 'bg-success',
  offline: 'bg-danger',
};

export function ConnectionBadge({ testId = 'connection-badge' }: { testId?: string }) {
  const status = useConnectionStore((s) => s.status);
  const lastEventSeq = useConnectionStore((s) => s.lastEventSeq);
  return (
    <span
      data-testid={testId}
      data-status={status}
      className={`inline-flex items-center gap-1.5 text-caption ${STATUS_CLASS[status]}`}
      title={`SSE 订阅状态：${STATUS_LABEL[status]}；已收事件 seq=${lastEventSeq}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${DOT_CLASS[status]}`} />
      {STATUS_LABEL[status]}
    </span>
  );
}
