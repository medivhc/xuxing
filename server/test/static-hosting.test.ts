// A 案服务端静态自托管 e2e（真服务：@hono/node-server 真监听 + 真 fetch）。
// 断言口径：在场 + 真状态——子路径直达与刷新都回 index.html、资产 200 且类型对、
// 缺失资产大声 404（不拿 index.html 冒充）、/api 与 SSE 同源行为不变、
// 路径穿越被拦、未启用托管时纯 API 形态零影响。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.ts';
import { resolveWebDist } from '../src/api/static.ts';
import { createHarness, stubProposer, TEST_SSE, type Harness } from './support/harness.ts';
import { seedDemo } from '../src/seed/demo.ts';

const INDEX_HTML = '<!doctype html><html><head><title>fixture</title></head><body><div id="root">FIXTURE-INDEX-MARKER</div><script type="module" src="/assets/app-abc123.js"></script></body></html>';
const APP_JS = 'console.log("fixture-app");\n';
const APP_CSS = '.fixture{color:rgb(1,2,3)}\n';

let harness: Harness;
let distDir: string;
let server: ServerType;
let base = '';
let pureServer: ServerType;
let pureBase = '';

async function listen(app: Parameters<typeof serve>[0]['fetch']): Promise<{ server: ServerType; base: string }> {
  return new Promise((resolve) => {
    const srv = serve({ fetch: app, port: 0, hostname: '127.0.0.1' }, (info) => {
      resolve({ server: srv, base: `http://127.0.0.1:${info.port}` });
    });
  });
}

beforeAll(async () => {
  distDir = await mkdtemp(path.join(tmpdir(), 'xuxing-webdist-'));
  await mkdir(path.join(distDir, 'assets'));
  await writeFile(path.join(distDir, 'index.html'), INDEX_HTML);
  await writeFile(path.join(distDir, 'assets', 'app-abc123.js'), APP_JS);
  await writeFile(path.join(distDir, 'assets', 'app-def456.css'), APP_CSS);
  await writeFile(path.join(distDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');

  harness = await createHarness();
  const built = await buildApp({
    pool: harness.pool,
    store: harness.store,
    proposer: stubProposer(),
    sse: TEST_SSE,
    clock: () => harness.clock.now,
    webDist: distDir,
  });
  await seedDemo({ store: harness.store, projection: built.config.projection });
  ({ server, base } = await listen(built.app.fetch));

  const pure = await buildApp({
    pool: harness.pool,
    store: harness.store,
    proposer: stubProposer(),
    sse: TEST_SSE,
    clock: () => harness.clock.now,
    webDist: null,
    rebuild: false,
  });
  ({ server: pureServer, base: pureBase } = await listen(pure.app.fetch));
});

afterAll(async () => {
  server.close();
  pureServer.close();
  await harness.close();
});

/** 原始 HTTP 请求（fetch 会规范化 .. 路径，穿越用例必须走 raw path）。 */
function rawGet(baseUrl: string, rawPath: string): Promise<{ status: number; body: string }> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: url.hostname, port: url.port, path: rawPath, method: 'GET' },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('A 案静态自托管（真服务）', () => {
  it('GET / → 200 index.html 本体（标记在场）', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it('子路径直达 → 200 回 index.html；刷新（重复请求）仍 200 同内容', async () => {
    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`${base}/projects/proj_demo_oq05`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toBe(INDEX_HTML);
    }
    const deep = await fetch(`${base}/projects/proj_demo_oq05/tasks/task-1`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toBe(INDEX_HTML);
  });

  it('JS/CSS 资产 → 200 且类型与内容逐字对，JS 带长缓存', async () => {
    const js = await fetch(`${base}/assets/app-abc123.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect(await js.text()).toBe(APP_JS);

    const css = await fetch(`${base}/assets/app-def456.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(await css.text()).toBe(APP_CSS);

    const svg = await fetch(`${base}/favicon.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
  });

  it('缺失资产 → 404 JSON 信封，绝不回退 index.html 冒充', async () => {
    const res = await fetch(`${base}/assets/missing-zzz.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it('/api 同源不受影响：health 信封 + home 真数据；未知 /api 路径仍是 JSON 404', async () => {
    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as { ok: boolean; data: { db: boolean } };
    expect(healthBody.ok).toBe(true);
    expect(healthBody.data.db).toBe(true);

    const home = await fetch(`${base}/api/home`);
    expect(home.status).toBe(200);
    const homeBody = (await home.json()) as { ok: boolean; data: { projects: unknown[] } };
    expect(homeBody.ok).toBe(true);
    expect(homeBody.data.projects.length).toBeGreaterThan(0);

    const unknown = await fetch(`${base}/api/definitely-not-a-route`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toContain('application/json');
    expect(((await unknown.json()) as { ok: boolean }).ok).toBe(false);
  });

  it('SSE 同源仍通：/api/stream 200 + ready 帧到达', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${base}/api/stream`, { signal: controller.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (!text.includes('ready')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      expect(text).toContain('ready');
      expect(text).toContain('projection_version');
      controller.abort();
    } finally {
      clearTimeout(timer);
    }
  });

  it('路径穿越被拦：编码 .. 逃不出 dist 根（404，不吐文件）', async () => {
    const a = await rawGet(base, '/%2e%2e%2fsecret.txt');
    expect(a.status).toBe(404);
    expect(a.body).not.toContain('FIXTURE-INDEX-MARKER');
    const b = await rawGet(base, '/assets/%2e%2e%2f%2e%2e%2fetc%2fpasswd');
    expect(b.status).toBe(404);
    expect(b.body).not.toContain('root:');
  });

  it('HEAD 子路径 → 200 且无 body', async () => {
    const res = await fetch(`${base}/projects/proj_demo_oq05`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});

describe('未启用托管时纯 API 形态零影响', () => {
  it('webDist=null：GET / → 404（无静态兜底），/api/health 仍 200', async () => {
    const root = await fetch(`${pureBase}/`);
    expect(root.status).toBe(404);
    const health = await fetch(`${pureBase}/api/health`);
    expect(health.status).toBe(200);
  });
});

describe('resolveWebDist 解析口径', () => {
  it('XUXING_WEB_DIST 显式指定且有效 → 返回该目录', () => {
    expect(resolveWebDist({ XUXING_WEB_DIST: distDir })).toBe(distDir);
  });

  it('XUXING_WEB_DIST 指向无 index.html 的目录 → 大声抛错（不静默降级）', () => {
    expect(() => resolveWebDist({ XUXING_WEB_DIST: path.join(distDir, 'assets') })).toThrow(
      /没有 index\.html/,
    );
  });

  it('未设环境变量且候选全缺 → null（纯 API 形态）', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'xuxing-empty-'));
    expect(resolveWebDist({}, { moduleDir: empty, cwd: empty })).toBeNull();
  });
});
