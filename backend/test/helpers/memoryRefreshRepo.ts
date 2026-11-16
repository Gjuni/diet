import crypto from 'node:crypto';
import type {
  NewRefreshToken,
  RefreshTokenRecord,
  RefreshTokenRepo,
  RevokeReason,
} from '../../src/services/refreshTokens.js';

/** 단위 테스트용 메모리 저장소 (PostgreSQL 구현과 같은 의미론) */
export class MemoryRefreshRepo implements RefreshTokenRepo {
  readonly rows = new Map<string, RefreshTokenRecord>();

  async insert(t: NewRefreshToken): Promise<RefreshTokenRecord> {
    if ([...this.rows.values()].some((r) => r.tokenHash === t.tokenHash)) throw new Error('unique violation');
    const rec: RefreshTokenRecord = {
      id: crypto.randomUUID(),
      ...t,
      revokedAt: null,
      revokedReason: null,
      replacedBy: null,
      lastUsedAt: null,
    };
    this.rows.set(rec.id, rec);
    return { ...rec };
  }

  async findByHashForUpdate(tokenHash: string) {
    const r = [...this.rows.values()].find((x) => x.tokenHash === tokenHash);
    return r ? { ...r } : null;
  }

  async markRotated(id: string, replacedBy: string, now: Date) {
    const r = this.rows.get(id)!;
    Object.assign(r, { revokedAt: now, revokedReason: 'rotated', replacedBy, lastUsedAt: now });
  }

  async revokeFamily(familyId: string, reason: RevokeReason, now: Date) {
    let n = 0;
    for (const r of this.rows.values()) {
      if (r.familyId === familyId && !r.revokedAt) {
        Object.assign(r, { revokedAt: now, revokedReason: reason });
        n++;
      }
    }
    return n;
  }

  async revokeAllForUser(userId: string, reason: RevokeReason, now: Date) {
    let n = 0;
    for (const r of this.rows.values()) {
      if (r.userId === userId && !r.revokedAt) {
        Object.assign(r, { revokedAt: now, revokedReason: reason });
        n++;
      }
    }
    return n;
  }

  activeInFamily(familyId: string) {
    return [...this.rows.values()].filter((r) => r.familyId === familyId && !r.revokedAt);
  }
}
