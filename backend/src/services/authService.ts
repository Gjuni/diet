import crypto from 'node:crypto';
import { config } from '../config.js';
import { pool, query, queryOne, withTransaction, type Db } from '../db.js';
import { badRequest, conflict, HttpError, unauthorized } from '../lib/errors.js';
import { sendPasswordChangedMail, sendTempPasswordMail } from '../lib/mailer.js';
import {
  dummyVerify,
  generateTempPassword,
  hashPassword,
  needsRehash,
  passwordPolicyError,
  verifyPassword,
  type StoredPassword,
} from '../lib/password.js';
import { clock } from '../lib/time.js';
import { signAccessToken, signPasswordChangeToken, hashRefreshToken } from '../lib/tokens.js';
import { pgRefreshTokenRepo } from '../repositories/pgRefreshTokenRepo.js';
import { issueRefreshToken, rotateRefreshToken, type ClientInfo } from './refreshTokens.js';

export interface PublicUser {
  id: string;
  email: string;
  nickname: string;
  created_at: Date;
}

interface UserRow extends PublicUser {
  password_hash: Buffer;
  password_salt: Buffer;
  password_algo: string;
  password_iterations: number;
  token_version: number;
  failed_login_count: number;
  locked_until: Date | null;
  deleted_at: Date | null;
}

interface ResetRow {
  id: string;
  temp_password_hash: Buffer;
  salt: Buffer;
  algo: string;
  iterations: number;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

export type LoginResult =
  | { kind: 'session'; session: SessionTokens }
  | { kind: 'password_change_required'; passwordChangeToken: string; user: PublicUser };

export type PasswordChangeAuth =
  | { kind: 'session'; userId: string }
  | { kind: 'reset'; userId: string; resetId: string; tokenVersion: number };

export function normalizeEmail(email: string): string {
  return email.normalize('NFKC').trim().toLowerCase();
}

const toPublic = (u: PublicUser): PublicUser => ({ id: u.id, email: u.email, nickname: u.nickname, created_at: u.created_at });

const storedOf = (u: UserRow): StoredPassword => ({
  hash: u.password_hash,
  salt: u.password_salt,
  algo: u.password_algo,
  iterations: u.password_iterations,
});

const invalidCredentials = () =>
  new HttpError(401, 'INVALID_CREDENTIALS', '이메일 또는 비밀번호가 올바르지 않습니다.');

const accountLocked = (until: Date, now: Date) =>
  new HttpError(
    423,
    'ACCOUNT_LOCKED',
    `로그인에 ${config.login.maxFailures}회 연속 실패해 계정이 잠겼습니다. ${Math.max(
      1,
      Math.ceil((until.getTime() - now.getTime()) / 60000),
    )}분 후 다시 시도해 주세요.`,
    { retry_after_sec: Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000)) },
  );

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && e.constraint === constraint;
}

function assertPasswordPolicy(password: string) {
  const msg = passwordPolicyError(password);
  if (msg) throw badRequest(msg, 'WEAK_PASSWORD');
}

async function createSession(db: Db, user: UserRow, client: ClientInfo): Promise<SessionTokens> {
  const { token } = await issueRefreshToken(
    pgRefreshTokenRepo(db),
    user.id,
    client,
    clock.now(),
    config.refreshTokenTtlDays,
  );
  return {
    accessToken: signAccessToken({ userId: user.id, tokenVersion: user.token_version }),
    refreshToken: token,
    user: toPublic(user),
  };
}

// -----------------------------------------------------------------------------
// 회원가입
// -----------------------------------------------------------------------------
export async function signup(
  input: { email: string; password: string; nickname: string },
  client: ClientInfo,
): Promise<SessionTokens> {
  const email = normalizeEmail(input.email);
  assertPasswordPolicy(input.password);
  const pw = await hashPassword(input.password, config.passwordIterations);
  try {
    return await withTransaction(async (db) => {
      const user = await queryOne<UserRow>(
        db,
        `INSERT INTO users (email, password_hash, password_salt, password_algo, password_iterations, nickname)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [email, pw.hash, pw.salt, pw.algo, pw.iterations, input.nickname.trim()],
      );
      return createSession(db, user!, client);
    });
  } catch (err) {
    if (isUniqueViolation(err, 'users_email_key')) throw conflict('이미 가입된 이메일입니다.', 'EMAIL_TAKEN');
    throw err;
  }
}

// -----------------------------------------------------------------------------
// 로그인 (5회 연속 실패 시 15분 잠금)
// -----------------------------------------------------------------------------
export async function login(input: { email: string; password: string }, client: ClientInfo): Promise<LoginResult> {
  const email = normalizeEmail(input.email);
  const now = clock.now();
  const user = await queryOne<UserRow>(pool, `SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL`, [email]);
  if (!user) {
    await dummyVerify(config.passwordIterations);
    throw invalidCredentials();
  }

  // 시도 횟수를 "먼저" 원자적으로 올린다 → 병렬 요청으로 잠금을 우회할 수 없다.
  const attempt = await queryOne<{ failed_login_count: number }>(
    pool,
    `UPDATE users SET failed_login_count = failed_login_count + 1
      WHERE id = $1 AND (locked_until IS NULL OR locked_until <= $2)
      RETURNING failed_login_count`,
    [user.id, now],
  );
  if (!attempt) throw accountLocked(user.locked_until ?? now, now);

  const lockAccount = async () => {
    const until = new Date(now.getTime() + config.login.lockMinutes * 60_000);
    await query(pool, `UPDATE users SET failed_login_count = 0, locked_until = $2 WHERE id = $1`, [user.id, until]);
    return accountLocked(until, now);
  };
  if (attempt.failed_login_count > config.login.maxFailures) throw await lockAccount();

  const clearFailures = (db: Db) =>
    query(db, `UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [user.id]);

  // 1) 기존 비밀번호
  if (await verifyPassword(input.password, storedOf(user))) {
    const session = await withTransaction(async (db) => {
      await clearFailures(db);
      if (needsRehash(storedOf(user), config.passwordIterations)) {
        const pw = await hashPassword(input.password, config.passwordIterations);
        await query(
          db,
          `UPDATE users SET password_hash = $2, password_salt = $3, password_algo = $4, password_iterations = $5
            WHERE id = $1`,
          [user.id, pw.hash, pw.salt, pw.algo, pw.iterations],
        );
      }
      // 기존 비밀번호로 로그인했다면 아직 쓰지 않은 임시 비밀번호는 더 이상 필요 없다.
      await query(
        db,
        `UPDATE password_resets SET invalidated_at = $2
          WHERE user_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
        [user.id, now],
      );
      return createSession(db, user, client);
    });
    return { kind: 'session', session };
  }

  // 2) 임시 비밀번호 (기존 비밀번호와 별개로 유효, 30분, 1회용)
  const reset = await queryOne<ResetRow>(
    pool,
    `SELECT id, temp_password_hash, salt, algo, iterations FROM password_resets
      WHERE user_id = $1 AND used_at IS NULL AND invalidated_at IS NULL AND expires_at > $2
      ORDER BY created_at DESC LIMIT 1`,
    [user.id, now],
  );
  if (
    reset &&
    (await verifyPassword(input.password, {
      hash: reset.temp_password_hash,
      salt: reset.salt,
      algo: reset.algo,
      iterations: reset.iterations,
    }))
  ) {
    await clearFailures(pool);
    return {
      kind: 'password_change_required',
      passwordChangeToken: signPasswordChangeToken({
        userId: user.id,
        tokenVersion: user.token_version,
        resetId: reset.id,
      }),
      user: toPublic(user),
    };
  }

  if (attempt.failed_login_count >= config.login.maxFailures) throw await lockAccount();
  throw invalidCredentials();
}

// -----------------------------------------------------------------------------
// Refresh (rotation + 재사용 탐지)
// -----------------------------------------------------------------------------
export async function refreshSession(presented: string | undefined, client: ClientInfo): Promise<SessionTokens> {
  const expired = () => unauthorized('로그인이 만료되었습니다. 다시 로그인해 주세요.', 'REFRESH_INVALID');
  if (!presented) throw expired();
  const now = clock.now();

  const outcome = await withTransaction(async (db) => {
    const result = await rotateRefreshToken(pgRefreshTokenRepo(db), presented, client, now, config.refreshTokenTtlDays);
    if (result.status !== 'rotated') return { result, session: null };
    const user = await queryOne<UserRow>(db, `SELECT * FROM users WHERE id = $1`, [result.record.userId]);
    // 탈퇴한 계정: 트랜잭션을 롤백하고 거부
    if (!user || user.deleted_at) throw expired();
    const session: SessionTokens = {
      accessToken: signAccessToken({ userId: user.id, tokenVersion: user.token_version }),
      refreshToken: result.token,
      user: toPublic(user),
    };
    return { result, session };
  });

  if (outcome.result.status === 'reuse_detected') {
    console.warn(
      `[auth] refresh token 재사용 탐지 → family 폐기 user=${outcome.result.userId} family=${outcome.result.familyId} revoked=${outcome.result.revokedCount}`,
    );
    throw unauthorized('보안을 위해 로그인이 해제되었습니다. 다시 로그인해 주세요.', 'REFRESH_REUSED');
  }
  if (!outcome.session) throw expired();
  return outcome.session;
}

// -----------------------------------------------------------------------------
// 로그아웃
// -----------------------------------------------------------------------------
export async function logout(presented: string | undefined): Promise<void> {
  if (!presented) return;
  await query(
    pool,
    `UPDATE refresh_tokens SET revoked_at = $2, revoked_reason = 'logout'
      WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)
        AND revoked_at IS NULL`,
    [hashRefreshToken(presented), clock.now()],
  );
}

/** 모든 기기 로그아웃: refresh token 전부 폐기 + tokenVersion 증가(발급된 access token 즉시 무효) */
export async function logoutAll(userId: string): Promise<void> {
  await withTransaction(async (db) => {
    await pgRefreshTokenRepo(db).revokeAllForUser(userId, 'logout_all', clock.now());
    await query(db, `UPDATE users SET token_version = token_version + 1 WHERE id = $1`, [userId]);
  });
}

// -----------------------------------------------------------------------------
// 비밀번호 초기화 (이메일 임시 비밀번호)
// -----------------------------------------------------------------------------

/**
 * 계정 존재 여부와 관계없이 즉시 같은 응답을 주기 위해 실제 처리는 백그라운드로 돌린다.
 * (DB 조회 / PBKDF2 / 메일 발송 시간 차이로 계정 존재 여부가 드러나지 않게)
 */
export function requestPasswordReset(rawEmail: string, ip: string | null): void {
  const email = normalizeEmail(rawEmail);
  void processPasswordReset(email, ip).catch((err: Error) => {
    console.error('[auth] 임시 비밀번호 처리 실패:', err.message);
  });
}

export async function processPasswordReset(email: string, ip: string | null): Promise<'sent' | 'no_user' | 'rate_limited'> {
  const user = await queryOne<{ id: string; email: string; nickname: string }>(
    pool,
    `SELECT id, email, nickname FROM users WHERE email = $1 AND deleted_at IS NULL`,
    [email],
  );
  if (!user) return 'no_user';

  const now = clock.now();
  const tempPassword = generateTempPassword(14);
  const pw = await hashPassword(tempPassword, config.passwordIterations);

  const created = await withTransaction(async (db) => {
    // 같은 사용자에 대한 동시 요청 직렬화
    await query(db, `SELECT id FROM users WHERE id = $1 FOR UPDATE`, [user.id]);
    const recent = await queryOne<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM password_resets WHERE user_id = $1 AND created_at > $2`,
      [user.id, new Date(now.getTime() - 60 * 60_000)],
    );
    if ((recent?.n ?? 0) >= config.passwordReset.maxPerHour) return false;

    // 새로 발급하면 이전 임시 비밀번호는 무효
    await query(
      db,
      `UPDATE password_resets SET invalidated_at = $2
        WHERE user_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
      [user.id, now],
    );
    await query(
      db,
      `INSERT INTO password_resets (user_id, temp_password_hash, salt, algo, iterations, expires_at, request_ip, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::inet, $8)`,
      [
        user.id,
        pw.hash,
        pw.salt,
        pw.algo,
        pw.iterations,
        new Date(now.getTime() + config.passwordReset.ttlMinutes * 60_000),
        ip,
        now,
      ],
    );
    return true;
  });

  if (!created) {
    console.info('[auth] 임시 비밀번호 요청 한도 초과 (이메일당 1시간 3회)');
    return 'rate_limited';
  }
  await sendTempPasswordMail(user.email, user.nickname, tempPassword, config.passwordReset.ttlMinutes);
  return 'sent';
}

// -----------------------------------------------------------------------------
// 비밀번호 변경 (임시 비밀번호 로그인 후 / 로그인 상태에서 일반 변경)
// -----------------------------------------------------------------------------
export async function changePassword(
  auth: PasswordChangeAuth,
  input: { currentPassword?: string; newPassword: string },
  client: ClientInfo,
): Promise<SessionTokens> {
  assertPasswordPolicy(input.newPassword);
  const now = clock.now();
  const user = await queryOne<UserRow>(pool, `SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL`, [auth.userId]);
  if (!user) throw unauthorized();

  if (auth.kind === 'session') {
    if (!input.currentPassword) throw badRequest('현재 비밀번호를 입력해 주세요.');
    if (!(await verifyPassword(input.currentPassword, storedOf(user)))) {
      throw new HttpError(400, 'INVALID_CURRENT_PASSWORD', '현재 비밀번호가 올바르지 않습니다.');
    }
  } else if (user.token_version !== auth.tokenVersion) {
    throw unauthorized('비밀번호 변경 시간이 만료되었습니다. 다시 로그인해 주세요.', 'PASSWORD_CHANGE_TOKEN_INVALID');
  }

  const pw = await hashPassword(input.newPassword, config.passwordIterations);
  const session = await withTransaction(async (db) => {
    if (auth.kind === 'reset') {
      const used = await queryOne(
        db,
        `UPDATE password_resets SET used_at = $3
          WHERE id = $1 AND user_id = $2 AND used_at IS NULL AND invalidated_at IS NULL
          RETURNING id`,
        [auth.resetId, user.id, now],
      );
      if (!used) {
        throw unauthorized(
          '임시 비밀번호가 이미 사용되었거나 무효화되었습니다. 다시 요청해 주세요.',
          'PASSWORD_CHANGE_TOKEN_INVALID',
        );
      }
    }
    await query(
      db,
      `UPDATE password_resets SET invalidated_at = $2
        WHERE user_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
      [user.id, now],
    );
    const updated = await queryOne<UserRow>(
      db,
      `UPDATE users
          SET password_hash = $2, password_salt = $3, password_algo = $4, password_iterations = $5,
              token_version = token_version + 1, failed_login_count = 0, locked_until = NULL
        WHERE id = $1 RETURNING *`,
      [user.id, pw.hash, pw.salt, pw.algo, pw.iterations],
    );
    // 기존 refresh token 전부 폐기 → 이 요청 기기에만 새 세션 발급
    await pgRefreshTokenRepo(db).revokeAllForUser(user.id, 'password_changed', now);
    return createSession(db, updated!, client);
  });

  void sendPasswordChangedMail(user.email, user.nickname).catch((err: Error) => {
    console.error('[auth] 비밀번호 변경 알림 메일 실패:', err.message);
  });
  return session;
}

// -----------------------------------------------------------------------------
// 회원 탈퇴 (데이터 삭제)
//  - 개인 기록(식사/체중/운동/프로필/조정 이력/AI 로그/토큰)은 모두 삭제한다.
//  - users 행은 deleted_at 표시 + 이메일/닉네임/비밀번호를 무작위 값으로 덮어써 개인정보를 남기지 않는다.
// -----------------------------------------------------------------------------
export async function deleteAccount(userId: string, password: string): Promise<void> {
  const user = await queryOne<UserRow>(pool, `SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL`, [userId]);
  if (!user) throw unauthorized();
  if (!(await verifyPassword(password, storedOf(user)))) {
    throw new HttpError(400, 'INVALID_CURRENT_PASSWORD', '비밀번호가 올바르지 않습니다.');
  }
  const now = clock.now();
  await withTransaction(async (db) => {
    await query(db, `DELETE FROM meals WHERE user_id = $1`, [userId]);
    await query(db, `DELETE FROM daily_logs WHERE user_id = $1`, [userId]);
    await query(db, `DELETE FROM weekly_calorie_adjustments WHERE user_id = $1`, [userId]);
    await query(db, `DELETE FROM user_profiles WHERE user_id = $1`, [userId]);
    await query(db, `DELETE FROM ai_usage_logs WHERE user_id = $1`, [userId]);
    await query(db, `DELETE FROM food_analysis_jobs WHERE user_id = $1`, [userId]);
    await query(db, `DELETE FROM password_resets WHERE user_id = $1`, [userId]);
    await query(db, `DELETE FROM refresh_tokens WHERE user_id = $1`, [userId]);
    await query(
      db,
      `UPDATE users
          SET email = 'deleted+' || id::text || '@deleted.invalid',
              nickname = '탈퇴한 사용자',
              password_hash = $2, password_salt = $3,
              token_version = token_version + 1,
              failed_login_count = 0, locked_until = NULL,
              deleted_at = $4
        WHERE id = $1`,
      [userId, crypto.randomBytes(32), crypto.randomBytes(16), now],
    );
  });
}
