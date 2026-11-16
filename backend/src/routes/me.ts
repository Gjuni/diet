import { Router } from 'express';
import { z } from 'zod';
import { pool, queryOne, withTransaction } from '../db.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { clearRefreshCookie } from '../lib/http.js';
import { macroTargetGrams } from '../lib/nutrition.js';
import { ageOn, clock, todayKst } from '../lib/time.js';
import { dateString, decimal1, parse } from '../lib/validate.js';
import { getAuth, requireAuth } from '../middleware/auth.js';
import { deleteAccount } from '../services/authService.js';
import {
  computeMetrics,
  getLatestWeight,
  getProfile,
  ratioOf,
  serializeProfile,
  upsertProfile,
} from '../services/profileService.js';

export const meRouter = Router();
meRouter.use(requireAuth);

const macroRatio = z
  .object({
    carbs: z.number().int().min(5).max(80),
    protein: z.number().int().min(5).max(80),
    fat: z.number().int().min(5).max(80),
  })
  .refine((r) => r.carbs + r.protein + r.fat === 100, { message: '탄수화물·단백질·지방 비율의 합은 100이어야 합니다.' });

const profileSchema = z.object({
  sex: z.enum(['male', 'female'], { message: '성별을 선택해 주세요.' }),
  birth_date: dateString,
  height_cm: decimal1(100, 250, '키'),
  start_weight_kg: decimal1(20, 300, '시작 체중'),
  goal_weight_kg: decimal1(20, 300, '목표 체중'),
  activity_level: z.enum(['sedentary', 'light', 'moderate', 'active', 'very_active'], {
    message: '활동 수준을 선택해 주세요.',
  }),
  goal_type: z.enum(['lose', 'maintain', 'gain'], { message: '목표를 선택해 주세요.' }),
  macro_ratio: macroRatio.optional(),
  recalculate_target: z.boolean().optional(),
});

const deleteSchema = z.object({ password: z.string({ message: '비밀번호를 입력해 주세요.' }).min(1).max(128) });

export async function buildMe(userId: string) {
  const today = todayKst(clock.now());
  const user = await queryOne<{ id: string; email: string; nickname: string; created_at: Date }>(
    pool,
    `SELECT id, email, nickname, created_at FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  if (!user) throw unauthorized();
  const profile = await getProfile(pool, userId);
  if (!profile) return { user, profile: null, metrics: null, today };
  const latest = await getLatestWeight(pool, userId, today);
  return {
    user,
    profile: serializeProfile(profile),
    metrics: computeMetrics(profile, latest, today),
    today,
  };
}

meRouter.get('/', async (req, res) => {
  res.json(await buildMe(getAuth(req).userId));
});

meRouter.put('/profile', async (req, res) => {
  const { userId } = getAuth(req);
  const body = parse(profileSchema, req.body);
  const today = todayKst(clock.now());
  const age = ageOn(body.birth_date, today);
  if (body.birth_date > today || age < 10 || age > 120) {
    throw badRequest('생년월일을 확인해 주세요 (만 10세 ~ 120세).', 'VALIDATION_ERROR', { field: 'birth_date' });
  }
  await withTransaction((db) =>
    upsertProfile(db, userId, body, { recalculateTarget: body.recalculate_target === true, today }),
  );
  res.json(await buildMe(userId));
});

/** 목표 탄단지 비율만 수정 */
meRouter.put('/macro-ratio', async (req, res) => {
  const { userId } = getAuth(req);
  const ratio = parse(macroRatio, req.body);
  const row = await queryOne<{ target_kcal: number; target_carbs_pct: number; target_protein_pct: number; target_fat_pct: number }>(
    pool,
    `UPDATE user_profiles SET target_carbs_pct = $2, target_protein_pct = $3, target_fat_pct = $4
      WHERE user_id = $1 RETURNING target_kcal, target_carbs_pct, target_protein_pct, target_fat_pct`,
    [userId, ratio.carbs, ratio.protein, ratio.fat],
  );
  if (!row) throw badRequest('먼저 프로필을 입력해 주세요.', 'PROFILE_REQUIRED');
  res.json({ macro_ratio: ratioOf(row), target_macros_g: macroTargetGrams(row.target_kcal, ratioOf(row)) });
});

/** 회원 탈퇴 (데이터 삭제) */
meRouter.delete('/', async (req, res) => {
  const { userId } = getAuth(req);
  const body = parse(deleteSchema, req.body);
  await deleteAccount(userId, body.password);
  clearRefreshCookie(res);
  res.status(204).end();
});
