// A 案：服务端静态自托管（部署形态回归 app 自包含，Caddy 只做反代/终止 TLS）。
//
// 行为契约：
// - 仅当解析到 web 构建产物目录（dist）时启用；未启用时 createApp 不注册任何
//   静态路由，服务保持纯 API 形态（既有测试/本地调试零影响）。
// - /api/* 永远优先于静态：本模块只在全部 API 路由之后注册兜底，/api 下未命中
//   的路径返回 JSON 信封 404，绝不回退 index.html（否则前端会把 HTML 当 API 响应）。
// - SPA 回退：无扩展名的路径（前端 BrowserRouter 路由）一律回 index.html；
//   带扩展名的路径按文件直出，缺失即 404——资产 404 必须大声失败，不能拿
//   index.html 冒充 JS/CSS（浏览器会以模块加载错误静默坏掉，正是 B 案踩过的坑）。
// - 路径穿越：解码后规范化并校验仍在 dist 根内，越界一律 404。
// - 缓存：index.html 与 SPA 回退响应 no-store（部署即生效）；/assets/ 下为
//   Vite 内容哈希命名，可长缓存 immutable；其余文件不额外加头（全局中间件
//   会补 no-store）。

import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context, Hono } from 'hono';
import { fail } from './http.ts';

export const WEB_DIST_ENV = 'XUXING_WEB_DIST';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export interface WebDistOverrides {
  moduleDir?: string;
  cwd?: string;
}

/**
 * 解析 web/dist 目录：
 * 1. 环境变量 XUXING_WEB_DIST 显式指定（绝对路径，或相对进程 cwd）——指定了
 *    就必须有效：目录无 index.html 直接抛错，不静默降级成纯 API 形态。
 * 2. 缺省相对定位：按源码布局（server/src/api）与构建布局
 *    （server/dist/server/src/api）两种相对路径、再加 cwd 两处候选探测，
 *    首个含 index.html 的目录胜出；都没有 → null（纯 API 形态）。
 */
export function resolveWebDist(
  env: NodeJS.ProcessEnv = process.env,
  overrides: WebDistOverrides = {},
): string | null {
  const raw = env[WEB_DIST_ENV]?.trim();
  const cwd = overrides.cwd ?? process.cwd();
  if (raw) {
    const abs = path.resolve(cwd, raw);
    if (!existsSync(path.join(abs, 'index.html'))) {
      throw new Error(
        `${WEB_DIST_ENV}=${raw} 指向的目录没有 index.html（解析为 ${abs}）：` +
          `先构建 web（npm --prefix web run build）或修正路径`,
      );
    }
    return abs;
  }
  const moduleDir = overrides.moduleDir ?? path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, '../../../web/dist'), // 源码布局：server/src/api → 仓库根
    path.resolve(moduleDir, '../../../../../web/dist'), // 构建布局：server/dist/server/src/api → 仓库根
    path.resolve(cwd, 'web/dist'),
    path.resolve(cwd, '../web/dist'),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

function contentTypeOf(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** 把请求路径解析成 dist 内的绝对文件路径；越界/非法返回 null。 */
function resolveInside(distDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const rel = decoded.replace(/^\/+/, '');
  const resolved = path.resolve(distDir, rel);
  if (resolved !== distDir && !resolved.startsWith(distDir + path.sep)) return null;
  return resolved;
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/** 文件响应：HEAD 只回头不回体；GET 回全量字节。Content-Length 两种都给准。 */
function fileResponse(c: Context, data: Buffer, headers: Record<string, string>): Response {
  const withLength = { ...headers, 'Content-Length': String(data.byteLength) };
  if (c.req.method === 'HEAD') return c.body(null, 200, withLength);
  return c.body(new Uint8Array(data), 200, withLength);
}

/**
 * 在 Hono app 上注册静态托管兜底（必须在全部 API 路由之后调用）。
 * 返回的处理器只处理未被前面路由命中的请求。
 */
export function registerStaticHosting(app: Hono, distDir: string): void {
  const indexPath = path.join(distDir, 'index.html');

  app.all('*', async (c) => {
    const pathname = c.req.path;

    // /api 未命中：保持 JSON 信封 404，绝不回退 SPA（API 契约优先）。
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return c.json(fail('not_found', `接口不存在：${c.req.method} ${pathname}`), 404);
    }
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      return c.json(fail('not_found', `路径不存在：${c.req.method} ${pathname}`), 404);
    }

    const target = pathname === '/' ? indexPath : resolveInside(distDir, pathname);
    if (target !== null && (await isFile(target))) {
      const headers: Record<string, string> = { 'Content-Type': contentTypeOf(target) };
      if (target === indexPath) {
        headers['Cache-Control'] = 'no-store';
      } else if (pathname.startsWith('/assets/')) {
        headers['Cache-Control'] = 'public, max-age=31536000, immutable';
      }
      return fileResponse(c, await readFile(target), headers);
    }

    // 带扩展名却缺失：资产真丢了，大声 404，不拿 index.html 冒充。
    const base = pathname.split('/').pop() ?? '';
    if (base.includes('.')) {
      return c.json(fail('not_found', `静态文件不存在：${pathname}`), 404);
    }

    // SPA 回退：前端路由直达/刷新都回 index.html（BrowserRouter 语义）。
    return fileResponse(c, await readFile(indexPath), {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  });
}
