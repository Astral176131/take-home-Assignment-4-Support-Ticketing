import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MyTicketsPage } from '../MyTicketsPage';
import type { Role, TicketListItem } from '../../types';

const get = vi.fn();

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, api: { get: (p: string) => get(p) } };
});

let role: Role = 'agent';

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Agent A', email: 'a@x.com', role } }),
}));

function ticket(overrides: Partial<TicketListItem> = {}): TicketListItem {
  return {
    id: 't1',
    subject: 'VPN drops every ten minutes',
    status: 'open',
    priority_code: 'normal',
    category: 'bug',
    requester: { id: 'r1', name: 'Jane Customer', email: 'jane@corp.com' },
    assignee: { id: 'u1', name: 'Agent A' },
    sla: {
      elapsed_minutes: 10,
      target_minutes: 1440,
      remaining_minutes: 1430,
      breached: false,
      warning: false,
      alert_active: false,
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
      <MyTicketsPage />
    </MemoryRouter>
  );
}

describe('MyTicketsPage', () => {
  beforeEach(() => {
    role = 'agent';
    get.mockReset();
  });

  it('reads from the my-tickets endpoint, not the full queue', async () => {
    get.mockResolvedValue({ items: [ticket()], total: 1 });
    renderPage();

    expect(await screen.findByText('VPN drops every ten minutes')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/api/tickets/mine');
  });

  it('explains what an agent is looking at', async () => {
    get.mockResolvedValue({ items: [ticket()], total: 1 });
    renderPage();

    expect(await screen.findByText(/assigned to you, and tickets you are collaborating on/i)).toBeInTheDocument();
  });

  it('explains that a supervisor sees only what they hold', async () => {
    role = 'supervisor';
    get.mockResolvedValue({ items: [], total: 0 });
    renderPage();

    expect(await screen.findByText(/you hold yourself, rather than the whole queue/i)).toBeInTheDocument();
  });

  it('says so when nothing is assigned', async () => {
    get.mockResolvedValue({ items: [], total: 0 });
    renderPage();

    expect(await screen.findByText(/nothing is on your plate/i)).toBeInTheDocument();
  });
});
