import { CookieOptions } from 'express';

/**
 * Read lazily, not at module load. `import` statements are hoisted above any code that
 * runs before them — this project has hit that exact trap three times already (a
 * standalone script, and twice in test tooling) — so a module-scope
 * `const SECRET = process.env.JWT_SECRET!` risks signing with `undefined` if this module
 * is ever imported before the environment is loaded. Throwing here instead gives a clear
 * error pointing at the actual cause.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  return secret;
}

/**
 * The session cookie's attributes — one definition, used identically by both the route
 * that sets it and the one that clears it. They drifting apart is exactly how "logout"
 * stops actually clearing the cookie: clearCookie only matches a cookie whose path,
 * domain, secure and sameSite attributes are identical to the one that set it.
 *
 * `SameSite=None` is required once the client and API are on different origins — which is
 * the deployed setup (Vercel + Render) — because a `Lax` cookie is not sent on a cross-site
 * fetch at all, only on top-level navigations. Browsers require `Secure` alongside
 * `SameSite=None`, so this can only be `none` when the connection is actually HTTPS, which
 * is why it's tied to production rather than always-on: a plain-HTTP local dev server
 * cannot satisfy that pairing, and the cookie would be silently rejected.
 */
export function cookieOptions(): CookieOptions {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
  };
}
