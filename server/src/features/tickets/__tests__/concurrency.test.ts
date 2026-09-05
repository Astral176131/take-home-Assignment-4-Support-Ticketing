import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../../.env.test') });

import { app } from '../../../app.js';
import { purgeTicketEvents } from '../../../lib/purgeTicketEvents.js';

/**
 * Two requests arriving at once for the same ticket.
 *
 * Every route here reads the ticket, decides whether the change is legal, then writes — and
 * for a long time nothing tied those two statements together. Both requests read the same
 * state, both concluded they were allowed, and both wrote. What made that worth fixing
 * rather than tolerating is the audit trail: `ticket_events` is append-only by database
 * trigger, so a duplicated row cannot be cleaned up afterwards, and the pending clock is
 * a counter, so a double credit is permanent too.
 *
 * These tests fire the pair with Promise.all against a real database. They are inherently
 * racy — which is the point — so each asserts the invariant that must hold whichever
 * request wins, never a particular winner.
 */

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 3 });
const testPrisma = new PrismaClient({ adapter });
const request = supertest(app);

const PASSWORD = 'testpass123';
const SUPERVISOR_EMAIL = 'conc-test-sup@example.com';
const AGENT_A_EMAIL = 'conc-test-agent-a@example.com';
const AGENT_B_EMAIL = 'conc-test-agent-b@example.com';

let supervisorId: string;
let agentAId: string;
let agentBId: string;
let supervisorCookie: string;
let agentACookie: string;

async function upsertUser(email: string, name: string, role: 'agent' | 'supervisor') {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const user = await testPrisma.user.upsert({
    where: { email },
    update: { passwordHash, role, name },
    create: { email, name, role, passwordHash },
  });
  return user.id;
}

async function login(email: string): Promise<string> {
  const res = await request.post('/api/auth/login').send({ email, password: PASSWORD });
  const cookies = res.headers['set-cookie'];
  return Array.isArray(cookies) ? cookies[0] : (cookies as unknown as string);
}

function createTicket(overrides: Record<string, unknown> = {}) {
  return request
    .post('/api/tickets')
    .set('Cookie', agentACookie)
    .send({
      subject: 'Concurrent access',
      description: 'Two requests at once.',
      requester: { name: 'Race Requester', email: 'conc-test-req@example.com' },
      priority_code: 'normal',
      category: 'bug',
      assignee_id: agentAId,
      ...overrides,
    });
}

/** Statuses of a fired pair, sorted, so an assertion does not depend on who won. */
function codes(a: { status: number }, b: { status: number }): number[] {
  return [a.status, b.status].sort();
}

describe('Concurrent requests for the same ticket', () => {
  beforeAll(async () => {
    supervisorId = await upsertUser(SUPERVISOR_EMAIL, 'Conc Supervisor', 'supervisor');
    agentAId = await upsertUser(AGENT_A_EMAIL, 'Conc Agent A', 'agent');
    agentBId = await upsertUser(AGENT_B_EMAIL, 'Conc Agent B', 'agent');

    for (const p of [
      { code: 'normal' as const, targetResponseMinutes: 1440, sortOrder: 2 },
      { code: 'urgent' as const, targetResponseMinutes: 60, sortOrder: 4 },
    ]) {
      await testPrisma.priorityConfig.upsert({ where: { code: p.code }, update: {}, create: p });
    }

    supervisorCookie = await login(SUPERVISOR_EMAIL);
    agentACookie = await login(AGENT_A_EMAIL);
  });

  afterAll(async () => {
    const tickets = await testPrisma.ticket.findMany({
      where: { requester: { email: { startsWith: 'conc-test-' } } },
      select: { id: true },
    });
    const ids = tickets.map((t) => t.id);

    await purgeTicketEvents(testPrisma, { ticketId: { in: ids } });
    await testPrisma.ticketCollaborator.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.reply.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.ticket.deleteMany({ where: { id: { in: ids } } });
    await testPrisma.requester.deleteMany({ where: { email: { startsWith: 'conc-test-' } } });
    await testPrisma.user.deleteMany({ where: { email: { startsWith: 'conc-test-' } } });
    await testPrisma.$disconnect();
  });

  it('applies the same status change once, not twice', async () => {
    const { body } = await createTicket();

    const [a, b] = await Promise.all([
      request.post(`/api/tickets/${body.id}/status`).set('Cookie', agentACookie).send({ status: 'open' }),
      request.post(`/api/tickets/${body.id}/status`).set('Cookie', agentACookie).send({ status: 'open' }),
    ]);

    expect(codes(a, b)).toEqual([200, 409]);

    const events = await testPrisma.ticketEvent.count({
      where: { ticketId: body.id, eventType: 'status_change' },
    });
    expect(events).toBe(1);
  });

  it('lets only one of two conflicting transitions through', async () => {
    const { body } = await createTicket();
    await request.post(`/api/tickets/${body.id}/status`).set('Cookie', agentACookie).send({ status: 'open' });

    const [a, b] = await Promise.all([
      request.post(`/api/tickets/${body.id}/status`).set('Cookie', agentACookie).send({ status: 'pending' }),
      request.post(`/api/tickets/${body.id}/status`).set('Cookie', agentACookie).send({ status: 'resolved' }),
    ]);

    expect(codes(a, b)).toEqual([200, 409]);

    const after = await testPrisma.ticket.findUniqueOrThrow({ where: { id: body.id } });

    // Whichever won, the ticket must look like exactly one of the two moves happened.
    // Both applying left a resolved ticket still carrying pending_since — a state the
    // state machine cannot otherwise produce, and one that later mis-credits paused time.
    if (after.status === 'pending') {
      expect(after.pendingSince).not.toBeNull();
      expect(after.resolvedAt).toBeNull();
    } else {
      expect(after.status).toBe('resolved');
      expect(after.pendingSince).toBeNull();
      expect(after.resolvedAt).not.toBeNull();
    }

    const events = await testPrisma.ticketEvent.count({
      where: { ticketId: body.id, eventType: 'status_change' },
    });
    // One for new -> open, one for whichever of the pair won.
    expect(events).toBe(2);
  });

  it('credits pending time once when a customer reply races a manual resume', async () => {
    const { body } = await createTicket();
    await request.post(`/api/tickets/${body.id}/status`).set('Cookie', agentACookie).send({ status: 'open' });
    await request.post(`/api/tickets/${body.id}/status`).set('Cookie', agentACookie).send({ status: 'pending' });

    // Backdate the pause so the credit is a large, unmistakable number.
    await testPrisma.ticket.update({
      where: { id: body.id },
      data: { pendingSince: new Date(Date.now() - 60 * 60_000) },
    });

    const [reply, resume] = await Promise.all([
      request
        .post(`/api/tickets/${body.id}/replies`)
        .set('Cookie', agentACookie)
        .send({ body: 'The customer wrote back', author_type: 'customer' }),
      request.post(`/api/tickets/${body.id}/status`).set('Cookie', agentACookie).send({ status: 'open' }),
    ]);

    // The reply is valid regardless of who resumed the ticket, so it always succeeds.
    expect(reply.status).toBe(201);
    expect([200, 409]).toContain(resume.status);

    const after = await testPrisma.ticket.findUniqueOrThrow({ where: { id: body.id } });
    expect(after.status).toBe('open');
    expect(after.pendingSince).toBeNull();

    // ~60, never ~120. Both paths read the same pending_since and each used to increment
    // by it, leaving the ticket with an hour of pause it never spent — which quietly
    // pushes a genuine breach back under its target.
    expect(after.pausedMinutes).toBeGreaterThanOrEqual(59);
    expect(after.pausedMinutes).toBeLessThanOrEqual(61);

    const resumeEvents = await testPrisma.ticketEvent.count({
      where: { ticketId: body.id, eventType: 'status_change', oldValue: 'pending', newValue: 'open' },
    });
    expect(resumeEvents).toBe(1);
  });

  it('archives once when archive is fired twice', async () => {
    const { body } = await createTicket();

    const [a, b] = await Promise.all([
      request.post(`/api/tickets/${body.id}/archive`).set('Cookie', agentACookie),
      request.post(`/api/tickets/${body.id}/archive`).set('Cookie', agentACookie),
    ]);

    expect(codes(a, b)).toEqual([200, 409]);
    expect(
      await testPrisma.ticketEvent.count({ where: { ticketId: body.id, eventType: 'archived' } })
    ).toBe(1);
  });

  it('acknowledges once when acknowledge is fired twice', async () => {
    const { body } = await createTicket({ priority_code: 'urgent' });
    await request.post(`/api/tickets/${body.id}/status`).set('Cookie', agentACookie).send({ status: 'open' });

    // Push it past the 60-minute urgent target so there is a live alert to acknowledge.
    await testPrisma.ticket.update({
      where: { id: body.id },
      data: { clockStartedAt: new Date(Date.now() - 120 * 60_000) },
    });

    const [a, b] = await Promise.all([
      request.post(`/api/tickets/${body.id}/alerts/ack`).set('Cookie', agentACookie),
      request.post(`/api/tickets/${body.id}/alerts/ack`).set('Cookie', agentACookie),
    ]);

    expect(codes(a, b)).toEqual([200, 409]);
    expect(
      await testPrisma.ticketEvent.count({ where: { ticketId: body.id, eventType: 'sla_ack' } })
    ).toBe(1);
  });

  it('adds a collaborator once, answering 409 rather than 500 to the loser', async () => {
    const { body } = await createTicket();

    const [a, b] = await Promise.all([
      request.post(`/api/tickets/${body.id}/collaborators`).set('Cookie', supervisorCookie).send({ agent_id: agentBId }),
      request.post(`/api/tickets/${body.id}/collaborators`).set('Cookie', supervisorCookie).send({ agent_id: agentBId }),
    ]);

    // The composite primary key always stopped the duplicate row; what it did not do was
    // give the loser the same 409 the sequential path returns.
    expect(codes(a, b)).toEqual([201, 409]);
    expect(
      await testPrisma.ticketCollaborator.count({ where: { ticketId: body.id, agentId: agentBId } })
    ).toBe(1);
  });

  it('records one reassignment when two are fired at once', async () => {
    const { body } = await createTicket();

    const [a, b] = await Promise.all([
      request.post(`/api/tickets/${body.id}/reassign`).set('Cookie', supervisorCookie).send({ assignee_id: agentBId }),
      request.post(`/api/tickets/${body.id}/reassign`).set('Cookie', supervisorCookie).send({ assignee_id: supervisorId }),
    ]);

    expect(codes(a, b)).toEqual([200, 409]);

    const events = await testPrisma.ticketEvent.findMany({
      where: { ticketId: body.id, eventType: 'reassignment' },
    });
    expect(events).toHaveLength(1);

    // The surviving history row must describe a handoff that actually happened: from the
    // agent who held it, to whoever holds it now.
    const after = await testPrisma.ticket.findUniqueOrThrow({ where: { id: body.id } });
    expect(events[0].oldValue).toBe(agentAId);
    expect(events[0].newValue).toBe(after.assigneeId);
  });

  it('closes once when bulk-close races a single close', async () => {
    const { body } = await createTicket();
    await request.post(`/api/tickets/${body.id}/status`).set('Cookie', agentACookie).send({ status: 'open' });
    await request.post(`/api/tickets/${body.id}/status`).set('Cookie', agentACookie).send({ status: 'resolved' });

    const [bulk, single] = await Promise.all([
      request.post('/api/tickets/bulk-close').set('Cookie', supervisorCookie).send({ ticket_ids: [body.id] }),
      request.post(`/api/tickets/${body.id}/status`).set('Cookie', supervisorCookie).send({ status: 'closed' }),
    ]);

    // The bulk endpoint reports per ticket and never fails the whole batch, so it stays
    // 200 either way — what changes is whether its one entry claims success.
    expect(bulk.status).toBe(200);
    const bulkSucceeded = bulk.body[0].success === true;
    const singleSucceeded = single.status === 200;
    expect(bulkSucceeded !== singleSucceeded).toBe(true);

    if (!bulkSucceeded) expect(bulk.body[0].reason).toBeTruthy();

    const closedEvents = await testPrisma.ticketEvent.count({
      where: { ticketId: body.id, eventType: 'status_change', newValue: 'closed' },
    });
    expect(closedEvents).toBe(1);
  });
});
