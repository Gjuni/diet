import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, refreshSession, setAccessToken, setAuthLostHandler } from '../api/client';
import type { LoginResponse, MeResponse, SessionResponse } from '../api/types';

type Status = 'loading' | 'anon' | 'authed';

interface AuthCtx {
  status: Status;
  me: MeResponse | null;
  /** 임시 비밀번호 로그인 후 받은 비밀번호 변경 전용 토큰 (메모리에만 보관) */
  passwordChangeToken: string | null;
  login: (email: string, password: string) => Promise<'ok' | 'password_change_required'>;
  signup: (email: string, password: string, nickname: string) => Promise<void>;
  completePasswordChange: (newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  reloadMe: () => Promise<MeResponse | null>;
  setMe: (me: MeResponse) => void;
  clearSession: () => void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<MeResponse | null>(null);
  const [passwordChangeToken, setPasswordChangeToken] = useState<string | null>(null);

  const clearSession = useCallback(() => {
    setAccessToken(null);
    setMe(null);
    setStatus('anon');
  }, []);

  const reloadMe = useCallback(async () => {
    const data = await api<MeResponse>('/me');
    setMe(data);
    setStatus('authed');
    return data;
  }, []);

  const startSession = useCallback(
    async (s: SessionResponse) => {
      setAccessToken(s.access_token);
      setPasswordChangeToken(null);
      await reloadMe();
    },
    [reloadMe],
  );

  // 앱 시작: httpOnly 쿠키의 refresh token 으로 세션 복구
  useEffect(() => {
    setAuthLostHandler(clearSession);
    (async () => {
      const s = await refreshSession().catch(() => null);
      if (!s) {
        setStatus('anon');
        return;
      }
      try {
        await reloadMe();
      } catch {
        clearSession();
      }
    })();
  }, [clearSession, reloadMe]);

  const value = useMemo<AuthCtx>(
    () => ({
      status,
      me,
      passwordChangeToken,
      async login(email, password) {
        const r = await api<LoginResponse>('/auth/login', { method: 'POST', body: { email, password }, auth: false });
        if (r.password_change_required && r.password_change_token) {
          setPasswordChangeToken(r.password_change_token);
          return 'password_change_required';
        }
        await startSession(r as SessionResponse);
        return 'ok';
      },
      async signup(email, password, nickname) {
        const r = await api<SessionResponse>('/auth/signup', { method: 'POST', body: { email, password, nickname }, auth: false });
        await startSession(r);
      },
      async completePasswordChange(newPassword) {
        if (!passwordChangeToken) throw new Error('다시 로그인해 주세요.');
        const r = await api<SessionResponse>('/auth/password/change', {
          method: 'POST',
          body: { new_password: newPassword },
          token: passwordChangeToken,
        });
        await startSession(r);
      },
      async logout() {
        await api('/auth/logout', { method: 'POST', auth: false }).catch(() => undefined);
        clearSession();
      },
      async logoutAll() {
        await api('/auth/logout-all', { method: 'POST' });
        clearSession();
      },
      reloadMe,
      setMe,
      clearSession,
    }),
    [status, me, passwordChangeToken, startSession, reloadMe, clearSession],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('AuthProvider 가 필요합니다.');
  return c;
}
