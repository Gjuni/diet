import cron from 'node-cron';
import { pool } from '../db.js';
import { KST_TIMEZONE } from '../lib/time.js';
import { runWeeklyAdjustments } from '../services/weeklyAdjustment.js';

/**
 * 내장 스케줄러 (ENABLE_SCHEDULER=true)
 *  - 매주 월요일 00:05 KST: 주간 칼로리 조정 (본 실행)
 *  - 월요일 01:05 ~ 22:05 KST 매시: 키 소진/혼잡으로 미뤄진 사용자 재시도
 *    (무료 티어 일일 쿼터는 태평양시 자정 = 한국시간 16:00~17:00 에 리셋되므로 그 이후 재시도로 처리된다)
 *  - 월요일 23:05 KST: 마지막 실행 — 그래도 실패하면 조정 0 으로 기록
 *  - 매일 04:00 KST: 만료 토큰 / 오래된 분석 작업 기록 정리
 * 서버를 여러 대 띄워도 advisory lock + UNIQUE(user_id, week_start) 로 사용자당 1회만 반영된다.
 * 외부 cron 을 쓰려면 ENABLE_SCHEDULER=false 로 끄고 `npm run job:weekly:prod` 를 호출한다 (README).
 */
export function startScheduler() {
  const weekly = (finalAttempt: boolean) => () => {
    runWeeklyAdjustments({ finalAttempt }).catch((err: Error) => console.error('[weekly] 배치 실패:', err.message));
  };
  cron.schedule('5 0 * * 1', weekly(false), { timezone: KST_TIMEZONE, name: 'weekly-adjustment' });
  cron.schedule('5 1-22 * * 1', weekly(false), { timezone: KST_TIMEZONE, name: 'weekly-adjustment-retry' });
  cron.schedule('5 23 * * 1', weekly(true), { timezone: KST_TIMEZONE, name: 'weekly-adjustment-final' });

  cron.schedule(
    '0 4 * * *',
    () => {
      cleanup().catch((err: Error) => console.error('[cleanup] 실패:', err.message));
    },
    { timezone: KST_TIMEZONE, name: 'daily-cleanup' },
  );
  console.info('[scheduler] 주간 조정(월 00:05 KST + 재시도), 일일 정리(04:00 KST) 등록');
}

export async function cleanup() {
  const tokens = await pool.query(`DELETE FROM refresh_tokens WHERE expires_at < now() - interval '7 days'`);
  const resets = await pool.query(`DELETE FROM password_resets WHERE created_at < now() - interval '30 days'`);
  // 분석 작업 기록(결과 JSON)은 30일 보관. 식사에 연결된 결과는 meal_items.ai_raw 에도 남아 있다.
  const jobs = await pool.query(
    `DELETE FROM food_analysis_jobs WHERE created_at < now() - interval '30 days' AND status NOT IN ('queued', 'processing')`,
  );
  const keyUsage = await pool.query(`DELETE FROM gemini_key_usage WHERE usage_date < current_date - 90`);
  console.info(
    `[cleanup] refresh_tokens=${tokens.rowCount} password_resets=${resets.rowCount} analysis_jobs=${jobs.rowCount} key_usage=${keyUsage.rowCount}`,
  );
}
