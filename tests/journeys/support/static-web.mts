// 真实前端构建产物（web/dist）的静态托管 + /api 流式反代（与生产部署 B 案
// 同拓扑：静态文件直出、/api 反代到目标服务、BrowserRouter 路径回退
// index.html）。spec50 首创于 spec 内，K1 旅程（60/80）起抽到 support 共用。
import { createServer, request as httpRequest, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, '../../../web/dist');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

export interface StaticWeb {
  origin: string;
  close: () => Promise<void>;
}

/** targetBaseUrl = 被反代的真服务基址（如 http://127.0.0.1:8787）。 */
export async function startStaticWeb(targetBaseUrl: string): Promise<StaticWeb> {
  if (!existsSync(path.join(distDir, 'index.html'))) {
    throw new Error(`web/dist 未构建：${distDir}（先执行 npm --prefix web run build）`);
  }
  const apiBase = new URL(targetBaseUrl);
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://static.local');
    if (url.pathname.startsWith('/api/')) {
      const proxy = httpRequest(
        {
          hostname: apiBase.hostname,
          port: apiBase.port || undefined,
          path: url.pathname + url.search,
          method: req.method,
          headers: { ...req.headers, host: apiBase.host },
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      proxy.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end('proxy error');
      });
      req.pipe(proxy);
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    readFile(path.join(distDir, rel))
      .then((body) => {
        res.writeHead(200, { 'content-type': MIME[path.extname(rel)] ?? 'application/octet-stream' });
        res.end(body);
      })
      .catch(async () => {
        try {
          const body = await readFile(path.join(distDir, 'index.html'));
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(body);
        } catch {
          res.writeHead(404);
          res.end();
        }
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('静态服务器监听失败');
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
