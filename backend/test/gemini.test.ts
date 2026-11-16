import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetGeminiStateForTests, generateJson, GeminiError, type GeminiRequest } from '../src/services/gemini.js';
import { GeminiKeyPool } from '../src/services/geminiKeyPool.js';
import { answerChunks, errorResponse, keyOf, rateLimit, sleep, sse } from './helpers/fakeGemini.js';

const KEYS = ['key-AAA', 'key-BBB', 'key-CCC'];
const ANSWER = { is_food: true, items: [] };
const REQ: GeminiRequest = {
  kind: 'analyze',
  systemPrompt: '시스템 프롬프트',
  parts: [{ text: '분석해 주세요' }, { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }],
  responseSchema: { type: 'OBJECT' },
};
// 테스트용으로 짧게
const tuning = { stallTimeoutMs: 150, hedgeAfterMs: 0, minAttemptMs: 10, acquireWaitMs: 200 };

beforeEach(() => __resetGeminiStateForTests());

type Handler = (key: string, init: RequestInit, n: number) => Response | Promise<Response>;
function fakeFetch(handler: Handler) {
  let n = 0;
  return vi.fn(async (_url: string, init: RequestInit) => handler(keyOf(init), init, n++));
}

describe('스트리밍(SSE) 수신', () => {
  it('바이트 중간에서 잘린 이벤트도 이어 붙이고, 추론 요약은 답변에서 뺀다', async () => {
    const pool = new GeminiKeyPool(KEYS);
    const fetchImpl = fakeFetch((_k, init) => sse(answerChunks(ANSWER), init.signal, { splitBytes: true }));
    const r = await generateJson(REQ, { pool, fetchImpl, tuning });
    expect(JSON.parse(r.text)).toEqual(ANSWER);
    expect(r).toMatchObject({ tokensIn: 2500, tokensOut: 420, attempts: 1, hedged: false });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toMatch(/models\/gemini-3\.8-flash:streamGenerateContent\?alt=sse$/);
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'MEDIUM', includeThoughts: true });
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });
});

describe('failover: 다른 키로 즉시 재요청', () => {
  it('분당 한도 429 → 다음 키로 성공, 429 키는 쿨다운', async () => {
    const pool = new GeminiKeyPool(KEYS);
    const fetchImpl = fakeFetch((key, init) => (key === 'key-AAA' ? rateLimit('minute', '30s') : sse(answerChunks(ANSWER), init.signal)));
    const r = await generateJson(REQ, { pool, fetchImpl, tuning });
    expect(r.attempts).toBe(2);
    expect(fetchImpl.mock.calls.map(([, i]) => keyOf(i))).toEqual(['key-AAA', 'key-BBB']);
    expect(pool.status()[0]!.state).toBe('cooldown');
  });

  it('일일 한도 429 → 그 키는 오늘 다시 쓰지 않는다', async () => {
    const pool = new GeminiKeyPool(KEYS);
    const fetchImpl = fakeFetch((key, init) => (key === 'key-AAA' ? rateLimit('day') : sse(answerChunks(ANSWER), init.signal)));
    await generateJson(REQ, { pool, fetchImpl, tuning });
    for (let i = 0; i < 4; i++) await generateJson(REQ, { pool, fetchImpl, tuning });
    expect(fetchImpl.mock.calls.filter(([, i]) => keyOf(i) === 'key-AAA')).toHaveLength(1);
    expect(pool.status()[0]!.state).toBe('exhausted');
  });

  it('추론 중 정체(데이터가 끊김) → stall 감지 후 다른 키로', async () => {
    const pool = new GeminiKeyPool(KEYS);
    let firstSignal: AbortSignal | null = null;
    const fetchImpl = fakeFetch((key, init) => {
      if (key === 'key-AAA') {
        firstSignal = init.signal ?? null;
        return sse(answerChunks(ANSWER), init.signal, { hangAfter: 0 }); // thought 1개 보내고 멈춤
      }
      return sse(answerChunks(ANSWER), init.signal);
    });
    const t0 = Date.now();
    const r = await generateJson(REQ, { pool, fetchImpl, tuning });
    expect(r.keyId).toBe(pool.status()[1]!.keyId);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(firstSignal!.aborted).toBe(true);
  });

  it('답변 도중 스트림이 끊김(finishReason 없음) → 다른 키로 처음부터', async () => {
    const pool = new GeminiKeyPool(KEYS);
    const fetchImpl = fakeFetch((key, init) =>
      sse(answerChunks(ANSWER), init.signal, key === 'key-AAA' ? { cutAfter: 1 } : {}),
    );
    const r = await generateJson(REQ, { pool, fetchImpl, tuning });
    expect(JSON.parse(r.text)).toEqual(ANSWER);
    expect(r.attempts).toBe(2);
  });

  it('MAX_TOKENS 잘림 → 다음 시도는 thinking LOW + 출력 한도 2배', async () => {
    const pool = new GeminiKeyPool(KEYS);
    const fetchImpl = fakeFetch((_k, init, n) =>
      n === 0 ? sse(answerChunks(ANSWER, { finishReason: 'MAX_TOKENS' }), init.signal) : sse(answerChunks(ANSWER), init.signal),
    );
    await generateJson(REQ, { pool, fetchImpl, tuning: { ...tuning, maxOutputTokens: 4096 } });
    const second = JSON.parse(fetchImpl.mock.calls[1]![1].body as string);
    expect(second.generationConfig.thinkingConfig.thinkingLevel).toBe('LOW');
    expect(second.generationConfig.maxOutputTokens).toBe(8192);
  });

  it('잘못된 키(400 API_KEY_INVALID) → 비활성화 후 다른 키로', async () => {
    const pool = new GeminiKeyPool(KEYS);
    const fetchImpl = fakeFetch((key, init) =>
      key === 'key-AAA'
        ? errorResponse(400, { message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] })
        : sse(answerChunks(ANSWER), init.signal),
    );
    await generateJson(REQ, { pool, fetchImpl, tuning });
    expect(pool.status()[0]!.state).toBe('disabled');
  });

  it('5xx(과부하) → 다른 키로', async () => {
    const pool = new GeminiKeyPool(KEYS);
    const fetchImpl = fakeFetch((key, init) =>
      key === 'key-AAA' ? errorResponse(503, { message: 'overloaded' }) : sse(answerChunks(ANSWER), init.signal),
    );
    expect((await generateJson(REQ, { pool, fetchImpl, tuning })).attempts).toBe(2);
  });
});

describe('failover 하지 않는 경우', () => {
  it('안전 차단(SAFETY)은 다른 키로 보내도 같으므로 즉시 실패', async () => {
    const pool = new GeminiKeyPool(KEYS);
    const fetchImpl = fakeFetch((_k, init) => sse(answerChunks(ANSWER, { finishReason: 'SAFETY' }), init.signal));
    const err = await generateJson(REQ, { pool, fetchImpl, tuning }).catch((e: GeminiError) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect((err as GeminiError).code).toBe('blocked');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('모든 키가 일일 소진 → quota_exhausted (시도 횟수 포함)', async () => {
    const pool = new GeminiKeyPool(KEYS);
    const fetchImpl = fakeFetch(() => rateLimit('day'));
    const err = (await generateJson(REQ, { pool, fetchImpl, tuning }).catch((e) => e)) as GeminiError;
    expect(err.code).toBe('quota_exhausted');
    expect(err.attempts).toBe(3);
    const again = (await generateJson(REQ, { pool, fetchImpl, tuning }).catch((e) => e)) as GeminiError;
    expect(again.code).toBe('quota_exhausted');
    expect(again.attempts).toBe(0); // 쿼터를 더 쓰지 않음
  });

  it('전체 제한 시간(deadline) 초과 → timeout', async () => {
    const pool = new GeminiKeyPool(KEYS);
    const fetchImpl = fakeFetch((_k, init) => sse(answerChunks(ANSWER), init.signal, { firstDelayMs: 5_000 }));
    const err = (await generateJson({ ...REQ, deadlineMs: 300 }, { pool, fetchImpl, tuning: { ...tuning, stallTimeoutMs: 10_000 } }).catch(
      (e) => e,
    )) as GeminiError;
    expect(err.code).toBe('timeout');
  });

  it('호출자가 취소하면 진행 중인 요청도 끊는다', async () => {
    const pool = new GeminiKeyPool(KEYS);
    let sig: AbortSignal | null = null;
    const fetchImpl = fakeFetch((_k, init) => {
      sig = init.signal ?? null;
      return sse(answerChunks(ANSWER), init.signal, { firstDelayMs: 5_000 });
    });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    const err = (await generateJson(REQ, { pool, fetchImpl, tuning: { ...tuning, stallTimeoutMs: 10_000 }, signal: ctrl.signal }).catch(
      (e) => e,
    )) as GeminiError;
    expect(err.code).toBe('aborted');
    expect(sig!.aborted).toBe(true);
  });
});

describe('hedging: 첫 응답이 늦으면 다른 키로 병렬 요청', () => {
  it('느린 키 대신 먼저 끝난 키의 답을 쓰고, 느린 요청은 취소한다', async () => {
    const pool = new GeminiKeyPool(KEYS);
    let slowSignal: AbortSignal | null = null;
    const fetchImpl = fakeFetch((key, init) => {
      if (key === 'key-AAA') {
        slowSignal = init.signal ?? null;
        return sse(answerChunks(ANSWER), init.signal, { firstDelayMs: 2_000 });
      }
      return sse(answerChunks(ANSWER), init.signal);
    });
    const t0 = Date.now();
    const r = await generateJson(REQ, { pool, fetchImpl, tuning: { ...tuning, stallTimeoutMs: 10_000, hedgeAfterMs: 80 } });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(r).toMatchObject({ hedged: true, attempts: 2, keyId: pool.status()[1]!.keyId });
    await sleep(10);
    expect(slowSignal!.aborted).toBe(true);
    expect(pool.status()[0]!.inFlight).toBe(0); // 취소된 요청도 반납됨
  });

  it('첫 데이터(추론 요약)가 이미 오고 있으면 hedging 하지 않는다', async () => {
    const pool = new GeminiKeyPool(KEYS);
    const fetchImpl = fakeFetch((_k, init) => sse(answerChunks(ANSWER), init.signal, { delayMs: 120 }));
    const r = await generateJson(REQ, { pool, fetchImpl, tuning: { ...tuning, stallTimeoutMs: 10_000, hedgeAfterMs: 60 } });
    expect(r.attempts).toBe(1);
  });

  it('배치 요청은 hedging 하지 않는다 (쿼터 절약)', async () => {
    const pool = new GeminiKeyPool(KEYS);
    const fetchImpl = fakeFetch((_k, init) => sse(answerChunks(ANSWER), init.signal, { firstDelayMs: 200 }));
    const r = await generateJson(
      { ...REQ, priority: 'batch' },
      { pool, fetchImpl, tuning: { ...tuning, stallTimeoutMs: 10_000, hedgeAfterMs: 20 } },
    );
    expect(r).toMatchObject({ attempts: 1, hedged: false });
  });
});
