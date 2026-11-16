import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, errorMessage, get, put } from '../api/client';
import type { DayResponse, DayTotals, Meal, MealItem, MealSlot } from '../api/types';
import { AddMealFlow } from '../components/AddMealFlow';
import { ChevronLeft, ChevronRight, PlusIcon, TrashIcon } from '../components/Icons';
import { draftFromMealItem, draftToPayload, evaluateDraft, ItemEditor, type DraftItem } from '../components/ItemEditor';
import { ProgressBar } from '../components/ProgressBar';
import { Sheet } from '../components/Sheet';
import { SLOT_LABEL, SLOTS } from '../lib/constants';
import { addDays, formatDateKo, isValidDate, kstIso } from '../lib/date';
import { n0, n1 } from '../lib/format';
import { pct } from '../lib/nutrition';
import { useServerTime } from '../time/ServerTime';

const MACRO_COLORS = { carbs: 'var(--series-1)', protein: 'var(--series-2)', fat: 'var(--series-3)' };

export function DayPage() {
  const { date } = useParams();
  const { today } = useServerTime();
  const navigate = useNavigate();
  const [data, setData] = useState<DayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<MealItem | null>(null);
  const [weight, setWeight] = useState('');
  const [weightMsg, setWeightMsg] = useState<string | null>(null);

  const valid = isValidDate(date);
  const isFuture = valid && date! > today;

  const load = useCallback(async () => {
    if (!valid || isFuture) return;
    try {
      const d = await get<DayResponse>(`/days/${date}`);
      setData(d);
      setWeight(d.daily_log.weight_kg === null ? '' : String(d.daily_log.weight_kg));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [date, valid, isFuture]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  if (!valid || isFuture) {
    return (
      <div className="stack">
        <p className="notice warn">{isFuture ? '미래 날짜는 열 수 없어요.' : '잘못된 날짜예요.'}</p>
        <Link className="btn" to="/">
          달력으로
        </Link>
      </div>
    );
  }
  const d = date!;
  const isToday = d === today;

  const applyTotals = (totals: DayTotals) => setData((prev) => (prev ? { ...prev, totals } : prev));

  const toggleExercise = async (checked: boolean) => {
    setData((p) => (p ? { ...p, daily_log: { ...p.daily_log, exercised: checked } } : p));
    try {
      await put(`/days/${d}/exercise`, { exercised: checked });
    } catch (e) {
      setData((p) => (p ? { ...p, daily_log: { ...p.daily_log, exercised: !checked } } : p));
      setError(errorMessage(e));
    }
  };

  const saveWeight = async () => {
    setWeightMsg(null);
    const v = weight.trim() === '' ? null : Number(weight.replace(',', '.'));
    if (v !== null && (!Number.isFinite(v) || v < 20 || v > 300)) {
      setWeightMsg('체중은 20~300kg 사이로 입력해 주세요.');
      return;
    }
    try {
      const r = await put<{ weight_kg: number | null }>(`/days/${d}/weight`, { weight_kg: v });
      setWeight(r.weight_kg === null ? '' : String(r.weight_kg));
      setWeightMsg(r.weight_kg === null ? '체중 기록을 지웠어요.' : `${n1(r.weight_kg)}kg 저장했어요.`);
    } catch (e) {
      setWeightMsg(errorMessage(e));
    }
  };

  const t = data?.totals;
  const tg = data?.targets;

  return (
    <div className="stack">
      <div className="page-header">
        <button type="button" className="icon-btn" onClick={() => navigate(`/day/${addDays(d, -1)}`)} aria-label="전날">
          <ChevronLeft />
        </button>
        <h1 className="center grow">
          {formatDateKo(d)} {isToday && <span className="badge cat">오늘</span>}
        </h1>
        <button
          type="button"
          className="icon-btn"
          onClick={() => navigate(`/day/${addDays(d, 1)}`)}
          aria-label="다음 날"
          disabled={d >= today}
        >
          <ChevronRight />
        </button>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {!data ? (
        !error && <div className="empty">불러오는 중…</div>
      ) : (
        <>
          {/* 상단 요약 */}
          <section className="card" aria-label="섭취 요약">
            <div className="row between">
              <div>
                <div className="small muted">섭취 / 목표</div>
                <div className="kcal-big num">
                  {n1(t!.kcal)} <span className="small muted">/ {tg ? `${n0(tg.kcal)} kcal` : '-'}</span>
                </div>
              </div>
              {tg && (
                <div className={`small ${t!.kcal > tg.kcal ? 'delta-up' : 'muted'}`}>
                  {t!.kcal > tg.kcal ? `${n0(t!.kcal - tg.kcal)} kcal 초과` : `${n0(tg.kcal - t!.kcal)} kcal 남음`}
                </div>
              )}
            </div>
            {tg && <ProgressBar value={t!.kcal} max={tg.kcal} label="목표 칼로리 대비 섭취" />}
            <div className="stack" style={{ marginTop: 12, gap: 8 }}>
              {(
                [
                  ['carbs', '탄수화물', t!.carbs_g, tg?.carbs_g],
                  ['protein', '단백질', t!.protein_g, tg?.protein_g],
                  ['fat', '지방', t!.fat_g, tg?.fat_g],
                ] as const
              ).map(([k, label, v, target]) => (
                <div className="macro-row" key={k}>
                  <span>
                    <i className="macro-dot" style={{ background: MACRO_COLORS[k] }} />
                    {label}
                  </span>
                  <ProgressBar value={v} max={target ?? 0} label={`${label} 목표 대비`} thin />
                  <span className="num small">
                    {n1(v)}g{target ? ` · ${pct(v, target)}%` : ''}
                  </span>
                </div>
              ))}
            </div>
            {t!.items_missing_grams > 0 && (
              <p className="notice warn" style={{ margin: '12px 0 0' }}>
                g 을 입력하지 않은 음식 {t!.items_missing_grams}개는 합계에서 빠져 있어요.
              </p>
            )}
          </section>

          {/* 운동 / 체중 */}
          <section className="card stack" aria-label="운동과 체중">
            <label className="row between">
              <span>
                <strong>{isToday ? '오늘 운동했나요?' : '이날 운동했나요?'}</strong>
              </span>
              <span className="switch">
                <input type="checkbox" checked={data.daily_log.exercised} onChange={(e) => toggleExercise(e.target.checked)} />
                <span />
              </span>
            </label>
            <div className="row">
              <label className="field grow">
                <span>체중</span>
                <div className="input-suffix">
                  <input
                    className="input"
                    inputMode="decimal"
                    placeholder="예: 68.5"
                    value={weight}
                    onChange={(e) => setWeight(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && saveWeight()}
                  />
                  <em>kg</em>
                </div>
              </label>
              <button type="button" className="btn" style={{ marginTop: 22 }} onClick={saveWeight}>
                저장
              </button>
            </div>
            {weightMsg && (
              <p className="small muted" style={{ margin: 0 }} aria-live="polite">
                {weightMsg}
              </p>
            )}
          </section>

          {/* 식사 타임라인 */}
          <section className="stack" aria-label="식사 기록">
            <div className="row between">
              <h2 style={{ fontSize: '1.05rem', margin: 0 }}>식사</h2>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
                <PlusIcon width={18} /> 식사 추가
              </button>
            </div>
            {data.meals.length === 0 ? (
              <div className="card empty">아직 기록한 식사가 없어요.</div>
            ) : (
              <div className="timeline">
                {data.meals.map((m) => (
                  <MealCard
                    key={m.id}
                    meal={m}
                    date={d}
                    onEditItem={setEditing}
                    onChanged={(totals) => {
                      applyTotals(totals);
                      void load();
                    }}
                    onError={setError}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {adding && (
        <AddMealFlow
          date={d}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
      {editing && (
        <EditItemSheet
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function MealCard({
  meal,
  date,
  onEditItem,
  onChanged,
  onError,
}: {
  meal: Meal;
  date: string;
  onEditItem: (it: MealItem) => void;
  onChanged: (totals: DayTotals) => void;
  onError: (msg: string) => void;
}) {
  const [time, setTime] = useState(meal.time_kst);
  const mealKcal = meal.items.reduce((a, i) => a + (i.kcal ?? 0), 0);

  const patchMeal = async (body: { eaten_at?: string; meal_slot?: MealSlot }) => {
    try {
      const r = await api<{ day_totals: DayTotals }>(`/meals/${meal.id}`, { method: 'PATCH', body });
      onChanged(r.day_totals);
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  const remove = async () => {
    if (!confirm('이 식사 기록을 삭제할까요?')) return;
    try {
      const r = await api<{ day_totals: DayTotals }>(`/meals/${meal.id}`, { method: 'DELETE' });
      onChanged(r.day_totals);
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  return (
    <article className="meal-card">
      <header>
        <input
          className="input compact time"
          type="time"
          value={time}
          aria-label="먹은 시각"
          onChange={(e) => setTime(e.target.value)}
          onBlur={() => time !== meal.time_kst && /^\d{2}:\d{2}$/.test(time) && patchMeal({ eaten_at: kstIso(date, time) })}
        />
        <select
          value={meal.meal_slot}
          aria-label="끼니 구분"
          onChange={(e) => patchMeal({ meal_slot: e.target.value as MealSlot })}
        >
          {SLOTS.map((s) => (
            <option key={s} value={s}>
              {SLOT_LABEL[s]}
            </option>
          ))}
        </select>
        <span className="grow" />
        <button type="button" className="icon-btn" onClick={remove} aria-label="식사 삭제">
          <TrashIcon />
        </button>
      </header>
      {meal.items.map((it) => (
        <button key={it.id} type="button" className="meal-item" onClick={() => onEditItem(it)}>
          <div className="grow">
            <div className="row wrap" style={{ gap: 6 }}>
              <span className="name">{it.name}</span>
              <span className="badge cat">{it.category}</span>
              {it.needs_grams ? <span className="badge warn">g 입력 필요</span> : <span className="badge num">{n1(it.grams)}g</span>}
            </div>
            <div className="macros">
              {it.needs_grams
                ? `100g당 탄 ${n1(it.per_100g.carbs)} · 단 ${n1(it.per_100g.protein)} · 지 ${n1(it.per_100g.fat)}g`
                : `탄 ${n1(it.carbs_g)}g · 단 ${n1(it.protein_g)}g · 지 ${n1(it.fat_g)}g`}
            </div>
          </div>
          <div className="kcal">{it.needs_grams ? '-' : `${n1(it.kcal)}`}<span className="tiny muted"> kcal</span></div>
        </button>
      ))}
      <footer>
        <span>{meal.source === 'ai' ? 'AI 사진 분석' : '직접 입력'}</span>
        <span>
          합계 <strong>{n1(mealKcal)}</strong> kcal
        </span>
      </footer>
    </article>
  );
}

function EditItemSheet({ item, onClose, onSaved }: { item: MealItem; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<DraftItem>(() => draftFromMealItem(item));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const e = evaluateDraft(draft);
    if (e.error) {
      setErr(e.error);
      return;
    }
    setBusy(true);
    try {
      const p = draftToPayload(draft, 'manual');
      await api(`/meal-items/${item.id}`, {
        method: 'PATCH',
        body: { name: p.name, category: p.category, grams: p.grams, per_100g: p.per_100g, note: p.note },
      });
      onSaved();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : errorMessage(x));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`'${item.name}' 을(를) 삭제할까요?`)) return;
    try {
      await api(`/meal-items/${item.id}`, { method: 'DELETE' });
      onSaved();
    } catch (x) {
      setErr(errorMessage(x));
    }
  };

  return (
    <Sheet title="음식 수정" onClose={onClose}>
      <div className="stack">
        <ItemEditor draft={draft} onChange={setDraft} />
        {err && (
          <p className="notice error" role="alert" style={{ margin: 0 }}>
            {err}
          </p>
        )}
        <button type="button" className="btn btn-primary btn-block" onClick={save} disabled={busy}>
          {busy ? '저장 중…' : '저장 (g 을 바꾸면 바로 다시 계산돼요)'}
        </button>
        <button type="button" className="btn btn-danger btn-block" onClick={remove}>
          이 음식 삭제
        </button>
      </div>
    </Sheet>
  );
}
