import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Layout } from '../Layout';

const get = vi.fn();

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, api: { get: (p: string) => get(p) } };
});

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Agent A', email: 'a@x.com', role: 'agent' }, logout: vi.fn() }),
}));

function renderLayout() {
  return render(
    <MemoryRouter>
      <Layout />
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
});
