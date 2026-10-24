// actor 身份与分离校验（K0-Q12 / C6）——纯函数层，无 IO。
// 依据：冻结 spec v1.0 §2.5 INV-6、§2.6 REQ-ACC-2、§4 事件信封。
// 内核写路径（event-store-pg 的 prepareAppend）与命令层共用本模块，口径只有一份。

import type { ActorKind } from './events.js';

export const ACTOR_KINDS: readonly ActorKind[] = ['human', 'agent', 'system', 'external'];

/** actor_id 字符集：与命令层 client_submit_id 同口径（[A-Za-z0-9:_-.]，1–128 位）。 */
export const ACTOR_ID_PATTERN = /^[A-Za-z0-9:_.\-]{1,128}$/;

export class ActorValidationError extends Error {
  readonly detail: { field: string; reason: string };
  constructor(message: string, detail: { field: string; reason: string }) {
    super(message);
    this.name = 'ActorValidationError';
    this.detail = detail;
  }
}

export class ActorSeparationError extends Error {
  readonly detail: { reason: 'acceptor_is_run_actor' | 'manual_criterion_needs_reviewer'; [k: string]: unknown };
  constructor(
    message: string,
    detail: { reason: 'acceptor_is_run_actor' | 'manual_criterion_needs_reviewer'; [k: string]: unknown },
  ) {
    super(message);
    this.name = 'ActorSeparationError';
    this.detail = detail;
  }
}

/** INV-6：tool_output Evidence 只许经 Tool Gateway 通道写入，通用写路径命中即抛此错。 */
export class ToolOutputChannelError extends Error {
  readonly detail = { reason: 'tool_output_channel_required' as const };
  constructor(message: string) {
    super(message);
    this.name = 'ToolOutputChannelError';
  }
}

/**
 * actor 身份形状校验：缺失 / 空 / 类型错 / kind 非枚举一律拒绝。
 * 在写路径调用 = 拒绝即零落盘（校验发生在任何 INSERT 之前）。
 */
export function validateActorIdentity(actor_id: unknown, actor_kind: unknown): { actor_id: string; actor_kind: ActorKind } {
  if (typeof actor_id !== 'string' || actor_id.trim().length === 0) {
    throw new ActorValidationError('actor_id 必填且必须是非空字符串（spec §4 事件信封）', {
      field: 'actor_id',
      reason: 'actor_id_missing',
    });
  }
  if (!ACTOR_ID_PATTERN.test(actor_id)) {
    throw new ActorValidationError('actor_id 限 1-128 位 [A-Za-z0-9:_-.]', {
      field: 'actor_id',
      reason: 'actor_id_invalid',
    });
  }
  if (typeof actor_kind !== 'string' || !(ACTOR_KINDS as readonly string[]).includes(actor_kind)) {
    throw new ActorValidationError(
      `actor_kind 必须是 ${ACTOR_KINDS.join(' / ')} 之一（spec §4 事件信封）`,
      { field: 'actor_kind', reason: 'actor_kind_invalid' },
    );
  }
  return { actor_id, actor_kind: actor_kind as ActorKind };
}

export interface AcceptanceSeparationInput {
  acceptor_id: string;
  acceptor_kind: ActorKind;
  /** subject Outcome 所属 Run 的执行者（REQ-ACC-2 的判定对象，不是全部 Run 的执行者集合）。 */
  subject_run: { run_id: string; run_kind: string; actor_id: string } | null;
  /** 本次验收覆盖的判据（取 auto 标记判定 system 代判）。 */
  criteria: Array<{ criterion_ref: string; auto: boolean }>;
}

/**
 * REQ-ACC-2 分离判定（K0-Q12 裁决口径，见 Q12-1024.md §1.3）：
 * - acceptor 是 subject Run（run_kind='executor'）的执行者 → 拒（acceptor_is_run_actor）；
 * - 含非 auto 判据且 acceptor_kind='system' → 拒（manual_criterion_needs_reviewer）；
 * - human_light Run 的人类执行者自验收不在此拒（命令层以 self_acceptance 标记诚实落盘）。
 * 通过返回 { self_acceptance } 供事件落盘标记。
 */
export function assertAcceptanceActorSeparation(input: AcceptanceSeparationInput): { self_acceptance: boolean } {
  const { acceptor_id, acceptor_kind, subject_run, criteria } = input;
  if (subject_run && subject_run.actor_id === acceptor_id && subject_run.run_kind === 'executor') {
    throw new ActorSeparationError(
      `acceptor=${acceptor_id} 是 subject Outcome 所属 Run ${subject_run.run_id} 的执行者（REQ-ACC-2 拦截）`,
      { reason: 'acceptor_is_run_actor', run_id: subject_run.run_id, acceptor_id },
    );
  }
  const manual = criteria.filter((c) => !c.auto);
  if (manual.length > 0 && acceptor_kind === 'system') {
    throw new ActorSeparationError(
      `判据 ${manual.map((m) => m.criterion_ref).join(', ')} 非 auto，须由人类或独立评审 actor 结论，system 不得代判（REQ-ACC-2）`,
      { reason: 'manual_criterion_needs_reviewer', manual_criteria: manual.map((m) => m.criterion_ref) },
    );
  }
  return {
    self_acceptance: subject_run !== null && subject_run.actor_id === acceptor_id,
  };
}

/** Evidence 的 source_kind 封闭集（spec §2.5）。 */
export const EVIDENCE_SOURCE_KINDS = ['user_statement', 'agent_claim', 'tool_output', 'external_doc', 'device_log'] as const;
export type EvidenceSourceKind = (typeof EVIDENCE_SOURCE_KINDS)[number];

export function isEvidenceSourceKind(value: unknown): value is EvidenceSourceKind {
  return typeof value === 'string' && (EVIDENCE_SOURCE_KINDS as readonly string[]).includes(value);
}
