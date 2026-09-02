import { Prisma, TicketStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

/**
 * The schema stores the first state as `new_ticket` because `new` is awkward as an enum
 * member, but the brief's state machine calls it `new` — so the API speaks `new` and the
 * rename stays an internal detail.
 */
export const STATUS_TO_API: Record<TicketStatus, string> = {
  new_ticket: 'new',
  open: 'open',
  pending: 'pending',
  resolved: 'resolved',
  closed: 'closed',
};

export const detailInclude = {
  requester: true,
  assignee: { select: { id: true, name: true, email: true, role: true } },
  collaborators: {
    include: { agent: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: 'asc' },
  },
  replies: {
    orderBy: { createdAt: 'asc' },
    include: { author: { select: { id: true, name: true } } },
  },
  events: {
    orderBy: { createdAt: 'asc' },
    include: { actor: { select: { id: true, name: true } } },
  },
} satisfies Prisma.TicketInclude;

export type TicketDetail = Prisma.TicketGetPayload<{ include: typeof detailInclude }>;

/**
 * One ticket with everything needed to render it. Shared by every endpoint that returns
 * a ticket, so the shape can only change in one place.
 *
 * Responses use snake_case to match the vocabulary the brief uses for its fields.
 */
export function toTicketDetail(ticket: TicketDetail) {
  return {
    id: ticket.id,
    subject: ticket.subject,
    description: ticket.description,
    status: STATUS_TO_API[ticket.status],
    priority_code: ticket.priorityCode,
    category: ticket.category,
    requester: ticket.requester,
    assignee: ticket.assignee,
    collaborators: ticket.collaborators.map((c) => c.agent),
    replies: ticket.replies.map((r) => ({
      id: r.id,
      body: r.body,
      author: r.author,
      // `author_type` says whose words these are; `author` is always the user who
      // recorded them, since a customer reply is transcribed by an agent.
      author_type: r.authorType,
      is_internal: r.isInternal,
      created_at: r.createdAt,
    })),
    events: ticket.events.map((e) => ({
      id: e.id,
      event_type: e.eventType,
      actor: e.actor,
      old_value: e.oldValue,
      new_value: e.newValue,
      created_at: e.createdAt,
    })),
    pending_since: ticket.pendingSince,
    paused_minutes: ticket.pausedMinutes,
    resolved_at: ticket.resolvedAt,
    closed_at: ticket.closedAt,
    archived_at: ticket.archivedAt,
    ack_cycle: ticket.ackCycle,
    acked_through_cycle: ticket.ackedThroughCycle,
    created_at: ticket.createdAt,
    updated_at: ticket.updatedAt,
    // `allowed_transitions` and the SLA figures are added in 2.3, once the state
    // machine and clock exist.
  };
}

export function loadTicketDetail(ticketId: string) {
  return prisma.ticket.findUnique({ where: { id: ticketId }, include: detailInclude });
}
