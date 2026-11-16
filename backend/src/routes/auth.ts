import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import {
  clearRefreshCookie,
  clientInfo,
  readRefreshCookie,
  requireCsrfHeader,
  setRefreshCookie,
} from '../lib/http.js';
import { email, parse } from '../lib/validate.js';
import { getAuth, requireAuth, resolvePasswordChangeAuth } from '../middleware/auth.js';
import {
  forgotLimiter,
  loginLimiter,
  passwordChangeLimiter,
  refreshLimiter,
  signupLimiter,
} from '../middleware/rateLimits.js';
import {
  changePassword,
  login,
  logout,
  logoutAll,
  refreshSession,
  requestPasswordReset,
  signup,
  type SessionTokens,
} from '../services/authService.js';

export const authRouter = Router();

const password = z.string({ message: '비밀번호를 입력해 주세요.' }).min(1, { message: '비밀번호를 입력해 주세요.' }).max(128);

const signupSchema = z.object({
  email,
  password,
  nickname: z
    .string({ message: '닉네임을 입력해 주세요.' })
    .trim()
    .min(1, { message: '닉네임을 입력해 주세요.' })
    .max(30, { message: '닉네임은 30자 이하여야 합니다.' }),
});

const loginSchema = z.object({ email, password });
const forgotSchema = z.object({ email });
const changeSchema = z.object({
  current_password: z.string().max(128).optional(),
  new_password: password,
});

function sessionBody(s: SessionTokens) {
  return {
    access_token: s.accessToken,
    token_type: 'Bearer',
    expires_in: config.accessTokenTtlSec,
    user: s.user,
  };
}

authRouter.post('/signup', signupLimiter, async (req, res) => {
  const body = parse(signupSchema, req.body);
  const session = await signup(body, clientInfo(req));
  setRefreshCookie(res, session.refreshToken);
  res.status(201).json(sessionBody(session));
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const body = parse(loginSchema, req.body);
  const result = await login(body, clientInfo(req));
  if (result.kind === 'password_change_required') {
    // 임시 비밀번호 로그인: 비밀번호 변경 전용 제한 토큰만 발급 (refresh 쿠키 없음)
    res.json({
      password_change_required: true,
      password_change_token: result.passwordChangeToken,
      expires_in: config.passwordChangeTokenTtlSec,
      user: result.user,
    });
    return;
  }
  setRefreshCookie(res, result.session.refreshToken);
  res.json(sessionBody(result.session));
});

authRouter.post('/refresh', refreshLimiter, requireCsrfHeader, async (req, res) => {
  try {
    const session = await refreshSession(readRefreshCookie(req), clientInfo(req));
    setRefreshCookie(res, session.refreshToken);
    res.json(sessionBody(session));
  } catch (err) {
    clearRefreshCookie(res);
    throw err;
  }
});

authRouter.post('/logout', requireCsrfHeader, async (req, res) => {
  await logout(readRefreshCookie(req));
  clearRefreshCookie(res);
  res.status(204).end();
});

authRouter.post('/logout-all', requireAuth, async (req, res) => {
  await logoutAll(getAuth(req).userId);
  clearRefreshCookie(res);
  res.status(204).end();
});

authRouter.post('/password/forgot', forgotLimiter, async (req, res) => {
  const body = parse(forgotSchema, req.body);
  requestPasswordReset(body.email, clientInfo(req).ip);
  // 계정 존재 여부와 관계없이 항상 같은 응답
  res.status(202).json({ message: '가입된 이메일이라면 임시 비밀번호를 보냈습니다. 메일함을 확인해 주세요.' });
});

authRouter.post('/password/change', passwordChangeLimiter, async (req, res) => {
  const auth = await resolvePasswordChangeAuth(req);
  const body = parse(changeSchema, req.body);
  const session = await changePassword(
    auth,
    { currentPassword: body.current_password, newPassword: body.new_password },
    clientInfo(req),
  );
  setRefreshCookie(res, session.refreshToken);
  res.json({ ...sessionBody(session), message: '비밀번호가 변경되었습니다. 다른 기기에서는 로그아웃되었습니다.' });
});
