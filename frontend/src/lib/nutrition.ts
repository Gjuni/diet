/**
 * 영양 계산 (백엔드 src/lib/nutrition.ts 와 같은 규칙 — 화면 미리보기용)
 *  - 섭취 매크로 = g / 100 × 100g당 값, 소수 첫째 자리 반올림 (DB GENERATED 컬럼과 동일한 정수 연산)
 *  - kcal = 탄수화물 g × 4 + 단백질 g × 4 + 지방 g × 9
 */
import type { Per100g } from '../api/types';

const tenths = (x: number) => Math.round((x + (x >= 0 ? Number.EPSILON : -Number.EPSILON)) * 10);
const macroTenths = (grams: number, per100: number) => Math.floor((tenths(grams) * tenths(per100) + 500) / 1000);

export interface Macros {
  carbs_g: number;
  protein_g: number;
  fat_g: number;
  kcal: number;
}

export function itemNutrition(grams: number | null, per100: Per100g): Macros | null {
  if (grams === null || !Number.isFinite(grams) || grams <= 0) return null;
  const c = macroTenths(grams, per100.carbs);
  const p = macroTenths(grams, per100.protein);
  const f = macroTenths(grams, per100.fat);
  return { carbs_g: c / 10, protein_g: p / 10, fat_g: f / 10, kcal: (c * 4 + p * 4 + f * 9) / 10 };
}

export function round1(x: number): number {
  return Math.round((x + Number.EPSILON) * 10) / 10;
}

/** 섭취량 기준 입력(총 g) → 100g당 값 */
export function per100FromTotal(totalG: number, grams: number): number {
  if (!grams) return 0;
  return round1((totalG * 100) / grams);
}

export function per100Valid(v: Per100g): boolean {
  const vals = [v.carbs, v.protein, v.fat];
  return vals.every((x) => Number.isFinite(x) && x >= 0) && tenths(v.carbs) + tenths(v.protein) + tenths(v.fat) <= 1000;
}

export function pct(value: number, target: number): number {
  if (!target) return 0;
  return Math.round((value / target) * 100);
}
