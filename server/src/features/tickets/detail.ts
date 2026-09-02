import { Prisma, Role } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { STATUS_TO_API, allowedTransitions } from './stateMachine.js';
import { computeSla } from './sla.js';

export { STATUS_TO_API };

export const detailInclude = {
  requester: true,
  priority: true,
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
 * Takes the viewer's role because `allowed_transitions` depends on it — an agent is not
 * offered "close". The server computes that list so the rules exist in exactly one place;
 * the endpoint still re-checks on the way in, whatever the client was told.
 *
 * Responses use snake_case to match the vocabulary the brief uses for its fields.
 */
export function toTicketDetail(ticket: TicketDetail, viewerRole: Role) {
  return {
    allowed_transitions: allowedTransitions({
      status: ticket.status,
      assigneeId: ticket.assigneeId,
      closedAt: ticket.closedAt,
      role: viewerRole,
    }),
    sla: computeSla({
      status: ticket.status,
      clockStartedAt: ticket.clockStartedAt,
      pausedMinutes: ticket.pausedMinutes,
      pendingSince: ticket.pendingSince,
      resolvedAt: ticket.resolvedAt,
      closedAt: ticket.closedAt,
      targetResponseMinutes: ticket.priority.targetResponseMinutes,
      ackCycle: ticket.ackCycle,
      ackedThroughCycle: ticket.ackedThroughCycle,
    }),
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
    clock_started_at: ticket.clockStartedAt,
    created_at: ticket.createdAt,
    updated_at: ticket.updatedAt,
  };
}

export function loadTicketDetail(ticketId: string) {
  return prisma.ticket.findUnique({ where: { id: ticketId }, include: detailInclude });
}
