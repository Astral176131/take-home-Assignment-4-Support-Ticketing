import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueuePage } from '../QueuePage';
import type { TicketListItem } from '../../types';

const get = vi.fn();

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, api: { get: (path: string) => get(path) } };
});

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Agent A', email: 'a@x.com', role: 'agent' } }),
}));

function ticket(overrides: Partial<TicketListItem> = {}): TicketListItem {
  return {
    id: 't1',
    subject: 'Printer will not print',
    status: 'open',
    priority_code: 'high',
    category: 'bug',
    requester: { id: 'r1', name: 'Jane Customer', email: 'jane@corp.com' },
    assignee: { id: 'u1', name: 'Agent A' },
    sla: {
      elapsed_minutes: 100,
      target_minutes: 240,
      remaining_minutes: 140,
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

function renderQueue() {
  return render(
    <MemoryRouter>
      <QueuePage />
    </MemoryRouter>
  );
}

describe('QueuePage', () => {
  beforeEach(() => get.mockReset());

  it('lists tickets with their status, priority and response standing', async () => {
    get.mockResolvedValue({ items: [ticket()], total: 1 });
    renderQueue();

    expect(await screen.findByText('Printer will not print')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText('Jane Customer')).toBeInTheDocument();
    expect(screen.getByText('2h 20m left')).toBeInTheDocument();
  });

  it('marks a breached ticket rather than showing time remaining', async () => {
    get.mockResolvedValue({
      items: [
        ticket({
          sla: {
            elapsed_minutes: 300,
            target_minutes: 240,
            remaining_minutes: -60,
            breached: true,
            warning: false,
            alert_active: true,
          },
        }),
      ],
      total: 1,
    });
    renderQueue();

    expect(await screen.findByText('Breached by 1h')).toBeInTheDocument();
  });

  it('says so when there is nothing in the queue', async () => {
    get.mockResolvedValue({ items: [], total: 0 });
    renderQueue();

    expect(await screen.findByText(/no tickets here yet/i)).toBeInTheDocument();
  });

  it('shows an unassigned ticket as unassigned', async () => {
    get.mockResolvedValue({ items: [ticket({ assignee: null })], total: 1 });
    renderQueue();

    expect(await screen.findByText('Unassigned')).toBeInTheDocument();
  });
});
