import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AlertsPage } from '../AlertsPage';
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
  useAuth: () => ({ user: { id: 'u1', name: 'Agent A', email: 'a@x.com', role } }),
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
      alert_active: true,
    },
    archived_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AlertsPage />
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
    get.mockResolvedValue({ items: [], total: 0 });
    renderPage();

    expect(await screen.findByText(/no active alerts/i)).toBeInTheDocument();
  });

  it('explains the difference between an agent and a supervisor view', async () => {
    role = 'supervisor';
    get.mockResolvedValue({ items: [], total: 0 });
    renderPage();

    expect(await screen.findByText(/every ticket currently breaching/i)).toBeInTheDocument();
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

    expect(await screen.findByText('You do not have access to this ticket')).toBeInTheDocument();
  });
});
