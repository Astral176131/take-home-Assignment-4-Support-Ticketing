import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useAlerts } from '../context/AlertsContext';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/tickets', label: 'Tickets', end: false },
  { to: '/my-tickets', label: 'My tickets', end: false },
  { to: '/alerts', label: 'Alerts', end: false },
];

const ROLE_LABELS: Record<string, string> = {
  supervisor: 'Supervisor',
  agent: 'Agent',
};

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Shared with the alerts page, so acknowledging one there updates this badge in the
  // same render rather than on the next poll. The count is not this component's to own.
  const { total: alertCount } = useAlerts();

  const [navOpen, setNavOpen] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Following a link inside the drawer navigates; leaving the drawer sitting open
  // over the page you just asked for is never what was meant.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  /**
   * While the drawer is open it owns the keyboard: Escape closes it and returns
   * focus to the button that opened it, Tab cycles inside it rather than walking
   * the page behind, and the page behind does not scroll.
   */
  useEffect(() => {
    if (!navOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const drawer = drawerRef.current;
    const focusable = () =>
      Array.from(
        drawer?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? []
      );

    focusable()[0]?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setNavOpen(false);
        toggleRef.current?.focus();
        return;
      }

      if (event.key !== 'Tab') return;

      const items = focusable();
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [navOpen]);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="app-layout">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      {/* Below 1024px the rail is replaced by this bar plus a drawer. Above it,
          both the bar and the scrim are display:none and the rail is always on. */}
      <header className="topbar">
        <button
          ref={toggleRef}
          type="button"
          className="nav-toggle"
          aria-label={navOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={navOpen}
          aria-controls="app-nav"
          onClick={() => setNavOpen((open) => !open)}
        >
          <MenuIcon />
        </button>
        <span className="topbar-title">Support Desk</span>
      </header>

      {navOpen && (
        <button
          type="button"
          className="nav-scrim"
          aria-label="Close menu"
          tabIndex={-1}
          onClick={() => setNavOpen(false)}
        />
      )}

      <nav
        id="app-nav"
        ref={drawerRef}
        className={`sidebar${navOpen ? ' open' : ''}`}
        aria-label="Main"
      >
        <div className="sidebar-header">
          <span className="app-title">Support Desk</span>
          <button
            type="button"
            className="sidebar-close"
            aria-label="Close menu"
            onClick={() => {
              setNavOpen(false);
              toggleRef.current?.focus();
            }}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="sidebar-nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              aria-current={location.pathname === item.to ? 'page' : undefined}
            >
              {item.label}
              {item.label === 'Alerts' && alertCount > 0 && (
                <span className="nav-badge">
                  {alertCount}
                  <span className="sr-only"> alerts need attention</span>
                </span>
              )}
            </NavLink>
          ))}
        </div>

        <div className="sidebar-footer">
          <div className="user-info">
            <div className="user-avatar" aria-hidden="true">
              {user?.name.charAt(0).toUpperCase()}
            </div>
            <div className="user-details">
              <span className="user-name">{user?.name}</span>
              <span className="user-role">
                {user ? ROLE_LABELS[user.role] ?? user.role : ''}
              </span>
            </div>
          </div>
          <button className="btn-logout" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </nav>

      <main className="main-content" id="main">
        {/* The alert count changes on a timer as well as on an action, so it is
            announced rather than only redrawn. */}
        <span aria-live="polite" className="sr-only">
          {alertCount > 0 ? `${alertCount} alerts need attention` : 'No alerts need attention'}
        </span>
        <Outlet />
      </main>
    </div>
  );
}
