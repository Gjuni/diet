import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { HttpError } from '../src/lib/errors.js';
import {
  addDays,
  ageOn,
  clock,
  isFutureDate,
  kstStartOfDay,
  mealSlotForHour,
  mealSlotForInstant,
  monthRange,
  toKstDate,
  toKstIso,
  toKstTime,
  todayKst,
  weekStartOf,
} from '../src/lib/time.js';
import { assertNotFuture, parseDateParam } from '../src/lib/validate.js';

const realNow = clock.now;
const setNow = (iso: string) => {
  clock.now = () => new Date(iso);
};
afterEach(() => {
  clock.now = realNow;
});

describe('KST 날짜 경계 (UTC 저장 → KST 날짜 판단)', () => {
  it('KST 23:59:59.999 는 같은 날, 00:00:00 은 다음 날', () => {
    // 2026-11-16 23:59:59.999 KST == 2026-11-16T14:59:59.999Z
    expect(toKstDate(new Date('2026-11-16T14:59:59.999Z'))).toBe('2026-11-16');
    expect(toKstTime(new Date('2026-11-16T14:59:59.999Z'))).toBe('23:59:59');
    // 2026-11-17 00:00:00 KST == 2026-11-16T15:00:00Z
    expect(toKstDate(new Date('2026-11-16T15:00:00.000Z'))).toBe('2026-11-17');
    expect(toKstTime(new Date('2026-11-16T15:00:00.000Z'))).toBe('00:00:00');
  });

  it('UTC 날짜와 KST 날짜가 다른 구간(UTC 15:00~24:00)을 올바르게 처리', () => {
    expect(toKstDate(new Date('2026-11-16T20:00:00Z'))).toBe('2026-11-17');
    expect(toKstDate(new Date('2026-11-16T00:00:00Z'))).toBe('2026-11-16'); // 09:00 KST
  });

  it('연말/윤년 경계', () => {
    expect(toKstDate(new Date('2026-12-31T14:59:59Z'))).toBe('2026-12-31');
    expect(toKstDate(new Date('2026-12-31T15:00:00Z'))).toBe('2027-01-01');
    expect(toKstDate(new Date('2028-02-28T15:00:00Z'))).toBe('2028-02-29');
  });

  it('KST ISO 문자열', () => {
    expect(toKstIso(new Date('2026-11-16T03:04:05Z'))).toBe('2026-11-16T12:04:05+09:00');
  });

  it('KST 00:00 → UTC 순간', () => {
    expect(kstStartOfDay('2026-11-17').toISOString()).toBe('2026-11-16T15:00:00.000Z');
  });

  it('오늘 / 미래 판단은 서버 시각(KST) 기준', () => {
    setNow('2026-11-16T14:59:59.999Z'); // 11/16 23:59:59 KST
    expect(todayKst()).toBe('2026-11-16');
    expect(isFutureDate('2026-11-16')).toBe(false);
    expect(isFutureDate('2026-11-17')).toBe(true);

    setNow('2026-11-16T15:00:00.000Z'); // 11/17 00:00 KST
    expect(todayKst()).toBe('2026-11-17');
    expect(isFutureDate('2026-11-17')).toBe(false);
    expect(isFutureDate('2026-11-18')).toBe(true);
  });

  it('미래 local_date 쓰기는 403 (23:59 vs 00:00)', () => {
    setNow('2026-11-16T14:59:59Z');
    expect(() => assertNotFuture('2026-11-17')).toThrowError(HttpError);
    try {
      parseDateParam('2026-11-17', { forbidFuture: true });
    } catch (e) {
      expect((e as HttpError).status).toBe(403);
      expect((e as HttpError).code).toBe('FUTURE_DATE');
    }
    setNow('2026-11-16T15:00:00Z');
    expect(() => assertNotFuture('2026-11-17')).not.toThrow();
    expect(parseDateParam('2026-11-17', { forbidFuture: true })).toBe('2026-11-17');
  });

  it('잘못된 날짜 형식은 400', () => {
    for (const bad of ['2026-13-01', '2026-02-30', '20261116', 'abc']) {
      try {
        parseDateParam(bad, { forbidFuture: false });
        expect.unreachable();
      } catch (e) {
        expect((e as HttpError).status).toBe(400);
      }
    }
  });
});

describe('주 기준 (KST 월요일 00:00 ~ 일요일 23:59)', () => {
  it('일요일은 그 주 월요일, 월요일은 자기 자신', () => {
    expect(weekStartOf('2026-11-22')).toBe('2026-11-16'); // 일
    expect(weekStartOf('2026-11-16')).toBe('2026-11-16'); // 월
    expect(weekStartOf('2026-11-18')).toBe('2026-11-16'); // 수
  });

  it('일요일 23:59 KST 와 월요일 00:00 KST 는 다른 주', () => {
    expect(weekStartOf(toKstDate(new Date('2026-11-22T14:59:59Z')))).toBe('2026-11-16');
    expect(weekStartOf(toKstDate(new Date('2026-11-22T15:00:00Z')))).toBe('2026-11-23');
  });

  it('월 범위', () => {
    expect(monthRange('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(monthRange('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(monthRange('2026-12')).toEqual({ start: '2026-12-01', end: '2026-12-31' });
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('끼니 자동 지정 (KST 시각 기준)', () => {
  it.each([
    [4, 'snack'],
    [5, 'breakfast'],
    [9, 'breakfast'],
    [10, 'lunch'],
    [14, 'lunch'],
    [15, 'dinner'],
    [20, 'dinner'],
    [21, 'snack'],
    [0, 'snack'],
  ] as const)('%i시 → %s', (hour, slot) => {
    expect(mealSlotForHour(hour)).toBe(slot);
  });

  it('UTC 가 아니라 KST 시각으로 판단', () => {
    // 2026-11-16T20:00Z = 11/17 05:00 KST → 아침
    expect(mealSlotForInstant(new Date('2026-11-16T20:00:00Z'))).toBe('breakfast');
    // 2026-11-16T12:30Z = 21:30 KST → 간식/야식
    expect(mealSlotForInstant(new Date('2026-11-16T12:30:00Z'))).toBe('snack');
  });
});

describe('만 나이', () => {
  it('생일 전날/당일', () => {
    expect(ageOn('1990-11-17', '2026-11-16')).toBe(35);
    expect(ageOn('1990-11-16', '2026-11-16')).toBe(36);
  });
});

describe('GET /api/time — 서버가 KST 날짜를 제공', () => {
  let base = '';
  let close: () => void = () => undefined;
  beforeAll(async () => {
    const server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  it('23:59:59 KST', async () => {
    setNow('2026-11-22T14:59:59.000Z'); // 일요일 23:59:59 KST
    const body = await (await fetch(`${base}/api/time`)).json();
    expect(body).toMatchObject({
      timezone: 'Asia/Seoul',
      kst_date: '2026-11-22',
      kst_time: '23:59:59',
      week_start: '2026-11-16',
      month: '2026-11',
    });
  });

  it('00:00:00 KST (다음 날, 새 주)', async () => {
    setNow('2026-11-22T15:00:00.000Z'); // 월요일 00:00 KST
    const body = (await (await fetch(`${base}/api/time`)).json()) as { now_utc: string };
    expect(body).toMatchObject({ kst_date: '2026-11-23', kst_time: '00:00:00', week_start: '2026-11-23' });
    expect(body.now_utc).toBe('2026-11-22T15:00:00.000Z');
  });
});
