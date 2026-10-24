// 旅程/联调用的确定性模型桩：实现 proposer 期望的 OpenAI 兼容
// POST /chat/completions 形态，按 system prompt 区分两类调用：
//   - 意图解释（capture）：恒返回 assignee_kind="agent" 的任务草稿
//     （K1-B 节点旅程需要 agent 任务；真模型/降级路径都不可确定地产出）；
//   - 结果解释（outcome）：恒返回 achieved 的 Outcome 草稿。
// 只用于测试与联调，不是产品代码；生产 proposer 指向真实网关（magpie）。
import { createServer } from 'node:http';

const port = Number(process.env.MODEL_STUB_PORT ?? '46123');

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    let system = '';
    let user = '';
    try {
      const body = JSON.parse(raw);
      for (const message of body.messages ?? []) {
        if (message.role === 'system') system = String(message.content ?? '');
        if (message.role === 'user') user = String(message.content ?? '');
      }
    } catch {
      /* 坏请求按 capture 处理 */
    }
    const isOutcome = system.includes('结果解释器');
    const content = isOutcome
      ? {
          conclusion_kind: 'achieved',
          info_obtained: true,
          certainty: 'high',
          evidence_sufficiency: 'sufficient',
          blockers: [],
          followup_suggestions: [],
        }
      : {
          title: '节点执行检查任务',
          description: user.slice(0, 200) || '由节点执行的检查任务',
          assignee_kind: 'agent',
          acceptance_criteria: [{ criterion_ref: 'c1', text: '节点产出可核对的执行结果', auto: false }],
          rationale: 'model-stub 确定性提议（旅程/联调用）',
        };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ event: 'model_stub_listening', port }));
});
