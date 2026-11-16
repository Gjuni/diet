import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { WeightStats } from '../../api/types';
import { n1 } from '../../lib/format';

const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`;

/** 체중 꺾은선 + 7일 이동평균 + 목표 체중 가로선 (y축 하나) */
export function WeightChart({ stats }: { stats: WeightStats }) {
  const pts = stats.points;
  if (pts.length === 0) return <div className="empty">이 기간에 기록한 체중이 없어요.</div>;
  const values = pts.flatMap((p) => [p.weight_kg, p.ma7]);
  if (stats.goal_weight_kg !== null) values.push(stats.goal_weight_kg);
  const min = Math.floor(Math.min(...values) - 1);
  const max = Math.ceil(Math.max(...values) + 1);

  return (
    <figure style={{ margin: 0 }}>
      <div className="legend" aria-hidden>
        <span>
          <i style={{ background: 'var(--series-1)' }} />
          체중
        </span>
        <span>
          <i style={{ background: 'var(--series-2)' }} />
          7일 이동평균
        </span>
        {stats.goal_weight_kg !== null && (
          <span>
            <i className="dashed" />
            목표 {n1(stats.goal_weight_kg)}kg
          </span>
        )}
      </div>
      <div className="chart-box" role="img" aria-label={`체중 변화 그래프, 최근 ${n1(pts.at(-1)!.weight_kg)}kg`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={pts} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis dataKey="date" tickFormatter={md} tick={{ fontSize: 11, fill: 'var(--text-3)' }} tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis domain={[min, max]} tick={{ fontSize: 11, fill: 'var(--text-3)' }} tickLine={false} axisLine={false} width={44} />
            <Tooltip
              formatter={(v, name) => [`${n1(Number(v))} kg`, name === 'ma7' ? '7일 평균' : '체중']}
              labelFormatter={(l) => md(String(l))}
              contentStyle={{ borderRadius: 10, border: '1px solid var(--border)', fontSize: 13 }}
            />
            {stats.goal_weight_kg !== null && (
              <ReferenceLine y={stats.goal_weight_kg} stroke="var(--chart-ref)" strokeDasharray="5 4" strokeWidth={1.5} />
            )}
            {/* 이동평균을 먼저 그리고 실제 체중 점을 위에 */}
            <Line type="monotone" dataKey="ma7" name="ma7" stroke="var(--series-2)" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line
              type="monotone"
              dataKey="weight_kg"
              name="weight_kg"
              stroke="var(--series-1)"
              strokeWidth={2}
              dot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2, fill: 'var(--series-1)' }}
              activeDot={{ r: 6 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <details>
        <summary>표로 보기</summary>
        <table className="data">
          <thead>
            <tr>
              <th>날짜</th>
              <th>체중</th>
              <th>7일 평균</th>
            </tr>
          </thead>
          <tbody>
            {pts.map((p) => (
              <tr key={p.date}>
                <td>{p.date}</td>
                <td>{n1(p.weight_kg)}</td>
                <td>{n1(p.ma7)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
