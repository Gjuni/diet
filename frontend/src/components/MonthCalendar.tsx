import type { CalendarDay } from '../api/types';
import { addDays, daysInMonth, formatDateKo, weekday } from '../lib/date';
import { n0 } from '../lib/format';

const DOW = ['일', '월', '화', '수', '목', '금', '토'];

/**
 * 월 달력. 셀 상태 우선순위:
 *  1) 오늘: 강조 테두리 + 메인 컬러  2) 운동한 날: 초록 배경 + ✓ 아이콘(색만으로 구분하지 않음)
 *  3) 지난 날(기록 있음): 연한 회색  4) 지난 날(기록 없음): 더 연한 배경 + 흐린 글자  5) 미래: 비활성
 *  오늘이면서 운동한 날은 테두리 + 초록 배경을 함께 표시한다.
 */
export function MonthCalendar({
  month,
  today,
  days,
  onSelect,
}: {
  month: string;
  today: string;
  days: CalendarDay[];
  onSelect: (date: string) => void;
}) {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const first = `${month}-01`;
  const lead = weekday(first);
  const total = daysInMonth(month);
  const cells: Array<string | null> = [...Array(lead).fill(null), ...Array.from({ length: total }, (_, i) => addDays(first, i))];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div>
      <div className="cal-grid" role="grid" aria-label="월간 달력">
        {DOW.map((d, i) => (
          <div key={d} className={`cal-dow${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}`} role="columnheader">
            {d}
          </div>
        ))}
        {cells.map((date, i) => {
          if (!date) return <div key={`b${i}`} className="cal-cell blank" aria-hidden />;
          const info = byDate.get(date);
          const isToday = date === today;
          const isFuture = date > today;
          const classes = ['cal-cell'];
          if (isFuture) classes.push('future');
          else {
            if (info?.exercised) classes.push('exercised');
            else if (info?.has_record) classes.push('recorded');
            if (isToday) classes.push('today');
          }
          const parts = [formatDateKo(date)];
          if (isToday) parts.push('오늘');
          if (info?.exercised) parts.push('운동함');
          if (info?.kcal) parts.push(`${n0(info.kcal)}kcal`);
          if (!isFuture && !info?.has_record) parts.push('기록 없음');
          if (isFuture) parts.push('미래 날짜');
          return (
            <button
              key={date}
              type="button"
              className={classes.join(' ')}
              disabled={isFuture}
              aria-disabled={isFuture}
              aria-current={isToday ? 'date' : undefined}
              aria-label={parts.join(', ')}
              onClick={() => !isFuture && onSelect(date)}
            >
              <span className="d">{Number(date.slice(8))}</span>
              {info?.exercised && !isFuture && (
                <span className="ex" aria-hidden>
                  ✓
                </span>
              )}
              {!isFuture && info?.kcal ? <span className="kcal">{n0(info.kcal)}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="cal-legend" aria-label="색상 범례">
        <span>
          <i style={{ borderColor: 'var(--primary)', background: 'var(--primary-weak)' }} />
          오늘
        </span>
        <span>
          <i style={{ background: 'var(--exercise-bg)', color: 'var(--exercise-icon)' }}>✓</i>
          운동한 날
        </span>
        <span>
          <i style={{ background: 'var(--past-record-bg)' }} />
          기록 있음
        </span>
        <span>
          <i style={{ background: 'var(--past-empty-bg)', borderColor: 'var(--border)' }} />
          기록 없음
        </span>
        <span>
          <i style={{ borderColor: 'var(--border)', borderStyle: 'dashed' }} />
          미래(선택 불가)
        </span>
        <span className="muted">숫자 = 섭취 kcal</span>
      </div>
    </div>
  );
}
