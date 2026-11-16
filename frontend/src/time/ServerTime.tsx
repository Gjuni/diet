import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { ServerTime } from '../api/types';
import { kstDate, kstHour, kstTime } from '../lib/date';

/**
 * 서버 시각 컨텍스트
 *  - 기기 시간을 믿지 않는다: GET /api/time 으로 서버 시각과의 차이(offset)를 구해 보정한다.
 *  - 달력의 "오늘"은 서버 KST 날짜. 앱을 켜 둔 채 자정이 지나도 30초마다 갱신되고,
 *    화면으로 돌아올 때(visibilitychange)와 5분마다 서버와 다시 맞춘다.
 */
interface Ctx {
  ready: boolean;
  today: string;
  nowMs: () => number;
  nowKst: () => { date: string; time: string; hour: number };
  resync: () => Promise<void>;
}

const TimeContext = createContext<Ctx | null>(null);

export function ServerTimeProvider({ children }: { children: ReactNode }) {
  const offset = useRef(0);
  const [ready, setReady] = useState(false);
  const [today, setToday] = useState(() => kstDate(Date.now()));

  const nowMs = useCallback(() => Date.now() + offset.current, []);

  const resync = useCallback(async () => {
    try {
      const sent = Date.now();
      const t = await api<ServerTime>('/time', { auth: false });
      const rtt = Date.now() - sent;
      offset.current = t.now_ms + rtt / 2 - Date.now();
      setToday(t.kst_date);
    } catch {
      // 오프라인이면 마지막 offset 유지
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void resync();
    const tick = setInterval(() => setToday(kstDate(Date.now() + offset.current)), 30_000);
    const sync = setInterval(() => void resync(), 5 * 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void resync();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(tick);
      clearInterval(sync);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [resync]);

  const value = useMemo<Ctx>(
    () => ({
      ready,
      today,
      nowMs,
      nowKst: () => {
        const ms = nowMs();
        return { date: kstDate(ms), time: kstTime(ms), hour: kstHour(ms) };
      },
      resync,
    }),
    [ready, today, nowMs, resync],
  );
  return <TimeContext.Provider value={value}>{children}</TimeContext.Provider>;
}

export function useServerTime(): Ctx {
  const c = useContext(TimeContext);
  if (!c) throw new Error('ServerTimeProvider 가 필요합니다.');
  return c;
}
