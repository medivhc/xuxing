import { describe, expect, it } from 'vitest';
import { createTestPg } from './support/pg.ts';
import { fail, ok } from '../src/api/http.ts';

// 冒烟：server 车道测试可以被拉起，且确实连的是 PostgreSQL 16（不是 mock）。
describe('server 测试基线', () => {
  it('HTTP 信封约定：ok/fail 形状稳定', () => {
    expect(ok({ a: 1 })).toEqual({ ok: true, data: { a: 1 } });
    expect(fail('conflict', '越权', { reason: 'not_in_available_actions' })).toEqual({
      ok: false,
      error: { code: 'conflict', message: '越权', detail: { reason: 'not_in_available_actions' } },
    });
  });

  it('真实 PostgreSQL 16 可用', async () => {
    const ctx = await createTestPg();
    try {
      const { rows } = await ctx.pool.query<{ version: string }>('select version()');
      expect(rows[0].version.startsWith('PostgreSQL 16')).toBe(true);
    } finally {
      await ctx.close();
    }
  });
});
