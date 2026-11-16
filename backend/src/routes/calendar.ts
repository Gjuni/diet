import { Router } from 'express';
import { pool, query, queryOne } from '../db.js';
import { badRequest } from '../lib/errors.js';
import { clock, isValidMonthString, monthRange, todayKst } from '../lib/time.js';
import { getAuth, requireAuth } from '../middleware/auth.js';

export const calendarRouter = Router();
calendarRouter.use(requireAuth);

interface NutritionRow {
  local_date: string;
  kcal: number;
  meal_count: number;
  items_missing_grams: number;
}
interface LogRow {
  local_date: string;
  exercised: boolean;
  weight_kg: number | null;
}

/**
 * GET /api/calendar?month=YYYY-MM
 * 날짜별 kcal / 운동 여부 / 기록 여부 + 월 운동 횟수. "오늘"은 서버 KST 기준.
 */
calendarRouter.get('/', async (req, res) => {
  const { userId } = getAuth(req);
  const today = todayKst(clock.now());
  const month = typeof req.query.month === 'string' ? req.query.month : today.slice(0, 7);
  if (!isValidMonthString(month)) throw badRequest('month 형식이 올바르지 않습니다 (YYYY-MM).');
  const { start, end } = monthRange(month);

  const [nutrition, logs, exercise, profile] = await Promise.all([
    query<NutritionRow>(
      pool,
      `SELECT local_date, kcal, meal_count, items_missing_grams FROM v_daily_nutrition
        WHERE user_id = $1 AND local_date BETWEEN $2 AND $3`,
      [userId, start, end],
    ),
    query<LogRow>(
      pool,
      `SELECT local_date, exercised, weight_kg FROM daily_logs
        WHERE user_id = $1 AND local_date BETWEEN $2 AND $3`,
      [userId, start, end],
    ),
    queryOne<{ exercise_days: number }>(
      pool,
      `SELECT exercise_days FROM v_monthly_exercise WHERE user_id = $1 AND month = $2`,
      [userId, start],
    ),
    queryOne<{ target_kcal: number }>(pool, `SELECT target_kcal FROM user_profiles WHERE user_id = $1`, [userId]),
  ]);

  const byDate = new Map<
    string,
    { date: string; kcal: number | null; meal_count: number; items_missing_grams: number; exercised: boolean; weight_kg: number | null }
  >();
  const get = (date: string) => {
    let d = byDate.get(date);
    if (!d) {
      d = { date, kcal: null, meal_count: 0, items_missing_grams: 0, exercised: false, weight_kg: null };
      byDate.set(date, d);
    }
    return d;
  };
  for (const n of nutrition) Object.assign(get(n.local_date), { kcal: n.kcal, meal_count: n.meal_count, items_missing_grams: n.items_missing_grams });
  for (const l of logs) Object.assign(get(l.local_date), { exercised: l.exercised, weight_kg: l.weight_kg });

  const days = [...byDate.values()]
    .filter((d) => d.date <= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ ...d, has_record: d.meal_count > 0 || d.weight_kg !== null || d.exercised }));

  res.json({
    month,
    today,
    exercise_count: exercise?.exercise_days ?? 0,
    target_kcal: profile?.target_kcal ?? null,
    days,
  });
});
