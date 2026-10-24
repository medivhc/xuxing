// PG Event Store —— 确定性事件溯源的写入与读取路径（spec §4 / INV-12 / INV-13）。
//
// 编码与并发约定（spec §4 / §8.2；Q1/Q2/Q5 见 §9 已裁决）：
// - 哈希：H = sha256，输入逐字节为
//     prev_hash_hex + 0x1F + payload_canonical + 0x1F + decimal(seq)
//   genesis prev_hash = 64 个 '0'；输出小写 hex。golden vector 已冻结在测试中。
// - payload_canonical = 键按 UTF-16 code unit 升序递归排序的 JSON；数组保序；
//   拒绝 undefined/function/symbol/bigint/NaN/Infinity（抛 CanonicalizationError）。
//   哈希与链校验一律用 payload_canonical 列（jsonb 会做数值归一化，不能作为哈希输入）。
// - idempotency_key 唯一域 = (stream_id, key)（per-stream）；同 key 不同内容抛
//   IdempotencyKeyConflictError，同 key 相同内容返回首次结果（INV-13）。
// - seq 原子分配：每 stream 一行 event_streams 作为链头，SELECT … FOR UPDATE 串行化同
//   stream 追加；UNIQUE(stream_id, seq) 兜底命中即 StoreInvariantError（大声失败，不重试）。
// - 提交序护栏（S5 / Q5）：所有事件写在分配 seq 前取事务级咨询锁并持有到提交，
//   因此「可见的最大 global_seq」不会越过任何未提交事件 —— 增量消费的水位由它定义。
//   代价是写路径全局串行（K0 §7 量级下无感；跨 stream 并行写入降为串行）。
// - replay 用单条 SELECT（单快照）按 global_seq 重演；global_seq 允许空洞（回滚跳号），
//   只保证单调。增量消费见 tailing 方法（水位落库 + 投递幂等键）。
// - occurred_at 由注入时钟提供（store 接口无该参数，见假设 A8）。
// - 状态迁移写路径（appendStateTransition）：
//   ① 事件类型必须属于 entity 家族（spec §4）且与 from→to 格匹配（F6）；
//   ② 期望 from 由事件流当前状态派生（F1），入参 from 不一致即拒；
//   ③ payload.from/to 与顶层一致（缺失补齐、矛盾拒绝），TaskLifecycleChanged 必须带
//      trigger_event_id（F7）；
//   ④ guard 的客观 fact（Outcome/取消意图/Run 终态/wait_state/duplicate）从事件流派生并
//      覆盖调用方自述（F3/F4/F5）；
//   ⑤ 迁入 accepted/canceled 时 INV-11 / REQ-RUN-6 收尾事件由内核在同一事务内自动落库，
//      调用方无法忽略（F2/F4）；通用 append 路径禁止直写终态迁移，堵死绕过口。
// - 跨事务批量：appendBatch 在**同一事务**内按序写入同一 stream（Q4）；非法形状在开事务前
//   拒绝，guard 拒绝则整批回滚；withTransaction 提供显式同事务入口。
// - 增量消费：append 事务持全局追加锁（提交序 = global_seq 序），水位见 tailing.ts（Q5）。

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ulid } from 'ulid';
import type { EventEnvelope, EventType, ProjectId } from './events.js';
import { EVENT_TYPES } from './events.js';
import type {
  AppendBatchEntryInput,
  AppendBatchResult,
  AppendEventInput,
  EventStore,
} from './event-store.js';

export type {
  AppendBatchEntryInput,
  AppendBatchResult,
  AppendEventInput,
} from './event-store.js';
import {
  RUN_STATES,
  TASK_STATES,
  guardTransition,
  guardTransitionReplay,
  guardWaitStateChange,
  isMatrixCellAllowed,
  type GuardEffect,
  type GuardFacts,
  type GuardResult,
} from './transition-guard.js';
import type { RunState, TaskLifecycle, TaskWaitState } from '../domain/types.js';
import {
  ActorValidationError,
  ToolOutputChannelError,
  isEvidenceSourceKind,
  validateActorIdentity,
} from './actor-guard.js';


export const GENESIS_HASH = '0'.repeat(64);

// ---------------------------------------------------------------------------
// 错误类型（全部 typed、不被吞掉）
// ---------------------------------------------------------------------------

/** payload 含不可规范化值（undefined/function/symbol/bigint/NaN/Infinity 等）。 */
export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

/** 事件类型不在 spec §4 封闭集内（不静默丢弃）。 */
export class UnknownEventTypeError extends Error {
  readonly type: string;
  constructor(type: string) {
    super(`未知事件类型：${type}（事件目录是封闭集，新增类型须走 spec 修订）`);
    this.name = 'UnknownEventTypeError';
    this.type = type;
  }
}

/** 幂等冲突时已存在事件的定位（pF8：报错必须能直接定位到冲突事件，而不是只报 key）。 */
export interface IdempotencyConflictExisting {
  event_id: string;
  seq: number;
  global_seq: number;
  type: string;
}

/** 同 (stream_id, key) 已有事件且内容不同 —— 客户端 bug，不能伪装成重放。 */
export class IdempotencyKeyConflictError extends Error {
  readonly stream_id: string;
  readonly idempotency_key: string;
  /** 已存在事件的定位（event_id/seq/global_seq/type）；拿不到既有行时为 null（pF8）。 */
  readonly existing: IdempotencyConflictExisting | null;
  /** 冲突定位（杂-2③）：既有事件 id 与不一致字段清单（与 existing 并存的视图）。 */
  readonly existing_event_id: string | null;
  readonly conflicting_fields: string[];
  constructor(
    stream_id: string,
    idempotency_key: string,
    location:
      | IdempotencyConflictExisting
      | {
          existing?: IdempotencyConflictExisting | null;
          existing_event_id?: string | null;
          conflicting_fields?: string[];
        }
      | null = {},
  ) {
    const direct =
      location !== null && 'event_id' in location ? (location as IdempotencyConflictExisting) : null;
    const bag = direct === null ? (location ?? {}) : {};
    const existing = direct ?? ('existing' in bag ? (bag.existing ?? null) : null);
    const existing_event_id =
      existing?.event_id ?? ('existing_event_id' in bag ? (bag.existing_event_id ?? null) : null);
    const conflicting_fields = 'conflicting_fields' in bag ? (bag.conflicting_fields ?? []) : [];
    super(
      `idempotency_key 冲突：stream=${stream_id} key=${idempotency_key} 已存在不同内容的事件（A3：同 key 不同内容视为错误）` +
        (existing !== null
          ? `；已存在事件定位：event_id=${existing.event_id} seq=${existing.seq} global_seq=${existing.global_seq} type=${existing.type}`
          : '') +
        (existing_event_id !== null ? ` existing_event_id=${existing_event_id}` : '') +
        (conflicting_fields.length > 0 ? ` 冲突字段=${conflicting_fields.join(',')}` : ''),
    );
    this.name = 'IdempotencyKeyConflictError';
    this.stream_id = stream_id;
    this.idempotency_key = idempotency_key;
    this.existing = existing;
    this.existing_event_id = existing_event_id;
    this.conflicting_fields = conflicting_fields;
  }
}

/** 由事件行/信封构造冲突定位（bigint 字段统一过 toSafeNumber）。 */
function conflictExistingOf(source: {
  id: string;
  seq: string | number;
  global_seq: string | number;
  type: string;
}): IdempotencyConflictExisting {
  return {
    event_id: source.id,
    seq: toSafeNumber(source.seq, 'events.seq'),
    global_seq: toSafeNumber(source.global_seq, 'events.global_seq'),
    type: source.type,
  };
}

/** 存储不变量被破坏（seq 唯一约束命中、bigint 越界等）—— 立即失败，不用重试掩盖。 */
export class StoreInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreInvariantError';
  }
}

/** 迁移矩阵拒绝写入（校验器嵌在写路径上的证据）。 */
export class TransitionDeniedError extends Error {
  readonly result: GuardResult;
  constructor(result: GuardResult) {
    const missing = result.missing_facts?.length
      ? ` missing_facts=${result.missing_facts.map((hint) => hint.expected).join(',')}`
      : '';
    const expectedTypes = result.expected_event_types?.length
      ? ` expected_event_types=${result.expected_event_types.join('|')}`
      : '';
    const unknown = result.unknown_states?.length
      ? ` unknown=${result.unknown_states.map((u) => `${u.field}=${u.value}`).join(',')}`
      : '';
    super(
      `状态迁移被拒绝：${result.basis.spec_ref} ${result.basis.row}→${result.basis.col} ` +
        `reason=${result.reason ?? 'unknown'}${result.unmet?.length ? ` unmet=${result.unmet.join(',')}` : ''}` +
        missing + expectedTypes + unknown,
    );
    this.name = 'TransitionDeniedError';
    this.result = result;
  }
}

/** entity 与事件类型家族不符（如 entity:'task' 配 RunStarted）—— 拒绝写入，不静默落库。 */
export class EventEntityMismatchError extends Error {
  readonly entity: 'task' | 'run';
  readonly type: string;
  constructor(entity: 'task' | 'run', type: string) {
    super(
      `事件类型 ${type} 不属于 ${entity} 状态迁移事件家族（spec §4）。` +
        (entity === 'task'
          ? '生命周期迁移请用 appendStateTransition({entity:"task", type:"TaskLifecycleChanged"})；' +
            'wait_state 变更（TaskWaitStateChanged）与取消附随事件（TaskCanceled / WaitConditionCanceled）' +
            '请用 append 或 requestTaskCancellation，它们不走生命周期矩阵。'
          : 'Run 状态迁移请用 appendRunTransition(...)（内部 appendStateTransition({entity:"run"})）；' +
            '建 Run 用 appendRunCreated(...)。'),
    );
    this.name = 'EventEntityMismatchError';
    this.entity = entity;
    this.type = type;
  }
}

/** payload.from/to 与顶层 from/to 矛盾 —— 拒绝写入（否则 guard 判 A 迁移、落库写 B 迁移）。 */
export class TransitionPayloadMismatchError extends Error {
  readonly field: 'from' | 'to';
  readonly top_level: string;
  readonly payload_value: unknown;
  constructor(field: 'from' | 'to', top_level: string, payload_value: unknown) {
    super(
      `payload.${field} 与顶层 ${field} 矛盾：顶层=${JSON.stringify(top_level)}，` +
        `payload=${JSON.stringify(payload_value)}（spec §4 要求两处一致）`,
    );
    this.name = 'TransitionPayloadMismatchError';
    this.field = field;
    this.top_level = top_level;
    this.payload_value = payload_value;
  }
}

/** payload 形状无法承载 from/to（非 plain object）—— 拒绝写入。 */
export class TransitionPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransitionPayloadError';
  }
}

/** 通用 append 的 payload 必须是 plain object（F8：array/null/Date/Map 一律拒绝）。 */
export class PayloadNotPlainObjectError extends Error {
  readonly received: string;
  constructor(received: string) {
    super(
      `事件 payload 必须是 plain object（收到 ${received}）：` +
        `array/null/Date/Map 等无法作为事件事实（spec §4 事件信封）`,
    );
    this.name = 'PayloadNotPlainObjectError';
    this.received = received;
  }
}

/**
 * 终态迁移必须走 appendStateTransition（F2 的绕过口封堵）：
 * accepted/canceled 的 INV-11 / REQ-RUN-6 收尾必须与 lifecycle 迁移同事务，
 * 通用 append 直写会跳过收尾，因此拒绝。
 */
export class TerminalClosureRequiredError extends Error {
  readonly task_id: string;
  readonly to: string;
  constructor(task_id: string, to: string) {
    super(
      `Task ${task_id} 迁移到 ${to} 必须走 appendStateTransition（内核要在同一事务内执行 INV-11/REQ-RUN-6 收尾），` +
        `通用 append 直写会绕过收尾`,
    );
    this.name = 'TerminalClosureRequiredError';
    this.task_id = task_id;
    this.to = to;
  }
}

/**
 * S4-②（reverify-R2）：事务结果必须真实反映 COMMIT 状态。
 * fn 吞掉 SQL 错误后 PG 把事务置为 aborted，COMMIT 实际执行 ROLLBACK 且不抛错；
 * 不检查 command tag 就会「返回成功但零落库」。
 */
export class TransactionCommitError extends Error {
  readonly command: string | null;
  constructor(command: string | null) {
    super(
      `事务提交未成功：COMMIT 返回 ${command ?? '<无 command tag>'}（PG 对 aborted 事务会隐式 ROLLBACK）。` +
        `fn 内若吞掉了 SQL 错误，请重新抛出而不是继续 return`,
    );
    this.name = 'TransactionCommitError';
    this.command = command;
  }
}

/**
 * S4-①：事务进行中误用外层 store 写同一 stream 会因链头行锁自锁挂起。
 * 这里在写之前立即显式拒绝，把「静默挂起」变成「可定位的编程错误」。
 */
export class TransactionScopeError extends Error {
  readonly stream_id: string;
  constructor(stream_id: string) {
    super(
      `store 事务作用域误用：stream ${JSON.stringify(stream_id)} 已在 withTransaction 的 tx 内被写入；` +
        `事务内请只用 tx.append / tx.appendStateTransition（用外层 store 会等待自己持有的行锁而挂起）`,
    );
    this.name = 'TransactionScopeError';
    this.stream_id = stream_id;
  }
}

export type TransitionStateDenialReason =
  /** payload 里找不到 task_id / run_id，无法定位迁移主体。 */
  | 'subject_id_missing'
  /** 事件流里没有该主体的创建/生命周期事件。 */
  | 'subject_not_found'
  /** 入参 from 与事件流派生的当前状态不一致（F1 核心拒绝）。 */
  | 'from_mismatch'
  /** 流的最后一条生命周期事件自身不合法（payload.to 不在状态枚举内）。 */
  | 'stream_state_invalid'
  /** 已 accepted/canceled 的 Task 不允许再走取消路径（须另立 Task）。 */
  | 'task_already_terminal';

/**
 * F1：迁移与事件流当前状态不一致 —— 永远不按调用方自述的 from 落库。
 * 分类可区分：缺主体 id / 主体不存在 / from 不一致 / 流状态损坏 / 终态任务。
 */
export class TransitionStateError extends Error {
  readonly reason: TransitionStateDenialReason;
  readonly entity: 'task' | 'run';
  readonly subject_id: string | null;
  readonly expected_from: string | null;
  readonly provided_from: string | null;
  constructor(input: {
    reason: TransitionStateDenialReason;
    entity: 'task' | 'run';
    subject_id: string | null;
    expected_from?: string | null;
    provided_from?: string | null;
    detail?: string;
  }) {
    super(
      `状态迁移被拒绝（流状态）：entity=${input.entity} subject=${input.subject_id ?? '<missing>'} ` +
        `reason=${input.reason}` +
        (input.expected_from !== undefined ? ` expected_from=${input.expected_from}` : '') +
        (input.provided_from !== undefined ? ` provided_from=${input.provided_from}` : '') +
        (input.detail ? ` detail=${input.detail}` : ''),
    );
    this.name = 'TransitionStateError';
    this.reason = input.reason;
    this.entity = input.entity;
    this.subject_id = input.subject_id;
    this.expected_from = input.expected_from ?? null;
    this.provided_from = input.provided_from ?? null;
  }
}

// ---------------------------------------------------------------------------
// payload 规范化与哈希（具名导出，测试独立重算整条链）
// ---------------------------------------------------------------------------

function encodeCanonical(value: unknown, stack: Set<object> = new Set()): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`不可规范化的数值：${String(value)}`);
      }
      // JSON.stringify 生成短表示：1.0→"1"、1e2→"100"、-0→"0"
      return JSON.stringify(value);
    }
    case 'object': {
      if (stack.has(value)) {
        throw new CanonicalizationError('不可规范化的循环引用（payload 必须是无环数据）');
      }

      if (Array.isArray(value)) {
        // 稀疏数组的 hole 会被 JSON.stringify 静默写成 null，必须显式拒绝。
        // 同时拒绝 symbol key 与非枚举自有属性（JSON.stringify 会静默忽略）。
        if (Object.getOwnPropertySymbols(value).length > 0) {
          throw new CanonicalizationError('数组含 symbol key，无法规范化');
        }
        const names = Object.getOwnPropertyNames(value);
        for (const name of names) {
          if (name === 'length') continue;
          const index = Number(name);
          if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== name) {
            throw new CanonicalizationError(`数组含非索引自有属性 ${JSON.stringify(name)}，无法规范化`);
          }
        }

        stack.add(value);
        try {
          const parts: string[] = [];
          for (let index = 0; index < value.length; index += 1) {
            // hole（或非枚举索引）不能当作 null 悄悄写入哈希
            if (!Object.prototype.propertyIsEnumerable.call(value, index)) {
              throw new CanonicalizationError(`稀疏数组存在 hole：index ${index}，无法规范化`);
            }
            parts.push(encodeCanonical(value[index], stack));
          }
          return `[${parts.join(',')}]`;
        } finally {
          stack.delete(value);
        }
      }

      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalizationError(
          `只接受 plain object / array / 原始值，收到 ${Object.prototype.toString.call(value)}`,
        );
      }

      // symbol key / 非枚举 key 会被 JSON.stringify 静默忽略，这里显式拒绝。
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new CanonicalizationError('对象含 symbol key，无法规范化');
      }
      const enumerableNames = Object.keys(value);
      const allNames = Object.getOwnPropertyNames(value);
      if (allNames.length !== enumerableNames.length) {
        const hidden = allNames.find((name) => !Object.prototype.propertyIsEnumerable.call(value, name));
        throw new CanonicalizationError(
          `对象含不可枚举自有属性 ${JSON.stringify(hidden ?? '<unknown>')}，无法规范化`,
        );
      }

      const record = value as Record<string, unknown>;
      // 默认 sort 即为 UTF-16 code unit 升序（不能用 localeCompare）
      const keys = [...enumerableNames].sort();
      stack.add(value);
      try {
        return `{${keys
          .map((key) => `${JSON.stringify(key)}:${encodeCanonical(record[key], stack)}`)
          .join(',')}}`;
      } finally {
        stack.delete(value);
      }
    }
    default:
      // undefined / function / symbol / bigint
      throw new CanonicalizationError(`不可规范化的值类型：${typeof value}`);
  }
}

/** 键排序的规范 JSON —— 哈希的唯一权威输入。 */
export function canonicalJson(value: unknown): string {
  return encodeCanonical(value);
}

/**
 * spec INV-12 的 H 编码（Q1 裁决 A2，已冻结）：
 * sha256(prev_hash_hex ‖ 0x1F ‖ payload_canonical ‖ 0x1F ‖ decimal(seq))。
 */
export function computeEventHash(
  prev_hash: string,
  payload_canonical: string,
  seq: number,
): string {
  return createHash('sha256')
    .update(Buffer.concat([
      Buffer.from(prev_hash, 'utf8'),
      Buffer.from([0x1f]),
      Buffer.from(payload_canonical, 'utf8'),
      Buffer.from([0x1f]),
      Buffer.from(String(seq), 'utf8'),
    ]))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// DDL（幂等 IF NOT EXISTS；INV-12 链头与唯一约束）
// ---------------------------------------------------------------------------

const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS event_streams (
     stream_id  text PRIMARY KEY,
     last_seq   bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
     last_hash  text   NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     global_seq        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     id                text NOT NULL UNIQUE,
     stream_id         text NOT NULL REFERENCES event_streams(stream_id),
     seq               bigint NOT NULL CHECK (seq > 0),
     type              text NOT NULL,
     actor_id          text NOT NULL,
     actor_kind        text NOT NULL CHECK (actor_kind IN ('human','agent','system','external')),
     causation_id      text,
     correlation_id    text NOT NULL,
     idempotency_key   text,
     payload           jsonb NOT NULL,
     payload_canonical text NOT NULL,
     prev_hash         text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
     hash              text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
     occurred_at       timestamptz NOT NULL,
     recorded_at       timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT events_stream_seq_uq UNIQUE (stream_id, seq)
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS events_stream_idem_uq
     ON events (stream_id, idempotency_key)
     WHERE idempotency_key IS NOT NULL`,
  `CREATE OR REPLACE FUNCTION events_forbid_mutation() RETURNS trigger
     LANGUAGE plpgsql AS $$
     BEGIN
       RAISE EXCEPTION 'events is append-only (INV-12)';
     END $$`,
  `DROP TRIGGER IF EXISTS events_no_mutation ON events`,
  `CREATE TRIGGER events_no_mutation BEFORE UPDATE OR DELETE ON events
     FOR EACH ROW EXECUTE FUNCTION events_forbid_mutation()`,
  // F16：TRUNCATE 不触发行级触发器，必须用语句级 TRUNCATE 触发器一并封堵。
  `DROP TRIGGER IF EXISTS events_no_truncate ON events`,
  `CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON events
     FOR EACH STATEMENT EXECUTE FUNCTION events_forbid_mutation()`,
  // S5：增量消费水位（落库，进程重启后恢复）与投递幂等键。
  `CREATE TABLE IF NOT EXISTS consumer_watermarks (
     consumer_id     text PRIMARY KEY,
     last_global_seq bigint NOT NULL DEFAULT 0 CHECK (last_global_seq >= 0),
     updated_at      timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS consumer_deliveries (
     consumer_id      text NOT NULL,
     event_id         text NOT NULL,
     event_global_seq bigint NOT NULL,
     delivered_at     timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (consumer_id, event_id)
   )`,
];

/** 建表 + 触发器（幂等；重复调用安全）。 */
export async function migrate(pool: Pool): Promise<void> {
  for (const statement of DDL) {
    await pool.query(statement);
  }
}

// ---------------------------------------------------------------------------
// 行映射
// ---------------------------------------------------------------------------

interface EventRow {
  global_seq: string;
  id: string;
  stream_id: string;
  seq: string;
  type: string;
  actor_id: string;
  actor_kind: EventEnvelope['actor_kind'];
  causation_id: string | null;
  correlation_id: string;
  idempotency_key: string | null;
  payload: unknown;
  payload_canonical: string;
  prev_hash: string;
  hash: string;
  occurred_at: Date | string;
  recorded_at: Date | string;
}

/** bigint 读回是字符串：显式 Number() 并断言安全整数，越界抛错（不静默截断）。 */
function toSafeNumber(value: string | number, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new StoreInvariantError(`${label} 超出 JS 安全整数范围：${String(value)}`);
  }
  return parsed;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToEnvelope(row: EventRow): EventEnvelope {
  return {
    id: row.id,
    stream_id: row.stream_id as ProjectId,
    seq: toSafeNumber(row.seq, 'events.seq'),
    global_seq: toSafeNumber(row.global_seq, 'events.global_seq'),
    type: row.type as EventType,
    actor_id: row.actor_id,
    actor_kind: row.actor_kind,
    causation_id: row.causation_id,
    correlation_id: row.correlation_id,
    idempotency_key: row.idempotency_key,
    // 用落库的 canonical 文本还原 payload：保证「读回 → 再规范化」与哈希输入逐字节一致
    payload: JSON.parse(row.payload_canonical) as unknown,
    prev_hash: row.prev_hash,
    hash: row.hash,
    occurred_at: toIso(row.occurred_at),
    recorded_at: toIso(row.recorded_at),
  };
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

/**
 * F15：幂等 key 的「同内容」定义 = type + payload + actor_id + actor_kind +
 * correlation_id + causation_id。任一不同都视为同 key 不同内容，拒绝静默返回首次事件。
 */
function idempotencyConflictFields(
  existing: {
    type: string;
    payload_canonical: string;
    actor_id: string;
    actor_kind: EventEnvelope['actor_kind'];
    causation_id: string | null;
    correlation_id: string;
  },
  input: AppendEventInput,
  payload_canonical: string,
): string[] {
  const fields: string[] = [];
  if (existing.type !== input.type) fields.push('type');
  if (existing.payload_canonical !== payload_canonical) fields.push('payload');
  if (existing.actor_id !== input.actor_id) fields.push('actor_id');
  if (existing.actor_kind !== input.actor_kind) fields.push('actor_kind');
  if (existing.correlation_id !== input.correlation_id) fields.push('correlation_id');
  if (existing.causation_id !== input.causation_id) fields.push('causation_id');
  return fields;
}

// ---------------------------------------------------------------------------
// 工厂与接口
// ---------------------------------------------------------------------------

export interface PgEventStoreOptions {
  /** 注入时钟（occurred_at）；测试可固定，业务代码不散落 Date.now()。 */
  clock?: () => Date;
  /** 注入 id 工厂（默认 ULID），测试可固定 id。 */
  idFactory?: () => string;
  /**
   * S3-②（F13 残留）：默认要求流的首条事件是 ProjectCreated（spec §4 / INV-12：stream = Project）。
   * 仅 store 机制测试（哈希链/幂等/并发）需要「无 ProjectCreated 的局部流」时显式关闭；
   * 生产入口（server / seed / journeys）不得关闭。
   */
  requireProjectCreated?: boolean;
}

export type AppendStateTransitionInput = AppendEventInput & {
  entity?: 'task' | 'run';
  from: string;
  to: string;
  facts?: GuardFacts;
  /** F7：TaskLifecycleChanged 的触发事件 id；缺省时回落到信封 causation_id。 */
  trigger_event_id?: string;
};

/** appendBatch 的单条结果：迁移条目带 guard 与收尾证据；普通事件只在 events 里。 */
export interface AppendBatchTransitionResult extends AppendStateTransitionResult {}

export interface PgAppendBatchResult extends AppendBatchResult {
  /** 按条目顺序记录的迁移结果（普通事件条目不占位）。 */
  transitions: AppendBatchTransitionResult[];
}

/** appendBatch 的使用错误（空批次 / 跨 stream / from-to 只给一半）——编程错误，不静默。 */
export class AppendBatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppendBatchError';
  }
}

/** F2/F4 收尾动作的落库证据（与 lifecycle 迁移同事务）。 */
export interface TransitionClosure {
  wait_conditions_canceled: string[];
  wait_state_reset_from: TaskWaitState | null;
  decisions_expired: string[];
  assignments_ended: string[];
  /** REQ-RUN-6③：TaskCanceled 事件的 id（accepted 迁移为 null）。 */
  task_canceled_event_id: string | null;
  /** 实际执行的收尾动作（按序）。 */
  effects_applied: GuardEffect[];
}

export interface AppendStateTransitionResult {
  event: EventEnvelope;
  guard: GuardResult;
  /** 终态迁移的收尾结果；非终态为 null。 */
  closure: TransitionClosure | null;
}

/**
 * 状态迁移事件家族（spec §4）：
 * - Task 生命周期迁移的唯一事件是 TaskLifecycleChanged（payload 带 from/to）；
 * - Run 的状态变迁分散为 Run* 事件，不含其它 Task 事件。
 * 用显式集合而非前缀匹配：TaskWaitStateChanged 也以 Task 开头，但它不走生命周期矩阵。
 */
const TASK_TRANSITION_EVENT_TYPES: readonly EventType[] = ['TaskLifecycleChanged'];
const RUN_TRANSITION_EVENT_TYPES: readonly EventType[] = [
  'RunCreated',
  'RunQueued',
  'RunLeased',
  'RunStarted',
  'RunSucceeded',
  'RunFailed',
  'RunCanceled',
  'RunTimedOut',
  'RunIndeterminate',
  'RunReconciled',
];

function assertTransitionEventType(entity: 'task' | 'run', type: string): void {
  const family = entity === 'task' ? TASK_TRANSITION_EVENT_TYPES : RUN_TRANSITION_EVENT_TYPES;
  if (!family.includes(type as EventType)) {
    throw new EventEntityMismatchError(entity, type);
  }
}

/**
 * §4 / INV-12：事件流的 stream_id 恒为 project_id。
 * 把 task_id/run_id 等主体 id 当 stream_id 会破坏按 Project 重演与投影边界，必须拒绝。
 */
export class ProjectStreamRequiredError extends Error {
  readonly stream_id: string;
  constructor(stream_id: string, detail: string) {
    super(
      `stream_id 必须是 project_id（spec §4 / INV-12），收到 ${JSON.stringify(stream_id)}：${detail}`,
    );
    this.name = 'ProjectStreamRequiredError';
    this.stream_id = stream_id;
  }
}

/**
 * S3-②（F13 残留）：流内必须有 ProjectCreated 事实才能承载后续事件。
 * 品牌类型与撞值校验只能保证「看起来像 project_id」，不能证明项目真的被创建过。
 */
export class ProjectCreatedRequiredError extends Error {
  readonly stream_id: string;
  readonly type: string;
  constructor(stream_id: string, type: string) {
    super(
      `stream ${JSON.stringify(stream_id)} 尚无 ProjectCreated 事实：拒绝写入 ${type}。` +
        `事件流按 Project 划分（spec §4 / INV-12），建流的第一条事件必须是 ProjectCreated`,
    );
    this.name = 'ProjectCreatedRequiredError';
    this.stream_id = stream_id;
    this.type = type;
  }
}

// ---------------------------------------------------------------------------
// payload 形状（F8：通用 append 只接受 plain object）
// ---------------------------------------------------------------------------

function describePayloadShape(payload: unknown): string {
  if (payload === null) return 'null';
  if (Array.isArray(payload)) return 'array';
  if (payload instanceof Date) return 'Date';
  if (payload instanceof Map) return 'Map';
  if (payload instanceof Set) return 'Set';
  if (typeof payload !== 'object') return typeof payload;
  return Object.prototype.toString.call(payload);
}

function isPlainObject(payload: unknown): payload is Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const proto = Object.getPrototypeOf(payload);
  return proto === Object.prototype || proto === null;
}

/** payload 中可能出现的主体 id 字段：这些值绝不能同时充当 stream_id（INV-12）。 */
const SUBJECT_ID_FIELDS = [
  'task_id',
  'run_id',
  'wait_condition_id',
  'decision_id',
  'assignment_id',
  'outcome_id',
  'feedback_id',
  'evidence_id',
  'goal_id',
  'plan_change_id',
  'release_override_id',
] as const;

/**
 * F13：运行时兜底 —— branded ProjectId 只管编译期，JS/反序列化输入仍需校验：
 * 非空、不等于 payload 中任一主体 id、若 payload 自带 project_id 则必须一致。
 */
function assertProjectStreamId(stream_id: string, payload: Record<string, unknown>): void {
  if (stream_id.trim().length === 0) {
    throw new ProjectStreamRequiredError(stream_id, 'project_id 不能为空');
  }
  for (const field of SUBJECT_ID_FIELDS) {
    const value = payload[field];
    if (typeof value === 'string' && value === stream_id) {
      throw new ProjectStreamRequiredError(
        stream_id,
        `该值同时是 payload.${field}；事件流按 Project 划分，禁止用主体 id 建流`,
      );
    }
  }
  const declaredProject = payload.project_id;
  if (typeof declaredProject === 'string' && declaredProject !== stream_id) {
    throw new ProjectStreamRequiredError(
      stream_id,
      `与 payload.project_id=${JSON.stringify(declaredProject)} 不一致（stream 必须等于 Project id）`,
    );
  }
}

// ---------------------------------------------------------------------------
// F1：从事件流派生当前状态（appendStateTransition 的唯一 from 来源）
// ---------------------------------------------------------------------------

const DERIVED_EVENT_TYPES: readonly EventType[] = [
  'TaskCaptured',
  'TaskLifecycleChanged',
  'TaskWaitStateChanged',
  'TaskCancelRequested',
  'TaskDuplicateSuspected',
  'TaskDuplicateResolved',
  'OutcomeRecorded',
  'WaitConditionCreated',
  'WaitConditionCanceled',
  'WaitConditionSatisfied',
  'WaitConditionExpired',
  'DecisionCreated',
  'DecisionResolved',
  'DecisionExpired',
  'AssignmentCreated',
  'AssignmentEnded',
  'RunCreated',
  'RunQueued',
  'RunLeased',
  'RunStarted',
  'RunSucceeded',
  'RunFailed',
  'RunCanceled',
  'RunTimedOut',
  'RunIndeterminate',
];

/** Run 事件 → 它把 Run 迁入的目标状态（S3-①：命令层用同一张表校验 type ↔ to）。 */
export const RUN_STATE_BY_EVENT: Partial<Record<EventType, RunState>> = {
  RunCreated: 'created',
  RunQueued: 'queued',
  RunLeased: 'leased',
  RunStarted: 'running',
  RunSucceeded: 'succeeded',
  RunFailed: 'failed',
  RunCanceled: 'canceled',
  RunTimedOut: 'timed_out',
  RunIndeterminate: 'indeterminate',
};

const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set([
  'succeeded', 'failed', 'canceled', 'timed_out',
]);

type RunKind = 'executor' | 'human_light';

interface RunFactsRow {
  run_id: string;
  task_id: string | null;
  state: RunState;
  /** 是否出现过 RunStarted（REQ-RUN-4 的「已启动」判据）。 */
  started: boolean;
  /** REQ-HUM-1：运行形态（缺省 executor）。由 RunCreated.payload.run_kind 派生。 */
  run_kind: RunKind;
}

interface WaitConditionFactsRow {
  id: string;
  task_id: string | null;
  active: boolean;
  /** REQ-SCH-3：定时器持久化在事件里（due_at），Scheduler 从流恢复。 */
  due_at: string | null;
}

interface DecisionFactsRow {
  id: string;
  /** Decision.subject_ref；取消级联覆盖该 Task 的 pending Decision。 */
  subject_ref: string | null;
  task_id: string | null;
  pending: boolean;
}

interface AssignmentFactsRow {
  id: string;
  task_id: string | null;
  active: boolean;
}

interface StreamFacts {
  /** 最后一条生命周期事件派生的 Task.lifecycle（F1 的期望 from）。 */
  taskLifecycle: Map<string, string>;
  taskWaitState: Map<string, TaskWaitState>;
  taskCancelRequested: Set<string>;
  taskDuplicateSuspect: Set<string>;
  outcomesByTask: Set<string>;
  runs: Map<string, RunFactsRow>;
  waitConditions: Map<string, WaitConditionFactsRow>;
  decisions: Map<string, DecisionFactsRow>;
  assignments: Map<string, AssignmentFactsRow>;
}

function payloadField(payload: unknown, field: string): string | null {
  if (!isPlainObject(payload)) return null;
  const value = payload[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function payloadId(payload: unknown, preferred: string): string | null {
  return payloadField(payload, preferred) ?? payloadField(payload, 'id');
}

function requirePayloadId(type: string, payload: unknown, preferred: string): string {
  const id = payloadId(payload, preferred);
  if (id === null) {
    throw new StoreInvariantError(`${type} 事件缺少 ${preferred}，无法派生流状态`);
  }
  return id;
}

/**
 * 单条 SELECT 读出该 stream 中参与状态派生的全部事件，按 seq 升序在内存折叠。
 * 规模假设见 spec §7（单 Project ≤500 Task），一次流内扫描可接受；
 * 若未来击穿假设，改为按 subject 索引查询（需在 DDL 增加表达式索引）。
 */
async function deriveStreamFacts(
  reader: Pool | PoolClient,
  stream_id: string,
): Promise<StreamFacts> {
  const facts: StreamFacts = {
    taskLifecycle: new Map(),
    taskWaitState: new Map(),
    taskCancelRequested: new Set(),
    taskDuplicateSuspect: new Set(),
    outcomesByTask: new Set(),
    runs: new Map(),
    waitConditions: new Map(),
    decisions: new Map(),
    assignments: new Map(),
  };

  const { rows } = await reader.query<{ type: string; payload: unknown }>(
    `SELECT type, payload FROM events
     WHERE stream_id = $1 AND type = ANY($2::text[])
     ORDER BY seq ASC`,
    [stream_id, DERIVED_EVENT_TYPES],
  );

  for (const row of rows) {
    const type = row.type as EventType;
    const payload = row.payload;

    switch (type) {
      case 'TaskCaptured': {
        const task_id = requirePayloadId(type, payload, 'task_id');
        facts.taskLifecycle.set(task_id, 'captured');
        if (!facts.taskWaitState.has(task_id)) facts.taskWaitState.set(task_id, 'none');
        break;
      }
      case 'TaskLifecycleChanged': {
        const task_id = requirePayloadId(type, payload, 'task_id');
        const to = payloadField(payload, 'to');
        if (to === null) {
          throw new StoreInvariantError(
            `TaskLifecycleChanged 缺少 payload.to（task=${task_id}），流状态无法派生`,
          );
        }
        facts.taskLifecycle.set(task_id, to);
        break;
      }
      case 'TaskWaitStateChanged': {
        const task_id = requirePayloadId(type, payload, 'task_id');
        const to = payloadField(payload, 'to');
        if (to !== null) facts.taskWaitState.set(task_id, to as TaskWaitState);
        break;
      }
      case 'TaskCancelRequested':
        facts.taskCancelRequested.add(requirePayloadId(type, payload, 'task_id'));
        break;
      case 'TaskDuplicateSuspected':
        facts.taskDuplicateSuspect.add(requirePayloadId(type, payload, 'task_id'));
        break;
      case 'TaskDuplicateResolved':
        facts.taskDuplicateSuspect.delete(requirePayloadId(type, payload, 'task_id'));
        break;
      case 'OutcomeRecorded':
        facts.outcomesByTask.add(requirePayloadId(type, payload, 'task_id'));
        break;
      case 'WaitConditionCreated': {
        const id = requirePayloadId(type, payload, 'wait_condition_id');
        facts.waitConditions.set(id, {
          id,
          task_id: payloadField(payload, 'task_id'),
          active: true,
          due_at: payloadField(payload, 'due_at'),
        });
        break;
      }
      case 'WaitConditionCanceled':
      case 'WaitConditionSatisfied':
      case 'WaitConditionExpired': {
        const id = payloadId(payload, 'wait_condition_id');
        if (id === null) {
          throw new StoreInvariantError(`${type} 事件缺少 wait_condition_id`);
        }
        const existing = facts.waitConditions.get(id);
        if (existing) existing.active = false;
        else {
          facts.waitConditions.set(id, {
            id,
            task_id: payloadField(payload, 'task_id'),
            active: false,
            due_at: null,
          });
        }
        break;
      }
      case 'DecisionCreated': {
        const id = requirePayloadId(type, payload, 'decision_id');
        facts.decisions.set(id, {
          id,
          subject_ref: payloadField(payload, 'subject_ref'),
          task_id: payloadField(payload, 'task_id'),
          pending: true,
        });
        break;
      }
      case 'DecisionResolved':
      case 'DecisionExpired': {
        const id = payloadId(payload, 'decision_id');
        if (id === null) throw new StoreInvariantError(`${type} 事件缺少 decision_id`);
        const existing = facts.decisions.get(id);
        if (existing) existing.pending = false;
        else {
          facts.decisions.set(id, {
            id,
            subject_ref: payloadField(payload, 'subject_ref'),
            task_id: payloadField(payload, 'task_id'),
            pending: false,
          });
        }
        break;
      }
      case 'AssignmentCreated': {
        const id = requirePayloadId(type, payload, 'assignment_id');
        facts.assignments.set(id, {
          id,
          task_id: payloadField(payload, 'task_id'),
          active: true,
        });
        break;
      }
      case 'AssignmentEnded': {
        const id = payloadId(payload, 'assignment_id');
        if (id === null) throw new StoreInvariantError(`${type} 事件缺少 assignment_id`);
        const existing = facts.assignments.get(id);
        if (existing) existing.active = false;
        else {
          facts.assignments.set(id, {
            id,
            task_id: payloadField(payload, 'task_id'),
            active: false,
          });
        }
        break;
      }
      default: {
        const runState = RUN_STATE_BY_EVENT[type];
        if (runState === undefined) break;
        const run_id = requirePayloadId(type, payload, 'run_id');
        const existing = facts.runs.get(run_id);
        const started =
          (existing?.started ?? false) ||
          facts.runs.get(run_id)?.state === 'running' ||
          type === 'RunStarted';
        facts.runs.set(run_id, {
          run_id,
          task_id: existing?.task_id ?? payloadField(payload, 'task_id'),
          state: runState,
          started: started || runState === 'running',
          run_kind:
            existing?.run_kind
            ?? (payloadField(payload, 'run_kind') === 'human_light' ? 'human_light' : 'executor'),
        });
        break;
      }
    }
  }

  return facts;
}

function deriveTaskLifecycle(
  facts: StreamFacts,
  task_id: string,
): TaskLifecycle | null {
  const lifecycle = facts.taskLifecycle.get(task_id);
  if (lifecycle === undefined) return null;
  if (!(TASK_STATES as readonly string[]).includes(lifecycle)) {
    throw new TransitionStateError({
      reason: 'stream_state_invalid',
      entity: 'task',
      subject_id: task_id,
      expected_from: lifecycle,
      detail: `最后一条生命周期事件的 to=${lifecycle} 不在 Task 状态枚举内`,
    });
  }
  return lifecycle as TaskLifecycle;
}

/** 幂等重放路径的轻量查询：只取 RunCreated 的运行形态，不派生整条流（F2：不在重放路径求值 facts）。 */
async function deriveRunKind(
  reader: Pool | PoolClient,
  stream_id: string,
  run_id: string,
): Promise<RunKind> {
  const { rows } = await reader.query<{ run_kind: string | null }>(
    `SELECT payload->>'run_kind' AS run_kind FROM events
     WHERE stream_id = $1 AND type = 'RunCreated' AND payload->>'run_id' = $2
     LIMIT 1`,
    [stream_id, run_id],
  );
  return rows[0]?.run_kind === 'human_light' ? 'human_light' : 'executor';
}

function deriveRunState(facts: StreamFacts, run_id: string): RunFactsRow | null {
  const run = facts.runs.get(run_id);
  if (run === undefined) return null;
  if (!(RUN_STATES as readonly string[]).includes(run.state)) {
    throw new TransitionStateError({
      reason: 'stream_state_invalid',
      entity: 'run',
      subject_id: run_id,
      expected_from: run.state,
    });
  }
  return run;
}

function currentWaitState(facts: StreamFacts, task_id: string): TaskWaitState {
  return facts.taskWaitState.get(task_id) ?? 'none';
}

function runsOfTask(facts: StreamFacts, task_id: string): RunFactsRow[] {
  return [...facts.runs.values()].filter((run) => run.task_id === task_id);
}

function allRunsTerminalForTask(facts: StreamFacts, task_id: string): boolean {
  return runsOfTask(facts, task_id).every((run) => TERMINAL_RUN_STATES.has(run.state));
}

/**
 * F3/F4/F5：能从事件流客观判定的 fact，一律以派生值覆盖调用方自述。
 * 不能从本批事件流判定的（capability/policy/sideEffectLevel/心跳等）仍由调用方显式提供，
 * 缺失即 precondition_facts_missing（不默认放行）。
 */
function derivedTaskFacts(facts: StreamFacts, task_id: string): GuardFacts {
  return {
    waitStateNone: currentWaitState(facts, task_id) === 'none',
    duplicateSuspectFalse: !facts.taskDuplicateSuspect.has(task_id),
    runOutcomeRecorded: facts.outcomesByTask.has(task_id),
    cancellationRequested: facts.taskCancelRequested.has(task_id),
    allRunsTerminal: allRunsTerminalForTask(facts, task_id),
  };
}

function derivedRunFacts(facts: StreamFacts, run: RunFactsRow): GuardFacts {
  return {
    started: run.started,
    cancellationRequested:
      run.task_id !== null && facts.taskCancelRequested.has(run.task_id),
  };
}

function mergeFacts(caller: GuardFacts | undefined, derived: GuardFacts): GuardFacts {
  const merged: Record<string, unknown> = { ...(caller ?? {}) };
  for (const [key, value] of Object.entries(derived)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as GuardFacts;
}

function subjectIdFor(
  entity: 'task' | 'run',
  payload: Record<string, unknown>,
): string | null {
  return entity === 'task'
    ? payloadField(payload, 'task_id')
    : payloadField(payload, 'run_id');
}

/**
 * spec §4：payload 必须带 from/to，且与 guard 判定的顶层 from/to 一致。
 * - 缺失 → 用顶层值补齐（调用方只需写一份，落库形状仍然合规）；
 * - 存在但不一致 → TransitionPayloadMismatchError（不允许静默写出矛盾事件）。
 */
function mergeTransitionPayload(
  payload: unknown,
  from: string,
  to: string,
): Record<string, unknown> {
  if (!isPlainObject(payload)) {
    throw new TransitionPayloadError(
      `状态迁移事件的 payload 必须是 plain object（收到 ${describePayloadShape(payload)}），才能承载 from/to`,
    );
  }
  const merged: Record<string, unknown> = { ...payload };
  for (const field of ['from', 'to'] as const) {
    const expected = field === 'from' ? from : to;
    const actual = Object.hasOwn(payload, field) ? payload[field] : undefined;
    if (actual === undefined) {
      merged[field] = expected;
    } else if (actual !== expected) {
      throw new TransitionPayloadMismatchError(field, expected, actual);
    }
  }
  return merged;
}

/**
 * F7：spec §4 要求 TaskLifecycleChanged 的 payload 带「触发事件 id」。
 * 来源优先级：payload.trigger_event_id > 入参 trigger_event_id > 信封 causation_id。
 * 三者都没有 → 拒绝（不编造一个无意义的 id）。
 */
function withTransitionTrigger(
  payload: Record<string, unknown>,
  type: EventType,
  fallbackTriggerId: string | null,
  explicitTriggerId?: string,
): Record<string, unknown> {
  if (type !== 'TaskLifecycleChanged') return payload;

  const existing = payload.trigger_event_id;
  if (existing !== undefined) {
    if (typeof existing !== 'string' || existing.length === 0) {
      throw new TransitionPayloadError(
        'TaskLifecycleChanged.payload.trigger_event_id 必须是非空字符串（spec §4）',
      );
    }
    return payload;
  }

  const trigger = explicitTriggerId ?? fallbackTriggerId;
  if (typeof trigger !== 'string' || trigger.length === 0) {
    throw new TransitionPayloadError(
      'TaskLifecycleChanged.payload 必须带 trigger_event_id（触发事件 id，spec §4）：' +
        '可直接写入 payload.trigger_event_id，或提供 causation_id 供内核补齐',
    );
  }
  return { ...payload, trigger_event_id: trigger };
}

/** REQ-SCH-3：到期待触发的 WaitCondition（due_at 来自事件，不靠内存计时）。 */
export interface DueWaitCondition {
  stream_id: string;
  wait_condition_id: string;
  task_id: string | null;
  due_at: string;
}

/** S5：增量消费的一批事件与安全水位。 */
export interface TailingBatch {
  events: EventEnvelope[];
  /** 本批可推进到的安全水位（不越过任何未提交事件）；空批=当前水位不变。 */
  watermark: number;
  /** 本次是否被 limit 截断（还有更多待消费）。 */
  has_more: boolean;
}

export interface CommitDeliveriesInput {
  consumer_id: string;
  /** 消费到的 global_seq（单调推进；回退被忽略）。 */
  last_global_seq: number;
  /** 本批已处理事件 id：作为消费幂等键，重复提交不产生重复投递记录。 */
  event_ids: string[];
}

export interface CommitDeliveriesResult {
  new_deliveries: number;
  watermark: number;
}

/** 运维视图：全库流清单（listStreams；dashboard / 巡检用）。 */
export interface StreamSummary {
  stream_id: string;
  last_seq: number;
  last_hash: string;
  updated_at: string;
  event_count: number;
}

export interface ChainVerification {
  ok: boolean;
  stream_id: string;
  length: number;
  broken_at_seq: number | null;
  /** 断点位置（杂-1③）：events 行内 / 链头行本身；ok 为 null。 */
  broken_in: 'events' | 'stream_head' | null;
  reason: string | null;
  /** event_streams 是否有链头行：区分「不存在的 stream」与「健康的空流」。 */
  stream_exists: boolean;
}

/** REQ-RUN-6①：记取消意图（TaskCancelRequested）并级联收尾 Decision/Assignment。 */
export interface RequestTaskCancellationInput {
  stream_id: ProjectId;
  task_id: string;
  actor_id: string;
  actor_kind: EventEnvelope['actor_kind'];
  causation_id: string | null;
  correlation_id: string;
  idempotency_key: string | null;
  reason?: string;
}

export interface TaskCancellationResult {
  /** 本次新写入的 TaskCancelRequested；重复请求 / 已终态时为 null。 */
  cancel_requested: EventEnvelope | null;
  already_requested: boolean;
  /** 本次级联直接置 canceled 的未启动 Run 事件。 */
  runs_canceled: EventEnvelope[];
  /** 全部 Run 已终态并完成正式取消时的收尾证据；否则 null。 */
  closure: TransitionClosure | null;
  finalized: boolean;
  task_lifecycle: TaskLifecycle | null;
}

/** 事务内的 store 视图：append / appendStateTransition 共享调用方开启的同一 client 与事务。 */
export interface PgEventStoreTx extends EventStore {
  appendBatch(entries: AppendBatchEntryInput[]): Promise<PgAppendBatchResult>;
  /**
   * 校验器嵌在写路径：先按事件流派生期望 from（F1），再 guardTransition，
   * 拒绝则抛 TransitionDeniedError / TransitionStateError 且不写任何行。
   * 迁入 accepted/canceled 时同事务自动执行 INV-11 / REQ-RUN-6 收尾（F2/F4）。
   */
  appendStateTransition(input: AppendStateTransitionInput): Promise<AppendStateTransitionResult>;
  /** REQ-RUN-6 取消级联入口：意图 + Decision/Assignment 收尾 + 未启动 Run 取消。 */
  requestTaskCancellation(input: RequestTaskCancellationInput): Promise<TaskCancellationResult>;
  /** 读全流、用 payload_canonical 重算链，返回首个断点（不在 append/replay 热路径）。 */
  verifyChain(stream_id: ProjectId): Promise<ChainVerification>;
  /** S5：读消费水位（落库；不存在时为 0）。 */
  readWatermark(consumer_id: string): Promise<number>;
  /** S5：按水位取增量事件（单快照；水位不会越过未提交事件）。 */
  fetchAfterWatermark(input: { consumer_id: string; limit?: number }): Promise<TailingBatch>;
  /** S5：原子提交「消费到 last_global_seq」+ 投递幂等键（重复提交不重复入账）。 */
  commitDeliveries(input: CommitDeliveriesInput): Promise<CommitDeliveriesResult>;
  /** 运维：列出全部 stream 的链头与事件数。 */
  listStreams(): Promise<StreamSummary[]>;
  /** REQ-SCH-3：列出 due_at 已到且仍 active 的 WaitCondition（进程重启后由事件流恢复）。 */
  listDueWaitConditions(now: Date): Promise<DueWaitCondition[]>;
  /**
   * Tool Gateway 专用写入口（INV-6）：唯一可写 source_kind='tool_output' Evidence 的路径。
   * 凭据核验在 tool-gateway.ts 模块层完成；本入口只负责带网关标记的落盘，
   * 并在 payload 注入 recorded_via/gateway_id 审计字段。普通 append 写 tool_output 一律被拒。
   */
  appendToolOutputEvidence(
    input: Parameters<EventStore['append']>[0] & { gateway_id: string },
  ): Promise<EventEnvelope>;
}

export interface PgEventStore extends PgEventStoreTx {
  /**
   * 显式同事务入口：fn 内的 append / appendStateTransition 共享同一 client，
   * fn 抛错（或 COMMIT 失败）则整体回滚，零事件落库。
   *
   * 注意：INV-11/REQ-RUN-6 收尾已由 appendStateTransition 自行在同一事务内完成，
   * 调用方无需（也不应）再手工补发 WaitConditionCanceled / TaskWaitStateChanged。
   */
  withTransaction<T>(fn: (tx: PgEventStoreTx) => Promise<T>): Promise<T>;
}

const INSERT_EVENT_SQL = `
  INSERT INTO events
    (id, stream_id, seq, type, actor_id, actor_kind, causation_id, correlation_id,
     idempotency_key, payload, payload_canonical, prev_hash, hash, occurred_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)
  RETURNING global_seq, recorded_at`;

interface PreparedAppend {
  input: AppendEventInput;
  payload_canonical: string;
}

interface PrepareAppendOptions {
  /** 仅内核收尾路径可用：允许直接写 TaskLifecycleChanged→accepted/canceled。 */
  allowTerminalLifecycle?: boolean;
  /** 仅 Tool Gateway 专用入口可用（INV-6）：允许写 source_kind='tool_output' 的 EvidenceAdded。 */
  viaToolGateway?: boolean;
  /** 网关标识（viaToolGateway 时必填），注入 payload 作审计字段。 */
  gatewayId?: string;
}

/**
 * 写前校验（与事务无关，两种入口共用）：
 * 类型封闭集、payload 必须 plain object（F8）、TaskLifecycleChanged 的 from/to/trigger
 * 形状（F7）与格级纵深防御、payload 可规范化。
 */
function prepareAppend(
  input: AppendEventInput,
  options: PrepareAppendOptions = {},
): PreparedAppend {
  if (!(EVENT_TYPES as readonly string[]).includes(input.type)) {
    throw new UnknownEventTypeError(String(input.type));
  }

  // Q12/C6：actor 身份形状校验——缺失/空/类型错/kind 非枚举一律拒绝（零落盘）。
  validateActorIdentity(input.actor_id, input.actor_kind);

  // F8：通用 append 的 payload 一律要求 plain object（array/null/Date/Map 拒绝）。
  if (!isPlainObject(input.payload)) {
    throw new PayloadNotPlainObjectError(describePayloadShape(input.payload));
  }

  // F13：§4 / INV-12 —— stream 必须是 Project，不能是主体 id。
  assertProjectStreamId(input.stream_id, input.payload);

  // F2/F7：TaskLifecycleChanged 的形状与终态路径。
  // 这里只查矩阵格，不评估前置条件（前置条件由 appendStateTransition 负责）。
  if (input.type === 'TaskLifecycleChanged') {
    const payload = input.payload;
    const from = payload.from;
    const to = payload.to;
    if (typeof from !== 'string' || typeof to !== 'string') {
      throw new TransitionPayloadError(
        'TaskLifecycleChanged.payload 必须带 from/to（spec §4 派生规则），' +
          '否则无法重演生命周期迁移',
      );
    }
    const trigger = payload.trigger_event_id;
    if (typeof trigger !== 'string' || trigger.length === 0) {
      throw new TransitionPayloadError(
        'TaskLifecycleChanged.payload 必须带 trigger_event_id（触发事件 id，spec §4）',
      );
    }
    const check = isMatrixCellAllowed('task', from, to);
    if (!check.allowed) throw new TransitionDeniedError(check);

    // F2：accepted/canceled 的 INV-11 收尾必须与迁移同事务，通用 append 不得绕过。
    if (!options.allowTerminalLifecycle && (to === 'accepted' || to === 'canceled')) {
      throw new TerminalClosureRequiredError(
        payloadField(payload, 'task_id') ?? '<unknown>',
        to,
      );
    }
  }

  // F12：TaskWaitStateChanged 是 wait_state 的唯一事件源（spec §4 派生规则声明）。
  // payload 必须带 from/to、置位 actor 与 reason；写入时再校验 from 与流派生一致，
  // 并过 guardWaitStateChange（终态 / 自环拒绝）。
  if (input.type === 'TaskWaitStateChanged') {
    const payload = input.payload;
    if (typeof payload.task_id !== 'string' || payload.task_id.length === 0) {
      throw new TransitionPayloadError('TaskWaitStateChanged.payload 必须带非空 task_id');
    }
    for (const field of ['from', 'to'] as const) {
      if (typeof payload[field] !== 'string' || payload[field].length === 0) {
        throw new TransitionPayloadError(
          `TaskWaitStateChanged.payload 必须带非空 ${field}（spec §4：wait_state 每次变更必有 from/to）`,
        );
      }
    }
    if (typeof payload.reason !== 'string' || payload.reason.length === 0) {
      throw new TransitionPayloadError(
        'TaskWaitStateChanged.payload 必须带非空 reason（spec §4：wait_state 变更须记录原因）',
      );
    }
    const actorId = payload.actor_id;
    const actorKind = payload.actor_kind;
    if (typeof actorId !== 'string' || actorId.length === 0) {
      throw new TransitionPayloadError(
        'TaskWaitStateChanged.payload 必须带非空 actor_id（spec §4：wait_state 变更须记录置位 actor）',
      );
    }
    if (typeof actorKind !== 'string' || actorKind.length === 0) {
      throw new TransitionPayloadError(
        'TaskWaitStateChanged.payload 必须带非空 actor_kind（spec §4：wait_state 变更须记录置位 actor）',
      );
    }
    if (actorId !== input.actor_id || actorKind !== input.actor_kind) {
      throw new TransitionPayloadError(
        `TaskWaitStateChanged.payload 的 actor 与事件信封不一致：` +
          `payload=${actorId}/${actorKind}，envelope=${input.actor_id}/${input.actor_kind}`,
      );
    }
  }

  // Q12：AcceptanceRecorded 的验收人必须与事件信封 actor 一致（防 payload 伪造验收人）。
  if (input.type === 'AcceptanceRecorded') {
    const acceptorId = input.payload.acceptor_id;
    const acceptorKind = input.payload.acceptor_kind;
    if (typeof acceptorId !== 'string' || acceptorId.length === 0) {
      throw new ActorValidationError('AcceptanceRecorded.payload 必须带非空 acceptor_id（REQ-ACC-2）', {
        field: 'acceptor_id',
        reason: 'acceptor_missing',
      });
    }
    if (acceptorId !== input.actor_id || acceptorKind !== input.actor_kind) {
      throw new ActorValidationError(
        `AcceptanceRecorded.payload 的 acceptor 与事件信封不一致：` +
          `payload=${acceptorId}/${String(acceptorKind)}，envelope=${input.actor_id}/${input.actor_kind}`,
        { field: 'acceptor_id', reason: 'acceptor_envelope_mismatch' },
      );
    }
  }

  // Q12/INV-6：EvidenceAdded 的 source_kind 枚举外值封锁 + tool_output 通道封锁（缺失不归内核管，必填性由命令层把关）。
  let effectiveInput = input;
  if (input.type === 'EvidenceAdded') {
    const sourceKind = input.payload.source_kind;
    if (sourceKind !== undefined && !isEvidenceSourceKind(sourceKind)) {
      throw new ActorValidationError(
        'EvidenceAdded.payload.source_kind 必须是 user_statement / agent_claim / tool_output / external_doc / device_log 之一（spec §2.5）',
        { field: 'source_kind', reason: 'source_kind_invalid' },
      );
    }
    if (sourceKind === 'tool_output') {
      if (options.viaToolGateway !== true || typeof options.gatewayId !== 'string' || options.gatewayId.length === 0) {
        throw new ToolOutputChannelError(
          'source_kind=tool_output 的 Evidence 只能经 Tool Gateway 通道写入（INV-6），通用写路径拒绝',
        );
      }
      // 审计字段由内核注入（调用方自带同名字段一律覆盖，防伪造审计来源）。
      effectiveInput = {
        ...input,
        payload: { ...input.payload, recorded_via: 'tool_gateway', gateway_id: options.gatewayId },
      };
    }
  }

  const payload_canonical = canonicalJson(effectiveInput.payload);
  return { input: effectiveInput, payload_canonical };
}

/**
 * S5（Q5）：全局追加顺序锁。事件写事务在分配 seq 之前取它，并持有到提交/回滚。
 * 这样 allocations 与 commits 同序，消费者可以用「快照内可见的最大 global_seq」
 * 作为安全水位，不会越过并发未提交事件。锁按事务释放，可重入（同一事务多次取不阻塞）。
 */
const APPEND_ORDER_LOCK_KEY = 0x7878_0001;

/**
 * S4-①：withTransaction 的异步作用域。事务内误用外层 store 写（任意 stream）时，
 * 外层调用仍处在同一个 async context 里 → 立即抛 TransactionScopeError。
 * 与全局追加顺序锁配合：同事务内跨 stream 的外层写入同样会等锁死锁，故一并拒绝。
 * 并发请求各自不在该 context 中，不受影响（只会等锁，不会误报）。
 */
const TX_SCOPE = new AsyncLocalStorage<{ stream_id?: string }>();

function assertOutsideTransactionScope(stream_id: string): void {
  if (TX_SCOPE.getStore() !== undefined) throw new TransactionScopeError(stream_id);
}

async function lockAppendOrder(conn: PoolClient): Promise<void> {
  await conn.query('SELECT pg_advisory_xact_lock($1)', [APPEND_ORDER_LOCK_KEY]);
}

/**
 * 在已开启的事务内追加一条事件：不 BEGIN / COMMIT / ROLLBACK，连接生命周期由调用方管。
 * 任何一步失败都让所在事务进入 aborted 状态，由调用方整体回滚。
 */
async function appendWithin(
  client: PoolClient,
  prepared: PreparedAppend,
  idFactory: () => string,
  clock: () => Date,
  requireProjectCreated: boolean,
): Promise<EventEnvelope> {
  const { input, payload_canonical } = prepared;

  // S5：先取全局追加顺序锁（在链头行锁之前，避免锁序反转），再分配 seq。
  await lockAppendOrder(client);

  // 幂等建链头行；genesis last_hash = 64 个 0
  await client.query(
    `INSERT INTO event_streams (stream_id, last_seq, last_hash)
     VALUES ($1, 0, $2)
     ON CONFLICT (stream_id) DO NOTHING`,
    [input.stream_id, GENESIS_HASH],
  );

  // 临界区入口：同 stream 串行，跨 stream 并行
  const head = await client.query<{ last_seq: string; last_hash: string }>(
    `SELECT last_seq, last_hash FROM event_streams
     WHERE stream_id = $1 FOR UPDATE`,
    [input.stream_id],
  );
  if (head.rows.length !== 1) {
    throw new StoreInvariantError(`event_streams 缺少 stream=${input.stream_id} 的链头行`);
  }
  const last_seq = toSafeNumber(head.rows[0].last_seq, 'event_streams.last_seq');
  const last_hash = head.rows[0].last_hash;

  // S3-②：新流的首条事件必须是 ProjectCreated（其余事件不得凭空建项目流）。
  if (requireProjectCreated && last_seq === 0 && input.type !== 'ProjectCreated') {
    throw new ProjectCreatedRequiredError(input.stream_id, input.type);
  }

  // 锁内快路径：同 key 已入账 → 返回首次结果（INV-13）
  if (input.idempotency_key !== null) {
    const existing = await client.query<EventRow>(
      `SELECT * FROM events WHERE stream_id = $1 AND idempotency_key = $2`,
      [input.stream_id, input.idempotency_key],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      const conflicting_fields = idempotencyConflictFields(row, input, payload_canonical);
      if (conflicting_fields.length > 0) {
        throw new IdempotencyKeyConflictError(input.stream_id, input.idempotency_key, {
          existing: conflictExistingOf(row),
          existing_event_id: row.id,
          conflicting_fields,
        });
      }
      return rowToEnvelope(row);
    }
  }

  // F12：wait_state 变更必须在锁内与流派生状态对账，并过 guardWaitStateChange。
  // 幂等快路径已在此之前返回，重放不会被状态校验误伤。
  if (input.type === 'TaskWaitStateChanged') {
    const payload = input.payload as Record<string, unknown>;
    const task_id = payload.task_id as string;
    const facts = await deriveStreamFacts(client, input.stream_id);
    const lifecycle = deriveTaskLifecycle(facts, task_id);
    if (lifecycle === null) {
      throw new TransitionStateError({
        reason: 'subject_not_found',
        entity: 'task',
        subject_id: task_id,
        provided_from: payload.from as string,
        detail: 'stream 内没有 TaskCaptured / TaskLifecycleChanged（F12）',
      });
    }
    const expected_from = currentWaitState(facts, task_id);
    const provided_from = payload.from as string;
    if (expected_from !== provided_from) {
      throw new TransitionStateError({
        reason: 'from_mismatch',
        entity: 'task',
        subject_id: task_id,
        expected_from,
        provided_from,
        detail: 'payload.from 与流派生 wait_state 不一致（F12）',
      });
    }
    const waitGuard = guardWaitStateChange({
      lifecycle,
      from: expected_from,
      to: payload.to as string,
      reason: typeof payload.reason === 'string' ? payload.reason : undefined,
    });
    if (!waitGuard.allowed) throw new TransitionDeniedError(waitGuard);
  }

  // R1：原始 append 也不得绕行流派生状态写生命周期迁移——
  // 形状已在 prepareAppend 校验（from/to/trigger 必填 + 格合法），这里补「from 必须等于
  // 事件流当前状态」与「主体必须已存在」，否则同一条流可以写出两条互斥的生命周期分支。
  if (input.type === 'TaskLifecycleChanged') {
    const payload = input.payload as Record<string, unknown>;
    const task_id = requirePayloadId(input.type, payload, 'task_id');
    const facts = await deriveStreamFacts(client, input.stream_id);
    const lifecycle = deriveTaskLifecycle(facts, task_id);
    if (lifecycle === null) {
      throw new TransitionStateError({
        reason: 'subject_not_found',
        entity: 'task',
        subject_id: task_id,
        provided_from: payload.from as string,
        detail: 'stream 内没有 TaskCaptured / TaskLifecycleChanged（R1：原始 append 不得凭空建生命周期）',
      });
    }
    if (payload.from !== lifecycle) {
      throw new TransitionStateError({
        reason: 'from_mismatch',
        entity: 'task',
        subject_id: task_id,
        expected_from: lifecycle,
        provided_from: payload.from as string,
        detail: '原始 append 的 payload.from 与流派生 lifecycle 不一致（R1）',
      });
    }
  }

  const seq = last_seq + 1;
  const hash = computeEventHash(last_hash, payload_canonical, seq);
  const id = idFactory();
  const occurred_at = clock().toISOString();

  const inserted = await client.query<{ global_seq: string; recorded_at: Date | string }>(
    INSERT_EVENT_SQL,
    [
      id,
      input.stream_id,
      seq,
      input.type,
      input.actor_id,
      input.actor_kind,
      input.causation_id,
      input.correlation_id,
      input.idempotency_key,
      payload_canonical,
      payload_canonical,
      last_hash,
      hash,
      occurred_at,
    ],
  );

  await client.query(
    `UPDATE event_streams
     SET last_seq = $2, last_hash = $3, updated_at = now()
     WHERE stream_id = $1`,
    [input.stream_id, seq, hash],
  );

  return {
    id,
    stream_id: input.stream_id,
    seq,
    global_seq: toSafeNumber(inserted.rows[0].global_seq, 'events.global_seq'),
    type: input.type,
    actor_id: input.actor_id,
    actor_kind: input.actor_kind,
    causation_id: input.causation_id,
    correlation_id: input.correlation_id,
    idempotency_key: input.idempotency_key,
    payload: JSON.parse(payload_canonical) as unknown,
    prev_hash: last_hash,
    hash,
    occurred_at,
    recorded_at: toIso(inserted.rows[0].recorded_at),
  };
}

// ---------------------------------------------------------------------------
// 批量追加（Q4）：同 stream、同事务、哈希链内连续
// ---------------------------------------------------------------------------

function isTransitionEntry(entry: AppendBatchEntryInput): boolean {
  return typeof entry.from === 'string' && typeof entry.to === 'string';
}

/**
 * 批次形状预校验：在所有 DB 动作之前跑一遍，非法批次连事务都不开
 * （「非法迁移先拒、不进事务」）。guard 的前置条件仍由事务内的
 * appendStateTransitionOn 按流派生 fact 判定。
 */
function prevalidateBatchEntry(entry: AppendBatchEntryInput): void {
  if (entry.from === undefined && entry.to === undefined) {
    prepareAppend(entry);
    return;
  }
  if (typeof entry.from !== 'string' || typeof entry.to !== 'string') {
    throw new AppendBatchError(
      `appendBatch 条目 from/to 必须成对提供：stream=${entry.stream_id} type=${entry.type}`,
    );
  }
  const entity = entry.entity ?? 'task';
  assertTransitionEventType(entity, entry.type);
  const merged = mergeTransitionPayload(entry.payload, entry.from, entry.to);
  assertProjectStreamId(entry.stream_id, merged);
  // 与 appendStateTransitionOn 同口径：trigger_event_id 可由 causation_id 补齐
  const withTrigger = withTransitionTrigger(
    merged,
    entry.type,
    entry.causation_id,
    entry.trigger_event_id,
  );
  // 批量入口本身就是「同事务收尾」的兑现方式，终态迁移在此合法。
  prepareAppend({ ...entry, payload: withTrigger }, { allowTerminalLifecycle: true });
}

function batchStreamId(entries: AppendBatchEntryInput[]): ProjectId {
  if (entries.length === 0) {
    throw new AppendBatchError('appendBatch 至少需要一条事件（空批次不产生任何写入）');
  }
  const stream_id = entries[0].stream_id;
  for (const entry of entries) {
    if (entry.stream_id !== stream_id) {
      throw new AppendBatchError(
        `appendBatch 只允许同一 stream（同事务同链）：${stream_id} ≠ ${entry.stream_id}`,
      );
    }
  }
  return stream_id;
}

export function createPgEventStore(pool: Pool, options: PgEventStoreOptions = {}): PgEventStore {
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => ulid());
  const requireProjectCreated = options.requireProjectCreated ?? true;

  /**
   * 构造一个 store 视图。client = null 时每次写各自开事务（pool 路径）；
   * client 非空时所有读写都走该连接（withTransaction 路径），共享同一事务。
   */
  function makeScoped(client: PoolClient | null): PgEventStoreTx {
    const reader = client ?? pool;

    /** 在指定连接上写一条事件（调用方负责事务边界）。 */
    async function appendOn(
      conn: PoolClient,
      input: AppendEventInput,
      prepareOptions: PrepareAppendOptions = {},
    ): Promise<EventEnvelope> {
      return appendWithin(conn, prepareAppend(input, prepareOptions), idFactory, clock, requireProjectCreated);
    }

    async function append(
      input: AppendEventInput,
    ): Promise<EventEnvelope> {
      // 事务内：直接复用调用方连接，失败由 withTransaction 整体回滚
      if (client) return appendOn(client, input);

      // S4-①：事务内只能用 tx 写（外层 store 会等自己持有的行锁/全局追加锁而挂起）
      assertOutsideTransactionScope(input.stream_id);

      const conn = await pool.connect();
      try {
        await conn.query('BEGIN');
        const event = await appendOn(conn, input);

        // 快路径命中已存在事件时事务是只读的，COMMIT 同样安全
        const committed = await conn.query('COMMIT');
        if (committed.command !== 'COMMIT') {
          throw new TransactionCommitError(committed.command ?? null);
        }
        return event;
      } catch (error) {
        await conn.query('ROLLBACK').catch(() => undefined);

        // 唯一索引兜底：并发同 key 跨路径（23505），回滚后重查首次行
        if (
          isUniqueViolation(error, 'events_stream_idem_uq') &&
          input.idempotency_key !== null
        ) {
          const { rows } = await pool.query<EventRow>(
            `SELECT * FROM events WHERE stream_id = $1 AND idempotency_key = $2`,
            [input.stream_id, input.idempotency_key],
          );
          if (rows.length === 1) {
            const conflicting_fields = idempotencyConflictFields(
              rows[0],
              input,
              canonicalJson(input.payload),
            );
            if (conflicting_fields.length > 0) {
              throw new IdempotencyKeyConflictError(input.stream_id, input.idempotency_key, {
                existing: conflictExistingOf(rows[0]),
                existing_event_id: rows[0].id,
                conflicting_fields,
              });
            }
            return rowToEnvelope(rows[0]);
          }
        }

        // (stream_id, seq) 唯一约束命中 = 行锁逻辑有 bug，大声失败
        if (isUniqueViolation(error, 'events_stream_seq_uq')) {
          throw new StoreInvariantError(
            `seq 分配冲突：stream=${input.stream_id}（行锁逻辑失效，不重试掩盖）`,
          );
        }

        throw error;
      } finally {
        conn.release();
      }
    }

    /** 事务内执行一批：迁移条目走 appendStateTransitionOn（同一 guard 语义），其余走 appendOn。 */
    async function appendBatchOn(
      conn: PoolClient,
      entries: AppendBatchEntryInput[],
    ): Promise<PgAppendBatchResult> {
      const stream_id = batchStreamId(entries);

      // 先取全局追加顺序锁再读批次起点：否则并发事务可能在「读起点」与「拿锁」之间
      // 提交事件，导致事后按 seq > 起点读回时把别人的事件算进本批结果。
      await lockAppendOrder(conn);
      const head = await conn.query<{ last_seq: string }>(
        `SELECT last_seq FROM event_streams WHERE stream_id = $1`,
        [stream_id],
      );
      const before_seq = head.rows.length === 0
        ? 0
        : toSafeNumber(head.rows[0].last_seq, 'event_streams.last_seq');

      const transitions: AppendBatchTransitionResult[] = [];
      for (const entry of entries) {
        if (isTransitionEntry(entry)) {
          transitions.push(
            await appendStateTransitionOn(conn, {
              ...(entry as AppendStateTransitionInput),
              from: entry.from as string,
              to: entry.to as string,
            }),
          );
        } else {
          await appendOn(conn, entry);
        }
      }

      // 用同一连接读回本批真实写入（含内核自动收尾），uncommitted 行对本事务可见。
      const { rows } = await conn.query<EventRow>(
        `SELECT * FROM events
         WHERE stream_id = $1 AND seq > $2
         ORDER BY seq ASC`,
        [stream_id, before_seq],
      );
      return { events: rows.map(rowToEnvelope), transitions };
    }

    async function appendBatch(entries: AppendBatchEntryInput[]): Promise<PgAppendBatchResult> {
      // 形状预校验放在开事务之前：非法批次零 DB 动作。
      const batch_stream = batchStreamId(entries);
      if (client === null) assertOutsideTransactionScope(batch_stream);
      for (const entry of entries) prevalidateBatchEntry(entry);

      return withStoreTransaction((conn) => appendBatchOn(conn, entries));
    }

    async function readStream(stream_id: ProjectId, from_seq = 1): Promise<EventEnvelope[]> {
      const { rows } = await reader.query<EventRow>(
        `SELECT * FROM events
         WHERE stream_id = $1 AND seq >= $2
         ORDER BY seq ASC`,
        [stream_id, from_seq],
      );
      return rows.map(rowToEnvelope);
    }

    async function replay(from_global_seq = 0): Promise<EventEnvelope[]> {
      // 单条 SELECT = 单快照：避免「先看到 global_seq 10、后看到 9」的交错。
      // 已知限界（Q5）：提交序可能先于 global_seq 分配序；增量 tailing 需水位保护，batch 2。
      const { rows } = await reader.query<EventRow>(
        `SELECT * FROM events
         WHERE global_seq >= $1
         ORDER BY global_seq ASC`,
        [from_global_seq],
      );
      return rows.map(rowToEnvelope);
    }

    async function verifyChain(stream_id: ProjectId): Promise<ChainVerification> {
      // 单条 SELECT = 单快照：链头与 events 在同一快照内读取，避免并发 append 造成假红。
      const { rows } = await reader.query<{
        head_last_seq: string;
        head_last_hash: string;
        seq: string | null;
        prev_hash: string | null;
        hash: string | null;
        payload_canonical: string | null;
      }>(
        `SELECT h.last_seq AS head_last_seq, h.last_hash AS head_last_hash,
                e.seq, e.prev_hash, e.hash, e.payload_canonical
         FROM event_streams h
         LEFT JOIN events e ON e.stream_id = h.stream_id
         WHERE h.stream_id = $1
         ORDER BY e.seq ASC`,
        [stream_id],
      );

      if (rows.length === 0) {
        return {
          ok: false,
          stream_id,
          length: 0,
          broken_at_seq: null,
          broken_in: null,
          reason: '流不存在：event_streams 无此 stream 的链头行',
          stream_exists: false,
        };
      }

      const headLastSeq = toSafeNumber(rows[0].head_last_seq, 'event_streams.last_seq');
      const headLastHash = rows[0].head_last_hash;
      const eventRows = rows.filter(
        (row): row is typeof row & {
          seq: string;
          prev_hash: string;
          hash: string;
          payload_canonical: string;
        } => row.seq !== null,
      );

      let expectedPrev = GENESIS_HASH;
      let expectedSeq = 1;
      for (const row of eventRows) {
        const seq = toSafeNumber(row.seq, 'events.seq');
        if (seq !== expectedSeq) {
          return {
            ok: false,
            stream_id,
            length: eventRows.length,
            broken_at_seq: seq,
            broken_in: 'events',
            reason: `seq 不连续：期望 ${expectedSeq}，实际 ${seq}`,
            stream_exists: true,
          };
        }
        if (row.prev_hash !== expectedPrev) {
          return {
            ok: false,
            stream_id,
            length: eventRows.length,
            broken_at_seq: seq,
            broken_in: 'events',
            reason: `prev_hash 断链：期望 ${expectedPrev}，实际 ${row.prev_hash}`,
            stream_exists: true,
          };
        }
        // F14：payload_canonical 必须是重新规范化后的逐字节文本，否则拒绝报绿。
        let recanonicalized: string;
        try {
          recanonicalized = canonicalJson(JSON.parse(row.payload_canonical));
        } catch (error) {
          return {
            ok: false,
            stream_id,
            length: eventRows.length,
            broken_at_seq: seq,
            broken_in: 'events',
            reason:
              `payload_canonical 无法重新规范化：` +
              (error instanceof Error ? error.message : String(error)),
            stream_exists: true,
          };
        }
        if (recanonicalized !== row.payload_canonical) {
          return {
            ok: false,
            stream_id,
            length: eventRows.length,
            broken_at_seq: seq,
            broken_in: 'events',
            reason:
              `payload_canonical 非规范形式（F14）：` +
              `重规范化=${recanonicalized}，库中=${row.payload_canonical}`,
            stream_exists: true,
          };
        }
        const recomputed = computeEventHash(row.prev_hash, row.payload_canonical, seq);
        if (recomputed !== row.hash) {
          return {
            ok: false,
            stream_id,
            length: eventRows.length,
            broken_at_seq: seq,
            broken_in: 'events',
            reason: `hash 不匹配：重算 ${recomputed}，实际 ${row.hash}`,
            stream_exists: true,
          };
        }
        expectedPrev = row.hash;
        expectedSeq = seq + 1;
      }

      // F-b：不只看 events 行，还要校验链头行。链头被改乱/半提交时不能报绿。
      if (headLastSeq !== eventRows.length) {
        // 断点在链头行本身：broken_at_seq 给 events 的真实末行（不是链头声称的序号），
        // broken_in 指明位置，reason 同时给出两边数值。
        return {
          ok: false,
          stream_id,
          length: eventRows.length,
          broken_at_seq: eventRows.length === 0 ? null : eventRows.length,
          broken_in: 'stream_head',
          reason:
            `链头 last_seq 与 events 不一致：链头声称 last_seq=${headLastSeq}（链头声称值），` +
            `events 实际行数=${eventRows.length}（断点在链头行，不在 events；broken_at_seq 给 events 真实末行）`,
          stream_exists: true,
        };
      }
      if (headLastHash !== expectedPrev) {
        return {
          ok: false,
          stream_id,
          length: eventRows.length,
          broken_at_seq: eventRows.length === 0 ? null : eventRows.length,
          broken_in: 'stream_head',
          reason:
            `链头 last_hash 与 events 末行不一致：` +
            `last_hash=${headLastHash}，期望 ${expectedPrev}`,
          stream_exists: true,
        };
      }

      return {
        ok: true,
        stream_id,
        length: eventRows.length,
        broken_at_seq: null,
        broken_in: null,
        reason: null,
        stream_exists: true,
      };
    }

    // -----------------------------------------------------------------------
    // S5：增量消费水位（落库）+ 投递幂等
    // -----------------------------------------------------------------------

    async function readWatermark(consumer_id: string): Promise<number> {
      const { rows } = await reader.query<{ last_global_seq: string }>(
        `SELECT last_global_seq FROM consumer_watermarks WHERE consumer_id = $1`,
        [consumer_id],
      );
      if (rows.length === 0) return 0;
      return toSafeNumber(rows[0].last_global_seq, 'consumer_watermarks.last_global_seq');
    }

    async function fetchAfterWatermark(input: {
      consumer_id: string;
      limit?: number;
    }): Promise<TailingBatch> {
      const limit = input.limit ?? 200;
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new StoreInvariantError(`tailing limit 必须是正整数，收到 ${String(limit)}`);
      }
      // 单条 SELECT = 单快照：水位与事件在同一快照内读取。
      const { rows } = await reader.query<EventRow>(
        `SELECT * FROM events
         WHERE global_seq > COALESCE(
           (SELECT last_global_seq FROM consumer_watermarks WHERE consumer_id = $1), 0
         )
         ORDER BY global_seq ASC
         LIMIT $2`,
        [input.consumer_id, limit],
      );
      const events = rows.map(rowToEnvelope);
      const watermark = events.length > 0
        ? events[events.length - 1].global_seq
        : await readWatermark(input.consumer_id);
      return { events, watermark, has_more: events.length === limit };
    }

    async function commitDeliveries(
      input: CommitDeliveriesInput,
    ): Promise<CommitDeliveriesResult> {
      if (!Number.isSafeInteger(input.last_global_seq) || input.last_global_seq < 0) {
        throw new StoreInvariantError(
          `commitDeliveries.last_global_seq 必须是非负安全整数，收到 ${String(input.last_global_seq)}`,
        );
      }
      const seqs = input.event_ids.map(() => input.last_global_seq);
      return withStoreTransaction(async (conn) => {
        const inserted = await conn.query<{ event_id: string }>(
          `INSERT INTO consumer_deliveries (consumer_id, event_id, event_global_seq)
           SELECT $1, item.event_id, item.global_seq
           FROM unnest($2::text[], $3::bigint[]) AS item(event_id, global_seq)
           ON CONFLICT (consumer_id, event_id) DO NOTHING
           RETURNING event_id`,
          [input.consumer_id, input.event_ids, seqs],
        );
        const watermark = await conn.query<{ last_global_seq: string }>(
          `INSERT INTO consumer_watermarks (consumer_id, last_global_seq)
           VALUES ($1, $2)
           ON CONFLICT (consumer_id) DO UPDATE
             SET last_global_seq = GREATEST(consumer_watermarks.last_global_seq, EXCLUDED.last_global_seq),
                 updated_at = now()
           RETURNING last_global_seq`,
          [input.consumer_id, input.last_global_seq],
        );
        return {
          new_deliveries: inserted.rows.length,
          watermark: toSafeNumber(watermark.rows[0].last_global_seq, 'consumer_watermarks.last_global_seq'),
        };
      });
    }

    async function listDueWaitConditions(now: Date): Promise<DueWaitCondition[]> {
      const cutoff = now.toISOString();
      const { rows } = await reader.query<{
        stream_id: string;
        type: EventType;
        payload: unknown;
      }>(
        `SELECT stream_id, type, payload FROM events
         WHERE type IN ('WaitConditionCreated','WaitConditionSatisfied','WaitConditionExpired','WaitConditionCanceled')
         ORDER BY stream_id ASC, seq ASC`,
      );

      const conditions = new Map<string, DueWaitCondition & { active: boolean }>();
      for (const row of rows) {
        const id = payloadId(row.payload, 'wait_condition_id');
        if (id === null) continue;
        const key = `${row.stream_id}\u0000${id}`;
        if (row.type === 'WaitConditionCreated') {
          const due_at = payloadField(row.payload, 'due_at');
          conditions.set(key, {
            stream_id: row.stream_id,
            wait_condition_id: id,
            task_id: payloadField(row.payload, 'task_id'),
            due_at: due_at ?? '',
            active: true,
          });
        } else {
          const existing = conditions.get(key);
          if (existing) existing.active = false;
        }
      }

      return [...conditions.values()]
        .filter((item) => item.active && item.due_at.length > 0 && item.due_at <= cutoff)
        .map(({ active: _active, ...timer }) => timer)
        .sort((a, b) => a.due_at.localeCompare(b.due_at) || a.wait_condition_id.localeCompare(b.wait_condition_id));
    }

    async function listStreams(): Promise<StreamSummary[]> {
      const { rows } = await reader.query<{
        stream_id: string;
        last_seq: string;
        last_hash: string;
        updated_at: Date | string;
        event_count: string;
      }>(
        `SELECT h.stream_id, h.last_seq, h.last_hash, h.updated_at,
                (SELECT count(*) FROM events e WHERE e.stream_id = h.stream_id) AS event_count
         FROM event_streams h
         ORDER BY h.stream_id ASC`,
      );
      return rows.map((row) => ({
        stream_id: row.stream_id,
        last_seq: toSafeNumber(row.last_seq, 'event_streams.last_seq'),
        last_hash: row.last_hash,
        updated_at: toIso(row.updated_at),
        event_count: toSafeNumber(row.event_count, 'events.count'),
      }));
    }

    // -----------------------------------------------------------------------
    // 事务与锁
    // -----------------------------------------------------------------------

    async function withStoreTransaction<T>(
      fn: (conn: PoolClient) => Promise<T>,
    ): Promise<T> {
      if (client) return fn(client);

      const conn = await pool.connect();
      try {
        await conn.query('BEGIN');
        const result = await fn(conn);
        const committed = await conn.query('COMMIT');
        if (committed.command !== 'COMMIT') {
          throw new TransactionCommitError(committed.command ?? null);
        }
        return result;
      } catch (error) {
        await conn.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        conn.release();
      }
    }

    /** 同 stream 串行化入口：派生状态与写入必须在同一把行锁内完成（F1）。 */
    async function ensureAndLockStream(conn: PoolClient, stream_id: string): Promise<number> {
      await conn.query(
        `INSERT INTO event_streams (stream_id, last_seq, last_hash)
         VALUES ($1, 0, $2)
         ON CONFLICT (stream_id) DO NOTHING`,
        [stream_id, GENESIS_HASH],
      );
      const head = await conn.query<{ last_seq: string }>(
        `SELECT last_seq FROM event_streams WHERE stream_id = $1 FOR UPDATE`,
        [stream_id],
      );
      if (head.rows.length !== 1) {
        throw new StoreInvariantError(`event_streams 缺少 stream=${stream_id} 的链头行`);
      }
      return toSafeNumber(head.rows[0].last_seq, 'event_streams.last_seq');
    }

    async function findByIdempotencyKey(
      conn: PoolClient,
      stream_id: string,
      key: string | null,
    ): Promise<EventEnvelope | null> {
      if (key === null) return null;
      const { rows } = await conn.query<EventRow>(
        `SELECT * FROM events WHERE stream_id = $1 AND idempotency_key = $2`,
        [stream_id, key],
      );
      return rows.length > 0 ? rowToEnvelope(rows[0]) : null;
    }

    // -----------------------------------------------------------------------
    // F2/F4：终态收尾（同事务）
    // -----------------------------------------------------------------------

    type EmitBase = Pick<
      AppendEventInput,
      'stream_id' | 'actor_id' | 'actor_kind' | 'causation_id' | 'correlation_id'
    >;

    interface PreClosureResult {
      wait_conditions_canceled: string[];
      wait_state_reset_from: TaskWaitState | null;
      decisions_expired: string[];
      assignments_ended: string[];
      effects_applied: GuardEffect[];
    }

    async function emitClosureEvent(
      conn: PoolClient,
      base: EmitBase,
      type: EventType,
      payload: Record<string, unknown>,
    ): Promise<EventEnvelope> {
      return appendOn(
        conn,
        {
          stream_id: base.stream_id,
          type,
          actor_id: base.actor_id,
          actor_kind: base.actor_kind,
          causation_id: base.causation_id,
          correlation_id: base.correlation_id,
          idempotency_key: null,
          payload,
        },
        { allowTerminalLifecycle: true },
      );
    }

    /**
     * INV-11 收尾顺序（spec §3.1）：
     * active WaitCondition → canceled；wait_state → none；随后（调用方）lifecycle 迁移。
     * REQ-RUN-6 额外在正式取消前收尾 pending Decision / active Assignment。
     */
    async function applyTerminalPreClosure(
      conn: PoolClient,
      base: EmitBase,
      facts: StreamFacts,
      task_id: string,
      to: 'accepted' | 'canceled',
    ): Promise<PreClosureResult> {
      const result: PreClosureResult = {
        wait_conditions_canceled: [],
        wait_state_reset_from: null,
        decisions_expired: [],
        assignments_ended: [],
        effects_applied: [],
      };

      if (to === 'canceled') {
        // REQ-RUN-6①：pending Decision → expired(task_canceled)
        for (const decision of facts.decisions.values()) {
          if (!decision.pending) continue;
          if (decision.task_id !== task_id && decision.subject_ref !== task_id) continue;
          await emitClosureEvent(conn, base, 'DecisionExpired', {
            decision_id: decision.id,
            subject_ref: task_id,
            reason: 'task_canceled',
          });
          result.decisions_expired.push(decision.id);
        }
        result.effects_applied.push('expire_pending_decisions');

        // REQ-RUN-6①：active Assignment → ended(task_canceled)
        for (const assignment of facts.assignments.values()) {
          if (!assignment.active || assignment.task_id !== task_id) continue;
          await emitClosureEvent(conn, base, 'AssignmentEnded', {
            assignment_id: assignment.id,
            task_id,
            reason: 'task_canceled',
          });
          result.assignments_ended.push(assignment.id);
        }
        result.effects_applied.push('end_active_assignments');
      }

      // INV-11：active WaitCondition → canceled
      for (const waitCondition of facts.waitConditions.values()) {
        if (!waitCondition.active || waitCondition.task_id !== task_id) continue;
        await emitClosureEvent(conn, base, 'WaitConditionCanceled', {
          wait_condition_id: waitCondition.id,
          task_id,
          reason: to === 'canceled' ? 'task_canceled' : 'task_accepted',
        });
        result.wait_conditions_canceled.push(waitCondition.id);
      }
      result.effects_applied.push('cancel_active_wait_conditions');

      // INV-11：wait_state → none（每次变更必有 TaskWaitStateChanged 事件源）
      const waitState = currentWaitState(facts, task_id);
      if (waitState !== 'none') {
        await emitClosureEvent(conn, base, 'TaskWaitStateChanged', {
          task_id,
          from: waitState,
          to: 'none',
          reason: to === 'canceled' ? 'task_canceled' : 'task_accepted',
          actor_id: base.actor_id,
          actor_kind: base.actor_kind,
        });
        result.wait_state_reset_from = waitState;
      }
      result.effects_applied.push('reset_wait_state_none');

      return result;
    }

    /** REQ-RUN-6①：记取消意图时的级联收尾（Decision/Assignment）。 */
    async function applyCancellationIntentCascade(
      conn: PoolClient,
      base: EmitBase,
      facts: StreamFacts,
      task_id: string,
    ): Promise<{ decisions_expired: string[]; assignments_ended: string[] }> {
      const decisions_expired: string[] = [];
      for (const decision of facts.decisions.values()) {
        if (!decision.pending) continue;
        if (decision.task_id !== task_id && decision.subject_ref !== task_id) continue;
        await emitClosureEvent(conn, base, 'DecisionExpired', {
          decision_id: decision.id,
          subject_ref: task_id,
          reason: 'task_canceled',
        });
        decisions_expired.push(decision.id);
      }

      const assignments_ended: string[] = [];
      for (const assignment of facts.assignments.values()) {
        if (!assignment.active || assignment.task_id !== task_id) continue;
        await emitClosureEvent(conn, base, 'AssignmentEnded', {
          assignment_id: assignment.id,
          task_id,
          reason: 'task_canceled',
        });
        assignments_ended.push(assignment.id);
      }

      return { decisions_expired, assignments_ended };
    }

    // -----------------------------------------------------------------------
    // 状态迁移写路径
    // -----------------------------------------------------------------------

    async function appendStateTransitionOn(
      conn: PoolClient,
      input: AppendStateTransitionInput,
    ): Promise<AppendStateTransitionResult> {
      const entity = input.entity ?? 'task';
      // ① 事件类型必须属于该实体的迁移事件家族（spec §4）；格级匹配由 guard 再查（F6）
      assertTransitionEventType(entity, input.type);

      // ② payload.from/to 缺失补齐、矛盾拒绝
      const mergedPayload = mergeTransitionPayload(input.payload, input.from, input.to);

      // F13：先于流读取给出明确拒绝（否则只会得到模糊的 subject_not_found）。
      assertProjectStreamId(input.stream_id, mergedPayload);

      // F7：TaskLifecycleChanged 补 trigger_event_id
      const payload = withTransitionTrigger(
        mergedPayload,
        input.type,
        input.causation_id,
        input.trigger_event_id,
      );

      const subject_id = subjectIdFor(entity, payload);
      if (subject_id === null) {
        throw new TransitionStateError({
          reason: 'subject_id_missing',
          entity,
          subject_id: null,
          provided_from: input.from,
          detail: entity === 'task' ? 'payload.task_id 缺失' : 'payload.run_id 缺失',
        });
      }

      // 锁内：先做幂等重放检查（避免重放被 F1 的 from 校验误伤），再派生流状态。
      const payload_canonical = canonicalJson(payload);
      await lockAppendOrder(conn);
      const head_seq = await ensureAndLockStream(conn, input.stream_id);
      if (requireProjectCreated && head_seq === 0 && input.type !== 'ProjectCreated') {
        throw new ProjectCreatedRequiredError(input.stream_id, input.type);
      }

      const existing = await findByIdempotencyKey(conn, input.stream_id, input.idempotency_key);
      if (existing !== null && input.idempotency_key !== null) {
        const conflicting_fields = idempotencyConflictFields(
          { ...existing, payload_canonical: canonicalJson(existing.payload) },
          input,
          payload_canonical,
        );
        if (conflicting_fields.length > 0) {
          throw new IdempotencyKeyConflictError(input.stream_id, input.idempotency_key, {
            existing: conflictExistingOf(existing),
            existing_event_id: existing.id,
            conflicting_fields,
          });
        }
        return {
          event: existing,
          guard: guardTransitionReplay({
            entity,
            from: input.from,
            to: input.to,
            event_type: input.type,
            run_kind:
              entity === 'run'
                ? await deriveRunKind(conn, input.stream_id, subject_id)
                : undefined,
          }),
          closure: null,
        };
      }

      // ③ F1：期望 from 只来自事件流当前状态（最后一条生命周期/状态事件）
      const facts = await deriveStreamFacts(conn, input.stream_id);
      let expected_from: string;
      if (entity === 'task') {
        const lifecycle = deriveTaskLifecycle(facts, subject_id);
        if (lifecycle === null) {
          throw new TransitionStateError({
            reason: 'subject_not_found',
            entity,
            subject_id,
            provided_from: input.from,
            detail: 'stream 内没有 TaskCaptured / TaskLifecycleChanged',
          });
        }
        expected_from = lifecycle;
      } else {
        const run = deriveRunState(facts, subject_id);
        if (run === null) {
          throw new TransitionStateError({
            reason: 'subject_not_found',
            entity,
            subject_id,
            provided_from: input.from,
            detail: 'stream 内没有 RunCreated / Run* 状态事件',
          });
        }
        expected_from = run.state;
      }

      if (expected_from !== input.from) {
        throw new TransitionStateError({
          reason: 'from_mismatch',
          entity,
          subject_id,
          expected_from,
          provided_from: input.from,
          detail: '调用方 from 与事件流当前状态不一致（F1）',
        });
      }

      // ④ F3/F4/F5：客观 fact 由流派生并覆盖调用方自述
      const runFacts = entity === 'run' ? deriveRunState(facts, subject_id)! : null;
      const derived =
        entity === 'task' ? derivedTaskFacts(facts, subject_id) : derivedRunFacts(facts, runFacts!);
      const guard = guardTransition({
        entity,
        from: expected_from,
        to: input.to,
        event_type: input.type,
        facts: mergeFacts(input.facts, derived),
        run_kind: runFacts?.run_kind,
      });
      if (!guard.allowed) throw new TransitionDeniedError(guard);

      const base: EmitBase = {
        stream_id: input.stream_id,
        actor_id: input.actor_id,
        actor_kind: input.actor_kind,
        causation_id: input.causation_id,
        correlation_id: input.correlation_id,
      };

      // ⑤ F2/F4：终态迁移的收尾与 lifecycle 同事务落库
      if (entity === 'task' && (input.to === 'accepted' || input.to === 'canceled')) {
        const pre = await applyTerminalPreClosure(conn, base, facts, subject_id, input.to);

        const event = await appendOn(
          conn,
          {
            ...input,
            payload,
          },
          { allowTerminalLifecycle: true },
        );

        let task_canceled_event_id: string | null = null;
        if (input.to === 'canceled') {
          const taskCanceled = await emitClosureEvent(conn, base, 'TaskCanceled', {
            task_id: subject_id,
            reason: typeof payload.reason === 'string' ? payload.reason : 'task_canceled',
            lifecycle_event_id: event.id,
          });
          task_canceled_event_id = taskCanceled.id;
          pre.effects_applied.push('emit_task_canceled');
        }

        return {
          event,
          guard,
          closure: {
            wait_conditions_canceled: pre.wait_conditions_canceled,
            wait_state_reset_from: pre.wait_state_reset_from,
            decisions_expired: pre.decisions_expired,
            assignments_ended: pre.assignments_ended,
            task_canceled_event_id,
            effects_applied: pre.effects_applied,
          },
        };
      }

      const event = await appendOn(conn, { ...input, payload });
      return { event, guard, closure: null };
    }

    async function appendStateTransition(
      input: AppendStateTransitionInput,
    ): Promise<AppendStateTransitionResult> {
      if (client === null) assertOutsideTransactionScope(input.stream_id);
      return withStoreTransaction((conn) => appendStateTransitionOn(conn, input));
    }

    // -----------------------------------------------------------------------
    // REQ-RUN-6：取消级联
    // -----------------------------------------------------------------------

    interface FinalizeOutcome {
      closure: TransitionClosure | null;
      finalized: boolean;
      lifecycle: TaskLifecycle;
    }

    /** 已记取消意图时，取该 Task 最近一条 TaskCancelRequested 的 id 作为迁移触发事件（F7）。 */
    async function findCancelRequestedEventId(
      conn: PoolClient,
      stream_id: string,
      task_id: string,
    ): Promise<string | null> {
      const { rows } = await conn.query<{ id: string; payload: unknown }>(
        `SELECT id, payload FROM events
         WHERE stream_id = $1 AND type = 'TaskCancelRequested'
         ORDER BY seq DESC`,
        [stream_id],
      );
      for (const row of rows) {
        if (payloadField(row.payload, 'task_id') === task_id) return row.id;
      }
      return null;
    }

    /** 全部 Run 达终态时执行第③步（收尾 + lifecycle canceled + TaskCanceled）。 */
    async function finalizeTaskCancellation(
      conn: PoolClient,
      input: RequestTaskCancellationInput,
      causation_id: string | null,
    ): Promise<FinalizeOutcome> {
      const facts = await deriveStreamFacts(conn, input.stream_id);
      const lifecycle = deriveTaskLifecycle(facts, input.task_id);
      if (lifecycle === null) {
        throw new TransitionStateError({
          reason: 'subject_not_found',
          entity: 'task',
          subject_id: input.task_id,
        });
      }
      if (lifecycle === 'canceled') {
        return { closure: null, finalized: true, lifecycle };
      }
      if (!allRunsTerminalForTask(facts, input.task_id)) {
        return { closure: null, finalized: false, lifecycle };
      }

      // F7：正式取消的触发事件是取消意图；意图已存在时从流里回查，而不是编造 id。
      const trigger_event_id =
        causation_id
        ?? (await findCancelRequestedEventId(conn, input.stream_id, input.task_id))
        ?? input.causation_id;

      const result = await appendStateTransitionOn(conn, {
        stream_id: input.stream_id,
        type: 'TaskLifecycleChanged',
        entity: 'task',
        from: lifecycle,
        to: 'canceled',
        actor_id: input.actor_id,
        actor_kind: input.actor_kind,
        causation_id: causation_id ?? trigger_event_id,
        correlation_id: input.correlation_id,
        idempotency_key: null,
        trigger_event_id: trigger_event_id ?? undefined,
        payload: { task_id: input.task_id, reason: input.reason ?? 'task_canceled' },
        facts: {},
      });
      return { closure: result.closure, finalized: true, lifecycle: 'canceled' };
    }

    async function requestTaskCancellationOn(
      conn: PoolClient,
      input: RequestTaskCancellationInput,
    ): Promise<TaskCancellationResult> {
      // F13：stream 必须是 Project，不能复用 task_id。
      assertProjectStreamId(input.stream_id, { task_id: input.task_id });
      await lockAppendOrder(conn);
      const head_seq = await ensureAndLockStream(conn, input.stream_id);
      if (requireProjectCreated && head_seq === 0) {
        throw new ProjectCreatedRequiredError(input.stream_id, 'TaskCancelRequested');
      }

      // 幂等：同 key 已记过取消意图 → 返回首次结果（INV-13）
      const existing = await findByIdempotencyKey(conn, input.stream_id, input.idempotency_key);
      if (existing !== null && input.idempotency_key !== null) {
        if (existing.type !== 'TaskCancelRequested') {
          throw new IdempotencyKeyConflictError(input.stream_id, input.idempotency_key, {
            existing: conflictExistingOf(existing),
            existing_event_id: existing.id,
            conflicting_fields: ['type'],
          });
        }
        const facts = await deriveStreamFacts(conn, input.stream_id);
        const lifecycle = deriveTaskLifecycle(facts, input.task_id);
        return {
          cancel_requested: existing,
          already_requested: true,
          runs_canceled: [],
          closure: null,
          finalized: lifecycle === 'canceled',
          task_lifecycle: lifecycle,
        };
      }

      const facts = await deriveStreamFacts(conn, input.stream_id);
      const lifecycle = deriveTaskLifecycle(facts, input.task_id);
      if (lifecycle === null) {
        throw new TransitionStateError({
          reason: 'subject_not_found',
          entity: 'task',
          subject_id: input.task_id,
        });
      }
      if (lifecycle === 'accepted') {
        throw new TransitionStateError({
          reason: 'task_already_terminal',
          entity: 'task',
          subject_id: input.task_id,
          expected_from: lifecycle,
          detail: 'accepted 的 Task 不可取消，须另立 Task',
        });
      }
      if (lifecycle === 'canceled') {
        return {
          cancel_requested: null,
          already_requested: true,
          runs_canceled: [],
          closure: null,
          finalized: true,
          task_lifecycle: lifecycle,
        };
      }

      // 意图已记（不可撤销）：不重复写事件，只尝试推进第③步
      if (facts.taskCancelRequested.has(input.task_id)) {
        const finalized = await finalizeTaskCancellation(conn, input, null);
        return {
          cancel_requested: null,
          already_requested: true,
          runs_canceled: [],
          closure: finalized.closure,
          finalized: finalized.finalized,
          task_lifecycle: finalized.lifecycle,
        };
      }

      // REQ-RUN-6①：记取消意图
      const cancelRequested = await appendOn(conn, {
        stream_id: input.stream_id,
        type: 'TaskCancelRequested',
        actor_id: input.actor_id,
        actor_kind: input.actor_kind,
        causation_id: input.causation_id,
        correlation_id: input.correlation_id,
        idempotency_key: input.idempotency_key,
        payload: {
          task_id: input.task_id,
          reason: input.reason ?? 'cancel_requested',
          cancel_requested_at: clock().toISOString(),
        },
      });

      const base: EmitBase = {
        stream_id: input.stream_id,
        actor_id: input.actor_id,
        actor_kind: input.actor_kind,
        causation_id: cancelRequested.id,
        correlation_id: input.correlation_id,
      };

      // REQ-RUN-6①：级联收尾 Decision / Assignment
      const cascade = await applyCancellationIntentCascade(conn, base, facts, input.task_id);

      // REQ-RUN-6②：未启动的 created/queued/leased Run 直接 canceled
      const runs_canceled: EventEnvelope[] = [];
      for (const run of runsOfTask(facts, input.task_id)) {
        if (run.started) continue;
        if (run.state !== 'created' && run.state !== 'queued' && run.state !== 'leased') continue;
        const canceled = await appendStateTransitionOn(conn, {
          stream_id: input.stream_id,
          type: 'RunCanceled',
          entity: 'run',
          from: run.state,
          to: 'canceled',
          actor_id: input.actor_id,
          actor_kind: input.actor_kind,
          causation_id: cancelRequested.id,
          correlation_id: input.correlation_id,
          idempotency_key: null,
          payload: { run_id: run.run_id, task_id: input.task_id, reason: 'task_canceled' },
          facts: {},
        });
        runs_canceled.push(canceled.event);
      }

      // REQ-RUN-6③：全部 Run 已终态则同事务正式取消
      const finalized = await finalizeTaskCancellation(conn, input, cancelRequested.id);

      // 收尾证据合并：级联发生在正式收尾之前，finalize 时的重派生已看不到这些项。
      if (finalized.closure !== null) {
        finalized.closure.decisions_expired = [
          ...cascade.decisions_expired,
          ...finalized.closure.decisions_expired,
        ];
        finalized.closure.assignments_ended = [
          ...cascade.assignments_ended,
          ...finalized.closure.assignments_ended,
        ];
      }

      return {
        cancel_requested: cancelRequested,
        already_requested: false,
        runs_canceled,
        closure: finalized.closure,
        finalized: finalized.finalized,
        task_lifecycle: finalized.lifecycle,
      };
    }

    async function requestTaskCancellation(
      input: RequestTaskCancellationInput,
    ): Promise<TaskCancellationResult> {
      if (client === null) assertOutsideTransactionScope(input.stream_id);
      return withStoreTransaction((conn) => requestTaskCancellationOn(conn, input));
    }

    async function appendToolOutputEvidence(
      input: Parameters<EventStore['append']>[0] & { gateway_id: string },
    ): Promise<EventEnvelope> {
      const { gateway_id, ...appendInput } = input;
      if (appendInput.type !== 'EvidenceAdded') {
        throw new ToolOutputChannelError('Tool Gateway 专用入口只写 EvidenceAdded 事件（INV-6）');
      }
      const prepared = prepareAppend(appendInput, { viaToolGateway: true, gatewayId: gateway_id });
      return withStoreTransaction((conn) => appendWithin(conn, prepared, idFactory, clock, requireProjectCreated));
    }

    return {
      append,
      appendBatch,
      readStream,
      replay,
      appendStateTransition,
      requestTaskCancellation,
      verifyChain,
      readWatermark,
      fetchAfterWatermark,
      commitDeliveries,
      listStreams,
      listDueWaitConditions,
      appendToolOutputEvidence,
    };
  }

  const base = makeScoped(null);

  async function withTransaction<T>(
    fn: (tx: PgEventStoreTx) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    const tx = makeScoped(client);
    try {
      await client.query('BEGIN');
      // S4-①：fn 及其后代异步调用都处于事务作用域内；此时再调外层 store 写会立即报错。
      const result = await TX_SCOPE.run({}, () => fn(tx));
      const committed = await client.query('COMMIT');
      if (committed.command !== 'COMMIT') {
        throw new TransactionCommitError(committed.command ?? null);
      }
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return { ...base, withTransaction };
}
