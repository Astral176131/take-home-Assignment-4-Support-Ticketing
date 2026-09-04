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
const SUPERVISOR_EMAIL = 'collab-test-sup@example.com';
const SUPERVISOR_2_EMAIL = 'collab-test-sup2@example.com';
const AGENT_A_EMAIL = 'collab-test-agent-a@example.com';
const AGENT_B_EMAIL = 'collab-test-agent-b@example.com';
const REQUESTER_EMAIL = 'collab-test-customer@example.com';

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

/** A ticket assigned to agent A, created by the supervisor so A is not auto-attached. */
async function newTicket(): Promise<string> {
  const res = await request
    .post('/api/tickets')
    .set('Cookie', supervisorCookie)
    .send({
      subject: 'Collaborator test ticket',
      description: 'Needs a second pair of eyes.',
      requester: { name: 'Collab Customer', email: REQUESTER_EMAIL },
      priority_code: 'normal',
      category: 'bug',
      assignee_id: agentAId,
    });
  return res.body.id;
}

const addCollaborator = (ticketId: string, cookie: string, agentId: string) =>
  request.post(`/api/tickets/${ticketId}/collaborators`).set('Cookie', cookie).send({ agent_id: agentId });

const removeCollaborator = (ticketId: string, cookie: string, agentId: string) =>
  request.delete(`/api/tickets/${ticketId}/collaborators/${agentId}`).set('Cookie', cookie);

describe('Collaborators', () => {
  beforeAll(async () => {
    await upsertUser(SUPERVISOR_EMAIL, 'Collab Supervisor', 'supervisor');
    supervisor2Id = await upsertUser(SUPERVISOR_2_EMAIL, 'Second Supervisor', 'supervisor');
    agentAId = await upsertUser(AGENT_A_EMAIL, 'Collab Agent A', 'agent');
    agentBId = await upsertUser(AGENT_B_EMAIL, 'Collab Agent B', 'agent');

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
      where: { requester: { email: { startsWith: 'collab-test-' } } },
      select: { id: true },
    });
    const ids = tickets.map((t) => t.id);

    await purgeTicketEvents(testPrisma, { ticketId: { in: ids } });
    await testPrisma.reply.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.ticketCollaborator.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.ticket.deleteMany({ where: { id: { in: ids } } });
    await testPrisma.requester.deleteMany({ where: { email: { startsWith: 'collab-test-' } } });
    await testPrisma.user.deleteMany({ where: { email: { startsWith: 'collab-test-' } } });
    await testPrisma.$disconnect();
  });

  describe('adding', () => {
    it('lets a supervisor add an agent, recording it on the timeline', async () => {
      const id = await newTicket();
      const res = await addCollaborator(id, supervisorCookie, agentBId);

      expect(res.status).toBe(201);
      expect(res.body.collaborators.map((c: { id: string }) => c.id)).toContain(agentBId);

      const added = res.body.events.filter(
        (e: { event_type: string }) => e.event_type === 'collaborator_added'
      );
      expect(added).toHaveLength(1);
      expect(added[0].target.name).toBe('Collab Agent B');
    });

    it('grants the new collaborator access on their very next request', async () => {
      const id = await newTicket();

      expect((await request.get(`/api/tickets/${id}`).set('Cookie', agentBCookie)).status).toBe(403);
      await addCollaborator(id, supervisorCookie, agentBId);
      expect((await request.get(`/api/tickets/${id}`).set('Cookie', agentBCookie)).status).toBe(200);
    });

    it('refuses an agent adding anyone, including themselves', async () => {
      const id = await newTicket();

      // The assignee is the strongest case an agent has, and it is still refused.
      const byAssignee = await addCollaborator(id, agentACookie, agentBId);
      expect(byAssignee.status).toBe(403);

      const selfAdd = await addCollaborator(id, agentBCookie, agentBId);
      expect(selfAdd.status).toBe(403);

      const stillNoAccess = await request.get(`/api/tickets/${id}`).set('Cookie', agentBCookie);
      expect(stillNoAccess.status).toBe(403);
    });

    it('refuses adding a supervisor, an unknown user, or a missing agent_id', async () => {
      const id = await newTicket();

      const sup = await addCollaborator(id, supervisorCookie, supervisor2Id);
      expect(sup.status).toBe(400);
      expect(sup.body.error).toBe('Only agents can be added as collaborators');

      const unknown = await addCollaborator(
        id,
        supervisorCookie,
        '00000000-0000-0000-0000-000000000000'
      );
      expect(unknown.status).toBe(400);

      const missing = await request
        .post(`/api/tickets/${id}/collaborators`)
        .set('Cookie', supervisorCookie)
        .send({});
      expect(missing.status).toBe(400);
    });

    it('refuses adding the same agent twice', async () => {
      const id = await newTicket();
      await addCollaborator(id, supervisorCookie, agentBId);

      const again = await addCollaborator(id, supervisorCookie, agentBId);
      expect(again.status).toBe(409);
    });

    it('rejects an unauthenticated request', async () => {
      const id = await newTicket();
      const res = await request.post(`/api/tickets/${id}/collaborators`).send({ agent_id: agentBId });
      expect(res.status).toBe(401);
    });
  });

  describe('removing', () => {
    it('revokes access on the very next request', async () => {
      const id = await newTicket();
      await addCollaborator(id, supervisorCookie, agentBId);
      expect((await request.get(`/api/tickets/${id}`).set('Cookie', agentBCookie)).status).toBe(200);

      const removed = await removeCollaborator(id, supervisorCookie, agentBId);
      expect(removed.status).toBe(200);
      expect(removed.body.collaborators).toHaveLength(0);

      // No residual read-only state: the very next request is refused outright.
      expect((await request.get(`/api/tickets/${id}`).set('Cookie', agentBCookie)).status).toBe(403);
      expect(
        (await request.post(`/api/tickets/${id}/replies`).set('Cookie', agentBCookie).send({ body: 'Hi' }))
          .status
      ).toBe(403);
    });

    it('records the removal on the timeline', async () => {
      const id = await newTicket();
      await addCollaborator(id, supervisorCookie, agentBId);
      const res = await removeCollaborator(id, supervisorCookie, agentBId);

      const removed = res.body.events.filter(
        (e: { event_type: string }) => e.event_type === 'collaborator_removed'
      );
      expect(removed).toHaveLength(1);
      expect(removed[0].target.name).toBe('Collab Agent B');
    });

    it('refuses an agent removing anyone, including themselves', async () => {
      const id = await newTicket();
      await addCollaborator(id, supervisorCookie, agentBId);

      expect((await removeCollaborator(id, agentACookie, agentBId)).status).toBe(403);
      expect((await removeCollaborator(id, agentBCookie, agentBId)).status).toBe(403);

      // Still on the ticket after both attempts.
      expect((await request.get(`/api/tickets/${id}`).set('Cookie', agentBCookie)).status).toBe(200);
    });

    it('returns 404 for someone who is not a collaborator', async () => {
      const id = await newTicket();
      const res = await removeCollaborator(id, supervisorCookie, agentBId);
      expect(res.status).toBe(404);
    });
  });

  describe('what a collaborator may do', () => {
    it('can reply to and edit the ticket', async () => {
      const id = await newTicket();
      await addCollaborator(id, supervisorCookie, agentBId);

      const reply = await request
        .post(`/api/tickets/${id}/replies`)
        .set('Cookie', agentBCookie)
        .send({ body: 'Taking a look as well.' });
      expect(reply.status).toBe(201);

      const edit = await request
        .patch(`/api/tickets/${id}`)
        .set('Cookie', agentBCookie)
        .send({ priority_code: 'high' });
      expect(edit.status).toBe(200);
    });

    it('cannot close the ticket', async () => {
      const id = await newTicket();
      await addCollaborator(id, supervisorCookie, agentBId);

      await request.post(`/api/tickets/${id}/status`).set('Cookie', agentBCookie).send({ status: 'open' });
      await request
        .post(`/api/tickets/${id}/status`)
        .set('Cookie', agentBCookie)
        .send({ status: 'resolved' });

      const close = await request
        .post(`/api/tickets/${id}/status`)
        .set('Cookie', agentBCookie)
        .send({ status: 'closed' });

      expect(close.status).toBe(403);
      expect(close.body.error).toBe('Only a supervisor can close a ticket');
    });
  });

  describe('GET /api/tickets/mine', () => {
    it('returns tickets where the agent is assignee or collaborator, and no others', async () => {
      const assigned = await newTicket();
      const collaborating = await newTicket();
      const unrelated = await newTicket();

      await addCollaborator(collaborating, supervisorCookie, agentBId);

      const res = await request.get('/api/tickets/mine').set('Cookie', agentBCookie);
      const ids = res.body.items.map((t: { id: string }) => t.id);

      expect(res.status).toBe(200);
      expect(ids).toContain(collaborating);
      expect(ids).not.toContain(assigned);
      expect(ids).not.toContain(unrelated);

      const forAssignee = await request.get('/api/tickets/mine').set('Cookie', agentACookie);
      expect(forAssignee.body.items.map((t: { id: string }) => t.id)).toContain(assigned);
    });

    it('shows a supervisor only what they hold, not the whole queue', async () => {
      const someoneElses = await newTicket();

      const mine = await request.get('/api/tickets/mine').set('Cookie', supervisorCookie);
      const everything = await request.get('/api/tickets').set('Cookie', supervisorCookie);

      expect(mine.body.items.map((t: { id: string }) => t.id)).not.toContain(someoneElses);
      expect(everything.body.items.map((t: { id: string }) => t.id)).toContain(someoneElses);
    });

    it('rejects an unauthenticated request', async () => {
      expect((await request.get('/api/tickets/mine')).status).toBe(401);
    });
  });
});
