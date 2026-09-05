import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AlertsPage } from '../AlertsPage';
import { Layout } from '../../components/Layout';
import { AlertsProvider } from '../../context/AlertsContext';
import { UnassignedProvider } from '../../context/UnassignedContext';
import type { Role, TicketListItem } from '../../types';

// No beforeEach reset — see DashboardPage.test.tsx for why a hook here misreports a
// mount-time rejection as unhandled even when handled. Every test sets its own mocks.
const get = vi.fn();
const post = vi.fn();

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return {
    ...actual,
    api: { get: (p: string) => get(p), post: (p: string) => post(p) },
  };
});

let role: Role = 'agent';

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Agent A', email: 'a@x.com', role }, logout: vi.fn() }),
}));

function alert(overrides: Partial<TicketListItem> = {}): TicketListItem {
  return {
    id: 't1',
    key: 'SUP-1',
    subject: 'Printer will not print',
    status: 'open',
    priority_code: 'urgent',
    category: 'bug',
    requester: { id: 'r1', name: 'Jane Customer', email: 'jane@corp.com' },
    assignee: { id: 'u1', name: 'Agent A' },
    sla: {
      elapsed_minutes: 70,
      target_minutes: 60,
      remaining_minutes: -10,
      breached: true,
      warning: false,
      alert_active: true, snoozed_for_minutes: null,
    },
    archived_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/** The real provider: the page renders what it holds, so stubbing it would test nothing. */
function renderPage() {
  return render(
    <MemoryRouter>
      <AlertsProvider>
        <AlertsPage />
      </AlertsProvider>
    </MemoryRouter>
  );
}

/** The nav and the page together, which is where the badge bug actually lived. */
function renderWithNav() {
  return render(
    <MemoryRouter>
      <AlertsProvider>
        <UnassignedProvider>
          <Layout />
          <AlertsPage />
        </UnassignedProvider>
      </AlertsProvider>
    </MemoryRouter>
  );
}

describe('AlertsPage', () => {
  it('lists active alerts with their key, subject and response standing', async () => {
    role = 'agent';
    get.mockResolvedValue({ items: [alert()], total: 1 });
    renderPage();

    expect(await screen.findByText('SUP-1')).toBeInTheDocument();
    expect(screen.getByText('Printer will not print')).toBeInTheDocument();
    expect(screen.getByText('Breached by 10m')).toBeInTheDocument();
  });

  it('says so when nothing is currently alerting', async () => {
    get.mockResolvedValue({ items: [], total: 0, acknowledged: 0 });
    renderPage();

    expect(await screen.findByText(/everything is within its response target/i)).toBeInTheDocument();
  });

  it('does not claim all is well when breaching tickets are merely acknowledged', async () => {
    // The dashboard's breaching tile ignores acknowledgement on purpose, so an empty list
    // saying "everything is within its response target" directly contradicts it — which is
    // what makes "14 breaching" next to an empty alerts page look like a broken page.
    get.mockResolvedValue({ items: [], total: 0, acknowledged: 14 });
    renderPage();

    expect(await screen.findByText(/nothing needs attention right now/i)).toBeInTheDocument();
    expect(screen.getByText(/14 acknowledged tickets are still past their targets/i)).toBeInTheDocument();
    expect(screen.getByText(/stay quiet unless those tickets are reopened/i)).toBeInTheDocument();
    expect(screen.queryByText(/everything is within its response target/i)).not.toBeInTheDocument();
  });

  it('reads naturally when exactly one is acknowledged', async () => {
    get.mockResolvedValue({ items: [], total: 0, acknowledged: 1 });
    renderPage();

    expect(await screen.findByText(/^1 acknowledged ticket is still past its target/i)).toBeInTheDocument();
  });


  it('acknowledges an alert and reloads the list', async () => {
    role = 'agent';
    get.mockResolvedValueOnce({ items: [alert()], total: 1 }).mockResolvedValueOnce({ items: [], total: 0 });
    post.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('SUP-1');
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));

    expect(post).toHaveBeenCalledWith('/api/tickets/t1/alerts/ack');
    expect(await screen.findByText(/no active alerts/i)).toBeInTheDocument();
  });

  it("shows the server's reason when acknowledging fails", async () => {
    role = 'agent';
    const { ApiError } = await import('../../lib/api');
    get.mockResolvedValue({ items: [alert()], total: 1 });
    post.mockRejectedValue(new ApiError(403, 'You do not have access to this ticket'));
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('SUP-1');
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));

    expect(await screen.findByText(/You do not have access to this ticket/)).toBeInTheDocument();
    // The list is still there — a refused acknowledgement is not a failure to load.
    expect(screen.getByText('SUP-1')).toBeInTheDocument();
  });

  it('drops the nav badge in the same breath as the row, with no reload', async () => {
    // The reported bug: acknowledging emptied this table but left the badge showing the
    // old count until the next poll a minute later, or until the page was reloaded.
    role = 'agent';
    get
      .mockResolvedValueOnce({ items: [alert(), alert({ id: 't2', key: 'SUP-2' })], total: 2 })
      .mockResolvedValueOnce({ items: [alert({ id: 't2', key: 'SUP-2' })], total: 1 });
    post.mockResolvedValue({});
    const user = userEvent.setup();
    renderWithNav();

    await screen.findByText('SUP-1');
    expect(screen.getByText('2')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Acknowledge' })[0]);

    expect(await screen.findByText('1')).toBeInTheDocument();
    expect(screen.queryByText('SUP-1')).not.toBeInTheDocument();
    expect(screen.getByText('SUP-2')).toBeInTheDocument();
  });

  it('hides the badge entirely once the last alert is acknowledged', async () => {
    role = 'agent';
    get
      .mockResolvedValueOnce({ items: [alert()], total: 1 })
      .mockResolvedValueOnce({ items: [], total: 0 });
    post.mockResolvedValue({});
    const user = userEvent.setup();
    renderWithNav();

    await screen.findByText('SUP-1');
    expect(screen.getByText('1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));

    expect(await screen.findByText(/no active alerts/i)).toBeInTheDocument();
    expect(screen.queryByText('1')).not.toBeInTheDocument();
  });
});
