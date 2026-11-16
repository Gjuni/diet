import { describe, expect, it } from 'vitest';
import {
  generateTempPassword,
  hashPassword,
  needsRehash,
  passwordPolicyError,
  verifyPassword,
} from '../src/lib/password.js';
import {
  signAccessToken,
  signPasswordChangeToken,
  TokenError,
  verifyAccessToken,
  verifyPasswordChangeToken,
} from '../src/lib/tokens.js';

// 테스트 속도를 위해 반복 횟수를 낮춘다 (운영은 600,000 이상, config 에서 강제)
const ITER = 1000;

describe('PBKDF2-HMAC-SHA256 비밀번호 해시', () => {
  it('해시/검증, 사용자별 랜덤 salt', async () => {
    const a = await hashPassword('abc12345', ITER);
    const b = await hashPassword('abc12345', ITER);
    expect(a.algo).toBe('pbkdf2-sha256');
    expect(a.iterations).toBe(ITER);
    expect(a.salt.length).toBeGreaterThanOrEqual(16);
    expect(a.salt.equals(b.salt)).toBe(false);
    expect(a.hash.equals(b.hash)).toBe(false);
    expect(await verifyPassword('abc12345', a)).toBe(true);
    expect(await verifyPassword('abc12346', a)).toBe(false);
  });

  it('저장된 반복 횟수로 검증하고, 낮으면 재해시 대상', async () => {
    const old = await hashPassword('abc12345', ITER);
    expect(await verifyPassword('abc12345', old)).toBe(true);
    expect(needsRehash(old, 600_000)).toBe(true);
    expect(needsRehash({ algo: 'pbkdf2-sha256', iterations: 600_000 }, 600_000)).toBe(false);
    expect(await verifyPassword('abc12345', { ...old, algo: 'md5' })).toBe(false);
  });

  it('유니코드 정규화(NFC/NFD) 차이를 흡수', async () => {
    const h = await hashPassword('비밀번호abc1'.normalize('NFC'), ITER);
    expect(await verifyPassword('비밀번호abc1'.normalize('NFD'), h)).toBe(true);
  });
});

describe('비밀번호 정책 / 임시 비밀번호', () => {
  it('8자 이상, 영문과 숫자 포함', () => {
    expect(passwordPolicyError('abc1234')).not.toBeNull();
    expect(passwordPolicyError('abcdefgh')).not.toBeNull();
    expect(passwordPolicyError('12345678')).not.toBeNull();
    expect(passwordPolicyError('abcd1234')).toBeNull();
  });

  it('임시 비밀번호는 12자 이상, 영문+숫자, 매번 다름', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = generateTempPassword();
      expect(p.length).toBeGreaterThanOrEqual(12);
      expect(p).toMatch(/[A-Za-z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).not.toMatch(/[0O1lI]/);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
    expect(() => generateTempPassword(8)).toThrow();
  });
});

describe('JWT', () => {
  it('Access Token payload 는 userId / tokenVersion 만', () => {
    const t = signAccessToken({ userId: 'u1', tokenVersion: 3 });
    const payload = JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString());
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'tokenVersion', 'userId']);
    expect(payload.exp - payload.iat).toBe(15 * 60);
    expect(verifyAccessToken(t)).toEqual({ userId: 'u1', tokenVersion: 3 });
  });

  it('비밀번호 변경 전용 토큰은 일반 API 토큰으로 쓸 수 없다 (그 반대도)', () => {
    const restricted = signPasswordChangeToken({ userId: 'u1', tokenVersion: 0, resetId: 'r1' });
    expect(() => verifyAccessToken(restricted)).toThrow(TokenError);
    const access = signAccessToken({ userId: 'u1', tokenVersion: 0 });
    expect(() => verifyPasswordChangeToken(access)).toThrow(TokenError);
    expect(verifyPasswordChangeToken(restricted)).toMatchObject({ userId: 'u1', resetId: 'r1', scope: 'password_change' });
  });

  it('alg=none / 변조 토큰 거부', () => {
    const t = signAccessToken({ userId: 'u1', tokenVersion: 0 });
    const [h, p] = t.split('.');
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${p}.`;
    expect(() => verifyAccessToken(none)).toThrow(TokenError);
    const tampered = `${h}.${Buffer.from(JSON.stringify({ userId: 'u2', tokenVersion: 0 })).toString('base64url')}.${t.split('.')[2]}`;
    expect(() => verifyAccessToken(tampered)).toThrow(TokenError);
  });
});
