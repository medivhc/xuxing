// 测试支撑：复用仓库既有 PG 口径（docker 容器 xuxing-pg-test / XUXING_TEST_PG_URL 外部兜底）。
// 直接复用 tests/support/pg.ts，不改内核测试支撑：每个 suite 独立 schema，afterAll 清理。
// 纪律与内核一致：docker 不可用一律大声失败，绝不 skip / mock。
export {
  createTestPg,
  resetEventTables,
  assertPostgres16,
  ensurePgContainer,
  DEFAULT_PG_URL,
  PG_CONTAINER,
  type TestPg,
} from '../../../tests/support/pg.ts';
