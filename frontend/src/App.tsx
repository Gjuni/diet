import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { AppLayout } from './components/Layout';
import {
  ChangePasswordPage,
  ForcedPasswordChangePage,
  ForgotPasswordPage,
  LoginPage,
  SignupPage,
} from './pages/AuthPages';
import { CalendarPage } from './pages/CalendarPage';
import { DayPage } from './pages/DayPage';
import { ProfilePage } from './pages/ProfilePage';
import { ProfileSetupPage } from './pages/ProfileSetupPage';
import { ServerTimeProvider } from './time/ServerTime';

// 차트 라이브러리는 통계 화면에서만 필요 → 분리 로드
const StatsPage = lazy(() => import('./pages/StatsPage').then((m) => ({ default: m.StatsPage })));

function Splash() {
  return (
    <div className="splash" aria-busy="true">
      <div className="spinner" aria-label="불러오는 중" />
    </div>
  );
}

/** 로그인 + 프로필이 있어야 들어갈 수 있는 화면 */
function RequireApp({ children }: { children: ReactNode }) {
  const { status, me } = useAuth();
  const loc = useLocation();
  if (status === 'loading') return <Splash />;
  if (status === 'anon') return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (!me?.profile) return <Navigate to="/setup" replace />;
  return <>{children}</>;
}

function RequireAuthNoProfile({ children }: { children: ReactNode }) {
  const { status, me } = useAuth();
  if (status === 'loading') return <Splash />;
  if (status === 'anon') return <Navigate to="/login" replace />;
  if (me?.profile) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === 'loading') return <Splash />;
  if (status === 'authed') return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <BrowserRouter>
      <ServerTimeProvider>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<GuestOnly><LoginPage /></GuestOnly>} />
            <Route path="/signup" element={<GuestOnly><SignupPage /></GuestOnly>} />
            <Route path="/forgot" element={<GuestOnly><ForgotPasswordPage /></GuestOnly>} />
            <Route path="/reset-password" element={<ForcedPasswordChangePage />} />
            <Route path="/setup" element={<RequireAuthNoProfile><ProfileSetupPage /></RequireAuthNoProfile>} />
            <Route element={<RequireApp><AppLayout /></RequireApp>}>
              <Route index element={<CalendarPage />} />
              <Route path="day/:date" element={<DayPage />} />
              <Route
                path="stats"
                element={
                  <Suspense fallback={<div className="empty">불러오는 중…</div>}>
                    <StatsPage />
                  </Suspense>
                }
              />
              <Route path="profile" element={<ProfilePage />} />
              <Route path="profile/password" element={<ChangePasswordPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </ServerTimeProvider>
    </BrowserRouter>
  );
}
