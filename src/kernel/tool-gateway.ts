// Tool Gateway（K0-Q12 / INV-6）：spec S5 定案 = 内核模块 + 专用凭据 + 审计事件（不做独立服务）。
// 职责：唯一被授权写 source_kind='tool_output' Evidence 的通道。
// 纪律：
// - 凭据只在构造时注入（服务端从环境变量读），逐次调用核验，常量时间比较；
// - 凭据不入事件、不入日志、不落盘到仓库；未配置凭据 = 网关关闭（fail-closed）；
// - 每次成功写入由内核在事件 payload 注入 recorded_via/gateway_id 审计字段。
// 模块边界即 K1 把网关抽为独立服务时的接缝。

import { timingSafeEqual } from 'node:crypto';
import type { EventEnvelope, ProjectId } from './events.js';
import { ActorValidationError, validateActorIdentity } from './actor-guard.js';

export interface ToolGatewayConfig {
  /** 网关标识（进审计字段，不含秘密）。 */
  gateway_id: string;
  /** 专用凭据；null/空 = 网关关闭。 */
  credential: string | null;
}

export interface ToolOutputEvidenceInput {
  stream_id: ProjectId;
  actor_id: string;
  actor_kind: EventEnvelope['actor_kind'];
  causation_id: string | null;
  correlation_id: string;
  idempotency_key: string | null;
  /** Evidence payload：必须含 task_id / content_ref / content_hash 等，source_kind 可省略（强制 tool_output）。 */
  payload: Record<string, unknown>;
}

/** store 侧的网关专用写入口（由 PgEventStore 实现，普通 append 没有这条路径）。 */
export interface ToolGatewayStore {
  appendToolOutputEvidence(
    input: Parameters<import('./event-store.js').EventStore['append']>[0] & { gateway_id: string },
  ): Promise<EventEnvelope>;
}

export class ToolGatewayCredentialError extends Error {
  readonly detail = { reason: 'tool_gateway_credential_invalid' as const };
  constructor(message: string) {
    super(message);
    this.name = 'ToolGatewayCredentialError';
  }
}

function credentialEquals(expected: string, presented: unknown): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class ToolGateway {
  readonly gateway_id: string;
  readonly #credential: string | null;
  readonly #store: ToolGatewayStore;

  constructor(store: ToolGatewayStore, config: ToolGatewayConfig) {
    this.#store = store;
    this.gateway_id = config.gateway_id;
    this.#credential = config.credential !== null && config.credential.length > 0 ? config.credential : null;
  }

  get enabled(): boolean {
    return this.#credential !== null;
  }

  /**
   * 以网关凭据写一条 tool_output Evidence。
   * presented_credential 错误/缺失、网关未配置 → ToolGatewayCredentialError，零落盘。
   */
  async recordToolOutputEvidence(
    presented_credential: unknown,
    input: ToolOutputEvidenceInput,
  ): Promise<EventEnvelope> {
    if (this.#credential === null || !credentialEquals(this.#credential, presented_credential)) {
      throw new ToolGatewayCredentialError('Tool Gateway 凭据无效或未配置（INV-6：tool_output 写入失败）');
    }
    validateActorIdentity(input.actor_id, input.actor_kind);
    const payload: Record<string, unknown> = { ...input.payload, source_kind: 'tool_output' };
    if (payload.task_id !== undefined && typeof payload.task_id !== 'string') {
      throw new ActorValidationError('Evidence.payload.task_id 必须是字符串', {
        field: 'task_id',
        reason: 'evidence_task_id_invalid',
      });
    }
    return this.#store.appendToolOutputEvidence({
      stream_id: input.stream_id,
      type: 'EvidenceAdded',
      actor_id: input.actor_id,
      actor_kind: input.actor_kind,
      causation_id: input.causation_id,
      correlation_id: input.correlation_id,
      idempotency_key: input.idempotency_key,
      payload,
      gateway_id: this.gateway_id,
    });
  }
}

export function createToolGateway(store: ToolGatewayStore, config: ToolGatewayConfig): ToolGateway {
  return new ToolGateway(store, config);
}
