/** API 에러. 응답 형식: { error: { code, message, ...details } } */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, code = 'VALIDATION_ERROR', details?: Record<string, unknown>) =>
  new HttpError(400, code, message, details);

export const unauthorized = (message = '로그인이 필요합니다.', code = 'UNAUTHORIZED') =>
  new HttpError(401, code, message);

export const forbidden = (message = '접근할 수 없습니다.', code = 'FORBIDDEN') => new HttpError(403, code, message);

export const notFound = (message = '대상을 찾을 수 없습니다.') => new HttpError(404, 'NOT_FOUND', message);

export const conflict = (message: string, code = 'CONFLICT') => new HttpError(409, code, message);

export const tooManyRequests = (message: string, code = 'RATE_LIMITED', details?: Record<string, unknown>) =>
  new HttpError(429, code, message, details);

export const futureDateForbidden = () =>
  new HttpError(403, 'FUTURE_DATE', '미래 날짜에는 기록할 수 없습니다.');
