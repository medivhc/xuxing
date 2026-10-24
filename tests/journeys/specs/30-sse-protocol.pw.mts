import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import {
  DEMO,
  SSE_HEARTBEAT_MS,
  SSE_LIMITS,
  USING_EXTERNAL_SERVICE,
} from '../journeys.config.mts';
import type { CaptureData, DevBurstData, StreamReadyFrame } from '../contract.mts';
import { capture, getHealth, getHome, unwrap } from '../support/api.mts';
import { SseOpenError, SseStream } from '../support/sse-client.mts';

// ============================================================================
// 交付物 2：SSE 三纪律（协议级，不经浏览器 EventSource）
//
//   1. 快照-订阅对齐：
//      a) 先订阅 → 取快照；订阅建立与快照返回之间注入事件，最终不漏；
//      b) 先快照 → 用 snapshot.projection_version 作 cursor 订阅，只收新事件。
//   2. cursor 补发：断线期间的事件，重连后按 seq 精确补发，不丢不重。
//   3. 背压（R-4，只断言**可观测行为**）：
//      - 连接数达到上限 → 503 + Retry-After，不进入 hub、断线后名额归还；
//      - 慢消费者 → 服务端断开连接（不测内部发送泵/drain 模型）。
//
// 断言口径（FIX-ROUND-1 裁决）：
//   - 全部读 data 字段（R-2）：cursor 起点来自 data.projection_version；
//   - 事件帧 event=event，data.kind = 内核 PascalCase 事件名（R-9）；
//   - 上限一律以 GET /api/health 的 data.limits 为准，不假设 mock 的默认值。
//
// 队列/超时用例依赖 mock-only 的 POST /api/dev/burst 造流；真服务没有该端点
// （不在定版契约里），mock 轮覆盖，真服务轮跳过并在 README 登记。
// ============================================================================

test.describe.configure({ mode: 'serial' });

const usingMock = !USING_EXTERNAL_SERVICE;

type ApiRequest = Parameters<typeof capture>[0];

/**
 * mock 轮的连接计数来自 health data.streams.active（mock 扩展字段，不在定版契约里）；
 * 真服务不暴露该字段时返回 null，调用方跳过这项本地观测。
 */
async function activeStreams(request: ApiRequest): Promise<number | null> {
  const health = (await getHealth(request)) as unknown as { streams?: { active?: number } };
  return health.streams?.active ?? null;
}

/** mock 轮才有的确证：capture 的两条事件都到了订阅端（按 emitted 的 seq 精确核对）。 */
function expectCaptureBroadcast(replay: SseStream, captured: CaptureData): void {
  const seqs = new Set(replay.updates().map((update) => update.seq));
  for (const event of captured.emitted) expect(seqs.has(event.seq)).toBe(true);
}

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

function assertUpdateShape(update: {
  seq: number;
  kind: string;
  project_id: string;
  occurred_at: string;
}): void {
  expect(Number.isInteger(update.seq)).toBe(true);
  expect(update.seq).toBeGreaterThan(0);
  // R-9：kind = 内核封闭目录的 PascalCase 领域事件名
  expect(update.kind).toMatch(/^[A-Z][A-Za-z]+$/);
  expect(update.project_id).toBeTruthy();
  expect(typeof update.occurred_at).toBe('string');
}

test.afterEach(async () => {
  for (const stream of streams) stream.close();
  streams.length = 0;
  // 真服务在 hub 里异步回收预算，给下一用例留出名额。
  await sleep(USING_EXTERNAL_SERVICE ? 300 : 100);
});

test.describe('SSE 协议纪律', () => {
  test('纪律 1a：先订阅再取快照，订阅与快照之间注入的事件最终不漏', async ({ request }) => {
    const before = await getHome(request);
    const cursor = before.projection_version;
    expect(Number.isInteger(cursor)).toBe(true);

    // 先建立订阅：cursor 锚定在快照之前的版本。
    const stream = track(await SseStream.open(`/api/stream?cursor=${cursor}`));
    expect(stream.headers.get('content-type') ?? '').toContain('text/event-stream');

    // 订阅已建立、快照尚未返回期间注入新事件（capture 会追加提议 + 反馈两条事件）。
    const captured = await capture(request, `SSE 快照对齐 ${randomUUID().slice(0, 8)}`, {
      projectId: DEMO.projectId,
    });

    // 此刻才取快照：快照必须至少并入刚注入的事件。
    const snapshot = await getHome(request);
    expect(snapshot.projection_version).toBeGreaterThanOrEqual(captured.projection_version);

    // ready 帧记录的是订阅时的快照水位，不用于本断言（客户端以 cursor 为准）。
    await stream.waitForUpdate((update) => update.seq === snapshot.projection_version, 10_000);
    const updates = stream.updates();
    updates.forEach(assertUpdateShape);

    const seqs = updates.map((update) => update.seq);
    // 从 cursor+1 到快照版本，一条不漏、一条不重、顺序严格递增。
    expect(seqs).toEqual(range(cursor + 1, snapshot.projection_version));
    expect(new Set(seqs).size).toBe(seqs.length);

    for (const event of captured.emitted) {
      expect(seqs).toContain(event.seq);
    }
    const feedback = updates.find((update) => update.kind === 'FeedbackReceived');
    expect(feedback, 'capture 必须广播 FeedbackReceived（R-9 PascalCase）').toBeDefined();
    const proposed = updates.find((update) => update.kind === 'PlanChangeProposed');
    expect(proposed, 'capture 必须广播 PlanChangeProposed').toBeDefined();
    expect(proposed!.proposal_id).toBe(captured.proposal_id);
  });

  test('纪律 1b：先快照后订阅（cursor=projection_version），不补旧事件只收新事件', async ({ request }) => {
    const snapshot = await getHome(request);
    const cursor = snapshot.projection_version;

    const stream = track(await SseStream.open(`/api/stream?cursor=${cursor}`));
    // 给补发窗口留足时间：cursor 之后没有历史事件，不应出现任何 update。
    await sleep(400);
    expect(stream.updateSeqs()).toEqual([]);

    const captured = await capture(request, `SSE 快照后订阅 ${randomUUID().slice(0, 8)}`, {
      projectId: DEMO.projectId,
    });
    await stream.waitForUpdate((update) => update.seq === captured.projection_version, 10_000);

    const seqs = stream.updateSeqs();
    expect(seqs).toEqual(range(cursor + 1, captured.projection_version));
    expect(seqs.every((seq) => seq > cursor)).toBe(true);
  });

  test('纪律 2：断线后按 cursor 重连，补发 seq 连续、不丢不重', async ({ request }) => {
    const baseline = await getHome(request);
    const cursor = baseline.projection_version;

    // 先连一次再断开，确定 cursor 锚点。
    const first = track(await SseStream.open(`/api/stream?cursor=${cursor}`));
    first.close();
    await sleep(100);

    // 断线期间发生 3 次 capture。
    const captures = [];
    for (let index = 0; index < 3; index += 1) {
      captures.push(
        await capture(request, `SSE 断线补发 ${index} ${randomUUID().slice(0, 8)}`, {
          projectId: DEMO.projectId,
        }),
      );
    }
    const finalHead = (await getHome(request)).projection_version;
    expect(finalHead).toBeGreaterThan(cursor);
    expect(finalHead).toBeGreaterThanOrEqual(captures[2].projection_version);

    // 带 cursor 重连：应精确补发 (cursor, finalHead]。
    const replay = track(await SseStream.open(`/api/stream?cursor=${cursor}`));
    const ready: StreamReadyFrame = await replay
      .waitFor((frame) => frame.event === 'ready' && frame.data !== null, 10_000)
      .then((frame) => JSON.parse(frame.data!) as StreamReadyFrame);
    expect(ready.requested_cursor).toBe(cursor);
    expect(ready.replayed).toBe(finalHead - cursor);

    await replay.waitForUpdate((update) => update.seq === finalHead, 10_000);
    const seqs = replay.updateSeqs();
    expect(seqs).toEqual(range(cursor + 1, finalHead));
    expect(new Set(seqs).size).toBe(seqs.length);

    // 3 次 capture 的事件都补发到了（用各自 emitted 的 seq 精确核对）
    const replayedSeqs = new Set(replay.updates().map((update) => update.seq));
    for (const captured of captures) {
      for (const event of captured.emitted) {
        expect(replayedSeqs.has(event.seq)).toBe(true);
      }
    }
    expect(replay.updates().filter((update) => update.kind === 'FeedbackReceived')).toHaveLength(3);

    // 已追平 head 后再重连：没有可补发的事件。
    const caughtUp = track(await SseStream.open(`/api/stream?cursor=${finalHead}`));
    await sleep(300);
    expect(caughtUp.updateSeqs()).toEqual([]);
  });

  test('纪律 3a（R-4）：连接数达到上限后新连接返回 503 + Retry-After，断线后名额归还', async ({
    request,
  }) => {
    const health = await getHealth(request);
    const maxConnections = health.limits.max_connections;
    expect(maxConnections).toBeGreaterThanOrEqual(2);

    const cursor = (await getHome(request)).projection_version;
    const opened: SseStream[] = [];
    for (let index = 0; index < maxConnections; index += 1) {
      opened.push(track(await SseStream.open(`/api/stream?cursor=${cursor}`)));
    }
    const active = await activeStreams(request);
    if (active !== null) expect(active).toBe(maxConnections);

    let failure: unknown;
    try {
      await SseStream.open(`/api/stream?cursor=${cursor}`);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SseOpenError);
    const openError = failure as SseOpenError;
    // R-4：可观测行为 = 503 + Retry-After；不测旧的 429 too_many_connections
    expect(openError.status).toBe(503);
    expect(openError.headers.get('retry-after')).toBeTruthy();
    expect(Number(openError.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = JSON.parse(openError.body) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(['unavailable', 'bad_request']).toContain(body.error.code);

    // 关闭全部连接后名额归还：可以重新建连
    for (const stream of opened) stream.close();
    streams.length = 0;
    await sleep(300);

    const again = track(await SseStream.open(`/api/stream?cursor=${cursor}`));
    await again.waitFor((frame) => frame.event === 'ready', 5_000);
  });

  test('纪律 3b（R-4）：慢消费者被服务端断开（mock：burst 造流）', async ({ request }) => {
    test.skip(
      USING_EXTERNAL_SERVICE,
      '需要 mock-only 的 POST /api/dev/burst 造流；真服务无该端点（不在定版契约内），见 README「已知限制」',
    );

    const head = (await getHome(request)).projection_version;
    // paused：只拿响应头、不读 body，构造慢消费者
    const stream = track(await SseStream.open(`/api/stream?cursor=${head}`, { paused: true }));
    const active = await activeStreams(request);
    if (active !== null) expect(active).toBe(1);

    const burstCount = SSE_LIMITS.maxPendingPerConnection;
    const burst = await request.post('/api/dev/burst', { data: { count: burstCount } });
    expect([200, 201, 202]).toContain(burst.status());
    const burstBody = unwrap<DevBurstData>('POST /api/dev/burst', burst.status(), await burst.json());
    expect(burstBody.emitted).toBe(burstCount);

    // 可观测行为：服务端把这条不消费的连接断掉（不看内部发送泵/drain 模型）
    const closedAt = Date.now();
    stream.startReading();
    await stream.waitForClosed(15_000);
    expect(Date.now() - closedAt).toBeLessThanOrEqual(15_000);
  });

  test('心跳：15s 内至少一条心跳帧（注释 : ping 或 heartbeat）', async ({ request }) => {
    const health = await getHealth(request);
    const heartbeatMs = health.limits.heartbeat_ms;
    expect(heartbeatMs).toBe(SSE_HEARTBEAT_MS);

    const head = (await getHome(request)).projection_version;
    const openedAt = Date.now();
    const stream = track(await SseStream.open(`/api/stream?cursor=${head}`));
    const frame = await stream.waitFor(
      (candidate) =>
        (candidate.comment ?? '').includes('ping') || (candidate.comment ?? '').includes('heartbeat'),
      heartbeatMs + 5_000,
    );
    const elapsed = Date.now() - openedAt;

    expect(frame.comment).toMatch(/ping|heartbeat/);
    expect(elapsed).toBeGreaterThanOrEqual(heartbeatMs - 2_000);
    expect(elapsed).toBeLessThanOrEqual(heartbeatMs + 5_000);
  });
});
