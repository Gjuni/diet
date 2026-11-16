import { Router } from 'express';
import { pool, query, queryOne, withTransaction } from '../db.js';
import { conflict, notFound } from '../lib/errors.js';
import { isValidMacroRatio, type MacroRatio } from '../lib/nutrition.js';
import { clock, todayKst, weekStartOf } from '../lib/time.js';
import { parseUuidParam } from '../lib/validate.js';
import { getAuth, requireAuth } from '../middleware/auth.js';

export const adjustmentsRouter = Router();
adjustmentsRouter.use(requireAuth);

interface AdjustmentRow {
  id: string;
  week_start: string;
  prev_target_kcal: number;
  adjustment_kcal: number;
  new_target_kcal: number;
  ai_adjustment_kcal: number | null;
  prev_macro_ratio: MacroRatio | null;
  macro_ratio: MacroRatio;
  reason: string;
  confidence: 'low' | 'medium' | 'high' | null;
  status: 'applied' | 'rejected' | 'failed';
  guard_notes: string[];
  created_at: Date;
  rejected_at: Date | null;
}

const COLUMNS = `id, week_start, prev_target_kcal, adjustment_kcal, new_target_kcal, ai_adjustment_kcal,
  prev_macro_ratio, macro_ratio, reason, confidence, status, guard_notes, created_at, rejected_at`;

function serialize(r: AdjustmentRow, currentWeekStart: string) {
  return {
    id: r.id,
    week_start: r.week_start,
    prev_target_kcal: r.prev_target_kcal,
    adjustment_kcal: r.adjustment_kcal,
    new_target_kcal: r.new_target_kcal,
    ai_adjustment_kcal: r.ai_adjustment_kcal,
    macro_ratio: r.macro_ratio,
    prev_macro_ratio: r.prev_macro_ratio,
    reason: r.reason,
    confidence: r.confidence,
    status: r.status,
    guard_notes: r.guard_notes,
    created_at: r.created_at,
    rejected_at: r.rejected_at,
    /** 이번 주에 적용된 조정만 거부(이전 값 유지)할 수 있다 */
    can_reject: r.status === 'applied' && r.week_start === currentWeekStart,
  };
}

/** GET /api/adjustments — 주간 칼로리 조정 이력 (최신순) */
adjustmentsRouter.get('/', async (req, res) => {
  const { userId } = getAuth(req);
  const rows = await query<AdjustmentRow>(
    pool,
    `SELECT ${COLUMNS} FROM weekly_calorie_adjustments WHERE user_id = $1 ORDER BY week_start DESC LIMIT 104`,
    [userId],
  );
  const currentWeek = weekStartOf(todayKst(clock.now()));
  res.json({ items: rows.map((r) => serialize(r, currentWeek)) });
});

/** POST /api/adjustments/:id/reject — 조정 거부: 목표 칼로리/비율을 조정 전 값으로 되돌린다 */
adjustmentsRouter.post('/:id/reject', async (req, res) => {
  const { userId } = getAuth(req);
  const id = parseUuidParam(req.params.id);
  const currentWeek = weekStartOf(todayKst(clock.now()));
  const now = clock.now();

  const row = await withTransaction(async (db) => {
    const adj = await queryOne<AdjustmentRow>(
      db,
      `SELECT ${COLUMNS} FROM weekly_calorie_adjustments WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [id, userId],
    );
    if (!adj) throw notFound('조정 이력을 찾을 수 없습니다.');
    if (adj.status !== 'applied') throw conflict('이미 거부되었거나 적용되지 않은 조정입니다.', 'NOT_REJECTABLE');
    if (adj.week_start !== currentWeek) throw conflict('이번 주 조정만 거부할 수 있습니다.', 'NOT_REJECTABLE');

    const ratio = isValidMacroRatio(adj.prev_macro_ratio) ? adj.prev_macro_ratio : null;
    await query(
      db,
      `UPDATE user_profiles
          SET target_kcal = $2,
              target_carbs_pct = coalesce($3, target_carbs_pct),
              target_protein_pct = coalesce($4, target_protein_pct),
              target_fat_pct = coalesce($5, target_fat_pct)
        WHERE user_id = $1`,
      [userId, adj.prev_target_kcal, ratio?.carbs ?? null, ratio?.protein ?? null, ratio?.fat ?? null],
    );
    return queryOne<AdjustmentRow>(
      db,
      `UPDATE weekly_calorie_adjustments SET status = 'rejected', rejected_at = $2 WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, now],
    );
  });

  res.json({ item: serialize(row!, currentWeek), target_kcal: row!.prev_target_kcal });
});
