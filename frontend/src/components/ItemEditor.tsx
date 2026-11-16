import type { AnalyzedItem, Category, Confidence, MealItem, Per100g } from '../api/types';
import { CATEGORIES, CONFIDENCE_LABEL } from '../lib/constants';
import { n1 } from '../lib/format';
import { itemNutrition, per100FromTotal, per100Valid, round1 } from '../lib/nutrition';
import { TrashIcon } from './Icons';

/** 화면에서 편집 중인 음식 1개 (입력값은 문자열로 들고 있다가 저장할 때 숫자로 변환) */
export interface DraftItem {
  key: string;
  name: string;
  category: Category;
  grams: string;
  /** AI 가 추정한 원래 g (사용자가 바꿨는지 판단용) */
  aiGrams: number | null;
  confidence: Confidence | null;
  mode: 'per100' | 'total';
  per100: { carbs: string; protein: string; fat: string };
  total: { carbs: string; protein: string; fat: string };
  note: string;
  aiRaw: Record<string, unknown> | null;
}

let seq = 0;
const key = () => `d${Date.now().toString(36)}${(seq++).toString(36)}`;
const s = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));

export function emptyDraft(): DraftItem {
  return {
    key: key(),
    name: '',
    category: '한식',
    grams: '',
    aiGrams: null,
    confidence: null,
    mode: 'total',
    per100: { carbs: '', protein: '', fat: '' },
    total: { carbs: '', protein: '', fat: '' },
    note: '',
    aiRaw: null,
  };
}

export function draftFromAnalysis(it: AnalyzedItem): DraftItem {
  return {
    key: key(),
    name: it.name,
    category: it.category,
    grams: s(it.estimated_grams),
    aiGrams: it.estimated_grams,
    confidence: it.grams_confidence,
    mode: 'per100',
    per100: { carbs: s(it.per_100g.carbs), protein: s(it.per_100g.protein), fat: s(it.per_100g.fat) },
    total: { carbs: '', protein: '', fat: '' },
    note: it.note ?? '',
    aiRaw: it.ai_raw,
  };
}

export function draftFromMealItem(it: MealItem): DraftItem {
  return {
    key: it.id,
    name: it.name,
    category: it.category,
    grams: s(it.grams),
    aiGrams: it.grams_source === 'ai' ? it.grams : null,
    confidence: it.grams_confidence,
    mode: 'per100',
    per100: { carbs: s(it.per_100g.carbs), protein: s(it.per_100g.protein), fat: s(it.per_100g.fat) },
    total: { carbs: '', protein: '', fat: '' },
    note: it.note ?? '',
    aiRaw: null,
  };
}

const num = (v: string): number | null => {
  if (v.trim() === '') return null;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

export interface DraftEval {
  grams: number | null;
  per100: Per100g | null;
  error: string | null;
}

/** 입력값 해석 + 검증 */
export function evaluateDraft(d: DraftItem): DraftEval {
  const grams = num(d.grams);
  if (!d.name.trim()) return { grams, per100: null, error: '음식 이름을 입력해 주세요.' };
  if (grams !== null && (Number.isNaN(grams) || grams <= 0 || grams > 5000)) {
    return { grams: null, per100: null, error: 'g 은 0보다 크고 5000 이하로 입력해 주세요.' };
  }
  let per100: Per100g;
  if (d.mode === 'per100') {
    const c = num(d.per100.carbs) ?? 0;
    const p = num(d.per100.protein) ?? 0;
    const f = num(d.per100.fat) ?? 0;
    per100 = { carbs: c, protein: p, fat: f };
  } else {
    if (grams === null) return { grams, per100: null, error: '섭취량 기준으로 입력하려면 g 을 먼저 입력해 주세요.' };
    const c = num(d.total.carbs) ?? 0;
    const p = num(d.total.protein) ?? 0;
    const f = num(d.total.fat) ?? 0;
    per100 = { carbs: per100FromTotal(c, grams), protein: per100FromTotal(p, grams), fat: per100FromTotal(f, grams) };
  }
  if (Object.values(per100).some((v) => Number.isNaN(v) || v < 0)) {
    return { grams, per100: null, error: '영양값은 0 이상의 숫자로 입력해 주세요.' };
  }
  if (!per100Valid(per100)) {
    return { grams, per100: null, error: '탄수화물·단백질·지방의 합이 100g당 100g 을 넘을 수 없어요.' };
  }
  return { grams: grams === null ? null : round1(grams), per100, error: null };
}

export function draftToPayload(d: DraftItem, source: 'ai' | 'manual') {
  const e = evaluateDraft(d);
  if (e.error || !e.per100) throw new Error(e.error ?? '입력값을 확인해 주세요.');
  const userChangedGrams = e.grams !== d.aiGrams;
  return {
    name: d.name.trim(),
    category: d.category,
    grams: e.grams,
    grams_source: e.grams === null ? null : source === 'ai' && !userChangedGrams ? 'ai' : 'user',
    grams_confidence: source === 'ai' ? d.confidence : null,
    per_100g: e.per100,
    note: d.note.trim() || null,
    ai_raw: d.aiRaw,
  };
}

export function ItemEditor({
  draft,
  onChange,
  onRemove,
  index,
}: {
  draft: DraftItem;
  onChange: (next: DraftItem) => void;
  onRemove?: () => void;
  index?: number;
}) {
  const e = evaluateDraft(draft);
  const nutrition = e.per100 ? itemNutrition(e.grams, e.per100) : null;
  const set = (patch: Partial<DraftItem>) => onChange({ ...draft, ...patch });
  const label = index !== undefined ? `음식 ${index + 1}` : '음식';

  const switchMode = (mode: 'per100' | 'total') => {
    if (mode === draft.mode) return;
    // 현재 값을 다른 방식으로 환산해 채워 준다
    if (mode === 'total' && e.per100 && e.grams) {
      const n = itemNutrition(e.grams, e.per100);
      set({ mode, total: { carbs: s(n?.carbs_g), protein: s(n?.protein_g), fat: s(n?.fat_g) } });
    } else if (mode === 'per100' && e.per100) {
      set({ mode, per100: { carbs: s(e.per100.carbs), protein: s(e.per100.protein), fat: s(e.per100.fat) } });
    } else set({ mode });
  };

  const macroInputs = draft.mode === 'per100' ? draft.per100 : draft.total;
  const setMacro = (k: 'carbs' | 'protein' | 'fat', v: string) =>
    draft.mode === 'per100' ? set({ per100: { ...draft.per100, [k]: v } }) : set({ total: { ...draft.total, [k]: v } });

  return (
    <section className="item-editor" aria-label={label}>
      <div className="row">
        <label className="field grow">
          <span>음식 이름</span>
          <input
            className="input"
            value={draft.name}
            maxLength={40}
            placeholder="예: 제육볶음"
            onChange={(ev) => set({ name: ev.target.value })}
          />
        </label>
        {onRemove && (
          <button type="button" className="icon-btn" onClick={onRemove} aria-label={`${label} 삭제`} style={{ marginTop: 20 }}>
            <TrashIcon />
          </button>
        )}
      </div>
      <div className="grid-2">
        <label className="field">
          <span>카테고리</span>
          <select className="select input" value={draft.category} onChange={(ev) => set({ category: ev.target.value as Category })}>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>
            섭취량{' '}
            {draft.confidence && draft.aiGrams !== null && <span className="badge">{CONFIDENCE_LABEL[draft.confidence]}</span>}
          </span>
          <div className="input-suffix">
            <input
              className="input"
              inputMode="decimal"
              value={draft.grams}
              placeholder="g 입력"
              onChange={(ev) => set({ grams: ev.target.value })}
              aria-describedby={e.grams === null ? `${draft.key}-needg` : undefined}
            />
            <em>g</em>
          </div>
        </label>
      </div>
      {e.grams === null && (
        <p id={`${draft.key}-needg`} className="notice warn" style={{ margin: 0 }}>
          <span className="badge warn">g 입력 필요</span> 중량을 모르면 일일 합계에서 빠져요. 나중에 입력해도 돼요.
        </p>
      )}

      <div className="segmented" role="group" aria-label="영양값 입력 방식">
        <button type="button" aria-pressed={draft.mode === 'per100'} onClick={() => switchMode('per100')}>
          100g당 값
        </button>
        <button type="button" aria-pressed={draft.mode === 'total'} onClick={() => switchMode('total')}>
          먹은 양 기준
        </button>
      </div>
      <div className="grid-3">
        {(['carbs', 'protein', 'fat'] as const).map((k) => (
          <label className="field" key={k}>
            <span>{k === 'carbs' ? '탄수화물' : k === 'protein' ? '단백질' : '지방'}</span>
            <div className="input-suffix">
              <input className="input compact" inputMode="decimal" value={macroInputs[k]} onChange={(ev) => setMacro(k, ev.target.value)} />
              <em>g</em>
            </div>
          </label>
        ))}
      </div>

      <div className="computed" aria-live="polite">
        <div>
          탄수 <b>{n1(nutrition?.carbs_g)}</b>
        </div>
        <div>
          단백질 <b>{n1(nutrition?.protein_g)}</b>
        </div>
        <div>
          지방 <b>{n1(nutrition?.fat_g)}</b>
        </div>
        <div>
          kcal <b>{n1(nutrition?.kcal)}</b>
        </div>
      </div>
      {draft.note && <p className="tiny muted" style={{ margin: 0 }}>메모: {draft.note}</p>}
      {e.error && <p className="error-text">{e.error}</p>}
    </section>
  );
}
