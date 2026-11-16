import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

/**
 * 키 분리: 같은 JWT_SECRET 에서 용도별 키를 파생한다.
 * → 비밀번호 변경 전용 제한 토큰을 일반 API 의 Access Token 으로 쓸 수 없고, 그 반대도 불가능하다.
 */
const deriveKey = (purpose: string) => crypto.createHmac('sha256', config.jwtSecret).update(purpose).digest();
const ACCESS_KEY = deriveKey('diet/access-token/v1');
const PASSWORD_CHANGE_KEY = deriveKey('diet/password-change-token/v1');

export interface AccessTokenPayload {
  userId: string;
  tokenVersion: number;
}

export interface PasswordChangeTokenPayload {
  userId: string;
  tokenVersion: number;
  resetId: string;
  scope: 'password_change';
}

export class TokenError extends Error {
  readonly expired: boolean;
  constructor(message: string, expired = false) {
    super(message);
    this.expired = expired;
  }
}

function verify(token: string, key: Buffer): jwt.JwtPayload {
  try {
    const decoded = jwt.verify(token, key, { algorithms: ['HS256'] });
    if (typeof decoded !== 'object' || decoded === null) throw new TokenError('invalid token');
    return decoded;
  } catch (err) {
    if (err instanceof TokenError) throw err;
    if (err instanceof jwt.TokenExpiredError) throw new TokenError('token expired', true);
    throw new TokenError('invalid token');
  }
}

/** Access Token: JWT(HS256), 만료 15분, payload 는 userId / tokenVersion 만 */
export function signAccessToken(payload: AccessTokenPayload): string {
  const body: AccessTokenPayload = { userId: payload.userId, tokenVersion: payload.tokenVersion };
  return jwt.sign(body, ACCESS_KEY, { algorithm: 'HS256', expiresIn: config.accessTokenTtlSec });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const d = verify(token, ACCESS_KEY);
  if (typeof d.userId !== 'string' || !Number.isInteger(d.tokenVersion)) throw new TokenError('invalid payload');
  return { userId: d.userId, tokenVersion: d.tokenVersion as number };
}

/** 임시 비밀번호 로그인 후 발급하는 "비밀번호 변경 전용" 제한 토큰 */
export function signPasswordChangeToken(p: Omit<PasswordChangeTokenPayload, 'scope'>): string {
  const body: PasswordChangeTokenPayload = {
    userId: p.userId,
    tokenVersion: p.tokenVersion,
    resetId: p.resetId,
    scope: 'password_change',
  };
  return jwt.sign(body, PASSWORD_CHANGE_KEY, { algorithm: 'HS256', expiresIn: config.passwordChangeTokenTtlSec });
}

export function verifyPasswordChangeToken(token: string): PasswordChangeTokenPayload {
  const d = verify(token, PASSWORD_CHANGE_KEY);
  if (
    d.scope !== 'password_change' ||
    typeof d.userId !== 'string' ||
    typeof d.resetId !== 'string' ||
    !Number.isInteger(d.tokenVersion)
  ) {
    throw new TokenError('invalid payload');
  }
  return { userId: d.userId, tokenVersion: d.tokenVersion as number, resetId: d.resetId, scope: 'password_change' };
}

/** Refresh Token 원문: 32바이트 랜덤, base64url (불투명 토큰) */
export function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** DB 에는 원문 대신 SHA-256 hex 만 저장 */
export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}
