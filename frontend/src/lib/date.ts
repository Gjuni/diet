/**
 * 날짜 유틸 (KST 고정 +09:00). 기기 시간대와 무관하게 동작한다.
 * "지금"은 서버 시각(GET /api/time)과의 차이를 보정한 값을 쓴다 (ServerTime 컨텍스트).
 */
const KST_OFFSET = 9 * 3600 * 1000;
const DAY = 86_400_000;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export function kstDate(ms: number): string {
  return new Date(ms + KST_OFFSET).toISOString().slice(0, 10);
}

export function kstTime(ms: number): string {
  return new Date(ms + KST_OFFSET).toISOString().slice(11, 16);
}

export function kstHour(ms: number): number {
  return new Date(ms + KST_OFFSET).getUTCHours();
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function weekdayLabel(date: string): string {
  return WEEKDAYS[weekday(date)]!;
}

/** 2026-11-16 → 11월 16일 (월) */
export function formatDateKo(date: string, withWeekday = true): string {
  const [, m, d] = date.split('-').map(Number);
  return `${m}월 ${d}일${withWeekday ? ` (${weekdayLabel(date)})` : ''}`;
}

export function formatMonthKo(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${y}년 ${m}월`;
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** KST 날짜 + 'HH:mm' → ISO 문자열(+09:00) */
export function kstIso(date: string, hhmm: string): string {
  return `${date}T${hhmm}:00+09:00`;
}

export function mealSlotForHour(hour: number): 'breakfast' | 'lunch' | 'dinner' | 'snack' {
  if (hour >= 5 && hour < 10) return 'breakfast';
  if (hour >= 10 && hour < 15) return 'lunch';
  if (hour >= 15 && hour < 21) return 'dinner';
  return 'snack';
}

export function isValidDate(s: string | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}
