// 测试用 PG 供给：容器确保/启动/就绪等待、外部 PG 复用、每 suite 独立 schema、afterAll 清理。
// 纪律（plan §6 / §8）：docker 不可用时**大声失败**并给出处置指引，绝不 skip 或用内存 mock 顶替。
//
// 供给优先级：
//   1. XUXING_TEST_PG_URL 已设置 → 直接复用该 PG（外部兜底路径），不碰容器；
//   2. 否则确保本地容器 xuxing-pg-test（127.0.0.1:55432，postgres:16-alpine 本地镜像）。
// 隔离：每个 suite 一个 schema xs_test_<runid>_<rand>，连接池 search_path 指向它；
//       afterAll 先 DROP SCHEMA … CASCADE，容器本身保留复用（npm run db:down 清理）。

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';

export const PG_CONTAINER = 'xuxing-pg-test';
export const DEFAULT_PG_URL = 'postgres://postgres:postgres@127.0.0.1:55432/xuxing_test';

const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 500;

export interface TestPg {
  pool: Pool;
  schema: string;
  connectionString: string;
  /** 是否复用了外部 PG（XUXING_TEST_PG_URL） */
  external: boolean;
  close(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function dockerOk(args: string[]): boolean {
  try {
    docker(args);
    return true;
  } catch {
    return false;
  }
}

function guidance(cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    [
      `PG 测试供给失败：${detail}`,
      '处置路径（按 plan §8，三条按成本排序）：',
      '  ① 设置 XUXING_TEST_PG_URL 指向一个可用的 PostgreSQL 16（外部兜底，成本≈0）：',
      `       XUXING_TEST_PG_URL=postgres://user:pass@host:5432/db npm test`,
      '  ② 复用现有容器并加端口映射 127.0.0.1:55432→5432（需重启该容器，成本中，可能影响其它服务）',
      '  ③ 无 sudo 不装系统包 —— 不列为可行路径',
      '本批 C2/C5 必须真 PG 证据：不允许用内存 mock 或 skip 顶替。',
    ].join('\n'),
  );
}

/** 确保容器存在并运行；已设置 XUXING_TEST_PG_URL 时直接返回 external=true。 */
export function ensurePgContainer(connectionString: string): { external: boolean } {
  if (process.env.XUXING_TEST_PG_URL) return { external: true };

  try {
    // inspect 成功说明容器已存在（running 或 stopped）
    docker(['inspect', PG_CONTAINER]);
    const running = docker([
      'inspect', '-f', '{{.State.Running}}', PG_CONTAINER,
    ]).trim() === 'true';
    if (!running) docker(['start', PG_CONTAINER]);
  } catch (inspectError) {
    try {
      docker([
        'run', '-d',
        '--name', PG_CONTAINER,
        '-e', 'POSTGRES_PASSWORD=postgres',
        '-e', 'POSTGRES_DB=xuxing_test',
        '-p', '127.0.0.1:55432:5432',
        '--tmpfs', '/var/lib/postgresql/data:rw,size=512m',
        'postgres:16-alpine',
      ]);
    } catch (runError) {
      throw guidance(runError);
    }
    // inspect 失败且 run 成功 = 首次创建；无需处理 inspectError
    void inspectError;
  }

  void connectionString;
  return { external: false };
}

async function waitReady(connectionString: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 2_000 });
    try {
      await client.connect();
      await client.query('select 1');
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await sleep(READY_POLL_MS);
    }
  }
  throw guidance(lastError ?? new Error('pg_isready 轮询超时'));
}

function buildPoolConfig(connectionString: string, schema: string) {
  return {
    connectionString,
    options: `-c search_path=${schema}`,
    max: 8,
  };
}

/** 建立一个独立 schema 的测试上下文；调用方必须在 afterAll 调 close()。 */
export async function createTestPg(): Promise<TestPg> {
  const connectionString = process.env.XUXING_TEST_PG_URL ?? DEFAULT_PG_URL;
  const { external } = ensurePgContainer(connectionString);
  await waitReady(connectionString);

  const schema = `xs_test_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const admin = new Pool({ connectionString, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } catch (error) {
    await admin.end().catch(() => undefined);
    throw guidance(error);
  }

  const pool = new Pool(buildPoolConfig(connectionString, schema));

  return {
    pool,
    schema,
    connectionString,
    external,
    async close() {
      await pool.end().catch(() => undefined);
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    },
  };
}

/** 清空事件表（append-only 触发器拦 UPDATE/DELETE，TRUNCATE 留给测试清理）。 */
export async function resetEventTables(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE events, event_streams RESTART IDENTITY');
}

/** 断言底层确实是 PostgreSQL 16（防「跑到了 mock/别的库」）。 */
export async function assertPostgres16(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ version: string }>('select version()');
  const version = rows[0].version;
  if (!version.startsWith('PostgreSQL 16')) {
    throw new Error(`期望 PostgreSQL 16，实际：${version}`);
  }
  return version;
}
