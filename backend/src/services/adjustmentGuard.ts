import { isValidMacroRatio, minTargetKcal, type MacroRatio, type Sex } from '../lib/nutrition.js';

/**
 * 주간 칼로리 조정 서버 안전장치 (AI 결과보다 항상 우선 적용)
 *  1) 기록 누락 3일 이상 → 데이터 신뢰도 낮음: 조정 폭을 ±100kcal 로 더 보수적으로 제한
 *  2) 1회 조정 폭은 ±250kcal 이내로 자른다
 *  3) 최소 목표 칼로리: 여성 1,200 / 남성 1,500 이상, 그리고 BMR 이상 (최소값이 조정 폭 제한보다 우선)
 *  4) AI 호출 실패 → 이번 주 조정은 0
 *  5) 탄단지 비율은 정수, 각 10~70%, 합 100 일 때만 반영. 아니면 기존 비율 유지
 */
export const MAX_WEEKLY_STEP_KCAL = 250;
export const LOW_DATA_MISSING_DAYS = 3;
export const LOW_DATA_MAX_STEP_KCAL = 100;
export const MAX_TARGET_KCAL = 6000;

export type GuardNote =
  | 'ai_failed'
  | 'ai_target_mismatch'
  | 'low_data_conservative'
  | 'clamped_max_step'
  | 'raised_to_minimum'
  | 'capped_maximum'
  | 'macro_ratio_kept';

export interface GuardInput {
  prevTargetKcal: number;
  /** AI 가 제안한 조정량. null 이면 AI 실패 */
  aiAdjustmentKcal: number | null;
  aiNewTargetKcal?: number | null;
  sex: Sex;
  bmr: number;
  missingDaysLastWeek: number;
  prevMacroRatio: MacroRatio;
  aiMacroRatio?: unknown;
}

export interface GuardResult {
  adjustmentKcal: number;
  newTargetKcal: number;
  macroRatio: MacroRatio;
  minTargetKcal: number;
  notes: GuardNote[];
}

const clampAbs = (v: number, limit: number) => Math.max(-limit, Math.min(limit, v));

export function applyAdjustmentGuards(input: GuardInput): GuardResult {
  const floor = minTargetKcal(input.sex, input.bmr);
  const prev = input.prevTargetKcal;

  if (input.aiAdjustmentKcal === null || !Number.isFinite(input.aiAdjustmentKcal)) {
    return { adjustmentKcal: 0, newTargetKcal: prev, macroRatio: input.prevMacroRatio, minTargetKcal: floor, notes: ['ai_failed'] };
  }

  const notes: GuardNote[] = [];
  let adj = Math.round(input.aiAdjustmentKcal);

  if (
    input.aiNewTargetKcal !== undefined &&
    input.aiNewTargetKcal !== null &&
    Math.abs(prev + adj - input.aiNewTargetKcal) > 1
  ) {
    // 조정량(adjustment_kcal)을 기준으로 삼고, 불일치 사실만 기록
    notes.push('ai_target_mismatch');
  }

  if (input.missingDaysLastWeek >= LOW_DATA_MISSING_DAYS && Math.abs(adj) > LOW_DATA_MAX_STEP_KCAL) {
    adj = clampAbs(adj, LOW_DATA_MAX_STEP_KCAL);
    notes.push('low_data_conservative');
  }

  if (Math.abs(adj) > MAX_WEEKLY_STEP_KCAL) {
    adj = clampAbs(adj, MAX_WEEKLY_STEP_KCAL);
    notes.push('clamped_max_step');
  }

  let target = prev + adj;
  if (target < floor) {
    target = floor;
    notes.push('raised_to_minimum');
  }
  if (target > MAX_TARGET_KCAL) {
    target = MAX_TARGET_KCAL;
    notes.push('capped_maximum');
  }

  let macroRatio = input.prevMacroRatio;
  if (input.aiMacroRatio !== undefined) {
    if (isValidMacroRatio(input.aiMacroRatio, 10, 70)) macroRatio = input.aiMacroRatio;
    else notes.push('macro_ratio_kept');
  }

  return { adjustmentKcal: target - prev, newTargetKcal: target, macroRatio, minTargetKcal: floor, notes };
}

/** 사용자에게 보여줄 안전장치 설명 */
export function guardNotesText(notes: GuardNote[], minKcal: number): string[] {
  const out: string[] = [];
  for (const n of notes) {
    if (n === 'low_data_conservative') out.push('지난주 기록 누락이 많아 조정 폭을 ±100kcal 이내로 줄였어요.');
    if (n === 'clamped_max_step') out.push('한 번에 바꿀 수 있는 폭(±250kcal)으로 조정했어요.');
    if (n === 'raised_to_minimum') out.push(`건강을 위해 최소 목표(${minKcal.toLocaleString('ko-KR')}kcal) 아래로는 내리지 않아요.`);
    if (n === 'capped_maximum') out.push('목표 칼로리 상한에 맞췄어요.');
  }
  return out;
}
