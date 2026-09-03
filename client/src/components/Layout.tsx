import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../lib/api';
import type { Paged, TicketListItem } from '../types';

const ALERT_POLL_MS = 60_000;

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [alertCount, setAlertCount] = useState(0);

  // Polled rather than pushed: there's no server-side event stream, so "live" here means
  // "refreshed on a short interval" — good enough for a badge, not a promise of real time.
  useEffect(() => {
    let cancelled = false;

    function poll() {
      api
        .get<Paged<TicketListItem>>('/api/alerts')
        .then((data) => {
          if (!cancelled) setAlertCount(data.total);
        })
        .catch(() => {
          // A failed poll leaves the last known count showing rather than resetting to
          // zero — a badge that flickers to "no alerts" on a network blip is worse than
          // a stale one.
        });
    }

    poll();
    const interval = setInterval(poll, ALERT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="app-layout">
      <nav className="sidebar">
        <div className="sidebar-header">
          <h1 className="app-title">Support Desk</h1>
        </div>

        <div className="sidebar-nav">
          <NavLink to="/" end className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            Dashboard
          </NavLink>
          <NavLink to="/tickets" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            Tickets
          </NavLink>
          <NavLink to="/my-tickets" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            My tickets
          </NavLink>
          <NavLink to="/alerts" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            Alerts
            {alertCount > 0 && <span className="nav-badge">{alertCount}</span>}
          </NavLink>
        </div>

        <div className="sidebar-footer">
          <div className="user-info">
            <div className="user-avatar">
              {user?.name.charAt(0).toUpperCase()}
            </div>
            <div className="user-details">
              <span className="user-name">{user?.name}</span>
              <span className={`user-role role-${user?.role}`}>
                {user?.role}
              </span>
            </div>
          </div>
          <button className="btn-logout" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </nav>

      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
