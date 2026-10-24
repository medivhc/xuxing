// 命令层 Run 事件派发的唯一入口（S3-①）。
//
// 背景：store 写路径的守卫层已由 Q15 F1 落地（流派生 from + 客观 fact）。本模块解决
// 「命令层仍可直调 append 写 Run* 事件、绕过矩阵校验」的缺口：
// - RunCreated 是「建 Run」而非状态迁移（§3.2 没有进入 created 的格），经 appendRunCreated
//   做创建校验（载荷形状 / run_kind / 重复创建），写后由事件流派生；
// - 其余 RunQueued/RunLeased/RunStarted/RunSucceeded/RunFailed/RunCanceled/RunTimedOut/
//   RunIndeterminate/RunReconciled 一律经 appendStateTransition(entity:'run')，
//   并在进入 guard 前校验「事件类型 ↔ 目标状态」一一对应（type 与 to 不得错配）。
//
// 审计：tests/run-dispatch-audit.test.ts 扫描 src/ 与 server/src/，除本文件外任何
// `.append(...)` 直写 Run* 事件都会让测试变红。

import type { EventEnvelope, EventType } from './events.js';
import type { AppendEventInput } from './event-store.js';
import { RUN_STATE_BY_EVENT } from './event-store-pg.js';
import type {
  AppendStateTransitionInput,
  AppendStateTransitionResult,
  PgEventStoreTx,
} from './event-store-pg.js';

export type RunKind = 'executor' | 'human_light';

/** Run 事件派发违规（类型用错入口 / type 与目标状态错配 / 载荷不合法）。 */
export class RunDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunDispatchError';
  }
}

/** 同一 stream 内重复创建同一个 Run（INV-4：重试必须建新 Run）。 */
export class RunAlreadyCreatedError extends Error {
  readonly run_id: string;
  constructor(run_id: string) {
    super(`Run ${run_id} 已存在（INV-4：重试必须新建 Run，不得复用旧 Run 记录）`);
    this.name = 'RunAlreadyCreatedError';
    this.run_id = run_id;
  }
}

export interface AppendRunCreatedInput extends AppendEventInput {
  /** 可显式声明运行形态；必须与 payload.run_kind 一致（不一致即拒绝，不静默择一）。 */
  run_kind?: RunKind;
}

function asPayloadRecord(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RunDispatchError('RunCreated.payload 必须是 plain object（spec §4 事件信封）');
  }
  return payload as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RunDispatchError(`RunCreated.payload.${field} 必须是非空字符串`);
  }
  return value;
}

/** 建 Run 的唯一入口：校验载荷与 run_kind，重复创建拒绝，之后由 append 落库。 */
export async function appendRunCreated(
  store: PgEventStoreTx,
  input: AppendRunCreatedInput,
): Promise<EventEnvelope> {
  if (input.type !== 'RunCreated') {
    throw new RunDispatchError(
      `appendRunCreated 只接受 RunCreated，收到 ${input.type}；状态迁移请用 appendRunTransition`,
    );
  }

  const payload = asPayloadRecord(input.payload);
  const run_id = requireNonEmptyString(payload.run_id, 'run_id');

  const declared = input.run_kind;
  const fromPayload = payload.run_kind;
  if (declared !== undefined && fromPayload !== undefined && declared !== fromPayload) {
    throw new RunDispatchError(
      `run_kind 与 payload.run_kind 不一致：入参=${declared}，payload=${String(fromPayload)}`,
    );
  }
  const run_kind = (declared ?? fromPayload ?? 'executor') as unknown;
  if (run_kind !== 'executor' && run_kind !== 'human_light') {
    throw new RunDispatchError(
      `RunCreated.payload.run_kind 必须是 executor|human_light，收到 ${JSON.stringify(run_kind)}`,
    );
  }

  const existing = await store.readStream(input.stream_id);
  const duplicated = existing.some(
    (event) => event.type === 'RunCreated' && (event.payload as Record<string, unknown> | null)?.run_id === run_id,
  );
  if (duplicated) throw new RunAlreadyCreatedError(run_id);

  return store.append({ ...input, payload: { ...payload, run_kind } });
}

/**
 * Run 状态迁移的唯一入口：先校验「事件类型 ↔ 目标状态」，再交给
 * appendStateTransition(entity:'run')（流派生 from + §3.2 / REQ-HUM-1 矩阵 + 客观 fact）。
 */
export async function appendRunTransition(
  store: PgEventStoreTx,
  input: AppendStateTransitionInput,
): Promise<AppendStateTransitionResult> {
  if (input.entity !== undefined && input.entity !== 'run') {
    throw new RunDispatchError(
      `appendRunTransition 只派发 Run 状态迁移（收到 entity=${input.entity}）`,
    );
  }
  if (input.type === 'RunCreated') {
    throw new RunDispatchError('RunCreated 不是状态迁移：请用 appendRunCreated');
  }

  const target = RUN_STATE_BY_EVENT[input.type as EventType];
  if (target === undefined) {
    throw new RunDispatchError(
      `事件类型 ${input.type} 不是 Run 状态事件（§4）；Run 状态迁移只接受 Run* 状态事件`,
    );
  }
  if (target !== input.to) {
    throw new RunDispatchError(
      `事件类型与目标状态错配：${input.type} 只能迁入 ${target}，收到 to=${input.to}`,
    );
  }

  return store.appendStateTransition({ ...input, entity: 'run' });
}
