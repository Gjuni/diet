import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { WeeklyCalories } from '../../api/types';
import { n0 } from '../../lib/format';

/** 요일별 섭취 kcal 막대 + 목표선 */
export function WeeklyCaloriesChart({ data }: { data: WeeklyCalories }) {
  const max = Math.max(data.target_kcal ?? 0, ...data.days.map((d) => d.kcal));
  return (
    <figure style={{ margin: 0 }}>
      {data.target_kcal !== null && (
        <div className="legend" aria-hidden>
          <span>
            <i className="dashed" />
            목표 {n0(data.target_kcal)} kcal
          </span>
        </div>
      )}
      <div className="chart-box" role="img" aria-label={`이번 주 요일별 섭취 칼로리, 합계 ${n0(data.total_kcal)}kcal`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data.days} margin={{ top: 8, right: 8, bottom: 0, left: -8 }} barCategoryGap="28%">
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis dataKey="weekday" tick={{ fontSize: 12, fill: 'var(--text-3)' }} tickLine={false} axisLine={false} />
            <YAxis
              domain={[0, Math.ceil((max * 1.1) / 500) * 500 || 500]}
              tick={{ fontSize: 11, fill: 'var(--text-3)' }}
              tickLine={false}
              axisLine={false}
              width={48}
            />
            <Tooltip
              cursor={{ fill: 'var(--surface-2)' }}
              formatter={(v) => [`${n0(Number(v))} kcal`, '섭취']}
              labelFormatter={(_l, p) => (p?.[0]?.payload as { date?: string } | undefined)?.date ?? ''}
              contentStyle={{ borderRadius: 10, border: '1px solid var(--border)', fontSize: 13 }}
            />
            {data.target_kcal !== null && (
              <ReferenceLine y={data.target_kcal} stroke="var(--chart-ref)" strokeDasharray="5 4" strokeWidth={1.5} />
            )}
            <Bar dataKey="kcal" fill="var(--series-1)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details>
        <summary>표로 보기</summary>
        <table className="data">
          <thead>
            <tr>
              <th>날짜</th>
              <th>섭취 kcal</th>
            </tr>
          </thead>
          <tbody>
            {data.days.map((d) => (
              <tr key={d.date}>
                <td>
                  {d.date} ({d.weekday})
                </td>
                <td>{d.is_future ? '-' : d.has_record ? n0(d.kcal) : '기록 없음'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
