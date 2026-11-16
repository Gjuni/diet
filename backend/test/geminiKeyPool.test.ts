import { describe, expect, it, vi } from 'vitest';
import {
  GeminiKeyPool,
  keyFingerprint,
  nextQuotaReset,
  quotaDayKey,
  type KeyLease,
  type KeyUsageStore,
} from '../src/services/geminiKeyPool.js';
import { sleep } from './helpers/fakeGemini.js';

const KEYS = ['key-AAA', 'key-BBB', 'key-CCC'];
const ok = { kind: 'success' as const, latencyMs: 1000, tokensIn: null, tokensOut: null };

describe('키 rotation / 부하 분산', () => {
  it('순차 요청은 키 3개를 돌아가며 쓴다', async () => {
    const pool = new GeminiKeyPool(KEYS);
    const used: string[] = [];
    for (let i = 0; i < 6; i++) {
      const l = (await pool.acquire())!;
      used.push(l.apiKey);
      l.release(ok);
    }
    expect(used).toEqual([...KEYS, ...KEYS]);
  });

  it('동시 요청은 서로 다른 키로 분산된다', async () => {
    const pool = new GeminiKeyPool(KEYS);
    const leases = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
    expect(new Set(leases.map((l) => l!.apiKey)).size).toBe(3);
  });

  it('이번 요청에서 이미 쓴 키(avoid)는 다른 키가 있으면 피한다', async () => {
    const pool = new GeminiKeyPool(KEYS);
    const first = (await pool.acquire())!;
    first.release(ok);
    const next = (await pool.acquire({ avoid: new Set([first.keyId]) }))!;
    expect(next.keyId).not.toBe(first.keyId);
  });

  it('상태/로그에는 키 원문이 없고 지문만 있다', () => {
    const pool = new GeminiKeyPool(KEYS);
    const json = JSON.stringify(pool.status());
    for (const k of KEYS) expect(json).not.toContain(k);
    expect(json).toContain(keyFingerprint(KEYS[0]!).slice(0, 6));
  });
});

describe('분당 요청(RPM) / 분당 토큰(TPM) 예산', () => {
  it('RPM 한도에 닿으면 다른 키로, 모두 닿으면 창이 비워질 때까지 대기', async () => {
    const pool = new GeminiKeyPool(KEYS, { rpmPerKey: 2, windowMs: 200 });
    for (let i = 0; i < 6; i++) (await pool.acquire())!.release(ok);
    expect(await pool.acquire({ waitMs: 0 })).toBeNull();
    const t0 = Date.now();
    const l = await pool.acquire({ waitMs: 1000 });
    expect(l).not.toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
  });

  it('TPM: 추정 토큰을 예약해 한 키에 몰리지 않게 하고, 실제 토큰으로 정산한다', async () => {
    const pool = new GeminiKeyPool(KEYS, { tpmPerKey: 5000 });
    const leases: KeyLease[] = [];
    for (let i = 0; i < 3; i++) leases.push((await pool.acquire({ tokens: 3000 }))!);
    expect(new Set(leases.map((l) => l.keyId)).size).toBe(3); // 키마다 1건씩
    expect(await pool.acquire({ tokens: 3000, waitMs: 0 })).toBeNull(); // 모두 3000+3000 > 5000

    // 실제 입력 토큰은 1000 이었다 → 정산 후 그 키에 3000 짜리를 더 받을 수 있다
    leases[0]!.release({ kind: 'success', latencyMs: 500, tokensIn: 1000, tokensOut: 100 });
    const more = await pool.acquire({ tokens: 3000, waitMs: 0 });
    expect(more?.keyId).toBe(leases[0]!.keyId);
    expect(pool.status().find((s) => s.keyId === leases[0]!.keyId)!.tpmUsed).toBe(4000);
  });

  it('몇 건 보내지 않았는데 온 429 는 학습하지 않는다 (다른 곳과 쿼터 공유 가능성)', async () => {
    const pool = new GeminiKeyPool(['only']);
    (await pool.acquire())!.release({ kind: 'error', error: { code: 'rate_limited', quotaKind: 'rpm', retryAfterMs: 1 } });
    expect(pool.status()[0]!.rpmLimit).toBeNull();
  });

  it('한도를 모르면 429 로 학습한다 (TPM: 창 사용량의 90%, RPM: 직전까지의 요청 수)', async () => {
    const pool = new GeminiKeyPool(['only'], { windowMs: 60_000 });
    for (let i = 0; i < 3; i++) (await pool.acquire({ tokens: 2000 }))!.release(ok);
    const l = (await pool.acquire({ tokens: 2000 }))!;
    l.release({ kind: 'error', error: { code: 'rate_limited', quotaKind: 'tpm', retryAfterMs: 1 } });
    await sleep(5);
    expect(pool.status()[0]!.tpmLimit).toBe(7200); // 8000 × 0.9

    const pool2 = new GeminiKeyPool(['only']);
    for (let i = 0; i < 10; i++) (await pool2.acquire())!.release(ok);
    (await pool2.acquire())!.release({ kind: 'error', error: { code: 'rate_limited', quotaKind: 'rpm', retryAfterMs: 1 } });
    expect(pool2.status()[0]!.rpmLimit).toBe(10);
  });
});

describe('429 / 장애 처리', () => {
  it('분당 한도 429 → retryDelay 동안만 쉬고 다른 키 사용', async () => {
    const pool = new GeminiKeyPool(KEYS);
    const a = (await pool.acquire())!;
    a.release({ kind: 'error', error: { code: 'rate_limited', quotaKind: 'rpm', retryAfterMs: 100 } });
    expect(pool.status().find((s) => s.keyId === a.keyId)!.state).toBe('cooldown');
    for (let i = 0; i < 4; i++) {
      const l = (await pool.acquire())!;
      expect(l.keyId).not.toBe(a.keyId);
      l.release(ok);
    }
    await sleep(120);
    expect(pool.status().find((s) => s.keyId === a.keyId)!.state).toBe('ok');
  });

  it('일일 한도 429 → 다음 쿼터 리셋(태평양시 자정)까지 제외', async () => {
    let now = Date.parse('2026-11-16T10:00:00Z'); // 02:00 PST
    const pool = new GeminiKeyPool(KEYS, {}, undefined, () => now);
    const a = (await pool.acquire())!;
    a.release({ kind: 'error', error: { code: 'rate_limited', quotaKind: 'daily' } });
    expect(pool.status().find((s) => s.keyId === a.keyId)).toMatchObject({
      state: 'exhausted',
      availableAt: '2026-11-17T08:00:00.000Z', // 11/17 00:00 PST
    });
    now = Date.parse('2026-11-17T08:00:01Z');
    expect(pool.status().find((s) => s.keyId === a.keyId)!.state).toBe('ok');
  });

  it('모든 키가 일일 소진이면 기다리지 않고 null', async () => {
    const pool = new GeminiKeyPool(KEYS);
    for (let i = 0; i < 3; i++) {
      (await pool.acquire())!.release({ kind: 'error', error: { code: 'rate_limited', quotaKind: 'daily' } });
    }
    expect(pool.isExhausted()).toBe(true);
    const t0 = Date.now();
    expect(await pool.acquire({ waitMs: 5000 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it('잘못된 키는 비활성화, 연속 3회 장애는 회로 차단', async () => {
    const pool = new GeminiKeyPool(KEYS, { circuitOpenMs: 10_000 });
    const bad = (await pool.acquire())!;
    bad.release({ kind: 'error', error: { code: 'invalid_key' } });
    expect(pool.status().find((s) => s.keyId === bad.keyId)!.state).toBe('disabled');

    const flaky = new GeminiKeyPool(['only'], { circuitOpenMs: 10_000 });
    for (let i = 0; i < 3; i++) (await flaky.acquire())!.release({ kind: 'error', error: { code: 'upstream_error' } });
    expect(flaky.status()[0]!.state).toBe('cooldown');
  });

  it('취소(aborted)는 벌점 없음', async () => {
    const pool = new GeminiKeyPool(['only']);
    for (let i = 0; i < 5; i++) (await pool.acquire())!.release({ kind: 'aborted' });
    expect(pool.status()[0]!.state).toBe('ok');
  });
});

describe('일일 예산 / 대기열', () => {
  it('배치는 일일 한도의 20% 를 사용자 요청용으로 남긴다', async () => {
    const pool = new GeminiKeyPool(['only'], { rpdPerKey: 10, batchReserveRatio: 0.2 });
    const drain = async (priority: 'batch' | 'interactive') => {
      let n = 0;
      for (let l = await pool.acquire({ priority }); l; l = await pool.acquire({ priority })) {
        n++;
        l.release(ok);
      }
      return n;
    };
    expect(await drain('batch')).toBe(8);
    expect(await drain('interactive')).toBe(2);
  });

  it('대기열에서는 사용자 요청이 배치보다 먼저', async () => {
    const pool = new GeminiKeyPool(['only'], { maxConcurrentPerKey: 1 });
    const holder = (await pool.acquire())!;
    const order: string[] = [];
    const b = pool.acquire({ priority: 'batch', waitMs: 2000 }).then((l) => {
      order.push('batch');
      l!.release(ok);
    });
    await sleep(10);
    const i = pool.acquire({ priority: 'interactive', waitMs: 2000 }).then((l) => {
      order.push('interactive');
      l!.release(ok);
    });
    await sleep(10);
    holder.release(ok);
    await Promise.all([b, i]);
    expect(order).toEqual(['interactive', 'batch']);
  });

  it('대기열이 가득 차면 즉시 거절', async () => {
    const pool = new GeminiKeyPool(['only'], { maxConcurrentPerKey: 1, maxQueue: 1 });
    await pool.acquire();
    const waiting = pool.acquire({ waitMs: 300 });
    await sleep(5);
    expect(await pool.acquire({ waitMs: 300 })).toBeNull();
    expect(await waiting).toBeNull();
  });

  it('재시작 후 오늘 사용량/소진 상태를 복원하고, 사용량을 기록한다', async () => {
    const now = Date.parse('2026-11-16T10:00:00Z');
    const day = quotaDayKey(now, 'America/Los_Angeles');
    const store: KeyUsageStore = {
      load: vi.fn(async () => [
        { keyId: keyFingerprint('key-AAA'), requests: 9, exhausted: false },
        { keyId: keyFingerprint('key-BBB'), requests: 3, exhausted: true },
      ]),
      record: vi.fn(),
    };
    const pool = new GeminiKeyPool(KEYS, { rpdPerKey: 10 }, store, () => now);
    await pool.ready();
    expect(store.load).toHaveBeenCalledWith(day);
    const st = pool.status();
    expect(st[0]).toMatchObject({ dailyUsed: 9, state: 'ok' });
    expect(st[1]).toMatchObject({ dailyUsed: 3, state: 'exhausted' });
    const l = (await pool.acquire())!;
    expect(l.apiKey).toBe('key-CCC'); // 사용률이 가장 낮은 키
    expect(store.record).toHaveBeenCalledWith(keyFingerprint('key-CCC'), day, { requests: 1 });
  });

  it('쿼터 기준일/리셋 시각 (서머타임 포함)', () => {
    expect(quotaDayKey(Date.parse('2026-11-16T07:59:59Z'), 'America/Los_Angeles')).toBe('2026-11-15');
    expect(quotaDayKey(Date.parse('2026-11-16T08:00:00Z'), 'America/Los_Angeles')).toBe('2026-11-16');
    // 7월(PDT, UTC-7): 자정 = 07:00Z
    expect(new Date(nextQuotaReset(Date.parse('2026-07-01T12:00:00Z'), 'America/Los_Angeles')).toISOString()).toBe(
      '2026-07-02T07:00:00.000Z',
    );
  });
});
