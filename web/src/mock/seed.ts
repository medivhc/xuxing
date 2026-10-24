// Mock 种子数据：project proj-d8（e2e 车道默认项目 id）+ 覆盖全旅程的实体状态。
//
// 设计口径（与契约/内核对齐，mock 只模拟、不发明领域规则）：
// - 待验收任务（awaiting_acceptance）不进 My Actions（D10/OQ-02=A），只在
//   Home attention（acceptance_due）与 Project 页出现；
// - actor 模型：human-user 执行（human_light Run）、human-reviewer 验收、
//   agent-exec-1 执行 agent 任务；REQ-ACC-2 要求验收者与 Run 执行者分离，
//   故验收命令的 acceptor 固定为 human-reviewer；
// - 领域状态与种子事件日志手工保持一致（mock 开发件，非生产投影实现）；
//   命令路径上状态与事件由同一段代码更新，天然一致。

import type { MockDecisionState, MockProjectState, MockProposalState, MockTaskState, SeedEvent } from './types';

export const SEED_PROJECT_ID = 'proj-d8';

export function seedProject(): MockProjectState {
  return {
    project_id: SEED_PROJECT_ID,
    name: 'K0 旅程验证项目',
    goal: {
      statement: '打通「捕获 → 提议 → 任务 → 验收」最小闭环',
      success_criteria: '四入口可走通完整旅程；逐判据验收可提交可呈现',
      stop_conditions: '连续两次旅程验收失败即暂停收敛',
      status: 'active',
    },
    // FIX-ROUND-1 R-8：plan_rev/plan_history 已从投影键集移除
  };
}

export function seedTasks(): MockTaskState[] {
  return [
    {
      task_id: 'task-seed-1',
      title: '整理发布检查清单',
      description: '把发布前必须核对的事项整理成清单，逐项确认。',
      lifecycle: 'active',
      wait_state: 'none',
      duplicate_suspect: false,
      current_contract_rev: 1,
      assignee: { actor_id: 'agent-exec-1', actor_kind: 'agent' },
      active_run: { run_id: 'run-seed-1', state: 'running', run_kind: 'executor' },
      last_outcome_id: null,
      acceptance_criteria: [
        { criterion_ref: 'task-seed-1/c1', text: '清单覆盖构建、测试、发布三步', auto: false },
        { criterion_ref: 'task-seed-1/c2', text: '每项均有负责人与回滚口令', auto: false },
      ],
      criterion_results: [],
      acceptance: null,
      executed_by: 'agent-exec-1',
      updated_global_seq: 9,
    },
    {
      task_id: 'task-seed-2',
      title: '核对契约 v0.2 验收清单',
      description: '按契约 v0.2 逐条核对交互验收清单并记录结论。',
      lifecycle: 'awaiting_acceptance',
      wait_state: 'none',
      duplicate_suspect: false,
      current_contract_rev: 1,
      assignee: { actor_id: 'agent-exec-1', actor_kind: 'agent' },
      active_run: null,
      last_outcome_id: 'outcome-seed-2',
      acceptance_criteria: [
        { criterion_ref: 'task-seed-2/c1', text: '四入口路由与契约一致', auto: false },
        { criterion_ref: 'task-seed-2/c2', text: '命令入口只走 POST /api/commands', auto: false },
        { criterion_ref: 'task-seed-2/c3', text: 'SSE 三纪律可观测（订阅先行/游标自理/35s 看护）', auto: true },
      ],
      // 已记录一条判论（部分验收），其余待补 —— 用于验证 partially_accepted 呈现
      criterion_results: [
        {
          criterion_ref: 'task-seed-2/c1',
          verdict: 'passed',
          note: '路由逐条核对通过',
          evidence_refs: ['docs/interaction-contract.md'],
        },
      ],
      acceptance: {
        acceptance_id: 'acc-seed-2',
        contract_rev: 1,
        subject_outcome_id: 'outcome-seed-2',
        acceptor_id: 'human-reviewer',
        verdict: 'partially_accepted',
        criterion_results: [
          {
            criterion_ref: 'task-seed-2/c1',
            verdict: 'passed',
            note: '路由逐条核对通过',
            evidence_refs: ['docs/interaction-contract.md'],
          },
        ],
        rationale: null,
        created_at: '2026-10-20T08:30:00.000Z',
        superseded: false,
      },
      executed_by: 'agent-exec-1',
      updated_global_seq: 12,
    },
    {
      task_id: 'task-seed-3',
      title: '回顾上周阻塞项',
      description: '把上周遗留的阻塞项过一遍，确认哪些可以关闭。',
      lifecycle: 'captured',
      wait_state: 'none',
      duplicate_suspect: false,
      current_contract_rev: 0,
      assignee: null,
      active_run: null,
      last_outcome_id: null,
      acceptance_criteria: [],
      criterion_results: [],
      acceptance: null,
      executed_by: null,
      updated_global_seq: 3,
    },
  ];
}

export function seedDecisions(): MockDecisionState[] {
  return [
    {
      decision_id: 'decision-dec-1',
      project_id: SEED_PROJECT_ID,
      question: '发布窗口选本周四还是下周一？',
      recommendation: '本周四（避开月末对账高峰）',
      alternatives: ['本周四', '下周一'],
      evidence_refs: ['docs/DECISIONS.md#D8'],
      status: 'pending',
      expires_at: '2026-10-24T00:00:00.000Z',
      created_at: '2026-10-19T10:00:00.000Z',
      updated_global_seq: 13,
    },
  ];
}

export function seedProposals(): MockProposalState[] {
  return [];
}

export function seedCaptures(): Array<{ capture_id: string; project_id: string; text: string; proposal_id: string | null; created_at: string }> {
  return [];
}

/** 种子事件日志（store 分配 seq）。与上面的领域状态讲述同一段历史。 */
export function seedEvents(): SeedEvent[] {
  return [
    { kind: 'ProjectCreated', project_id: SEED_PROJECT_ID, summary: '创建项目「K0 旅程验证项目」' },
    { kind: 'GoalCreated', project_id: SEED_PROJECT_ID, summary: '设定目标：打通捕获到验收最小闭环' },
    { kind: 'TaskCaptured', project_id: SEED_PROJECT_ID, task_id: 'task-seed-3', summary: '捕获任务「回顾上周阻塞项」' },
    { kind: 'TaskCaptured', project_id: SEED_PROJECT_ID, task_id: 'task-seed-1', summary: '捕获任务「整理发布检查清单」' },
    { kind: 'TaskCaptured', project_id: SEED_PROJECT_ID, task_id: 'task-seed-2', summary: '捕获任务「核对契约 v0.2 验收清单」' },
    {
      kind: 'TaskDefined',
      project_id: SEED_PROJECT_ID,
      task_id: 'task-seed-1',
      summary: '任务「整理发布检查清单」契约定稿（rev 1，2 条判据）',
    },
    {
      kind: 'TaskDefined',
      project_id: SEED_PROJECT_ID,
      task_id: 'task-seed-2',
      summary: '任务「核对契约 v0.2 验收清单」契约定稿（rev 1，3 条判据）',
    },
    {
      kind: 'AssignmentCreated',
      project_id: SEED_PROJECT_ID,
      task_id: 'task-seed-1',
      summary: '任务「整理发布检查清单」指派给 agent-exec-1',
    },
    {
      kind: 'AssignmentCreated',
      project_id: SEED_PROJECT_ID,
      task_id: 'task-seed-2',
      summary: '任务「核对契约 v0.2 验收清单」指派给 agent-exec-1',
    },
    {
      kind: 'RunStarted',
      project_id: SEED_PROJECT_ID,
      task_id: 'task-seed-1',
      summary: '任务「整理发布检查清单」开始执行',
    },
    {
      kind: 'RunSucceeded',
      project_id: SEED_PROJECT_ID,
      task_id: 'task-seed-2',
      summary: '任务「核对契约 v0.2 验收清单」执行完成，等待验收',
    },
    {
      kind: 'OutcomeRecorded',
      project_id: SEED_PROJECT_ID,
      task_id: 'task-seed-2',
      summary: '任务「核对契约 v0.2 验收清单」记录产出',
    },
    {
      kind: 'AcceptanceRecorded',
      project_id: SEED_PROJECT_ID,
      task_id: 'task-seed-2',
      summary: '任务「核对契约 v0.2 验收清单」记录 1/3 条判论（部分验收）',
    },
    {
      kind: 'DecisionCreated',
      project_id: SEED_PROJECT_ID,
      decision_id: 'decision-dec-1',
      summary: '新决策：发布窗口选本周四还是下周一？',
    },
  ];
}
