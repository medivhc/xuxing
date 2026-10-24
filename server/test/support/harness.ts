// server 车道端到端测试支撑：真 PG16（仓库既有 docker 口径）+ 进程内 Hono app + 可控时钟/提议器。
// 纪律：PG 不可用大声失败，不 skip、不 mock；模型调用一律用测试替身（不碰真实网关）。

import { Pool } from 'pg';
import { createPgEventStore, migrate, type PgEventStore } from '../../../src/kernel/event-store-pg.ts';
import { buildApp, DEFAULT_ACTOR_ID, DEFAULT_PROJECT_ID } from '../../src/app.ts';
import { seedDemo } from '../../src/seed/demo.ts';
import { createProposer, type Proposer, type ProposerConfig } from '../../src/proposers/proposer.ts';
import { createTestPg, type TestPg } from './pg.ts';
import type { SseOptions } from '../../src/sse/protocol.ts';

export const TEST_SSE: SseOptions = {
  maxConnections: 4,
  queueLimit: 8,
  slowTimeoutMs: 150,
  heartbeatMs: 60,
};

export interface Harness {
  pg: TestPg;
  pool: Pool;
  store: PgEventStore;
  clock: { now: Date; tick: (ms: number) => void };
  close: () => Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const pg = await createTestPg();
  await migrate(pg.pool);
  const clock = {
    now: new Date('2026-10-24T08:00:00.000Z'),
    tick(ms: number) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
  const store = createPgEventStore(pg.pool, { clock: () => clock.now });
  return {
    pg,
    pool: pg.pool,
    store,
    clock,
    close: () => pg.close(),
  };
}

/** 提议器替身：确定性、可控降级状态，不访问网络。 */
export function stubProposer(options: { degraded?: boolean; title?: string } = {}): Proposer {
  const degraded = options.degraded === true;
  const config: ProposerConfig = {
    baseUrl: 'http://stub.invalid/v1',
    apiKey: null,
    model: 'workbuddy-ai/deepseek-v4.1-flash',
    timeoutMs: 10,
  };
  const real = createProposer(config);
  if (!degraded) {
    return {
      interpretCapture: async ({ text }) => ({
        title: options.title ?? `模型提议：${text.slice(0, 12)}`,
        description: text,
        assignee_kind: 'human',
        acceptance_criteria: [{ criterion_ref: 'c1', text: '提交可核对的执行反馈', auto: false }],
        rationale: '测试替身（model）',
        meta: { source: 'model', model: config.model, degraded: false, degraded_reason: null, latency_ms: 1 },
      }),
      interpretFeedback: async ({ feedback }) => ({
        draft: {
          conclusion_kind: 'achieved',
          info_obtained: true,
          certainty: 'med',
          evidence_sufficiency: 'sufficient',
          blockers: [],
          followup_suggestions: [],
          source: 'model',
          degraded: false,
          degraded_reason: null,
        },
        meta: { source: 'model', model: config.model, degraded: false, degraded_reason: null, latency_ms: 1 },
      }),
    };
  }
  // 降级：复用真实降级实现（无 key → not_configured）
  return {
    interpretCapture: async ({ text }) => ({ ...(await real.interpretCapture({ text, projectName: 'P' })), rationale: '测试替身（fallback）' }),
    interpretFeedback: async ({ taskTitle, feedback, criteria }) => real.interpretFeedback({ taskTitle, feedback, criteria }),
  };
}

export interface BootedApp {
  harness: Harness;
  app: Awaited<ReturnType<typeof buildApp>>['app'];
  config: Awaited<ReturnType<typeof buildApp>>['config'];
  close: () => Promise<void>;
}

/** 起一个已种子化的应用（演示项目 + 4 个任务）。 */
export async function bootApp(options: {
  proposer?: Proposer;
  seed?: boolean;
  sse?: SseOptions;
  /** A 案静态自托管：显式传 dist 目录启用；缺省 undefined（按环境解析）。 */
  webDist?: string | null;
} = {}): Promise<BootedApp> {
  const harness = await createHarness();
  const { app, config } = await buildApp({
    pool: harness.pool,
    store: harness.store,
    proposer: options.proposer ?? stubProposer(),
    sse: options.sse ?? TEST_SSE,
    clock: () => harness.clock.now,
    webDist: options.webDist,
  });
  if (options.seed !== false) {
    await seedDemo({ store: harness.store, projection: config.projection });
  }
  return {
    harness,
    app,
    config,
    close: async () => {
      config.hub.closeAll();
      await harness.close();
    },
  };
}

export { DEFAULT_PROJECT_ID, DEFAULT_ACTOR_ID };

export async function api(
  app: BootedApp,
  path: string,
  init: RequestInit & { actor?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.actor) headers.set('x-xuxing-actor', init.actor);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return app.app.request(`http://localhost${path}`, { ...init, headers });
}

export async function jsonOf<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** 读取 SSE 流直到满足条件（或超时），返回原始帧文本。 */
export async function readSseUntil(
  response: Response,
  predicate: (text: string) => boolean,
  timeoutMs = 2_000,
): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (predicate(text)) {
      reader.releaseLock();
      return text;
    }
  }
  reader.releaseLock();
  return text;
}

export function parseSse(text: string): Array<{ event: string; data: unknown }> {
  const frames: Array<{ event: string; data: unknown }> = [];
  for (const block of text.split('\n\n')) {
    if (block.trim().length === 0) continue;
    if (block.startsWith(':')) {
      frames.push({ event: 'heartbeat', data: block });
      continue;
    }
    const eventLine = block.split('\n').find((line) => line.startsWith('event: '));
    const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
    if (!dataLine) continue;
    frames.push({
      event: eventLine ? eventLine.slice('event: '.length) : 'message',
      data: JSON.parse(dataLine.slice('data: '.length)),
    });
  }
  return frames;
}
