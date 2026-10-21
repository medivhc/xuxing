// PG Event Store —— 确定性事件溯源的写入与读取路径（spec §4 / INV-12 / INV-13）。
//
// 编码与并发约定（plan §3，Q1/Q2/Q5 已裁决）：
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
// - replay 用单条 SELECT（单快照）按 global_seq 重演；global_seq 允许空洞（回滚跳号），
//   只保证单调。增量 tailing 需要水位保护，按 Q5 留给 batch 2。
// - occurred_at 由注入时钟提供（store 接口无该参数，见假设 A8）。
// - 本批只支持单事件 append；INV-11 的收尾动作只以 required_effects 形式返回，
//   appendBatch 留给 batch 2（Q4）。

import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { ulid } from 'ulid';
import type { EventEnvelope, EventType } from './events.js';
import { EVENT_TYPES } from './events.js';
import type { EventStore } from './event-store.js';
import {
  guardTransition,
  isMatrixCellAllowed,
  type GuardFacts,
  type GuardResult,
} from './transition-guard.js';

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

/** 同 (stream_id, key) 已有事件且内容不同 —— 客户端 bug，不能伪装成重放。 */
export class IdempotencyKeyConflictError extends Error {
  readonly stream_id: string;
  readonly idempotency_key: string;
  constructor(stream_id: string, idempotency_key: string) {
    super(
      `idempotency_key 冲突：stream=${stream_id} key=${idempotency_key} 已存在不同内容的事件（A3：同 key 不同内容视为错误）`,
    );
    this.name = 'IdempotencyKeyConflictError';
    this.stream_id = stream_id;
    this.idempotency_key = idempotency_key;
  }
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
    super(
      `状态迁移被拒绝：${result.basis.spec_ref} ${result.basis.row}→${result.basis.col} ` +
        `reason=${result.reason ?? 'unknown'}${result.unmet?.length ? ` unmet=${result.unmet.join(',')}` : ''}`,
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
      `事件类型 ${type} 不属于 ${entity} 状态迁移事件家族：` +
        `task 用 TaskLifecycleChanged，run 用 Run* 状态事件（spec §4）`,
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

// ---------------------------------------------------------------------------
// payload 规范化与哈希（具名导出，测试独立重算整条链）
// ---------------------------------------------------------------------------

function encodeCanonical(value: unknown): string {
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
      if (Array.isArray(value)) {
        return `[${value.map((item) => encodeCanonical(item)).join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalizationError(
          `只接受 plain object / array / 原始值，收到 ${Object.prototype.toString.call(value)}`,
        );
      }
      const record = value as Record<string, unknown>;
      // 默认 sort 即为 UTF-16 code unit 升序（不能用 localeCompare）
      const keys = Object.keys(record).sort();
      return `{${keys
        .map((key) => `${JSON.stringify(key)}:${encodeCanonical(record[key])}`)
        .join(',')}}`;
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
// DDL（plan §3.1；幂等 IF NOT EXISTS）
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
    stream_id: row.stream_id,
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

// ---------------------------------------------------------------------------
// 工厂与接口
// ---------------------------------------------------------------------------

export interface PgEventStoreOptions {
  /** 注入时钟（occurred_at）；测试可固定，业务代码不散落 Date.now()。 */
  clock?: () => Date;
  /** 注入 id 工厂（默认 ULID），测试可固定 id。 */
  idFactory?: () => string;
}

export type AppendStateTransitionInput = Parameters<EventStore['append']>[0] & {
  entity?: 'task' | 'run';
  from: string;
  to: string;
  facts?: GuardFacts;
};

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
 * spec §4：payload 必须带 from/to，且与 guard 判定的顶层 from/to 一致。
 * - 缺失 → 用顶层值补齐（调用方只需写一份，落库形状仍然合规）；
 * - 存在但不一致 → TransitionPayloadMismatchError（不允许静默写出矛盾事件）。
 */
function mergeTransitionPayload(
  payload: unknown,
  from: string,
  to: string,
): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TransitionPayloadError(
      `状态迁移事件的 payload 必须是对象（收到 ${payload === null ? 'null' : typeof payload}），才能承载 from/to`,
    );
  }
  const record = payload as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...record };
  for (const field of ['from', 'to'] as const) {
    const expected = field === 'from' ? from : to;
    const actual = record[field];
    if (actual === undefined) {
      merged[field] = expected;
    } else if (actual !== expected) {
      throw new TransitionPayloadMismatchError(field, expected, actual);
    }
  }
  return merged;
}

export interface ChainVerification {
  ok: boolean;
  stream_id: string;
  length: number;
  broken_at_seq: number | null;
  reason: string | null;
}

export interface PgEventStore extends EventStore {
  /** 校验器嵌在写路径：先 guardTransition，拒绝则抛 TransitionDeniedError 且不进入事务。 */
  appendStateTransition(
    input: AppendStateTransitionInput,
  ): Promise<{ event: EventEnvelope; guard: GuardResult }>;
  /** 读全流、用 payload_canonical 重算链，返回首个断点（不在 append/replay 热路径）。 */
  verifyChain(stream_id: string): Promise<ChainVerification>;
}

const INSERT_EVENT_SQL = `
  INSERT INTO events
    (id, stream_id, seq, type, actor_id, actor_kind, causation_id, correlation_id,
     idempotency_key, payload, payload_canonical, prev_hash, hash, occurred_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)
  RETURNING global_seq, recorded_at`;

export function createPgEventStore(pool: Pool, options: PgEventStoreOptions = {}): PgEventStore {
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => ulid());

  async function append(
    input: Parameters<EventStore['append']>[0],
  ): Promise<EventEnvelope> {
    if (!(EVENT_TYPES as readonly string[]).includes(input.type)) {
      throw new UnknownEventTypeError(String(input.type));
    }

    const payload_canonical = canonicalJson(input.payload);

    // 纵深防御（plan §5）：TaskLifecycleChanged 的 payload 带 from/to 时复核格合法性。
    // 这里只查矩阵格，不评估前置条件（前置条件由 appendStateTransition 负责）。
    if (input.type === 'TaskLifecycleChanged') {
      const payload = input.payload as { from?: unknown; to?: unknown } | null;
      if (typeof payload?.from === 'string' && typeof payload?.to === 'string') {
        const check = isMatrixCellAllowed('task', payload.from, payload.to);
        if (!check.allowed) throw new TransitionDeniedError(check);
      }
    }

    const client = await pool.connect();
    let settled = false;
    try {
      await client.query('BEGIN');

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

      // 锁内快路径：同 key 已入账 → 返回首次结果（INV-13）
      if (input.idempotency_key !== null) {
        const existing = await client.query<EventRow>(
          `SELECT * FROM events WHERE stream_id = $1 AND idempotency_key = $2`,
          [input.stream_id, input.idempotency_key],
        );
        if (existing.rows.length > 0) {
          const row = existing.rows[0];
          await client.query('ROLLBACK');
          settled = true;
          if (row.type !== input.type || row.payload_canonical !== payload_canonical) {
            throw new IdempotencyKeyConflictError(input.stream_id, input.idempotency_key);
          }
          return rowToEnvelope(row);
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

      await client.query('COMMIT');
      settled = true;

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
    } catch (error) {
      if (!settled) {
        await client.query('ROLLBACK').catch(() => undefined);
        settled = true;
      }

      // 唯一索引兜底：并发同 key 跨路径（23505），回滚后重查首次行
      if (isUniqueViolation(error, 'events_stream_idem_uq') && input.idempotency_key !== null) {
        const { rows } = await pool.query<EventRow>(
          `SELECT * FROM events WHERE stream_id = $1 AND idempotency_key = $2`,
          [input.stream_id, input.idempotency_key],
        );
        if (rows.length === 1) {
          if (rows[0].type !== input.type || rows[0].payload_canonical !== payload_canonical) {
            throw new IdempotencyKeyConflictError(input.stream_id, input.idempotency_key);
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
      client.release();
    }
  }

  async function readStream(stream_id: string, from_seq = 1): Promise<EventEnvelope[]> {
    const { rows } = await pool.query<EventRow>(
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
    const { rows } = await pool.query<EventRow>(
      `SELECT * FROM events
       WHERE global_seq >= $1
       ORDER BY global_seq ASC`,
      [from_global_seq],
    );
    return rows.map(rowToEnvelope);
  }

  async function verifyChain(stream_id: string): Promise<ChainVerification> {
    const { rows } = await pool.query<{
      seq: string;
      prev_hash: string;
      hash: string;
      payload_canonical: string;
    }>(
      `SELECT seq, prev_hash, hash, payload_canonical FROM events
       WHERE stream_id = $1 ORDER BY seq ASC`,
      [stream_id],
    );

    let expectedPrev = GENESIS_HASH;
    let expectedSeq = 1;
    for (const row of rows) {
      const seq = toSafeNumber(row.seq, 'events.seq');
      if (seq !== expectedSeq) {
        return {
          ok: false,
          stream_id,
          length: rows.length,
          broken_at_seq: seq,
          reason: `seq 不连续：期望 ${expectedSeq}，实际 ${seq}`,
        };
      }
      if (row.prev_hash !== expectedPrev) {
        return {
          ok: false,
          stream_id,
          length: rows.length,
          broken_at_seq: seq,
          reason: `prev_hash 断链：期望 ${expectedPrev}，实际 ${row.prev_hash}`,
        };
      }
      const recomputed = computeEventHash(row.prev_hash, row.payload_canonical, seq);
      if (recomputed !== row.hash) {
        return {
          ok: false,
          stream_id,
          length: rows.length,
          broken_at_seq: seq,
          reason: `hash 不匹配：重算 ${recomputed}，实际 ${row.hash}`,
        };
      }
      expectedPrev = row.hash;
      expectedSeq = seq + 1;
    }

    return {
      ok: true,
      stream_id,
      length: rows.length,
      broken_at_seq: null,
      reason: null,
    };
  }

  async function appendStateTransition(
    input: AppendStateTransitionInput,
  ): Promise<{ event: EventEnvelope; guard: GuardResult }> {
    const entity = input.entity ?? 'task';
    // ① 事件类型必须属于该实体的迁移事件家族（spec §4）
    assertTransitionEventType(entity, input.type);

    const guard = guardTransition({
      entity,
      from: input.from,
      to: input.to,
      event_type: input.type,
      facts: input.facts,
    });

    // 校验不通过：不进入事务、不写任何行
    if (!guard.allowed) throw new TransitionDeniedError(guard);

    // ② payload.from/to 缺失则补齐、矛盾则拒绝；guard 判定与落库内容必须同源
    const payload = mergeTransitionPayload(input.payload, input.from, input.to);

    const event = await append({
      stream_id: input.stream_id,
      type: input.type,
      actor_id: input.actor_id,
      actor_kind: input.actor_kind,
      causation_id: input.causation_id,
      correlation_id: input.correlation_id,
      idempotency_key: input.idempotency_key,
      payload,
    });

    return { event, guard };
  }

  return { append, readStream, replay, appendStateTransition, verifyChain };
}
