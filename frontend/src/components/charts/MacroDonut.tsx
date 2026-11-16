import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { MacroRatioStats } from '../../api/types';
import { n1 } from '../../lib/format';

const ROWS = [
  { key: 'carbs', label: '탄수화물', color: 'var(--series-1)' },
  { key: 'protein', label: '단백질', color: 'var(--series-2)' },
  { key: 'fat', label: '지방', color: 'var(--series-3)' },
] as const;

/** 실제 탄단지 비율(kcal 기준) 도넛 + 목표 비율 비교표 (색만으로 구분하지 않도록 라벨/수치 표기) */
export function MacroDonut({ stats }: { stats: MacroRatioStats }) {
  const actual = stats.actual_ratio;
  if (!actual) return <div className="empty">이 기간에 g 이 입력된 식사 기록이 없어요.</div>;
  const data = ROWS.map((r) => ({ name: r.label, value: actual[r.key], color: r.color }));

  return (
    <div className="donut-wrap">
      <div style={{ height: 150 }} role="img" aria-label={`실제 비율 탄수화물 ${actual.carbs}%, 단백질 ${actual.protein}%, 지방 ${actual.fat}%`}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              innerRadius={44}
              outerRadius={70}
              startAngle={90}
              endAngle={-270}
              stroke="var(--surface)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {data.map((d) => (
                <Cell key={d.name} fill={d.color} />
              ))}
            </Pie>
            <Tooltip formatter={(v, n) => [`${n1(Number(v))}%`, String(n)]} contentStyle={{ borderRadius: 10, fontSize: 13 }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>영양소</th>
            <th>실제</th>
            <th>목표</th>
            <th>g</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => {
            const a = actual[r.key];
            const t = stats.target_ratio?.[r.key];
            const diff = t === undefined ? null : a - t;
            return (
              <tr key={r.key}>
                <td>
                  <i className="macro-dot" style={{ background: r.color }} />
                  {r.label}
                </td>
                <td>
                  <strong>{n1(a)}%</strong>
                </td>
                <td>
                  {t ?? '-'}%
                  {diff !== null && Math.abs(diff) >= 1 && (
                    <span className="tiny muted">
                      {' '}
                      ({diff > 0 ? '+' : '−'}
                      {n1(Math.abs(diff))})
                    </span>
                  )}
                </td>
                <td>{n1(stats.totals[`${r.key}_g`])}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
