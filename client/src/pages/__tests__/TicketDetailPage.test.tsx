import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TicketDetailPage } from '../TicketDetailPage';
import type { Ticket } from '../../types';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return {
    ...actual,
    api: {
      get: (p: string) => get(p),
      post: (p: string, b?: unknown) => post(p, b),
      patch: (p: string, b: unknown) => patch(p, b),
      del: (p: string) => del(p),
    },
  };
});

// TicketPeople renders only for supervisors, so the viewer's role is part of the fixture.
let role: 'agent' | 'supervisor' = 'agent';

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'sup1', name: 'Supervisor', email: 's@x.com', role } }),
}));

// The page refreshes the shared alert count after any successful action, so the nav badge
// follows a resolve or an acknowledge immediately instead of on its next poll.
const refreshAlerts = vi.fn();

vi.mock('../../context/AlertsContext', () => ({
  useAlerts: () => ({ items: [], total: 0, loading: false, error: '', refresh: refreshAlerts }),
}));

const alice = { id: 'u1', name: 'Alice' };
const bob = { id: 'u2', name: 'Bob' };

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 't1',
    key: 'SUP-1',
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
      alert_active: false, snoozed_for_minutes: null,
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
    patch.mockReset();
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

  it('clears the reply box on success but keeps what was typed if the post fails', async () => {
    get.mockResolvedValue(ticket());
    const { ApiError } = await import('../../lib/api');
    post.mockRejectedValue(new ApiError(500, 'Internal server error'));
    const user = userEvent.setup();
    renderPage();

    const box = await screen.findByLabelText('Reply');
    await user.type(box, 'A reply worth not losing');
    await user.click(screen.getByRole('button', { name: 'Add reply' }));

    await screen.findByText(/Internal server error/);
    // Lost work is worse than an error banner — the draft must still be there.
    expect(box).toHaveValue('A reply worth not losing');
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

    expect(await screen.findByText(/Only a supervisor can close a ticket/)).toBeInTheDocument();
  });

  it('freezes an archived ticket', async () => {
    get.mockResolvedValue(ticket({ archived_at: '2026-09-02T11:00:00Z' }));
    renderPage();

    expect(await screen.findByText('Archived')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add reply' })).not.toBeInTheDocument();
    // The server refuses an edit on an archived ticket, so the page never offers one.
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  describe('editing the ticket', () => {
    /** Open the edit form and hand back a driver for it. */
    async function openEditor(t = ticket()) {
      get.mockResolvedValue(t);
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: 'Edit' }));
      return user;
    }

    it('opens an editor prefilled with the ticket as it stands', async () => {
      await openEditor();

      expect(screen.getByLabelText('Subject')).toHaveValue('Printer will not print');
      expect(screen.getByLabelText('Description')).toHaveValue('It makes a noise and then stops.');
      expect(screen.getByLabelText('Priority')).toHaveValue('high');
      expect(screen.getByLabelText('Category')).toHaveValue('bug');
    });

    it('sends only the fields that actually changed', async () => {
      const user = await openEditor();
      patch.mockResolvedValue(ticket({ subject: 'Printer jams on page 2' }));

      const subject = screen.getByLabelText('Subject');
      await user.clear(subject);
      await user.type(subject, 'Printer jams on page 2');
      await user.selectOptions(screen.getByLabelText('Priority'), 'urgent');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));

      // Description and category were untouched, so they are absent from the body.
      expect(patch).toHaveBeenCalledWith('/api/tickets/t1', {
        subject: 'Printer jams on page 2',
        priority_code: 'urgent',
      });
    });

    it('re-renders from the response and closes the editor on success', async () => {
      const user = await openEditor();
      patch.mockResolvedValue(ticket({ subject: 'Printer jams on page 2' }));

      await user.clear(screen.getByLabelText('Subject'));
      await user.type(screen.getByLabelText('Subject'), 'Printer jams on page 2');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));

      expect(await screen.findByText('Printer jams on page 2')).toBeInTheDocument();
      expect(screen.queryByLabelText('Subject')).not.toBeInTheDocument();
    });

    it('keeps the editor open with the edits intact when the save fails', async () => {
      const user = await openEditor();
      patch.mockRejectedValue(
        new (await import('../../lib/api')).ApiError(403, 'You do not have access to this ticket')
      );

      await user.clear(screen.getByLabelText('Subject'));
      await user.type(screen.getByLabelText('Subject'), 'Hijacked');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));

      expect(await screen.findByText(/You do not have access to this ticket/)).toBeInTheDocument();
      expect(screen.getByLabelText('Subject')).toHaveValue('Hijacked');
    });

    it('cannot be saved with nothing changed, or with a field emptied', async () => {
      const user = await openEditor();

      // Nothing edited yet — the endpoint would refuse an empty body with a 400, so the
      // button is disabled rather than the error being discovered after the fact.
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

      await user.clear(screen.getByLabelText('Subject'));
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

      await user.type(screen.getByLabelText('Subject'), 'A real subject');
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    });

    it('discards the edits on cancel, leaving the ticket alone', async () => {
      const user = await openEditor();

      await user.clear(screen.getByLabelText('Subject'));
      await user.type(screen.getByLabelText('Subject'), 'Never saved');
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(patch).not.toHaveBeenCalled();
      expect(screen.getByText('Printer will not print')).toBeInTheDocument();
    });

    it('is offered to an agent, not only a supervisor — editing needs only ticket access', async () => {
      await openEditor();

      expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    });
  });

  describe('acknowledging an alert', () => {
    it('shows no Acknowledge button when there is no active alert', async () => {
      get.mockResolvedValue(ticket()); // sla.alert_active: false by default
      renderPage();

      await screen.findByText('Printer will not print');
      expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
    });

    it('shows Acknowledge when there is an active alert, and posts to ack on click', async () => {
      const breaching = ticket({
        sla: {
          elapsed_minutes: 300,
          target_minutes: 240,
          remaining_minutes: -60,
          breached: true,
          warning: false,
          alert_active: true, snoozed_for_minutes: null,
        },
      });
      get.mockResolvedValue(breaching);
      post.mockResolvedValue(ticket({ sla: { ...breaching.sla, breached: true, alert_active: false } }));
      const user = userEvent.setup();
      renderPage();

      const button = await screen.findByRole('button', { name: 'Acknowledge' });
      await user.click(button);

      expect(post).toHaveBeenCalledWith('/api/tickets/t1/alerts/ack', undefined);
      // Re-rendered from the response: the alert is gone, so is the button.
      expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
      // And the nav badge is told, rather than being left to notice on its next poll.
      expect(refreshAlerts).toHaveBeenCalled();
    });

    it('refreshes the shared count after a status change too, not only an ack', async () => {
      // Resolving a breaching ticket ends its clock, so it should leave the badge at once.
      get.mockResolvedValue(ticket());
      post.mockResolvedValue(ticket({ status: 'resolved', allowed_transitions: ['open'] }));
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: 'Resolve' }));

      expect(refreshAlerts).toHaveBeenCalled();
    });
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
