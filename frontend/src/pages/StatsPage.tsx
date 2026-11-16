import { useEffect, useState } from 'react';
import { errorMessage, get } from '../api/client';
import type { CalendarResponse, MacroRatioStats, WeeklyCalories, WeightStats } from '../api/types';
import { MacroDonut } from '../components/charts/MacroDonut';
import { WeeklyCaloriesChart } from '../components/charts/WeeklyCaloriesChart';
import { WeightChart } from '../components/charts/WeightChart';
import { n0, n1, signed } from '../lib/format';
import { useServerTime } from '../time/ServerTime';

const WEIGHT_RANGES = [
  ['1w', '1주'],
  ['1m', '1개월'],
  ['3m', '3개월'],
  ['all', '전체'],
] as const;
const MACRO_RANGES = [
  ['week', '이번 주'],
  ['1m', '1개월'],
  ['3m', '3개월'],
] as const;

function useFetch<T>(path: string, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    get<T>(path, ctrl.signal)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => {
        if ((e as Error).name !== 'AbortError') setError(errorMessage(e));
      });
    return () => ctrl.abort();
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error };
}

export function StatsPage() {
  const { today } = useServerTime();
  const [wr, setWr] = useState<(typeof WEIGHT_RANGES)[number][0]>('1m');
  const [mr, setMr] = useState<(typeof MACRO_RANGES)[number][0]>('week');
  const weight = useFetch<WeightStats>(`/stats/weight?range=${wr}`, [wr, today]);
  const weekly = useFetch<WeeklyCalories>('/stats/weekly-calories', [today]);
  const macro = useFetch<MacroRatioStats>(`/stats/macro-ratio?range=${mr}`, [mr, today]);
  const cal = useFetch<CalendarResponse>(`/calendar?month=${today.slice(0, 7)}`, [today]);

  const w = weight.data;
  return (
    <div className="stack">
      <div className="page-header">
        <h1>통계</h1>
      </div>

      <section className="card stack" aria-label="체중 변화">
        <div className="row between">
          <h2 style={{ margin: 0 }}>체중 변화</h2>
        </div>
        <div className="segmented" role="group" aria-label="기간">
          {WEIGHT_RANGES.map(([k, l]) => (
            <button key={k} type="button" aria-pressed={wr === k} onClick={() => setWr(k)}>
              {l}
            </button>
          ))}
        </div>
        {weight.error && <p className="notice error">{weight.error}</p>}
        {w && (
          <>
            <div className="stat-tiles">
              <div className="tile">
                <div className="label">시작 대비</div>
                <div className="value">{w.change_from_start_kg === null ? '-' : `${signed(w.change_from_start_kg)} kg`}</div>
              </div>
              <div className="tile">
                <div className="label">최근 4주 추세</div>
                <div className="value">{w.trend_kg_per_week === null ? '-' : `${signed(w.trend_kg_per_week, 2)} kg/주`}</div>
              </div>
            </div>
            {w.trend_kg_per_week === null && (
              <p className="tiny muted" style={{ margin: 0 }}>
                추세는 최근 4주 안에 7일 이상 간격의 체중 기록이 2개 이상 있어야 계산돼요.
              </p>
            )}
            <WeightChart stats={w} />
          </>
        )}
      </section>

      <section className="card stack" aria-label="이번 주 칼로리">
        <h2 style={{ margin: 0 }}>이번 주 칼로리</h2>
        {weekly.error && <p className="notice error">{weekly.error}</p>}
        {weekly.data && (
          <>
            <div className="stat-tiles">
              <div className="tile">
                <div className="label">주간 합계</div>
                <div className="value">{n0(weekly.data.total_kcal)} kcal</div>
              </div>
              <div className="tile">
                <div className="label">일평균 (기록한 {weekly.data.recorded_days}일)</div>
                <div className="value">{n0(weekly.data.avg_kcal)} kcal</div>
              </div>
            </div>
            <WeeklyCaloriesChart data={weekly.data} />
            <p className="tiny muted" style={{ margin: 0 }}>
              주 기준: 월요일 00:00 ~ 일요일 23:59 (KST)
            </p>
          </>
        )}
      </section>

      <section className="card stack" aria-label="탄단지 비율">
        <h2 style={{ margin: 0 }}>탄단지 비율</h2>
        <div className="segmented" role="group" aria-label="기간">
          {MACRO_RANGES.map(([k, l]) => (
            <button key={k} type="button" aria-pressed={mr === k} onClick={() => setMr(k)}>
              {l}
            </button>
          ))}
        </div>
        {macro.error && <p className="notice error">{macro.error}</p>}
        {macro.data && <MacroDonut stats={macro.data} />}
        {macro.data && macro.data.items_missing_grams > 0 && (
          <p className="tiny muted" style={{ margin: 0 }}>
            g 미입력 음식 {macro.data.items_missing_grams}개는 계산에서 빠졌어요.
          </p>
        )}
      </section>

      <section className="card" aria-label="이번 달 운동">
        <div className="row between">
          <h2 style={{ margin: 0 }}>이번 달 운동</h2>
          <span className="kcal-big">
            {cal.data ? n0(cal.data.exercise_count) : '-'}
            <span className="small muted"> 회</span>
          </span>
        </div>
        {w?.latest_weight_kg != null && (
          <p className="small muted" style={{ margin: '6px 0 0' }}>
            최근 체중 {n1(w.latest_weight_kg)}kg · 목표 {n1(w.goal_weight_kg)}kg
          </p>
        )}
      </section>
    </div>
  );
}
