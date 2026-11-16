/**
 * 시간 규칙
 *  - DB 에는 모든 시각을 UTC(timestamptz) 로 저장한다.
 *  - "날짜" 판단은 항상 서버에서 Asia/Seoul(KST, UTC+9) 기준으로 한다.
 *  - 한국은 1988년 이후 서머타임이 없으므로 고정 오프셋(+09:00)으로 계산한다.
 *    (Intl 의 타임존 DB 에 의존하지 않아 결정적이고 테스트하기 쉽다)
 */
export const KST_TIMEZONE = 'Asia/Seoul';
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 테스트에서 현재 시각을 바꿀 수 있도록 한 곳에서만 now() 를 얻는다. */
export const clock = {
  now: (): Date => new Date(),
};

export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

export interface KstParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = 일요일 ... 6 = 토요일 */
  weekday: number;
}

export function kstParts(instant: Date): KstParts {
  const d = new Date(instant.getTime() + KST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  };
}

/** 순간(instant) → KST 날짜 'YYYY-MM-DD' */
export function toKstDate(instant: Date): string {
  const p = kstParts(instant);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** 순간 → KST 시각 'HH:mm:ss' */
export function toKstTime(instant: Date): string {
  const p = kstParts(instant);
  return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** 순간 → 'YYYY-MM-DDTHH:mm:ss+09:00' */
export function toKstIso(instant: Date): string {
  return `${toKstDate(instant)}T${toKstTime(instant)}+09:00`;
}

/** 서버 기준 오늘(KST) */
export function todayKst(now: Date = clock.now()): string {
  return toKstDate(now);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

export function isValidDateString(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

export function isValidMonthString(s: unknown): s is string {
  return typeof s === 'string' && MONTH_RE.test(s) && isValidDateString(`${s}-01`);
}

/** 날짜 문자열에 n 일을 더한다 (달력 연산, 타임존 무관) */
export function addDays(date: string, n: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + n * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

/** b - a (일) */
export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** 0 = 일요일 ... 6 = 토요일 */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** 그 날짜가 속한 주의 월요일 (주 = KST 월요일 00:00 ~ 일요일 23:59) */
export function weekStartOf(date: string): string {
  const offset = (weekdayOf(date) + 6) % 7;
  return addDays(date, -offset);
}

/** KST 날짜의 00:00 을 UTC 순간으로 */
export function kstStartOfDay(date: string): Date {
  return new Date(Date.parse(`${date}T00:00:00Z`) - KST_OFFSET_MS);
}

/** 오늘(KST)보다 이후 날짜인가 */
export function isFutureDate(date: string, now: Date = clock.now()): boolean {
  return date > todayKst(now);
}

/** 'YYYY-MM' → 그 달의 첫날/마지막날 */
export function monthRange(month: string): { start: string; end: string } {
  const start = `${month}-01`;
  const [y, m] = month.split('-').map(Number) as [number, number];
  const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
  return { start, end: addDays(nextMonth, -1) };
}

/** 끼니 자동 지정: 아침 05~10시, 점심 10~15시, 저녁 15~21시, 그 외 간식/야식 */
export function mealSlotForHour(hour: number): MealSlot {
  if (hour >= 5 && hour < 10) return 'breakfast';
  if (hour >= 10 && hour < 15) return 'lunch';
  if (hour >= 15 && hour < 21) return 'dinner';
  return 'snack';
}

export function mealSlotForInstant(instant: Date): MealSlot {
  return mealSlotForHour(kstParts(instant).hour);
}

/** 만 나이 */
export function ageOn(birthDate: string, onDate: string): number {
  const [by, bm, bd] = birthDate.split('-').map(Number) as [number, number, number];
  const [y, m, d] = onDate.split('-').map(Number) as [number, number, number];
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age;
}
