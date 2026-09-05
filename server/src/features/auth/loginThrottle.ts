/**
 * A cap on how fast one caller may guess passwords.
 *
 * Without it `POST /api/auth/login` will answer an unlimited number of attempts as fast as
 * bcrypt can run, which is the whole attack: the demo accounts have short, guessable
 * passwords, and nothing anywhere else in the system slows a caller down.
 *
 * Deliberately in memory, and deliberately small. A shared store (Redis) would survive
 * restarts and cover several instances, but this deploys as one free-tier process — adding
 * a second service to rate-limit a login form would be more moving parts than the problem
 * has. The limitation is real and worth naming: a restart clears the counters, and if this
 * ever runs on more than one instance each keeps its own.
 *
 * Failures are counted per IP *and* per email, with different limits, because the two
 * guard different things and get the threshold wrong in opposite directions:
 *
 * - Per email, low. This is the one that actually stops guessing at a known account.
 * - Per IP, much higher. An address is a poor proxy for a person — a whole office behind
 *   one NAT, or a browser and the API on the same host, share it. Setting this as low as
 *   the email limit turns a handful of typos across a team into an outage for all of them.
 *
 * A successful login clears both counters, so someone who mistypes and then gets it right
 * is never left locked out by their own earlier attempts.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_EMAIL = 10;
const MAX_FAILURES_PER_IP = 50;

export interface ThrottleKey {
  key: string;
  max: number;
}

type Bucket = { failures: number; firstFailureAt: number };

const buckets = new Map<string, Bucket>();

/** The pair of counters one login attempt is measured against. */
export function throttleKeysFor(ip: string, email: string): ThrottleKey[] {
  return [
    { key: `ip:${ip}`, max: MAX_FAILURES_PER_IP },
    { key: `email:${email.trim().toLowerCase()}`, max: MAX_FAILURES_PER_EMAIL },
  ];
}

/** Drop buckets whose window has passed, so the map cannot grow without bound. */
function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.firstFailureAt > WINDOW_MS) buckets.delete(key);
  }
}

function current(key: string, now: number): Bucket | undefined {
  const bucket = buckets.get(key);
  if (!bucket) return undefined;
  if (now - bucket.firstFailureAt > WINDOW_MS) {
    buckets.delete(key);
    return undefined;
  }
  return bucket;
}

/** Whether this attempt should be refused before the password is even checked. */
export function isThrottled(keys: ThrottleKey[], now = Date.now()): boolean {
  return keys.some(({ key, max }) => (current(key, now)?.failures ?? 0) >= max);
}

/** How long the caller should wait, in whole seconds — for the Retry-After header. */
export function retryAfterSeconds(keys: ThrottleKey[], now = Date.now()): number {
  const waits = keys
    .map(({ key, max }) => ({ bucket: current(key, now), max }))
    .filter((e): e is { bucket: Bucket; max: number } => !!e.bucket && e.bucket.failures >= e.max)
    .map((e) => Math.ceil((WINDOW_MS - (now - e.bucket.firstFailureAt)) / 1000));

  return waits.length > 0 ? Math.max(...waits) : 0;
}

export function recordFailure(keys: ThrottleKey[], now = Date.now()): void {
  sweep(now);
  for (const { key } of keys) {
    const bucket = current(key, now);
    if (bucket) bucket.failures += 1;
    else buckets.set(key, { failures: 1, firstFailureAt: now });
  }
}

export function clearFailures(keys: ThrottleKey[]): void {
  for (const { key } of keys) buckets.delete(key);
}

/** Test seam — the counters are process-wide, so a test must be able to reset them. */
export function resetThrottle(): void {
  buckets.clear();
}

export const THROTTLE = { WINDOW_MS, MAX_FAILURES_PER_EMAIL, MAX_FAILURES_PER_IP } as const;
