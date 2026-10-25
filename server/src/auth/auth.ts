// K1-C 基础访问控制（K1-SPEC v0.4 §5，含 OQ-K1-3 双令牌裁决）：
// - 用户令牌 XUXING_ACCESS_TOKEN 只护 /api 用户面；节点令牌 XUXING_NODE_TOKEN
//   只护节点面（注册/心跳/注销/长轮询/Run 回报），互不通用（对方令牌 → 401）。
// - fail-closed：production 且用户令牌未设置 → 拒绝启动（错误信息含变量名）；
//   任一令牌已设置但 <16 字符 → 拒绝启动；production 且节点令牌未设置 →
//   不拒整进程，但节点面一律 401 + 启动 WARN。
// - 承载：用户面认 Bearer 用户令牌或会话 cookie（POST /api/auth/session 换发）；
//   节点面只认 Bearer 节点令牌，不认 cookie。
// - 未授权一律 401 同形 {ok:false,error:{code:"unauthorized",message:"unauthorized"}}：
//   无凭据与错凭据不可区分。令牌比较走常量时间（先 SHA-256 再 timingSafeEqual）。
// - 令牌不入库、不入仓、不进日志：本模块只从 env/注入配置读，日志只打布尔态。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { fail } from '../api/http.ts';

export const ACCESS_TOKEN_ENV = 'XUXING_ACCESS_TOKEN';
export const NODE_TOKEN_ENV = 'XUXING_NODE_TOKEN';
export const SESSION_COOKIE = 'xuxing_session';
export const MIN_TOKEN_LENGTH = 16;
export const DEFAULT_SESSION_TTL_SEC = 7 * 24 * 3600;

export interface AuthConfig {
  accessToken: string | null;
  nodeToken: string | null;
  production: boolean;
  sessionTtlSec: number;
  cookieSecure: boolean;
}

export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const ttlRaw = Number(env.XUXING_SESSION_TTL_SEC ?? '');
  const access = env[ACCESS_TOKEN_ENV];
  const node = env[NODE_TOKEN_ENV];
  return {
    accessToken: access !== undefined && access.trim() !== '' ? access : null,
    nodeToken: node !== undefined && node.trim() !== '' ? node : null,
    production: env.NODE_ENV === 'production',
    sessionTtlSec: Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : DEFAULT_SESSION_TTL_SEC,
    cookieSecure: env.XUXING_COOKIE_SECURE === '1',
  };
}

/**
 * 启动校验（fail-closed）。硬错误抛 Error（消息含环境变量名，调用方据此拒启）；
 * 软问题以 WARN 字符串返回（main/buildApp 打日志）。
 */
export function validateAuthConfig(config: AuthConfig): string[] {
  const warnings: string[] = [];
  if (config.accessToken !== null && config.accessToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(`${ACCESS_TOKEN_ENV} 已设置但长度不足 ${MIN_TOKEN_LENGTH} 字符：拒绝启动（fail-closed）`);
  }
  if (config.nodeToken !== null && config.nodeToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(`${NODE_TOKEN_ENV} 已设置但长度不足 ${MIN_TOKEN_LENGTH} 字符：拒绝启动（fail-closed）`);
  }
  if (config.production && config.accessToken === null) {
    throw new Error(`${ACCESS_TOKEN_ENV} 未设置：production 模式拒绝启动（fail-closed）`);
  }
  if (config.production && config.nodeToken === null) {
    warnings.push(`${NODE_TOKEN_ENV} 未设置：节点面一律 401（节点注册/心跳/派发/回报全部关闭）`);
  }
  if (!config.production && config.accessToken === null) {
    warnings.push(`${ACCESS_TOKEN_ENV} 未设置：非 production 模式，用户面未启用访问控制（auth_enabled=false）`);
  }
  return warnings;
}

/** 常量时间比较：先各自 SHA-256（定长化）再 timingSafeEqual，避免长度与前缀泄漏。 */
export function tokensEqual(candidate: string, expected: string): boolean {
  const a = createHash('sha256').update(candidate, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** 会话存储：不透明随机凭证（非令牌原文、非其简单哈希），进程内 Map + TTL。 */
export class SessionStore {
  private readonly sessions = new Map<string, number>(); // session_id -> expires_at(ms)

  constructor(private readonly ttlSec: number) {}

  issue(now: Date): { sessionId: string; expiresAt: Date } {
    const sessionId = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + this.ttlSec * 1000);
    this.sessions.set(sessionId, expiresAt.getTime());
    return { sessionId, expiresAt };
  }

  verify(sessionId: string | undefined, now: Date): boolean {
    if (!sessionId) return false;
    const expiresAt = this.sessions.get(sessionId);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now.getTime()) {
      this.sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  revoke(sessionId: string | undefined): void {
    if (sessionId) this.sessions.delete(sessionId);
  }
}

export interface AuthService {
  config: AuthConfig;
  sessions: SessionStore;
  /** 用户面是否启用访问控制（health.auth_enabled 的口径）。 */
  readonly userAuthEnabled: boolean;
  /** 节点面是否配置了节点令牌。 */
  readonly nodeAuthEnabled: boolean;
}

export function createAuthService(config: AuthConfig): AuthService {
  return {
    config,
    sessions: new SessionStore(config.sessionTtlSec),
    userAuthEnabled: config.accessToken !== null,
    nodeAuthEnabled: config.nodeToken !== null,
  };
}

/** 节点面路径判定（§5.2/§4.5）：/api/nodes 配下除 GET /api/nodes 列表（用户面）外全是节点面。 */
export function isNodeSurface(method: string, path: string): boolean {
  if (!path.startsWith('/api/nodes')) return false;
  if (method === 'GET' && path === '/api/nodes') return false; // 列表走用户面（§4.5）
  return true;
}

function bearerOf(c: Context): string | null {
  const header = c.req.header('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? (match[1] as string) : null;
}

export function sessionCookieOf(c: Context): string | undefined {
  const header = c.req.header('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function sessionCookieHeader(sessionId: string, config: AuthConfig, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${sessionId}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${config.sessionTtlSec}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedCookieHeader(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function unauthorized(): Response {
  return Response.json(fail('unauthorized', 'unauthorized'), { status: 401 });
}

/**
 * 访问控制中间件（覆盖全部 /api/*）。
 * 豁免仅两处：GET /api/health、POST /api/auth/session（§5.3）。
 */
export function createAuthMiddleware(auth: AuthService, clock: () => Date): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    if (!path.startsWith('/api/')) return next();
    if (path === '/api/health' && c.req.method === 'GET') return next();
    if (path === '/api/auth/session' && c.req.method === 'POST') return next();

    if (isNodeSurface(c.req.method, path)) {
      // 节点面：只认 Bearer 节点令牌（不认 cookie、不认用户令牌）。
      if (auth.config.nodeToken === null) {
        // production 未配节点令牌 → 一律 401（§5.1）；非 production 且用户面
        // 也未启访问控制 → 开发放行（与 auth_enabled=false 口径一致）。
        if (auth.config.production || auth.userAuthEnabled) return unauthorized();
        return next();
      }
      const bearer = bearerOf(c);
      if (bearer === null || !tokensEqual(bearer, auth.config.nodeToken)) return unauthorized();
      return next();
    }

    // 用户面：Bearer 用户令牌或会话 cookie 二选一。
    if (auth.config.accessToken === null) return next(); // 非 production 未配置 → 放行（启动已 WARN）
    const bearer = bearerOf(c);
    if (bearer !== null && tokensEqual(bearer, auth.config.accessToken)) return next();
    if (auth.sessions.verify(sessionCookieOf(c), clock())) return next();
    return unauthorized();
  };
}
