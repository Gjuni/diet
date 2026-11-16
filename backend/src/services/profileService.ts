import { queryOne, type Db } from '../db.js';
import {
  bmi,
  bmrMifflin,
  initialTargetKcal,
  macroTargetGrams,
  minTargetKcal,
  round1,
  tdee,
  type ActivityLevel,
  type GoalType,
  type MacroRatio,
  type Sex,
} from '../lib/nutrition.js';
import { ageOn } from '../lib/time.js';

export interface ProfileRow {
  user_id: string;
  sex: Sex;
  birth_date: string;
  height_cm: number;
  start_weight_kg: number;
  goal_weight_kg: number;
  activity_level: ActivityLevel;
  goal_type: GoalType;
  target_kcal: number;
  target_carbs_pct: number;
  target_protein_pct: number;
  target_fat_pct: number;
  created_at: Date;
  updated_at: Date;
}

export interface ProfileInput {
  sex: Sex;
  birth_date: string;
  height_cm: number;
  start_weight_kg: number;
  goal_weight_kg: number;
  activity_level: ActivityLevel;
  goal_type: GoalType;
  macro_ratio?: MacroRatio;
}

export interface Metrics {
  age: number;
  current_weight_kg: number;
  bmi: number;
  bmr: number;
  tdee: number;
  min_target_kcal: number;
}

export async function getProfile(db: Db, userId: string): Promise<ProfileRow | null> {
  return queryOne<ProfileRow>(db, `SELECT * FROM user_profiles WHERE user_id = $1`, [userId]);
}

/** 가장 최근(오늘 이하) 체중 기록 */
export async function getLatestWeight(db: Db, userId: string, today: string): Promise<number | null> {
  const row = await queryOne<{ weight_kg: number }>(
    db,
    `SELECT weight_kg FROM daily_logs
      WHERE user_id = $1 AND local_date <= $2 AND weight_kg IS NOT NULL
      ORDER BY local_date DESC LIMIT 1`,
    [userId, today],
  );
  return row?.weight_kg ?? null;
}

export function ratioOf(p: Pick<ProfileRow, 'target_carbs_pct' | 'target_protein_pct' | 'target_fat_pct'>): MacroRatio {
  return { carbs: p.target_carbs_pct, protein: p.target_protein_pct, fat: p.target_fat_pct };
}

export function computeMetrics(
  p: Pick<ProfileRow, 'sex' | 'birth_date' | 'height_cm' | 'start_weight_kg' | 'activity_level'>,
  currentWeightKg: number | null,
  today: string,
): Metrics {
  const age = ageOn(p.birth_date, today);
  const weight = currentWeightKg ?? p.start_weight_kg;
  const bmr = bmrMifflin({ sex: p.sex, weightKg: weight, heightCm: p.height_cm, age });
  return {
    age,
    current_weight_kg: weight,
    bmi: bmi(weight, p.height_cm),
    bmr: Math.round(bmr),
    tdee: Math.round(tdee(bmr, p.activity_level)),
    min_target_kcal: minTargetKcal(p.sex, bmr),
  };
}

/** 정확한 BMR (반올림 전) – 최소 칼로리 안전장치용 */
export function exactBmr(p: Pick<ProfileRow, 'sex' | 'birth_date' | 'height_cm' | 'start_weight_kg'>, weight: number | null, today: string) {
  return bmrMifflin({
    sex: p.sex,
    weightKg: weight ?? p.start_weight_kg,
    heightCm: p.height_cm,
    age: ageOn(p.birth_date, today),
  });
}

export function serializeProfile(p: ProfileRow) {
  const ratio = ratioOf(p);
  return {
    sex: p.sex,
    birth_date: p.birth_date,
    height_cm: p.height_cm,
    start_weight_kg: p.start_weight_kg,
    goal_weight_kg: p.goal_weight_kg,
    activity_level: p.activity_level,
    goal_type: p.goal_type,
    target_kcal: p.target_kcal,
    macro_ratio: ratio,
    target_macros_g: macroTargetGrams(p.target_kcal, ratio),
    updated_at: p.updated_at,
  };
}

/**
 * 프로필 생성/수정.
 *  - 처음 생성할 때는 항상 Mifflin-St Jeor → TDEE → (감량 -500 / 증량 +300) 로 목표 칼로리를 계산한다.
 *  - 수정할 때는 recalculateTarget 이 true 일 때만 다시 계산한다(주간 AI 조정 결과를 함부로 덮어쓰지 않도록).
 */
export async function upsertProfile(
  db: Db,
  userId: string,
  input: ProfileInput,
  opts: { recalculateTarget: boolean; today: string },
): Promise<ProfileRow> {
  const existing = await queryOne<ProfileRow>(db, `SELECT * FROM user_profiles WHERE user_id = $1 FOR UPDATE`, [userId]);
  const latestWeight = existing ? await getLatestWeight(db, userId, opts.today) : null;
  const ratio = input.macro_ratio ?? (existing ? ratioOf(existing) : { carbs: 40, protein: 30, fat: 30 });

  let targetKcal = existing?.target_kcal;
  if (!existing || opts.recalculateTarget) {
    const bmrExact = exactBmr(input, latestWeight, opts.today);
    targetKcal = initialTargetKcal({
      sex: input.sex,
      bmr: bmrExact,
      tdee: tdee(bmrExact, input.activity_level),
      goal: input.goal_type,
    });
  }

  const row = await queryOne<ProfileRow>(
    db,
    `INSERT INTO user_profiles (user_id, sex, birth_date, height_cm, start_weight_kg, goal_weight_kg,
                                activity_level, goal_type, target_kcal,
                                target_carbs_pct, target_protein_pct, target_fat_pct)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (user_id) DO UPDATE SET
       sex = EXCLUDED.sex, birth_date = EXCLUDED.birth_date, height_cm = EXCLUDED.height_cm,
       start_weight_kg = EXCLUDED.start_weight_kg, goal_weight_kg = EXCLUDED.goal_weight_kg,
       activity_level = EXCLUDED.activity_level, goal_type = EXCLUDED.goal_type,
       target_kcal = EXCLUDED.target_kcal,
       target_carbs_pct = EXCLUDED.target_carbs_pct, target_protein_pct = EXCLUDED.target_protein_pct,
       target_fat_pct = EXCLUDED.target_fat_pct
     RETURNING *`,
    [
      userId,
      input.sex,
      input.birth_date,
      round1(input.height_cm),
      round1(input.start_weight_kg),
      round1(input.goal_weight_kg),
      input.activity_level,
      input.goal_type,
      targetKcal,
      ratio.carbs,
      ratio.protein,
      ratio.fat,
    ],
  );
  return row!;
}
