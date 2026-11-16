import { describe, expect, it } from 'vitest';
import {
  bmi,
  bmrMifflin,
  initialTargetKcal,
  isValidPer100,
  itemNutrition,
  kcalFromMacros,
  macroGrams,
  macroKcalRatio,
  macroTargetGrams,
  minTargetKcal,
  normalizePer100,
  sumItems,
  tdee,
} from '../src/lib/nutrition.js';

const JEYUK = { carbs: 8.5, protein: 14.2, fat: 9.8 };

describe('g 변경에 따른 섭취 매크로 / kcal 재계산', () => {
  it('섭취 g / 100 × 100g당 값, kcal = C×4 + P×4 + F×9', () => {
    // DB GENERATED 컬럼 결과와 동일해야 한다 (PostgreSQL 에서 확인한 값)
    expect(itemNutrition(250, JEYUK)).toEqual({ carbs_g: 21.3, protein_g: 35.5, fat_g: 24.5, kcal: 447.7 });
  });

  it('g 을 바꾸면 즉시 다시 계산된다', () => {
    const before = itemNutrition(250, JEYUK)!;
    const after = itemNutrition(300, JEYUK)!;
    expect(after).toEqual({ carbs_g: 25.5, protein_g: 42.6, fat_g: 29.4, kcal: 537 });
    expect(after.kcal).toBeGreaterThan(before.kcal);
    expect(itemNutrition(125, JEYUK)).toEqual({ carbs_g: 10.6, protein_g: 17.8, fat_g: 12.3, kcal: 224.3 });
  });

  it('g 이 null 이면 섭취량도 null', () => {
    expect(itemNutrition(null, JEYUK)).toBeNull();
    expect(macroGrams(null, 10)).toBeNull();
  });

  it('반올림은 PostgreSQL round() 와 같다 (부동소수점 오차 없음)', () => {
    // 9.2g × 87.5 / 100 = 8.05 → 8.1  (부동소수점으로는 8.049999… 이라 단순 반올림하면 8.0 이 되어 DB 와 어긋난다)
    expect(Math.round(((9.2 * 87.5) / 100) * 10) / 10).toBe(8);
    expect(macroGrams(9.2, 87.5)).toBe(8.1);
    expect(macroGrams(2.8, 87.5)).toBe(2.5);
    expect(macroGrams(50, 0.9)).toBe(0.5); // 0.45 → 0.5
    expect(macroGrams(250, 8.5)).toBe(21.3); // 21.25 → 21.3
    expect(kcalFromMacros(0.1, 0.2, 0.3)).toBe(3.9);
  });

  it('일일 합계는 g 미입력 항목을 빼고, 빠진 개수를 알려준다', () => {
    const totals = sumItems([
      { grams: 250, per100: JEYUK },
      { grams: null, per100: { carbs: 31.7, protein: 2.7, fat: 0.3 } },
      { grams: 100, per100: { carbs: 5, protein: 1, fat: 0 } },
    ]);
    expect(totals).toEqual({
      carbs_g: 26.3,
      protein_g: 36.5,
      fat_g: 24.5,
      kcal: 471.7, // 26.3×4 + 36.5×4 + 24.5×9
      items_missing_grams: 1,
      item_count: 3,
    });
  });

  it('나중에 g 을 입력하면 합계에 포함된다', () => {
    const items = [
      { grams: 250 as number | null, per100: JEYUK },
      { grams: null as number | null, per100: { carbs: 31.7, protein: 2.7, fat: 0.3 } },
    ];
    const before = sumItems(items);
    items[1]!.grams = 210;
    const after = sumItems(items);
    expect(before.items_missing_grams).toBe(1);
    expect(after.items_missing_grams).toBe(0);
    expect(after.carbs_g).toBe(87.9); // 21.3 + (210 × 31.7 / 100 = 66.57 → 66.6)
  });
});

describe('100g당 값 검증 / 정규화', () => {
  it('합계 100 초과, 음수는 무효', () => {
    expect(isValidPer100({ carbs: 50, protein: 30, fat: 20 })).toBe(true);
    expect(isValidPer100({ carbs: 50, protein: 30, fat: 20.1 })).toBe(false);
    expect(isValidPer100({ carbs: -1, protein: 30, fat: 20 })).toBe(false);
  });

  it('반올림으로 100.1 이 되면 가장 큰 값에서 보정', () => {
    const n = normalizePer100({ carbs: 33.35, protein: 33.35, fat: 33.3 });
    expect(n.carbs + n.protein + n.fat).toBeLessThanOrEqual(100);
    expect(isValidPer100(n)).toBe(true);
  });
});

describe('BMR / TDEE / 목표 칼로리', () => {
  it('Mifflin-St Jeor', () => {
    expect(bmrMifflin({ sex: 'male', weightKg: 80, heightCm: 180, age: 30 })).toBe(1780);
    expect(bmrMifflin({ sex: 'female', weightKg: 60, heightCm: 165, age: 30 })).toBeCloseTo(1320.25);
    expect(tdee(1780, 'moderate')).toBeCloseTo(2759);
  });

  it('감량 목표는 TDEE - 500, 최소값(여 1200 / 남 1500 / BMR) 보장', () => {
    expect(initialTargetKcal({ sex: 'male', bmr: 1780, tdee: 2759, goal: 'lose' })).toBe(2260);
    expect(initialTargetKcal({ sex: 'male', bmr: 1780, tdee: 2759, goal: 'maintain' })).toBe(2760);
    // 좌식 여성: TDEE 1500 - 500 = 1000 → max(1200, BMR 1250) = 1250
    expect(initialTargetKcal({ sex: 'female', bmr: 1250, tdee: 1500, goal: 'lose' })).toBe(1250);
    expect(minTargetKcal('female', 1100)).toBe(1200);
    expect(minTargetKcal('male', 1600.2)).toBe(1601);
  });

  it('BMI, 목표 g, 실제 비율', () => {
    expect(bmi(70, 175)).toBe(22.9);
    expect(macroTargetGrams(2000, { carbs: 40, protein: 30, fat: 30 })).toEqual({ carbs_g: 200, protein_g: 150, fat_g: 66.7 });
    expect(macroKcalRatio({ carbs_g: 100, protein_g: 50, fat_g: 0 })).toEqual({ carbs: 66.7, protein: 33.3, fat: 0 });
    expect(macroKcalRatio({ carbs_g: 0, protein_g: 0, fat_g: 0 })).toBeNull();
  });
});
