import { describe, expect, it } from 'vitest';
import { addMonths, daysInMonth, kstDate, kstIso, kstTime, mealSlotForHour } from './date';
import { itemNutrition, per100FromTotal, per100Valid } from './nutrition';

describe('영양 계산 (백엔드/DB 와 같은 값)', () => {
  it('g × 100g당 → 매크로/kcal', () => {
    expect(itemNutrition(250, { carbs: 8.5, protein: 14.2, fat: 9.8 })).toEqual({ carbs_g: 21.3, protein_g: 35.5, fat_g: 24.5, kcal: 447.7 });
    expect(itemNutrition(9.2, { carbs: 87.5, protein: 0, fat: 0 })!.carbs_g).toBe(8.1);
    expect(itemNutrition(null, { carbs: 1, protein: 1, fat: 1 })).toBeNull();
  });
  it('먹은 양 기준 입력 → 100g당 환산', () => {
    expect(per100FromTotal(30, 200)).toBe(15);
    expect(per100Valid({ carbs: 50, protein: 30, fat: 20 })).toBe(true);
    expect(per100Valid({ carbs: 50, protein: 30, fat: 21 })).toBe(false);
  });
});

describe('KST 날짜 (기기 시간대와 무관)', () => {
  it('23:59 / 00:00 경계', () => {
    expect(kstDate(Date.parse('2026-11-16T14:59:59Z'))).toBe('2026-11-16');
    expect(kstDate(Date.parse('2026-11-16T15:00:00Z'))).toBe('2026-11-17');
    expect(kstTime(Date.parse('2026-11-16T15:00:00Z'))).toBe('00:00');
    expect(kstIso('2026-11-17', '08:30')).toBe('2026-11-17T08:30:00+09:00');
  });
  it('끼니 자동 지정 / 달 계산', () => {
    expect([4, 5, 10, 15, 21].map(mealSlotForHour)).toEqual(['snack', 'breakfast', 'lunch', 'dinner', 'snack']);
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(daysInMonth('2028-02')).toBe(29);
  });
});
