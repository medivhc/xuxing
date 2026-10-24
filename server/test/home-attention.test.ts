// Home attention 派生规则单测（契约 docs/interaction-contract.md §2.2 定版）。
// 纯投影函数测试：手工构造 ProjectionSnapshot，不依赖 PG。
// 钉死四件事：① 六类 kind 的出现条件；② 消失条件（终态/已裁决/已对账）；
// ③ 键集与 attention_id 格式；④ rank 由服务端按 kind 优先序顺序编号。
// 背景：真实投影曾缺失 attention 字段导致公网整页白屏（WHITESCREEN-FIX-1024）。

import { describe, expect, it } from 'vitest';
import { attentionItems, homeView } from '../src/api/views.ts';
import type {
  AcceptanceRecord,
  DecisionRecord,
  ProjectionSnapshot,
  ProposalRecord,
  RunRecord,
  TaskRecord,
  WaitConditionRecord,
} from '../src/projection/projection.ts';

const ACTOR = { actor_id: 'user_demo' };
const T0 = '2026-10-20T08:00:00.000Z';

function makeTask(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    task_id: 'task-x',
    project_id: 'proj-x',
    goal_id: null,
    title: '任务',
    description: '',
    lifecycle: 'defined',
    wait_state: 'none',
    assignee_kind: 'agent',
    assigned_by: null,
    current_contract_rev: 1,
    plan_rev_introduced: 1,
    duplicate_suspect: false,
    acceptance_criteria: [{ criterion_ref: 'c1', text: '判据', auto: false }],
    capture_id: null,
    proposal_id: null,
    cancel_requested_by: null,
    last_outcome_id: null,
    feedback_count: 0,
    updated_global_seq: 1,
    ...overrides,
  };
}

function makeProposal(overrides: Partial<ProposalRecord>): ProposalRecord {
  return {
    proposal_id: 'prop-x',
    project_id: 'proj-x',
    kind: 'capture_task',
    status: 'proposed',
    capture_id: 'cap-x',
    task_id: null,
    run_id: null,
    base_plan_rev: 1,
    ops: [],
    rationale: '',
    assumptions: [],
    risk_level: 'L0',
    proposer: { source: 'model', model: 'm', degraded: false, degraded_reason: null, latency_ms: 1 },
    details: {
      kind: 'capture_task',
      task: { title: '草稿', description: '', assignee_kind: 'agent', acceptance_criteria: [] },
    },
    status_reason: null,
    created_at: T0,
    updated_global_seq: 1,
    ...overrides,
  };
}

function makeAcceptance(overrides: Partial<AcceptanceRecord>): AcceptanceRecord {
  return {
    acceptance_id: 'acc-x',
    task_id: 'task-x',
    contract_rev: 1,
    subject_outcome_id: null,
    acceptor_id: 'human-reviewer',
    acceptor_kind: 'human',
    verdict: 'accepted',
    criterion_results: [],
    rationale: '',
    created_at: T0,
    superseded_by: null,
    updated_global_seq: 1,
    ...overrides,
  };
}

function makeRun(overrides: Partial<RunRecord>): RunRecord {
  return {
    run_id: 'run-x',
    task_id: 'task-x',
    assignment_id: null,
    run_kind: 'executor',
    state: 'running',
    actor_id: 'agent-exec-1',
    side_effect_level: 'L0',
    executor_kind: null,
    side_effect_count: 0,
    updated_global_seq: 1,
    ...overrides,
  };
}

function makeDecision(overrides: Partial<DecisionRecord>): DecisionRecord {
  return {
    decision_id: 'dec-x',
    project_id: 'proj-x',
    subject_ref: { kind: 'plan_change', id: 'prop-x' },
    question: '是否批准该变更？',
    recommendation: null,
    alternatives: [],
    evidence_refs: [],
    status: 'pending',
    decided_by: null,
    decided_at: null,
    verdict: null,
    reason: null,
    wake_condition: null,
    disposition: null,
    duplicate_of: null,
    expires_at: null,
    created_at: T0,
    created_global_seq: 1,
    updated_global_seq: 1,
    ...overrides,
  };
}

function makeWait(overrides: Partial<WaitConditionRecord>): WaitConditionRecord {
  return {
    wait_condition_id: 'wc-x',
    task_id: 'task-x',
    kind: 'person',
    target_ref: 'someone',
    followup_task_id: null,
    status: 'active',
    updated_global_seq: 1,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<ProjectionSnapshot>): ProjectionSnapshot {
  return {
    projection_version: 10,
    projects: [
      { project_id: 'proj-x', name: '项目X', policy_id: 'p', created_by: 'user_demo', created_at: T0, updated_global_seq: 1 },
    ],
    goals: [],
    tasks: [],
    runs: [],
    wait_conditions: [],
    acceptances: [],
    feedbacks: [],
    outcomes: [],
    proposals: [],
    decisions: [],
    recent_events: [
      { seq: 10, kind: 'TaskLifecycleChanged', stream_id: 'proj-x', task_id: 'task-acc', proposal_id: null, occurred_at: '2026-10-21T09:00:00.000Z' },
    ],
    ...overrides,
  };
}

describe('home attention 派生（契约 §2.2）', () => {
  it('空快照：attention 恒在且为空数组（字段不能缺）', () => {
    const view = homeView(makeSnapshot({ projects: [], tasks: [], recent_events: [] }), ACTOR);
    expect(view).toHaveProperty('attention');
    expect(view.attention).toEqual([]);
    expect(view.recent).toEqual([]);
  });

  it('decision_pending：K1 口径——status=pending 的 Decision 入列，已裁决/过期不入；提议本身不再派生', () => {
    const items = attentionItems(
      makeSnapshot({
        // K0 近似口径下会产生 decision_pending 的提议，K1 起不得再派生（同源同数看 Decision）
        proposals: [makeProposal({ proposal_id: 'prop-a', status: 'needs_decision' })],
        decisions: [
          makeDecision({ decision_id: 'dec-a', status: 'pending' }),
          makeDecision({ decision_id: 'dec-b', status: 'approved' }),
          makeDecision({ decision_id: 'dec-c', status: 'expired' }),
          makeDecision({ decision_id: 'dec-d', status: 'deferred' }),
        ],
      }),
      ACTOR,
    );
    const decisions = items.filter((i) => i.kind === 'decision_pending');
    expect(decisions.map((i) => i.decision_id)).toEqual(['dec-a']);
    const a = decisions[0]!;
    expect(a.attention_id).toBe('attention:decision_pending:dec-a');
    expect(a.project_id).toBe('proj-x');
    expect(a.available_actions).toEqual(['resolve_decision']);
    expect(a.created_at).toBe(T0);
  });

  it('acceptance_due：awaiting_acceptance 且无有效 Acceptance 或 partially 才入列', () => {
    const items = attentionItems(
      makeSnapshot({
        tasks: [
          makeTask({ task_id: 'task-acc', lifecycle: 'awaiting_acceptance' }),
          makeTask({ task_id: 'task-part', lifecycle: 'awaiting_acceptance' }),
          makeTask({ task_id: 'task-done', lifecycle: 'awaiting_acceptance' }),
          makeTask({ task_id: 'task-rej', lifecycle: 'awaiting_acceptance' }),
          makeTask({ task_id: 'task-active', lifecycle: 'active' }),
        ],
        acceptances: [
          makeAcceptance({ acceptance_id: 'acc-part', task_id: 'task-part', verdict: 'partially_accepted' }),
          makeAcceptance({ acceptance_id: 'acc-done', task_id: 'task-done', verdict: 'accepted' }),
          makeAcceptance({ acceptance_id: 'acc-rej', task_id: 'task-rej', verdict: 'rejected' }),
        ],
      }),
      ACTOR,
    );
    const due = items.filter((i) => i.kind === 'acceptance_due');
    expect(due.map((i) => i.task_id).sort()).toEqual(['task-acc', 'task-part']);
    // created_at 口径：该任务最近事件 occurred_at
    expect(due.find((i) => i.task_id === 'task-acc')!.created_at).toBe('2026-10-21T09:00:00.000Z');
  });

  it('run_indeterminate / duplicate_suspect / wait_expired / cancel_pending 的出现与消失', () => {
    const items = attentionItems(
      makeSnapshot({
        tasks: [
          makeTask({ task_id: 'task-run', lifecycle: 'active' }),
          makeTask({ task_id: 'task-dup', lifecycle: 'ready', duplicate_suspect: true }),
          makeTask({ task_id: 'task-dup-canceled', lifecycle: 'canceled', duplicate_suspect: true }),
          makeTask({ task_id: 'task-wait', lifecycle: 'defined' }),
          makeTask({ task_id: 'task-wait-done', lifecycle: 'accepted' }),
          makeTask({ task_id: 'task-cancel', lifecycle: 'active', cancel_requested_by: 'user_demo' }),
          makeTask({ task_id: 'task-canceled', lifecycle: 'canceled', cancel_requested_by: 'user_demo' }),
        ],
        runs: [
          makeRun({ run_id: 'run-ind', task_id: 'task-run', state: 'indeterminate' }),
          makeRun({ run_id: 'run-ok', task_id: 'task-run', state: 'running' }),
        ],
        wait_conditions: [
          makeWait({ wait_condition_id: 'wc-exp', task_id: 'task-wait', status: 'expired' }),
          makeWait({ wait_condition_id: 'wc-exp-done', task_id: 'task-wait-done', status: 'expired' }),
          makeWait({ wait_condition_id: 'wc-act', task_id: 'task-wait', status: 'active' }),
        ],
      }),
      ACTOR,
    );
    const byKind = (kind: string) => items.filter((i) => i.kind === kind);
    expect(byKind('run_indeterminate').map((i) => i.attention_id)).toEqual(['attention:run_indeterminate:run-ind']);
    expect(byKind('duplicate_suspect').map((i) => i.task_id)).toEqual(['task-dup']);
    expect(byKind('wait_expired').map((i) => i.attention_id)).toEqual(['attention:wait_expired:wc-exp']);
    expect(byKind('cancel_pending').map((i) => i.task_id)).toEqual(['task-cancel']);
  });

  it('键集与 rank：每项必带六键，rank 按 kind 优先序 1..n 顺序编号', () => {
    const items = attentionItems(
      makeSnapshot({
        decisions: [makeDecision({ decision_id: 'dec-a' })],
        tasks: [
          makeTask({ task_id: 'task-acc', lifecycle: 'awaiting_acceptance' }),
          makeTask({ task_id: 'task-run', lifecycle: 'active' }),
          makeTask({ task_id: 'task-cancel', lifecycle: 'active', cancel_requested_by: 'user_demo' }),
          makeTask({ task_id: 'task-wait', lifecycle: 'defined' }),
          makeTask({ task_id: 'task-dup', lifecycle: 'ready', duplicate_suspect: true }),
        ],
        runs: [makeRun({ run_id: 'run-ind', task_id: 'task-run', state: 'indeterminate' })],
        wait_conditions: [makeWait({ wait_condition_id: 'wc-exp', task_id: 'task-wait', status: 'expired' })],
      }),
      ACTOR,
    );
    expect(items.map((i) => i.kind)).toEqual([
      'decision_pending',
      'acceptance_due',
      'run_indeterminate',
      'cancel_pending',
      'wait_expired',
      'duplicate_suspect',
    ]);
    expect(items.map((i) => i.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const item of items) {
      expect(item).toHaveProperty('attention_id');
      expect(item).toHaveProperty('project_id');
      expect(Array.isArray(item.available_actions)).toBe(true);
      expect(typeof item.created_at).toBe('string');
      expect(item.created_at.length).toBeGreaterThan(0);
    }
    // attention_id 全唯一（同任务多类共存不撞 key）
    expect(new Set(items.map((i) => i.attention_id)).size).toBe(items.length);
  });

  it('homeView 页面契约键：recent 为页面形状（event_id），项目带 last_activity_at', () => {
    const view = homeView(makeSnapshot({}), ACTOR);
    expect(view.recent).toHaveLength(1);
    expect(view.recent[0]).toMatchObject({
      event_id: 'evt-10',
      project_id: 'proj-x',
      task_id: 'task-acc',
      occurred_at: '2026-10-21T09:00:00.000Z',
    });
    expect(typeof view.recent[0]!.summary).toBe('string');
    expect(view.projects[0]).toHaveProperty('last_activity_at');
    // API 级附加键保留（journeys 消费）
    expect(view.recent_activity[0]).toHaveProperty('kind');
  });
});
