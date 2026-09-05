/**
 * The checks every free-text field on a ticket needs, in one place — subject, description,
 * reply body and requester name all want the same three things and were each doing two of
 * them.
 *
 * The limits are deliberate rather than defensive decoration. Without one, a 100,000
 * character subject is accepted and stored, and then has to be rendered in every queue row
 * and written into every CSV export. Without the NUL check, Postgres rejects the insert
 * itself (`22021 invalid byte sequence for encoding "UTF8"`) and a bad request surfaces as
 * a 500 with a stack trace rather than a 400 explaining what was wrong.
 */

export const LIMITS = {
  subject: 200,
  description: 10_000,
  replyBody: 10_000,
  requesterName: 200,
  requesterEmail: 320, // the practical maximum length of an email address
} as const;

export type TextResult = { ok: true; value: string } | { ok: false; error: string };

/** Postgres cannot store a NUL byte in a text column, whatever the encoding. */
const NUL = '\u0000';

/**
 * Require a non-empty string of at most `max` characters, with no NUL bytes, and return it
 * trimmed. `label` is what the caller sees, so it reads as a sentence about their input.
 */
export function readText(value: unknown, label: string, max: number): TextResult {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: `A ${label} is required` };
  }
  // Checked before trimming: a NUL is not whitespace, so trimming would not remove it.
  if (value.includes(NUL)) {
    return { ok: false, error: `A ${label} cannot contain null bytes` };
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    return { ok: false, error: `A ${label} cannot be longer than ${max} characters` };
  }
  return { ok: true, value: trimmed };
}

/**
 * A deliberately ordinary email check: something, an @, something with a dot in it. Not
 * RFC 5322 — that grammar accepts addresses no support desk will ever see and is famously
 * unreadable. What matters here is rejecting the values that silently corrupt data.
 *
 * The bar used to be `includes('@')`, which accepted the single character "@". Since
 * `requesters.email` is unique and lowercased, every such entry collapses a different
 * customer into the same record — precisely the split-history failure the unique index was
 * added to prevent, arriving from the other direction.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function readEmail(value: unknown, label: string): TextResult {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: `A ${label} is required` };
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length > LIMITS.requesterEmail) {
    return { ok: false, error: `A ${label} cannot be longer than ${LIMITS.requesterEmail} characters` };
  }
  if (!EMAIL.test(trimmed)) {
    return { ok: false, error: `A valid ${label} is required` };
  }
  return { ok: true, value: trimmed };
}
