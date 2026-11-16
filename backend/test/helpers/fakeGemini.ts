/** Gemini REST 응답 흉내 (SSE 스트림 / JSON / 오류) */

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SseOptions {
  /** 청크 사이 지연 */
  delayMs?: number;
  /** 첫 청크 전 지연 */
  firstDelayMs?: number;
  /** n 번째 청크를 보낸 뒤 멈춤(끊기지도 않고 데이터도 없음 = 정체) */
  hangAfter?: number;
  /** n 번째 청크까지 보내고 스트림을 그냥 닫음 (finishReason 없이 끊김) */
  cutAfter?: number;
  /** 이벤트 경계를 일부러 바이트 중간에서 자른다 */
  splitBytes?: boolean;
}

export function sse(chunks: unknown[], signal?: AbortSignal | null, o: SseOptions = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const onAbort = () => {
        try {
          controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        } catch {
          // 이미 닫힘
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (o.firstDelayMs) await sleep(o.firstDelayMs);
      for (let i = 0; i < chunks.length; i++) {
        if (signal?.aborted) return;
        if (i > 0 && o.delayMs) await sleep(o.delayMs);
        const bytes = enc.encode(`data: ${JSON.stringify(chunks[i])}\r\n\r\n`);
        if (o.splitBytes) {
          const mid = Math.floor(bytes.length / 2);
          controller.enqueue(bytes.slice(0, mid));
          await sleep(1);
          controller.enqueue(bytes.slice(mid));
        } else {
          controller.enqueue(bytes);
        }
        if (o.hangAfter === i) return; // 정체: 닫지 않음
        if (o.cutAfter === i) {
          controller.close();
          return;
        }
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** 답변 JSON 을 thought 청크 + 답변 2조각 + 종료 청크로 나눈 스트림 */
export function answerChunks(answer: unknown, opts: { finishReason?: string; promptTokens?: number } = {}) {
  const text = JSON.stringify(answer);
  const mid = Math.floor(text.length / 2);
  return [
    { candidates: [{ content: { parts: [{ text: '사진 속 음식을 살펴보는 중', thought: true }] } }] },
    { candidates: [{ content: { parts: [{ text: text.slice(0, mid) }] } }] },
    {
      candidates: [{ content: { parts: [{ text: text.slice(mid) }] }, finishReason: opts.finishReason ?? 'STOP' }],
      usageMetadata: { promptTokenCount: opts.promptTokens ?? 2500, candidatesTokenCount: 120, thoughtsTokenCount: 300 },
    },
  ];
}

export function errorResponse(status: number, error: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error: { code: status, ...error } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const rateLimit = (kind: 'day' | 'minute' | 'tokens', retryDelay = '7s') =>
  errorResponse(429, {
    status: 'RESOURCE_EXHAUSTED',
    message: 'quota exceeded',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          {
            quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId:
              kind === 'day'
                ? 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'
                : kind === 'tokens'
                  ? 'GenerateContentInputTokensPerModelPerMinute-FreeTier'
                  : 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
          },
        ],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
    ],
  });

export function keyOf(init: RequestInit): string {
  return (init.headers as Record<string, string>)['x-goog-api-key']!;
}
