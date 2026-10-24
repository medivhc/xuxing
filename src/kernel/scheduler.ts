// REQ-SCH-3：WaitCondition 定时器（K0 最小可用 Scheduler）。
//
// 纪律（spec §4 派生规则 / REQ-SCH-3）：
// - 定时器全部持久化：到期时间写在 WaitConditionCreated.payload.due_at（事件即持久化记录），
//   `listDueTimers` 每次从事件流重算待触发集合 —— 进程重启不依赖任何内存计时（C4 的机制前提）。
// - 触发只发 WaitConditionExpired（C4 的验收事件），不改 wait_state、不派发新 Run：
//   本批不做生产调度循环，触发与投影消费由后续批次接线。
// - 幂等：idempotency_key = `scheduler:<stream>:<wait_condition_id>:<due_at>`；
//   已 expired 的条件不会再次进入待触发集合，重复调用不产生第二条事件。

import type { EventEnvelope, ProjectId } from './events.js';
import type { PgEventStore, PgEventStoreTx } from './event-store-pg.js';

export type WaitConditionKind = 'person' | 'until' | 'dependency' | 'device';

/** 注册一个带到期时间的 WaitCondition（写 WaitConditionCreated 事实）。 */
export interface RegisterWaitConditionTimerInput {
  stream_id: ProjectId;
  wait_condition_id: string;
  task_id: string;
  kind: WaitConditionKind;
  /** person/dependency/device 的等待对象标识（spec §2.7）。 */
  target_ref: string;
  /** `until` 类必填；其它 kind 可选（REQ-SCH-3 的持久化定时器落点）。 */
  due_at: string | null;
  followup_task_id?: string | null;
  actor_id: string;
  actor_kind: EventEnvelope['actor_kind'];
  causation_id: string | null;
  correlation_id: string;
  idempotency_key: string | null;
}

export interface WaitConditionTimer {
  stream_id: string;
  wait_condition_id: string;
  task_id: string | null;
  due_at: string;
}

export class SchedulerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchedulerInputError';
  }
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SchedulerInputError(`${field} 必须是非空字符串`);
  }
  return value;
}

/** 注册定时器：due_at 必须是可解析的 ISO 时间（不读系统时钟，时间由调用方给）。 */
export async function registerWaitConditionTimer(
  store: PgEventStoreTx,
  input: RegisterWaitConditionTimerInput,
): Promise<EventEnvelope> {
  const wait_condition_id = requireNonEmpty(input.wait_condition_id, 'wait_condition_id');
  const task_id = requireNonEmpty(input.task_id, 'task_id');
  const target_ref = requireNonEmpty(input.target_ref, 'target_ref');

  let due_at: string | null = null;
  if (input.due_at !== null) {
    const parsed = new Date(input.due_at);
    if (Number.isNaN(parsed.getTime())) {
      throw new SchedulerInputError(`due_at 不是合法时间：${JSON.stringify(input.due_at)}`);
    }
    due_at = parsed.toISOString();
  }

  if (input.kind === 'until' && due_at === null) {
    throw new SchedulerInputError('kind=until 的 WaitCondition 必须带 due_at（REQ-SCH-3）');
  }

  return store.append({
    stream_id: input.stream_id,
    type: 'WaitConditionCreated',
    actor_id: input.actor_id,
    actor_kind: input.actor_kind,
    causation_id: input.causation_id,
    correlation_id: input.correlation_id,
    idempotency_key: input.idempotency_key,
    payload: {
      wait_condition_id,
      task_id,
      kind: input.kind,
      target_ref,
      due_at,
      followup_task_id: input.followup_task_id ?? null,
    },
  });
}

/** 从事件流恢复待触发定时器（进程重启后同样可用）。 */
export async function listDueTimers(
  store: PgEventStoreTx,
  now: Date,
): Promise<WaitConditionTimer[]> {
  return store.listDueWaitConditions(now);
}

export interface FireDueTimersResult {
  /** 到期待触发的定时器（按 due_at 升序）。 */
  due: WaitConditionTimer[];
  /** 本次新写入的 WaitConditionExpired 事件。 */
  expired: EventEnvelope[];
}

/**
 * 触发全部到期定时器：每个 WaitCondition 写一条 WaitConditionExpired。
 * `now` 由调用方注入（内核不读系统时间）。
 */
export async function fireDueTimers(
  store: PgEventStore,
  now: Date,
  options: {
    actor_id?: string;
    correlation_id?: string;
    clock?: () => Date;
  } = {},
): Promise<FireDueTimersResult> {
  const due = await listDueTimers(store, now);
  const expired: EventEnvelope[] = [];
  const actor_id = options.actor_id ?? 'scheduler';
  const correlation_id = options.correlation_id ?? 'scheduler:tick';
  const nowIso = now.toISOString();

  for (const timer of due) {
    const event = await store.append({
      stream_id: timer.stream_id as ProjectId,
      type: 'WaitConditionExpired',
      actor_id,
      actor_kind: 'system',
      causation_id: null,
      correlation_id,
      idempotency_key: `scheduler:${timer.stream_id}:${timer.wait_condition_id}:${timer.due_at}`,
      payload: {
        wait_condition_id: timer.wait_condition_id,
        task_id: timer.task_id,
        due_at: timer.due_at,
        fired_at: nowIso,
        reason: 'due_at_reached',
      },
    });
    expired.push(event);
  }

  return { due, expired };
}
