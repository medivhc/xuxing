import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { bootApp, parseSse, type BootedApp } from './support/harness.ts';

// SSE 三纪律的线路级验证：走真实 HTTP（node:http 中转 + fetch 读流），
// 进程内 app.request() 会冻结状态码与响应头，测不到"503 + Retry-After"与真实断流。
let booted: BootedApp;
let server: Server;
let base: string;

beforeAll(async () => {
  booted = await bootApp();
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(key, value);
    }
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    const response = await booted.app.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) {
      // 对端断开时取消上游流（真 @hono/node-server 的同类行为）；否则 SSE 读端挂住不会结束
      const reader = response.body!.getReader();
      // 对端断开时以 reader.cancel() 关闭上游流（真 @hono/node-server 的同类行为）；
      // 内部状态取消会一直排到 ReadableStream 源的 cancel()，SSE 路由据此回收连接
      res.on('close', () => {
        void reader.cancel('peer closed').catch(() => undefined);
      });
      const pump = async (): Promise<void> => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            // res.write 返回 false = 下游还没消化（真 @hono/node-server 同样据此回压）；
            // 与生产路由一致：等 drain 后再继续，避免测试替身无限缓冲
            if (!res.write(new Uint8Array(value))) {
              await new Promise<void>((resolve) => res.once('drain', resolve));
            }
          }
        } catch {
          // 已取消
        }
        if (!res.destroyed) res.end();
      };
      void pump();
      return;
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await booted.close();
});

beforeEach(async () => {
  // 每条用例开始前等预算归零，避免上一条用例的连接拖延
  const before = booted.config.hub.budget.count;
  for (let i = 0; i < 100 && booted.config.hub.budget.count > 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(booted.config.hub.budget.count, `上一条用例遗留 ${before} 个未归还的 SSE 连接`).toBe(0);
});

afterEach(async () => {
  // 用例中途失败的连接不能漏到下一条：收掉残余连接再等预算归零
  booted.config.hub.closeAll();
  for (let i = 0; i < 100 && booted.config.hub.budget.count > 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});

interface OpenSse {
  frames: Array<{ event: string; data: any }>;
  raw: string;
  status: number;
  headers: Headers;
  alive: boolean;
  close: () => Promise<void>;
  waitFor: (predicate: (frames: OpenSse['frames'], raw: string) => boolean, timeoutMs?: number) => Promise<void>;
}

async function openSse(path: string): Promise<OpenSse> {
  const controller = new AbortController();
  const response = await fetch(`${base}${path}`, { signal: controller.signal });
  const state: OpenSse = {
    frames: [],
    raw: '',
    status: response.status,
    headers: response.headers,
    alive: true,
    close: async () => {
      controller.abort();
      for (let i = 0; i < 100; i += 1) {
        if (booted.config.hub.budget.count === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    waitFor: (predicate, timeoutMs = 3_000) =>
      new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const tick = (): void => {
          if (predicate(state.frames, state.raw)) return resolve();
          if (Date.now() > deadline) {
            return reject(new Error(`waitFor 超时；已收帧=${JSON.stringify(state.raw)}`));
          }
          setTimeout(tick, 10);
        };
        tick();
      }),
  };
  if (response.status !== 200) {
    state.raw = await response.text();
    return state;
  }
  void (async () => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        buffer += text;
        state.raw += text;
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          state.frames.push(...parseSse(`${block}\n\n`));
          index = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // abort 属正常关闭
    } finally {
      state.alive = false;
    }
  })();
  return state;
}

async function postJson(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/** 一次捕获 + 接受提议（两次提交，7 条事件），返回这些事件的全局序号区间。 */
async function commitPair(prefix: string): Promise<{ first_seq: number; last_seq: number; proposal_id: string }> {
  const captured = await postJson('/api/capture', { text: `真实线路测试输入 ${prefix}`, client_submit_id: `${prefix}-cap` });
  const proposal_id = captured.body.data.proposal_id as string;
  const captured_seqs = captured.body.data.emitted.map((e: { seq: number }) => e.seq as number);
  const accepted = await postJson('/api/commands', {
    type: 'proposal_accept',
    payload: { proposal_id },
    client_submit_id: `${prefix}-accept`,
  });
  expect(accepted.status).toBe(201);
  // 广播的事件区间直接取两次写入回执给出的序号（= 本次真正落账的那些 seq），
  // 不靠投影水位推算：并发/外部写入都不会让断言漂移
  const accepted_seqs = accepted.body.data.emitted.map((e: { seq: number }) => e.seq as number);
  const all = [...captured_seqs, ...accepted_seqs];
  return { first_seq: Math.min(...all), last_seq: Math.max(...all), proposal_id };
}

describe('SSE 纪律①：快照-订阅对齐（真实 HTTP）', () => {
  it('ready 帧带快照投影版本与订阅 cursor，且两者一致', async () => {
    const before = booted.config.projection.version();
    const sse = await openSse('/api/stream');
    expect(sse.status).toBe(200);
    expect(sse.headers.get('content-type')).toContain('text/event-stream');
    await sse.waitFor((frames) => frames.some((f) => f.event === 'ready'));
    const ready = sse.frames.find((f) => f.event === 'ready')!.data;
    expect(ready.projection_version).toBe(before);
    expect(ready.cursor).toBe(before);
    expect(ready.requested_cursor).toBeNull();
    await sse.close();
    expect(booted.config.hub.budget.count).toBe(0);
  });

  it('订阅建立后写入 → 事件必达且 seq 连续递增、带 kind', async () => {
    const sse = await openSse('/api/stream');
    await sse.waitFor((frames) => frames.some((f) => f.event === 'ready'));
    const ready = sse.frames.find((f) => f.event === 'ready')!.data;

    const committed = await commitPair('orderly');
    await sse.waitFor((frames) => frames.some((f) => f.event === 'event' && f.data.seq === committed.last_seq));

    const events = sse.frames.filter((f) => f.event === 'event').map((f) => f.data);
    const seqs = events.map((e) => e.seq as number);
    expect(Math.min(...seqs)).toBe(committed.first_seq);
    expect(Math.max(...seqs)).toBe(committed.last_seq);
    // 无空洞：订阅后的每条事件都到了
    expect(seqs).toEqual(Array.from({ length: committed.last_seq - committed.first_seq + 1 }, (_, i) => committed.first_seq + i));
    expect(Math.min(...seqs)).toBeGreaterThan(ready.cursor);
    for (const event of events) {
      expect(typeof event.kind).toBe('string');
      expect(event.stream_id).toBe(booted.config.defaultProjectId);
    }
    await sse.close();
  });
});

describe('SSE 纪律②：游标补发（真实 HTTP）', () => {
  it('掉线期间的事件，重连带 cursor 后按序号补发，随后转实时', async () => {
    const first = await openSse('/api/stream');
    await first.waitFor((frames) => frames.some((f) => f.event === 'ready'));
    const cursor = first.frames.find((f) => f.event === 'ready')!.data.cursor as number;
    await first.close();

    const missed = await commitPair('offline');

    const resumed = await openSse(`/api/stream?cursor=${cursor}`);
    await resumed.waitFor((frames) => frames.some((f) => f.event === 'ready'));
    const ready = resumed.frames.find((f) => f.event === 'ready')!.data;
    expect(ready.requested_cursor).toBe(cursor);
    expect(ready.replayed).toBeGreaterThanOrEqual(missed.last_seq - cursor);
    expect(ready.cursor).toBe(missed.last_seq);

    const replayed = resumed.frames.filter((f) => f.event === 'event').map((f) => f.data.seq as number);
    expect(replayed).toEqual(
      Array.from({ length: missed.last_seq - cursor }, (_, i) => cursor + 1 + i),
    );

    // 转实时：补发之后写入的新事件继续送达（只推 > cursor 的，无重复）
    const live = await commitPair('live-after-replay');
    await resumed.waitFor((frames) => frames.some((f) => f.event === 'event' && f.data.seq === live.last_seq));
    const all = resumed.frames.filter((f) => f.event === 'event').map((f) => f.data.seq as number);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual(Array.from({ length: live.last_seq - cursor }, (_, i) => cursor + 1 + i));
    await resumed.close();
  });

  it('cursor 非法 → 400 JSON（不静默从 0 重放）', async () => {
    const sse = await openSse('/api/stream?cursor=abc');
    expect(sse.status).toBe(400);
    expect(JSON.parse(sse.raw).error.code).toBe('bad_request');
  });

  it('项目过滤：带 project_id 只补发该流的事件', async () => {
    const cursor = booted.config.projection.version();
    const missed = await commitPair('scoped');
    const sse = await openSse(`/api/stream?cursor=${cursor}&project_id=${booted.config.defaultProjectId}`);
    await sse.waitFor((frames) => frames.some((f) => f.event === 'ready'));
    const eventFrames = sse.frames.filter((f) => f.event === 'event').map((f) => f.data);
    expect(eventFrames.length).toBe(missed.last_seq - cursor);
    for (const frame of eventFrames) expect(frame.stream_id).toBe(booted.config.defaultProjectId);
    await sse.close();
  });
});

describe('SSE 纪律③：背压与心跳（真实 HTTP）', () => {
  it('心跳保活：heartbeat_ms 到点即有注释帧', async () => {
    const sse = await openSse('/api/stream');
    await sse.waitFor((_frames, raw) => raw.includes(': ping'), 2_000);
    expect(sse.raw).toContain(': ping');
    await sse.close();
  });

  it('连接数上限：超过上限回 503 + Retry-After，断线后名额归还', async () => {
    const opened: OpenSse[] = [];
    for (let i = 0; i < booted.config.sse.maxConnections; i += 1) {
      const sse = await openSse('/api/stream');
      expect(sse.status).toBe(200);
      await sse.waitFor((frames) => frames.some((f) => f.event === 'ready'));
      opened.push(sse);
    }
    expect(booted.config.hub.budget.count).toBe(booted.config.sse.maxConnections);

    const over = await openSse('/api/stream');
    expect(over.status).toBe(503);
    expect(over.headers.get('retry-after')).toBe('5');
    const body = JSON.parse(over.raw);
    expect(body.error.code).toBe('unavailable');
    expect(body.error.detail.retry_after_ms).toBe(5_000);
    expect(body.error.detail.max_connections).toBe(booted.config.sse.maxConnections);

    for (const sse of opened) await sse.close();
    expect(booted.config.hub.budget.count).toBe(0);

    // 名额真的还回来了：可以重新建连
    const again = await openSse('/api/stream');
    expect(again.status).toBe(200);
    await again.close();
  });

  it('客户端断开即归还预算并停掉定时器', async () => {
    const sse = await openSse('/api/stream');
    await sse.waitFor((frames) => frames.some((f) => f.event === 'ready'));
    expect(booted.config.hub.budget.count).toBe(1);
    expect(booted.config.hub.connections()).toHaveLength(1);
    await sse.close();
    expect(booted.config.hub.budget.count).toBe(0);
    expect(booted.config.hub.connections()).toHaveLength(0);
  });
});
