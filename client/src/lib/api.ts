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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.body) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, { credentials: 'include', ...init, headers });

  if (!res.ok) {
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
