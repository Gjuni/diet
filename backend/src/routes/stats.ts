import { Router } from 'express';
import { pool, query, queryOne } from '../db.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { macroKcalRatio, round1 } from '../lib/nutrition.js';
import { addDays, clock, isValidDateString, todayKst, weekStartOf } from '../lib/time.js';
import { getAuth, requireAuth } from '../middleware/auth.js';
import { getLatestWeight, getProfile, ratioOf } from '../services/profileService.js';
import { movingAverage7, trendKgPerWeek, type WeightPoint } from '../services/statsCalc.js';

export const statsRouter = Router();
statsRouter.use(requireAuth);

const WEIGHT_RANGES: Record<string, number | null> = { '1w': 7, '1m': 30, '3m': 90, all: null };
const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

/**
 * GET /api/stats/weight?range=1w|1m|3m|all
 * 체중 꺾은선 + 7일 이동평균 + 목표 체중 + 시작 대비 변화 + 최근 4주 추세(주당 kg)
 */
statsRouter.get('/weight', async (req, res) => {
  const { userId } = getAuth(req);
  const range = typeof req.query.range === 'string' ? req.query.range : '1m';
  if (!(range in WEIGHT_RANGES)) throw badRequest('range 는 1w, 1m, 3m, all 중 하나입니다.');
  const today = todayKst(clock.now());
  const days = WEIGHT_RANGES[range]!;
  const from = days === null ? null : addDays(today, -(days - 1));

  // 이동평균 계산을 위해 구간 시작 6일 전부터 조회
  const rows = await query<WeightPoint>(
    pool,
    `SELECT local_date AS date, weight_kg FROM daily_logs
      WHERE user_id = $1 AND weight_kg IS NOT NULL AND local_date <= $2
        AND ($3::date IS NULL OR local_date >= $3::date)
      ORDER BY local_date`,
    [userId, today, from ? addDays(from, -6) : null],
  );
  const points = movingAverage7(rows).filter((p) => from === null || p.date >= from);

  const last4w = await query<WeightPoint>(
    pool,
    `SELECT local_date AS date, weight_kg FROM daily_logs
      WHERE user_id = $1 AND weight_kg IS NOT NULL AND local_date BETWEEN $2 AND $3
      ORDER BY local_date`,
    [userId, addDays(today, -27), today],
  );

  const profile = await getProfile(pool, userId);
  const latest = await getLatestWeight(pool, userId, today);
  res.json({
    range,
    from: from ?? points[0]?.date ?? today,
    to: today,
    points,
    start_weight_kg: profile?.start_weight_kg ?? null,
    goal_weight_kg: profile?.goal_weight_kg ?? null,
    latest_weight_kg: latest,
    change_from_start_kg: profile && latest !== null ? round1(latest - profile.start_weight_kg) : null,
    trend_kg_per_week: trendKgPerWeek(last4w),
    trend_sample_size: last4w.length,
  });
});

/**
 * GET /api/stats/weekly-calories?week_start=YYYY-MM-DD
 * 주 = KST 월요일 00:00 ~ 일요일 23:59. 요일별 섭취 kcal + 목표선 + 주간 합계/일평균
 */
statsRouter.get('/weekly-calories', async (req, res) => {
  const { userId } = getAuth(req);
  const today = todayKst(clock.now());
  const q = req.query.week_start;
  if (q !== undefined && !isValidDateString(q)) throw badRequest('week_start 형식이 올바르지 않습니다 (YYYY-MM-DD).');
  const weekStart = weekStartOf(typeof q === 'string' ? q : today);
  if (weekStart > weekStartOf(today)) throw forbidden('미래 주는 조회할 수 없습니다.', 'FUTURE_DATE');
  const weekEnd = addDays(weekStart, 6);

  const rows = await query<{ local_date: string; kcal: number; items_missing_grams: number }>(
    pool,
    `SELECT local_date, kcal, items_missing_grams FROM v_daily_nutrition
      WHERE user_id = $1 AND local_date BETWEEN $2 AND $3`,
    [userId, weekStart, weekEnd],
  );
  const byDate = new Map(rows.map((r) => [r.local_date, r]));
  const profile = await getProfile(pool, userId);

  const days = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(weekStart, i);
    const r = byDate.get(date);
    return {
      date,
      weekday: WEEKDAY_KO[(i + 1) % 7],
      kcal: r ? r.kcal : 0,
      has_record: Boolean(r),
      items_missing_grams: r?.items_missing_grams ?? 0,
      is_future: date > today,
    };
  });
  const recorded = days.filter((d) => d.has_record);
  const total = round1(recorded.reduce((a, d) => a + d.kcal, 0));
  res.json({
    week_start: weekStart,
    week_end: weekEnd,
    today,
    target_kcal: profile?.target_kcal ?? null,
    days,
    total_kcal: total,
    recorded_days: recorded.length,
    /** 기록한 날 기준 일평균 */
    avg_kcal: recorded.length ? round1(total / recorded.length) : 0,
  });
});

/**
 * GET /api/stats/macro-ratio?range=week|1m|3m
 * 실제 탄단지 비율(kcal 기준)과 목표 비율
 */
statsRouter.get('/macro-ratio', async (req, res) => {
  const { userId } = getAuth(req);
  const today = todayKst(clock.now());
  const range = typeof req.query.range === 'string' ? req.query.range : 'week';
  let from: string;
  if (range === 'week') from = weekStartOf(today);
  else if (range === '1m') from = addDays(today, -29);
  else if (range === '3m') from = addDays(today, -89);
  else throw badRequest('range 는 week, 1m, 3m 중 하나입니다.');

  const sums = await queryOne<{
    carbs_g: number;
    protein_g: number;
    fat_g: number;
    kcal: number;
    items_missing_grams: number;
    days: number;
  }>(
    pool,
    `SELECT coalesce(sum(carbs_g), 0) AS carbs_g, coalesce(sum(protein_g), 0) AS protein_g,
            coalesce(sum(fat_g), 0) AS fat_g, coalesce(sum(kcal), 0) AS kcal,
            coalesce(sum(items_missing_grams), 0) AS items_missing_grams, count(*) AS days
       FROM v_daily_nutrition WHERE user_id = $1 AND local_date BETWEEN $2 AND $3`,
    [userId, from, today],
  );
  const profile = await getProfile(pool, userId);
  const totals = {
    carbs_g: round1(sums?.carbs_g ?? 0),
    protein_g: round1(sums?.protein_g ?? 0),
    fat_g: round1(sums?.fat_g ?? 0),
    kcal: round1(sums?.kcal ?? 0),
  };
  res.json({
    range,
    from,
    to: today,
    recorded_days: sums?.days ?? 0,
    items_missing_grams: sums?.items_missing_grams ?? 0,
    totals,
    actual_ratio: macroKcalRatio(totals),
    target_ratio: profile ? ratioOf(profile) : null,
  });
});
