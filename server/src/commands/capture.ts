// 写路径编排（HTTP 与种子脚本共用）。
//
// 捕获（POST /api/capture）：
//   提议层先出提议（模型或降级占位）→ 事件落账：
//   PlanChangeProposed（kind=capture_task，携 proposer.degraded）
//   + FeedbackReceived（raw_content = 用户原文；游离 Feedback 不生成 Outcome，REQ-OC-1 来源限定）
//   → 返回 {capture_id, proposal_id, degraded}。
//   捕获不直接建 Task：Task 由用户接受提议后生成（REQ-PC 流水线 / 红线"事件为唯一真相源"）。

import { ulid } from 'ulid';
import type { PgEventStore } from '../../../src/kernel/event-store-pg.ts';
import { asProjectId, type EventEnvelope } from '../../../src/kernel/events.ts';
import type { Proposer } from '../proposers/proposer.ts';
import type { ProjectionService } from '../projection/service.ts';

export interface CaptureOutcome {
  capture_id: string;
  proposal_id: string;
  project_id: string;
  degraded: boolean;
  degraded_reason: string | null;
  proposer: { source: 'model' | 'fallback'; model: string | null; latency_ms: number | null };
  /** 接受提议后将要生成的任务草稿（界面用于"整理中 → 待确认"） */
  draft: { title: string; description: string; assignee_kind: 'human' | 'agent'; acceptance_criteria: unknown[] };
  replayed: boolean;
  projection_version: number;
  /** 本次真正写入的事件信封（供 SSE 广播；幂等重放为空）。不出现在 HTTP 响应体里。 */
  events: EventEnvelope[];
  /** 本次落账的事件序号与类型（响应体里可读，客户端据此对齐 SSE cursor）。 */
  emitted: Array<{ seq: number; kind: string }>;
}

export interface CaptureContext {
  store: PgEventStore;
  projection: ProjectionService;
  proposer: Proposer;
  clock: () => Date;
  /** 缺省项目（未指定 project_id 时落此项目流）。 */
  defaultProjectId: string;
}

export class CaptureValidationError extends Error {
  readonly detail: Record<string, unknown>;
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CaptureValidationError';
    this.detail = detail;
  }
}

const MAX_CAPTURE_LENGTH = 8_000;

/** 捕获幂等键：`capture:<client_submit_id>`（OQ-07 同口径：同一提交 id 只入账一次）。 */
export function captureIdempotencyKey(client_submit_id: string): string {
  return `capture:${client_submit_id}`;
}

export async function runCapture(
  ctx: CaptureContext,
  input: { text: unknown; project_id?: unknown; client_submit_id?: unknown; actor_id: string },
): Promise<CaptureOutcome> {
  if (typeof input.text !== 'string' || input.text.trim().length === 0) {
    throw new CaptureValidationError('text 必填且非空', { field: 'text' });
  }
  const text = input.text.trim();
  if (text.length > MAX_CAPTURE_LENGTH) {
    throw new CaptureValidationError(`text 超长（上限 ${MAX_CAPTURE_LENGTH} 字符）`, { field: 'text' });
  }
  const project_id = typeof input.project_id === 'string' && input.project_id.length > 0
    ? input.project_id
    : ctx.defaultProjectId;
  const project = ctx.projection.snapshot().projects.find((p) => p.project_id === project_id);
  if (!project) {
    throw new CaptureValidationError(`项目 ${project_id} 不存在（先跑种子脚本生成演示项目）`, { field: 'project_id' });
  }
  const client_submit_id = typeof input.client_submit_id === 'string' && input.client_submit_id.length > 0
    ? input.client_submit_id
    : `capture_${ulid()}`;

  // 幂等：同 client_submit_id 重放 → 返回首次的 capture_id / proposal_id，不重复落事件
  const idemKey = captureIdempotencyKey(client_submit_id);
  const prior = (await ctx.store.readStream(asProjectId(project_id), 1)).filter(
    (e) => e.idempotency_key === idemKey || e.idempotency_key === `${idemKey}:feedback`,
  );
  const first = prior.find((e) => e.idempotency_key === idemKey);
  if (first) {
    const priorPayload = first.payload as Record<string, unknown>;
    const proposal_id = typeof priorPayload.change_id === 'string'
      ? priorPayload.change_id
      : typeof priorPayload.proposal_id === 'string'
        ? priorPayload.proposal_id
        : '';
    const proposal = ctx.projection.snapshot().proposals.find((p) => p.proposal_id === proposal_id);
    if (!proposal) {
      // 回执已入账但投影尚未并入（并发窗口）：直接把事件流增量并入后再查一次
      const current = ctx.projection.version();
      const events = await ctx.store.readStream(asProjectId(project_id), 1);
      ctx.projection.ingest(events.filter((e) => e.global_seq > current));
    }
    const proposalAfter = ctx.projection.snapshot().proposals.find((p) => p.proposal_id === proposal_id);
    if (!proposalAfter || proposalAfter.details.kind !== 'capture_task') {
      throw new CaptureValidationError('同 client_submit_id 的捕获记录内容异常', { field: 'client_submit_id' });
    }
    return {
      capture_id: proposalAfter.capture_id ?? '',
      proposal_id: proposalAfter.proposal_id,
      project_id,
      degraded: proposalAfter.proposer.degraded,
      degraded_reason: proposalAfter.proposer.degraded_reason,
      proposer: {
        source: proposalAfter.proposer.source,
        model: proposalAfter.proposer.model,
        latency_ms: proposalAfter.proposer.latency_ms,
      },
      draft: proposalAfter.details.task,
      replayed: true,
      projection_version: ctx.projection.version(),
      events: [],
      emitted: [],
    };
  }

  const proposal = await ctx.proposer.interpretCapture({ text, projectName: project.name });
  const capture_id = `cap_${ulid()}`;
  const proposal_id = `pc_${ulid()}`;
  const now = ctx.clock().toISOString();
  const base = {
    stream_id: asProjectId(project_id),
    actor_id: input.actor_id,
    actor_kind: 'human' as const,
    causation_id: null,
    correlation_id: `capture-${capture_id}`,
  };

  const events: EventEnvelope[] = [];
  await ctx.store.withTransaction(async (tx) => {
    events.push(await tx.append({
      ...base,
      type: 'PlanChangeProposed',
      idempotency_key: idemKey,
      payload: {
        change_id: proposal_id,
        client_proposal_id: capture_id,
        kind: 'capture_task',
        capture_id,
        task_id: null,
        base_plan_rev: ctx.projection.snapshot().projects.length,
        ops: [{ op: 'add_task' }],
        risk_level: 'L0',
        rationale: proposal.rationale,
        assumptions: proposal.meta.degraded ? ['模型不可用，任务草稿为确定性占位'] : [],
        proposer: {
          source: proposal.meta.source,
          model: proposal.meta.model,
          degraded: proposal.meta.degraded,
          degraded_reason: proposal.meta.degraded_reason,
          latency_ms: proposal.meta.latency_ms,
        },
        details: {
          task: {
            title: proposal.title,
            description: proposal.description,
            assignee_kind: proposal.assignee_kind,
            acceptance_criteria: proposal.acceptance_criteria,
          },
        },
        proposed_at: now,
      },
    }));

    events.push(await tx.append({
      ...base,
      type: 'FeedbackReceived',
      idempotency_key: `${idemKey}:feedback`,
      payload: {
        feedback_id: `fb_${capture_id}`,
        task_id: null,
        run_id: null,
        author_id: input.actor_id,
        raw_content: text,
        raw_attachments: [],
        capture_id,
      },
    }));
  });

  await ctx.projection.refresh();

  return {
    capture_id,
    proposal_id,
    project_id,
    degraded: proposal.meta.degraded,
    degraded_reason: proposal.meta.degraded_reason,
    proposer: { source: proposal.meta.source, model: proposal.meta.model, latency_ms: proposal.meta.latency_ms },
    draft: {
      title: proposal.title,
      description: proposal.description,
      assignee_kind: proposal.assignee_kind,
      acceptance_criteria: proposal.acceptance_criteria,
    },
    replayed: false,
    projection_version: ctx.projection.version(),
    events,
    emitted: events.map((event) => ({ seq: event.global_seq, kind: event.type })),
  };
}
