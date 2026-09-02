import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { NewTicketPage } from '../NewTicketPage';
import type { Role } from '../../types';

const get = vi.fn();
const post = vi.fn();
const navigate = vi.fn();

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, api: { get: (p: string) => get(p), post: (p: string, b?: unknown) => post(p, b) } };
});

let role: Role = 'agent';

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Agent A', email: 'a@x.com', role } }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

function renderPage() {
  return render(
    <MemoryRouter>
      <NewTicketPage />
    </MemoryRouter>
  );
}

async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Subject'), 'Printer will not print');
  await user.type(screen.getByLabelText('Description'), 'It makes a noise and stops.');
  await user.type(screen.getByLabelText('Requester name'), 'Jane Customer');
  await user.type(screen.getByLabelText('Requester email'), 'jane@corp.com');
}

describe('NewTicketPage', () => {
  beforeEach(() => {
    role = 'agent';
    get.mockReset();
    post.mockReset();
    get.mockResolvedValue({ items: [], total: 0 });
  });

  it('creates a ticket from what was typed and opens it', async () => {
    post.mockResolvedValue({ id: 'new-1' });
    const user = userEvent.setup();
    renderPage();

    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Create ticket' }));

    expect(post).toHaveBeenCalledWith('/api/tickets', {
      subject: 'Printer will not print',
      description: 'It makes a noise and stops.',
      requester: { name: 'Jane Customer', email: 'jane@corp.com' },
      priority_code: 'normal',
      category: 'bug',
    });
    expect(navigate).toHaveBeenCalledWith('/tickets/new-1');
  });

  it('sends the agent as assignee only when they opt in', async () => {
    post.mockResolvedValue({ id: 'new-2' });
    const user = userEvent.setup();
    renderPage();

    await fillRequired(user);
    await user.click(screen.getByLabelText('Assign this to me'));
    await user.click(screen.getByRole('button', { name: 'Create ticket' }));

    expect(post.mock.calls[0][1]).toMatchObject({ assignee_id: 'u1' });
  });

  it('gives an agent no way to assign a colleague', async () => {
    renderPage();

    expect(screen.getByLabelText('Assign this to me')).toBeInTheDocument();
    expect(screen.queryByLabelText('Assign to')).not.toBeInTheDocument();
  });

  it('offers a supervisor the agent roster', async () => {
    role = 'supervisor';
    get.mockResolvedValue({ items: [{ id: 'u9', name: 'Agent Zed' }], total: 1 });
    renderPage();

    expect(await screen.findByRole('option', { name: 'Agent Zed' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Assign this to me')).not.toBeInTheDocument();
  });

  it('warns when the requester already has open tickets', async () => {
    get.mockResolvedValue({
      items: [
        { id: 't7', subject: 'Printer jams', status: 'open', assignee: { id: 'u2', name: 'Bob' } },
      ],
      total: 1,
    });
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Requester email'), 'jane@corp.com');
    await user.tab();

    expect(await screen.findByText(/already has 1 open ticket/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Printer jams' })).toBeInTheDocument();
    expect(screen.getByText('with Bob')).toBeInTheDocument();
  });

  it('still lets the ticket be filed despite the warning', async () => {
    get.mockResolvedValue({
      items: [{ id: 't7', subject: 'Printer jams', status: 'open', assignee: null }],
      total: 1,
    });
    post.mockResolvedValue({ id: 'new-3' });
    const user = userEvent.setup();
    renderPage();

    await fillRequired(user);
    await user.tab();
    await screen.findByText(/already has 1 open ticket/i);
    await user.click(screen.getByRole('button', { name: 'Create ticket' }));

    expect(post).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/tickets/new-3');
  });

  it("shows the server's reason when creation is refused", async () => {
    const { ApiError } = await import('../../lib/api');
    post.mockRejectedValue(new ApiError(400, 'A subject is required'));
    const user = userEvent.setup();
    renderPage();

    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Create ticket' }));

    expect(await screen.findByText('A subject is required')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});
