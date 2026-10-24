// 提议层（智能层）：只产提议，无写内核通道（技术方案 §2.2 边界铁律 / proposers 边界）。
//
// 三条硬约束（任务书 §3）：
// 1. 模型调用只走服务端 magpie 网关（OpenAI 兼容口），key 只从环境变量读取；
//    key 不进日志、不进事件、不进响应、不进仓库 —— 本文件只在构造请求头时读取一次。
// 2. 只用免费模型（默认 workbuddy-ai/deepseek-v4.1-flash），不接受客户端指定模型。
// 3. 模型不可用/超时/输出不合规 → 确定性占位提议，并显式标 degraded（透传到 API 响应）。

import type { AcceptanceCriterion, OutcomeDraft } from '../projection/projection.ts';

export type DegradedReason = 'not_configured' | 'model_unavailable' | 'model_timeout' | 'model_output_invalid';

export interface ProposerMeta {
  source: 'model' | 'fallback';
  model: string | null;
  degraded: boolean;
  degraded_reason: DegradedReason | null;
  latency_ms: number | null;
}

export interface CaptureProposal {
  title: string;
  description: string;
  assignee_kind: 'human' | 'agent';
  acceptance_criteria: AcceptanceCriterion[];
  rationale: string;
  meta: ProposerMeta;
}

export type EngineKind = 'model' | 'fallback';

export interface Proposer {
  /** 捕获 → 任务草稿提议（Intent Interpreter）。 */
  interpretCapture(input: { text: string; projectName: string }): Promise<CaptureProposal>;
  /** 反馈 / RawResult → Outcome 维度提议（Outcome Interpreter）。 */
  interpretFeedback(input: { taskTitle: string; feedback: string; criteria: AcceptanceCriterion[] }): Promise<{ draft: OutcomeDraft; meta: ProposerMeta }>;
}

export interface ProposerConfig {
  baseUrl: string;
  /** 只从环境变量取；此字段永远不序列化到任何输出。 */
  apiKey: string | null;
  model: string;
  timeoutMs: number;
  /** 注入用（测试替身）；缺省走全局 fetch。 */
  fetchImpl?: typeof fetch;
}

export const DEFAULT_BASE_URL = 'http://10.144.144.3:3425/v1';
export const DEFAULT_MODEL = 'workbuddy-ai/deepseek-v4.1-flash';
export const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * 从环境读取提议层配置。key 只支持 MAGPIE_API_KEY（服务端运行环境注入）；
 * 任务书口径：绝不向用户索要 key，绝不落仓库/日志。缺省时一律走降级路径。
 */
export function proposerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ProposerConfig {
  const rawTimeout = Number(env.XUXING_PROPOSER_TIMEOUT_MS ?? '');
  return {
    baseUrl: env.MAGPIE_BASE_URL ?? DEFAULT_BASE_URL,
    apiKey: env.MAGPIE_API_KEY ?? null,
    model: env.XUXING_PROPOSER_MODEL ?? DEFAULT_MODEL,
    timeoutMs: Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS,
  };
}

const CAPTURE_SYSTEM_PROMPT = [
  '你是"续行"工作系统里的意图解释器（Intent Interpreter）。',
  '用户会给你一条自由输入；你要把它变成一条可执行任务的草稿提议。',
  '只输出一个 JSON 对象，不要任何解释、不要 markdown 代码围栏。',
  '字段：title(<=30字，动词开头)、description(1-3句，保留用户原意、不编造事实)、',
  'assignee_kind("human" 或 "agent")、acceptance_criteria(1-3 条，每条 {criterion_ref,text,auto})。',
  'criterion_ref 用 c1/c2/c3；auto=true 仅当该判据可由程序检查。',
  '无法判断时选择保守值（assignee_kind="human"），不要虚构联系人、日期或数字。',
].join('\n');

const OUTCOME_SYSTEM_PROMPT = [
  '你是"续行"里的结果解释器（Outcome Interpreter）。',
  '输入：任务标题、验收判据、执行者提交的反馈原文。输出一个 JSON 对象，不要解释、不要围栏。',
  '字段必须齐全：conclusion_kind("achieved"|"partial"|"infeasible"|"no_response"|"unknown")、',
  'info_obtained(boolean)、certainty("low"|"med"|"high")、evidence_sufficiency("sufficient"|"insufficient"|"none")、',
  'blockers(string[])、followup_suggestions(string[])。',
  '只依据反馈原文判断；原文没说的不要编造。判据是否通过由人类验收，不由你决定。',
].join('\n');

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

function fallbackMeta(reason: DegradedReason, latency_ms: number | null, model: string | null): ProposerMeta {
  return { source: 'fallback', model, degraded: true, degraded_reason: reason, latency_ms };
}

// ---------------------------------------------------------------------------
// 确定性占位提议（降级路径）：同一输入 → 同一输出，绝不含随机/时间
// ---------------------------------------------------------------------------

export function fallbackCaptureProposal(text: string): CaptureProposal {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const clause = collapsed.split(/[。；;\n]/)[0] ?? collapsed;
  const title = (clause.length > 30 ? clause.slice(0, 30) : clause) || '（未命名任务）';
  return {
    title,
    description: collapsed,
    assignee_kind: 'human',
    acceptance_criteria: [
      { criterion_ref: 'c1', text: '完成输入所述事项，并提交可核对的执行反馈', auto: false },
    ],
    rationale: '降级占位提议：模型不可用，按确定性规则截取输入首句作为任务标题，判据为通用兜底项。',
    meta: fallbackMeta('model_unavailable', null, null),
  };
}

export function fallbackOutcomeDraft(feedback: string, criteria: AcceptanceCriterion[]): OutcomeDraft {
  const empty = feedback.trim().length === 0;
  return {
    conclusion_kind: empty ? 'unknown' : 'partial',
    info_obtained: !empty,
    certainty: 'low',
    evidence_sufficiency: empty ? 'none' : 'insufficient',
    blockers: empty ? ['执行者未提交任何文本反馈'] : [],
    followup_suggestions: criteria.length > 0 ? ['由人类按判据逐项验收'] : ['补充验收判据'],
    source: 'fallback',
    degraded: true,
    degraded_reason: 'model_unavailable',
  };
}

// ---------------------------------------------------------------------------
// 模型调用（OpenAI 兼容 /chat/completions）
// ---------------------------------------------------------------------------

class ModelCallError extends Error {
  constructor(readonly reason: DegradedReason) {
    super(`model call failed: ${reason}`);
    this.name = 'ModelCallError';
  }
}

async function callChat(
  config: ProposerConfig,
  messages: ChatMessage[],
): Promise<{ content: string; latency_ms: number }> {
  if (config.apiKey === null || config.apiKey.length === 0) throw new ModelCallError('not_configured');
  const fetchImpl = config.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const started = Date.now();
  try {
    const response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        // 唯一接触 key 的位置：请求头。绝不写入日志/错误/事件。
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0,
        max_tokens: 700,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new ModelCallError('model_unavailable');
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new ModelCallError('model_output_invalid');
    }
    return { content, latency_ms: Date.now() - started };
  } catch (error) {
    if (error instanceof ModelCallError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new ModelCallError('model_timeout');
    throw new ModelCallError('model_unavailable');
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) throw new ModelCallError('model_output_invalid');
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      throw new ModelCallError('model_output_invalid');
    }
  }
}

const ASSIGNEE_KINDS = ['human', 'agent'] as const;
const CONCLUSION_KINDS = ['achieved', 'partial', 'infeasible', 'no_response', 'unknown'] as const;
const CERTAINTIES = ['low', 'med', 'high'] as const;
const SUFFICIENCIES = ['sufficient', 'insufficient', 'none'] as const;

function parseCaptureOutput(raw: string, text: string): CaptureProposal {
  const parsed = extractJson(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ModelCallError('model_output_invalid');
  }
  const record = parsed as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  if (title.length === 0 || title.length > 120) throw new ModelCallError('model_output_invalid');
  const assignee = ASSIGNEE_KINDS.includes(record.assignee_kind as (typeof ASSIGNEE_KINDS)[number])
    ? (record.assignee_kind as 'human' | 'agent')
    : null;
  if (assignee === null) throw new ModelCallError('model_output_invalid');

  const criteriaRaw = Array.isArray(record.acceptance_criteria) ? record.acceptance_criteria : [];
  const criteria: AcceptanceCriterion[] = [];
  for (const item of criteriaRaw.slice(0, 5)) {
    if (item === null || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const text2 = typeof entry.text === 'string' ? entry.text.trim() : '';
    if (text2.length === 0) continue;
    criteria.push({
      criterion_ref: criteria.length === 0 ? 'c1' : `c${criteria.length + 1}`,
      text: text2.slice(0, 200),
      auto: entry.auto === true,
    });
  }
  if (criteria.length === 0 && assignee === 'agent') {
    // REQ-TC-1：Agent 执行必须有至少一条可判定判据，否则不采纳模型输出
    throw new ModelCallError('model_output_invalid');
  }
  return {
    title,
    description: typeof record.description === 'string' && record.description.trim().length > 0
      ? record.description.trim().slice(0, 1000)
      : text.trim(),
    assignee_kind: assignee,
    acceptance_criteria: criteria,
    rationale: '模型提议：由 magpie 网关免费模型生成的意图解释结果。',
    meta: { source: 'model', model: null, degraded: false, degraded_reason: null, latency_ms: null },
  };
}

function parseOutcomeOutput(raw: string): OutcomeDraft {
  const parsed = extractJson(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ModelCallError('model_output_invalid');
  }
  const record = parsed as Record<string, unknown>;
  const pick = <T extends string>(value: unknown, allowed: readonly T[]): T | null =>
    typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;

  const conclusion = pick(record.conclusion_kind, CONCLUSION_KINDS);
  const certainty = pick(record.certainty, CERTAINTIES);
  const sufficiency = pick(record.evidence_sufficiency, SUFFICIENCIES);
  if (conclusion === null || certainty === null || sufficiency === null || typeof record.info_obtained !== 'boolean') {
    throw new ModelCallError('model_output_invalid');
  }
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, 10) : [];
  return {
    conclusion_kind: conclusion,
    info_obtained: record.info_obtained,
    certainty,
    evidence_sufficiency: sufficiency,
    blockers: strings(record.blockers),
    followup_suggestions: strings(record.followup_suggestions),
    source: 'model',
    degraded: false,
    degraded_reason: null,
  };
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

export function createProposer(config: ProposerConfig): Proposer {
  return {
    async interpretCapture({ text, projectName }) {
      const started = Date.now();
      try {
        const { content, latency_ms } = await callChat(config, [
          { role: 'system', content: CAPTURE_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({ project: projectName, input: text }) },
        ]);
        const proposal = parseCaptureOutput(content, text);
        return { ...proposal, meta: { ...proposal.meta, model: config.model, latency_ms } };
      } catch (error) {
        const reason = error instanceof ModelCallError ? error.reason : 'model_unavailable';
        const fallback = fallbackCaptureProposal(text);
        return {
          ...fallback,
          meta: {
            ...fallback.meta,
            degraded_reason: reason,
            latency_ms: Date.now() - started,
            model: config.apiKey === null ? null : config.model,
          },
        };
      }
    },

    async interpretFeedback({ taskTitle, feedback, criteria }) {
      const started = Date.now();
      try {
        const { content, latency_ms } = await callChat(config, [
          { role: 'system', content: OUTCOME_SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({
              task: taskTitle,
              criteria: criteria.map((c) => c.text),
              feedback,
            }),
          },
        ]);
        const draft = parseOutcomeOutput(content);
        return {
          draft,
          meta: { source: 'model', model: config.model, degraded: false, degraded_reason: null, latency_ms },
        };
      } catch (error) {
        const reason = error instanceof ModelCallError ? error.reason : 'model_unavailable';
        const draft = fallbackOutcomeDraft(feedback, criteria);
        return {
          draft: { ...draft, degraded_reason: reason },
          meta: {
            source: 'fallback',
            model: config.apiKey === null ? null : config.model,
            degraded: true,
            degraded_reason: reason,
            latency_ms: Date.now() - started,
          },
        };
      }
    },
  };
}
