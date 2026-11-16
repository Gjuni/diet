import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { api, ApiError, errorMessage, setAccessToken } from '../api/client';
import type { SessionResponse } from '../api/types';
import { useAuth } from '../auth/AuthContext';

/** 비밀번호 정책: 8자 이상, 영문과 숫자 포함 (서버와 동일) */
export function passwordPolicyError(pw: string): string | null {
  if (pw.length < 8) return '비밀번호는 8자 이상이어야 해요.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return '비밀번호에 영문과 숫자를 모두 넣어 주세요.';
  return null;
}

function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="auth-wrap">
      <div className="brand">
        <img src="/icons/icon.svg" alt="" />
        <strong>식단 기록</strong>
      </div>
      <h1>{title}</h1>
      {subtitle && <p className="muted" style={{ marginTop: 0 }}>{subtitle}</p>}
      <div className="card" style={{ marginTop: 16 }}>
        {children}
      </div>
    </div>
  );
}

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await login(email, pw);
      navigate(r === 'password_change_required' ? '/reset-password' : '/', { replace: true });
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="로그인" subtitle="사진 한 장으로 식단을 기록해요">
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span>이메일</span>
          <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          <span>비밀번호</span>
          <input className="input" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required />
        </label>
        {err && (
          <p className="error-text" role="alert">
            {err}
          </p>
        )}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? '로그인 중…' : '로그인'}
        </button>
        <div className="row between small">
          <Link to="/forgot">비밀번호를 잊었어요</Link>
          <Link to="/signup">회원가입</Link>
        </div>
      </form>
    </AuthShell>
  );
}

export function SignupPage() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [nickname, setNickname] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    const policy = passwordPolicyError(pw);
    if (policy) return setErr(policy);
    if (pw !== pw2) return setErr('비밀번호가 서로 달라요.');
    if (!nickname.trim()) return setErr('닉네임을 입력해 주세요.');
    setBusy(true);
    try {
      await signup(email, pw, nickname.trim());
      navigate('/setup', { replace: true }); // 가입 직후 프로필 입력
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="회원가입">
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span>이메일</span>
          <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          <span>닉네임</span>
          <input className="input" maxLength={30} autoComplete="nickname" value={nickname} onChange={(e) => setNickname(e.target.value)} required />
        </label>
        <label className="field">
          <span>비밀번호 (8자 이상, 영문+숫자)</span>
          <input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required />
        </label>
        <label className="field">
          <span>비밀번호 확인</span>
          <input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required />
        </label>
        {err && (
          <p className="error-text" role="alert">
            {err}
          </p>
        )}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? '가입 중…' : '가입하기'}
        </button>
        <p className="small center" style={{ margin: 0 }}>
          이미 계정이 있나요? <Link to="/login">로그인</Link>
        </p>
      </form>
    </AuthShell>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ message: string }>('/auth/password/forgot', { method: 'POST', body: { email }, auth: false });
      setDone(r.message);
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="비밀번호 찾기" subtitle="가입한 이메일로 임시 비밀번호(30분 유효)를 보내 드려요.">
      {done ? (
        <div className="stack">
          <p className="notice info" style={{ margin: 0 }}>
            {done}
          </p>
          <p className="small muted" style={{ margin: 0 }}>
            임시 비밀번호로 로그인하면 새 비밀번호를 설정하게 돼요. 기존 비밀번호도 계속 쓸 수 있어요.
          </p>
          <Link className="btn btn-primary btn-block" to="/login">
            로그인하러 가기
          </Link>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          <label className="field">
            <span>이메일</span>
            <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          {err && <p className="error-text">{err}</p>}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? '요청 중…' : '임시 비밀번호 받기'}
          </button>
          <Link className="small center" to="/login">
            로그인으로 돌아가기
          </Link>
        </form>
      )}
    </AuthShell>
  );
}

/** 임시 비밀번호로 로그인한 뒤: 새 비밀번호를 설정해야 정상 토큰이 발급된다 */
export function ForcedPasswordChangePage() {
  const { passwordChangeToken, completePasswordChange } = useAuth();
  const navigate = useNavigate();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!passwordChangeToken) return <Navigate to="/login" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    const policy = passwordPolicyError(pw);
    if (policy) return setErr(policy);
    if (pw !== pw2) return setErr('비밀번호가 서로 달라요.');
    setBusy(true);
    try {
      await completePasswordChange(pw);
      navigate('/', { replace: true });
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : (x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="새 비밀번호 설정" subtitle="임시 비밀번호로 로그인했어요. 계속하려면 새 비밀번호를 정해 주세요.">
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span>새 비밀번호 (8자 이상, 영문+숫자)</span>
          <input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </label>
        <label className="field">
          <span>새 비밀번호 확인</span>
          <input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </label>
        {err && <p className="error-text">{err}</p>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? '저장 중…' : '비밀번호 변경'}
        </button>
      </form>
    </AuthShell>
  );
}

/** 로그인 상태에서 일반 비밀번호 변경 (현재 비밀번호 확인) */
export function ChangePasswordPage() {
  const navigate = useNavigate();
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    const policy = passwordPolicyError(pw);
    if (policy) return setErr(policy);
    if (pw !== pw2) return setErr('새 비밀번호가 서로 달라요.');
    setBusy(true);
    try {
      const r = await api<SessionResponse & { message: string }>('/auth/password/change', {
        method: 'POST',
        body: { current_password: cur, new_password: pw },
      });
      setAccessToken(r.access_token); // 다른 기기는 로그아웃, 이 기기는 새 토큰으로 계속
      setOk(r.message);
      setCur('');
      setPw('');
      setPw2('');
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="page-header">
        <h1>비밀번호 변경</h1>
        <button type="button" className="btn btn-sm" onClick={() => navigate('/profile')}>
          닫기
        </button>
      </div>
      <form className="card stack" onSubmit={submit}>
        <label className="field">
          <span>현재 비밀번호</span>
          <input className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
        </label>
        <label className="field">
          <span>새 비밀번호 (8자 이상, 영문+숫자)</span>
          <input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </label>
        <label className="field">
          <span>새 비밀번호 확인</span>
          <input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </label>
        {err && <p className="error-text">{err}</p>}
        {ok && <p className="notice info">{ok}</p>}
        <button className="btn btn-primary btn-block" disabled={busy || !cur}>
          {busy ? '변경 중…' : '변경하기'}
        </button>
      </form>
    </div>
  );
}
