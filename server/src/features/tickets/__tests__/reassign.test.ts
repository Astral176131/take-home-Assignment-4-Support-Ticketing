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

// Capped small: this file's fixture writes are always awaited sequentially, and
// every test file opens its own pool — left uncapped, running many files together
// (as the full suite does) exhausts Postgres's connection limit.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 2 });
const testPrisma = new PrismaClient({ adapter });
const request = supertest(app);

const PASSWORD = 'testpass123';
const SUPERVISOR_EMAIL = 'reassign-test-sup@example.com';
const SUPERVISOR_2_EMAIL = 'reassign-test-sup2@example.com';
const AGENT_A_EMAIL = 'reassign-test-agent-a@example.com';
const AGENT_B_EMAIL = 'reassign-test-agent-b@example.com';
const REQUESTER_EMAIL = 'reassign-test-customer@example.com';

let supervisorId: string;
let supervisor2Id: string;
let agentAId: string;
let agentBId: string;

let supervisorCookie: string;
let agentACookie: string;
let agentBCookie: string;

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

/** A ticket assigned to agent A. Created by the supervisor, so nobody is auto-attached. */
async function newTicket(assign = true): Promise<string> {
  const res = await request
    .post('/api/tickets')
    .set('Cookie', supervisorCookie)
    .send({
      subject: 'Reassignment test ticket',
      description: 'Needs to change hands.',
      requester: { name: 'Reassign Customer', email: REQUESTER_EMAIL },
      priority_code: 'normal',
      category: 'bug',
      ...(assign ? { assignee_id: agentAId } : {}),
    });
  return res.body.id;
}

const reassign = (ticketId: string, cookie: string, assigneeId: string) =>
  request.post(`/api/tickets/${ticketId}/reassign`).set('Cookie', cookie).send({ assignee_id: assigneeId });

describe('Reassignment', () => {
  beforeAll(async () => {
    supervisorId = await upsertUser(SUPERVISOR_EMAIL, 'Reassign Supervisor', 'supervisor');
    supervisor2Id = await upsertUser(SUPERVISOR_2_EMAIL, 'Other Supervisor', 'supervisor');
    agentAId = await upsertUser(AGENT_A_EMAIL, 'Reassign Agent A', 'agent');
    agentBId = await upsertUser(AGENT_B_EMAIL, 'Reassign Agent B', 'agent');

    await testPrisma.priorityConfig.upsert({
      where: { code: 'normal' },
      update: {},
      create: { code: 'normal', targetResponseMinutes: 1440, sortOrder: 2 },
    });

    supervisorCookie = await login(SUPERVISOR_EMAIL);
    agentACookie = await login(AGENT_A_EMAIL);
    agentBCookie = await login(AGENT_B_EMAIL);
  });

  afterAll(async () => {
    const tickets = await testPrisma.ticket.findMany({
      where: { requester: { email: { startsWith: 'reassign-test-' } } },
      select: { id: true },
    });
    const ids = tickets.map((t) => t.id);

    await purgeTicketEvents(testPrisma, { ticketId: { in: ids } });
    await testPrisma.reply.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.ticketCollaborator.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.ticket.deleteMany({ where: { id: { in: ids } } });
    await testPrisma.requester.deleteMany({ where: { email: { startsWith: 'reassign-test-' } } });
    await testPrisma.user.deleteMany({ where: { email: { startsWith: 'reassign-test-' } } });
    await testPrisma.$disconnect();
  });

  describe('a supervisor reassigning', () => {
    it('moves the ticket and records both ends on the timeline', async () => {
      const id = await newTicket();
      const res = await reassign(id, supervisorCookie, agentBId);

      expect(res.status).toBe(200);
      expect(res.body.assignee.id).toBe(agentBId);

      const events = res.body.events.filter(
        (e: { event_type: string }) => e.event_type === 'reassignment'
      );
      expect(events).toHaveLength(1);
      expect(events[0].old_value).toBe(agentAId);
      expect(events[0].new_value).toBe(agentBId);
      // Resolved to a name, so the timeline reads properly rather than quoting a UUID.
      expect(events[0].target.name).toBe('Reassign Agent B');
    });

    it('can assign a ticket that had nobody on it', async () => {
      const id = await newTicket(false);

      const before = await request.get(`/api/tickets/${id}`).set('Cookie', supervisorCookie);
      expect(before.body.assignee).toBeNull();
      // A ticket with nobody on it cannot be opened, so no move is offered.
      expect(before.body.allowed_transitions).toEqual([]);

      const res = await reassign(id, supervisorCookie, agentAId);
      expect(res.status).toBe(200);
      // Giving it an owner is what makes opening it possible.
      expect(res.body.allowed_transitions).toEqual(['open']);
    });

    it('lets a supervisor take a ticket on as an escalation', async () => {
      const id = await newTicket();
      const res = await reassign(id, supervisorCookie, supervisorId);

      expect(res.status).toBe(200);
      expect(res.body.assignee.id).toBe(supervisorId);
    });

    it('refuses handing a ticket to the other supervisor', async () => {
      const id = await newTicket();
      const res = await reassign(id, supervisorCookie, supervisor2Id);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('only be assigned to an agent');
    });

    it('refuses an unknown user, a missing assignee_id, and the current holder', async () => {
      const id = await newTicket();

      expect((await reassign(id, supervisorCookie, '00000000-0000-0000-0000-000000000000')).status).toBe(400);
      expect(
        (await request.post(`/api/tickets/${id}/reassign`).set('Cookie', supervisorCookie).send({})).status
      ).toBe(400);

      const noop = await reassign(id, supervisorCookie, agentAId);
      expect(noop.status).toBe(409);
      expect(noop.body.error).toBe('That agent already holds this ticket');
    });

    it('refuses reassigning an archived ticket', async () => {
      const id = await newTicket();
      await request.post(`/api/tickets/${id}/archive`).set('Cookie', supervisorCookie);

      const res = await reassign(id, supervisorCookie, agentBId);
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('archived');
    });
  });

  describe('an agent attempting to reassign', () => {
    it('is refused in every case, including to themselves', async () => {
      const id = await newTicket();

      // Away from themselves to a colleague — the case Goal 1 names.
      expect((await reassign(id, agentACookie, agentBId)).status).toBe(403);
      // To themselves, the loophole the brief calls out by name.
      expect((await reassign(id, agentACookie, agentAId)).status).toBe(403);
      // Grabbing someone else's ticket.
      expect((await reassign(id, agentBCookie, agentBId)).status).toBe(403);

      const after = await request.get(`/api/tickets/${id}`).set('Cookie', supervisorCookie);
      expect(after.body.assignee.id).toBe(agentAId);
    });

    it('leaves no history row behind when refused', async () => {
      const id = await newTicket();
      await reassign(id, agentACookie, agentBId);

      const events = await testPrisma.ticketEvent.count({
        where: { ticketId: id, eventType: 'reassignment' },
      });
      expect(events).toBe(0);
    });

    it('rejects an unauthenticated request', async () => {
      const id = await newTicket();
      const res = await request.post(`/api/tickets/${id}/reassign`).send({ assignee_id: agentBId });
      expect(res.status).toBe(401);
    });
  });

  describe('what reassignment does to access', () => {
    it('revokes the previous assignee on their very next request', async () => {
      const id = await newTicket();
      expect((await request.get(`/api/tickets/${id}`).set('Cookie', agentACookie)).status).toBe(200);

      await reassign(id, supervisorCookie, agentBId);

      // A clean handoff: no collaborator row, no residual read-only access.
      expect((await request.get(`/api/tickets/${id}`).set('Cookie', agentACookie)).status).toBe(403);
      expect(
        (await request.post(`/api/tickets/${id}/replies`).set('Cookie', agentACookie).send({ body: 'Hi' }))
          .status
      ).toBe(403);

      expect((await request.get(`/api/tickets/${id}`).set('Cookie', agentBCookie)).status).toBe(200);
    });

    it('does not add the previous assignee as a collaborator', async () => {
      const id = await newTicket();
      const res = await reassign(id, supervisorCookie, agentBId);

      expect(res.body.collaborators).toHaveLength(0);
    });

    it('keeps access for a previous assignee who is separately a collaborator', async () => {
      const id = await newTicket();
      await request
        .post(`/api/tickets/${id}/collaborators`)
        .set('Cookie', supervisorCookie)
        .send({ agent_id: agentAId });

      await reassign(id, supervisorCookie, agentBId);

      // Attached explicitly, so the handoff does not remove them.
      expect((await request.get(`/api/tickets/${id}`).set('Cookie', agentACookie)).status).toBe(200);
    });

    it('drops the ticket out of the previous assignee\'s list and into the new one\'s', async () => {
      const id = await newTicket();

      const beforeA = await request.get('/api/tickets/mine').set('Cookie', agentACookie);
      expect(beforeA.body.items.map((t: { id: string }) => t.id)).toContain(id);

      await reassign(id, supervisorCookie, agentBId);

      const afterA = await request.get('/api/tickets/mine').set('Cookie', agentACookie);
      const afterB = await request.get('/api/tickets/mine').set('Cookie', agentBCookie);

      expect(afterA.body.items.map((t: { id: string }) => t.id)).not.toContain(id);
      expect(afterB.body.items.map((t: { id: string }) => t.id)).toContain(id);
    });
  });
});
