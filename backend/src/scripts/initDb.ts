/**
 * db/schema.sql 실행 (psql 이 없는 환경용). 여러 번 실행해도 안전하다.
 *   npm run db:init
 */
import fs from 'node:fs';
import path from 'node:path';
import { BACKEND_ROOT } from '../config.js';
import { pool } from '../db.js';

const file = path.join(BACKEND_ROOT, 'db', 'schema.sql');
try {
  await pool.query(fs.readFileSync(file, 'utf8'));
  console.info(`[db:init] 적용 완료: ${file}`);
} catch (err) {
  console.error('[db:init] 실패:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
