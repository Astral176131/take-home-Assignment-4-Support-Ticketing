import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ApiError, SESSION_EXPIRED_EVENT } from '../api';

/**
 * A 401 has to mean one of two different things depending on where it came from, and
 * getting that wrong is what leaves someone stranded on a signed-in-looking app whose
 * every request fails.
 */
describe('api: session expiry', () => {
  const onExpired = vi.fn();

  function respondWith(status: number, body: unknown = { error: 'Authentication required' }) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status }))
    );
  }

  beforeEach(() => {
    onExpired.mockClear();
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
  });

  afterEach(() => {
    window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
    vi.unstubAllGlobals();
  });

  it('announces an expired session when a data request is rejected', async () => {
    respondWith(401);

    await expect(api.get('/api/tickets')).rejects.toBeInstanceOf(ApiError);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('stays quiet for a rejected sign-in, which means a wrong password', async () => {
    respondWith(401, { error: 'Invalid email or password' });

    await expect(api.post('/api/auth/login', {})).rejects.toThrow('Invalid email or password');
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('stays quiet for the session probe, which 401s for anyone not signed in', async () => {
    respondWith(401);

    await expect(api.get('/api/auth/me')).rejects.toBeInstanceOf(ApiError);
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('stays quiet for a refusal that is about permission, not identity', async () => {
    respondWith(403, { error: 'Only a supervisor can close a ticket' });

    await expect(api.post('/api/tickets/t1/status', {})).rejects.toThrow(
      'Only a supervisor can close a ticket'
    );
    expect(onExpired).not.toHaveBeenCalled();
  });
});
