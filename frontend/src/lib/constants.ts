import type { ActivityLevel, Category, GoalType, MealSlot } from '../api/types';

export const CATEGORIES: Category[] = [
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
];

export const SLOT_LABEL: Record<MealSlot, string> = {
  breakfast: '아침',
  lunch: '점심',
  dinner: '저녁',
  snack: '간식/야식',
};
export const SLOTS: MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snack'];

export const ACTIVITY_LABEL: Record<ActivityLevel, string> = {
  sedentary: '좌식 (운동 거의 안 함)',
  light: '가벼움 (주 1~3회)',
  moderate: '보통 (주 3~5회)',
  active: '활발 (주 6~7회)',
  very_active: '매우 활발 (육체노동/하루 2회)',
};

export const GOAL_LABEL: Record<GoalType, string> = {
  lose: '감량',
  maintain: '유지',
  gain: '증량',
};

export const CONFIDENCE_LABEL = { high: '정확도 높음', medium: '정확도 보통', low: '정확도 낮음' } as const;

/** 클라이언트 리사이즈: 긴 변 1024px, JPEG 품질 0.8 (업로드 용량/지연 최소화) */
export const IMAGE_MAX_EDGE = 1024;
export const IMAGE_QUALITY = 0.8;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
