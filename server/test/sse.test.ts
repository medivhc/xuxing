import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, type BootedApp } from './support/harness.ts';
import { SseConnection, createHub, isHeartbeat, type SseWriter } from '../src/sse/hub.ts';
import { ConnectionBudget, parseFrameQuery, sseOptionsFromEnv } from '../src/sse/protocol.ts';

// 背压纪律③的单元测：连接上限 / 队列上限 / 慢连接超时 / 心跳 / 预算归还，
// 以及纪律②的参数解析。线路级行为（真 HTTP 断流、503 + Retry-After）见 sse-http.test.ts。

const OPTIONS = { maxConnections: 2, queueLimit: 4, slowTimeoutMs: 60, heartbeatMs: 30 };

let booted: BootedApp;

beforeAll(async () => {
  booted = await bootApp();
});

afterAll(async () => {
  await booted.close();
});

function writer(): SseWriter & { written: string[]; closed: boolean } {
  const state = {
    written: [] as string[],
    closed: false,
    write(chunk: string) {
      state.written.push(chunk);
    },
    isAlive: () => !state.closed,
    close() {
      state.closed = true;
    },
  };
  return state;
}

function connection(budget: ConnectionBudget, sink: SseWriter, overrides: Partial<typeof OPTIONS> = {}) {
  const options = { ...OPTIONS, ...overrides };
  return new SseConnection('test', sink, { options, project_id: null }, budget, 0);
}

describe('SSE 纪律③：连接上限与预算归还', () => {
  it('超过连接上限即拒绝，预算归还后可以再建', () => {
    const budget = new ConnectionBudget(2);
    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(false);
    expect(budget.metrics.rejected_limit).toBe(1);
    budget.release();
    expect(budget.tryAcquire()).toBe(true);
  });

  it('重复 close 只归还一次预算（断线与定时器可能同时收尾）', () => {
    const budget = new ConnectionBudget(1);
    budget.tryAcquire();
    const conn = connection(budget, writer());
    conn.close();
    conn.close();
    expect(budget.count).toBe(0);
  });

  it('背压参数口径：默认心跳 15s，可用环境变量覆盖', () => {
    expect(sseOptionsFromEnv({})).toMatchObject({ heartbeatMs: 15_000, maxConnections: 32, queueLimit: 256 });
    expect(sseOptionsFromEnv({ XUXING_SSE_HEARTBEAT_MS: '5000' }).heartbeatMs).toBe(5_000);
  });
});

describe('SSE 纪律③：每连接队列上限', () => {
  it('待发帧超过 queueLimit 即断连（不无限堆内存）', () => {
    const budget = new ConnectionBudget(1);
    budget.tryAcquire();
    const sink = writer();
    const conn = connection(budget, sink, { queueLimit: 2 });
    // 模拟写端阻塞：flush 不消费队列
    (conn as unknown as { flush: () => void }).flush = () => undefined;

    expect(conn.push('a')).toBe(true);
    expect(conn.push('b')).toBe(true);
    expect(conn.push('c')).toBe(false);
    expect(conn.dropped).toBe('overflow');
    expect(conn.isClosed).toBe(true);
    expect(sink.closed).toBe(true);
    expect(budget.metrics.dropped_overflow).toBe(1);
    expect(budget.count).toBe(0);
  });

  it('缓冲期（订阅先于快照）积压也受限', () => {
    const budget = new ConnectionBudget(1);
    budget.tryAcquire();
    const conn = connection(budget, writer(), { queueLimit: 1 });
    conn.buffer();
    const event = (seq: number) => ({ global_seq: seq, stream_id: 'proj_x', type: 'PlanChangeProposed' }) as never;
    expect(conn.deliver(event(1))).toBe(true);
    expect(conn.deliver(event(2))).toBe(false);
    expect(conn.dropped).toBe('overflow');
    expect(budget.count).toBe(0);
  });
});

describe('SSE 纪律③：慢连接超时', () => {
  it('队列持续积压超过 slowTimeoutMs → 断开并计数', async () => {
    const hub = createHub(OPTIONS);
    hub.budget.tryAcquire();
    const conn = connection(hub.budget, writer());
    (conn as unknown as { flush: () => void }).flush = () => undefined;
    hub.attach(conn);
    conn.push('x'.repeat(10));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(conn.isClosed).toBe(true);
    expect(conn.dropped).toBe('slow');
    expect(hub.budget.metrics.dropped_slow).toBeGreaterThanOrEqual(1);
    expect(hub.budget.count).toBe(0);
    hub.closeAll();
  });

  it('写端一直不落地（write 返回 false）也算慢连接，别只盯队列长度', async () => {
    // 真 HTTP 写端（res.write）会把帧塞进内核缓冲，队列不积压；只有背压窗口满了才说明对端没收
    const hub = createHub(OPTIONS);
    hub.budget.tryAcquire();
    const blocked: SseWriter = {
      written: [] as string[],
      write() {
        return false;
      },
      isAlive: () => true,
      close() {},
    } as SseWriter;
    // 队列上限放宽到不会先触发 overflow，把判定逼到"背压窗口"这一条路上
    const conn = new SseConnection('blocked', blocked, { options: { ...OPTIONS, queueLimit: 64 }, project_id: null }, hub.budget, 0);
    hub.attach(conn);
    for (let i = 0; i < 32; i += 1) conn.push(`chunk-${i}\n`);
    expect(conn.isClosed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(conn.isClosed).toBe(true);
    expect(conn.dropped).toBe('slow');
    expect(hub.budget.count).toBe(0);
    hub.closeAll();
  });
});

describe('SSE 纪律③：心跳保活', () => {
  it('按 heartbeatMs 发注释帧，且不占 seq', async () => {
    const hub = createHub({ ...OPTIONS, heartbeatMs: 20 });
    hub.budget.tryAcquire();
    const sink = writer();
    const conn = connection(hub.budget, sink, { heartbeatMs: 20 });
    hub.attach(conn);
    await new Promise((resolve) => setTimeout(resolve, 90));
    const pings = sink.written.filter(isHeartbeat);
    expect(pings.length).toBeGreaterThan(0);
    expect(conn.lastSeq).toBe(0);
    expect(hub.budget.metrics.heartbeats_sent).toBeGreaterThan(0);
    hub.closeAll();
  });
});

describe('SSE 纪律②：帧去重与参数解析', () => {
  it('seq <= lastSeq 的事件被丢弃（重连补发窗口内不重复）', () => {
    const budget = new ConnectionBudget(1);
    budget.tryAcquire();
    const sink = writer();
    const conn = connection(budget, sink);
    const event = (seq: number) => ({
      global_seq: seq,
      stream_id: 'proj_x',
      type: 'PlanChangeProposed',
      occurred_at: '2026-10-24T08:00:00.000Z',
      payload: { change_id: `pc_${seq}`, task_id: null },
    }) as never;

    conn.pushEvents([event(1), event(2)]);
    conn.deliver(event(2));
    conn.deliver(event(3));
    const seqs = sink.written
      .filter((chunk) => chunk.startsWith('event: event'))
      .map((chunk) => JSON.parse(chunk.split('\ndata: ')[1]!).seq as number);
    expect(seqs).toEqual([1, 2, 3]);
    expect(conn.lastSeq).toBe(3);
  });

  it('cursor 必须是全局序号（非负整数），非法值不静默从 0 重放', () => {
    expect(parseFrameQuery({ cursor: '12' })).toMatchObject({ ok: true, cursor: 12 });
    expect(parseFrameQuery({ cursor: null })).toMatchObject({ ok: true, cursor: null });
    expect(parseFrameQuery({ cursor: '' })).toMatchObject({ ok: true, cursor: null });
    expect(parseFrameQuery({ cursor: 'abc' }).ok).toBe(false);
    expect(parseFrameQuery({ cursor: '-1' }).ok).toBe(false);
    expect(parseFrameQuery({ cursor: '1.5' }).ok).toBe(false);
  });
});
