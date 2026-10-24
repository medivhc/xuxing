import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import {
  SSE_HEARTBEAT_MS,
  SSE_LIMITS,
  USING_EXTERNAL_SERVICE,
} from '../journeys.config.mts';
import { capture, getHealth, getHome, waitForActiveStreams } from '../support/api.mts';
import { SseOpenError, SseStream } from '../support/sse-client.mts';

// ============================================================================
// 交付物 2：SSE 三纪律（协议级，不经浏览器 EventSource）
//
//   1. 快照-订阅对齐：
//      a) 先订阅 → 取快照；订阅建立与快照返回之间注入事件，最终不漏；
//      b) 先快照 → 用 snapshot.projection_version 作 cursor 订阅，只收新事件。
//   2. cursor 补发：断线期间的事件，重连后按 seq 精确补发，不丢不重。
//   3. 背压：连接数上限 / 每连接待发队列上限 / 慢消费者超时断开。
//
// 断言口径：
//   - update 帧的 data 必须含 seq 与 kind（契约）；
//   - 一次连接内的 seq 必须从 cursor+1 起连续，且无重复；
//   - 背压行为以服务端 health 上报的 limits 为准（mock 与真服务同口径）。
//
// 队列/超时用例依赖 mock-only 的 POST /api/dev/burst 造流；对外部真服务
// 集成时跳过，连接数与心跳用例仍可对真服务运行。
// ============================================================================

test.describe.configure({ mode: 'serial' });

const streams: SseStream[] = [];

function track(stream: SseStream): SseStream {
  streams.push(stream);
  return stream;
}

function range(from: number, to: number): number[] {
  const result: number[] = [];
  for (let seq = from; seq <= to; seq += 1) result.push(seq);
  return result;
}

function assertUpdateShape(update: { seq: number; kind: string; type: string }): void {
  expect(Number.isInteger(update.seq)).toBe(true);
  expect(update.seq).toBeGreaterThan(0);
  expect(typeof update.kind).toBe('string');
  expect(update.kind.length).toBeGreaterThan(0);
  expect(typeof update.type).toBe('string');
}

test.afterEach(async ({ request }) => {
  for (const stream of streams) stream.close();
  streams.length = 0;
  await waitForActiveStreams(request, 0);
});

test.describe('SSE 协议纪律', () => {
  test('纪律 1a：先订阅再取快照，订阅与快照之间注入的事件最终不漏', async ({ request }) => {
    const before = await getHome(request);
    const cursor = before.projection_version;

    // 先建立订阅：cursor 锚定在快照之前的版本。
    const stream = track(await SseStream.open(`/api/stream?cursor=${cursor}`));
    expect(stream.headers.get('content-type') ?? '').toContain('text/event-stream');
    await waitForActiveStreams(request, 1);

    // 订阅已建立、快照尚未返回期间注入新事件（capture 会追加 feedback + proposal）。
    const captured = await capture(request, `SSE 快照对齐 ${randomUUID().slice(0, 8)}`);

    // 此刻才取快照：快照必须至少并入刚注入的事件。
    const snapshot = await getHome(request);
    expect(snapshot.projection_version).toBeGreaterThanOrEqual(captured.projection_version);

    await stream.waitForUpdate((update) => update.seq === snapshot.projection_version, 10_000);
    const updates = stream.updates();
    updates.forEach(assertUpdateShape);

    const seqs = updates.map((update) => update.seq);
    // 从 cursor+1 到快照版本，一条不漏、一条不重、顺序严格递增。
    expect(seqs).toEqual(range(cursor + 1, snapshot.projection_version));
    expect(new Set(seqs).size).toBe(seqs.length);

    const feedback = updates.find((update) => update.kind === 'feedback.captured');
    expect(feedback?.entity_id).toBe(captured.capture_id);
    expect(updates.some((update) => update.kind === 'proposal.created')).toBe(true);
  });

  test('纪律 1b：先快照后订阅（cursor=projection_version），不补旧事件只收新事件', async ({ request }) => {
    const snapshot = await getHome(request);
    const cursor = snapshot.projection_version;

    const stream = track(await SseStream.open(`/api/stream?cursor=${cursor}`));
    // 给补发窗口留足时间：cursor 之后没有历史事件，不应出现任何 update。
    await sleep(400);
    expect(stream.updateSeqs()).toEqual([]);

    const captured = await capture(request, `SSE 快照后订阅 ${randomUUID().slice(0, 8)}`);
    await stream.waitForUpdate((update) => update.seq === captured.projection_version, 10_000);

    const seqs = stream.updateSeqs();
    expect(seqs).toEqual(range(cursor + 1, captured.projection_version));
    expect(seqs.every((seq) => seq > cursor)).toBe(true);
    expect(stream.updates().every((update) => update.seq > cursor)).toBe(true);
  });

  test('纪律 2：断线后按 cursor 重连，补发 seq 连续、不丢不重', async ({ request }) => {
    const baseline = await getHome(request);
    const cursor = baseline.projection_version;

    // 先连一次再断开，确定 cursor 锚点。
    const first = track(await SseStream.open(`/api/stream?cursor=${cursor}`));
    first.close();
    await waitForActiveStreams(request, 0);

    // 断线期间发生 3 次 capture；每次至少落 feedback + proposal 两条事件。
    const captures = [];
    for (let index = 0; index < 3; index += 1) {
      captures.push(await capture(request, `SSE 断线补发 ${index} ${randomUUID().slice(0, 8)}`));
    }
    const finalHead = (await getHome(request)).projection_version;
    expect(finalHead).toBeGreaterThan(cursor);
    expect(finalHead).toBeGreaterThanOrEqual(captures[2].projection_version);

    // 带 cursor 重连：应精确补发 (cursor, finalHead]。
    const replay = track(await SseStream.open(`/api/stream?cursor=${cursor}`));
    await replay.waitForUpdate((update) => update.seq === finalHead, 10_000);
    const seqs = replay.updateSeqs();

    expect(seqs).toEqual(range(cursor + 1, finalHead));
    expect(new Set(seqs).size).toBe(seqs.length);

    const captureIds = new Set(
      replay
        .updates()
        .filter((update) => update.kind === 'feedback.captured')
        .map((update) => update.entity_id),
    );
    for (const captured of captures) {
      expect(captureIds.has(captured.capture_id)).toBe(true);
    }

    // 已追平 head 后再重连：没有可补发的事件。
    const caughtUp = track(await SseStream.open(`/api/stream?cursor=${finalHead}`));
    await sleep(300);
    expect(caughtUp.updateSeqs()).toEqual([]);
  });

  test('背压 1：连接数达到上限后新连接返回 429，不进入 hub', async ({ request }) => {
    const health = await getHealth(request);
    const maxConnections = health.limits?.max_connections ?? SSE_LIMITS.maxConnections;
    expect(maxConnections).toBeGreaterThanOrEqual(2);

    const cursor = (await getHome(request)).projection_version;
    const opened: SseStream[] = [];
    for (let index = 0; index < maxConnections; index += 1) {
      opened.push(track(await SseStream.open(`/api/stream?cursor=${cursor}`)));
    }
    await waitForActiveStreams(request, maxConnections);

    let failure: unknown;
    try {
      await SseStream.open(`/api/stream?cursor=${cursor}`);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SseOpenError);
    const openError = failure as SseOpenError;
    expect(openError.status).toBe(429);

    const body = JSON.parse(openError.body) as {
      error?: { code?: string; details?: { max_connections?: number } };
    };
    expect(body.error?.code).toBe('too_many_connections');
    expect(body.error?.details?.max_connections).toBe(maxConnections);

    // 被拒绝的连接不占名额。
    await waitForActiveStreams(request, maxConnections);

    for (const stream of opened) stream.close();
    await waitForActiveStreams(request, 0);
  });

  test('背压 2：每连接待发队列超限 → backpressure(queue_overflow) 并断开', async ({ request }) => {
    test.skip(USING_EXTERNAL_SERVICE, '需要 mock 的 POST /api/dev/burst 造流；外部真服务无此端点');

    const health = await getHealth(request);
    const maxQueue = health.limits.max_pending_per_connection;
    const head = (await getHome(request)).projection_version;

    // paused：只拿响应头、不读 body，构造慢消费者。
    const stream = track(await SseStream.open(`/api/stream?cursor=${head}`, { paused: true }));
    await waitForActiveStreams(request, 1);

    const burstCount = maxQueue + 32;
    const burst = await request.post('/api/dev/burst', { data: { count: burstCount } });
    expect(burst.status()).toBe(202);
    expect((await burst.json()).emitted).toBe(burstCount);

    // 队列溢出在 burst 的同步入队过程中发生：连接被立即断开。
    await waitForActiveStreams(request, 0, 10_000);

    stream.startReading();
    await stream.waitForClosed(10_000);

    const backpressure = stream.backpressureFrame();
    expect(backpressure?.code).toBe('slow_consumer');
    expect(backpressure?.reason).toBe('queue_overflow');
    // 溢出后不会再补齐整个队列。
    expect(stream.updateSeqs().length).toBeLessThanOrEqual(maxQueue);
  });

  test('背压 3：慢消费者超过超时阈值 → backpressure(slow_consumer_timeout) 并断开', async ({ request }) => {
    test.skip(USING_EXTERNAL_SERVICE, '需要 mock 的 POST /api/dev/burst 造流；外部真服务无此端点');

    const health = await getHealth(request);
    const maxQueue = health.limits.max_pending_per_connection;
    const timeoutMs = health.limits.slow_consumer_timeout_ms;
    const head = (await getHome(request)).projection_version;

    const stream = track(await SseStream.open(`/api/stream?cursor=${head}`, { paused: true }));
    await waitForActiveStreams(request, 1);

    // 恰好填满队列（不触发 queue_overflow），让发送泵逐帧排空；
    // 队首等待时间超过 slow_consumer_timeout_ms 后必须断开。
    const startedAt = Date.now();
    const burst = await request.post('/api/dev/burst', { data: { count: maxQueue } });
    expect(burst.status()).toBe(202);
    expect((await burst.json()).emitted).toBe(maxQueue);

    await waitForActiveStreams(request, 0, timeoutMs + 6_000);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(Math.floor(timeoutMs * 0.9));

    stream.startReading();
    await stream.waitForClosed(10_000);

    const backpressure = stream.backpressureFrame();
    expect(backpressure?.code).toBe('slow_consumer');
    expect(backpressure?.reason).toBe('slow_consumer_timeout');
  });

  test('心跳：15s 内至少发送一条 heartbeat 注释帧', async ({ request }) => {
    const health = await getHealth(request);
    const heartbeatMs = health.limits?.heartbeat_ms ?? SSE_HEARTBEAT_MS;
    expect(heartbeatMs).toBe(SSE_HEARTBEAT_MS);

    const head = (await getHome(request)).projection_version;
    const openedAt = Date.now();
    const stream = track(await SseStream.open(`/api/stream?cursor=${head}`));
    const frame = await stream.waitFor(
      (candidate) => (candidate.comment ?? '').includes('heartbeat'),
      heartbeatMs + 5_000,
    );
    const elapsed = Date.now() - openedAt;

    expect(frame.comment).toContain('heartbeat');
    expect(elapsed).toBeGreaterThanOrEqual(heartbeatMs - 2_000);
    expect(elapsed).toBeLessThanOrEqual(heartbeatMs + 5_000);
  });
});
