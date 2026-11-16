import { query, queryOne, type Db } from '../db.js';
import type { NewRefreshToken, RefreshTokenRecord, RefreshTokenRepo, RevokeReason } from '../services/refreshTokens.js';

interface Row {
  id: string;
  user_id: string;
  token_hash: string;
  family_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: RevokeReason | null;
  replaced_by: string | null;
  user_agent: string | null;
  ip: string | null;
  last_used_at: Date | null;
  created_at: Date;
}

const COLUMNS = `id, user_id, token_hash, family_id, expires_at, revoked_at, revoked_reason, replaced_by,
                 user_agent, host(ip) AS ip, last_used_at, created_at`;

function map(r: Row): RefreshTokenRecord {
  return {
    id: r.id,
    userId: r.user_id,
    tokenHash: r.token_hash,
    familyId: r.family_id,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    revokedReason: r.revoked_reason,
    replacedBy: r.replaced_by,
    userAgent: r.user_agent,
    ip: r.ip,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
  };
}

/** PostgreSQL 구현. db 는 트랜잭션 클라이언트를 넘겨야 FOR UPDATE 잠금이 의미가 있다. */
export function pgRefreshTokenRepo(db: Db): RefreshTokenRepo {
  return {
    async insert(t: NewRefreshToken) {
      const row = await queryOne<Row>(
        db,
        `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at, user_agent, ip, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::inet, $7)
         RETURNING ${COLUMNS}`,
        [t.userId, t.tokenHash, t.familyId, t.expiresAt, t.userAgent, t.ip, t.createdAt],
      );
      return map(row!);
    },

    async findByHashForUpdate(tokenHash: string) {
      const row = await queryOne<Row>(db, `SELECT ${COLUMNS} FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`, [
        tokenHash,
      ]);
      return row ? map(row) : null;
    },

    async markRotated(id: string, replacedBy: string, now: Date) {
      await query(
        db,
        `UPDATE refresh_tokens
            SET revoked_at = $3, revoked_reason = 'rotated', replaced_by = $2, last_used_at = $3
          WHERE id = $1`,
        [id, replacedBy, now],
      );
    },

    async revokeFamily(familyId: string, reason: RevokeReason, now: Date) {
      const rows = await query(
        db,
        `UPDATE refresh_tokens SET revoked_at = $3, revoked_reason = $2
          WHERE family_id = $1 AND revoked_at IS NULL RETURNING id`,
        [familyId, reason, now],
      );
      return rows.length;
    },

    async revokeAllForUser(userId: string, reason: RevokeReason, now: Date) {
      const rows = await query(
        db,
        `UPDATE refresh_tokens SET revoked_at = $3, revoked_reason = $2
          WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
        [userId, reason, now],
      );
      return rows.length;
    },
  };
}
