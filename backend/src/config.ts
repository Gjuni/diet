import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** backend/ 디렉터리 (src/config.ts 와 dist/config.js 양쪽에서 동일하게 계산된다) */
export const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!process.env.SKIP_DOTENV) {
  try {
    process.loadEnvFile(path.join(BACKEND_ROOT, '.env'));
  } catch {
    // .env 가 없으면 실제 환경변수만 사용한다.
  }
}

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`환경변수 ${name} 는 정수여야 합니다: ${v}`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const nodeEnv = str('NODE_ENV', 'development');
const isProduction = nodeEnv === 'production';

function jwtSecret(): string {
  const v = str('JWT_SECRET');
  if (v.length >= 32) return v;
  if (isProduction) {
    throw new Error('JWT_SECRET 은 32자 이상이어야 합니다 (production).');
  }
  console.warn('[config] JWT_SECRET 이 없거나 짧아 임시 키를 생성합니다. 서버 재시작 시 로그인이 풀립니다.');
  return crypto.randomBytes(48).toString('base64url');
}

function float(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`환경변수 ${name} 는 숫자여야 합니다: ${v}`);
  return n;
}

/** GEMINI_API_KEYS(쉼표/줄바꿈 구분) + GEMINI_API_KEY(단일, 하위 호환) → 중복 제거 */
function geminiKeys(): string[] {
  const raw = [str('GEMINI_API_KEYS'), str('GEMINI_API_KEY')].join(',');
  return [...new Set(raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}

function trustProxy(): boolean | number | string {
  const v = str('TRUST_PROXY', 'loopback');
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

export const config = {
  nodeEnv,
  isProduction,
  isTest: nodeEnv === 'test',
  port: int('PORT', 4000),

  databaseUrl: str('DATABASE_URL', 'postgres://diet:diet@localhost:5432/diet'),
  pgPoolMax: int('PG_POOL_MAX', 10),

  jwtSecret: jwtSecret(),
  accessTokenTtlSec: int('ACCESS_TOKEN_TTL_SEC', 15 * 60),
  refreshTokenTtlDays: int('REFRESH_TOKEN_TTL_DAYS', 30),
  passwordChangeTokenTtlSec: int('PASSWORD_CHANGE_TOKEN_TTL_SEC', 10 * 60),
  /** PBKDF2 반복 횟수. 600,000 미만으로는 내려가지 않는다. 올리면 다음 로그인 때 자동 재해시. */
  passwordIterations: Math.max(600_000, int('PASSWORD_ITERATIONS', 600_000)),

  cookieSecure: bool('COOKIE_SECURE', true),
  corsOrigins: str('CORS_ORIGIN')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  trustProxy: trustProxy(),

  gemini: {
    /** 키 풀 (여러 개면 rotation / failover). 로그에는 키 원문 대신 지문만 남긴다. */
    apiKeys: geminiKeys(),
    model: str('GEMINI_MODEL', 'gemini-3.8-flash'),
    thinkingLevel: str('GEMINI_THINKING_LEVEL', 'medium'),
    /** 사진 분석 1건의 전체 제한 시간 (failover/hedging 포함) */
    timeoutMs: int('GEMINI_TIMEOUT_MS', 30_000),
    /** 주간 조정(배치) 1명당 제한 시간 */
    batchTimeoutMs: int('GEMINI_BATCH_TIMEOUT_MS', 90_000),
    apiBase: str('GEMINI_API_BASE', 'https://generativelanguage.googleapis.com/v1beta'),
    maxOutputTokens: int('GEMINI_MAX_OUTPUT_TOKENS', 8192),
    /**
     * 이미지 해상도 레벨: MEDIA_RESOLUTION_LOW(280토큰) / MEDIUM(560) / HIGH(1120). 비우면 모델 기본값(1120).
     * TPM 이 병목이면 MEDIUM 으로 이미지 토큰을 절반으로 줄일 수 있다. 모델이 거부하면 자동으로 빼고 재시도한다.
     */
    mediaResolution: str('GEMINI_MEDIA_RESOLUTION'),

    /** 스트리밍(SSE)으로 받아 끊김/정체를 감지한다 */
    stream: bool('GEMINI_STREAM', true),
    /** 추론 요약(thought summary)도 스트리밍 받아 "추론 중" heartbeat 로 사용 */
    streamThoughts: bool('GEMINI_STREAM_THOUGHTS', true),
    /** 이 시간 동안 스트림에 아무 데이터가 없으면 정체로 보고 다른 키로 재시도 */
    stallTimeoutMs: int('GEMINI_STALL_TIMEOUT_MS', 15_000),
    /** 첫 응답이 이 시간 안에 없으면 다른 키로 병렬 요청(hedging). 0 = 끔 */
    hedgeAfterMs: int('GEMINI_HEDGE_AFTER_MS', 8_000),
    /** 키 풀 전체의 남은 일일 예산이 이 비율 이상일 때만 hedging (RPD 를 알 때) */
    hedgeMinBudgetRatio: float('GEMINI_HEDGE_MIN_BUDGET_RATIO', 0.5),
    /**
     * 키당 한도 (AI Studio > Rate limits 에서 모델별 값을 확인해 넣으면 429 없이 선제적으로 분산한다).
     * 0 = 모름 → 429 응답으로 한도를 학습한다.
     */
    rpmPerKey: int('GEMINI_RPM_PER_KEY', 0),
    tpmPerKey: int('GEMINI_TPM_PER_KEY', 0),
    rpdPerKey: int('GEMINI_RPD_PER_KEY', 0),
    maxConcurrencyPerKey: int('GEMINI_MAX_CONCURRENCY_PER_KEY', 4),
    /** 모든 키가 바쁠 때 사용자 요청이 대기열에서 기다리는 최대 시간 (전체 제한 시간 안에서) */
    queueWaitMs: int('GEMINI_QUEUE_WAIT_MS', 12_000),
    /** 대기열 최대 길이 (초과 시 즉시 "잠시 후 다시" 응답 → 대기 중인 이미지 버퍼로 메모리가 차지 않게) */
    maxQueue: int('GEMINI_MAX_QUEUE', 100),
    /** 배치(주간 조정)는 키별 일일 한도의 이 비율을 사용자 요청용으로 남겨둔다 */
    batchReserveRatio: float('GEMINI_BATCH_RESERVE_RATIO', 0.2),
    /** 무료 티어 일일 쿼터 리셋 기준 타임존 (Google: 태평양 시간 자정) */
    quotaTimeZone: str('GEMINI_QUOTA_TZ', 'America/Los_Angeles'),

    /** 개발용: Gemini 키 없이 고정 응답으로 화면 흐름을 확인. production 에서는 무시된다. */
    mock: bool('AI_MOCK', false) && !isProduction,
  },
  analyzeDailyLimit: int('ANALYZE_DAILY_LIMIT', 50),
  maxUploadBytes: 10 * 1024 * 1024,

  /** 사진 분석 작업 (이미지는 분석하는 동안만 서버에 암호화해 임시 저장하고, 끝나면 즉시 파기) */
  analysis: {
    /** 임시 이미지 최대 보관 시간. 이 안에 분석되지 않으면 작업을 만료시키고 이미지를 파기한다. */
    imageTtlSec: int('ANALYSIS_IMAGE_TTL_SEC', 300),
    /** 임시 저장 디렉터리 (비우면 OS 임시 디렉터리 아래 diet-analysis) */
    tmpDir: str('ANALYSIS_TMP_DIR'),
    /** 동시에 분석할 작업 수 (0 = 키 개수 × 키당 동시 요청 수, 최대 12) */
    workerConcurrency: int('ANALYSIS_WORKER_CONCURRENCY', 0),
    /** 사용자당 동시에 진행 중일 수 있는 분석 작업 수 */
    maxPendingPerUser: int('ANALYSIS_MAX_PENDING_PER_USER', 3),
    /** 같은 사진을 다시 올리면 이 시간 안의 기존 결과를 재사용 (AI 호출 절약) */
    dedupWindowSec: int('ANALYSIS_DEDUP_WINDOW_SEC', 600),
  },

  mail: {
    transport: str('MAIL_TRANSPORT', 'smtp') as 'smtp' | 'console',
    host: str('SMTP_HOST'),
    port: int('SMTP_PORT', 587),
    secure: bool('SMTP_SECURE', false),
    user: str('SMTP_USER'),
    pass: str('SMTP_PASS'),
    from: str('MAIL_FROM', '다이어트 기록 <no-reply@example.com>'),
  },
  appBaseUrl: str('APP_BASE_URL', 'http://localhost:5173'),

  enableScheduler: bool('ENABLE_SCHEDULER', true),
  promptsDir: str('PROMPTS_DIR', path.join(BACKEND_ROOT, 'prompts')),

  login: { maxFailures: 5, lockMinutes: 15 },
  passwordReset: { ttlMinutes: 30, maxPerHour: 3 },
} as const;

export type AppConfig = typeof config;
