export type Sex = 'male' | 'female';
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';
export type GoalType = 'lose' | 'maintain' | 'gain';
export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export type Confidence = 'high' | 'medium' | 'low';
export type Category =
  | '한식'
  | '중식'
  | '일식'
  | '양식'
  | '분식'
  | '아시안'
  | '패스트푸드'
  | '샐러드/건강식'
  | '디저트/간식'
  | '음료'
  | '기타';

export interface MacroRatio {
  carbs: number;
  protein: number;
  fat: number;
}
export interface Per100g {
  carbs: number;
  protein: number;
  fat: number;
}

export interface User {
  id: string;
  email: string;
  nickname: string;
  created_at: string;
}

export interface Profile {
  sex: Sex;
  birth_date: string;
  height_cm: number;
  start_weight_kg: number;
  goal_weight_kg: number;
  activity_level: ActivityLevel;
  goal_type: GoalType;
  target_kcal: number;
  macro_ratio: MacroRatio;
  target_macros_g: { carbs_g: number; protein_g: number; fat_g: number };
}

export interface Metrics {
  age: number;
  current_weight_kg: number;
  bmi: number;
  bmr: number;
  tdee: number;
  min_target_kcal: number;
}

export interface MeResponse {
  user: User;
  profile: Profile | null;
  metrics: Metrics | null;
  today: string;
}

export interface SessionResponse {
  access_token: string;
  user: User;
}

export interface LoginResponse extends Partial<SessionResponse> {
  password_change_required?: boolean;
  password_change_token?: string;
}

export interface ServerTime {
  timezone: string;
  now_utc: string;
  now_ms: number;
  kst_date: string;
  kst_time: string;
  week_start: string;
  month: string;
}

export interface CalendarDay {
  date: string;
  kcal: number | null;
  meal_count: number;
  items_missing_grams: number;
  exercised: boolean;
  weight_kg: number | null;
  has_record: boolean;
}

export interface CalendarResponse {
  month: string;
  today: string;
  exercise_count: number;
  target_kcal: number | null;
  days: CalendarDay[];
}

export interface MealItem {
  id: string;
  meal_id: string;
  name: string;
  category: Category;
  grams: number | null;
  grams_source: 'ai' | 'user' | null;
  grams_confidence: Confidence | null;
  needs_grams: boolean;
  per_100g: Per100g;
  carbs_g: number | null;
  protein_g: number | null;
  fat_g: number | null;
  kcal: number | null;
  note: string | null;
}

export interface Meal {
  id: string;
  eaten_at: string;
  eaten_at_kst: string;
  time_kst: string;
  local_date: string;
  meal_slot: MealSlot;
  source: 'ai' | 'manual';
  items: MealItem[];
}

export interface DayTotals {
  meal_count: number;
  item_count: number;
  items_missing_grams: number;
  carbs_g: number;
  protein_g: number;
  fat_g: number;
  kcal: number;
}

export interface DayResponse {
  date: string;
  today: string;
  is_today: boolean;
  daily_log: { exercised: boolean; weight_kg: number | null };
  meals: Meal[];
  totals: DayTotals;
  targets: { kcal: number; macro_ratio: MacroRatio; carbs_g: number; protein_g: number; fat_g: number } | null;
}

export interface AnalyzedItem {
  name: string;
  category: Category;
  estimated_grams: number | null;
  grams_confidence: Confidence;
  per_100g: Per100g;
  note: string | null;
  nutrition: { carbs_g: number; protein_g: number; fat_g: number; kcal: number } | null;
  ai_raw: Record<string, unknown>;
}

export type JobStatus = 'queued' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'expired';

export interface AnalysisJob {
  id: string;
  status: JobStatus;
  queue_position: number | null;
  image_purged: boolean;
  result: { is_food: boolean; items: AnalyzedItem[]; model: string } | null;
  error: { code: string; message: string; manual_entry_suggested: true } | null;
  deduplicated?: boolean;
}

export interface WeightStats {
  range: string;
  from: string;
  to: string;
  points: Array<{ date: string; weight_kg: number; ma7: number }>;
  start_weight_kg: number | null;
  goal_weight_kg: number | null;
  latest_weight_kg: number | null;
  change_from_start_kg: number | null;
  trend_kg_per_week: number | null;
  trend_sample_size: number;
}

export interface WeeklyCalories {
  week_start: string;
  week_end: string;
  today: string;
  target_kcal: number | null;
  days: Array<{ date: string; weekday: string; kcal: number; has_record: boolean; items_missing_grams: number; is_future: boolean }>;
  total_kcal: number;
  recorded_days: number;
  avg_kcal: number;
}

export interface MacroRatioStats {
  range: string;
  from: string;
  to: string;
  recorded_days: number;
  items_missing_grams: number;
  totals: { carbs_g: number; protein_g: number; fat_g: number; kcal: number };
  actual_ratio: MacroRatio | null;
  target_ratio: MacroRatio | null;
}

export interface Adjustment {
  id: string;
  week_start: string;
  prev_target_kcal: number;
  adjustment_kcal: number;
  new_target_kcal: number;
  ai_adjustment_kcal: number | null;
  macro_ratio: MacroRatio;
  reason: string;
  confidence: Confidence | null;
  status: 'applied' | 'rejected' | 'failed';
  created_at: string;
  can_reject: boolean;
}
