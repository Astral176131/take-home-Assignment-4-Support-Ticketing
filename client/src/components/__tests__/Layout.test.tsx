import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Layout } from '../Layout';
import { AlertsProvider } from '../../context/AlertsContext';
import { UnassignedProvider } from '../../context/UnassignedContext';

const get = vi.fn();

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, api: { get: (p: string) => get(p) } };
});

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Agent A', email: 'a@x.com', role: 'agent' }, logout: vi.fn() }),
}));

/** The real provider, since the badge's whole job is to render what it holds. */
function renderLayout() {
  return render(
    <MemoryRouter>
      <AlertsProvider>
        <UnassignedProvider>
          <Layout />
        </UnassignedProvider>
      </AlertsProvider>
    </MemoryRouter>
  );
}

describe('Layout alert badge', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows no badge when there are no active alerts', async () => {
    get.mockResolvedValue({ items: [], total: 0 });
    renderLayout();

    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/alerts'));
    expect(screen.queryByText(/^\d+$/)).not.toBeInTheDocument();
  });

  it('shows the alert count once loaded', async () => {
    get.mockResolvedValue({ items: [], total: 3 });
    renderLayout();

    expect(await screen.findByText('3')).toBeInTheDocument();
  });

  it('keeps the last known count rather than clearing it on a failed poll', async () => {
    get.mockResolvedValueOnce({ items: [], total: 2 }).mockRejectedValueOnce(new Error('network blip'));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderLayout();

    await vi.waitFor(() => expect(screen.getByText('2')).toBeInTheDocument());

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));

    // The failed second poll must not have reset the badge.
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('follows the shared count down without waiting for the next poll', async () => {
    // The bug this replaced: the badge held its own copy, so acknowledging an alert
    // anywhere else left it counting a ticket that was no longer alerting until the poll
    // came round a minute later — or until the page was reloaded by hand.
    get.mockResolvedValueOnce({ items: [], total: 2 }).mockResolvedValueOnce({ items: [], total: 1 });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderLayout();

    await vi.waitFor(() => expect(screen.getByText('2')).toBeInTheDocument());

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
    expect(screen.queryByText('2')).not.toBeInTheDocument();
  });
});
