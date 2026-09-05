import { Category, Prisma, Priority, Role } from '@prisma/client';
import { API_STATUSES, API_TO_STATUS, ApiStatus } from './stateMachine.js';

/**
 * The filter and sort logic behind the ticket queue. Shared by the list endpoint and the
 * CSV export, which the brief requires to use "the same filters as the list endpoint" —
 * one definition means they cannot drift apart.
 */

const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent'];
const CATEGORIES: Category[] = ['bug', 'billing', 'how_to', 'other'];

const SORT_FIELDS = ['created_at', 'priority', 'updated_at'] as const;
type SortField = (typeof SORT_FIELDS)[number];

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

export interface TicketQueryInput {
  q?: unknown;
  status?: unknown;
  priority?: unknown;
  category?: unknown;
  assignee_id?: unknown;
  /** 'true' includes archived alongside live ones, 'only' returns just the archived. */
  archived?: unknown;
  /** 'true' keeps only tickets past their response target. Applied after the query, not
   *  in it: see the note on filterBreaching below. */
  breaching?: unknown;
  sort?: unknown;
  dir?: unknown;
}

const ARCHIVED_MODES = ['true', 'only'] as const;

type Actor = { userId: string; role: Role };

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Every filter, plus access scoping and the archived toggle, ANDed together. Scoping is
 * unconditional — it is not something a query parameter can widen — so it is folded in
 * here rather than left to each caller to remember.
 */
export function buildTicketWhere(actor: Actor, query: TicketQueryInput): Result<Prisma.TicketWhereInput> {
  const and: Prisma.TicketWhereInput[] = [];

  // Three states, not two: exclude archived (the default), include them alongside the
  // live ones, or show nothing but the archive. 'true' keeps its original meaning so an
  // existing link or bookmark still does what it used to.
  if (query.archived !== undefined && query.archived !== '' && query.archived !== 'false') {
    if (typeof query.archived !== 'string' || !ARCHIVED_MODES.includes(query.archived as 'true' | 'only')) {
      return { ok: false, error: `archived must be one of: ${ARCHIVED_MODES.join(', ')}` };
    }
    if (query.archived === 'only') and.push({ archivedAt: { not: null } });
  } else {
    and.push({ archivedAt: null });
  }

  if (actor.role === 'agent') {
    and.push({
      OR: [{ assigneeId: actor.userId }, { collaborators: { some: { agentId: actor.userId } } }],
    });
  }

  if (typeof query.q === 'string' && query.q.trim()) {
    const term = query.q.trim();
    // ILIKE '%term%' — accelerated by the pg_trgm GIN indexes on subject and description,
    // and the only form that matches a genuine partial word ("print" inside "printer").
    and.push({
      OR: [
        { subject: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
        // Requesters are searched by name too: "everything Priya Nair has raised" is the
        // question people actually arrive with, and it was previously unanswerable
        // without knowing a ticket key. There is no trigram index on this column, but the
        // requester table is small and the join is on a primary key.
        { requester: { name: { contains: term, mode: 'insensitive' } } },
      ],
    });
  }

  if (query.status !== undefined) {
    if (typeof query.status !== 'string' || !API_STATUSES.includes(query.status as ApiStatus)) {
      return { ok: false, error: `status must be one of: ${API_STATUSES.join(', ')}` };
    }
    and.push({ status: API_TO_STATUS[query.status as ApiStatus] });
  }

  if (query.priority !== undefined) {
    if (typeof query.priority !== 'string' || !PRIORITIES.includes(query.priority as Priority)) {
      return { ok: false, error: `priority must be one of: ${PRIORITIES.join(', ')}` };
    }
    and.push({ priorityCode: query.priority as Priority });
  }

  if (query.category !== undefined) {
    if (typeof query.category !== 'string' || !CATEGORIES.includes(query.category as Category)) {
      return { ok: false, error: `category must be one of: ${CATEGORIES.join(', ')}` };
    }
    and.push({ category: query.category as Category });
  }

  if (typeof query.assignee_id === 'string' && query.assignee_id) {
    and.push({ assigneeId: query.assignee_id });
  }

  return { ok: true, value: { AND: and } };
}

/**
 * Whether a request asked for breaching tickets only.
 *
 * This cannot be a WHERE clause. "Breached" is not stored: it is derived from the clock in
 * `computeSla`, which accounts for the pause while a ticket waits on the customer and for
 * the reopen that restarts the clock. Restating that arithmetic in SQL would put the
 * definition of "breaching" in two places, and the queue, the alerts page and the
 * dashboard's count would eventually disagree about which tickets are in trouble.
 *
 * So the filter is applied to the rows after they are read, exactly as the alerts list and
 * the dashboard already do via findInProgressTickets. The cost is that a breaching query
 * reads its whole scoped set before paging it. At this queue's size that is cheap; if it
 * ever stops being cheap, the fix is to store a `breach_at` timestamp maintained from this
 * same function and index it, not to duplicate the clock in a query.
 */
export function wantsBreachingOnly(query: TicketQueryInput): boolean {
  return query.breaching === 'true';
}

/**
 * `priority` sorts by `priorities.sort_order` through the relation, not the enum value —
 * alphabetically that would read high, low, normal, urgent, which is meaningless. Each
 * field has a default direction that reads naturally; `dir` overrides it.
 */
export function resolveTicketSort(query: TicketQueryInput): Result<Prisma.TicketOrderByWithRelationInput> {
  const field = (query.sort as string | undefined) ?? 'created_at';
  if (!SORT_FIELDS.includes(field as SortField)) {
    return { ok: false, error: `sort must be one of: ${SORT_FIELDS.join(', ')}` };
  }

  if (query.dir !== undefined && query.dir !== 'asc' && query.dir !== 'desc') {
    return { ok: false, error: 'dir must be one of: asc, desc' };
  }
  const dir = (query.dir as 'asc' | 'desc' | undefined) ?? (field === 'priority' ? 'desc' : 'desc');

  switch (field as SortField) {
    case 'priority':
      return { ok: true, value: { priority: { sortOrder: dir } } };
    case 'updated_at':
      return { ok: true, value: { updatedAt: dir } };
    case 'created_at':
      return { ok: true, value: { createdAt: dir } };
  }
}

/** Clamped so a client can never demand an unbounded page. */
export function resolvePagination(query: { page?: unknown; page_size?: unknown }): {
  page: number;
  pageSize: number;
  skip: number;
} {
  const page = Math.max(1, Math.trunc(Number(query.page)) || 1);
  const requested = Math.trunc(Number(query.page_size)) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requested));

  return { page, pageSize, skip: (page - 1) * pageSize };
}
