import { query, queryOne, type Db } from '../db.js';
import { badRequest } from '../lib/errors.js';
import { isValidPer100, normalizePer100, type Category, type Per100g } from '../lib/nutrition.js';
import { toKstIso, toKstTime, type MealSlot } from '../lib/time.js';

export interface MealRow {
  id: string;
  user_id: string;
  eaten_at: Date;
  local_date: string;
  meal_slot: MealSlot;
  source: 'ai' | 'manual';
  created_at: Date;
}

export interface MealItemRow {
  id: string;
  meal_id: string;
  position: number;
  name: string;
  category: Category;
  grams: number | null;
  grams_source: 'ai' | 'user' | null;
  grams_confidence: 'high' | 'medium' | 'low' | null;
  carbs_per_100g: number;
  protein_per_100g: number;
  fat_per_100g: number;
  note: string | null;
  carbs_g: number | null;
  protein_g: number | null;
  fat_g: number | null;
  kcal: number | null;
  created_at: Date;
}

export interface NewItem {
  name: string;
  category: Category;
  grams: number | null;
  grams_source?: 'ai' | 'user' | null;
  grams_confidence?: 'high' | 'medium' | 'low' | null;
  per_100g: Per100g;
  note?: string | null;
  ai_raw?: Record<string, unknown> | null;
}

const ITEM_COLUMNS = `id, meal_id, position, name, category, grams, grams_source, grams_confidence,
  carbs_per_100g, protein_per_100g, fat_per_100g, note, carbs_g, protein_g, fat_g, kcal, created_at`;

export function serializeItem(r: MealItemRow) {
  return {
    id: r.id,
    meal_id: r.meal_id,
    name: r.name,
    category: r.category,
    grams: r.grams,
    grams_source: r.grams_source,
    grams_confidence: r.grams_confidence,
    /** g 미입력 → "g 입력 필요" 배지, 일일 합계에서 제외 */
    needs_grams: r.grams === null,
    per_100g: { carbs: r.carbs_per_100g, protein: r.protein_per_100g, fat: r.fat_per_100g },
    carbs_g: r.carbs_g,
    protein_g: r.protein_g,
    fat_g: r.fat_g,
    kcal: r.kcal,
    note: r.note,
  };
}

export function serializeMeal(m: MealRow, items: MealItemRow[]) {
  const sorted = [...items].sort((a, b) => a.position - b.position || a.created_at.getTime() - b.created_at.getTime());
  return {
    id: m.id,
    eaten_at: m.eaten_at.toISOString(),
    eaten_at_kst: toKstIso(m.eaten_at),
    time_kst: toKstTime(m.eaten_at).slice(0, 5),
    local_date: m.local_date,
    meal_slot: m.meal_slot,
    source: m.source,
    items: sorted.map(serializeItem),
  };
}

async function itemsFor(db: Db, mealIds: string[]): Promise<MealItemRow[]> {
  if (mealIds.length === 0) return [];
  return query<MealItemRow>(db, `SELECT ${ITEM_COLUMNS} FROM meal_items WHERE meal_id = ANY($1::uuid[])`, [mealIds]);
}

export async function loadMealsForDate(db: Db, userId: string, date: string) {
  const meals = await query<MealRow>(
    db,
    `SELECT id, user_id, eaten_at, local_date, meal_slot, source, created_at FROM meals
      WHERE user_id = $1 AND local_date = $2 ORDER BY eaten_at, created_at`,
    [userId, date],
  );
  const items = await itemsFor(
    db,
    meals.map((m) => m.id),
  );
  return meals.map((m) =>
    serializeMeal(
      m,
      items.filter((i) => i.meal_id === m.id),
    ),
  );
}

/** 본인 식사만 조회 (남의 식사는 404 로 취급해 존재 여부도 숨긴다) */
export async function findOwnMeal(db: Db, userId: string, mealId: string, forUpdate = false): Promise<MealRow | null> {
  return queryOne<MealRow>(
    db,
    `SELECT id, user_id, eaten_at, local_date, meal_slot, source, created_at FROM meals
      WHERE id = $1 AND user_id = $2 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [mealId, userId],
  );
}

export async function loadMeal(db: Db, meal: MealRow) {
  return serializeMeal(meal, await itemsFor(db, [meal.id]));
}

export async function findOwnItem(db: Db, userId: string, itemId: string) {
  return queryOne<MealItemRow & { local_date: string; user_id: string }>(
    db,
    `SELECT mi.id, mi.meal_id, mi.position, mi.name, mi.category, mi.grams, mi.grams_source, mi.grams_confidence,
            mi.carbs_per_100g, mi.protein_per_100g, mi.fat_per_100g, mi.note,
            mi.carbs_g, mi.protein_g, mi.fat_g, mi.kcal, mi.created_at, m.local_date, m.user_id
       FROM meal_items mi JOIN meals m ON m.id = mi.meal_id
      WHERE mi.id = $1 AND m.user_id = $2
      FOR UPDATE OF mi`,
    [itemId, userId],
  );
}

export function preparePer100(v: Per100g): Per100g {
  const n = normalizePer100(v);
  if (!isValidPer100(n)) {
    throw badRequest('100g당 탄수화물·단백질·지방의 합은 100g 을 넘을 수 없습니다.', 'INVALID_MACROS');
  }
  return n;
}

export async function insertItems(db: Db, mealId: string, items: NewItem[], mealSource: 'ai' | 'manual', startPosition = 0) {
  let pos = startPosition;
  for (const it of items) {
    const per = preparePer100(it.per_100g);
    const grams = it.grams === null ? null : Math.round(it.grams * 10) / 10;
    const gramsSource = grams === null ? null : (it.grams_source ?? (mealSource === 'ai' ? 'ai' : 'user'));
    await query(
      db,
      `INSERT INTO meal_items (meal_id, position, name, category, grams, grams_source, grams_confidence,
                               carbs_per_100g, protein_per_100g, fat_per_100g, note, ai_raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        mealId,
        pos++,
        it.name.trim(),
        it.category,
        grams,
        gramsSource,
        it.grams_confidence ?? null,
        per.carbs,
        per.protein,
        per.fat,
        it.note?.trim() || null,
        it.ai_raw ? JSON.stringify(it.ai_raw) : null,
      ],
    );
  }
}

export interface DayTotalsRow {
  meal_count: number;
  item_count: number;
  items_missing_grams: number;
  carbs_g: number;
  protein_g: number;
  fat_g: number;
  kcal: number;
}

export async function dayTotals(db: Db, userId: string, date: string): Promise<DayTotalsRow> {
  const row = await queryOne<DayTotalsRow>(
    db,
    `SELECT meal_count, item_count, items_missing_grams, carbs_g, protein_g, fat_g, kcal
       FROM v_daily_nutrition WHERE user_id = $1 AND local_date = $2`,
    [userId, date],
  );
  return row ?? { meal_count: 0, item_count: 0, items_missing_grams: 0, carbs_g: 0, protein_g: 0, fat_g: 0, kcal: 0 };
}
