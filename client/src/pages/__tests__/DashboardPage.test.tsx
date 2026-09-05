import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DashboardPage } from '../DashboardPage';
import { AlertsProvider } from '../../context/AlertsContext';
import type { Dashboard } from '../../types';

/**
 * The breakdown rows are links into the queue, so the page needs a router around it,
 * and the breaching tile reads the shared alert count to decide what its own link
 * can honestly promise, so it needs the alerts provider too.
 */
function renderPage() {
  return render(
    <MemoryRouter>
      <AlertsProvider>
        <DashboardPage />
      </AlertsProvider>
    </MemoryRouter>
  );
}

const get = vi.fn();

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, api: { get: (path: string) => get(path) } };
});

/** Answers /api/alerts with an empty list and the dashboard payload otherwise. */
function route(dashboardPayload: Dashboard, alerts = { items: [], total: 0, acknowledged: 0 }) {
  get.mockImplementation((path: string) =>
    path.startsWith('/api/alerts') ? Promise.resolve(alerts) : Promise.resolve(dashboardPayload)
  );
}

function dashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    open_count: 4,
    pending_count: 2,
    resolved_this_week: 5,
    breaching_count: 1,
    by_status: { new: 1, open: 4, pending: 2, resolved: 5, closed: 3 },
    by_agent: [
      { agent: { id: 'u1', name: 'Alice' }, count: 6 },
      { agent: { id: 'u2', name: 'Bob' }, count: 2 },
    ],
    resolved_per_week: [
      { week_start: '2026-07-13', count: 1 },
      { week_start: '2026-07-20', count: 3 },
      { week_start: '2026-07-27', count: 0 },
      { week_start: '2026-08-03', count: 4 },
      { week_start: '2026-08-10', count: 2 },
      { week_start: '2026-08-17', count: 5 },
      { week_start: '2026-08-24', count: 1 },
      { week_start: '2026-08-31', count: 5 },
    ],
    ...overrides,
  };
}

// No beforeEach reset: every test below sets get's behavior itself before rendering, so a
// shared reset hook isn't load-bearing — and, empirically, a beforeEach hook in this file
// shifts effect-scheduling timing enough to make a mount-time rejection misreport as an
// unhandled rejection even though DashboardPage's own .catch genuinely handles it (see the
// last test below). Confirmed via a minimal repro: identical mock/render code fails only
// when a beforeEach hook is present in the same describe block, regardless of what it does.
describe('DashboardPage', () => {
  it('shows the four headline numbers', async () => {
    route(dashboard());
    renderPage();

    // "Open" appears twice (the stat tile and the status breakdown), so wait on the
    // unambiguous heading instead.
    await screen.findByText('By status');
    const tiles = document.querySelectorAll('.stat-value');
    expect(Array.from(tiles).map((t) => t.textContent)).toEqual(['4', '2', '5', '1']);
  });

  it('breaks tickets down by status and by agent', async () => {
    route(dashboard());
    renderPage();

    await screen.findByText('By status');
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('links each status row to the queue filtered to that status', async () => {
    route(dashboard());
    renderPage();

    // Queried by title: the link's accessible name comes from its contents ("Pending 2"),
    // so the title is what identifies it as the affordance rather than naming it.
    const row = await screen.findByTitle('Show Pending tickets');
    expect(row).toHaveAttribute('href', '/tickets?status=pending');
  });

  it('links each agent row to the queue filtered to that agent', async () => {
    route(dashboard());
    renderPage();

    // The number and the list behind it are the same query — the id, not the name, so two
    // agents who share a name still get their own queue.
    const row = await screen.findByTitle('Show Alice tickets');
    expect(row).toHaveAttribute('href', '/tickets?assignee_id=u1');
  });

  it('renders one bar per week in the 8-week chart', async () => {
    route(dashboard());
    renderPage();

    await screen.findByText('Resolved per week, last 8 weeks');
    expect(document.querySelectorAll('.week-chart-col')).toHaveLength(8);
  });

  it("shows the server's reason when loading fails", async () => {
    const { ApiError } = await import('../../lib/api');
    get.mockImplementation((path: string) =>
      path.startsWith('/api/alerts')
        ? Promise.resolve({ items: [], total: 0, acknowledged: 0 })
        : Promise.reject(new ApiError(500, 'Internal server error'))
    );
    renderPage();

    // The reason is now shown inside a sentence that says what failed.
    expect(await screen.findByText(/Internal server error/)).toBeInTheDocument();
  });
});
