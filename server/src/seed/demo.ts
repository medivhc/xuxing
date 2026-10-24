// 演示项目种子（OQ-05 口径：一个演示项目，供四入口与旅程测试共用）。
//
// 纪律：种子也走事件（ProjectCreated / GoalCreated / TaskCaptured …），不存在"直接写投影表"。
// 幂等：所有事件带固定 idempotency_key（seed:<demo>:<n>），重复执行不产生重复实体。
// 演示项目为人类执行者任务（K0 单用户），因此不需要在册 Agent 能力声明。

import type { PgEventStore } from '../../../src/kernel/event-store-pg.ts';
import type { ProjectionService } from '../projection/service.ts';

/** 与 server/src/app.ts 的 DEFAULT_PROJECT_ID 同源。 */
export const DEFAULT_PROJECT_ID = 'proj_demo_oq05';
export const DEFAULT_ACTOR_ID = 'user_demo';
export const DEFAULT_PG_URL = 'postgres://postgres:postgres@127.0.0.1:55432/xuxing';

export const DEMO_PROJECT = {
  project_id: DEFAULT_PROJECT_ID,
  name: '续行演示 · 客户方案落地',
  created_by: DEFAULT_ACTOR_ID,
  policy_id: 'policy_demo',
  goal: {
    goal_id: 'goal_demo_oq05',
    statement: '把「张三方案确认 → 报价 → 合同」这条客户落地链路跑通并完成验收',
    success_criteria: '每个任务都有可核对反馈，最终验收全部判据通过',
    stop_conditions: '客户明确终止合作时停止',
  },
} as const;

type SeedTask = {
  task_id: string;
  title: string;
  description: string;
  criteria: Array<{ criterion_ref: string; text: string; auto: boolean }>;
  /** 种子内推进到哪个阶段：defined / ready / active / awaiting_acceptance / accepted */
  stage: 'defined' | 'ready' | 'active' | 'awaiting_acceptance' | 'accepted';
  run?: 'none' | 'human_light_running' | 'human_light_succeeded';
  feedback?: string;
  outcome?: { conclusion_kind: string; info_obtained: boolean };
  acceptance?: 'accepted';
};

const DEMO_TASKS: SeedTask[] = [
  {
    task_id: 'task_demo_contact',
    title: '联系张三确认方案',
    description: '给张三打电话确认上周讨论的方案细节，并记录对方意见。',
    criteria: [{ criterion_ref: 'c1', text: '确认了方案的关键细节（时间、范围、负责人）', auto: false }],
    stage: 'active',
    run: 'human_light_running',
  },
  {
    task_id: 'task_demo_quote',
    title: '整理报价单',
    description: '按确认后的方案整理报价单，附上工作量说明。',
    criteria: [
      { criterion_ref: 'c1', text: '报价单覆盖全部交付项', auto: false },
      { criterion_ref: 'c2', text: '金额与工作量一致', auto: false },
    ],
    stage: 'ready',
  },
  {
    task_id: 'task_demo_contract',
    title: '起草合同附件',
    description: '按已确认的方案与报价起草合同附件。',
    criteria: [{ criterion_ref: 'c1', text: '附件条款与方案一致', auto: false }],
    stage: 'defined',
  },
  {
    task_id: 'task_demo_kickoff',
    title: '确认客户启动会时间',
    description: '与客户确认启动会时间（已通过种子演示"已完成"状态）。',
    criteria: [{ criterion_ref: 'c1', text: '已在日历中登记启动会', auto: true }],
    stage: 'accepted',
    run: 'human_light_succeeded',
    feedback: '已和客户约定下周二下午三点的启动会，日历已登记。',
    outcome: { conclusion_kind: 'achieved', info_obtained: true },
    acceptance: 'accepted',
  },
];

export interface SeedResult {
  project_id: string;
  created: boolean;
  tasks: number;
  projection_version: number;
}

export async function seedDemo(input: {
  store: PgEventStore;
  projection: ProjectionService;
  project_id?: string;
  actor_id?: string;
}): Promise<SeedResult> {
  const { store, projection } = input;
  const project_id = input.project_id ?? DEFAULT_PROJECT_ID;
  const actor_id = input.actor_id ?? DEFAULT_ACTOR_ID;
  const existing = projection.snapshot().projects.find((p) => p.project_id === project_id);

  if (!existing) {
    await store.withTransaction(async (tx) => {
      await tx.append({
        stream_id: project_id,
        type: 'ProjectCreated',
        actor_id,
        actor_kind: 'human',
        causation_id: null,
        correlation_id: `seed-${project_id}`,
        idempotency_key: `seed:${project_id}:project`,
        payload: { name: DEMO_PROJECT.name, policy_id: DEMO_PROJECT.policy_id, created_by: actor_id },
      });
      await tx.append({
        stream_id: project_id,
        type: 'GoalCreated',
        actor_id,
        actor_kind: 'human',
        causation_id: null,
        correlation_id: `seed-${project_id}`,
        idempotency_key: `seed:${project_id}:goal`,
        payload: {
          goal_id: DEMO_PROJECT.goal.goal_id,
          statement: DEMO_PROJECT.goal.statement,
          success_criteria: DEMO_PROJECT.goal.success_criteria,
          stop_conditions: DEMO_PROJECT.goal.stop_conditions,
        },
      });
    });
  } else if (existing.name !== DEMO_PROJECT.name) {
    // 允许把项目名改为演示项目名（幂等：同一 key 同内容不重复入账）
    await store.append({
      stream_id: project_id,
      type: 'ProjectCreated',
      actor_id,
      actor_kind: 'human',
      causation_id: null,
      correlation_id: `seed-${project_id}`,
      idempotency_key: `seed:${project_id}:project`,
      payload: { name: DEMO_PROJECT.name, policy_id: DEMO_PROJECT.policy_id, created_by: actor_id },
    });
  }

  await ingest(store, projection, project_id);

  let createdTasks = 0;
  for (const seed of DEMO_TASKS) {
    const snapshot = projection.snapshot();
    if (snapshot.tasks.some((t) => t.task_id === seed.task_id)) continue;
    createdTasks += 1;
    const base = {
      stream_id: project_id,
      actor_id,
      actor_kind: 'human' as const,
      causation_id: null,
      correlation_id: `seed-${project_id}-${seed.task_id}`,
    };
    const key = (suffix: string) => `seed:${project_id}:${seed.task_id}:${suffix}`;

    await store.withTransaction(async (tx) => {
      await tx.append({
        ...base,
        type: 'TaskCaptured',
        idempotency_key: key('captured'),
        payload: {
          task_id: seed.task_id,
          title: seed.title,
          description: seed.description,
          assignee_kind: 'human',
          goal_id: DEMO_PROJECT.goal.goal_id,
          capture_id: null,
          proposal_id: null,
          acceptance_criteria: seed.criteria,
          plan_rev_introduced: 1,
          seeded: true,
        },
      });
      await tx.append({
        ...base,
        type: 'AssignmentCreated',
        idempotency_key: key('assigned'),
        payload: {
          assignment_id: `asg_${seed.task_id}`,
          task_id: seed.task_id,
          actor_id,
          actor_kind: 'human',
          role: 'executor',
          scope_note: '',
          assigned_by: actor_id,
        },
      });
      await tx.append({
        ...base,
        type: 'TaskDefined',
        idempotency_key: key('defined'),
        payload: {
          task_id: seed.task_id,
          title: seed.title,
          description: seed.description,
          contract_rev: 1,
          acceptance_criteria: seed.criteria,
        },
      });
      await tx.appendStateTransition({
        ...base,
        type: 'TaskLifecycleChanged',
        entity: 'task',
        idempotency_key: key('lc-defined'),
        from: 'captured',
        to: 'defined',
        facts: { hasTitle: true, assigneeKind: 'human', contractStructured: seed.criteria.length > 0 },
        payload: { task_id: seed.task_id },
      });

      if (seed.stage === 'defined') return;

      await tx.appendStateTransition({
        ...base,
        type: 'TaskLifecycleChanged',
        entity: 'task',
        idempotency_key: key('lc-ready'),
        from: 'defined',
        to: 'ready',
        payload: { task_id: seed.task_id },
      });
      if (seed.stage === 'ready') return;

      if (seed.run !== undefined && seed.run !== 'none') {
        await tx.append({
          ...base,
          type: 'RunCreated',
          idempotency_key: key('run-created'),
          payload: {
            run_id: `run_${seed.task_id}`,
            task_id: seed.task_id,
            run_kind: 'human_light',
            assignment_id: `asg_${seed.task_id}`,
            actor_id,
            actor_version: 'k0',
            side_effect_level: 'L0',
            task_rev: 1,
            contract_rev: 1,
            plan_rev: 1,
            input_snapshot: { seeded: true },
            policy_snapshot: { policy_id: DEMO_PROJECT.policy_id },
            idempotency_key: key('run'),
          },
        });
        await tx.append({
          ...base,
          type: 'RunStarted',
          idempotency_key: key('run-started'),
          payload: { run_id: `run_${seed.task_id}` },
        });
      }

      await tx.appendStateTransition({
        ...base,
        type: 'TaskLifecycleChanged',
        entity: 'task',
        idempotency_key: key('lc-active'),
        from: 'ready',
        to: 'active',
        payload: { task_id: seed.task_id },
      });

      if (seed.stage === 'active' || seed.run !== 'human_light_succeeded') return;

      // 完成反馈 → Outcome → Run 成功 → awaiting_acceptance
      const feedback_id = `fb_${seed.task_id}`;
      const outcome_id = `out_${seed.task_id}`;
      await tx.append({
        ...base,
        type: 'FeedbackReceived',
        idempotency_key: key('feedback'),
        payload: {
          feedback_id,
          task_id: seed.task_id,
          run_id: `run_${seed.task_id}`,
          author_id: actor_id,
          raw_content: seed.feedback ?? '',
          raw_attachments: [],
          seeded: true,
        },
      });
      const conclusion = seed.outcome?.conclusion_kind ?? 'achieved';
      const info = seed.outcome?.info_obtained ?? true;
      await tx.append({
        ...base,
        type: 'FeedbackInterpreted',
        idempotency_key: key('interpreted'),
        payload: {
          feedback_id,
          run_id: `run_${seed.task_id}`,
          interpretation: {
            conclusion_kind: conclusion,
            info_obtained: info,
            certainty: 'med',
            evidence_sufficiency: 'sufficient',
            blockers: [],
            followup_suggestions: [],
            source: 'fallback',
            degraded: true,
            degraded_reason: 'seed',
          },
          interpreted_by: 'seed',
        },
      });
      await tx.append({
        ...base,
        type: 'OutcomeRecorded',
        idempotency_key: key('outcome'),
        payload: {
          outcome_id,
          task_id: seed.task_id,
          run_id: `run_${seed.task_id}`,
          feedback_id,
          conclusion_kind: conclusion,
          info_obtained: info,
          certainty: 'med',
          evidence_sufficiency: 'sufficient',
          blockers: [],
          followup_suggestions: [],
          interpreted_by: 'seed',
          proposal_id: `pc_${seed.task_id}`,
        },
      });
      await tx.append({
        ...base,
        type: 'RunSucceeded',
        idempotency_key: key('run-succeeded'),
        payload: { run_id: `run_${seed.task_id}`, outcome_id },
      });
      await tx.appendStateTransition({
        ...base,
        type: 'TaskLifecycleChanged',
        entity: 'task',
        idempotency_key: key('lc-awaiting'),
        from: 'active',
        to: 'awaiting_acceptance',
        payload: { task_id: seed.task_id, outcome_id },
      });

      if (seed.acceptance !== 'accepted') return;

      const acceptance_id = `acc_${seed.task_id}`;
      await tx.append({
        ...base,
        type: 'AcceptanceRecorded',
        idempotency_key: key('acceptance'),
        payload: {
          acceptance_id,
          task_id: seed.task_id,
          contract_rev: 1,
          subject_outcome_id: outcome_id,
          acceptor_id: actor_id,
          acceptor_kind: 'human',
          verdict: 'accepted',
          criterion_results: seed.criteria.map((c) => ({ criterion_ref: c.criterion_ref, verdict: 'passed', evidence_refs: [] })),
          evidence_refs: [],
          rationale: '种子演示数据',
          self_acceptance: true,
          acceptance_mode: 'manual',
        },
      });
      await tx.appendStateTransition({
        ...base,
        type: 'TaskLifecycleChanged',
        entity: 'task',
        idempotency_key: key('lc-accepted'),
        from: 'awaiting_acceptance',
        to: 'accepted',
        facts: { acceptanceVerdict: 'accepted' },
        payload: { task_id: seed.task_id, acceptance_id },
      });
    });

    await ingest(store, projection, project_id);
  }

  await ingest(store, projection, project_id);
  return {
    project_id,
    created: existing === undefined,
    tasks: projection.snapshot().tasks.filter((t) => t.project_id === project_id).length,
    projection_version: projection.version(),
  };
}

async function ingest(store: PgEventStore, projection: ProjectionService, project_id: string): Promise<void> {
  const current = projection.version();
  const events = await store.readStream(project_id, 1);
  projection.ingest(events.filter((e) => e.global_seq > current));
}
