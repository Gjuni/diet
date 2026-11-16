import type { NextFunction, Request, Response } from 'express';
import { pool, queryOne } from '../db.js';
import { unauthorized } from '../lib/errors.js';
import { TokenError, verifyAccessToken, verifyPasswordChangeToken } from '../lib/tokens.js';
import type { PasswordChangeAuth } from '../services/authService.js';
import type { AuthContext } from '../types/express.js';

function bearer(req: Request): string | null {
  const h = req.get('authorization');
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1]! : null;
}

interface AuthUserRow {
  id: string;
  email: string;
  nickname: string;
  token_version: number;
  deleted_at: Date | null;
}

async function loadUser(userId: string, tokenVersion: number): Promise<AuthUserRow> {
  const user = await queryOne<AuthUserRow>(
    pool,
    `SELECT id, email, nickname, token_version, deleted_at FROM users WHERE id = $1`,
    [userId],
  );
  // tokenVersion 이 다르면 (모든 기기 로그아웃 / 비밀번호 변경) 기존 access token 은 즉시 무효
  if (!user || user.deleted_at || user.token_version !== tokenVersion) {
    throw unauthorized('다시 로그인해 주세요.', 'TOKEN_REVOKED');
  }
  return user;
}

/** 일반 API: 정상 Access Token 만 허용 (비밀번호 변경 전용 토큰은 키가 달라 검증에 실패한다) */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = bearer(req);
  if (!token) throw unauthorized();
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    if (err instanceof TokenError && err.expired) throw unauthorized('로그인이 만료되었습니다.', 'TOKEN_EXPIRED');
    throw unauthorized('인증 정보가 올바르지 않습니다.', 'TOKEN_INVALID');
  }
  const user = await loadUser(payload.userId, payload.tokenVersion);
  req.auth = { userId: user.id, email: user.email, nickname: user.nickname };
  next();
}

export function getAuth(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/**
 * 비밀번호 변경 API 전용: 정상 Access Token 또는 "비밀번호 변경 전용 제한 토큰" 중 하나.
 * 제한 토큰은 오직 이 경로에서만 받아준다.
 */
export async function resolvePasswordChangeAuth(req: Request): Promise<PasswordChangeAuth> {
  const token = bearer(req);
  if (!token) throw unauthorized();
  try {
    const p = verifyAccessToken(token);
    await loadUser(p.userId, p.tokenVersion);
    return { kind: 'session', userId: p.userId };
  } catch (err) {
    if (!(err instanceof TokenError)) throw err;
  }
  try {
    const p = verifyPasswordChangeToken(token);
    return { kind: 'reset', userId: p.userId, resetId: p.resetId, tokenVersion: p.tokenVersion };
  } catch (err) {
    if (err instanceof TokenError && err.expired) {
      throw unauthorized('비밀번호 변경 시간이 만료되었습니다. 다시 로그인해 주세요.', 'PASSWORD_CHANGE_TOKEN_INVALID');
    }
    throw unauthorized('인증 정보가 올바르지 않습니다.', 'TOKEN_INVALID');
  }
}
