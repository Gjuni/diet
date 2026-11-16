import type { SessionResponse } from './types';

/**
 * API 클라이언트
 *  - Access Token 은 메모리에만 둔다 (localStorage 금지 → XSS 로 탈취되지 않게).
 *  - Refresh Token 은 httpOnly 쿠키라 JS 에서 읽을 수 없다. 401 이면 /auth/refresh 로 회전 후 1회 재시도.
 *  - refresh 는 여러 탭이 동시에 하면 "재사용 탐지"에 걸리므로 Web Locks 로 탭 간 직렬화한다.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let accessToken: string | null = null;
let onAuthLost: (() => void) | null = null;
let refreshing: Promise<SessionResponse | null> | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function setAuthLostHandler(fn: () => void) {
  onAuthLost = fn;
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toError(res: Response, body: unknown): ApiError {
  const e = (body as { error?: { code?: string; message?: string } & Record<string, unknown> })?.error;
  const { code, message, ...rest } = e ?? {};
  return new ApiError(
    res.status,
    code ?? `HTTP_${res.status}`,
    message ?? (res.status >= 500 ? '서버에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.' : '요청을 처리하지 못했어요.'),
    rest,
  );
}

async function doRefresh(): Promise<SessionResponse | null> {
  const res = await fetch('/api/auth/refresh', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-requested-with': 'fetch' },
  });
  if (!res.ok) {
    accessToken = null;
    return null;
  }
  const body = (await parse(res)) as SessionResponse;
  accessToken = body.access_token;
  return body;
}

/** 단일 실행(탭 안) + Web Locks(탭 간) */
export function refreshSession(): Promise<SessionResponse | null> {
  if (!refreshing) {
    const run = (): Promise<SessionResponse | null> => doRefresh();
    const locked: Promise<SessionResponse | null> =
      typeof navigator !== 'undefined' && 'locks' in navigator
        ? (navigator.locks.request('diet-refresh', run) as unknown as Promise<SessionResponse | null>)
        : run();
    refreshing = locked.finally(() => {
      refreshing = null;
    });
  }
  return refreshing!;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  form?: FormData;
  auth?: boolean;
  /** 명시적으로 쓸 Bearer 토큰 (예: 비밀번호 변경 전용 토큰) */
  token?: string;
  signal?: AbortSignal;
}

export async function api<T>(path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = { 'x-requested-with': 'fetch' };
  const bearer = opts.token ?? (opts.auth === false ? null : accessToken);
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body,
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', '인터넷 연결을 확인해 주세요.');
  }

  if (res.status === 401 && opts.auth !== false && !opts.token && !retried) {
    const session = await refreshSession();
    if (session) return api<T>(path, opts, true);
    onAuthLost?.();
  }
  const data = await parse(res);
  if (!res.ok) throw toError(res, data);
  return data as T;
}

export const get = <T>(path: string, signal?: AbortSignal) => api<T>(path, { signal });
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body });
export const put = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body });
export const patch = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body });
export const del = <T>(path: string, body?: unknown) => api<T>(path, { method: 'DELETE', body });

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return '문제가 생겼어요. 잠시 후 다시 시도해 주세요.';
}
