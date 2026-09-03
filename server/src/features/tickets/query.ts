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
  archived?: unknown;
  sort?: unknown;
  dir?: unknown;
}

type Actor = { userId: string; role: Role };

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Every filter, plus access scoping and the archived toggle, ANDed together. Scoping is
 * unconditional — it is not something a query parameter can widen — so it is folded in
 * here rather than left to each caller to remember.
 */
export function buildTicketWhere(actor: Actor, query: TicketQueryInput): Result<Prisma.TicketWhereInput> {
  const and: Prisma.TicketWhereInput[] = [];

  and.push({ archivedAt: query.archived === 'true' ? undefined : null });

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
