import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { pgKeyUsageStore } from '../repositories/pgKeyUsageStore.js';
import { GeminiKeyPool, type KeyLease, type Priority, type QuotaKind } from './geminiKeyPool.js';

/**
 * Gemini 호출 계층 (키 풀 + 스트리밍 + failover + hedging)
 *
 *  1) 키 풀에서 가장 여유 있는 키를 빌린다 (RPM/RPD/동시요청/쿨다운/소진 고려).
 *  2) streamGenerateContent(SSE)로 받는다. includeThoughts 로 추론 요약도 흘려받아
 *     "추론 중"에도 데이터가 오는지 감시한다 → stallTimeoutMs 동안 아무것도 안 오면 정체로 판단.
 *  3) 끊김/정체/잘림(MAX_TOKENS)/429/5xx/잘못된 키 → 즉시 다른 키로 처음부터 다시 요청(failover).
 *     (Gemini 는 이어받기(resume)를 지원하지 않으므로, 깨진 JSON 을 이어 붙이지 않고 새로 받는다)
 *     잘림이면 다음 시도는 thinking 을 낮추고 출력 한도를 늘린다.
 *  4) 사용자 요청은 hedgeAfterMs 안에 첫 데이터가 없으면 다른 키로 예비 요청을 병렬로 보내고,
 *     먼저 완성된 응답을 채택한 뒤 나머지는 취소한다 (일일 예산이 충분할 때만).
 *  5) 전체 제한 시간(deadline)을 넘기지 않는다.
 *
 *  보안: API 키는 서버에만 있다(x-goog-api-key 헤더). 요청 본문(이미지 base64)과 키 원문은 로그에 남기지 않는다.
 */

export type GeminiErrorCode =
  | 'not_configured'
  | 'quota_exhausted'
  | 'all_keys_busy'
  | 'timeout'
  | 'stalled'
  | 'incomplete'
  | 'truncated'
  | 'rate_limited'
  | 'invalid_key'
  | 'blocked'
  | 'bad_request'
  | 'upstream_error'
  | 'network'
  | 'empty_response'
  | 'invalid_json'
  | 'schema_mismatch'
  | 'aborted';

export class GeminiError extends Error {
  readonly code: GeminiErrorCode;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  /** 429 의 종류: 일일 한도 / 분당 토큰 / 분당 요청 */
  readonly quotaKind?: QuotaKind;
  /** 400 이 mediaResolution 설정 때문인지 (자동으로 빼고 재시도) */
  readonly mediaResolutionRejected?: boolean;
  /** 실제로 Gemini 에 보낸 HTTP 요청 수 (0 이면 쿼터를 쓰지 않음) */
  attempts = 0;
  keyId?: string;

  constructor(
    code: GeminiErrorCode,
    message: string,
    extra: { httpStatus?: number; retryAfterMs?: number; quotaKind?: QuotaKind; mediaResolutionRejected?: boolean } = {},
  ) {
    super(message);
    this.code = code;
    this.httpStatus = extra.httpStatus;
    this.retryAfterMs = extra.retryAfterMs;
    this.quotaKind = extra.quotaKind;
    this.mediaResolutionRejected = extra.mediaResolutionRejected;
  }
}

/** 다른 키로 다시 보내면 해결될 수 있는 오류 */
const FAILOVER_CODES = new Set<GeminiErrorCode>([
  'rate_limited',
  'invalid_key',
  'upstream_error',
  'network',
  'stalled',
  'incomplete',
  'truncated',
  'empty_response',
  'invalid_json',
]);

const BLOCK_FINISH_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'LANGUAGE']);

export type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

export interface GeminiRequest {
  /** 토큰 추정 보정용 요청 종류 */
  kind?: 'analyze' | 'weekly';
  systemPrompt: string;
  parts: GeminiPart[];
  responseSchema: Record<string, unknown>;
  /** interactive = 사용자 요청(빠르게, hedging), batch = 주간 배치(기다려도 됨, 일일 예산 일부를 남김) */
  priority?: Priority;
  /** 전체 제한 시간 (failover/hedging 포함) */
  deadlineMs?: number;
}

export interface GeminiResult {
  text: string;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number;
  keyId: string;
  /** 보낸 HTTP 요청 수 (failover / hedging 포함) */
  attempts: number;
  hedged: boolean;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GeminiTuning {
  stream: boolean;
  streamThoughts: boolean;
  stallTimeoutMs: number;
  hedgeAfterMs: number;
  hedgeMinBudgetRatio: number;
  maxLaunches: number;
  acquireWaitMs: number;
  batchAcquireWaitMs: number;
  maxOutputTokens: number;
  thinkingLevel: string;
  minAttemptMs: number;
}

export interface GeminiDeps {
  fetchImpl?: FetchLike;
  pool?: GeminiKeyPool;
  tuning?: Partial<GeminiTuning>;
  /** 호출자가 취소할 때 (예: 사용자가 분석 작업을 취소) */
  signal?: AbortSignal;
}

// -----------------------------------------------------------------------------
// 입력 토큰 추정 (TPM 예약용). 실제 promptTokenCount 로 요청 종류별 보정 비율을 학습한다.
// Gemini 3 이미지 토큰은 픽셀 크기가 아니라 해상도 레벨로 정해진다.
// -----------------------------------------------------------------------------
const IMAGE_TOKENS: Record<string, number> = {
  MEDIA_RESOLUTION_LOW: 280,
  MEDIA_RESOLUTION_MEDIUM: 560,
  MEDIA_RESOLUTION_HIGH: 1120,
};
const DEFAULT_IMAGE_TOKENS = 1120;
const tokenRatio = new Map<string, number>();
/** 모델이 mediaResolution 설정을 거부하면 이후 요청에서 뺀다 */
let mediaResolutionDisabled = false;

function activeMediaResolution(): string {
  return mediaResolutionDisabled ? '' : config.gemini.mediaResolution.toUpperCase();
}

function rawTokenEstimate(req: GeminiRequest): number {
  let chars = req.systemPrompt.length;
  let images = 0;
  for (const p of req.parts) {
    if ('text' in p) chars += p.text.length;
    else images += 1;
  }
  // 한국어 위주 텍스트: 글자당 약 0.7 토큰으로 보수적으로 잡는다
  const perImage = IMAGE_TOKENS[activeMediaResolution()] ?? DEFAULT_IMAGE_TOKENS;
  return Math.ceil(chars * 0.7) + images * perImage + 32;
}

export function estimateInputTokens(req: GeminiRequest): number {
  const ratio = tokenRatio.get(req.kind ?? 'default') ?? 1;
  return Math.ceil(rawTokenEstimate(req) * ratio);
}

function learnTokenRatio(req: GeminiRequest, actual: number | null) {
  if (!actual || actual <= 0) return;
  const key = req.kind ?? 'default';
  const observed = actual / rawTokenEstimate(req);
  const prev = tokenRatio.get(key);
  // 약간 넉넉하게(×1.1) 잡아 과소 추정으로 429 가 나지 않게
  tokenRatio.set(key, prev === undefined ? observed * 1.1 : prev * 0.8 + observed * 1.1 * 0.2);
}

let sharedPool: GeminiKeyPool | null = null;

/** 서버 전역 키 풀 (사용량은 DB 에 저장해 재시작 후에도 유지) */
export function getKeyPool(): GeminiKeyPool {
  if (!sharedPool) {
    const g = config.gemini;
    sharedPool = new GeminiKeyPool(
      g.apiKeys,
      {
        rpmPerKey: g.rpmPerKey,
        tpmPerKey: g.tpmPerKey,
        rpdPerKey: g.rpdPerKey,
        maxConcurrentPerKey: g.maxConcurrencyPerKey,
        batchReserveRatio: g.batchReserveRatio,
        quotaTimeZone: g.quotaTimeZone,
        maxQueue: g.maxQueue,
      },
      config.isTest ? undefined : pgKeyUsageStore(),
    );
  }
  return sharedPool;
}

function defaultTuning(pool: GeminiKeyPool): GeminiTuning {
  const g = config.gemini;
  return {
    stream: g.stream,
    streamThoughts: g.streamThoughts,
    stallTimeoutMs: g.stallTimeoutMs,
    hedgeAfterMs: g.hedgeAfterMs,
    hedgeMinBudgetRatio: g.hedgeMinBudgetRatio,
    maxLaunches: Math.min(6, Math.max(2, pool.size + 2)),
    acquireWaitMs: g.queueWaitMs,
    batchAcquireWaitMs: 120_000,
    maxOutputTokens: g.maxOutputTokens,
    thinkingLevel: g.thinkingLevel,
    minAttemptMs: 2_000,
  };
}

// -----------------------------------------------------------------------------
// 응답 누적 / 완결성 검사
// -----------------------------------------------------------------------------
interface ChunkJson {
  error?: { code?: number; message?: string; status?: string; details?: unknown[] };
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

class ResponseAccumulator {
  text = '';
  thoughtChunks = 0;
  finishReason: string | null = null;
  usage: ChunkJson['usageMetadata'] | null = null;

  constructor(private readonly onProgress: () => void) {}

  push(chunk: ChunkJson) {
    if (chunk.error) throw errorFromBody(chunk.error, chunk.error.code ?? 500, null);
    if (chunk.promptFeedback?.blockReason) {
      throw new GeminiError('blocked', `blocked: ${chunk.promptFeedback.blockReason}`);
    }
    const cand = chunk.candidates?.[0];
    for (const p of cand?.content?.parts ?? []) {
      if (p.thought) this.thoughtChunks += 1; // 추론 요약: 답변에는 넣지 않고 진행 신호로만 사용
      else if (typeof p.text === 'string') this.text += p.text;
    }
    if (cand?.finishReason) this.finishReason = cand.finishReason;
    if (chunk.usageMetadata) this.usage = chunk.usageMetadata;
    this.onProgress();
  }

  finish(): { text: string; tokensIn: number | null; tokensOut: number | null } {
    const fr = this.finishReason;
    if (!fr) throw new GeminiError('incomplete', 'stream ended without finishReason');
    if (fr === 'MAX_TOKENS') throw new GeminiError('truncated', 'response truncated (MAX_TOKENS)');
    if (BLOCK_FINISH_REASONS.has(fr)) throw new GeminiError('blocked', `finishReason=${fr}`);
    if (fr !== 'STOP') throw new GeminiError('incomplete', `finishReason=${fr}`);
    if (!this.text.trim()) throw new GeminiError('empty_response', 'empty response');
    try {
      JSON.parse(this.text); // JSON 모드인데 파싱이 안 되면 중간에 깨진 응답
    } catch {
      throw new GeminiError('invalid_json', 'response text is not valid JSON');
    }
    const u = this.usage;
    return {
      text: this.text,
      tokensIn: u?.promptTokenCount ?? null,
      tokensOut: u ? (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) : null,
    };
  }
}

function parseRetryDelay(details: unknown[], header: string | null): number | undefined {
  for (const d of details) {
    const v = (d as { retryDelay?: unknown })?.retryDelay;
    if (typeof v === 'string') {
      const s = Number.parseFloat(v);
      if (Number.isFinite(s)) return Math.ceil(s * 1000);
    }
  }
  if (header && /^\d+$/.test(header)) return Number(header) * 1000;
  return undefined;
}

function errorFromBody(
  err: { message?: string; status?: string; details?: unknown[] },
  status: number,
  retryAfterHeader: string | null,
): GeminiError {
  const details = Array.isArray(err.details) ? err.details : [];
  const message = String(err.message ?? '').slice(0, 200);
  if (status === 429 || err.status === 'RESOURCE_EXHAUSTED') {
    const quotaIds = details.flatMap((d) => {
      const vs = (d as { violations?: Array<{ quotaId?: string; quotaMetric?: string }> })?.violations;
      return Array.isArray(vs) ? vs.map((v) => `${v.quotaId ?? ''} ${v.quotaMetric ?? ''}`) : [];
    });
    // 예) GenerateRequestsPerDayPerProjectPerModel-FreeTier / GenerateContentInputTokensPerModelPerMinute-FreeTier
    const quotaKind: QuotaKind = quotaIds.some((q) => /per\s*day|PerDay/i.test(q))
      ? 'daily'
      : quotaIds.some((q) => /token/i.test(q))
        ? 'tpm'
        : 'rpm';
    return new GeminiError('rate_limited', `429 quota exceeded (${quotaKind})`, {
      httpStatus: 429,
      quotaKind,
      retryAfterMs: parseRetryDelay(details, retryAfterHeader),
    });
  }
  const reasons = details.map((d) => (d as { reason?: string })?.reason).filter(Boolean);
  if (status === 401 || status === 403 || reasons.includes('API_KEY_INVALID') || /api key not valid/i.test(message)) {
    return new GeminiError('invalid_key', `auth error ${status}`, { httpStatus: status });
  }
  if (status === 400 || status === 404) {
    return new GeminiError('bad_request', `${status}: ${message}`, {
      httpStatus: status,
      mediaResolutionRejected: status === 400 && /media_?resolution/i.test(message),
    });
  }
  return new GeminiError('upstream_error', `upstream ${status}`, { httpStatus: status });
}

async function errorFromResponse(res: Response): Promise<GeminiError> {
  let body: { error?: ChunkJson['error'] } | null = null;
  try {
    body = (await res.json()) as { error?: ChunkJson['error'] };
  } catch {
    // 본문 없음
  }
  return errorFromBody(body?.error ?? {}, res.status, res.headers.get('retry-after'));
}

// -----------------------------------------------------------------------------
// 단일 시도 (키 1개로 HTTP 요청 1번)
// -----------------------------------------------------------------------------
interface AttemptMode {
  thinkingLevel: string;
  maxOutputTokens: number;
}

function requestBody(req: GeminiRequest, mode: AttemptMode, t: GeminiTuning) {
  return {
    systemInstruction: { parts: [{ text: req.systemPrompt }] },
    contents: [{ role: 'user', parts: req.parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: req.responseSchema,
      maxOutputTokens: mode.maxOutputTokens,
      ...(activeMediaResolution() ? { mediaResolution: activeMediaResolution() } : {}),
      thinkingConfig: {
        thinkingLevel: mode.thinkingLevel.toUpperCase(),
        ...(t.stream && t.streamThoughts ? { includeThoughts: true } : {}),
      },
    },
  };
}

async function runOnce(
  apiKey: string,
  req: GeminiRequest,
  mode: AttemptMode,
  t: GeminiTuning,
  fetchImpl: FetchLike,
  deadlineAt: number,
  parentSignal: AbortSignal,
  onProgress: () => void,
) {
  const ctrl = new AbortController();
  let reason: 'stalled' | 'timeout' | 'aborted' | null = null;
  const abort = (r: 'stalled' | 'timeout' | 'aborted') => {
    if (!reason) {
      reason = r;
      ctrl.abort();
    }
  };
  const onParentAbort = () => abort('aborted');
  if (parentSignal.aborted) abort('aborted');
  parentSignal.addEventListener('abort', onParentAbort, { once: true });

  const deadlineTimer = setTimeout(() => abort('timeout'), Math.max(1, deadlineAt - Date.now()));
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  // 추론 요약을 받지 않으면 첫 데이터까지 오래 걸릴 수 있으므로 첫 대기만 길게 잡는다
  let firstWait = t.stream && t.streamThoughts ? t.stallTimeoutMs : Math.max(t.stallTimeoutMs, 25_000);
  const bump = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => abort('stalled'), firstWait);
  };
  bump();
  const progress = () => {
    firstWait = t.stallTimeoutMs;
    bump();
    onProgress();
  };

  const { apiBase, model } = config.gemini;
  const url = t.stream
    ? `${apiBase}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
    : `${apiBase}/models/${encodeURIComponent(model)}:generateContent`;

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(requestBody(req, mode, t)),
      signal: ctrl.signal,
    });
    if (!res.ok) throw await errorFromResponse(res);

    const acc = new ResponseAccumulator(progress);
    const ctype = res.headers.get('content-type') ?? '';
    if (!t.stream || !res.body || ctype.includes('application/json')) {
      acc.push((await res.json()) as ChunkJson);
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const handleEvent = (evt: string) => {
        const data = evt
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data || data === '[DONE]') return;
        let json: ChunkJson;
        try {
          json = JSON.parse(data) as ChunkJson;
        } catch {
          throw new GeminiError('invalid_json', 'broken SSE chunk');
        }
        acc.push(json);
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bump(); // 바이트가 들어오면 정체 타이머 연장 (keep-alive 포함)
        buf += decoder.decode(value, { stream: true });
        for (let m = /\r?\n\r?\n/.exec(buf); m; m = /\r?\n\r?\n/.exec(buf)) {
          const evt = buf.slice(0, m.index);
          buf = buf.slice(m.index + m[0].length);
          handleEvent(evt);
        }
      }
      buf += decoder.decode();
      if (buf.trim()) handleEvent(buf);
    }
    return acc.finish();
  } catch (err) {
    if (reason === 'stalled') throw new GeminiError('stalled', `no data for ${t.stallTimeoutMs}ms`);
    if (reason === 'timeout') throw new GeminiError('timeout', 'deadline exceeded');
    if (reason === 'aborted') throw new GeminiError('aborted', 'aborted');
    if (err instanceof GeminiError) throw err;
    throw new GeminiError('network', `network error: ${(err as Error)?.name ?? 'unknown'}`);
  } finally {
    clearTimeout(deadlineTimer);
    clearTimeout(stallTimer);
    parentSignal.removeEventListener('abort', onParentAbort);
  }
}

type AttemptOutcome =
  | { ok: true; result: Omit<GeminiResult, 'attempts' | 'hedged'> }
  | { ok: false; error: GeminiError };

interface Running {
  done: Promise<AttemptOutcome>;
  progressed: () => boolean;
  label: string;
}

function startAttempt(
  lease: KeyLease,
  req: GeminiRequest,
  mode: AttemptMode,
  t: GeminiTuning,
  fetchImpl: FetchLike,
  deadlineAt: number,
  parentSignal: AbortSignal,
): Running {
  let progressed = false;
  const started = Date.now();
  const done = runOnce(lease.apiKey, req, mode, t, fetchImpl, deadlineAt, parentSignal, () => {
    progressed = true;
  }).then(
    (r): AttemptOutcome => {
      const latencyMs = Date.now() - started;
      lease.release({ kind: 'success', latencyMs, tokensIn: r.tokensIn, tokensOut: r.tokensOut });
      return {
        ok: true,
        result: { text: r.text, model: config.gemini.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, latencyMs, keyId: lease.keyId },
      };
    },
    (e: unknown): AttemptOutcome => {
      const err = e instanceof GeminiError ? e : new GeminiError('network', 'unexpected error');
      err.keyId = lease.keyId;
      if (err.code === 'aborted') {
        lease.release({ kind: 'aborted' });
      } else {
        lease.release({ kind: 'error', error: err });
        console.warn(`[gemini] ${lease.label} 실패 code=${err.code}${err.httpStatus ? ` status=${err.httpStatus}` : ''}`);
      }
      return { ok: false, error: err };
    },
  );
  return { done, progressed: () => progressed, label: lease.label };
}

// -----------------------------------------------------------------------------
// 공개 API
// -----------------------------------------------------------------------------
export async function generateJson(req: GeminiRequest, deps: GeminiDeps = {}): Promise<GeminiResult> {
  const pool = deps.pool ?? getKeyPool();
  const t: GeminiTuning = { ...defaultTuning(pool), ...deps.tuning };
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (pool.size === 0) throw new GeminiError('not_configured', 'no Gemini API key configured');

  const priority = req.priority ?? 'interactive';
  const startedAt = Date.now();
  const deadlineAt =
    startedAt + (req.deadlineMs ?? (priority === 'batch' ? config.gemini.batchTimeoutMs : config.gemini.timeoutMs));
  const tried = new Set<string>();
  const running = new Set<Running>();
  const parent = new AbortController();
  const onCallerAbort = () => parent.abort();
  if (deps.signal?.aborted) throw new GeminiError('aborted', 'aborted by caller');
  deps.signal?.addEventListener('abort', onCallerAbort, { once: true });
  let mode: AttemptMode = { thinkingLevel: t.thinkingLevel, maxOutputTokens: t.maxOutputTokens };
  let launches = 0;
  let hedged = false;
  let lastError: GeminiError | null = null;

  const launch = async (waitMs: number): Promise<boolean> => {
    if (launches >= t.maxLaunches || parent.signal.aborted) return false;
    const remaining = deadlineAt - Date.now();
    if (remaining < t.minAttemptMs) return false;
    const lease = await pool.acquire({
      priority,
      avoid: tried,
      tokens: estimateInputTokens(req),
      waitMs: Math.max(0, Math.min(waitMs, remaining - t.minAttemptMs)),
    });
    if (!lease) return false;
    if (parent.signal.aborted) {
      lease.release({ kind: 'aborted' });
      return false;
    }
    tried.add(lease.keyId);
    launches += 1;
    running.add(startAttempt(lease, req, { ...mode }, t, fetchImpl, deadlineAt, parent.signal));
    return true;
  };

  const finalError = (): GeminiError => {
    let e = lastError;
    if (!e || (e.code === 'rate_limited' && pool.isExhausted(priority))) {
      e = pool.isExhausted(priority)
        ? new GeminiError('quota_exhausted', 'all API keys exhausted for today')
        : (e ?? new GeminiError('all_keys_busy', 'no API key available right now'));
    }
    e.attempts = launches;
    return e;
  };

  const waitForKey = () => (priority === 'batch' ? t.batchAcquireWaitMs : t.acquireWaitMs);

  try {
    if (!(await launch(waitForKey()))) throw finalError();

    while (running.size > 0) {
      type Ev = { kind: 'done'; r: Running; o: AttemptOutcome } | { kind: 'hedge' };
      const events: Array<Promise<Ev>> = [...running].map((r) => r.done.then((o): Ev => ({ kind: 'done', r, o })));
      let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
      if (!hedged && priority === 'interactive' && t.hedgeAfterMs > 0 && running.size === 1 && launches < t.maxLaunches) {
        events.push(
          new Promise<Ev>((resolve) => {
            hedgeTimer = setTimeout(() => resolve({ kind: 'hedge' }), Math.max(0, startedAt + t.hedgeAfterMs - Date.now()));
          }),
        );
      }
      const ev = await Promise.race(events);
      clearTimeout(hedgeTimer);

      if (ev.kind === 'hedge') {
        hedged = true;
        const only = [...running][0];
        // 첫 데이터조차 없는 느린 요청이면 다른 키로 예비 요청 (예산이 충분할 때만)
        if (
          only &&
          !only.progressed() &&
          pool.canHedge(tried, t.hedgeMinBudgetRatio, estimateInputTokens(req)) &&
          (await launch(0))
        ) {
          console.info(`[gemini] ${only.label} 응답 지연 → 다른 키로 병렬 요청(hedge)`);
        }
        continue;
      }

      running.delete(ev.r);
      if (ev.o.ok) {
        learnTokenRatio(req, ev.o.result.tokensIn);
        return { ...ev.o.result, attempts: launches, hedged };
      }
      const err = ev.o.error;
      if (err.code === 'aborted') {
        if (parent.signal.aborted && running.size === 0) {
          err.attempts = launches;
          throw err; // 호출자가 취소
        }
        continue;
      }
      lastError = err;
      if (err.code === 'truncated') {
        // 잘림: 다음 시도는 추론을 줄이고 출력 한도를 늘린다
        mode = { thinkingLevel: 'low', maxOutputTokens: Math.min(mode.maxOutputTokens * 2, 65_536) };
      }
      if (err.mediaResolutionRejected && !mediaResolutionDisabled) {
        // 모델이 mediaResolution 을 지원하지 않음 → 끄고 바로 다시 요청
        mediaResolutionDisabled = true;
        console.warn('[gemini] 모델이 mediaResolution 설정을 거부해 기본 해상도로 전환합니다.');
        if (running.size === 0 && (await launch(0))) continue;
      }
      if (!FAILOVER_CODES.has(err.code)) {
        err.attempts = launches;
        throw err; // 차단/잘못된 요청/제한 시간 초과 → 다른 키로 보내도 소용없음
      }
      if (running.size === 0) {
        // failover: 다른 키로 즉시 재요청 (같은 키는 가능한 한 피한다)
        const wait = priority === 'batch' ? Math.min(t.batchAcquireWaitMs, (err.retryAfterMs ?? 0) + 1_000) : t.acquireWaitMs;
        if (!(await launch(wait))) break;
      }
    }
    throw finalError();
  } finally {
    deps.signal?.removeEventListener('abort', onCallerAbort);
    parent.abort(); // 남은(진) 요청 취소
  }
}

/** 테스트용: 모듈 전역 상태 초기화 */
export function __resetGeminiStateForTests() {
  tokenRatio.clear();
  mediaResolutionDisabled = false;
  sharedPool = null;
}

const promptCache = new Map<string, string>();

/** prompts/<name>.md 를 읽는다 (시스템 프롬프트는 용도별로 파일을 분리) */
export function loadPrompt(name: 'food_analysis' | 'weekly_adjustment'): string {
  let p = promptCache.get(name);
  if (!p) {
    p = fs.readFileSync(path.join(config.promptsDir, `${name}.md`), 'utf8');
    promptCache.set(name, p);
  }
  return p;
}
