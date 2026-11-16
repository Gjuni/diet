import { describe, expect, it } from 'vitest';
import { hashRefreshToken } from '../src/lib/tokens.js';
import { issueRefreshToken, rotateRefreshToken } from '../src/services/refreshTokens.js';
import { MemoryRefreshRepo } from './helpers/memoryRefreshRepo.js';

const client = { userAgent: 'vitest', ip: '127.0.0.1' };
const t0 = new Date('2026-11-16T00:00:00Z');
const later = (min: number) => new Date(t0.getTime() + min * 60_000);

describe('Refresh Token rotation', () => {
  it('원문은 저장하지 않고 SHA-256 해시만 저장한다', async () => {
    const repo = new MemoryRefreshRepo();
    const { token, record } = await issueRefreshToken(repo, 'u1', client, t0, 30);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(record.tokenHash).toBe(hashRefreshToken(token));
    expect(record.tokenHash).not.toContain(token);
    expect(record.expiresAt.getTime() - t0.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
    expect([...repo.rows.values()].some((r) => JSON.stringify(r).includes(token))).toBe(false);
  });

  it('사용할 때마다 새 토큰을 발급하고 기존 토큰을 폐기한다 (같은 family)', async () => {
    const repo = new MemoryRefreshRepo();
    const first = await issueRefreshToken(repo, 'u1', client, t0, 30);
    const r = await rotateRefreshToken(repo, first.token, { userAgent: 'vitest-2', ip: '10.0.0.1' }, later(10), 30);

    expect(r.status).toBe('rotated');
    if (r.status !== 'rotated') return;
    expect(r.token).not.toBe(first.token);
    expect(r.record.familyId).toBe(first.record.familyId);
    expect(r.record.userAgent).toBe('vitest-2');

    const old = repo.rows.get(first.record.id)!;
    expect(old.revokedReason).toBe('rotated');
    expect(old.replacedBy).toBe(r.record.id);
    expect(old.lastUsedAt).toEqual(later(10));
    expect(repo.activeInFamily(first.record.familyId).map((x) => x.id)).toEqual([r.record.id]);
  });

  it('연속 rotation 은 체인으로 이어진다', async () => {
    const repo = new MemoryRefreshRepo();
    let { token } = await issueRefreshToken(repo, 'u1', client, t0, 30);
    for (let i = 1; i <= 5; i++) {
      const r = await rotateRefreshToken(repo, token, client, later(i), 30);
      expect(r.status).toBe('rotated');
      if (r.status === 'rotated') token = r.token;
    }
    expect(repo.rows.size).toBe(6);
    expect([...repo.rows.values()].filter((x) => !x.revokedAt)).toHaveLength(1);
  });
});

describe('재사용(탈취) 탐지', () => {
  it('이미 폐기된 토큰이 다시 들어오면 같은 family 를 전부 폐기한다', async () => {
    const repo = new MemoryRefreshRepo();
    const stolen = await issueRefreshToken(repo, 'u1', client, t0, 30);
    // 정상 사용자가 먼저 rotation
    const legit = await rotateRefreshToken(repo, stolen.token, client, later(1), 30);
    expect(legit.status).toBe('rotated');

    // 공격자가 탈취한 예전 토큰을 사용
    const attack = await rotateRefreshToken(repo, stolen.token, { userAgent: 'evil', ip: '6.6.6.6' }, later(2), 30);
    expect(attack).toMatchObject({ status: 'reuse_detected', userId: 'u1', familyId: stolen.record.familyId, revokedCount: 1 });

    // 정상 사용자의 최신 토큰도 함께 폐기되어 다시 로그인해야 한다
    expect(repo.activeInFamily(stolen.record.familyId)).toHaveLength(0);
    if (legit.status === 'rotated') {
      expect(repo.rows.get(legit.record.id)!.revokedReason).toBe('reuse_detected');
      const retry = await rotateRefreshToken(repo, legit.token, client, later(3), 30);
      expect(retry.status).toBe('reuse_detected');
    }
  });

  it('공격자가 먼저 rotation 해도, 정상 사용자가 예전 토큰을 쓰는 순간 family 전체가 폐기된다', async () => {
    const repo = new MemoryRefreshRepo();
    const original = await issueRefreshToken(repo, 'u1', client, t0, 30);
    const attacker = await rotateRefreshToken(repo, original.token, { userAgent: 'evil', ip: '6.6.6.6' }, later(1), 30);
    expect(attacker.status).toBe('rotated');
    const victim = await rotateRefreshToken(repo, original.token, client, later(2), 30);
    expect(victim.status).toBe('reuse_detected');
    if (attacker.status === 'rotated') {
      const attackerNext = await rotateRefreshToken(repo, attacker.token, client, later(3), 30);
      expect(attackerNext.status).toBe('reuse_detected');
    }
  });

  it('다른 기기(family)의 세션은 영향을 받지 않는다', async () => {
    const repo = new MemoryRefreshRepo();
    const phone = await issueRefreshToken(repo, 'u1', { userAgent: 'phone', ip: null }, t0, 30);
    const laptop = await issueRefreshToken(repo, 'u1', { userAgent: 'laptop', ip: null }, t0, 30);
    await rotateRefreshToken(repo, phone.token, client, later(1), 30);
    await rotateRefreshToken(repo, phone.token, client, later(2), 30); // reuse → phone family 폐기

    expect(repo.activeInFamily(phone.record.familyId)).toHaveLength(0);
    const r = await rotateRefreshToken(repo, laptop.token, client, later(3), 30);
    expect(r.status).toBe('rotated');
  });

  it('로그아웃 등으로 폐기된 토큰도 재사용이면 탐지한다', async () => {
    const repo = new MemoryRefreshRepo();
    const a = await issueRefreshToken(repo, 'u1', client, t0, 30);
    await repo.revokeFamily(a.record.familyId, 'logout', later(1));
    const r = await rotateRefreshToken(repo, a.token, client, later(2), 30);
    expect(r.status).toBe('reuse_detected');
  });
});

describe('만료 / 잘못된 토큰', () => {
  it('만료된 토큰은 거부하되 탈취로 보지 않는다', async () => {
    const repo = new MemoryRefreshRepo();
    const a = await issueRefreshToken(repo, 'u1', client, t0, 30);
    const r = await rotateRefreshToken(repo, a.token, client, new Date(t0.getTime() + 31 * 86_400_000), 30);
    expect(r).toEqual({ status: 'expired', userId: 'u1' });
    expect(repo.rows.get(a.record.id)!.revokedAt).toBeNull();
  });

  it('존재하지 않거나 형식이 틀린 토큰', async () => {
    const repo = new MemoryRefreshRepo();
    expect((await rotateRefreshToken(repo, 'garbage', client, t0, 30)).status).toBe('invalid');
    expect((await rotateRefreshToken(repo, 'A'.repeat(43), client, t0, 30)).status).toBe('invalid');
  });
});
