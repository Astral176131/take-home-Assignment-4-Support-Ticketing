import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueuePage } from '../QueuePage';
import type { Role, TicketListItem } from '../../types';

const get = vi.fn();
const post = vi.fn();

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return {
    ...actual,
    api: { get: (path: string) => get(path), post: (path: string, body?: unknown) => post(path, body) },
  };
});

let role: Role = 'agent';

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Agent A', email: 'a@x.com', role } }),
}));

function ticket(overrides: Partial<TicketListItem> = {}): TicketListItem {
  return {
    id: 't1',
    key: 'SUP-1',
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

/** The most recent /api/tickets query string, isolated from a mixed call history —
 *  `find` would return the initial mount's call instead of the one an interaction caused. */
function ticketsQuery(): string {
  const calls = [...get.mock.calls].reverse();
  const call = calls.find((args: unknown[]) => (args[0] as string).startsWith('/api/tickets?'));
  return call ? (call[0] as string).split('?')[1] : '';
}

function renderQueue() {
  return render(
    <MemoryRouter>
      <QueuePage />
    </MemoryRouter>
  );
}

describe('QueuePage', () => {
  beforeEach(() => {
    role = 'agent';
    get.mockReset();
    post.mockReset();
    get.mockResolvedValue({ items: [], total: 0 });
  });

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

  it('says so when nothing matches the current filters', async () => {
    renderQueue();
    expect(await screen.findByText(/no tickets match these filters/i)).toBeInTheDocument();
  });

  it('shows an unassigned ticket as unassigned', async () => {
    get.mockResolvedValue({ items: [ticket({ assignee: null })], total: 1 });
    renderQueue();

    expect(await screen.findByText('Unassigned')).toBeInTheDocument();
  });

  describe('search, filters and sort', () => {
    it('debounces the search box rather than querying on every keystroke', async () => {
      const user = userEvent.setup();
      renderQueue();
      await waitFor(() => expect(ticketsQuery()).not.toContain('q='));

      get.mockClear();
      await user.type(screen.getByLabelText('Search tickets'), 'print');

      // Nothing yet — still inside the debounce window.
      expect(get).not.toHaveBeenCalled();
      await waitFor(() => expect(ticketsQuery()).toContain('q=print'));
    });

    it('applies status, priority and category as query parameters', async () => {
      const user = userEvent.setup();
      renderQueue();
      await waitFor(() => expect(get).toHaveBeenCalled());

      await user.selectOptions(screen.getByLabelText('Filter by status'), 'open');
      await waitFor(() => expect(ticketsQuery()).toContain('status=open'));

      await user.selectOptions(screen.getByLabelText('Filter by priority'), 'high');
      await waitFor(() => expect(ticketsQuery()).toContain('priority=high'));

      await user.selectOptions(screen.getByLabelText('Filter by category'), 'billing');
      await waitFor(() => expect(ticketsQuery()).toContain('category=billing'));
    });

    it('toggles sort field and direction on header click', async () => {
      get.mockResolvedValue({ items: [ticket()], total: 1 });
      const user = userEvent.setup();
      renderQueue();
      await screen.findByText('Printer will not print');

      await user.click(screen.getByRole('button', { name: /priority/i }));
      await waitFor(() => expect(ticketsQuery()).toContain('sort=priority'));
      expect(ticketsQuery()).toContain('dir=desc');

      // Clicking the same header again flips direction rather than resetting it.
      await user.click(screen.getByRole('button', { name: /priority/i }));
      await waitFor(() => expect(ticketsQuery()).toContain('dir=asc'));
    });

    it('resets to page 1 when a filter changes', async () => {
      get.mockResolvedValue({ items: Array.from({ length: 30 }, (_, i) => ticket({ id: `t${i}` })), total: 30 });
      const user = userEvent.setup();
      renderQueue();
      await screen.findByText(/page 1 of/i);

      await user.click(screen.getByRole('button', { name: 'Next' }));
      await waitFor(() => expect(ticketsQuery()).toContain('page=2'));

      await user.selectOptions(screen.getByLabelText('Filter by status'), 'open');
      await waitFor(() => expect(ticketsQuery()).toContain('page=1'));
    });
  });

  describe('pagination', () => {
    it('disables Previous on the first page and Next on the last', async () => {
      get.mockResolvedValue({ items: [ticket()], total: 1 });
      renderQueue();
      await screen.findByText('Printer will not print');

      expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    });

    it('enables Next when more pages exist, and requests the next page', async () => {
      get.mockResolvedValue({ items: [ticket()], total: 60 });
      const user = userEvent.setup();
      renderQueue();
      await screen.findByText(/page 1 of 3/i);

      const next = screen.getByRole('button', { name: 'Next' });
      expect(next).toBeEnabled();

      await user.click(next);
      await waitFor(() => expect(ticketsQuery()).toContain('page=2'));
    });
  });

  describe('supervisor-only controls', () => {
    it('hides the assignee filter and selection from an agent', async () => {
      get.mockResolvedValue({ items: [ticket()], total: 1 });
      renderQueue();
      await screen.findByText('Printer will not print');

      expect(screen.queryByLabelText('Filter by assignee')).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/select all tickets/i)).not.toBeInTheDocument();
    });

    it('offers the assignee filter and row selection to a supervisor', async () => {
      role = 'supervisor';
      get.mockImplementation((path: string) =>
        path === '/api/agents'
          ? Promise.resolve({ items: [{ id: 'u9', name: 'Agent Zed' }], total: 1 })
          : Promise.resolve({ items: [ticket()], total: 1 })
      );
      renderQueue();
      await screen.findByText('Printer will not print');

      expect(screen.getByLabelText('Filter by assignee')).toBeInTheDocument();
      expect(screen.getByLabelText('Select SUP-1')).toBeInTheDocument();
    });

    it('shows the bulk action bar once a ticket is selected, and not before', async () => {
      role = 'supervisor';
      get.mockImplementation((path: string) =>
        path === '/api/agents' ? Promise.resolve({ items: [], total: 0 }) : Promise.resolve({ items: [ticket()], total: 1 })
      );
      const user = userEvent.setup();
      renderQueue();
      await screen.findByText('Printer will not print');

      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();

      await user.click(screen.getByLabelText('Select SUP-1'));
      expect(await screen.findByText('1 selected')).toBeInTheDocument();
    });

    it('reports a mixed bulk result and refreshes the table', async () => {
      role = 'supervisor';
      get.mockImplementation((path: string) =>
        path === '/api/agents'
          ? Promise.resolve({ items: [{ id: 'u9', name: 'Agent Zed' }], total: 1 })
          : Promise.resolve({ items: [ticket()], total: 1 })
      );
      post.mockResolvedValue([
        { ticket_id: 't1', success: false, reason: 'This ticket is archived — restore it before reassigning' },
      ]);
      const user = userEvent.setup();
      renderQueue();
      await screen.findByText('Printer will not print');

      await user.click(screen.getByLabelText('Select SUP-1'));
      await screen.findByText('1 selected');

      const callsBefore = get.mock.calls.length;
      await user.selectOptions(await screen.findByLabelText('Reassign selected to'), 'u9');
      await user.click(screen.getByRole('button', { name: 'Reassign' }));

      expect(post).toHaveBeenCalledWith('/api/tickets/bulk-reassign', {
        ticket_ids: ['t1'],
        assignee_id: 'u9',
      });
      expect(await screen.findByText('0 of 1 succeeded.')).toBeInTheDocument();
      // Scoped to the failure list item — "Show archived" also matches /archived/ loosely.
      expect(screen.getByText(/archived/, { selector: 'li' })).toBeInTheDocument();
      // The table was reloaded after the action, not left showing stale data.
      await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(callsBefore));
    });
  });

  describe('export', () => {
    it('carries the current filters into the CSV export link', async () => {
      const user = userEvent.setup();
      renderQueue();
      await waitFor(() => expect(get).toHaveBeenCalled());

      await user.selectOptions(screen.getByLabelText('Filter by status'), 'open');
      await waitFor(() => expect(ticketsQuery()).toContain('status=open'));

      const link = screen.getByRole('link', { name: 'Export CSV' });
      expect(link.getAttribute('href')).toContain('/api/tickets/export.csv?');
      expect(link.getAttribute('href')).toContain('status=open');
    });
  });
});
