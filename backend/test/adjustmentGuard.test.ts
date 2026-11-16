import { describe, expect, it } from 'vitest';
import { applyAdjustmentGuards, guardNotesText, type GuardInput } from '../src/services/adjustmentGuard.js';
import { validateWeeklyResponse } from '../src/services/weeklyAdjustment.js';

const RATIO = { carbs: 40, protein: 30, fat: 30 };
const base = (over: Partial<GuardInput>): GuardInput => ({
  prevTargetKcal: 2000,
  aiAdjustmentKcal: 0,
  sex: 'male',
  bmr: 1700,
  missingDaysLastWeek: 0,
  prevMacroRatio: RATIO,
  ...over,
});

describe('칼로리 조정 안전장치: 1회 조정 폭 ±250kcal', () => {
  it('범위 안이면 그대로', () => {
    const r = applyAdjustmentGuards(base({ aiAdjustmentKcal: -150 }));
    expect(r).toMatchObject({ adjustmentKcal: -150, newTargetKcal: 1850, notes: [] });
  });

  it('-400 → -250, +300 → +250 로 자른다', () => {
    expect(applyAdjustmentGuards(base({ aiAdjustmentKcal: -400 }))).toMatchObject({
      adjustmentKcal: -250,
      newTargetKcal: 1750,
      notes: ['clamped_max_step'],
    });
    expect(applyAdjustmentGuards(base({ aiAdjustmentKcal: 300 }))).toMatchObject({
      adjustmentKcal: 250,
      newTargetKcal: 2250,
      notes: ['clamped_max_step'],
    });
  });

  it('정확히 ±250 은 허용, 소수는 반올림', () => {
    expect(applyAdjustmentGuards(base({ aiAdjustmentKcal: -250 })).adjustmentKcal).toBe(-250);
    expect(applyAdjustmentGuards(base({ aiAdjustmentKcal: 99.6 })).adjustmentKcal).toBe(100);
  });
});

describe('칼로리 조정 안전장치: 최소 목표 칼로리', () => {
  it('여성은 1,200kcal 아래로 내려가지 않는다', () => {
    const r = applyAdjustmentGuards(base({ sex: 'female', bmr: 1150, prevTargetKcal: 1300, aiAdjustmentKcal: -250 }));
    expect(r).toMatchObject({ newTargetKcal: 1200, adjustmentKcal: -100, minTargetKcal: 1200 });
    expect(r.notes).toContain('raised_to_minimum');
  });

  it('남성은 1,500kcal 아래로 내려가지 않는다', () => {
    const r = applyAdjustmentGuards(base({ sex: 'male', bmr: 1400, prevTargetKcal: 1600, aiAdjustmentKcal: -200 }));
    expect(r).toMatchObject({ newTargetKcal: 1500, adjustmentKcal: -100 });
  });

  it('BMR 이 성별 최소값보다 크면 BMR 이상 (올림)', () => {
    const r = applyAdjustmentGuards(base({ sex: 'female', bmr: 1350.4, prevTargetKcal: 1500, aiAdjustmentKcal: -250 }));
    expect(r).toMatchObject({ newTargetKcal: 1351, adjustmentKcal: -149, minTargetKcal: 1351 });
  });

  it('최소값이 조정 폭 제한보다 우선한다 (현재 목표가 최소값보다 낮던 경우)', () => {
    const r = applyAdjustmentGuards(base({ sex: 'male', bmr: 1450, prevTargetKcal: 1200, aiAdjustmentKcal: 0 }));
    expect(r).toMatchObject({ newTargetKcal: 1500, adjustmentKcal: 300 });
  });
});

describe('칼로리 조정 안전장치: 기록 누락 / AI 실패', () => {
  it('지난주 기록 누락 3일 이상이면 ±100kcal 이내로 보수적으로', () => {
    const r = applyAdjustmentGuards(base({ missingDaysLastWeek: 3, aiAdjustmentKcal: -200 }));
    expect(r).toMatchObject({ adjustmentKcal: -100, notes: ['low_data_conservative'] });
    const ok = applyAdjustmentGuards(base({ missingDaysLastWeek: 2, aiAdjustmentKcal: -200 }));
    expect(ok.adjustmentKcal).toBe(-200);
  });

  it('AI 호출이 실패하면 조정은 0 (최소값 보정도 하지 않음)', () => {
    const r = applyAdjustmentGuards(base({ aiAdjustmentKcal: null, prevTargetKcal: 1400, bmr: 1450 }));
    expect(r).toEqual({ adjustmentKcal: 0, newTargetKcal: 1400, macroRatio: RATIO, minTargetKcal: 1500, notes: ['ai_failed'] });
  });

  it('AI 의 new_target 이 조정량과 안 맞으면 조정량을 기준으로 하고 기록', () => {
    const r = applyAdjustmentGuards(base({ aiAdjustmentKcal: -100, aiNewTargetKcal: 1850 }));
    expect(r.newTargetKcal).toBe(1900);
    expect(r.notes).toContain('ai_target_mismatch');
  });
});

describe('탄단지 비율 검증', () => {
  it('유효하면 반영, 합이 100 이 아니거나 범위를 벗어나면 기존 비율 유지', () => {
    expect(applyAdjustmentGuards(base({ aiMacroRatio: { carbs: 35, protein: 35, fat: 30 } })).macroRatio).toEqual({
      carbs: 35,
      protein: 35,
      fat: 30,
    });
    const bad = applyAdjustmentGuards(base({ aiMacroRatio: { carbs: 80, protein: 10, fat: 10 } }));
    expect(bad.macroRatio).toEqual(RATIO);
    expect(bad.notes).toContain('macro_ratio_kept');
    expect(applyAdjustmentGuards(base({ aiMacroRatio: { carbs: 40, protein: 30, fat: 31 } })).macroRatio).toEqual(RATIO);
  });
});

describe('안내 문구 / AI 응답 스키마', () => {
  it('안전장치 설명', () => {
    expect(guardNotesText(['clamped_max_step', 'raised_to_minimum'], 1200)).toEqual([
      '한 번에 바꿀 수 있는 폭(±250kcal)으로 조정했어요.',
      '건강을 위해 최소 목표(1,200kcal) 아래로는 내리지 않아요.',
    ]);
  });

  it('주간 조정 응답 검증', () => {
    expect(
      validateWeeklyResponse({
        adjustment_kcal: -150,
        new_target_kcal: 1850,
        macro_ratio: RATIO,
        reason: '지난주 평균 0.3% 감소로 목표보다 느렸어요.',
        confidence: 'medium',
      }),
    ).not.toBeNull();
    expect(validateWeeklyResponse({ adjustment_kcal: 'a' })).toBeNull();
    expect(validateWeeklyResponse({ adjustment_kcal: 0, new_target_kcal: 2000, macro_ratio: RATIO, reason: '', confidence: 'low' })).toBeNull();
  });
});
