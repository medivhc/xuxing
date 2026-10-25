import { describe, expect, it } from 'vitest';
import {
  createProposer,
  fallbackCaptureProposal,
  proposerConfigFromEnv,
  type ProposerConfig,
} from '../src/proposers/proposer.ts';

const SECRET = 'sk-test-DO-NOT-LEAK-1234567890';

function config(overrides: Partial<ProposerConfig> = {}, fetchImpl?: typeof fetch): ProposerConfig {
  return {
    baseUrl: 'http://magpie.test/v1',
    apiKey: SECRET,
    model: 'workbuddy-ai/deepseek-v4.1-flash',
    timeoutMs: 200,
    fetchImpl,
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

function chat(content: string): Response {
  return jsonResponse({ choices: [{ message: { content } }] });
}

describe('提议层：magpie 网关（OpenAI 兼容）', () => {
  it('正常路径：模型输出合规则 source=model、degraded=false，且请求走 /chat/completions 用免费模型', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const proposer = createProposer(
      config({}, async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return chat(JSON.stringify({
          title: '联系张三确认方案',
          description: '给张三打电话确认上周讨论的方案细节。',
          assignee_kind: 'human',
          acceptance_criteria: [{ criterion_ref: 'x', text: '确认了方案细节', auto: false }],
        }));
      }),
    );
    const proposal = await proposer.interpretCapture({ text: '给张三打电话确认方案', projectName: '演示项目' });
    expect(proposal.meta).toMatchObject({ source: 'model', degraded: false, degraded_reason: null });
    expect(proposal.title).toBe('联系张三确认方案');
    expect(proposal.acceptance_criteria[0].criterion_ref).toBe('c1');
    expect(calls[0].url).toBe('http://magpie.test/v1/chat/completions');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe('workbuddy-ai/deepseek-v4.1-flash');
  });

  it('网关 500 → 确定性降级提议，degraded=true 且原因 model_unavailable', async () => {
    const proposer = createProposer(config({}, async () => jsonResponse({ error: 'boom' }, 500)));
    const proposal = await proposer.interpretCapture({ text: '整理季度复盘材料。补充数据', projectName: 'P' });
    expect(proposal.meta.source).toBe('fallback');
    expect(proposal.meta.degraded).toBe(true);
    expect(proposal.meta.degraded_reason).toBe('model_unavailable');
    expect(proposal.title).toBe('整理季度复盘材料');
  });

  it('没有 key → 不发起任何请求，直接 degraded（not_configured）', async () => {
    let called = false;
    const proposer = createProposer(
      config({ apiKey: null }, async () => {
        called = true;
        return chat('{}');
      }),
    );
    const proposal = await proposer.interpretCapture({ text: '写周报', projectName: 'P' });
    expect(called).toBe(false);
    expect(proposal.meta.degraded_reason).toBe('not_configured');
  });

  it('模型输出不合规（缺字段/非 JSON）→ degraded（model_output_invalid），不采纳半截数据', async () => {
    const proposer = createProposer(config({}, async () => chat('这不是 JSON')));
    const proposal = await proposer.interpretCapture({ text: '写周报', projectName: 'P' });
    expect(proposal.meta.degraded).toBe(true);
    expect(proposal.meta.degraded_reason).toBe('model_output_invalid');
    expect(proposal).toMatchObject({
      title: fallbackCaptureProposal('写周报').title,
      assignee_kind: 'human',
      acceptance_criteria: fallbackCaptureProposal('写周报').acceptance_criteria,
    });
  });

  it('超时 → degraded（model_timeout）', async () => {
    const proposer = createProposer(
      config({ timeoutMs: 20 }, (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit).signal as AbortSignal;
          signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        })),
    );
    const proposal = await proposer.interpretCapture({ text: '写周报', projectName: 'P' });
    expect(proposal.meta.degraded_reason).toBe('model_timeout');
  });

  it('key 绝不出现在返回的提议对象里（序列化后也搜不到）', async () => {
    const proposer = createProposer(config({}, async () => chat('{"title":"x","assignee_kind":"human","acceptance_criteria":[],"description":"x"}')));
    const proposal = await proposer.interpretCapture({ text: '写周报', projectName: 'P' });
    expect(JSON.stringify(proposal)).not.toContain(SECRET);
  });

  it('Outcome 解释：模型输出合规 → source=model；失败 → 降级维度齐全', async () => {
    const good = createProposer(
      config({}, async () =>
        chat(JSON.stringify({
          conclusion_kind: 'no_response',
          info_obtained: false,
          certainty: 'med',
          evidence_sufficiency: 'insufficient',
          blockers: ['对方未接电话'],
          followup_suggestions: ['明天再拨'],
        })),
      ),
    );
    const ok = await good.interpretFeedback({ taskTitle: '联系张三', feedback: '打两次没接', criteria: [] });
    expect(ok.draft).toMatchObject({ conclusion_kind: 'no_response', degraded: false, source: 'model' });

    const bad = createProposer(config({ apiKey: null }));
    const degraded = await bad.interpretFeedback({ taskTitle: '联系张三', feedback: '发微信了，对方说下周回复', criteria: [] });
    expect(degraded.draft.degraded).toBe(true);
    expect(degraded.draft).toMatchObject({
      conclusion_kind: 'partial',
      info_obtained: true,
      certainty: 'low',
      evidence_sufficiency: 'insufficient',
    });
  });

  it('环境变量口径：默认免费模型，key 只从 MAGPIE_API_KEY 取', () => {
    const cfg = proposerConfigFromEnv({});
    expect(cfg.model).toBe('workbuddy-ai/deepseek-v4.1-flash');
    expect(cfg.apiKey).toBeNull();
    expect(proposerConfigFromEnv({ MAGPIE_API_KEY: SECRET }).apiKey).toBe(SECRET);
  });
});
