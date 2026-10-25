// 种子脚本 CLI：生成（或补齐）演示项目。幂等，可重复执行。
//   XUXING_PG_URL=postgres://... npm run seed:demo
// 只走事件（不直写投影表）；输出只打印项目 id 与投影水位，不打印任何凭据。

import { Pool } from 'pg';
import { createPgEventStore, migrate } from '../../../src/kernel/event-store-pg.ts';
import { createProjectionService } from '../projection/service.ts';
import { DEFAULT_ACTOR_ID, DEFAULT_PG_URL, seedDemo } from './demo.ts';

const connectionString = process.env.XUXING_PG_URL ?? DEFAULT_PG_URL;
const pool = new Pool({ connectionString, max: 4 });
try {
  await migrate(pool);
  const store = createPgEventStore(pool);
  const projection = createProjectionService(pool, store);
  await projection.rebuild();
  const result = await seedDemo({ store, projection });
  console.log(JSON.stringify({ event: 'seeded', ...result, actor: DEFAULT_ACTOR_ID }));
} finally {
  await pool.end();
}
