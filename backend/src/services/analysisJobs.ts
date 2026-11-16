import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { pool, query, queryOne } from '../db.js';
import { HttpError, notFound, tooManyRequests } from '../lib/errors.js';
import { clock, todayKst } from '../lib/time.js';
import { aiFailure, aiFailureInfo, runFoodAnalysis, type FoodAnalysis } from './foodAnalysis.js';
import { getKeyPool, type GeminiDeps } from './gemini.js';
import { TempImageStore } from './tempImageStore.js';

/**
 * 사진 분석 작업(job)
 *
 *  접수 → 이미지를 작업별 키로 암호화해 서버 임시 디렉터리에 저장 → 워커가 키 풀로 분석
 *  → 끝나면(성공/실패/취소/만료 모두) 이미지를 먼저 파기하고, 분석 결과(JSON)만 DB 에 남긴다.
 *
 *  - DB 에는 이미지가 아니라 SHA-256 지문/크기/형식만 저장한다 (같은 사진 재업로드 시 결과 재사용).
 *  - 모든 키가 바쁘면 이미지를 보관한 채 대기열로 되돌려 다시 시도한다 → 재업로드 없이 버스트를 흡수.
 *  - 보관 시간(TTL)이 지나면 어떤 상태든 이미지를 파기하고 작업을 만료시킨다.
 *  - 끝난 작업은 image_purged_at 이 반드시 있어야 한다 (DB CHECK 제약).
 */

export type JobStatus = 'queued' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'expired';
const FINAL: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'canceled', 'expired']);

interface JobRow {
  id: string;
  user_id: string;
  status: JobStatus;
  image_sha256: string;
  image_bytes: number;
  image_mime: string;
  image_purged_at: Date | null;
  result: (FoodAnalysis & { model: string }) | null;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  expires_at: Date;
}

const COLUMNS = `id, user_id, status, image_sha256, image_bytes, image_mime, image_purged_at, result,
  error_code, error_message, attempts, created_at, started_at, finished_at, expires_at`;

export interface JobView {
  id: string;
  status: JobStatus;
  created_at: Date;
  expires_at: Date;
  finished_at: Date | null;
  /** 대기열 순번 (1 = 다음 차례). 처리 중이거나 다른 서버가 맡은 작업이면 null */
  queue_position: number | null;
  image_purged: boolean;
  result: (FoodAnalysis & { model: string }) | null;
  error: { code: string; message: string; manual_entry_suggested: true } | null;
  deduplicated?: boolean;
}

interface FinishPatch {
  status: Exclude<JobStatus, 'queued' | 'processing'>;
  result?: (FoodAnalysis & { model: string }) | null;
  errorCode?: string | null;
  attempts?: number;
  model?: string | null;
  keyId?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  latencyMs?: number | null;
}

export class AnalysisJobService {
  readonly store: TempImageStore;
  private readonly queue: string[] = [];
  private readonly running = new Map<string, AbortController>();
  private readonly events = new EventEmitter();
  private readonly gemini: GeminiDeps;
  private readonly concurrencyOverride?: number;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(opts: { gemini?: GeminiDeps; concurrency?: number; store?: TempImageStore } = {}) {
    this.store = opts.store ?? new TempImageStore(config.analysis.tmpDir || undefined);
    this.gemini = opts.gemini ?? {};
    this.concurrencyOverride = opts.concurrency;
    this.events.setMaxListeners(0);
  }

  private get concurrency(): number {
    if (this.concurrencyOverride) return this.concurrencyOverride;
    if (config.analysis.workerConcurrency > 0) return config.analysis.workerConcurrency;
    const keys = (this.gemini.pool ?? getKeyPool()).size;
    return Math.min(12, Math.max(2, keys * config.gemini.maxConcurrencyPerKey));
  }

  private get ttlMs(): number {
    return config.analysis.imageTtlSec * 1000;
  }

  // ---------------------------------------------------------------------------
  // 접수
  // ---------------------------------------------------------------------------
  async submit(userId: string, image: Buffer, mimeType: string): Promise<JobView> {
    const sha = crypto.createHash('sha256').update(image).digest('hex');
    const now = clock.now();

    // 같은 사진을 최근에 올렸으면 기존 작업을 그대로 돌려준다 (AI 호출/쿼터 절약)
    const dup = await queryOne<JobRow>(
      pool,
      `SELECT ${COLUMNS} FROM food_analysis_jobs
        WHERE user_id = $1 AND image_sha256 = $2 AND created_at > $3
          AND status IN ('queued', 'processing', 'succeeded')
        ORDER BY created_at DESC LIMIT 1`,
      [userId, sha, new Date(now.getTime() - config.analysis.dedupWindowSec * 1000)],
    );
    if (dup) return { ...this.view(dup), deduplicated: true };

    const pool_ = this.gemini.pool ?? getKeyPool();
    if (pool_.size === 0 && !config.gemini.mock) throw aiFailure('not_configured');
    if (!config.gemini.mock && pool_.isExhausted('interactive')) throw aiFailure('quota_exhausted');

    const counts = await queryOne<{ pending: number; today: number }>(
      pool,
      `SELECT count(*) FILTER (WHERE status IN ('queued', 'processing')) AS pending,
              count(*) FILTER (WHERE local_date = $2 AND (status IN ('queued', 'processing') OR attempts > 0)) AS today
         FROM food_analysis_jobs WHERE user_id = $1 AND created_at > $3`,
      [userId, todayKst(now), new Date(now.getTime() - 2 * 86_400_000)],
    );
    if ((counts?.pending ?? 0) >= config.analysis.maxPendingPerUser) {
      throw tooManyRequests('분석 중인 사진이 있어요. 끝난 뒤 다시 시도해 주세요.', 'ANALYSIS_PENDING_LIMIT');
    }
    if ((counts?.today ?? 0) >= config.analyzeDailyLimit) {
      throw tooManyRequests(
        `AI 사진 분석은 하루 ${config.analyzeDailyLimit}회까지 사용할 수 있어요. 오늘은 직접 입력으로 기록해 주세요.`,
        'AI_DAILY_LIMIT',
        { manual_entry_suggested: true, limit: config.analyzeDailyLimit },
      );
    }
    if (this.queue.length >= config.gemini.maxQueue) throw aiFailure('all_keys_busy');

    const id = crypto.randomUUID();
    await this.store.put(id, image); // 암호화 임시 저장
    try {
      const row = await queryOne<JobRow>(
        pool,
        `INSERT INTO food_analysis_jobs (id, user_id, local_date, status, image_sha256, image_bytes, image_mime, expires_at, created_at)
         VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
        [id, userId, todayKst(now), sha, image.length, mimeType, new Date(now.getTime() + this.ttlMs), now],
      );
      this.enqueue(id);
      return this.view(row!);
    } catch (err) {
      await this.store.purge(id);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // 조회 / 대기 / 취소
  // ---------------------------------------------------------------------------
  private view(r: JobRow): JobView {
    const pos = this.queue.indexOf(r.id);
    const failure = r.status === 'failed' || r.status === 'expired' ? aiFailureInfo(r.error_code) : null;
    return {
      id: r.id,
      status: r.status,
      created_at: r.created_at,
      expires_at: r.expires_at,
      finished_at: r.finished_at,
      queue_position: r.status === 'queued' && pos >= 0 ? pos + 1 : null,
      image_purged: r.image_purged_at !== null,
      result: r.status === 'succeeded' ? r.result : null,
      error: failure
        ? { code: failure.code, message: r.error_message ?? failure.message, manual_entry_suggested: true }
        : null,
    };
  }

  private async load(userId: string, jobId: string): Promise<JobRow> {
    const row = await queryOne<JobRow>(pool, `SELECT ${COLUMNS} FROM food_analysis_jobs WHERE id = $1 AND user_id = $2`, [
      jobId,
      userId,
    ]);
    if (!row) throw notFound('분석 작업을 찾을 수 없습니다.');
    return row;
  }

  async get(userId: string, jobId: string): Promise<JobView> {
    return this.view(await this.load(userId, jobId));
  }

  /** long-poll: 작업이 끝나거나 waitMs 가 지날 때까지 기다렸다가 상태를 돌려준다 */
  async waitFor(userId: string, jobId: string, waitMs: number): Promise<JobView> {
    const first = await this.get(userId, jobId);
    if (FINAL.has(first.status) || waitMs <= 0) return first;
    await new Promise<void>((resolve) => {
      const onDone = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.events.removeListener(jobId, onDone);
        resolve();
      }, waitMs);
      this.events.once(jobId, onDone);
    });
    return this.get(userId, jobId);
  }

  async cancel(userId: string, jobId: string): Promise<JobView> {
    const row = await this.load(userId, jobId);
    if (FINAL.has(row.status)) return this.view(row);
    this.running.get(jobId)?.abort();
    this.removeFromQueue(jobId);
    await this.finish(jobId, { status: 'canceled', errorCode: 'canceled' });
    return this.get(userId, jobId);
  }

  // ---------------------------------------------------------------------------
  // 워커
  // ---------------------------------------------------------------------------
  private enqueue(id: string, front = false) {
    if (this.queue.includes(id) || this.running.has(id)) return;
    if (front) this.queue.unshift(id);
    else this.queue.push(id);
    this.pump();
  }

  private removeFromQueue(id: string) {
    const i = this.queue.indexOf(id);
    if (i >= 0) this.queue.splice(i, 1);
  }

  private pump() {
    while (this.running.size < this.concurrency && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const ctrl = new AbortController();
      this.running.set(id, ctrl);
      void this.process(id, ctrl)
        .catch((err: Error) => console.error(`[analysis] job=${id} 처리 오류:`, err.message))
        .finally(() => {
          this.running.delete(id);
          this.pump();
        });
    }
  }

  private async process(id: string, ctrl: AbortController) {
    const now = clock.now();
    const job = await queryOne<JobRow>(
      pool,
      `UPDATE food_analysis_jobs SET status = 'processing', started_at = coalesce(started_at, $2)
        WHERE id = $1 AND status = 'queued' RETURNING ${COLUMNS}`,
      [id, now],
    );
    if (!job) {
      await this.store.purge(id); // 취소/만료된 작업
      return;
    }
    if (job.expires_at.getTime() <= now.getTime()) {
      await this.finish(id, { status: 'expired', errorCode: 'expired' });
      return;
    }

    let image: Buffer | null = null;
    try {
      image = await this.store.read(id);
      if (!image) {
        await this.finish(id, { status: 'failed', errorCode: 'image_missing' });
        return;
      }
      const remaining = job.expires_at.getTime() - Date.now();
      const run = await runFoodAnalysis(image, job.image_mime, {
        ...this.gemini,
        signal: ctrl.signal,
        deadlineMs: Math.min(config.gemini.timeoutMs, remaining),
      });

      if (ctrl.signal.aborted) {
        await this.finish(id, { status: 'canceled', errorCode: 'canceled', attempts: run.attempts });
        return;
      }

      // 키가 모두 바빠 시작조차 못 했으면: 이미지를 보관한 채 대기열 앞쪽으로 되돌린다
      if (!run.result && run.errorCode === 'all_keys_busy' && job.expires_at.getTime() - Date.now() > 15_000) {
        await query(
          pool,
          `UPDATE food_analysis_jobs SET status = 'queued', attempts = attempts + $2 WHERE id = $1 AND status = 'processing'`,
          [id, run.attempts],
        );
        setTimeout(() => this.enqueue(id, true), 1_000).unref();
        return;
      }

      await this.finish(id, {
        status: run.result ? 'succeeded' : 'failed',
        result: run.result,
        errorCode: run.errorCode,
        attempts: run.attempts,
        model: run.model,
        keyId: run.keyId,
        tokensIn: run.tokensIn,
        tokensOut: run.tokensOut,
        latencyMs: run.latencyMs,
      });
    } catch (err) {
      await this.finish(id, { status: 'failed', errorCode: 'internal' });
      throw err;
    } finally {
      image?.fill(0); // 복호화한 사본도 즉시 지운다
    }
  }

  /** 작업 종료: ① 이미지 파기 → ② 결과만 저장 (image_purged_at 기록) → ③ 사용량 기록 / 대기자 깨우기 */
  private async finish(id: string, p: FinishPatch) {
    await this.store.purge(id);
    const message = p.status === 'succeeded' || p.status === 'canceled' ? null : aiFailureInfo(p.errorCode ?? null).message;
    const now = clock.now();
    const row = await queryOne<JobRow & { user_id: string }>(
      pool,
      `UPDATE food_analysis_jobs
          SET status = $2, result = $3, error_code = $4, error_message = $5,
              attempts = attempts + $6, model = coalesce($7, model), api_key_id = coalesce($8, api_key_id),
              tokens_in = $9, tokens_out = $10, latency_ms = $11,
              finished_at = $12, image_purged_at = $12
        WHERE id = $1 AND status IN ('queued', 'processing')
        RETURNING ${COLUMNS}`,
      [
        id,
        p.status,
        p.status === 'succeeded' && p.result ? JSON.stringify(p.result) : null,
        p.status === 'succeeded' ? null : (p.errorCode ?? null),
        message,
        p.attempts ?? 0,
        p.model ?? null,
        p.keyId ?? null,
        p.tokensIn ?? null,
        p.tokensOut ?? null,
        p.latencyMs ?? null,
        now,
      ],
    );
    if (row && row.attempts > 0) {
      await query(
        pool,
        `INSERT INTO ai_usage_logs (user_id, kind, model, api_key_id, local_date, tokens_in, tokens_out, latency_ms, attempts, success, error_code)
         VALUES ($1, 'analyze', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          row.user_id,
          p.model ?? config.gemini.model,
          p.keyId ?? null,
          todayKst(now),
          p.tokensIn ?? null,
          p.tokensOut ?? null,
          p.latencyMs ?? null,
          Math.min(10, row.attempts),
          p.status === 'succeeded',
          p.status === 'succeeded' ? null : (p.errorCode ?? null),
        ],
      ).catch((err: Error) => console.error('[analysis] usage log 실패:', err.message));
    }
    this.events.emit(id);
  }

  // ---------------------------------------------------------------------------
  // 수명 주기 / 정리
  // ---------------------------------------------------------------------------
  /** TTL 이 지난 작업 만료 + 로컬 임시 이미지 강제 파기 */
  async sweep(): Promise<void> {
    const now = clock.now();
    const expired = await query<{ id: string }>(
      pool,
      `UPDATE food_analysis_jobs
          SET status = 'expired', error_code = 'expired', error_message = $2, finished_at = $1, image_purged_at = $1
        WHERE status IN ('queued', 'processing') AND expires_at < $1
        RETURNING id`,
      [now, aiFailureInfo('expired').message],
    );
    for (const { id } of expired) {
      this.running.get(id)?.abort();
      this.removeFromQueue(id);
      await this.store.purge(id);
      this.events.emit(id);
    }
    // DB 상태와 무관하게 TTL(+여유 30초)을 넘긴 로컬 이미지는 무조건 파기
    await this.store.purgeOlderThan(this.ttlMs + 30_000);
  }

  async start(): Promise<void> {
    const removed = await this.store.sweepOrphans(this.ttlMs);
    if (removed > 0) console.info(`[analysis] 이전 프로세스의 임시 이미지 ${removed}개 정리`);
    this.sweepTimer = setInterval(() => {
      this.sweep().catch((err: Error) => console.error('[analysis] sweep 실패:', err.message));
    }, 15_000);
    this.sweepTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const c of this.running.values()) c.abort();
    await this.store.purgeAll();
  }

  stats() {
    return { queued: this.queue.length, running: this.running.size, concurrency: this.concurrency, storedImages: this.store.count };
  }
}

let shared: AnalysisJobService | null = null;
export function getAnalysisJobs(): AnalysisJobService {
  shared ??= new AnalysisJobService();
  return shared;
}

/** 저장 시 분석 작업 연결: 본인 작업이고 성공한 작업만 */
export async function assertOwnSucceededJob(userId: string, jobId: string): Promise<void> {
  const row = await queryOne(pool, `SELECT 1 FROM food_analysis_jobs WHERE id = $1 AND user_id = $2 AND status = 'succeeded'`, [
    jobId,
    userId,
  ]);
  if (!row) throw new HttpError(400, 'INVALID_ANALYSIS_JOB', '분석 결과를 찾을 수 없습니다.');
}
