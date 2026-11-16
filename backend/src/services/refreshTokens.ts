import crypto from 'node:crypto';
import { generateRefreshToken, hashRefreshToken } from '../lib/tokens.js';

/**
 * Refresh Token rotation + 재사용(탈취) 탐지
 *
 *  - 원문은 클라이언트(httpOnly 쿠키)에만 있고, 저장소에는 SHA-256 해시만 있다.
 *  - 사용할 때마다 같은 family 로 새 토큰을 발급하고 기존 토큰은 폐기(rotated)한다.
 *  - 이미 폐기된 토큰이 다시 들어오면 탈취로 보고 그 family 전체를 폐기한다.
 *  - family = 하나의 로그인 세션(기기). user_agent / 생성 시각 / 마지막 사용 시각을 함께 기록한다.
 *
 * 저장소는 인터페이스로 분리해 PostgreSQL 구현(운영)과 메모리 구현(단위 테스트)을 바꿔 끼운다.
 */

export type RevokeReason =
  | 'rotated'
  | 'logout'
  | 'logout_all'
  | 'reuse_detected'
  | 'password_changed'
  | 'account_deleted';

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: RevokeReason | null;
  replacedBy: string | null;
  userAgent: string | null;
  ip: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface NewRefreshToken {
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
}

export interface RefreshTokenRepo {
  insert(token: NewRefreshToken): Promise<RefreshTokenRecord>;
  /** 동시 rotation 을 직렬화하기 위해 행 잠금(SELECT ... FOR UPDATE)으로 조회한다 */
  findByHashForUpdate(tokenHash: string): Promise<RefreshTokenRecord | null>;
  markRotated(id: string, replacedBy: string, now: Date): Promise<void>;
  revokeFamily(familyId: string, reason: RevokeReason, now: Date): Promise<number>;
  revokeAllForUser(userId: string, reason: RevokeReason, now: Date): Promise<number>;
}

export interface ClientInfo {
  userAgent: string | null;
  ip: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** base64url(32 bytes) = 43자 */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export async function issueRefreshToken(
  repo: RefreshTokenRepo,
  userId: string,
  client: ClientInfo,
  now: Date,
  ttlDays: number,
  familyId: string = crypto.randomUUID(),
): Promise<{ token: string; record: RefreshTokenRecord }> {
  const token = generateRefreshToken();
  const record = await repo.insert({
    userId,
    tokenHash: hashRefreshToken(token),
    familyId,
    expiresAt: new Date(now.getTime() + ttlDays * DAY_MS),
    userAgent: client.userAgent,
    ip: client.ip,
    createdAt: now,
  });
  return { token, record };
}

export type RotateResult =
  | { status: 'rotated'; token: string; record: RefreshTokenRecord; previous: RefreshTokenRecord }
  | { status: 'invalid' }
  | { status: 'expired'; userId: string }
  | { status: 'reuse_detected'; userId: string; familyId: string; revokedCount: number };

export async function rotateRefreshToken(
  repo: RefreshTokenRepo,
  presentedToken: string,
  client: ClientInfo,
  now: Date,
  ttlDays: number,
): Promise<RotateResult> {
  if (typeof presentedToken !== 'string' || !TOKEN_RE.test(presentedToken)) return { status: 'invalid' };

  const current = await repo.findByHashForUpdate(hashRefreshToken(presentedToken));
  if (!current) return { status: 'invalid' };

  // 이미 폐기된 토큰이 다시 사용됨 → 탈취로 간주, family 전체 폐기
  if (current.revokedAt) {
    const revokedCount = await repo.revokeFamily(current.familyId, 'reuse_detected', now);
    return { status: 'reuse_detected', userId: current.userId, familyId: current.familyId, revokedCount };
  }

  if (current.expiresAt.getTime() <= now.getTime()) return { status: 'expired', userId: current.userId };

  const next = await issueRefreshToken(repo, current.userId, client, now, ttlDays, current.familyId);
  await repo.markRotated(current.id, next.record.id, now);
  return { status: 'rotated', token: next.token, record: next.record, previous: current };
}
