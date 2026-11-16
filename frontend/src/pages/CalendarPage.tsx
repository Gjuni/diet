import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { errorMessage, get } from '../api/client';
import type { CalendarResponse } from '../api/types';
import { ChevronLeft, ChevronRight } from '../components/Icons';
import { MonthCalendar } from '../components/MonthCalendar';
import { addMonths, formatMonthKo } from '../lib/date';
import { useServerTime } from '../time/ServerTime';

export function CalendarPage() {
  const { today } = useServerTime();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const thisMonth = today.slice(0, 7);
  const month = /^\d{4}-\d{2}$/.test(params.get('m') ?? '') ? params.get('m')! : thisMonth;
  const [data, setData] = useState<CalendarResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setError(null);
    get<CalendarResponse>(`/calendar?month=${month}`, ctrl.signal)
      .then(setData)
      .catch((e) => {
        if ((e as Error).name !== 'AbortError') setError(errorMessage(e));
      });
    return () => ctrl.abort();
  }, [month, today]);

  const go = (n: number) => setParams({ m: addMonths(month, n) });
  const isCurrent = month === thisMonth;

  return (
    <div className="stack">
      <div className="card">
        <div className="cal-head">
          <button type="button" className="icon-btn" onClick={() => go(-1)} aria-label="이전 달">
            <ChevronLeft />
          </button>
          <h2 aria-live="polite">{formatMonthKo(month)}</h2>
          <button type="button" className="icon-btn" onClick={() => go(1)} aria-label="다음 달">
            <ChevronRight />
          </button>
        </div>
        <div className="cal-summary">
          <span className="badge ok">
            ✓ {isCurrent ? '이번 달' : `${Number(month.slice(5))}월`} 운동 {data?.month === month ? data.exercise_count : 0}회
          </span>
          {data?.target_kcal && <span className="badge">목표 {data.target_kcal.toLocaleString('ko-KR')} kcal</span>}
          {!isCurrent && (
            <button type="button" className="badge" style={{ border: 'none', cursor: 'pointer' }} onClick={() => setParams({})}>
              오늘로
            </button>
          )}
        </div>
        {error && <p className="notice error">{error}</p>}
        <MonthCalendar
          month={month}
          today={today}
          days={data?.month === month ? data.days : []}
          onSelect={(date) => navigate(`/day/${date}`)}
        />
      </div>
      <button type="button" className="btn btn-primary btn-block" onClick={() => navigate(`/day/${today}`)}>
        오늘 기록하기
      </button>
    </div>
  );
}
