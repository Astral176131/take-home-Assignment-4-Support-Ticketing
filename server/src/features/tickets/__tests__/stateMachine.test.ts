import { describe, it, expect } from 'vitest';
import { Role, TicketStatus } from '@prisma/client';
import {
  ApiStatus,
  API_STATUSES,
  allowedTransitions,
  checkTransition,
  reopenDeadline,
} from '../stateMachine.js';
import { computeSla } from '../sla.js';

const ALL_DB_STATUSES: TicketStatus[] = ['new_ticket', 'open', 'pending', 'resolved', 'closed'];

/** Every move the brief permits, written out independently of the module's own table. */
const LEGAL: Array<[TicketStatus, ApiStatus]> = [
  ['new_ticket', 'open'],
  ['open', 'pending'],
  ['open', 'resolved'],
  ['pending', 'open'],
  ['resolved', 'open'],
  ['resolved', 'closed'],
  ['closed', 'open'],
];

function ctx(overrides: Partial<Parameters<typeof checkTransition>[1]> = {}) {
  return {
    status: 'open' as TicketStatus,
    assigneeId: 'agent-1',
    closedAt: null,
    role: 'supervisor' as Role,
    ...overrides,
  };
}

describe('state machine', () => {
  it('allows every move in the brief, for a supervisor on an assigned ticket', () => {
    for (const [from, to] of LEGAL) {
      const closedAt = from === 'closed' ? new Date() : null;
      expect(checkTransition(to, ctx({ status: from, closedAt })).ok, `${from} → ${to}`).toBe(true);
    }
  });

  it('rejects every move the brief does not list, with a specific reason', () => {
    for (const from of ALL_DB_STATUSES) {
      for (const to of API_STATUSES) {
        const isLegal = LEGAL.some(([f, t]) => f === from && t === to);
        if (isLegal) continue;

        const result = checkTransition(to, ctx({ status: from, closedAt: new Date() }));
        expect(result.ok, `${from} → ${to} should be refused`).toBe(false);
        if (!result.ok) {
          expect(result.httpStatus).toBe(409);
          expect(result.message.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('says so plainly when the ticket is already in the requested state', () => {
    const result = checkTransition('open', ctx({ status: 'open' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe('This ticket is already open');
  });

  it('refuses to open a ticket that has no assignee', () => {
    const result = checkTransition('open', ctx({ status: 'new_ticket', assigneeId: null }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.httpStatus).toBe(409);
      expect(result.message).toBe('Cannot open a ticket with no assignee');
    }
  });

  it('lets only a supervisor close a ticket', () => {
    const asSupervisor = checkTransition('closed', ctx({ status: 'resolved', role: 'supervisor' }));
    const asAgent = checkTransition('closed', ctx({ status: 'resolved', role: 'agent' }));

    expect(asSupervisor.ok).toBe(true);
    expect(asAgent.ok).toBe(false);
    if (!asAgent.ok) {
      expect(asAgent.httpStatus).toBe(403);
      expect(asAgent.message).toBe('Only a supervisor can close a ticket');
    }
  });

  describe('the reopen window', () => {
    const closedAt = new Date('2026-09-01T12:00:00Z');
    const deadline = reopenDeadline(closedAt);

    it('allows a reopen just inside seven days', () => {
      const justInside = new Date(deadline.getTime() - 60_000);
      const result = checkTransition('open', ctx({ status: 'closed', closedAt, now: justInside }));
      expect(result.ok).toBe(true);
    });

    it('refuses a reopen just outside seven days', () => {
      const justOutside = new Date(deadline.getTime() + 60_000);
      const result = checkTransition('open', ctx({ status: 'closed', closedAt, now: justOutside }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.httpStatus).toBe(409);
        expect(result.message).toBe('The reopen window has expired');
      }
    });
  });

  describe('allowedTransitions', () => {
    it('offers an agent everything except closing', () => {
      expect(allowedTransitions(ctx({ status: 'new_ticket', role: 'agent' }))).toEqual(['open']);
      expect(allowedTransitions(ctx({ status: 'open', role: 'agent' }))).toEqual(['pending', 'resolved']);
      expect(allowedTransitions(ctx({ status: 'pending', role: 'agent' }))).toEqual(['open']);
      expect(allowedTransitions(ctx({ status: 'resolved', role: 'agent' }))).toEqual(['open']);
    });

    it('offers a supervisor the close as well', () => {
      expect(allowedTransitions(ctx({ status: 'resolved', role: 'supervisor' }))).toEqual([
        'open',
        'closed',
      ]);
    });

    it('offers nothing on an unassigned new ticket', () => {
      expect(allowedTransitions(ctx({ status: 'new_ticket', assigneeId: null }))).toEqual([]);
    });

    it('offers nothing once the reopen window has passed', () => {
      const closedAt = new Date('2026-09-01T12:00:00Z');
      const inside = new Date(reopenDeadline(closedAt).getTime() - 60_000);
      const outside = new Date(reopenDeadline(closedAt).getTime() + 60_000);

      expect(allowedTransitions(ctx({ status: 'closed', closedAt, now: inside }))).toEqual(['open']);
      expect(allowedTransitions(ctx({ status: 'closed', closedAt, now: outside }))).toEqual([]);
    });
  });
});

describe('sla', () => {
  const base = {
    status: 'open' as TicketStatus,
    clockStartedAt: new Date('2026-09-02T10:00:00Z'),
    pausedMinutes: 0,
    pendingSince: null,
    resolvedAt: null,
    closedAt: null,
    targetResponseMinutes: 60,
    ackCycle: 0,
    ackedThroughCycle: null,
  };
  const now = new Date('2026-09-02T11:00:00Z'); // one hour after the clock started

  it('counts elapsed time from the clock start, minus paused minutes', () => {
    expect(computeSla(base, now).elapsed_minutes).toBe(60);
    expect(computeSla({ ...base, pausedMinutes: 25 }, now).elapsed_minutes).toBe(35);
  });

  it('breaches only once past the target, not on reaching it', () => {
    expect(computeSla(base, now).breached).toBe(false);
    expect(computeSla({ ...base, targetResponseMinutes: 59 }, now).breached).toBe(true);
  });

  it('warns inside the last fifteen minutes', () => {
    expect(computeSla({ ...base, targetResponseMinutes: 70 }, now).warning).toBe(true);
    expect(computeSla({ ...base, targetResponseMinutes: 90 }, now).warning).toBe(false);
  });

  it('freezes the clock while the ticket waits on the customer', () => {
    const pending = {
      ...base,
      status: 'pending' as TicketStatus,
      pendingSince: new Date('2026-09-02T10:20:00Z'),
    };
    // Twenty minutes had elapsed when it went pending; the clock has not moved since.
    expect(computeSla(pending, now).elapsed_minutes).toBe(20);
  });

  it('stops the clock for good once resolved or closed', () => {
    const resolved = {
      ...base,
      status: 'resolved' as TicketStatus,
      resolvedAt: new Date('2026-09-02T10:30:00Z'),
    };
    const closed = {
      ...base,
      status: 'closed' as TicketStatus,
      resolvedAt: new Date('2026-09-02T10:30:00Z'),
      closedAt: new Date('2026-09-02T10:45:00Z'),
    };

    expect(computeSla(resolved, now).elapsed_minutes).toBe(30);
    expect(computeSla(closed, now).elapsed_minutes).toBe(45);

    // Still 30 minutes a week later — a finished ticket cannot drift into breach.
    const muchLater = new Date('2026-09-09T11:00:00Z');
    expect(computeSla(resolved, muchLater).elapsed_minutes).toBe(30);
    expect(computeSla(resolved, muchLater).breached).toBe(false);
  });

  describe('alert_active', () => {
    const breaching = { ...base, targetResponseMinutes: 30 };

    it('is on for an unacknowledged breach and off once acknowledged', () => {
      expect(computeSla(breaching, now).alert_active).toBe(true);
      expect(computeSla({ ...breaching, ackedThroughCycle: 0 }, now).alert_active).toBe(false);
    });

    it('comes back when a reopen starts a new cycle', () => {
      // Acknowledged in cycle 0, then the ticket was reopened, taking ack_cycle to 1.
      const reopened = { ...breaching, ackCycle: 1, ackedThroughCycle: 0 };
      expect(computeSla(reopened, now).alert_active).toBe(true);
    });

    it('is off for a ticket that is comfortably inside its target', () => {
      expect(computeSla({ ...base, targetResponseMinutes: 600 }, now).alert_active).toBe(false);
    });
  });
});
