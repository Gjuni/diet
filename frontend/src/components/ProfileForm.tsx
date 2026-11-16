import { useState, type FormEvent } from 'react';
import type { ActivityLevel, GoalType, Profile, Sex } from '../api/types';
import { ACTIVITY_LABEL, GOAL_LABEL } from '../lib/constants';

export interface ProfileFormValue {
  sex: Sex;
  birth_date: string;
  height_cm: number;
  start_weight_kg: number;
  goal_weight_kg: number;
  activity_level: ActivityLevel;
  goal_type: GoalType;
  recalculate_target?: boolean;
}

/** 프로필 입력/수정 폼 (가입 직후 설정 화면과 프로필 페이지에서 공용) */
export function ProfileForm({
  initial,
  submitLabel,
  showRecalc,
  onSubmit,
}: {
  initial?: Profile | null;
  submitLabel: string;
  showRecalc?: boolean;
  onSubmit: (v: ProfileFormValue) => Promise<void>;
}) {
  const [sex, setSex] = useState<Sex>(initial?.sex ?? 'female');
  const [birth, setBirth] = useState(initial?.birth_date ?? '');
  const [height, setHeight] = useState(initial ? String(initial.height_cm) : '');
  const [start, setStart] = useState(initial ? String(initial.start_weight_kg) : '');
  const [goalW, setGoalW] = useState(initial ? String(initial.goal_weight_kg) : '');
  const [activity, setActivity] = useState<ActivityLevel>(initial?.activity_level ?? 'light');
  const [goal, setGoal] = useState<GoalType>(initial?.goal_type ?? 'lose');
  const [recalc, setRecalc] = useState(!initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const changedCalc =
    !!initial &&
    (sex !== initial.sex ||
      birth !== initial.birth_date ||
      Number(height) !== initial.height_cm ||
      Number(start) !== initial.start_weight_kg ||
      activity !== initial.activity_level ||
      goal !== initial.goal_type);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    const h = Number(height);
    const s = Number(start);
    const g = Number(goalW);
    if (!birth) return setErr('생년월일을 입력해 주세요.');
    if (!(h >= 100 && h <= 250)) return setErr('키는 100~250cm 사이로 입력해 주세요.');
    if (!(s >= 20 && s <= 300) || !(g >= 20 && g <= 300)) return setErr('체중은 20~300kg 사이로 입력해 주세요.');
    setBusy(true);
    try {
      await onSubmit({
        sex,
        birth_date: birth,
        height_cm: h,
        start_weight_kg: s,
        goal_weight_kg: g,
        activity_level: activity,
        goal_type: goal,
        recalculate_target: initial ? recalc || changedCalc : true,
      });
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div className="field">
        <span>성별</span>
        <div className="segmented" role="group" aria-label="성별">
          <button type="button" aria-pressed={sex === 'female'} onClick={() => setSex('female')}>
            여성
          </button>
          <button type="button" aria-pressed={sex === 'male'} onClick={() => setSex('male')}>
            남성
          </button>
        </div>
      </div>
      <label className="field">
        <span>생년월일</span>
        <input className="input" type="date" value={birth} onChange={(e) => setBirth(e.target.value)} required />
      </label>
      <div className="grid-2">
        <label className="field">
          <span>키</span>
          <div className="input-suffix">
            <input className="input" inputMode="decimal" value={height} onChange={(e) => setHeight(e.target.value)} />
            <em>cm</em>
          </div>
        </label>
        <label className="field">
          <span>시작 체중</span>
          <div className="input-suffix">
            <input className="input" inputMode="decimal" value={start} onChange={(e) => setStart(e.target.value)} />
            <em>kg</em>
          </div>
        </label>
      </div>
      <label className="field">
        <span>목표 체중</span>
        <div className="input-suffix">
          <input className="input" inputMode="decimal" value={goalW} onChange={(e) => setGoalW(e.target.value)} />
          <em>kg</em>
        </div>
      </label>
      <label className="field">
        <span>활동 수준</span>
        <select className="select input" value={activity} onChange={(e) => setActivity(e.target.value as ActivityLevel)}>
          {(Object.keys(ACTIVITY_LABEL) as ActivityLevel[]).map((k) => (
            <option key={k} value={k}>
              {ACTIVITY_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        <span>목표</span>
        <div className="segmented" role="group" aria-label="목표">
          {(Object.keys(GOAL_LABEL) as GoalType[]).map((k) => (
            <button key={k} type="button" aria-pressed={goal === k} onClick={() => setGoal(k)}>
              {GOAL_LABEL[k]}
            </button>
          ))}
        </div>
      </div>
      {showRecalc && initial && (
        <label className="row small">
          <input type="checkbox" checked={recalc || changedCalc} onChange={(e) => setRecalc(e.target.checked)} disabled={changedCalc} />
          바뀐 정보로 목표 칼로리 다시 계산하기 {changedCalc && <span className="muted">(계산 항목이 바뀌어 자동 적용)</span>}
        </label>
      )}
      {err && (
        <p className="error-text" role="alert">
          {err}
        </p>
      )}
      <button className="btn btn-primary btn-block" disabled={busy}>
        {busy ? '저장 중…' : submitLabel}
      </button>
    </form>
  );
}
