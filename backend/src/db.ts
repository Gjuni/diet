import pg from 'pg';
import { config } from './config.js';

// numeric / bigint(count) 는 JS number 로, date 는 'YYYY-MM-DD' 문자열 그대로 받는다.
// (date 를 JS Date 로 바꾸면 서버 로컬 타임존에 따라 하루가 밀리는 버그가 생기므로 금지)
const NUMERIC_OID = 1700;
const INT8_OID = 20;
const DATE_OID = 1082;
pg.types.setTypeParser(NUMERIC_OID, (v: string) => Number(v));
pg.types.setTypeParser(INT8_OID, (v: string) => Number(v));
pg.types.setTypeParser(DATE_OID, (v: string) => v);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.pgPoolMax,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

export type Db = pg.Pool | pg.PoolClient;
export type Row = pg.QueryResultRow;

export async function query<T extends Row = Row>(db: Db, text: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query<T>(text, params as unknown[]);
  return res.rows;
}

export async function queryOne<T extends Row = Row>(db: Db, text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(db, text, params);
  return rows[0] ?? null;
}

/** 트랜잭션 헬퍼. fn 이 throw 하면 ROLLBACK, 아니면 COMMIT. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    throw err;
  } finally {
    client.release();
  }
}
