import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TicketDetailPage } from '../TicketDetailPage';
import type { Ticket } from '../../types';

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return {
    ...actual,
    api: {
      get: (p: string) => get(p),
      post: (p: string, b?: unknown) => post(p, b),
      del: (p: string) => del(p),
    },
  };
});

// TicketPeople renders only for supervisors, so the viewer's role is part of the fixture.
let role: 'agent' | 'supervisor' = 'agent';

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'sup1', name: 'Supervisor', email: 's@x.com', role } }),
}));

const alice = { id: 'u1', name: 'Alice' };
const bob = { id: 'u2', name: 'Bob' };

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 't1',
    subject: 'Printer will not print',
    description: 'It makes a noise and then stops.',
    status: 'open',
    priority_code: 'high',
    category: 'bug',
    requester: { id: 'r1', name: 'Jane Customer', email: 'jane@corp.com' },
    assignee: alice,
    collaborators: [bob],
    replies: [
      {
        id: 'rep1',
        body: 'Looking into this now.',
        author: alice,
        author_type: 'agent',
        is_internal: false,
        created_at: '2026-09-02T10:00:00Z',
      },
      {
        id: 'rep2',
        body: 'Suspect the auth cache.',
        author: alice,
        author_type: 'agent',
        is_internal: true,
        created_at: '2026-09-02T10:30:00Z',
      },
    ],
    events: [
      {
        id: 'ev1',
        event_type: 'collaborator_added',
        actor: alice,
        old_value: null,
        new_value: 'u2',
        target: bob,
        created_at: '2026-09-02T09:00:00Z',
      },
      {
        id: 'ev2',
        event_type: 'status_change',
        actor: alice,
        old_value: 'new',
        new_value: 'open',
        target: null,
        created_at: '2026-09-02T09:30:00Z',
      },
    ],
    allowed_transitions: ['pending', 'resolved'],
    sla: {
      elapsed_minutes: 100,
      target_minutes: 240,
      remaining_minutes: 140,
      breached: false,
      warning: false,
      alert_active: false,
    },
    pending_since: null,
    paused_minutes: 0,
    resolved_at: null,
    closed_at: null,
    archived_at: null,
    ack_cycle: 0,
    acked_through_cycle: null,
    clock_started_at: '2026-09-02T09:00:00Z',
    created_at: '2026-09-02T09:00:00Z',
    updated_at: '2026-09-02T10:30:00Z',
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/tickets/t1']}>
      <Routes>
        <Route path="/tickets/:id" element={<TicketDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('TicketDetailPage', () => {
  beforeEach(() => {
    role = 'agent';
    get.mockReset();
    post.mockReset();
    del.mockReset();
  });

  it('shows the subject, description and metadata', async () => {
    get.mockResolvedValue(ticket());
    renderPage();

    expect(await screen.findByText('Printer will not print')).toBeInTheDocument();
    expect(screen.getByText('It makes a noise and then stops.')).toBeInTheDocument();
    expect(screen.getByText('Jane Customer')).toBeInTheDocument();
    expect(screen.getByText('jane@corp.com')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('lists replies oldest first and marks the internal one', async () => {
    get.mockResolvedValue(ticket());
    renderPage();

    const items = await screen.findAllByRole('listitem');
    expect(within(items[0]).getByText('Looking into this now.')).toBeInTheDocument();
    expect(within(items[1]).getByText('Suspect the auth cache.')).toBeInTheDocument();
    expect(within(items[1]).getByText('internal')).toBeInTheDocument();
    expect(within(items[0]).queryByText('internal')).not.toBeInTheDocument();
  });

  it('shows structural history under History, with names not ids', async () => {
    get.mockResolvedValue(ticket());
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('tab', { name: 'History' }));

    expect(screen.getByText('Alice added Bob as a collaborator')).toBeInTheDocument();
    expect(screen.getByText('Alice moved this from new to open')).toBeInTheDocument();
    // Reply bodies belong to Comments, so History stays an audit view.
    expect(screen.queryByText('Looking into this now.')).not.toBeInTheDocument();
  });

  it('offers only the transitions the server permits', async () => {
    get.mockResolvedValue(ticket());
    renderPage();

    expect(await screen.findByRole('button', { name: 'Waiting on customer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  it('offers Close when the server lists it', async () => {
    get.mockResolvedValue(ticket({ status: 'resolved', allowed_transitions: ['open', 'closed'] }));
    renderPage();

    expect(await screen.findByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
  });

  it('posts a status change and re-renders from the response', async () => {
    get.mockResolvedValue(ticket());
    post.mockResolvedValue(ticket({ status: 'resolved', allowed_transitions: ['open'] }));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Resolve' }));

    expect(post).toHaveBeenCalledWith('/api/tickets/t1/status', { status: 'resolved' });
    expect(await screen.findByRole('button', { name: 'Reopen' })).toBeInTheDocument();
  });

  it('posts a reply with its flags', async () => {
    get.mockResolvedValue(ticket());
    post.mockResolvedValue(ticket());
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Reply'), 'Any update?');
    await user.click(screen.getByLabelText('Internal note'));
    await user.click(screen.getByRole('button', { name: 'Add reply' }));

    expect(post).toHaveBeenCalledWith('/api/tickets/t1/replies', {
      body: 'Any update?',
      is_internal: true,
      author_type: 'agent',
    });
  });

  it('rules out marking a customer email as internal', async () => {
    get.mockResolvedValue(ticket());
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByLabelText('Log a customer email'));

    expect(screen.getByLabelText('Internal note')).toBeDisabled();
  });

  it("surfaces the server's reason when an action is refused", async () => {
    get.mockResolvedValue(ticket({ status: 'resolved', allowed_transitions: ['open', 'closed'] }));
    post.mockRejectedValue(
      new (await import('../../lib/api')).ApiError(403, 'Only a supervisor can close a ticket')
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Close' }));

    expect(await screen.findByText('Only a supervisor can close a ticket')).toBeInTheDocument();
  });

  it('freezes an archived ticket', async () => {
    get.mockResolvedValue(ticket({ archived_at: '2026-09-02T11:00:00Z' }));
    renderPage();

    expect(await screen.findByText('Archived')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add reply' })).not.toBeInTheDocument();
  });

  describe('people controls', () => {
    /** The first call loads the ticket; TicketPeople then asks for the agent roster. */
    function mockSupervisorView(t = ticket()) {
      role = 'supervisor';
      get.mockImplementation((path: string) =>
        path === '/api/agents'
          ? Promise.resolve({ items: [alice, bob, { id: 'u3', name: 'Carol' }], total: 3 })
          : Promise.resolve(t)
      );
    }

    it('are absent for an agent entirely', async () => {
      get.mockResolvedValue(ticket());
      renderPage();

      await screen.findByText('Printer will not print');
      expect(screen.queryByLabelText('Reassign to')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Add collaborator')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Remove Bob' })).not.toBeInTheDocument();
      // The agent still sees who is on the ticket, read-only.
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });

    it('are shown to a supervisor', async () => {
      mockSupervisorView();
      renderPage();

      expect(await screen.findByLabelText('Reassign to')).toBeInTheDocument();
      expect(screen.getByLabelText('Add collaborator')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Remove Bob' })).toBeInTheDocument();
    });

    it('offer the supervisor the escalation option, and never the current assignee', async () => {
      mockSupervisorView();
      renderPage();

      const reassignSelect = await loadedSelect('Reassign to');
      expect(
        within(reassignSelect).getByRole('option', { name: 'Take this on myself' })
      ).toBeInTheDocument();
      // Alice already holds it, so reassigning to her is not offered.
      expect(within(reassignSelect).queryByRole('option', { name: 'Alice' })).not.toBeInTheDocument();
    });

    /**
     * The select exists before the roster arrives, so waiting for the element is not
     * enough — wait for an option inside it, scoped to that select since the same agent
     * appears in both dropdowns.
     */
    async function loadedSelect(label: string) {
      const select = await screen.findByLabelText(label);
      await within(select).findByRole('option', { name: 'Carol' });
      return select;
    }

    it('does not offer an existing collaborator in the add list', async () => {
      mockSupervisorView();
      renderPage();

      // Bob is already a collaborator; Carol is not.
      const addSelect = await loadedSelect('Add collaborator');
      expect(within(addSelect).queryByRole('option', { name: 'Bob' })).not.toBeInTheDocument();
    });

    it('posts a reassignment', async () => {
      mockSupervisorView();
      post.mockResolvedValue(ticket({ assignee: { id: 'u3', name: 'Carol' } }));
      const user = userEvent.setup();
      renderPage();

      await user.selectOptions(await loadedSelect('Reassign to'), 'u3');
      await user.click(screen.getByRole('button', { name: 'Reassign' }));

      expect(post).toHaveBeenCalledWith('/api/tickets/t1/reassign', { assignee_id: 'u3' });
    });

    it('posts a collaborator addition', async () => {
      mockSupervisorView();
      post.mockResolvedValue(ticket());
      const user = userEvent.setup();
      renderPage();

      await user.selectOptions(await loadedSelect('Add collaborator'), 'u3');
      await user.click(screen.getByRole('button', { name: 'Add' }));

      expect(post).toHaveBeenCalledWith('/api/tickets/t1/collaborators', { agent_id: 'u3' });
    });

    it('deletes a collaborator', async () => {
      mockSupervisorView();
      del.mockResolvedValue(ticket({ collaborators: [] }));
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: 'Remove Bob' }));

      expect(del).toHaveBeenCalledWith('/api/tickets/t1/collaborators/u2');
    });

    it("surfaces the server's reason when a reassignment is refused", async () => {
      mockSupervisorView();
      const { ApiError } = await import('../../lib/api');
      post.mockRejectedValue(
        new ApiError(400, 'A ticket can only be assigned to an agent, or to yourself as an escalation')
      );
      const user = userEvent.setup();
      renderPage();

      await user.selectOptions(await loadedSelect('Reassign to'), 'u3');
      await user.click(screen.getByRole('button', { name: 'Reassign' }));

      expect(await screen.findByText(/only be assigned to an agent/i)).toBeInTheDocument();
    });
  });
});
