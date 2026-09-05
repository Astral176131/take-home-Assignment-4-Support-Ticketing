/**
 * The priority and category choices offered when writing a ticket, with the labels a
 * person reads rather than the raw enum values the API speaks.
 *
 * Shared by the create form and the edit form: the two offer exactly the same choices, and
 * a ticket that could be created with a priority the edit form does not list (or the other
 * way round) would be a small, quiet trap. One list means that cannot happen.
 *
 * The queue's filter dropdowns deliberately do not use these: a filter offers "all
 * statuses" alongside the values and is a different control, not the same list rendered
 * twice.
 */

import type { Category, Priority } from '../types';

/** The target response time in each label is the seeded value from `priorities`. */
export const PRIORITY_OPTIONS: Array<{ value: Priority; label: string }> = [
  { value: 'low', label: 'Low (3 days)' },
  { value: 'normal', label: 'Normal (1 day)' },
  { value: 'high', label: 'High (4 hours)' },
  { value: 'urgent', label: 'Urgent (1 hour)' },
];

export const CATEGORY_OPTIONS: Array<{ value: Category; label: string }> = [
  { value: 'bug', label: 'Bug' },
  { value: 'billing', label: 'Billing' },
  { value: 'how_to', label: 'How-to' },
  { value: 'other', label: 'Other' },
];
