import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, query, queryOne, withTransaction } from '../db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { detectImageMime } from '../lib/image.js';
import { CATEGORIES, MAX_GRAMS } from '../lib/nutrition.js';
import { mealSlotForInstant, toKstDate } from '../lib/time.js';
import { assertNotFuture, isoInstant, parse, parseUuidParam, uuid } from '../lib/validate.js';
import { getAuth, requireAuth } from '../middleware/auth.js';
import { analyzeLimiter } from '../middleware/rateLimits.js';
import { assertOwnSucceededJob, getAnalysisJobs } from '../services/analysisJobs.js';
import {
  dayTotals,
  findOwnItem,
  findOwnMeal,
  insertItems,
  loadMeal,
  preparePer100,
  serializeItem,
  type MealItemRow,
} from '../services/mealService.js';

export const mealsRouter = Router();
export const mealItemsRouter = Router();
mealsRouter.use(requireAuth);
mealItemsRouter.use(requireAuth);

const SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;

// -----------------------------------------------------------------------------
// 업로드: 메모리 저장소만 사용 (디스크/스토리지에 쓰지 않음), 최대 10MB, 파일 1개
// -----------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1, fields: 2, parts: 3 },
});

const per100Schema = z.object(
  {
    carbs: z.number({ message: '탄수화물(100g당)은 숫자여야 합니다.' }).min(0, { message: '음수는 입력할 수 없습니다.' }).max(100),
    protein: z.number({ message: '단백질(100g당)은 숫자여야 합니다.' }).min(0, { message: '음수는 입력할 수 없습니다.' }).max(100),
    fat: z.number({ message: '지방(100g당)은 숫자여야 합니다.' }).min(0, { message: '음수는 입력할 수 없습니다.' }).max(100),
  },
  { message: '100g당 영양값을 입력해 주세요.' },
);

const gramsSchema = z
  .number({ message: 'g 은 숫자여야 합니다.' })
  .gt(0, { message: 'g 은 0보다 커야 합니다.' })
  .max(MAX_GRAMS, { message: `g 은 ${MAX_GRAMS} 이하여야 합니다.` })
  .nullable();

const itemSchema = z.object({
  name: z
    .string({ message: '음식 이름을 입력해 주세요.' })
    .trim()
    .min(1, { message: '음식 이름을 입력해 주세요.' })
    .max(40, { message: '음식 이름은 40자 이하여야 합니다.' }),
  category: z.enum(CATEGORIES, { message: '카테고리를 선택해 주세요.' }),
  grams: gramsSchema,
  grams_source: z.enum(['ai', 'user']).nullable().optional(),
  grams_confidence: z.enum(['high', 'medium', 'low']).nullable().optional(),
  per_100g: per100Schema,
  note: z.string().trim().max(200).nullable().optional(),
  ai_raw: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .refine((v) => !v || JSON.stringify(v).length <= 4000, { message: 'ai_raw 가 너무 큽니다.' }),
});

const createMealSchema = z.object({
  eaten_at: isoInstant,
  meal_slot: z.enum(SLOTS, { message: '끼니 구분이 올바르지 않습니다.' }).optional(),
  source: z.enum(['ai', 'manual'], { message: 'source 는 ai 또는 manual 입니다.' }),
  /** AI 분석 결과로 저장할 때 해당 분석 작업 ID (선택) */
  analysis_job_id: uuid.optional(),
  items: z
    .array(itemSchema)
    .min(1, { message: '음식을 1개 이상 입력해 주세요.' })
    .max(20, { message: '한 끼에 음식은 20개까지 입력할 수 있습니다.' }),
});

const patchMealSchema = z
  .object({
    eaten_at: isoInstant.optional(),
    meal_slot: z.enum(SLOTS, { message: '끼니 구분이 올바르지 않습니다.' }).optional(),
  })
  .refine((v) => v.eaten_at !== undefined || v.meal_slot !== undefined, { message: '변경할 내용이 없습니다.' });

const patchItemSchema = z
  .object({
    name: itemSchema.shape.name.optional(),
    category: itemSchema.shape.category.optional(),
    grams: gramsSchema.optional(),
    per_100g: per100Schema.optional(),
    note: z.string().trim().max(200).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: '변경할 내용이 없습니다.' });

// -----------------------------------------------------------------------------
// POST /api/meals/analyze — 사진 분석 작업 접수 (202)
//   이미지는 작업별 키로 암호화해 서버에 임시 저장 → 분석이 끝나면 즉시 파기, 결과만 남는다.
//   식사로 저장하지는 않는다 (사용자가 확인/수정 후 POST /api/meals).
// -----------------------------------------------------------------------------
mealsRouter.post('/analyze', analyzeLimiter, upload.single('image'), async (req, res) => {
  const { userId } = getAuth(req);
  const file = req.file;
  if (!file) throw badRequest('분석할 사진을 첨부해 주세요.', 'IMAGE_REQUIRED');
  try {
    const mimeType = detectImageMime(file.buffer);
    if (!mimeType) throw badRequest('JPEG, PNG, WEBP, HEIC 이미지만 분석할 수 있습니다.', 'UNSUPPORTED_IMAGE');
    const job = await getAnalysisJobs().submit(userId, file.buffer, mimeType);
    res.status(job.status === 'succeeded' ? 200 : 202).json({ job, poll_after_ms: 800 });
  } finally {
    // 업로드 원본 버퍼는 암호화 저장 직후 메모리에서 지운다
    file.buffer.fill(0);
    req.file = undefined;
  }
});

/** GET /api/meals/analyze/:jobId?wait=초 — 분석 상태/결과 (long-poll, 최대 25초 대기) */
mealsRouter.get('/analyze/:jobId', async (req, res) => {
  const { userId } = getAuth(req);
  const id = parseUuidParam(req.params.jobId);
  const wait = Math.min(25, Math.max(0, Number(req.query.wait) || 0));
  res.json({ job: await getAnalysisJobs().waitFor(userId, id, wait * 1000) });
});

/** DELETE /api/meals/analyze/:jobId — 분석 취소 (임시 이미지 즉시 파기) */
mealsRouter.delete('/analyze/:jobId', async (req, res) => {
  const { userId } = getAuth(req);
  const id = parseUuidParam(req.params.jobId);
  res.json({ job: await getAnalysisJobs().cancel(userId, id) });
});

// -----------------------------------------------------------------------------
// POST /api/meals — 식사 저장 (AI 확인 화면 또는 수동 입력)
// -----------------------------------------------------------------------------
mealsRouter.post('/', async (req, res) => {
  const { userId } = getAuth(req);
  const body = parse(createMealSchema, req.body);
  const localDate = toKstDate(body.eaten_at); // KST 날짜는 서버가 계산
  assertNotFuture(localDate);
  const slot = body.meal_slot ?? mealSlotForInstant(body.eaten_at);
  if (body.analysis_job_id) await assertOwnSucceededJob(userId, body.analysis_job_id);

  const meal = await withTransaction(async (db) => {
    const m = await queryOne<{ id: string }>(
      db,
      `INSERT INTO meals (user_id, eaten_at, local_date, meal_slot, source, analysis_job_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [userId, body.eaten_at, localDate, slot, body.source, body.analysis_job_id ?? null],
    );
    await insertItems(
      db,
      m!.id,
      body.items.map((it) => ({ ...it, grams_confidence: body.source === 'ai' ? it.grams_confidence : null })),
      body.source,
    );
    const row = await findOwnMeal(db, userId, m!.id);
    return loadMeal(db, row!);
  });
  res.status(201).json({ meal, day_totals: await dayTotals(pool, userId, localDate) });
});

// -----------------------------------------------------------------------------
// PATCH /api/meals/:id — 시각 / 끼니 구분 수정
// -----------------------------------------------------------------------------
mealsRouter.patch('/:id', async (req, res) => {
  const { userId } = getAuth(req);
  const id = parseUuidParam(req.params.id);
  const body = parse(patchMealSchema, req.body);

  const result = await withTransaction(async (db) => {
    const meal = await findOwnMeal(db, userId, id, true);
    if (!meal) throw notFound('식사 기록을 찾을 수 없습니다.');
    assertNotFuture(meal.local_date);
    const eatenAt = body.eaten_at ?? meal.eaten_at;
    const localDate = toKstDate(eatenAt);
    assertNotFuture(localDate);
    // 시각만 바꾸면 끼니를 시간대에 맞게 다시 지정, 끼니를 함께 보내면 그 값을 사용
    const slot = body.meal_slot ?? (body.eaten_at ? mealSlotForInstant(eatenAt) : meal.meal_slot);
    await query(db, `UPDATE meals SET eaten_at = $2, local_date = $3, meal_slot = $4 WHERE id = $1`, [
      id,
      eatenAt,
      localDate,
      slot,
    ]);
    const updated = await findOwnMeal(db, userId, id);
    return { meal: await loadMeal(db, updated!), previousDate: meal.local_date, localDate };
  });

  res.json({
    meal: result.meal,
    day_totals: await dayTotals(pool, userId, result.localDate),
    moved_from: result.previousDate !== result.localDate ? result.previousDate : null,
  });
});

// -----------------------------------------------------------------------------
// DELETE /api/meals/:id
// -----------------------------------------------------------------------------
mealsRouter.delete('/:id', async (req, res) => {
  const { userId } = getAuth(req);
  const id = parseUuidParam(req.params.id);
  const meal = await findOwnMeal(pool, userId, id);
  if (!meal) throw notFound('식사 기록을 찾을 수 없습니다.');
  assertNotFuture(meal.local_date);
  await query(pool, `DELETE FROM meals WHERE id = $1 AND user_id = $2`, [id, userId]);
  res.json({ deleted: true, day_totals: await dayTotals(pool, userId, meal.local_date) });
});

// -----------------------------------------------------------------------------
// POST /api/meals/:id/items — 기존 식사에 음식 추가
// -----------------------------------------------------------------------------
mealsRouter.post('/:id/items', async (req, res) => {
  const { userId } = getAuth(req);
  const id = parseUuidParam(req.params.id);
  const item = parse(itemSchema, req.body);
  const meal = await withTransaction(async (db) => {
    const m = await findOwnMeal(db, userId, id, true);
    if (!m) throw notFound('식사 기록을 찾을 수 없습니다.');
    assertNotFuture(m.local_date);
    const pos = await queryOne<{ next: number }>(
      db,
      `SELECT coalesce(max(position) + 1, 0) AS next FROM meal_items WHERE meal_id = $1`,
      [id],
    );
    await insertItems(db, id, [{ ...item, grams_source: item.grams === null ? null : 'user', grams_confidence: null, ai_raw: null }], 'manual', pos?.next ?? 0);
    return loadMeal(db, m);
  });
  res.status(201).json({ meal, day_totals: await dayTotals(pool, userId, meal.local_date) });
});

// -----------------------------------------------------------------------------
// PATCH /api/meal-items/:id — g 수정 시 섭취 매크로/kcal 즉시 재계산 (GENERATED 컬럼)
// -----------------------------------------------------------------------------
mealItemsRouter.patch('/:id', async (req, res) => {
  const { userId } = getAuth(req);
  const id = parseUuidParam(req.params.id);
  const body = parse(patchItemSchema, req.body);

  const { item, localDate } = await withTransaction(async (db) => {
    const current = await findOwnItem(db, userId, id);
    if (!current) throw notFound('음식 항목을 찾을 수 없습니다.');
    assertNotFuture(current.local_date);

    const per = body.per_100g
      ? preparePer100(body.per_100g)
      : { carbs: current.carbs_per_100g, protein: current.protein_per_100g, fat: current.fat_per_100g };
    let grams = current.grams;
    let gramsSource = current.grams_source;
    if (body.grams !== undefined) {
      grams = body.grams === null ? null : Math.round(body.grams * 10) / 10;
      // 사용자가 g 을 바꾸면 출처는 user
      gramsSource = grams === null ? null : 'user';
    }

    const row = await queryOne<MealItemRow>(
      db,
      `UPDATE meal_items
          SET name = $2, category = $3, grams = $4, grams_source = $5,
              carbs_per_100g = $6, protein_per_100g = $7, fat_per_100g = $8, note = $9
        WHERE id = $1
        RETURNING id, meal_id, position, name, category, grams, grams_source, grams_confidence,
                  carbs_per_100g, protein_per_100g, fat_per_100g, note, carbs_g, protein_g, fat_g, kcal, created_at`,
      [
        id,
        body.name ?? current.name,
        body.category ?? current.category,
        grams,
        gramsSource,
        per.carbs,
        per.protein,
        per.fat,
        body.note === undefined ? current.note : body.note || null,
      ],
    );
    return { item: row!, localDate: current.local_date };
  });

  res.json({ item: serializeItem(item), day_totals: await dayTotals(pool, userId, localDate) });
});

// -----------------------------------------------------------------------------
// DELETE /api/meal-items/:id — 마지막 음식을 지우면 식사도 함께 삭제
// -----------------------------------------------------------------------------
mealItemsRouter.delete('/:id', async (req, res) => {
  const { userId } = getAuth(req);
  const id = parseUuidParam(req.params.id);
  const { localDate, mealDeleted } = await withTransaction(async (db) => {
    const current = await findOwnItem(db, userId, id);
    if (!current) throw notFound('음식 항목을 찾을 수 없습니다.');
    assertNotFuture(current.local_date);
    await query(db, `DELETE FROM meal_items WHERE id = $1`, [id]);
    const left = await queryOne<{ n: number }>(db, `SELECT count(*) AS n FROM meal_items WHERE meal_id = $1`, [
      current.meal_id,
    ]);
    let deleted = false;
    if ((left?.n ?? 0) === 0) {
      await query(db, `DELETE FROM meals WHERE id = $1 AND user_id = $2`, [current.meal_id, userId]);
      deleted = true;
    }
    return { localDate: current.local_date, mealDeleted: deleted };
  });
  res.json({ deleted: true, meal_deleted: mealDeleted, day_totals: await dayTotals(pool, userId, localDate) });
});
