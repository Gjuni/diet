import { z } from 'zod';
import { badRequest, futureDateForbidden } from './errors.js';
import { clock, isFutureDate, isValidDateString } from './time.js';

/** zod 스키마로 검증하고 실패하면 400 (첫 번째 오류 메시지를 사용자에게 보여준다) */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw badRequest(issue?.message ?? '입력값이 올바르지 않습니다.', 'VALIDATION_ERROR', {
      field: issue?.path.join('.') || undefined,
    });
  }
  return r.data;
}

export const dateString = z
  .string()
  .refine((s) => isValidDateString(s), { message: '날짜 형식이 올바르지 않습니다 (YYYY-MM-DD).' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const uuid = z.string().regex(UUID_RE, { message: '잘못된 ID 입니다.' });

export function parseUuidParam(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw badRequest('잘못된 ID 입니다.');
  return value.toLowerCase();
}

export const email = z
  .string({ message: '이메일을 입력해 주세요.' })
  .trim()
  .max(254, { message: '이메일이 너무 깁니다.' })
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { message: '이메일 형식이 올바르지 않습니다.' });

/** ISO 8601 (오프셋 포함) 시각 문자열 → Date */
export const isoInstant = z
  .string({ message: '시각을 입력해 주세요.' })
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/, {
    message: '시각 형식이 올바르지 않습니다 (예: 2026-11-16T12:30:00+09:00).',
  })
  .transform((s) => new Date(s))
  .refine((d) => Number.isFinite(d.getTime()) && d.getTime() >= Date.UTC(2000, 0, 1), {
    message: '시각이 올바르지 않습니다.',
  });

/** 1자리 소수로 반올림한 숫자 */
export const decimal1 = (min: number, max: number, label: string) =>
  z
    .number({ message: `${label}은(는) 숫자여야 합니다.` })
    .min(min, { message: `${label}은(는) ${min} 이상이어야 합니다.` })
    .max(max, { message: `${label}은(는) ${max} 이하여야 합니다.` })
    .transform((v) => Math.round(v * 10) / 10);

/** 경로의 :date 검증 + (쓰기 요청이면) 미래 날짜 거부(403) */
export function parseDateParam(value: unknown, opts: { forbidFuture: boolean }): string {
  if (!isValidDateString(value)) throw badRequest('날짜 형식이 올바르지 않습니다 (YYYY-MM-DD).');
  if (opts.forbidFuture && isFutureDate(value, clock.now())) throw futureDateForbidden();
  return value;
}

/** 모든 쓰기 API 공통: local_date 가 오늘(KST) 이하인지 확인 */
export function assertNotFuture(localDate: string): void {
  if (isFutureDate(localDate, clock.now())) throw futureDateForbidden();
}
