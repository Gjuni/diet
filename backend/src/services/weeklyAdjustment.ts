import type pg from 'pg';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, query, queryOne, type Db } from '../db.js';
import { bmrMifflin, round1, tdee, type MacroRatio } from '../lib/nutrition.js';
import { addDays, ageOn, clock, kstStartOfDay, todayKst, weekStartOf } from '../lib/time.js';
import { applyAdjustmentGuards, guardNotesText, type GuardNote } from './adjustmentGuard.js';
import { GeminiError, generateJson, getKeyPool, loadPrompt, type GeminiDeps } from './gemini.js';
import { ratioOf, type ProfileRow } from './profileService.js';
import { mean } from './statsCalc.js';

// -----------------------------------------------------------------------------
// AI 입력 만들기 (최근 4주 = 이번 주 월요일 직전 28일)
// -----------------------------------------------------------------------------
export interface WeeklyInput {
  week_start: string;
  window: { from: string; to: string };
  profile: {
    sex: 'male' | 'female';
    age: number;
    height_cm: number;
    goal_type: 'lose' | 'maintain' | 'gain';
    activity_level: string;
    start_weight_kg: number;
    goal_weight_kg: number;
    current_weight_kg: number;
  };
  current_target_kcal: number;
  current_macro_ratio: MacroRatio;
  bmr_kcal: number;
  tdee_estimate_kcal: number;
  last_week: WeekSummary;
  weekly_summary: WeekSummary[];
  missing_days_last_week: number;
  missing_days_4w: number;
  /** 최근 연속으로 의미 있는 감량(주당 -0.25% 이상)이 없었던 주 수 (감량 목표일 때만) */
  stalled_weeks: number;
  daily: Array<{
    date: string;
    kcal: number | null;
    carbs_g: number | null;
    protein_g: number | null;
    fat_g: number | null;
    items_missing_grams: number;
    weight_kg: number | null;
    exercised: boolean;
  }>;
}

export interface WeekSummary {
  week_start: string;
  logged_days: number;
  missing_days: number;
  avg_kcal: number | null;
  avg_carbs_g: number | null;
  avg_protein_g: number | null;
  avg_fat_g: number | null;
  exercise_count: number;
  weigh_in_days: number;
  avg_weight_kg: number | null;
  weight_change_kg: number | null;
  weight_change_pct: number | null;
}

const r1 = (v: number | null) => (v === null ? null : round1(v));

export async function buildWeeklyInput(db: Db, userId: string, weekStart: string): Promise<WeeklyInput | null> {
  const profile = await queryOne<ProfileRow>(db, `SELECT * FROM user_profiles WHERE user_id = $1`, [userId]);
  if (!profile) return null;
  const from = addDays(weekStart, -28);
  const to = addDays(weekStart, -1);

  // 같은 커넥션(트랜잭션 클라이언트)일 수 있으므로 순차 실행
  const nutrition = await query<{
    local_date: string;
    carbs_g: number;
    protein_g: number;
    fat_g: number;
    kcal: number;
    items_missing_grams: number;
    meal_count: number;
  }>(
    db,
    `SELECT local_date, carbs_g, protein_g, fat_g, kcal, items_missing_grams, meal_count
       FROM v_daily_nutrition WHERE user_id = $1 AND local_date BETWEEN $2 AND $3`,
    [userId, from, to],
  );
  const logs = await query<{ local_date: string; exercised: boolean; weight_kg: number | null }>(
    db,
    `SELECT local_date, exercised, weight_kg FROM daily_logs WHERE user_id = $1 AND local_date BETWEEN $2 AND $3`,
    [userId, from, to],
  );
  const nByDate = new Map(nutrition.map((n) => [n.local_date, n]));
  const lByDate = new Map(logs.map((l) => [l.local_date, l]));

  const daily: WeeklyInput['daily'] = Array.from({ length: 28 }, (_, i) => {
    const date = addDays(from, i);
    const n = nByDate.get(date);
    const l = lByDate.get(date);
    const logged = Boolean(n && n.meal_count > 0);
    return {
      date,
      kcal: logged ? n!.kcal : null,
      carbs_g: logged ? n!.carbs_g : null,
      protein_g: logged ? n!.protein_g : null,
      fat_g: logged ? n!.fat_g : null,
      items_missing_grams: n?.items_missing_grams ?? 0,
      weight_kg: l?.weight_kg ?? null,
      exercised: l?.exercised ?? false,
    };
  });

  const weeks: WeekSummary[] = [];
  for (let w = 0; w < 4; w++) {
    const days = daily.slice(w * 7, w * 7 + 7);
    const logged = days.filter((d) => d.kcal !== null);
    const weights = days.map((d) => d.weight_kg).filter((v): v is number => v !== null);
    const avgWeight = mean(weights);
    const prev = weeks[w - 1];
    const change = avgWeight !== null && prev?.avg_weight_kg != null ? avgWeight - prev.avg_weight_kg : null;
    weeks.push({
      week_start: days[0]!.date,
      logged_days: logged.length,
      missing_days: 7 - logged.length,
      avg_kcal: r1(mean(logged.map((d) => d.kcal!))),
      avg_carbs_g: r1(mean(logged.map((d) => d.carbs_g!))),
      avg_protein_g: r1(mean(logged.map((d) => d.protein_g!))),
      avg_fat_g: r1(mean(logged.map((d) => d.fat_g!))),
      exercise_count: days.filter((d) => d.exercised).length,
      weigh_in_days: weights.length,
      avg_weight_kg: r1(avgWeight),
      weight_change_kg: change === null ? null : Math.round(change * 100) / 100,
      weight_change_pct: change === null || !prev?.avg_weight_kg ? null : Math.round((change / prev.avg_weight_kg) * 10000) / 100,
    });
  }

  let stalled = 0;
  if (profile.goal_type === 'lose') {
    for (let w = 3; w >= 1; w--) {
      const pct = weeks[w]!.weight_change_pct;
      if (pct === null || pct > -0.25) stalled += 1;
      else break;
    }
  }

  const today = todayKst(clock.now());
  const latestWeight = [...daily].reverse().find((d) => d.weight_kg !== null)?.weight_kg ?? null;
  const fallbackWeight = await queryOne<{ weight_kg: number }>(
    db,
    `SELECT weight_kg FROM daily_logs WHERE user_id = $1 AND weight_kg IS NOT NULL AND local_date <= $2
      ORDER BY local_date DESC LIMIT 1`,
    [userId, today],
  );
  const currentWeight = latestWeight ?? fallbackWeight?.weight_kg ?? profile.start_weight_kg;
  const age = ageOn(profile.birth_date, today);
  const bmr = bmrMifflin({ sex: profile.sex, weightKg: currentWeight, heightCm: profile.height_cm, age });

  return {
    week_start: weekStart,
    window: { from, to },
    profile: {
      sex: profile.sex,
      age,
      height_cm: profile.height_cm,
      goal_type: profile.goal_type,
      activity_level: profile.activity_level,
      start_weight_kg: profile.start_weight_kg,
      goal_weight_kg: profile.goal_weight_kg,
      current_weight_kg: currentWeight,
    },
    current_target_kcal: profile.target_kcal,
    current_macro_ratio: ratioOf(profile),
    bmr_kcal: Math.round(bmr),
    tdee_estimate_kcal: Math.round(tdee(bmr, profile.activity_level)),
    last_week: weeks[3]!,
    weekly_summary: weeks,
    missing_days_last_week: weeks[3]!.missing_days,
    missing_days_4w: weeks.reduce((a, w) => a + w.missing_days, 0),
    stalled_weeks: stalled,
    daily,
  };
}

// -----------------------------------------------------------------------------
// AI 응답 스키마 / 검증
// -----------------------------------------------------------------------------
export const WEEKLY_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    adjustment_kcal: { type: 'INTEGER', description: '이번 주 목표 칼로리 변화량 (음수=감소)' },
    new_target_kcal: { type: 'INTEGER', description: '현재 목표 + 조정량' },
    macro_ratio: {
      type: 'OBJECT',
      properties: { carbs: { type: 'INTEGER' }, protein: { type: 'INTEGER' }, fat: { type: 'INTEGER' } },
      required: ['carbs', 'protein', 'fat'],
      propertyOrdering: ['carbs', 'protein', 'fat'],
    },
    reason: { type: 'STRING', description: '사용자에게 보여줄 2~3문장 한국어 설명' },
    confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
  },
  required: ['adjustment_kcal', 'new_target_kcal', 'macro_ratio', 'reason', 'confidence'],
  propertyOrdering: ['adjustment_kcal', 'new_target_kcal', 'macro_ratio', 'reason', 'confidence'],
} as const;

const aiWeeklySchema = z.object({
  adjustment_kcal: z.number(),
  new_target_kcal: z.number(),
  macro_ratio: z.object({ carbs: z.number(), protein: z.number(), fat: z.number() }),
  reason: z.string().trim().min(1).max(600),
  confidence: z.enum(['low', 'medium', 'high']),
});
export type AiWeekly = z.infer<typeof aiWeeklySchema>;

export function validateWeeklyResponse(raw: unknown): AiWeekly | null {
  const r = aiWeeklySchema.safeParse(raw);
  return r.success ? r.data : null;
}

// -----------------------------------------------------------------------------
// 사용자 1명 처리
// -----------------------------------------------------------------------------
async function inTx<T>(client: pg.PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const r = await fn();
    await client.query('COMMIT');
    return r;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

export type ProcessOutcome = 'applied' | 'failed' | 'skipped' | 'deferred';

/** AI 를 한 번도 호출하지 못한 실패(키 소진/혼잡) → 나중 재시도 대상 */
const DEFERRABLE = new Set(['quota_exhausted', 'all_keys_busy']);

export async function processUserWeekly(
  client: pg.PoolClient,
  userId: string,
  weekStart: string,
  opts: { deps?: GeminiDeps; finalAttempt?: boolean } = {},
): Promise<ProcessOutcome> {
  const input = await buildWeeklyInput(client, userId, weekStart);
  if (!input) return 'skipped';

  const { mock, model } = config.gemini;
  const pool_ = opts.deps?.pool ?? getKeyPool();
  let ai: AiWeekly | null = null;
  let errorCode: string | null = null;
  let attempts = 0;
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let latencyMs = 0;
  let keyId: string | null = null;

  if (mock) {
    ai = {
      adjustment_kcal: 0,
      new_target_kcal: input.current_target_kcal,
      macro_ratio: input.current_macro_ratio,
      reason: '(개발용 모의 응답) 지난주 데이터를 기준으로 목표를 그대로 유지합니다.',
      confidence: 'low',
    };
  } else if (pool_.size === 0) {
    errorCode = 'not_configured';
  } else {
    const systemPrompt = loadPrompt('weekly_adjustment');
    const started = Date.now();
    // 1회 + 응답 검증 실패 시 1회 재시도 (키 문제/끊김은 generateJson 이 다른 키로 처리)
    for (let i = 0; i < 2 && !ai; i++) {
      try {
        const r = await generateJson(
          {
            kind: 'weekly',
            priority: 'batch',
            systemPrompt,
            parts: [
              {
                text: `다음은 사용자의 최근 4주 기록입니다. 규칙에 따라 이번 주 목표 칼로리를 정하세요.

${JSON.stringify(input)}`,
              },
            ],
            responseSchema: WEEKLY_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
          },
          opts.deps,
        );
        attempts += r.attempts;
        tokensIn = (tokensIn ?? 0) + (r.tokensIn ?? 0);
        tokensOut = (tokensOut ?? 0) + (r.tokensOut ?? 0);
        keyId = r.keyId;
        ai = validateWeeklyResponse(JSON.parse(r.text));
        errorCode = ai ? null : 'schema_mismatch';
      } catch (err) {
        if (!(err instanceof GeminiError)) throw err;
        attempts += err.attempts;
        errorCode = err.code;
        keyId = err.keyId ?? keyId;
        break;
      }
    }
    latencyMs = Date.now() - started;
  }

  // 키가 모두 소진/혼잡해 AI 를 한 번도 못 불렀으면, 마지막 실행이 아닌 한 기록하지 않고 미룬다
  // (같은 날 재시도 배치가 쿼터 리셋 후 다시 처리 → 무료 티어 한도를 최대한 활용)
  if (!ai && attempts === 0 && errorCode && DEFERRABLE.has(errorCode) && !opts.finalAttempt) return 'deferred';

  const now = clock.now();
  const outcome = await inTx(client, async () => {
    // 최신 목표값 기준으로 안전장치 적용 (입력을 만든 뒤 사용자가 바꿨을 수도 있으므로)
    const p = await queryOne<ProfileRow>(client, `SELECT * FROM user_profiles WHERE user_id = $1 FOR UPDATE`, [userId]);
    if (!p) return 'skipped' as const;
    const prevRatio = ratioOf(p);
    const bmr = bmrMifflin({
      sex: p.sex,
      weightKg: input.profile.current_weight_kg,
      heightCm: p.height_cm,
      age: ageOn(p.birth_date, todayKst(now)),
    });

    let status: 'applied' | 'failed';
    let reason: string;
    let notes: GuardNote[];
    let adjustment = 0;
    let newTarget = p.target_kcal;
    let ratio = prevRatio;
    if (ai) {
      const g = applyAdjustmentGuards({
        prevTargetKcal: p.target_kcal,
        aiAdjustmentKcal: ai.adjustment_kcal,
        aiNewTargetKcal: ai.new_target_kcal,
        sex: p.sex,
        bmr,
        missingDaysLastWeek: input.missing_days_last_week,
        prevMacroRatio: prevRatio,
        aiMacroRatio: ai.macro_ratio,
      });
      status = 'applied';
      adjustment = g.adjustmentKcal;
      newTarget = g.newTargetKcal;
      ratio = g.macroRatio;
      notes = g.notes;
      reason = [ai.reason, ...guardNotesText(g.notes, g.minTargetKcal)].join(' ');
    } else {
      status = 'failed';
      notes = ['ai_failed'];
      reason = 'AI 분석에 실패해 이번 주 목표 칼로리는 그대로 유지합니다.';
    }

    const inserted = await queryOne<{ id: string }>(
      client,
      `INSERT INTO weekly_calorie_adjustments
         (user_id, week_start, prev_target_kcal, adjustment_kcal, new_target_kcal, ai_adjustment_kcal,
          prev_macro_ratio, macro_ratio, reason, confidence, status, guard_notes, error_code, ai_raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (user_id, week_start) DO NOTHING
       RETURNING id`,
      [
        userId,
        weekStart,
        p.target_kcal,
        adjustment,
        newTarget,
        ai ? Math.round(ai.adjustment_kcal) : null,
        JSON.stringify(prevRatio),
        JSON.stringify(ratio),
        reason,
        ai?.confidence ?? null,
        status,
        JSON.stringify(notes),
        errorCode,
        ai ? JSON.stringify(ai) : null,
      ],
    );
    if (!inserted) return 'skipped' as const; // 이미 처리됨 (중복 실행)
    if (status === 'applied') {
      await query(
        client,
        `UPDATE user_profiles SET target_kcal = $2, target_carbs_pct = $3, target_protein_pct = $4, target_fat_pct = $5
          WHERE user_id = $1`,
        [userId, newTarget, ratio.carbs, ratio.protein, ratio.fat],
      );
    }
    return status;
  });

  if (attempts > 0 || mock) {
    await query(
      client,
      `INSERT INTO ai_usage_logs (user_id, kind, model, api_key_id, local_date, tokens_in, tokens_out, latency_ms, attempts, success, error_code)
       VALUES ($1, 'weekly', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [userId, mock ? 'mock' : model, keyId, todayKst(now), tokensIn, tokensOut, latencyMs, Math.min(10, attempts), ai !== null, errorCode],
    ).catch((err: Error) => console.error('[weekly] usage log 실패:', err.message));
  }
  return outcome;
}

// -----------------------------------------------------------------------------
// 배치: 매주 월요일 00:05 KST
// -----------------------------------------------------------------------------
const ADVISORY_LOCK_KEY = 771_000_001;

export interface WeeklyRunSummary {
  week_start: string;
  locked: boolean;
  final: boolean;
  lanes: number;
  total: number;
  applied: number;
  failed: number;
  skipped: number;
  deferred: number;
  errors: number;
}

/**
 * 주간 조정 배치.
 *  - 여러 인스턴스가 동시에 실행해도 advisory lock 으로 한 곳만 처리한다.
 *  - 키 개수만큼 병렬 lane 으로 처리한다 (키 풀이 RPM/TPM 에 맞춰 속도를 조절).
 *  - 키가 모두 소진/혼잡하면 남은 사용자는 "미룸(deferred)" → 같은 날 재시도 배치에서 처리.
 *    마지막 실행(finalAttempt)에서도 실패하면 조정 0 으로 기록한다.
 */
export async function runWeeklyAdjustments(
  opts: { now?: Date; deps?: GeminiDeps; finalAttempt?: boolean } = {},
): Promise<WeeklyRunSummary> {
  const now = opts.now ?? clock.now();
  const weekStart = weekStartOf(todayKst(now));
  const keyPool = opts.deps?.pool ?? getKeyPool();
  const summary: WeeklyRunSummary = {
    week_start: weekStart,
    locked: false,
    final: opts.finalAttempt === true,
    lanes: 1,
    total: 0,
    applied: 0,
    failed: 0,
    skipped: 0,
    deferred: 0,
    errors: 0,
  };

  const lockClient = await pool.connect();
  const extraClients: Array<import('pg').PoolClient> = [];
  try {
    const lock = await queryOne<{ locked: boolean }>(lockClient, `SELECT pg_try_advisory_lock($1) AS locked`, [ADVISORY_LOCK_KEY]);
    if (!lock?.locked) return summary;
    summary.locked = true;
    try {
      const users = await query<{ user_id: string }>(
        lockClient,
        `SELECT p.user_id FROM user_profiles p JOIN users u ON u.id = p.user_id
          WHERE u.deleted_at IS NULL
            AND p.created_at < $2
            AND NOT EXISTS (SELECT 1 FROM weekly_calorie_adjustments a WHERE a.user_id = p.user_id AND a.week_start = $1)
          ORDER BY p.user_id`,
        [weekStart, kstStartOfDay(weekStart)],
      );
      summary.total = users.length;

      // lane 수 = min(키 개수, 3, DB 커넥션 여유). lane 0 은 lock 커넥션을 같이 쓴다.
      const wanted = Math.max(1, Math.min(keyPool.size || 1, 3, config.pgPoolMax - 1, users.length || 1));
      const clients = [lockClient];
      for (let i = 1; i < wanted; i++) {
        const c = await pool.connect();
        extraClients.push(c);
        clients.push(c);
      }
      summary.lanes = clients.length;

      const queue = users.map((u) => u.user_id);
      let stop = false;
      await Promise.all(
        clients.map(async (client) => {
          while (!stop && queue.length > 0) {
            const userId = queue.shift()!;
            try {
              const r = await processUserWeekly(client, userId, weekStart, { deps: opts.deps, finalAttempt: opts.finalAttempt });
              summary[r] += 1;
              if (r === 'deferred' && !opts.finalAttempt && keyPool.isExhausted('batch')) {
                // 오늘 쓸 수 있는 키가 없다 → 나머지도 미루고 종료
                stop = true;
                summary.deferred += queue.length;
                queue.length = 0;
              }
            } catch (err) {
              summary.errors += 1;
              console.error(`[weekly] user=${userId} 처리 실패:`, (err as Error).message);
            }
          }
        }),
      );
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    for (const c of extraClients) c.release();
    lockClient.release();
  }
  console.info(`[weekly] ${JSON.stringify(summary)}`);
  return summary;
}
