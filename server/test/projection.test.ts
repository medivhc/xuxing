import { describe, expect, it } from 'vitest';
import type { EventEnvelope, EventType } from '../../src/kernel/events.ts';
import { XuxingProjection } from '../src/projection/projection.ts';
import { computeAvailableActions, isActionableFor } from '../src/projection/actions.ts';

// 投影是纯函数：只喂事件信封即可断言（不碰 PG），验证"状态全部由事件派生"。
let seq = 0;

function ev(type: EventType, stream_id: string, payload: unknown, extra: Partial<EventEnvelope> = {}): EventEnvelope {
  seq += 1;
  return {
    id: `evt-${seq}`,
    stream_id,
    seq,
    global_seq: seq,
    type,
    actor_id: 'user-1',
    actor_kind: 'human',
    causation_id: null,
    correlation_id: 'c-1',
    idempotency_key: null,
    payload,
    prev_hash: '0'.repeat(64),
    hash: 'f'.repeat(64),
    occurred_at: '2026-10-24T00:00:00.000Z',
    recorded_at: '2026-10-24T00:00:00.000Z',
    ...extra,
  };
}

describe('投影：状态由事件派生', () => {
  it('TaskCaptured + lifecycle 迁移 → 任务状态与水位跟随事件', () => {
    const p = new XuxingProjection();
    p.apply(ev('ProjectCreated', 'proj-1', { name: '演示项目', created_by: 'user-1' }));
    p.apply(ev('TaskCaptured', 'proj-1', {
      task_id: 'task-1',
      title: '联系张三确认方案',
      assignee_kind: 'human',
      capture_id: 'cap-1',
      acceptance_criteria: [{ criterion_ref: 'c1', text: '确认方案' }],
    }));

    const captured = p.snapshot();
    expect(captured.projection_version).toBe(2);
    expect(captured.tasks[0]).toMatchObject({ task_id: 'task-1', lifecycle: 'captured', wait_state: 'none' });

    p.apply(ev('TaskLifecycleChanged', 'proj-1', { task_id: 'task-1', from: 'captured', to: 'defined' }));
    expect(p.snapshot().tasks[0].lifecycle).toBe('defined');
  });

  it('投影态不一致立即抛错（不静默跳过）', () => {
    const p = new XuxingProjection();
    p.apply(ev('TaskCaptured', 'proj-1', { task_id: 't', title: 'x', assignee_kind: 'human' }));
    expect(() =>
      p.apply(ev('TaskLifecycleChanged', 'proj-1', { task_id: 't', from: 'defined', to: 'ready' })),
    ).toThrow(/投影态不一致/);
  });

  it('同一事件重复并入是幂等的（cursor 补发重放不炸）', () => {
    const p = new XuxingProjection();
    const e = ev('TaskCaptured', 'proj-1', { task_id: 't', title: 'x', assignee_kind: 'human' });
    p.apply(e);
    p.apply(e);
    expect(p.snapshot().tasks).toHaveLength(1);
    expect(p.snapshot().projection_version).toBe(e.global_seq);
  });

  it('提案 degraded 标记从事件一路带到投影', () => {
    const p = new XuxingProjection();
    p.apply(ev('PlanChangeProposed', 'proj-1', {
      change_id: 'pc-1',
      kind: 'capture_task',
      capture_id: 'cap-1',
      base_plan_rev: 0,
      ops: [{ op: 'add_task' }],
      risk_level: 'L0',
      proposer: { source: 'fallback', model: null, degraded: true, degraded_reason: 'model_unavailable', latency_ms: null },
      details: { task: { title: '占位任务', description: '', assignee_kind: 'human', acceptance_criteria: [] } },
    }));
    expect(p.getProposal('pc-1')?.proposer.degraded).toBe(true);
    expect(p.getProposal('pc-1')?.proposer.degraded_reason).toBe('model_unavailable');
  });
});

describe('available_actions：由内核 guard 推出', () => {
  function snapshotWith(events: EventEnvelope[]) {
    const p = new XuxingProjection().applyAll(events);
    return p.snapshot();
  }

  it('captured → 有"定义完成"动作', () => {
    const snap = snapshotWith([ev('TaskCaptured', 'proj-1', { task_id: 't', title: '联系张三', assignee_kind: 'human' })]);
    const actions = computeAvailableActions(snap.tasks[0], snap, 'user-1');
    expect(actions.map((a) => a.id)).toEqual(['next_lifecycle', 'cancel_task']);
    expect(actions[0].next).toMatchObject({ from: 'captured', to: 'defined', guard: 'allowed' });
  });

  it('无 title 的 captured 任务不给出"定义完成"（内核前置条件拒绝）', () => {
    const snap = snapshotWith([ev('TaskCaptured', 'proj-1', { task_id: 't', title: '   ', assignee_kind: 'human' })]);
    // 只剩"取消"（captured→canceled 不要求 title），没有"定义完成"
    expect(computeAvailableActions(snap.tasks[0], snap, 'user-1').map((a) => a.id)).toEqual(['cancel_task']);
  });

  it('active 且有人类 Run → 出现"提交执行反馈"，ready 属于 MyActions', () => {
    const snap = snapshotWith([
      ev('TaskCaptured', 'proj-1', { task_id: 't', title: '联系张三', assignee_kind: 'human' }),
      ev('TaskLifecycleChanged', 'proj-1', { task_id: 't', from: 'captured', to: 'defined' }),
      ev('TaskLifecycleChanged', 'proj-1', { task_id: 't', from: 'defined', to: 'ready' }),
      ev('RunCreated', 'proj-1', { run_id: 'run-1', task_id: 't', run_kind: 'human_light', actor_id: 'user-1' }),
      ev('RunStarted', 'proj-1', { run_id: 'run-1' }),
      ev('TaskLifecycleChanged', 'proj-1', { task_id: 't', from: 'ready', to: 'active' }),
    ]);
    const actions = computeAvailableActions(snap.tasks[0], snap, 'user-1');
    expect(actions.map((a) => a.id)).toContain('submit_feedback');
    expect(isActionableFor(snap.tasks[0], snap, 'user-1')).toBe(true);
    // 别人看不到"提交反馈"
    expect(computeAvailableActions(snap.tasks[0], snap, 'user-2').map((a) => a.id)).not.toContain('submit_feedback');
  });

  it('awaiting_acceptance → 验收通过/退回两个动作都来自 guard', () => {
    const snap = snapshotWith([
      ev('TaskCaptured', 'proj-1', {
        task_id: 't', title: '联系张三', assignee_kind: 'human',
        acceptance_criteria: [{ criterion_ref: 'c1', text: '确认方案' }],
      }),
      ev('TaskLifecycleChanged', 'proj-1', { task_id: 't', from: 'captured', to: 'defined' }),
      ev('TaskLifecycleChanged', 'proj-1', { task_id: 't', from: 'defined', to: 'ready' }),
      ev('TaskLifecycleChanged', 'proj-1', { task_id: 't', from: 'ready', to: 'active' }),
      ev('OutcomeRecorded', 'proj-1', { task_id: 't', outcome_id: 'o-1', conclusion_kind: 'no_response' }),
      ev('TaskLifecycleChanged', 'proj-1', { task_id: 't', from: 'active', to: 'awaiting_acceptance' }),
    ]);
    const actions = computeAvailableActions(snap.tasks[0], snap, 'user-1');
    const verdicts = actions.filter((a) => a.id === 'record_acceptance').map((a) => a.verdict);
    expect(verdicts).toEqual(['accepted', 'rejected', 'partially_accepted']);
  });
});
