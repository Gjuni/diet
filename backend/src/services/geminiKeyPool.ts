import crypto from 'node:crypto';

/**
 * Gemini API 키 풀 — 여러 키(무료 티어 포함)를 병목 없이 최대한 활용한다.
 *
 * [선택] 사용 가능한 키 중
 *   (이번 요청에서 아직 안 쓴 키) → (동시 요청 적은 키) → (분당 토큰 사용률 낮은 키) → (분당 요청 사용률 낮은 키)
 *   → (일일 사용률 낮은 키) → (평균 지연 짧은 키) → (가장 오래 전에 쓴 키 = round-robin)
 *
 * [한도] 키별로 3가지 창(window)을 동시에 관리한다.
 *   - RPM: 최근 60초 요청 수
 *   - TPM: 최근 60초 입력 토큰 수. 요청 시 "추정 토큰"을 예약하고, 응답의 실제 promptTokenCount 로 정산한다.
 *          → 이미지 요청이 몰려도 TPM 을 넘기기 전에 다른 키로 분산된다.
 *   - RPD: 쿼터 기준일(태평양시) 요청 수
 *   한도를 설정하지 않으면(0) 429 응답으로 한도를 "학습"해 이후에는 선제적으로 피한다 (15분 후 재학습).
 *
 * [429] quotaId 로 종류를 구분한다.
 *   - PerDay → 다음 쿼터 리셋(태평양시 자정)까지 제외
 *   - Token·PerMinute → TPM 쿨다운(retryDelay)
 *   - 그 외 → RPM 쿨다운(retryDelay)
 *
 * [대기열] 바로 쓸 키가 없으면 공정한 대기열(사용자 요청 우선, 같은 우선순위는 선착순)에서 기다린다.
 *   대기열이 가득 차면 즉시 거절해 서버 메모리(대기 중인 이미지 버퍼)를 보호한다.
 *
 * [보관] 키 원문은 메모리에만. 로그/DB 에는 SHA-256 지문(앞 12자리)만 남긴다.
 */

export type Priority = 'interactive' | 'batch';
export type QuotaKind = 'daily' | 'tpm' | 'rpm';

export interface KeyPoolOptions {
  rpmPerKey: number;
  tpmPerKey: number;
  rpdPerKey: number;
  maxConcurrentPerKey: number;
  batchReserveRatio: number;
  quotaTimeZone: string;
  failureThreshold: number;
  circuitOpenMs: number;
  defaultRpmCooldownMs: number;
  defaultTpmCooldownMs: number;
  invalidKeyDisableMs: number;
  windowMs: number;
  learnTtlMs: number;
  maxQueue: number;
}

export const DEFAULT_POOL_OPTIONS: KeyPoolOptions = {
  rpmPerKey: 0,
  tpmPerKey: 0,
  rpdPerKey: 0,
  maxConcurrentPerKey: 4,
  batchReserveRatio: 0.2,
  quotaTimeZone: 'America/Los_Angeles',
  failureThreshold: 3,
  circuitOpenMs: 60_000,
  defaultRpmCooldownMs: 60_000,
  defaultTpmCooldownMs: 20_000,
  invalidKeyDisableMs: 60 * 60_000,
  windowMs: 60_000,
  learnTtlMs: 15 * 60_000,
  maxQueue: 100,
};

/** 풀이 해석하는 오류 정보 (GeminiError 의 일부) */
export interface KeyErrorInfo {
  code: string;
  quotaKind?: QuotaKind;
  retryAfterMs?: number;
}

export type LeaseOutcome =
  | { kind: 'success'; latencyMs: number; tokensIn: number | null; tokensOut: number | null }
  | { kind: 'error'; error: KeyErrorInfo }
  | { kind: 'aborted' };

export interface KeyLease {
  keyId: string;
  label: string;
  apiKey: string;
  release(outcome: LeaseOutcome): void;
}

export interface UsageDelta {
  requests?: number;
  successes?: number;
  rateLimited?: number;
  failures?: number;
  tokensIn?: number;
  tokensOut?: number;
  exhausted?: boolean;
}

/** 키별 일일 사용량 영속화 (재시작해도 "오늘 얼마나 썼는지" 유지) */
export interface KeyUsageStore {
  load(dayKey: string): Promise<Array<{ keyId: string; requests: number; exhausted: boolean }>>;
  record(keyId: string, dayKey: string, delta: UsageDelta): void;
}

type KeyStateName = 'ok' | 'busy' | 'cooldown' | 'exhausted' | 'disabled';

interface TokenEvent {
  t: number;
  tokens: number;
}

interface Learned {
  limit: number;
  until: number;
}

interface KeyState {
  id: string;
  label: string;
  apiKey: string;
  index: number;
  inFlight: number;
  recent: number[];
  tokens: TokenEvent[];
  dayKey: string;
  dailyUsed: number;
  cooldownUntil: number;
  exhaustedUntil: number;
  disabledUntil: number;
  consecutiveFailures: number;
  ewmaLatencyMs: number | null;
  lastPickedSeq: number;
  learnedRpm: Learned | null;
  learnedTpm: Learned | null;
}

export interface KeyStatus {
  label: string;
  keyId: string;
  state: KeyStateName;
  inFlight: number;
  rpmUsed: number;
  rpmLimit: number | null;
  tpmUsed: number;
  tpmLimit: number | null;
  dailyUsed: number;
  rpdLimit: number | null;
  availableAt: string | null;
  ewmaLatencyMs: number | null;
}

interface Ticket {
  priority: Priority;
  seq: number;
}

/** API 키 지문: 원문을 복원할 수 없는 SHA-256 앞 12자리 */
export function keyFingerprint(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 12);
}

function zonedParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
  };
}

/** 쿼터 기준 날짜 (기본: 태평양 시간) */
export function quotaDayKey(ms: number, timeZone: string): string {
  return zonedParts(ms, timeZone).date;
}

/** 다음 쿼터 리셋 시각 (해당 타임존 자정). 서머타임 전환일에는 최대 1시간 오차 → 다시 429 면 재학습 */
export function nextQuotaReset(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const sinceMidnight = ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 + (ms % 1000);
  return ms - sinceMidnight + 24 * 60 * 60 * 1000;
}

export class GeminiKeyPool {
  private readonly keys: KeyState[];
  private readonly opts: KeyPoolOptions;
  private readonly store?: KeyUsageStore;
  private readonly now: () => number;
  private loaded: Promise<void> | null = null;
  private seq = 0;
  private ticketSeq = 0;
  private readonly queue: Ticket[] = [];
  private waiters = new Set<() => void>();

  constructor(apiKeys: string[], opts: Partial<KeyPoolOptions> = {}, store?: KeyUsageStore, now: () => number = Date.now) {
    this.opts = { ...DEFAULT_POOL_OPTIONS, ...opts };
    this.store = store;
    this.now = now;
    const day = quotaDayKey(now(), this.opts.quotaTimeZone);
    this.keys = apiKeys.map((apiKey, index) => {
      const id = keyFingerprint(apiKey);
      return {
        id,
        label: `key#${index + 1}(${id.slice(0, 6)})`,
        apiKey,
        index,
        inFlight: 0,
        recent: [],
        tokens: [],
        dayKey: day,
        dailyUsed: 0,
        cooldownUntil: 0,
        exhaustedUntil: 0,
        disabledUntil: 0,
        consecutiveFailures: 0,
        ewmaLatencyMs: null,
        lastPickedSeq: -1,
        learnedRpm: null,
        learnedTpm: null,
      };
    });
  }

  get size(): number {
    return this.keys.length;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  /** 오늘 사용량 복원 (최초 1회) */
  ready(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        if (!this.store || this.keys.length === 0) return;
        const now = this.now();
        const day = quotaDayKey(now, this.opts.quotaTimeZone);
        try {
          // DB 가 느리거나 커넥션이 바빠도 AI 호출을 막지 않도록 3초까지만 기다린다
          const rows = await Promise.race([
            this.store.load(day),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('load timeout')), 3_000).unref()),
          ]);
          for (const r of rows) {
            const k = this.keys.find((x) => x.id === r.keyId);
            if (!k) continue;
            k.dayKey = day;
            k.dailyUsed = Math.max(k.dailyUsed, r.requests);
            if (r.exhausted) k.exhaustedUntil = nextQuotaReset(now, this.opts.quotaTimeZone);
          }
        } catch (err) {
          console.warn('[gemini-pool] 사용량 복원 실패(무시):', (err as Error).message);
        }
      })();
    }
    return this.loaded;
  }

  // ---------------------------------------------------------------------------
  // 한도 계산
  // ---------------------------------------------------------------------------
  private refresh(k: KeyState, now: number) {
    const day = quotaDayKey(now, this.opts.quotaTimeZone);
    if (k.dayKey !== day) {
      k.dayKey = day;
      k.dailyUsed = 0;
      k.exhaustedUntil = 0;
    }
    const windowStart = now - this.opts.windowMs;
    while (k.recent.length && k.recent[0]! <= windowStart) k.recent.shift();
    while (k.tokens.length && k.tokens[0]!.t <= windowStart) k.tokens.shift();
    if (k.learnedRpm && now >= k.learnedRpm.until) k.learnedRpm = null;
    if (k.learnedTpm && now >= k.learnedTpm.until) k.learnedTpm = null;
  }

  private rpmLimit(k: KeyState): number {
    return this.opts.rpmPerKey > 0 ? this.opts.rpmPerKey : (k.learnedRpm?.limit ?? 0);
  }

  private tpmLimit(k: KeyState): number {
    return this.opts.tpmPerKey > 0 ? this.opts.tpmPerKey : (k.learnedTpm?.limit ?? 0);
  }

  private windowTokens(k: KeyState): number {
    return k.tokens.reduce((a, e) => a + e.tokens, 0);
  }

  private dailyCap(priority: Priority): number {
    const { rpdPerKey, batchReserveRatio } = this.opts;
    if (rpdPerKey <= 0) return Infinity;
    return priority === 'batch' ? Math.floor(rpdPerKey * (1 - batchReserveRatio)) : rpdPerKey;
  }

  private stateOf(k: KeyState, now: number, priority: Priority, tokens = 0): KeyStateName {
    this.refresh(k, now);
    if (now < k.disabledUntil) return 'disabled';
    if (now < k.exhaustedUntil || k.dailyUsed >= this.dailyCap(priority)) return 'exhausted';
    if (now < k.cooldownUntil) return 'cooldown';
    if (k.inFlight >= this.opts.maxConcurrentPerKey) return 'busy';
    const rpm = this.rpmLimit(k);
    if (rpm > 0 && k.recent.length >= rpm) return 'busy';
    const tpm = this.tpmLimit(k);
    const used = this.windowTokens(k);
    // 창이 비어 있으면 한도보다 큰 요청도 1건은 보낸다 (영원히 막히지 않도록)
    if (tpm > 0 && used > 0 && used + tokens > tpm) return 'busy';
    return 'ok';
  }

  private pick(priority: Priority, avoid: ReadonlySet<string> | undefined, tokens: number): KeyState | null {
    const now = this.now();
    const usable = this.keys.filter((k) => this.stateOf(k, now, priority, tokens) === 'ok');
    if (usable.length === 0) return null;
    const rpd = this.opts.rpdPerKey;
    const score = (k: KeyState): number[] => {
      const rpm = this.rpmLimit(k);
      const tpm = this.tpmLimit(k);
      return [
        avoid?.has(k.id) ? 1 : 0,
        k.inFlight,
        tpm > 0 ? Math.floor(((this.windowTokens(k) + tokens) / tpm) * 10) : 0,
        rpm > 0 ? Math.floor((k.recent.length / rpm) * 10) : 0,
        rpd > 0 ? Math.floor((k.dailyUsed / rpd) * 20) : 0,
        Math.round((k.ewmaLatencyMs ?? 0) / 1000), // 1초 단위로 뭉개서 사소한 차이로 한 키에 쏠리지 않게
        k.lastPickedSeq,
      ];
    };
    usable.sort((a, b) => {
      const sa = score(a);
      const sb = score(b);
      for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i]! - sb[i]!;
      return a.index - b.index;
    });
    return usable[0]!;
  }

  // ---------------------------------------------------------------------------
  // 대여 / 반납
  // ---------------------------------------------------------------------------
  private lease(k: KeyState, tokens: number): KeyLease {
    const now = this.now();
    k.inFlight += 1;
    k.recent.push(now);
    const reservation: TokenEvent = { t: now, tokens };
    if (tokens > 0) k.tokens.push(reservation);
    k.dailyUsed += 1; // 구글은 실패/취소된 요청도 쿼터로 센다
    k.lastPickedSeq = this.seq++;
    this.store?.record(k.id, k.dayKey, { requests: 1 });
    let released = false;
    return {
      keyId: k.id,
      label: k.label,
      apiKey: k.apiKey,
      release: (outcome) => {
        if (released) return;
        released = true;
        k.inFlight = Math.max(0, k.inFlight - 1);
        // 예약했던 추정 토큰을 실제 입력 토큰으로 정산
        if (outcome.kind === 'success' && outcome.tokensIn !== null && tokens > 0) reservation.tokens = outcome.tokensIn;
        this.apply(k, outcome);
        this.notify();
      },
    };
  }

  private apply(k: KeyState, outcome: LeaseOutcome) {
    const now = this.now();
    if (outcome.kind === 'aborted') return;
    if (outcome.kind === 'success') {
      k.consecutiveFailures = 0;
      k.ewmaLatencyMs = k.ewmaLatencyMs === null ? outcome.latencyMs : k.ewmaLatencyMs * 0.7 + outcome.latencyMs * 0.3;
      this.store?.record(k.id, k.dayKey, {
        successes: 1,
        tokensIn: outcome.tokensIn ?? 0,
        tokensOut: outcome.tokensOut ?? 0,
      });
      return;
    }
    const e = outcome.error;
    switch (e.code) {
      case 'rate_limited': {
        this.refresh(k, now);
        if (e.quotaKind === 'daily') {
          k.exhaustedUntil = nextQuotaReset(now, this.opts.quotaTimeZone);
          console.warn(`[gemini-pool] ${k.label} 일일 한도 소진 → ${new Date(k.exhaustedUntil).toISOString()} 까지 제외`);
          this.store?.record(k.id, k.dayKey, { rateLimited: 1, exhausted: true });
          return;
        }
        // 한도 학습은 이 서버가 충분히 보낸 뒤 받은 429 일 때만 한다.
        // (몇 건 보내지도 않았는데 429 면 같은 프로젝트를 다른 곳에서 쓰는 중일 수 있어 쿨다운만 한다)
        if (e.quotaKind === 'tpm') {
          k.cooldownUntil = Math.max(k.cooldownUntil, now + (e.retryAfterMs ?? this.opts.defaultTpmCooldownMs));
          if (this.opts.tpmPerKey <= 0 && k.tokens.length >= 2) {
            // 이번 창에서 쓴 토큰의 90% 를 한도로 학습
            k.learnedTpm = { limit: Math.max(1, Math.floor(this.windowTokens(k) * 0.9)), until: now + this.opts.learnTtlMs };
          }
        } else {
          k.cooldownUntil = Math.max(k.cooldownUntil, now + (e.retryAfterMs ?? this.opts.defaultRpmCooldownMs));
          if (this.opts.rpmPerKey <= 0 && k.recent.length >= 3) {
            k.learnedRpm = { limit: k.recent.length - 1, until: now + this.opts.learnTtlMs };
          }
        }
        this.store?.record(k.id, k.dayKey, { rateLimited: 1 });
        return;
      }
      case 'invalid_key':
        k.disabledUntil = now + this.opts.invalidKeyDisableMs;
        console.error(`[gemini-pool] ${k.label} 키가 유효하지 않거나 권한이 없습니다. 1시간 동안 제외합니다.`);
        this.store?.record(k.id, k.dayKey, { failures: 1 });
        return;
      case 'upstream_error':
      case 'network':
      case 'stalled':
      case 'incomplete':
        // (전체 제한 시간 초과 'timeout' 은 모델이 느린 것일 수 있어 키 벌점에서 제외)
        k.consecutiveFailures += 1;
        if (k.consecutiveFailures >= this.opts.failureThreshold) {
          k.cooldownUntil = Math.max(k.cooldownUntil, now + this.opts.circuitOpenMs);
          k.consecutiveFailures = 0;
          console.warn(`[gemini-pool] ${k.label} 연속 실패 → ${this.opts.circuitOpenMs / 1000}초 회로 차단`);
        }
        this.store?.record(k.id, k.dayKey, { failures: 1 });
        return;
      default:
        // 응답 잘림/형식 오류/차단 등은 키 문제가 아니므로 벌점 없음
        return;
    }
  }

  private notify() {
    const ws = [...this.waiters];
    this.waiters.clear();
    for (const w of ws) w();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  private enqueue(t: Ticket) {
    // 사용자 요청(interactive)이 배치보다 앞, 같은 우선순위는 선착순
    const rank = (x: Ticket) => (x.priority === 'interactive' ? 0 : 1);
    const idx = this.queue.findIndex((q) => rank(q) > rank(t));
    if (idx < 0) this.queue.push(t);
    else this.queue.splice(idx, 0, t);
  }

  /** 모든 키가 오늘 쓸 수 없는 상태(소진/비활성)인가 */
  isExhausted(priority: Priority = 'interactive'): boolean {
    const now = this.now();
    return this.keys.every((k) => {
      const s = this.stateOf(k, now, priority);
      return s === 'exhausted' || s === 'disabled';
    });
  }

  /**
   * 키 빌리기. 바로 쓸 키가 없으면 대기열에서 waitMs 까지 기다린다.
   *  - tokens: 이 요청의 추정 입력 토큰 (TPM 예약용)
   *  - waitMs=0 이면 대기열에 들어가지 않는다 (hedging 처럼 "되면 하고 아니면 마는" 요청).
   *  - 모든 키가 오늘 소진이거나 대기열이 가득 차면 즉시 null.
   */
  async acquire(
    opts: { priority?: Priority; avoid?: ReadonlySet<string>; waitMs?: number; tokens?: number } = {},
  ): Promise<KeyLease | null> {
    await this.ready();
    if (this.keys.length === 0) return null;
    const priority = opts.priority ?? 'interactive';
    const tokens = Math.max(0, Math.round(opts.tokens ?? 0));

    // 앞에 기다리는 요청이 없으면 바로 시도 (새치기 방지)
    if (this.queue.length === 0) {
      const k = this.pick(priority, opts.avoid, tokens);
      if (k) return this.lease(k, tokens);
    }
    const waitMs = Math.max(0, opts.waitMs ?? 0);
    if (waitMs === 0 || this.isExhausted(priority) || this.queue.length >= this.opts.maxQueue) return null;

    const ticket: Ticket = { priority, seq: this.ticketSeq++ };
    this.enqueue(ticket);
    const until = this.now() + waitMs;
    try {
      for (;;) {
        if (this.queue[0] === ticket) {
          const k = this.pick(priority, opts.avoid, tokens);
          if (k) return this.lease(k, tokens);
        }
        const now = this.now();
        if (now >= until || this.isExhausted(priority)) return null;
        await this.sleep(Math.max(5, Math.min(100, until - now)));
      }
    } finally {
      const i = this.queue.indexOf(ticket);
      if (i >= 0) this.queue.splice(i, 1);
      this.notify();
    }
  }

  /** hedging(병렬 예비 요청)을 해도 되는가: 다른 키가 바로 쓸 수 있고, 대기열이 비었고, 일일 예산이 충분할 때만 */
  canHedge(exclude: ReadonlySet<string>, minBudgetRatio: number, tokens = 0): boolean {
    if (this.queue.length > 0) return false;
    const now = this.now();
    const other = this.keys.some((k) => !exclude.has(k.id) && this.stateOf(k, now, 'interactive', tokens) === 'ok');
    if (!other) return false;
    const rpd = this.opts.rpdPerKey;
    if (rpd <= 0) return true;
    const live = this.keys.filter((k) => this.stateOf(k, now, 'interactive') !== 'disabled');
    const remaining = live.reduce((a, k) => a + Math.max(0, rpd - k.dailyUsed), 0);
    return remaining / (rpd * Math.max(1, live.length)) >= minBudgetRatio;
  }

  status(): KeyStatus[] {
    const now = this.now();
    return this.keys.map((k) => {
      const state = this.stateOf(k, now, 'interactive');
      const until = Math.max(k.disabledUntil, k.exhaustedUntil, k.cooldownUntil);
      const rpm = this.rpmLimit(k);
      const tpm = this.tpmLimit(k);
      return {
        label: k.label,
        keyId: k.id,
        state,
        inFlight: k.inFlight,
        rpmUsed: k.recent.length,
        rpmLimit: rpm > 0 ? rpm : null,
        tpmUsed: this.windowTokens(k),
        tpmLimit: tpm > 0 ? tpm : null,
        dailyUsed: k.dailyUsed,
        rpdLimit: this.opts.rpdPerKey > 0 ? this.opts.rpdPerKey : null,
        availableAt: until > now ? new Date(until).toISOString() : null,
        ewmaLatencyMs: k.ewmaLatencyMs === null ? null : Math.round(k.ewmaLatencyMs),
      };
    });
  }
}
