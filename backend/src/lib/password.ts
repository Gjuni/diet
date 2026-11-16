import crypto from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2 = promisify(crypto.pbkdf2);

export const PASSWORD_ALGO = 'pbkdf2-sha256';
export const SALT_BYTES = 16;
const KEY_BYTES = 32;

export interface StoredPassword {
  hash: Buffer;
  salt: Buffer;
  algo: string;
  iterations: number;
}

/** 비밀번호 정규화: 유니코드 조합 차이(NFC/NFD)로 같은 비밀번호가 다르게 해시되는 것을 막는다 */
function normalize(password: string): string {
  return password.normalize('NFKC');
}

/** 사용자별 랜덤 salt(16바이트) + PBKDF2-HMAC-SHA256 */
export async function hashPassword(password: string, iterations: number): Promise<StoredPassword> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = await pbkdf2(normalize(password), salt, iterations, KEY_BYTES, 'sha256');
  return { hash, salt, algo: PASSWORD_ALGO, iterations };
}

/** 저장된 파라미터(알고리즘/반복 횟수/salt)로 다시 계산해 상수시간 비교 */
export async function verifyPassword(password: string, stored: StoredPassword): Promise<boolean> {
  if (stored.algo !== PASSWORD_ALGO) return false;
  const derived = await pbkdf2(normalize(password), stored.salt, stored.iterations, stored.hash.length, 'sha256');
  return derived.length === stored.hash.length && crypto.timingSafeEqual(derived, stored.hash);
}

/** 반복 횟수를 올렸거나 알고리즘이 바뀌었으면 다음 로그인 때 재해시 */
export function needsRehash(stored: { algo: string; iterations: number }, currentIterations: number): boolean {
  return stored.algo !== PASSWORD_ALGO || stored.iterations < currentIterations;
}

const DUMMY_SALT = crypto.randomBytes(SALT_BYTES);

/** 존재하지 않는 계정에도 비슷한 시간이 걸리게 해 계정 존재 여부가 응답 시간으로 드러나지 않게 한다 */
export async function dummyVerify(iterations: number): Promise<void> {
  await pbkdf2('dummy-password', DUMMY_SALT, iterations, KEY_BYTES, 'sha256');
}

/** 비밀번호 정책: 8자 이상, 영문과 숫자 포함. 위반 시 메시지, 통과 시 null */
export function passwordPolicyError(password: string): string | null {
  if (typeof password !== 'string' || password.length < 8) return '비밀번호는 8자 이상이어야 합니다.';
  if (password.length > 128) return '비밀번호는 128자 이하여야 합니다.';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return '비밀번호에는 영문과 숫자가 모두 포함되어야 합니다.';
  return null;
}

// 헷갈리는 문자(0/O, 1/l/I) 제외
const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** 임시 비밀번호: 암호학적 난수(crypto.randomInt, modulo bias 없음), 기본 14자, 영문+숫자 포함 */
export function generateTempPassword(length = 14): string {
  if (length < 12) throw new Error('임시 비밀번호는 12자 이상이어야 합니다.');
  for (;;) {
    let out = '';
    for (let i = 0; i < length; i++) out += TEMP_ALPHABET[crypto.randomInt(TEMP_ALPHABET.length)];
    if (/[A-Za-z]/.test(out) && /[0-9]/.test(out)) return out;
  }
}
