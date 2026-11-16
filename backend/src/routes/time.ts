import { Router } from 'express';
import { clock, KST_TIMEZONE, toKstDate, toKstIso, toKstTime, weekStartOf } from '../lib/time.js';

export const timeRouter = Router();

/**
 * GET /api/time — 서버 기준 현재 KST 날짜/시각.
 * 클라이언트는 기기 시간을 신뢰하지 않고 이 값으로 달력의 "오늘"을 정한다.
 */
timeRouter.get('/', (_req, res) => {
  const now = clock.now();
  const date = toKstDate(now);
  res.set('Cache-Control', 'no-store');
  res.json({
    timezone: KST_TIMEZONE,
    now_utc: now.toISOString(),
    now_ms: now.getTime(),
    kst_date: date,
    kst_time: toKstTime(now),
    kst_iso: toKstIso(now),
    week_start: weekStartOf(date),
    month: date.slice(0, 7),
  });
});
