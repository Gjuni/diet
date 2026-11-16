/**
 * 주간 칼로리 조정 배치를 1회 실행한다 (외부 cron / Kubernetes CronJob 용).
 *   개발:  npm run job:weekly             (미룰 수 있는 사용자는 미룸)
 *          npm run job:weekly -- --final  (마지막 실행: 실패하면 조정 0 으로 기록)
 *   운영:  npm run job:weekly:prod [-- --final]
 * 실행 시점의 KST 날짜가 속한 주(월요일)를 대상으로, 그 직전 4주 데이터를 사용한다.
 * 같은 주에 여러 번 실행해도 UNIQUE(user_id, week_start) 로 사용자당 1회만 반영된다.
 */
import { pool } from '../db.js';
import { runWeeklyAdjustments } from '../services/weeklyAdjustment.js';

try {
  const summary = await runWeeklyAdjustments({ finalAttempt: process.argv.includes('--final') });
  console.info(JSON.stringify(summary));
  if (!summary.locked) console.warn('다른 프로세스가 이미 배치를 실행 중입니다.');
  process.exitCode = summary.errors > 0 ? 1 : 0;
} catch (err) {
  console.error('[weekly] 실패:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
