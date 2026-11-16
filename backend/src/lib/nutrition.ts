/**
 * 영양 계산
 *  - 섭취 매크로(g) = 섭취 g / 100 × 100g당 값  (소수 첫째 자리 반올림)
 *  - kcal = 탄수화물 g × 4 + 단백질 g × 4 + 지방 g × 9  (반올림된 매크로 기준)
 *
 * DB 의 GENERATED 컬럼(meal_items.carbs_g/.../kcal)과 "완전히 같은 값"이 나오도록
 * 부동소수점 대신 0.1 단위 정수 연산으로 계산한다.
 *   g(0.1 단위) = G/10, 100g당(0.1 단위) = P/10  →  섭취량 = G×P / 10000
 *   0.1 단위 반올림 = floor((G×P + 500) / 1000) / 10   (PostgreSQL round() 와 동일: half away from zero, 양수)
 */

export const CATEGORIES = [
  '한식',
  '중식',
  '일식',
  '양식',
  '분식',
  '아시안',
  '패스트푸드',
  '샐러드/건강식',
  '디저트/간식',
  '음료',
  '기타',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const MAX_GRAMS = 5000;

export interface Per100g {
  carbs: number;
  protein: number;
  fat: number;
}

export interface MacroTotals {
  carbs_g: number;
  protein_g: number;
  fat_g: number;
  kcal: number;
}

/** 표시용 소수 첫째 자리 반올림 (부동소수점 오차 보정) */
export function round1(x: number): number {
  return Math.round((x + Number.EPSILON) * 10) / 10;
}

/** 0.1 단위 정수 (입력값 정규화) */
export function toTenths(x: number): number {
  return Math.round((x + (x >= 0 ? Number.EPSILON : -Number.EPSILON)) * 10);
}

/** 섭취 g 과 100g당 값으로 섭취 매크로 g (0.1 단위, 정수 연산) */
function macroTenths(grams: number, per100: number): number {
  const G = toTenths(grams);
  const P = toTenths(per100);
  return Math.floor((G * P + 500) / 1000);
}

/** 섭취 매크로 g. grams 가 null 이면 null */
export function macroGrams(grams: number | null, per100: number): number | null {
  if (grams === null) return null;
  return macroTenths(grams, per100) / 10;
}

/** kcal = C×4 + P×4 + F×9 */
export function kcalFromMacros(carbsG: number, proteinG: number, fatG: number): number {
  return (toTenths(carbsG) * 4 + toTenths(proteinG) * 4 + toTenths(fatG) * 9) / 10;
}

/** 음식 1개의 실제 섭취량. g 미입력이면 모두 null */
export function itemNutrition(grams: number | null, per100: Per100g): MacroTotals | null {
  if (grams === null) return null;
  const c = macroTenths(grams, per100.carbs);
  const p = macroTenths(grams, per100.protein);
  const f = macroTenths(grams, per100.fat);
  return {
    carbs_g: c / 10,
    protein_g: p / 10,
    fat_g: f / 10,
    kcal: (c * 4 + p * 4 + f * 9) / 10,
  };
}

export interface DailyTotals extends MacroTotals {
  /** g 이 없어 합계에서 빠진 항목 수 */
  items_missing_grams: number;
  item_count: number;
}

/** 일일 합계: g 미입력 항목은 빼고, 몇 개가 빠졌는지 함께 돌려준다 */
export function sumItems(items: Array<{ grams: number | null; per100: Per100g }>): DailyTotals {
  let c = 0;
  let p = 0;
  let f = 0;
  let missing = 0;
  for (const it of items) {
    if (it.grams === null) {
      missing += 1;
      continue;
    }
    c += macroTenths(it.grams, it.per100.carbs);
    p += macroTenths(it.grams, it.per100.protein);
    f += macroTenths(it.grams, it.per100.fat);
  }
  return {
    carbs_g: c / 10,
    protein_g: p / 10,
    fat_g: f / 10,
    kcal: (c * 4 + p * 4 + f * 9) / 10,
    items_missing_grams: missing,
    item_count: items.length,
  };
}

/**
 * 100g당 값 정규화: 0.1 단위 반올림, 음수 금지, 합계 ≤ 100 보장
 * (반올림으로 100.1 이 되는 경우 가장 큰 값에서 초과분을 뺀다)
 */
export function normalizePer100(v: Per100g): Per100g {
  const t = {
    carbs: Math.max(0, toTenths(v.carbs)),
    protein: Math.max(0, toTenths(v.protein)),
    fat: Math.max(0, toTenths(v.fat)),
  };
  const excess = t.carbs + t.protein + t.fat - 1000;
  if (excess > 0 && excess <= 3) {
    const key = (Object.keys(t) as Array<keyof Per100g>).reduce((a, b) => (t[a] >= t[b] ? a : b));
    t[key] -= excess;
  }
  return { carbs: t.carbs / 10, protein: t.protein / 10, fat: t.fat / 10 };
}

export function isValidPer100(v: Per100g): boolean {
  const vals = [v.carbs, v.protein, v.fat];
  if (vals.some((x) => !Number.isFinite(x) || x < 0)) return false;
  return toTenths(v.carbs) + toTenths(v.protein) + toTenths(v.fat) <= 1000;
}

// -----------------------------------------------------------------------------
// BMR / TDEE / 목표 칼로리
// -----------------------------------------------------------------------------
export type Sex = 'male' | 'female';
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';
export type GoalType = 'lose' | 'maintain' | 'gain';

export const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

/** 감량 시 TDEE 에서 빼는 기본값 / 증량 시 더하는 기본값 */
export const LOSE_DEFICIT_KCAL = 500;
export const GAIN_SURPLUS_KCAL = 300;

/** Mifflin-St Jeor */
export function bmrMifflin(input: { sex: Sex; weightKg: number; heightCm: number; age: number }): number {
  const base = 10 * input.weightKg + 6.25 * input.heightCm - 5 * input.age;
  return input.sex === 'male' ? base + 5 : base - 161;
}

export function tdee(bmr: number, activity: ActivityLevel): number {
  return bmr * ACTIVITY_FACTORS[activity];
}

/** 최소 목표 칼로리: 여성 1,200 / 남성 1,500 이상, 그리고 BMR 이상 */
export function minTargetKcal(sex: Sex, bmr: number): number {
  return Math.max(sex === 'female' ? 1200 : 1500, Math.ceil(bmr));
}

/** 초기 목표 칼로리 (10kcal 단위 반올림, 최소값 보장) */
export function initialTargetKcal(input: { sex: Sex; bmr: number; tdee: number; goal: GoalType }): number {
  let raw = input.tdee;
  if (input.goal === 'lose') raw -= LOSE_DEFICIT_KCAL;
  if (input.goal === 'gain') raw += GAIN_SURPLUS_KCAL;
  const rounded = Math.round(raw / 10) * 10;
  return Math.min(6000, Math.max(minTargetKcal(input.sex, input.bmr), rounded));
}

export function bmi(weightKg: number, heightCm: number): number {
  const m = heightCm / 100;
  return round1(weightKg / (m * m));
}

export interface MacroRatio {
  carbs: number;
  protein: number;
  fat: number;
}

/** 목표 kcal 과 비율(%)로 목표 g */
export function macroTargetGrams(targetKcal: number, ratio: MacroRatio): { carbs_g: number; protein_g: number; fat_g: number } {
  return {
    carbs_g: round1((targetKcal * ratio.carbs) / 100 / 4),
    protein_g: round1((targetKcal * ratio.protein) / 100 / 4),
    fat_g: round1((targetKcal * ratio.fat) / 100 / 9),
  };
}

/** 실제 섭취 g → kcal 기준 비율(%) */
export function macroKcalRatio(t: { carbs_g: number; protein_g: number; fat_g: number }): MacroRatio | null {
  const c = t.carbs_g * 4;
  const p = t.protein_g * 4;
  const f = t.fat_g * 9;
  const total = c + p + f;
  if (total <= 0) return null;
  return { carbs: round1((c / total) * 100), protein: round1((p / total) * 100), fat: round1((f / total) * 100) };
}

export function isValidMacroRatio(r: unknown, min = 5, max = 80): r is MacroRatio {
  if (!r || typeof r !== 'object') return false;
  const { carbs, protein, fat } = r as Record<string, unknown>;
  const vals = [carbs, protein, fat];
  if (!vals.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max)) return false;
  return (carbs as number) + (protein as number) + (fat as number) === 100;
}
