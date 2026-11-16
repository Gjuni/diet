import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage, get } from '../api/client';
import type { Adjustment, MeResponse, MacroRatio } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ProfileForm } from '../components/ProfileForm';
import { Sheet } from '../components/Sheet';
import { ACTIVITY_LABEL, GOAL_LABEL } from '../lib/constants';
import { formatDateKo } from '../lib/date';
import { n0, n1 } from '../lib/format';

export function ProfilePage() {
  const { me, setMe, reloadMe, logout, logoutAll, clearSession } = useAuth();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState<Adjustment[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadHistory = () =>
    get<{ items: Adjustment[] }>('/adjustments')
      .then((r) => setHistory(r.items))
      .catch((e) => setMsg(errorMessage(e)));
  useEffect(() => {
    void loadHistory();
  }, []);

  if (!me?.profile || !me.metrics) return null;
  const p = me.profile;
  const m = me.metrics;

  const reject = async (a: Adjustment) => {
    if (!confirm(`이번 주 조정(${a.adjustment_kcal > 0 ? '+' : ''}${a.adjustment_kcal}kcal)을 거부하고 이전 목표를 유지할까요?`)) return;
    try {
      await api(`/adjustments/${a.id}/reject`, { method: 'POST' });
      await Promise.all([reloadMe(), loadHistory()]);
      setMsg('이전 목표 칼로리로 되돌렸어요.');
    } catch (e) {
      setMsg(errorMessage(e));
    }
  };

  return (
    <div className="stack">
      <div className="page-header">
        <h1>{me.user.nickname}님</h1>
        <span className="small muted">{me.user.email}</span>
      </div>
      {msg && (
        <p className="notice info" role="status">
          {msg}
        </p>
      )}

      <section className="card">
        <div className="row between">
          <h2>내 몸 지표</h2>
          <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
            프로필 수정
          </button>
        </div>
        <div className="stat-tiles">
          <div className="tile">
            <div className="label">BMI</div>
            <div className="value">{n1(m.bmi)}</div>
          </div>
          <div className="tile">
            <div className="label">현재 체중</div>
            <div className="value">{n1(m.current_weight_kg)} kg</div>
          </div>
          <div className="tile">
            <div className="label">기초대사량 (BMR)</div>
            <div className="value">{n0(m.bmr)} kcal</div>
          </div>
          <div className="tile">
            <div className="label">활동대사량 (TDEE)</div>
            <div className="value">{n0(m.tdee)} kcal</div>
          </div>
        </div>
        <dl className="kv" style={{ marginTop: 12 }}>
          <dt>성별 / 나이</dt>
          <dd>
            {p.sex === 'male' ? '남성' : '여성'} · 만 {m.age}세
          </dd>
          <dt>키</dt>
          <dd>{n1(p.height_cm)} cm</dd>
          <dt>시작 → 목표 체중</dt>
          <dd>
            {n1(p.start_weight_kg)} → {n1(p.goal_weight_kg)} kg
          </dd>
          <dt>활동 수준</dt>
          <dd>{ACTIVITY_LABEL[p.activity_level].split(' (')[0]}</dd>
          <dt>목표</dt>
          <dd>{GOAL_LABEL[p.goal_type]}</dd>
        </dl>
      </section>

      <section className="card">
        <h2>목표</h2>
        <div className="row between">
          <span className="muted">하루 목표 칼로리</span>
          <span className="kcal-big">{n0(p.target_kcal)} kcal</span>
        </div>
        <MacroRatioEditor
          ratio={p.macro_ratio}
          onSaved={async () => {
            await reloadMe();
            setMsg('목표 탄단지 비율을 저장했어요.');
          }}
        />
        <p className="tiny muted" style={{ margin: '8px 0 0' }}>
          목표 g: 탄수 {n0(p.target_macros_g.carbs_g)} · 단백질 {n0(p.target_macros_g.protein_g)} · 지방 {n0(p.target_macros_g.fat_g)}
        </p>
      </section>

      <section className="card">
        <h2>주간 칼로리 조정 이력</h2>
        <p className="tiny muted" style={{ marginTop: -4 }}>
          매주 월요일 AI 가 지난 4주 기록을 보고 목표를 조정해요. 이번 주 조정은 거부할 수 있어요.
        </p>
        {!history ? (
          <div className="empty">불러오는 중…</div>
        ) : history.length === 0 ? (
          <div className="empty">아직 조정 이력이 없어요.</div>
        ) : (
          history.map((a) => (
            <div className="history-item" key={a.id}>
              <div className="row between">
                <strong>{formatDateKo(a.week_start, false)} 주</strong>
                <span className={`num ${a.adjustment_kcal < 0 ? 'delta-down' : a.adjustment_kcal > 0 ? 'delta-up' : 'muted'}`}>
                  {a.adjustment_kcal > 0 ? '+' : ''}
                  {a.adjustment_kcal} kcal
                </span>
              </div>
              <div className="small muted num">
                {n0(a.prev_target_kcal)} → {n0(a.new_target_kcal)} kcal ·{' '}
                {a.status === 'applied' ? '적용됨' : a.status === 'rejected' ? '거부함 (이전 값 유지)' : '조정 실패 (유지)'}
              </div>
              <p className="small" style={{ margin: '4px 0' }}>
                {a.reason}
              </p>
              {a.can_reject && (
                <button type="button" className="btn btn-sm" onClick={() => reject(a)}>
                  이 조정 거부하기
                </button>
              )}
            </div>
          ))
        )}
      </section>

      <section className="card stack">
        <h2 style={{ marginBottom: 0 }}>계정</h2>
        <Link className="btn btn-block" to="/profile/password">
          비밀번호 변경
        </Link>
        <button
          type="button"
          className="btn btn-block"
          onClick={async () => {
            await logout();
            navigate('/login', { replace: true });
          }}
        >
          로그아웃
        </button>
        <button
          type="button"
          className="btn btn-block"
          onClick={async () => {
            if (!confirm('모든 기기에서 로그아웃할까요?')) return;
            try {
              await logoutAll();
              navigate('/login', { replace: true });
            } catch (e) {
              setMsg(errorMessage(e));
            }
          }}
        >
          모든 기기에서 로그아웃
        </button>
        <button type="button" className="btn btn-danger btn-block" onClick={() => setDeleting(true)}>
          회원 탈퇴
        </button>
      </section>

      {editing && (
        <Sheet title="프로필 수정" onClose={() => setEditing(false)}>
          <ProfileForm
            initial={p}
            showRecalc
            submitLabel="저장"
            onSubmit={async (v) => {
              try {
                const r = await api<MeResponse>('/me/profile', { method: 'PUT', body: v });
                setMe(r);
                setEditing(false);
                setMsg(v.recalculate_target ? `저장했어요. 목표 칼로리: ${n0(r.profile!.target_kcal)}kcal` : '프로필을 저장했어요.');
              } catch (e) {
                throw new Error(errorMessage(e));
              }
            }}
          />
        </Sheet>
      )}
      {deleting && (
        <DeleteAccountSheet
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            clearSession();
            navigate('/login', { replace: true });
          }}
        />
      )}
    </div>
  );
}

function MacroRatioEditor({ ratio, onSaved }: { ratio: MacroRatio; onSaved: () => Promise<void> }) {
  const [v, setV] = useState({ carbs: String(ratio.carbs), protein: String(ratio.protein), fat: String(ratio.fat) });
  const [err, setErr] = useState<string | null>(null);
  const sum = Number(v.carbs) + Number(v.protein) + Number(v.fat);
  const dirty = Number(v.carbs) !== ratio.carbs || Number(v.protein) !== ratio.protein || Number(v.fat) !== ratio.fat;

  const save = async () => {
    setErr(null);
    const body = { carbs: Number(v.carbs), protein: Number(v.protein), fat: Number(v.fat) };
    if (Object.values(body).some((x) => !Number.isInteger(x) || x < 5 || x > 80)) return setErr('각 비율은 5~80 사이 정수로 입력해 주세요.');
    if (sum !== 100) return setErr('세 비율의 합이 100 이어야 해요.');
    try {
      await api('/me/macro-ratio', { method: 'PUT', body });
      await onSaved();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <div className="stack" style={{ marginTop: 12, gap: 8 }}>
      <div className="small muted">목표 탄단지 비율 (%)</div>
      <div className="grid-3">
        {(['carbs', 'protein', 'fat'] as const).map((k) => (
          <label className="field" key={k}>
            <span>{k === 'carbs' ? '탄수화물' : k === 'protein' ? '단백질' : '지방'}</span>
            <input className="input compact" inputMode="numeric" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
          </label>
        ))}
      </div>
      <div className="row between small">
        <span className={sum === 100 ? 'muted' : 'delta-up'}>합계 {Number.isFinite(sum) ? sum : '-'}%</span>
        <button type="button" className="btn btn-sm" disabled={!dirty} onClick={save}>
          비율 저장
        </button>
      </div>
      {err && <p className="error-text">{err}</p>}
    </div>
  );
}

function DeleteAccountSheet({ onClose, onDeleted }: { onClose: () => void; onDeleted: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Sheet title="회원 탈퇴" onClose={onClose}>
      <div className="stack">
        <p className="notice warn" style={{ margin: 0 }}>
          식사·체중·운동 기록과 프로필, 조정 이력이 모두 삭제되며 되돌릴 수 없어요.
        </p>
        <label className="field">
          <span>비밀번호 확인</span>
          <input className="input" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </label>
        {err && <p className="error-text">{err}</p>}
        <button
          type="button"
          className="btn btn-danger btn-block"
          disabled={!pw || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api('/me', { method: 'DELETE', body: { password: pw } });
              onDeleted();
            } catch (e) {
              setErr(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          탈퇴하고 모든 데이터 삭제
        </button>
      </div>
    </Sheet>
  );
}
