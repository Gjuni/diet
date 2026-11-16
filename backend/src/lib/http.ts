import net from 'node:net';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import type { ClientInfo } from '../services/refreshTokens.js';
import { HttpError } from './errors.js';

export const REFRESH_COOKIE = 'diet_rt';
const REFRESH_COOKIE_PATH = '/api/auth';

/** inet 컬럼에 넣을 수 있는 IP 만 (IPv6 zone id 등 제거) */
function cleanIp(ip: string | undefined): string | null {
  if (!ip) return null;
  const v = ip.split('%')[0]!;
  return net.isIP(v) ? v : null;
}

export function clientInfo(req: Request): ClientInfo {
  return {
    userAgent: req.get('user-agent')?.slice(0, 512) ?? null,
    ip: cleanIp(req.ip),
  };
}

/** Refresh Token 쿠키: httpOnly + Secure + SameSite=Strict, /api/auth 경로에서만 전송 */
export function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    maxAge: config.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
  });
}

export function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
  });
}

export function readRefreshCookie(req: Request): string | undefined {
  const v = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
  return typeof v === 'string' ? v : undefined;
}

/**
 * 쿠키로 인증하는 엔드포인트(refresh/logout)의 CSRF 방어(심층 방어).
 * SameSite=Strict 에 더해, 사용자 정의 헤더를 요구해 교차 출처 요청은 preflight 없이 보낼 수 없게 한다.
 */
export function requireCsrfHeader(req: Request, _res: Response, next: () => void) {
  if (req.get('x-requested-with') !== 'fetch') {
    throw new HttpError(403, 'CSRF', '허용되지 않은 요청입니다.');
  }
  next();
}
