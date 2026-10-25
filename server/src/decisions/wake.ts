// K1-A deferred 唤起与 Decision 过期服务（K1-SPEC §3.4 / REQ-PC-5 / REQ-DC-1）。
//
// 状态全在事件流里（DecisionResolved 的 wake_condition、DecisionCreated 的
// expires_at），本服务只是无状态扫描器：进程重启后靠投影重演恢复，tick 可重入。
// - 过期：pending 且 expires_at 已过的 Decision → DecisionExpired（Timer 口径）。
// - 唤起 at_time：时刻已到 → 触发；on_event：Decision 所属项目流中在裁决之后
//   出现 wake_condition.event_type 的事件 → 触发。
// - 唤起效果：PlanChange subject 按 REQ-PC-5——Change 回 proposed 并以唤起
//   时刻当前 rev 重走 base 复核：通过 → 应用；撞 base_rev_conflict → 回
//   needs_decision 并生成新 pending Decision。其余 subject 生成克隆的新
//   pending Decision（follow_up_of 指向原 Decision），重新进入裁决队列。

import { ulid } from 'ulid';
import { asProjectId, type EventEnvelope } from '../../../src/kernel/events.ts';
import type { PgEventStore } from '../../../src/kernel/event-store-pg.ts';
import type { DecisionRecord, ProposalRecord } from '../projection/projection.ts';
import type { ProjectionService } from '../projection/service.ts';
import { applyPlanChangeForDecision, currentPlanRev } from '../commands/commands.ts';

export interface DecisionWakeService {
  /** 执行一轮扫描；返回本轮落账概要（测试与日志用）。 */
  tick(): Promise<{ expired: string[]; woken: string[]; follow_up_decisions: string[] }>;
  start(intervalMs: number): void;
  stop(): void;
}

export function createDecisionWakeService(deps: {
  store: PgEventStore;
  projection: ProjectionService;
  clock: () => Date;
}): DecisionWakeService {
  const { store, projection, clock } = deps;
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;

  const systemBase = (project_id: string) => ({
    stream_id: asProjectId(project_id),
    actor_id: 'system',
    actor_kind: 'system' as const,
    causation_id: null,
    correlation_id: `wake-${ulid()}`,
  });

  async function expire(decision: DecisionRecord, nowIso: string): Promise<boolean> {
    await store.append({
      ...systemBase(decision.project_id),
      type: 'DecisionExpired',
      idempotency_key: `wake:expiry:${decision.decision_id}`,
      payload: { decision_id: decision.decision_id, reason: 'expires_at_reached', expired_at: nowIso },
    });
    return true;
  }

  async function wakeDue(decision: DecisionRecord, now: Date): Promise<boolean> {
    const wake = decision.wake_condition;
    if (wake === null) return false;
    if (wake.kind === 'at_time') {
      return wake.at !== null && Date.parse(wake.at) <= now.getTime();
    }
    // on_event：裁决（updated_global_seq）之后该项目流出现目标事件类型即唤起。
    if (wake.event_type === null) return false;
    const events = await store.readStream(asProjectId(decision.project_id), 1);
    return events.some((e) => e.global_seq > decision.updated_global_seq && e.type === wake.event_type);
  }

  async function fireWake(decision: DecisionRecord, nowIso: string): Promise<string | null> {
    const snapshot = projection.snapshot();
    const keyPrefix = `wake:${decision.decision_id}:${decision.updated_global_seq}`;
    let followUpId: string | null = null;

    await store.withTransaction(async (tx) => {
      const base = systemBase(decision.project_id);
      if (decision.subject_ref.kind === 'plan_change') {
        const change: ProposalRecord | undefined = snapshot.proposals.find(
          (p) => p.proposal_id === decision.subject_ref.id,
        );
        if (!change || change.status !== 'needs_decision') return;
        await tx.append({
          ...base,
          type: 'PlanChangeStatusChanged',
          idempotency_key: `${keyPrefix}:proposed`,
          payload: { change_id: change.proposal_id, status: 'proposed', reason: 'decision_wake' },
        });
        const currentRev = currentPlanRev(snapshot, decision.project_id);
        if (change.base_plan_rev === currentRev) {
          const emitted: Array<{ event: EventEnvelope }> = [];
          await applyPlanChangeForDecision(tx, base, keyPrefix, change, 'decision_wake', currentRev, nowIso, emitted);
          return;
        }
        // 撞 base_rev_conflict：回 needs_decision + 新 Decision（REQ-PC-5 回路）
        await tx.append({
          ...base,
          type: 'PlanChangeStatusChanged',
          idempotency_key: `${keyPrefix}:back-to-decision`,
          payload: { change_id: change.proposal_id, status: 'needs_decision', reason: 'base_rev_conflict' },
        });
        followUpId = `dec_${ulid()}`;
        await tx.append({
          ...base,
          type: 'DecisionCreated',
          idempotency_key: `${keyPrefix}:follow-up`,
          payload: {
            decision_id: followUpId,
            subject_ref: { kind: 'plan_change', id: change.proposal_id },
            question: `计划变更 ${change.proposal_id} 在唤起重审时基线版本已变化（base_rev_conflict：申报 base=${change.base_plan_rev}，当前=${currentRev}），请基于当前版本重新裁决`,
            recommendation: '基于当前计划版本重新审阅该变更后再次裁决',
            alternatives: [],
            evidence_refs: [`base_rev:${change.base_plan_rev}`, `current_rev:${currentRev}`],
            follow_up_of: decision.decision_id,
            created_by: 'system',
          },
        });
        return;
      }

      // 其余 subject：克隆一条新 pending Decision 重新入队。
      followUpId = `dec_${ulid()}`;
      await tx.append({
        ...base,
        type: 'DecisionCreated',
        idempotency_key: `${keyPrefix}:follow-up`,
        payload: {
          decision_id: followUpId,
          subject_ref: decision.subject_ref,
          question: decision.question,
          recommendation: decision.recommendation,
          alternatives: decision.alternatives,
          evidence_refs: decision.evidence_refs,
          duplicate_of: decision.duplicate_of,
          follow_up_of: decision.decision_id,
          created_by: 'system',
        },
      });
    });

    await projection.refresh();
    return followUpId;
  }

  async function tick(): Promise<{ expired: string[]; woken: string[]; follow_up_decisions: string[] }> {
    const result = { expired: [] as string[], woken: [] as string[], follow_up_decisions: [] as string[] };
    if (ticking) return result;
    ticking = true;
    try {
      const now = clock();
      const nowIso = now.toISOString();
      const snapshot = projection.snapshot();

      for (const decision of snapshot.decisions) {
        if (decision.status === 'pending' && decision.expires_at !== null && Date.parse(decision.expires_at) <= now.getTime()) {
          await expire(decision, nowIso);
          result.expired.push(decision.decision_id);
        }
      }
      if (result.expired.length > 0) await projection.refresh();

      const afterExpiry = projection.snapshot();
      for (const decision of afterExpiry.decisions) {
        if (decision.status !== 'deferred' || decision.wake_condition === null) continue;
        if (await wakeDue(decision, now)) {
          const followUp = await fireWake(decision, nowIso);
          result.woken.push(decision.decision_id);
          if (followUp !== null) result.follow_up_decisions.push(followUp);
        }
      }
      return result;
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    start(intervalMs: number) {
      if (timer !== null || intervalMs <= 0) return;
      timer = setInterval(() => {
        void tick().catch((error: unknown) => {
          console.error(JSON.stringify({ event: 'decision_wake_tick_failed', message: String(error) }));
        });
      }, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
