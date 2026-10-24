// 逐判据验收表单（契约 §5.4 P-A5 / OQ-03=A；Spec §2.6 REQ-ACC-2）：
// - 每条判据独立判定（passed/failed/not_applicable）+ 备注 + 证据；
// - 逐条经命令入口提交（acceptance_record，canonical 词表；FIX-ROUND-1 R-1
//   由 record_criterion_verdict 映射而来），禁止「一次性全判」总开关；
// - 覆盖完整性：全部 criterion_ref 均有结果才落最终 verdict（服务端判定，
//   前端只呈现剩余数量，不自行推断领域结论）；
// - 继承锁定：已 passed 改判必须附新证据（服务端 409 criterion_locked，UI 预告）；
// - actor 分离：验收者与 Run 执行者不得相同（服务端 409 forbidden）；
// - [web 层补充] 字段（acceptance_criteria/criterion_results）服务端未提供时
//   降级提示，不自行推断。

import { useState } from 'react';
import type {
  AcceptanceCriterion,
  AcceptanceRecord,
  CriterionResult,
  CriterionVerdict,
} from '../../api/types';
import { useCommand } from '../commands/use-command';
import { AcceptanceVerdictBadge, CriterionVerdictBadge } from '../../components/Badge';
import { ErrorBanner, PendingButton } from '../../components/Feedback';

const VERDICT_OPTIONS: Array<{ value: CriterionVerdict; label: string; testSuffix: string }> = [
  { value: 'passed', label: '通过', testSuffix: 'pass' },
  { value: 'failed', label: '未通过', testSuffix: 'fail' },
  { value: 'not_applicable', label: '不适用', testSuffix: 'na' },
];

interface CriterionRowProps {
  taskId: string;
  criterion: AcceptanceCriterion;
  existing?: CriterionResult;
}

function CriterionRow({ taskId, criterion, existing }: CriterionRowProps) {
  const [verdict, setVerdict] = useState<CriterionVerdict | null>(null);
  const [note, setNote] = useState('');
  const [evidence, setEvidence] = useState('');

  const command = useCommand({
    type: 'acceptance_record',
    onAccepted: () => {
      setVerdict(null);
      setNote('');
      setEvidence('');
    },
  });

  const needsNote = verdict === 'failed' && note.trim() === '';
  const inheritedLocked =
    existing?.verdict === 'passed' && verdict !== null && verdict !== 'passed' && evidence.trim() === '';

  const submit = () => {
    if (!verdict) return;
    command.mutate({
      idemKey: `cmd:acceptance_record:${taskId}:${criterion.criterion_ref}:${verdict}`,
      payload: {
        task_id: taskId,
        criterion_ref: criterion.criterion_ref,
        verdict,
        note: note.trim() === '' ? null : note.trim(),
        evidence_refs: evidence
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter((s) => s !== ''),
      },
    });
  };

  return (
    <li
      data-testid={`criterion-row-${criterion.criterion_ref}`}
      className="rounded-m border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-body-s text-text-primary">{criterion.text}</p>
          <p className="mt-0.5 text-mono text-caption text-text-tertiary">
            {criterion.criterion_ref} · {criterion.kind === 'auto' ? '自动判据' : '人工判据'}
          </p>
        </div>
        {existing ? (
          <div className="flex flex-col items-end gap-1">
            <CriterionVerdictBadge verdict={existing.verdict} />
            {existing.note ? (
              <span className="text-caption text-text-secondary">备注：{existing.note}</span>
            ) : null}
            {existing.evidence_refs && existing.evidence_refs.length > 0 ? (
              <span className="text-mono text-caption text-text-tertiary">
                证据：{existing.evidence_refs.join('、')}
              </span>
            ) : null}
          </div>
        ) : (
          <span className="text-caption text-text-tertiary">未判定</span>
        )}
      </div>

      <fieldset className="mt-3">
        <legend className="text-caption text-text-secondary">判定（逐条独立提交）</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {VERDICT_OPTIONS.map((option) => {
            const active = verdict === option.value;
            return (
              <button
                key={option.value}
                type="button"
                data-testid={`criterion-${option.testSuffix}-${criterion.criterion_ref}`}
                aria-pressed={active}
                onClick={() => setVerdict(option.value)}
                className={[
                  'min-h-touch rounded-m border px-3 text-body-s transition-colors duration-[var(--motion-feedback)]',
                  active
                    ? 'border-accent bg-accent-subtle font-medium text-accent'
                    : 'border-border-strong bg-surface text-text-secondary hover:bg-subtle',
                ].join(' ')}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-3 grid gap-3 tablet:grid-cols-2">
        <label className="block">
          <span className="text-caption text-text-secondary">
            备注{verdict === 'failed' ? '（未通过必填）' : '（选填）'}
          </span>
          <textarea
            data-testid={`criterion-note-${criterion.criterion_ref}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-m border border-border-strong bg-surface px-3 py-2 text-body-s text-text-primary outline-none transition-colors duration-[var(--motion-feedback)] focus:border-accent"
            placeholder="判定依据、复核结论…"
          />
        </label>
        <label className="block">
          <span className="text-caption text-text-secondary">证据引用（选填，逗号分隔）</span>
          <input
            data-testid={`criterion-evidence-${criterion.criterion_ref}`}
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            className="mt-1 w-full rounded-m border border-border-strong bg-surface px-3 py-2 text-body-s text-text-primary outline-none transition-colors duration-[var(--motion-feedback)] focus:border-accent"
            placeholder="docs/interaction-contract.md"
          />
        </label>
      </div>

      {inheritedLocked ? (
        <p className="mt-2 text-caption text-warning">
          继承锁定：已「通过」的判据改判必须附新证据（服务端将返回 409 criterion_locked）。
        </p>
      ) : null}

      <div className="mt-3 flex items-center gap-3">
        <PendingButton
          pending={command.isPending}
          onClick={submit}
          disabled={!verdict || needsNote}
          testId={`criterion-submit-${criterion.criterion_ref}`}
        >
          提交本条判定
        </PendingButton>
        {!verdict ? <span className="text-caption text-text-tertiary">请先选择判定</span> : null}
        {needsNote ? <span className="text-caption text-warning">未通过必须填写备注</span> : null}
      </div>

      <ErrorBanner error={command.error} className="mt-3" />
    </li>
  );
}

export interface AcceptanceTaskLike {
  task_id: string;
  lifecycle: string;
  acceptance_criteria?: AcceptanceCriterion[];
  criterion_results?: CriterionResult[];
  acceptance?: AcceptanceRecord | null;
}

export function CriterionForm({ task }: { task: AcceptanceTaskLike }) {
  if (task.lifecycle !== 'awaiting_acceptance') return null;

  // [web 层补充] 字段降级：服务端未提供判据清单时不渲染表单、不推断
  if (!task.acceptance_criteria) {
    return (
      <div
        data-testid="acceptance-degraded"
        className="rounded-m border border-warning/30 bg-warning-subtle p-4 text-body-s text-warning"
      >
        当前投影未提供判据清单（服务端未返回 acceptance_criteria），无法逐条验收。
        请升级服务端投影字段后重试。
      </div>
    );
  }

  const criteria = task.acceptance_criteria;
  const results = task.criterion_results ?? [];
  const recorded = new Set(results.map((r) => r.criterion_ref));
  const pendingRefs = criteria.filter((c) => !recorded.has(c.criterion_ref));

  return (
    <section data-testid="acceptance-form" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-title-s font-semibold text-text-primary">逐判据验收</h3>
        <span data-testid="acceptance-coverage" className="text-caption text-text-secondary">
          已判 {recorded.size}/{criteria.length}
          {pendingRefs.length > 0 ? `，剩余 ${pendingRefs.length} 条未判` : '，覆盖完整'}
        </span>
      </div>
      <p className="text-caption text-text-tertiary">
        每条判据独立提交；覆盖完整后由服务端按 verdict 一致性落最终结论
        （全 passed/not_applicable → accepted；出现 failed → rejected；混合 → partially_accepted）。
      </p>

      <div
        data-testid="acceptance-status"
        data-verdict={task.acceptance?.verdict ?? 'none'}
        className="rounded-m border border-border bg-subtle p-3 text-body-s"
      >
        {task.acceptance ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-text-secondary">当前验收结论：</span>
            <AcceptanceVerdictBadge
              verdict={task.acceptance.verdict}
              testId="acceptance-current-verdict"
            />
            <span className="text-caption text-text-tertiary">
              验收者 {task.acceptance.acceptor_id} · 契约 rev {task.acceptance.contract_rev}
              {task.acceptance.superseded ? ' · 已被新判论 supersede' : ''}
            </span>
          </div>
        ) : (
          <span className="text-text-secondary">尚无验收记录</span>
        )}
      </div>

      <ul className="space-y-3">
        {criteria.map((criterion) => (
          <CriterionRow
            key={criterion.criterion_ref}
            taskId={task.task_id}
            criterion={criterion}
            existing={results.find((r) => r.criterion_ref === criterion.criterion_ref)}
          />
        ))}
      </ul>
    </section>
  );
}
