import { Router } from 'express';
import { z } from 'zod';
import { pool, queryOne } from '../db.js';
import { macroTargetGrams } from '../lib/nutrition.js';
import { clock, todayKst } from '../lib/time.js';
import { decimal1, parse, parseDateParam } from '../lib/validate.js';
import { getAuth, requireAuth } from '../middleware/auth.js';
import { dayTotals, loadMealsForDate } from '../services/mealService.js';
import { getProfile, ratioOf } from '../services/profileService.js';

export const daysRouter = Router();
daysRouter.use(requireAuth);

const exerciseSchema = z.object({ exercised: z.boolean({ message: 'exercised 는 true/false 여야 합니다.' }) });
const weightSchema = z.object({
  // null 이면 그날 체중 기록 삭제
  weight_kg: decimal1(20, 300, '체중').nullable(),
});

/**
 * GET /api/days/:date — 일별 상세. 미래 날짜는 접근 불가(403).
 */
daysRouter.get('/:date', async (req, res) => {
  const { userId } = getAuth(req);
  const date = parseDateParam(req.params.date, { forbidFuture: true });
  const today = todayKst(clock.now());

  const [log, meals, totals, profile] = await Promise.all([
    queryOne<{ exercised: boolean; weight_kg: number | null }>(
      pool,
      `SELECT exercised, weight_kg FROM daily_logs WHERE user_id = $1 AND local_date = $2`,
      [userId, date],
    ),
    loadMealsForDate(pool, userId, date),
    dayTotals(pool, userId, date),
    getProfile(pool, userId),
  ]);

  const targets = profile
    ? {
        kcal: profile.target_kcal,
        macro_ratio: ratioOf(profile),
        ...macroTargetGrams(profile.target_kcal, ratioOf(profile)),
      }
    : null;

  res.json({
    date,
    today,
    is_today: date === today,
    daily_log: { exercised: log?.exercised ?? false, weight_kg: log?.weight_kg ?? null },
    meals,
    totals,
    targets,
  });
});

/** PUT /api/days/:date/exercise — "오늘 운동했나요?" 토글 */
daysRouter.put('/:date/exercise', async (req, res) => {
  const { userId } = getAuth(req);
  const date = parseDateParam(req.params.date, { forbidFuture: true });
  const body = parse(exerciseSchema, req.body);
  const row = await queryOne<{ exercised: boolean; weight_kg: number | null }>(
    pool,
    `INSERT INTO daily_logs (user_id, local_date, exercised) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, local_date) DO UPDATE SET exercised = EXCLUDED.exercised
     RETURNING exercised, weight_kg`,
    [userId, date, body.exercised],
  );
  res.json({ date, ...row });
});

/** PUT /api/days/:date/weight — 하루 1개 값, 다시 입력하면 덮어쓴다 (20~300kg, 소수 첫째 자리) */
daysRouter.put('/:date/weight', async (req, res) => {
  const { userId } = getAuth(req);
  const date = parseDateParam(req.params.date, { forbidFuture: true });
  const body = parse(weightSchema, req.body);
  const row = await queryOne<{ exercised: boolean; weight_kg: number | null }>(
    pool,
    `INSERT INTO daily_logs (user_id, local_date, weight_kg) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, local_date) DO UPDATE SET weight_kg = EXCLUDED.weight_kg
     RETURNING exercised, weight_kg`,
    [userId, date, body.weight_kg],
  );
  res.json({ date, ...row });
});
