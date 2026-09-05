/**
 * The one place the app talks to the server.
 *
 * Every call carries the session cookie and turns a non-2xx response into a thrown
 * ApiError holding the server's own message, so components can show what actually went
 * wrong — "Only a supervisor can close a ticket" rather than a generic failure.
 */

export class ApiError extends Error {
  // Declared explicitly rather than as a constructor parameter property: the client's
  // tsconfig sets erasableSyntaxOnly, which rules that shorthand out.
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// Empty in dev, where Vite's proxy forwards /api to the local server on the same
// origin. Also empty in production, where Vercel rewrites /api to the API service so
// the session cookie comes back first-party. Only set when the API is genuinely on
// another origin, which costs you the cookie in any browser that blocks third-party
// ones - see decisions.md 15.
const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');

/**
 * Fired when the server rejects a request because the session is gone.
 *
 * Signing in stores the user in memory and only re-checks against the server on a full
 * page load, so a session that dies mid-visit leaves the app looking signed in while
 * every request fails. That is not a hypothetical: a browser that silently drops the
 * session cookie produces exactly it, and the result is an app that renders its own
 * navigation over a wall of "Authentication required" with no way out.
 *
 * An event rather than a direct import: this module is the bottom of the dependency
 * graph and must not reach up into React context.
 */
export const SESSION_EXPIRED_EVENT = 'supportdesk:session-expired';

/**
 * 401 means something different on these two, so neither ends the session.
 * `login` answers 401 for a wrong password, and `me` answers 401 for someone who was
 * simply never signed in, which is the ordinary first-load case.
 */
const AUTH_PROBES = ['/api/auth/login', '/api/auth/me'];

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API_URL}${path}`, { credentials: 'include', ...init, headers });

  if (!res.ok) {
    if (res.status === 401 && !AUTH_PROBES.some((probe) => path.startsWith(probe))) {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    }

    let message = res.statusText || 'Request failed';
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      // A non-JSON error body; the status text will have to do.
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
