import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { CalendarIcon, ChartIcon, UserIcon } from './Icons';

/** 하단 탭 3개: [달력] [통계] [프로필] */
export function AppLayout() {
  const { pathname } = useLocation();
  const calendarActive = pathname === '/' || pathname.startsWith('/day/');
  return (
    <>
      <main className="app">
        <Outlet />
      </main>
      <nav className="bottom-nav" aria-label="주요 메뉴">
        <ul>
          <li>
            <NavLink to="/" className={calendarActive ? 'active' : undefined} aria-current={calendarActive ? 'page' : undefined}>
              <CalendarIcon />
              달력
            </NavLink>
          </li>
          <li>
            <NavLink to="/stats">
              <ChartIcon />
              통계
            </NavLink>
          </li>
          <li>
            <NavLink to="/profile">
              <UserIcon />
              프로필
            </NavLink>
          </li>
        </ul>
      </nav>
    </>
  );
}
