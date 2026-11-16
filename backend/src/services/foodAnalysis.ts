import { z } from 'zod';
import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import {
  CATEGORIES,
  MAX_GRAMS,
  itemNutrition,
  normalizePer100,
  type Category,
  type MacroTotals,
  type Per100g,
} from '../lib/nutrition.js';
import { GeminiError, generateJson, loadPrompt, type GeminiDeps } from './gemini.js';

// -----------------------------------------------------------------------------
// Gemini responseSchema (구조화 출력)
// -----------------------------------------------------------------------------
export const FOOD_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_food: { type: 'BOOLEAN', description: '사진에 음식(또는 음료)이 있으면 true' },
    items: {
      type: 'ARRAY',
      description: '사진 속 음식별 항목. 음식이 아니면 빈 배열',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: '한국어 짧은 일반 명칭, 15자 이내' },
          category: { type: 'STRING', enum: [...CATEGORIES] },
          estimated_grams: { type: 'NUMBER', nullable: true, description: '추정 섭취 중량(g). 추정 불가면 null' },
          grams_confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
          per_100g: {
            type: 'OBJECT',
            properties: {
              carbs: { type: 'NUMBER', description: '100g당 탄수화물 g' },
              protein: { type: 'NUMBER', description: '100g당 단백질 g' },
              fat: { type: 'NUMBER', description: '100g당 지방 g' },
            },
            required: ['carbs', 'protein', 'fat'],
            propertyOrdering: ['carbs', 'protein', 'fat'],
          },
          note: { type: 'STRING', nullable: true, description: '짧은 메모 (예: 밥 별도)' },
        },
        required: ['name', 'category', 'estimated_grams', 'grams_confidence', 'per_100g'],
        propertyOrdering: ['name', 'category', 'estimated_grams', 'grams_confidence', 'per_100g', 'note'],
      },
    },
  },
  required: ['is_food', 'items'],
  propertyOrdering: ['is_food', 'items'],
} as const;

const USER_INSTRUCTION = '첨부한 사진 속 음식을 분석해, 지정된 JSON 형식으로만 답하세요.';
export const MAX_ITEMS = 10;
const NAME_MAX = 15;

// -----------------------------------------------------------------------------
// 응답 검증 / 정규화
// -----------------------------------------------------------------------------
const rawItemSchema = z.object({
  name: z.string(),
  category: z.string(),
  estimated_grams: z.number().nullable(),
  grams_confidence: z.enum(['high', 'medium', 'low']),
  per_100g: z.object({ carbs: z.number(), protein: z.number(), fat: z.number() }),
  note: z.string().nullable().optional(),
});
const rawResponseSchema = z.object({ is_food: z.boolean(), items: z.array(rawItemSchema) });

export interface AnalyzedItem {
  name: string;
  category: Category;
  estimated_grams: number | null;
  grams_confidence: 'high' | 'medium' | 'low';
  per_100g: Per100g;
  note: string | null;
  /** estimated_grams 기준 섭취량 (g 이 null 이면 null) */
  nutrition: MacroTotals | null;
  /** 저장 시 meal_items.ai_raw 로 보관할 AI 원본 항목 */
  ai_raw: Record<string, unknown>;
}

export interface FoodAnalysis {
  is_food: boolean;
  items: AnalyzedItem[];
}

export type ValidationResult = { ok: true; value: FoodAnalysis } | { ok: false; reason: string };

function shortName(name: string): string {
  const chars = Array.from(name.replace(/\s+/g, ' ').trim());
  return chars.slice(0, NAME_MAX).join('').trim();
}

/**
 * 스키마 + 값 범위 검증.
 *  - 실패(=재시도 대상): 구조 불일치, 음수, 100g당 탄+단+지 > 100, 빈 이름
 *  - 정규화: 이름 15자 자르기, 모르는 카테고리 → 기타, g 이 0/비현실적이면 null + low, 0.1 단위 반올림
 */
export function validateFoodAnalysis(raw: unknown): ValidationResult {
  const parsed = rawResponseSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'schema' };
  const data = parsed.data;
  if (!data.is_food) return { ok: true, value: { is_food: false, items: [] } };

  const items: AnalyzedItem[] = [];
  for (const it of data.items.slice(0, MAX_ITEMS)) {
    const { carbs, protein, fat } = it.per_100g;
    if ([carbs, protein, fat].some((v) => !Number.isFinite(v) || v < 0)) return { ok: false, reason: 'negative_macro' };
    if (carbs + protein + fat > 100 + 1e-9) return { ok: false, reason: 'macro_sum_over_100' };
    if (it.estimated_grams !== null && (!Number.isFinite(it.estimated_grams) || it.estimated_grams < 0)) {
      return { ok: false, reason: 'negative_grams' };
    }
    const name = shortName(it.name);
    if (!name) return { ok: false, reason: 'empty_name' };

    let grams = it.estimated_grams === null ? null : Math.round(it.estimated_grams * 10) / 10;
    if (grams !== null && (grams <= 0 || grams > MAX_GRAMS)) grams = null;
    const per100 = normalizePer100(it.per_100g);
    items.push({
      name,
      category: (CATEGORIES as readonly string[]).includes(it.category) ? (it.category as Category) : '기타',
      estimated_grams: grams,
      grams_confidence: grams === null ? 'low' : it.grams_confidence,
      per_100g: per100,
      note: it.note?.trim().slice(0, 200) || null,
      nutrition: itemNutrition(grams, per100),
      ai_raw: it as unknown as Record<string, unknown>,
    });
  }
  return { ok: true, value: { is_food: true, items } };
}

// -----------------------------------------------------------------------------
// 실패 응답 (사용자 친화 메시지 + 수동 입력 안내)
// -----------------------------------------------------------------------------
export interface AiFailureInfo {
  status: number;
  code: string;
  message: string;
}

export function aiFailureInfo(code: string | null): AiFailureInfo {
  switch (code) {
    case 'not_configured':
      return { status: 503, code: 'AI_UNAVAILABLE', message: '지금은 AI 분석을 사용할 수 없어요. 직접 입력으로 기록해 주세요.' };
    case 'timeout':
      return { status: 504, code: 'AI_TIMEOUT', message: '분석이 제한 시간 안에 끝나지 않았어요. 다시 시도하거나 직접 입력해 주세요.' };
    case 'quota_exhausted':
      return {
        status: 503,
        code: 'AI_QUOTA_EXHAUSTED',
        message: '오늘 사용할 수 있는 AI 분석량을 모두 사용했어요. 직접 입력으로 기록해 주세요.',
      };
    case 'all_keys_busy':
    case 'rate_limited':
      return { status: 503, code: 'AI_BUSY', message: '지금 분석 요청이 많아요. 잠시 후 다시 시도하거나 직접 입력해 주세요.' };
    case 'expired':
      return { status: 503, code: 'AI_EXPIRED', message: '대기 시간이 길어져 분석을 취소했어요. 다시 시도해 주세요.' };
    case 'blocked':
      return { status: 422, code: 'AI_BLOCKED', message: '이 사진은 분석할 수 없어요. 다른 사진을 쓰거나 직접 입력해 주세요.' };
    case 'stalled':
    case 'incomplete':
    case 'network':
    case 'upstream_error':
    case 'invalid_key':
      return { status: 502, code: 'AI_UNSTABLE', message: 'AI 응답이 원활하지 않았어요. 다시 시도하거나 직접 입력해 주세요.' };
    default:
      return { status: 502, code: 'AI_INVALID_RESPONSE', message: '사진을 제대로 분석하지 못했어요. 다시 찍어 보거나 직접 입력해 주세요.' };
  }
}

export function aiFailure(code: string | null): HttpError {
  const f = aiFailureInfo(code);
  return new HttpError(f.status, f.code, f.message, { manual_entry_suggested: true });
}

const MOCK_RESULT = {
  is_food: true,
  items: [
    {
      name: '제육볶음',
      category: '한식',
      estimated_grams: 250,
      grams_confidence: 'medium',
      per_100g: { carbs: 8.5, protein: 14.2, fat: 9.8 },
      note: '밥 별도',
    },
    {
      name: '쌀밥',
      category: '한식',
      estimated_grams: null,
      grams_confidence: 'low',
      per_100g: { carbs: 31.7, protein: 2.7, fat: 0.3 },
      note: '그릇 크기 판단 어려움',
    },
  ],
};

export interface FoodAnalysisRun {
  result: (FoodAnalysis & { model: string }) | null;
  errorCode: string | null;
  /** Gemini 에 보낸 HTTP 요청 수 (failover / hedging / 검증 재시도 포함) */
  attempts: number;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number;
  keyId: string | null;
  model: string;
}

/**
 * 음식 사진 1장 분석 (DB 와 무관한 순수 실행부).
 *  - 키 풀 / 스트리밍 / failover / hedging 은 generateJson 이 담당
 *  - 응답 JSON 이 스키마·값 범위 검증에 실패하면 1회 더 요청 (그래도 실패하면 수동 입력 안내)
 */
export async function runFoodAnalysis(
  image: Buffer,
  mimeType: string,
  deps: GeminiDeps & { deadlineMs?: number } = {},
): Promise<FoodAnalysisRun> {
  const { model, mock } = config.gemini;
  const run: FoodAnalysisRun = {
    result: null,
    errorCode: null,
    attempts: 0,
    tokensIn: null,
    tokensOut: null,
    latencyMs: 0,
    keyId: null,
    model: mock ? 'mock' : model,
  };

  if (mock) {
    const v = validateFoodAnalysis(MOCK_RESULT);
    run.attempts = 1;
    if (v.ok) run.result = { ...v.value, model: 'mock' };
    else run.errorCode = 'schema_mismatch';
    return run;
  }

  const systemPrompt = loadPrompt('food_analysis');
  const data = image.toString('base64');
  const started = Date.now();
  const deadlineAt = started + (deps.deadlineMs ?? config.gemini.timeoutMs);

  for (let i = 0; i < 2 && !run.result; i++) {
    const remaining = deadlineAt - Date.now();
    if (remaining < (deps.tuning?.minAttemptMs ?? 2_000) + 500) {
      run.errorCode ??= 'timeout';
      break;
    }
    try {
      const r = await generateJson(
        {
          kind: 'analyze',
          priority: 'interactive',
          deadlineMs: remaining,
          systemPrompt,
          parts: [{ text: USER_INSTRUCTION }, { inlineData: { mimeType, data } }],
          responseSchema: FOOD_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
        },
        deps,
      );
      run.attempts += r.attempts;
      run.tokensIn = (run.tokensIn ?? 0) + (r.tokensIn ?? 0);
      run.tokensOut = (run.tokensOut ?? 0) + (r.tokensOut ?? 0);
      run.keyId = r.keyId;

      const v = validateFoodAnalysis(JSON.parse(r.text));
      if (v.ok) {
        run.result = { ...v.value, model: r.model };
        run.errorCode = null;
      } else {
        run.errorCode = 'schema_mismatch';
        console.warn(`[ai] 분석 결과 검증 실패 (${v.reason}) → ${i === 0 ? '재시도' : '수동 입력 안내'}`);
      }
    } catch (err) {
      if (!(err instanceof GeminiError)) throw err;
      run.attempts += err.attempts;
      run.errorCode = err.code;
      run.keyId = err.keyId ?? run.keyId;
      break; // 키 문제/끊김은 generateJson 안에서 이미 다른 키로 재시도했다
    }
  }
  run.latencyMs = Date.now() - started;
  return run;
}
