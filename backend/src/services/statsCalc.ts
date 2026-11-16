import { round1 } from '../lib/nutrition.js';
import { addDays, diffDays } from '../lib/time.js';

export interface WeightPoint {
  date: string;
  weight_kg: number;
}

/**
 * 7일 이동평균: 각 기록일 d 에 대해 [d-6, d] 구간에 있는 기록들의 평균.
 * (기록이 없는 날은 건너뛰고, 실제 날짜 간격 기준으로 창을 잡는다)
 */
export function movingAverage7(points: WeightPoint[]): Array<WeightPoint & { ma7: number }> {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  return sorted.map((p, i) => {
    const windowStart = addDays(p.date, -6);
    let sum = 0;
    let n = 0;
    for (let j = i; j >= 0 && sorted[j]!.date >= windowStart; j--) {
      sum += sorted[j]!.weight_kg;
      n += 1;
    }
    return { ...p, ma7: round1(sum / n) };
  });
}

/**
 * 최근 추세(주당 kg): 최소제곱 직선의 기울기(kg/일) × 7.
 * 기록이 2개 미만이거나 기간이 7일 미만이면 신뢰할 수 없으므로 null.
 */
export function trendKgPerWeek(points: WeightPoint[]): number | null {
  if (points.length < 2) return null;
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const first = sorted[0]!.date;
  const span = diffDays(first, sorted[sorted.length - 1]!.date);
  if (span < 7) return null;
  const xs = sorted.map((p) => diffDays(first, p.date));
  const ys = sorted.map((p) => p.weight_kg);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  if (den === 0) return null;
  return Math.round((num / den) * 7 * 100) / 100;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
