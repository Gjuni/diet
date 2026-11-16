import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { HttpError } from '../lib/errors.js';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: '요청한 API 를 찾을 수 없습니다.' } });
}

/**
 * 공통 에러 응답. 요청 본문/업로드 파일은 절대 로그에 남기지 않는다 (이미지 미보관 원칙).
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) return;

  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.details } });
    return;
  }

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: { code: 'FILE_TOO_LARGE', message: '이미지 용량은 10MB 이하여야 합니다.' } });
      return;
    }
    res.status(400).json({ error: { code: 'UPLOAD_ERROR', message: '이미지 업로드 형식이 올바르지 않습니다.' } });
    return;
  }

  const e = err as { type?: string; status?: number; code?: string; constraint?: string; message?: string };
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: '요청 본문(JSON) 형식이 올바르지 않습니다.' } });
    return;
  }
  if (e?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: '요청 본문이 너무 큽니다.' } });
    return;
  }
  // PostgreSQL CHECK 제약 위반 → 400 (앱 검증을 통과했더라도 DB 가 마지막 방어선)
  if (e?.code === '23514' || e?.code === '22003') {
    res.status(400).json({ error: { code: 'CONSTRAINT_VIOLATION', message: '입력값이 허용 범위를 벗어났습니다.' } });
    return;
  }

  console.error(`[error] ${req.method} ${req.path}:`, e?.message ?? err);
  res.status(500).json({ error: { code: 'INTERNAL', message: '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' } });
}
