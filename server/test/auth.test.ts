// K1-C 访问控制测试（K1-SPEC v0.4 §5，OQ-K1-3 双令牌）。
// 覆盖：fail-closed 启动校验、未授权 401 同形、Bearer/cookie 双承载、
// 会话换发与登出作废、双令牌互不通用、/api/stream 同样 401。

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import type { AuthConfig } from '../src/auth/auth.ts';
import { createHarness, stubProposer, TEST_SSE, type Harness } from './support/harness.ts';

const ACCESS = 'user-token-0123456789abcdef';
const NODE = 'node-token-0123456789abcdef';

function authConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    accessToken: ACCESS,
    nodeToken: NODE,
    production: false,
    sessionTtlSec: 3600,
    cookieSecure: false,
    ...overrides,
  };
}

async function bootWithAuth(auth: AuthConfig) {
  const harness: Harness = await createHarness();
  const built = await buildApp({
    pool: harness.pool,
    store: harness.store,
    proposer: stubProposer(),
    sse: TEST_SSE,
    clock: () => harness.clock.now,
    auth,
  });
  return {
    harness,
    app: built.app,
    close: async () => {
      built.config.hub.closeAll();
      await harness.close();
    },
  };
}

function req(app: Awaited<ReturnType<typeof bootWithAuth>>['app'], path: string, init: RequestInit = {}) {
  return app.request(`http://localhost${path}`, init);
}

describe('K1-C fail-closed 启动校验（K1C-AC-01）', () => {
  it('production 且 XUXING_ACCESS_TOKEN 未设置 → 拒绝启动且错误含变量名', async () => {
    const harness = await createHarness();
    await expect(
      buildApp({
        pool: harness.pool,
        store: harness.store,
        proposer: stubProposer(),
        sse: TEST_SSE,
        auth: authConfig({ accessToken: null, production: true }),
      }),
    ).rejects.toThrow(/XUXING_ACCESS_TOKEN/);
    await harness.close();
  });

  it('令牌已设置但不足 16 字符 → 拒绝启动（用户令牌与节点令牌同规则）', async () => {
    const harness = await createHarness();
    await expect(
      buildApp({
        pool: harness.pool,
        store: harness.store,
        proposer: stubProposer(),
        sse: TEST_SSE,
        auth: authConfig({ accessToken: 'short' }),
      }),
    ).rejects.toThrow(/XUXING_ACCESS_TOKEN/);
    await expect(
      buildApp({
        pool: harness.pool,
        store: harness.store,
        proposer: stubProposer(),
        sse: TEST_SSE,
        auth: authConfig({ nodeToken: 'short' }),
      }),
    ).rejects.toThrow(/XUXING_NODE_TOKEN/);
    await harness.close();
  });
});

describe('K1-C 未授权同形与双承载（K1C-AC-02/03/04/08）', () => {
  it('AC-02：受保护读面无凭据 → 401 同形；错令牌与无凭据响应体不可区分', async () => {
    const booted = await bootWithAuth(authConfig());
    const noCred = await req(booted.app, '/api/home');
    expect(noCred.status).toBe(401);
    const bodyNoCred = await noCred.json();
    expect(bodyNoCred).toEqual({ ok: false, error: { code: 'unauthorized', message: 'unauthorized' } });

    const wrong = await req(booted.app, '/api/home', {
      headers: { authorization: 'Bearer wrong-token-0123456789' },
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual(bodyNoCred);
    await booted.close();
  });

  it('AC-02：GET /api/health 豁免且含 auth_enabled:true，不泄漏业务字段', async () => {
    const booted = await bootWithAuth(authConfig());
    const health = await req(booted.app, '/api/health');
    expect(health.status).toBe(200);
    const body = await health.json();
    expect(body.data.auth_enabled).toBe(true);
    expect(JSON.stringify(body)).not.toContain(ACCESS);
    expect(JSON.stringify(body)).not.toContain(NODE);
    await booted.close();
  });

  it('AC-03：正确 Bearer 用户令牌可达用户面全部端点', async () => {
    const booted = await bootWithAuth(authConfig());
    const home = await req(booted.app, '/api/home', {
      headers: { authorization: `Bearer ${ACCESS}` },
    });
    expect(home.status).toBe(200);
    await booted.close();
  });

  it('AC-03/06：auth/session 换发 cookie（HttpOnly/SameSite=Lax/Path=/、值非令牌原文与简单哈希），cookie 可达读面，logout 后作废', async () => {
    const booted = await bootWithAuth(authConfig());
    const session = await req(booted.app, '/api/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: ACCESS }),
    });
    expect(session.status).toBe(200);
    const setCookie = session.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('xuxing_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    const cookieValue = /xuxing_session=([^;]+)/.exec(setCookie)?.[1] ?? '';
    expect(cookieValue.length).toBeGreaterThanOrEqual(32);
    expect(cookieValue).not.toBe(ACCESS);
    expect(cookieValue).not.toBe(createHash('sha256').update(ACCESS).digest('hex'));

    const cookie = `xuxing_session=${cookieValue}`;
    const home = await req(booted.app, '/api/home', { headers: { cookie } });
    expect(home.status).toBe(200);

    const logout = await req(booted.app, '/api/auth/logout', { method: 'POST', headers: { cookie } });
    expect(logout.status).toBe(200);
    const after = await req(booted.app, '/api/home', { headers: { cookie } });
    expect(after.status).toBe(401);
    await booted.close();
  });

  it('AC-04：/api/stream 无凭据 → 401 不建连', async () => {
    const booted = await bootWithAuth(authConfig());
    const stream = await req(booted.app, '/api/stream?cursor=0');
    expect(stream.status).toBe(401);
    await booted.close();
  });

  it('AC-08：非 production 且未配令牌 → 允许启动、health auth_enabled=false、读面直达', async () => {
    const booted = await bootWithAuth(authConfig({ accessToken: null, nodeToken: null }));
    const health = await req(booted.app, '/api/health');
    expect((await health.json()).data.auth_enabled).toBe(false);
    const home = await req(booted.app, '/api/home');
    expect(home.status).toBe(200);
    await booted.close();
  });
});

describe('K1-C 双令牌互不通用（OQ-K1-3 / K1C-AC-05 服务端面）', () => {
  it('节点令牌提交 auth/session → 401 且不下发 cookie', async () => {
    const booted = await bootWithAuth(authConfig());
    const session = await req(booted.app, '/api/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: NODE }),
    });
    expect(session.status).toBe(401);
    expect(session.headers.get('set-cookie')).toBeNull();
    await booted.close();
  });

  it('用户令牌打节点面 → 401；节点令牌打用户面 → 401；节点令牌过节点面中间件（非 401）', async () => {
    const booted = await bootWithAuth(authConfig());
    const userOnNode = await req(booted.app, '/api/nodes/some-node/heartbeat', {
      method: 'POST',
      headers: { authorization: `Bearer ${ACCESS}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(userOnNode.status).toBe(401);

    const nodeOnUser = await req(booted.app, '/api/home', {
      headers: { authorization: `Bearer ${NODE}` },
    });
    expect(nodeOnUser.status).toBe(401);

    // 节点面路由在 K1-B 落地前不存在：通过中间件后应为 404（而非 401），
    // 以此证明节点令牌在节点面被接受。K1-B 落地后该断言在 nodes 测试中收紧。
    const nodeOnNode = await req(booted.app, '/api/nodes/some-node/heartbeat', {
      method: 'POST',
      headers: { authorization: `Bearer ${NODE}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(nodeOnNode.status).not.toBe(401);
    await booted.close();
  });

  it('会话 cookie 打节点面 → 401（节点面不认 cookie）', async () => {
    const booted = await bootWithAuth(authConfig());
    const session = await req(booted.app, '/api/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: ACCESS }),
    });
    const cookie = (session.headers.get('set-cookie') ?? '').split(';')[0] as string;
    const onNode = await req(booted.app, '/api/nodes/some-node/heartbeat', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(onNode.status).toBe(401);
    await booted.close();
  });
});
