import { rateLimit } from 'express-rate-limit';

const make = (windowMs: number, limit: number, message: string) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message } });
    },
  });

/** IP별 제한 (메모리 저장소: 단일 인스턴스 기준. 다중 인스턴스면 Redis 저장소로 교체) */
export const loginLimiter = make(15 * 60_000, 20, '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.');
export const signupLimiter = make(60 * 60_000, 10, '가입 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
export const forgotLimiter = make(60 * 60_000, 10, '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
export const refreshLimiter = make(15 * 60_000, 120, '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
export const passwordChangeLimiter = make(15 * 60_000, 10, '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
export const analyzeLimiter = make(60_000, 10, '분석 요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.');
export const apiLimiter = make(60_000, 300, '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
