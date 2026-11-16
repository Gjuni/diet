import { pool, query } from '../db.js';
import type { KeyUsageStore, UsageDelta } from '../services/geminiKeyPool.js';

/** gemini_key_usage 테이블에 키 지문별/쿼터일자별 사용량을 누적한다 (키 원문은 저장하지 않음) */
export function pgKeyUsageStore(): KeyUsageStore {
  return {
    async load(dayKey: string) {
      const rows = await query<{ key_id: string; requests: number; exhausted: boolean }>(
        pool,
        `SELECT key_id, requests, daily_exhausted_at IS NOT NULL AS exhausted
           FROM gemini_key_usage WHERE usage_date = $1`,
        [dayKey],
      );
      return rows.map((r) => ({ keyId: r.key_id, requests: r.requests, exhausted: r.exhausted }));
    },

    record(keyId: string, dayKey: string, d: UsageDelta) {
      // 응답 지연을 만들지 않도록 기다리지 않는다 (실패해도 서비스에는 영향 없음)
      void query(
        pool,
        `INSERT INTO gemini_key_usage
           (key_id, usage_date, requests, successes, rate_limited, failures, tokens_in, tokens_out, daily_exhausted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $9::boolean THEN now() END)
         ON CONFLICT (key_id, usage_date) DO UPDATE SET
           requests     = gemini_key_usage.requests + EXCLUDED.requests,
           successes    = gemini_key_usage.successes + EXCLUDED.successes,
           rate_limited = gemini_key_usage.rate_limited + EXCLUDED.rate_limited,
           failures     = gemini_key_usage.failures + EXCLUDED.failures,
           tokens_in    = gemini_key_usage.tokens_in + EXCLUDED.tokens_in,
           tokens_out   = gemini_key_usage.tokens_out + EXCLUDED.tokens_out,
           daily_exhausted_at = coalesce(gemini_key_usage.daily_exhausted_at, EXCLUDED.daily_exhausted_at)`,
        [
          keyId,
          dayKey,
          d.requests ?? 0,
          d.successes ?? 0,
          d.rateLimited ?? 0,
          d.failures ?? 0,
          d.tokensIn ?? 0,
          d.tokensOut ?? 0,
          d.exhausted === true,
        ],
      ).catch((err: Error) => console.warn('[gemini-pool] 사용량 기록 실패(무시):', err.message));
    },
  };
}
