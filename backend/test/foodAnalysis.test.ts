import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aiFailure, runFoodAnalysis, validateFoodAnalysis } from '../src/services/foodAnalysis.js';
import { __resetGeminiStateForTests } from '../src/services/gemini.js';
import { GeminiKeyPool } from '../src/services/geminiKeyPool.js';
import { answerChunks, keyOf, rateLimit, sse } from './helpers/fakeGemini.js';

const VALID = {
  is_food: true,
  items: [
    {
      name: '매콤달콤 돼지고기 제육볶음 정식 스페셜',
      category: '한식',
      estimated_grams: 250,
      grams_confidence: 'high',
      per_100g: { carbs: 8.53, protein: 14.2, fat: 9.8 },
      note: '밥 별도',
    },
    {
      name: '쌀밥',
      category: '밥류', // 목록에 없는 카테고리
      estimated_grams: null,
      grams_confidence: 'medium',
      per_100g: { carbs: 31.7, protein: 2.7, fat: 0.3 },
      note: null,
    },
  ],
};

describe('AI 분석 결과 검증 / 정규화', () => {
  it('정상 응답 정규화: 이름 15자, 카테고리, 0.1 단위, g null → low', () => {
    const r = validateFoodAnalysis(VALID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [a, b] = r.value.items;
    expect(Array.from(a!.name).length).toBeLessThanOrEqual(15);
    expect(a!.per_100g.carbs).toBe(8.5);
    expect(a!.nutrition).toEqual({ carbs_g: 21.3, protein_g: 35.5, fat_g: 24.5, kcal: 447.7 });
    expect(b!.category).toBe('기타');
    expect(b!.estimated_grams).toBeNull();
    expect(b!.grams_confidence).toBe('low');
    expect(b!.nutrition).toBeNull();
  });

  it('100g당 탄+단+지 > 100 이면 실패', () => {
    const bad = structuredClone(VALID);
    bad.items[0]!.per_100g = { carbs: 60, protein: 30, fat: 20 };
    expect(validateFoodAnalysis(bad)).toEqual({ ok: false, reason: 'macro_sum_over_100' });
  });

  it('음수 금지', () => {
    const bad = structuredClone(VALID);
    bad.items[0]!.per_100g.fat = -1;
    expect(validateFoodAnalysis(bad).ok).toBe(false);
    const badGrams = structuredClone(VALID);
    (badGrams.items[0] as { estimated_grams: number | null }).estimated_grams = -10;
    expect(validateFoodAnalysis(badGrams).ok).toBe(false);
  });

  it('스키마 불일치 실패, 음식 아님 → 빈 목록', () => {
    expect(validateFoodAnalysis({ is_food: true }).ok).toBe(false);
    expect(validateFoodAnalysis({ is_food: true, items: [{ name: 'x' }] }).ok).toBe(false);
    expect(validateFoodAnalysis({ is_food: false, items: [] })).toEqual({ ok: true, value: { is_food: false, items: [] } });
  });

  it('실패 시 사용자 친화 메시지 + 수동 입력 안내', () => {
    const e = aiFailure('quota_exhausted');
    expect(e.code).toBe('AI_QUOTA_EXHAUSTED');
    expect(e.details).toEqual({ manual_entry_suggested: true });
    expect(aiFailure('timeout').status).toBe(504);
  });
});

describe('runFoodAnalysis: 검증 재시도 / 키 풀 연동', () => {
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const tuning = { stallTimeoutMs: 1000, hedgeAfterMs: 0, minAttemptMs: 10, acquireWaitMs: 100 };
  beforeEach(() => __resetGeminiStateForTests());

  it('검증 실패(탄단지 합 > 100) → 1회 재요청 후 성공', async () => {
    const pool = new GeminiKeyPool(['k1', 'k2']);
    const bad = structuredClone(VALID);
    bad.items[0]!.per_100g = { carbs: 90, protein: 20, fat: 10 };
    let n = 0;
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => sse(answerChunks(n++ === 0 ? bad : VALID), init.signal));
    const run = await runFoodAnalysis(image, 'image/jpeg', { pool, fetchImpl, tuning });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(run.result?.items).toHaveLength(2);
    expect(run.attempts).toBe(2);
    expect(run.tokensIn).toBe(5000);

    // 요청: 서버 키 헤더, 이미지는 inlineData, 이미지 원문은 로그/결과에 없음
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.contents[0].parts[1].inlineData.mimeType).toBe('image/jpeg');
    expect(JSON.stringify(run)).not.toContain(image.toString('base64'));
  });

  it('두 번 모두 검증 실패 → 수동 입력 안내용 오류 코드', async () => {
    const pool = new GeminiKeyPool(['k1']);
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => sse(answerChunks({ is_food: 'yes' }), init.signal));
    const run = await runFoodAnalysis(image, 'image/jpeg', { pool, fetchImpl, tuning });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(run.result).toBeNull();
    expect(run.errorCode).toBe('schema_mismatch');
  });

  it('키 하나가 429 여도 사용자는 모른 채 성공 (failover)', async () => {
    const pool = new GeminiKeyPool(['k1', 'k2', 'k3']);
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) =>
      keyOf(init) === 'k1' ? rateLimit('tokens', '5s') : sse(answerChunks(VALID), init.signal),
    );
    const run = await runFoodAnalysis(image, 'image/jpeg', { pool, fetchImpl, tuning });
    expect(run.result).not.toBeNull();
    expect(run.attempts).toBe(2);
  });

  it('제한 시간 초과 → timeout (재시도하지 않음)', async () => {
    const pool = new GeminiKeyPool(['k1', 'k2']);
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) =>
      sse(answerChunks(VALID), init.signal, { firstDelayMs: 5_000 }),
    );
    const run = await runFoodAnalysis(image, 'image/jpeg', { pool, fetchImpl, tuning: { ...tuning, stallTimeoutMs: 10_000 }, deadlineMs: 600 });
    expect(run.errorCode).toBe('timeout');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
