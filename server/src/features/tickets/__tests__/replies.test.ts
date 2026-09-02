import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../../.env.test') });

import { app } from '../../../app.js';
import { pauseCreditMinutes } from '../clock.js';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const testPrisma = new PrismaClient({ adapter });
const request = supertest(app);

const PASSWORD = 'testpass123';
const SUPERVISOR_EMAIL = 'replies-test-sup@example.com';
const AGENT_A_EMAIL = 'replies-test-agent-a@example.com';
const AGENT_B_EMAIL = 'replies-test-agent-b@example.com';
const REQUESTER_EMAIL = 'replies-test-customer@example.com';

let agentAId: string;
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

/** A fresh ticket assigned to agent A, so each test starts from a known state. */
async function newTicket(): Promise<string> {
  const res = await request
    .post('/api/tickets')
    .set('Cookie', agentACookie)
    .send({
      subject: 'Cannot log in',
      description: 'Password reset loops back to the login page.',
      requester: { name: 'Reply Customer', email: REQUESTER_EMAIL },
      priority_code: 'normal',
      category: 'bug',
      assignee_id: agentAId,
    });
  return res.body.id;
}

function reply(ticketId: string, cookie: string, payload: Record<string, unknown>) {
  return request.post(`/api/tickets/${ticketId}/replies`).set('Cookie', cookie).send(payload);
}

/** Park a ticket in `pending` as of N minutes ago, without needing the 2.3 endpoint. */
function parkInPending(ticketId: string, minutesAgo: number) {
  return testPrisma.ticket.update({
    where: { id: ticketId },
    data: {
      status: 'pending',
      pendingSince: new Date(Date.now() - minutesAgo * 60_000),
    },
  });
}

describe('Replies', () => {
  beforeAll(async () => {
    await upsertUser(SUPERVISOR_EMAIL, 'Replies Supervisor', 'supervisor');
    agentAId = await upsertUser(AGENT_A_EMAIL, 'Replies Agent A', 'agent');
    await upsertUser(AGENT_B_EMAIL, 'Replies Agent B', 'agent');

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
      where: { requester: { email: { startsWith: 'replies-test-' } } },
      select: { id: true },
    });
    const ids = tickets.map((t) => t.id);

    await testPrisma.ticketEvent.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.reply.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.ticketCollaborator.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.ticket.deleteMany({ where: { id: { in: ids } } });
    await testPrisma.requester.deleteMany({ where: { email: { startsWith: 'replies-test-' } } });
    await testPrisma.user.deleteMany({ where: { email: { startsWith: 'replies-test-' } } });
    await testPrisma.$disconnect();
  });

  describe('pauseCreditMinutes', () => {
    it('credits whole minutes, and never credits a negative interval', () => {
      const now = new Date('2026-09-02T12:00:00Z');

      expect(pauseCreditMinutes(new Date('2026-09-02T11:30:00Z'), now)).toBe(30);
      // Rounds to the nearest minute in both directions: 40s up to 1, 20s down to 0.
      expect(pauseCreditMinutes(new Date('2026-09-02T11:59:20Z'), now)).toBe(1);
      expect(pauseCreditMinutes(new Date('2026-09-02T11:59:40Z'), now)).toBe(0);
      // A pending_since in the future credits nothing rather than stealing paused time.
      expect(pauseCreditMinutes(new Date('2026-09-02T12:30:00Z'), now)).toBe(0);
    });
  });

  describe('POST /api/tickets/:id/replies', () => {
    it('adds a public agent reply and records it on the timeline', async () => {
      const id = await newTicket();
      const res = await reply(id, agentACookie, { body: 'Looking into this now.' });

      expect(res.status).toBe(201);
      expect(res.body.replies).toHaveLength(1);
      expect(res.body.replies[0].body).toBe('Looking into this now.');
      expect(res.body.replies[0].author_type).toBe('agent');
      expect(res.body.replies[0].is_internal).toBe(false);
      expect(res.body.replies[0].author.name).toBe('Replies Agent A');
      expect(res.body.events.map((e: { event_type: string }) => e.event_type)).toContain('reply_added');
    });

    it('flags an internal note distinctly from a customer-visible reply', async () => {
      const id = await newTicket();
      await reply(id, agentACookie, { body: 'Public answer.' });
      const res = await reply(id, agentACookie, { body: 'Suspect the auth cache.', is_internal: true });

      const [pub, internal] = res.body.replies;
      expect(pub.is_internal).toBe(false);
      expect(internal.is_internal).toBe(true);
    });

    it("attributes a customer's email to the agent who logged it", async () => {
      const id = await newTicket();
      const res = await reply(id, agentACookie, {
        body: 'Still broken this morning.',
        author_type: 'customer',
      });

      expect(res.body.replies[0].author_type).toBe('customer');
      expect(res.body.replies[0].author.id).toBe(agentAId);
    });

    it('returns replies oldest first', async () => {
      const id = await newTicket();
      await reply(id, agentACookie, { body: 'First' });
      await reply(id, agentACookie, { body: 'Second' });
      const res = await reply(id, agentACookie, { body: 'Third' });

      expect(res.body.replies.map((r: { body: string }) => r.body)).toEqual(['First', 'Second', 'Third']);
    });

    it('lets a supervisor reply to a ticket they are not attached to', async () => {
      const id = await newTicket();
      const res = await reply(id, supervisorCookie, { body: 'Escalating this.' });
      expect(res.status).toBe(201);
    });

    it('refuses an empty body, an unknown author_type, and a customer internal note', async () => {
      const id = await newTicket();

      expect((await reply(id, agentACookie, { body: '   ' })).status).toBe(400);
      expect((await reply(id, agentACookie, { body: 'x', author_type: 'robot' })).status).toBe(400);

      const contradiction = await reply(id, agentACookie, {
        body: 'x',
        author_type: 'customer',
        is_internal: true,
      });
      expect(contradiction.status).toBe(400);
      expect(contradiction.body.error).toContain('internal note');
    });

    it('returns 403 to an unrelated agent and 401 without a cookie', async () => {
      const id = await newTicket();

      expect((await reply(id, agentBCookie, { body: 'Butting in.' })).status).toBe(403);
      expect((await request.post(`/api/tickets/${id}/replies`).send({ body: 'x' })).status).toBe(401);
    });

    it('refuses a reply on an archived ticket', async () => {
      const id = await newTicket();
      await request.post(`/api/tickets/${id}/archive`).set('Cookie', agentACookie);

      const res = await reply(id, agentACookie, { body: 'Late follow-up.' });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('archived');
    });
  });

  describe('the pending clock', () => {
    it('reopens a pending ticket when the customer replies, crediting the paused time', async () => {
      const id = await newTicket();
      await parkInPending(id, 30);

      const res = await reply(id, agentACookie, {
        body: 'Here are the logs you asked for.',
        author_type: 'customer',
      });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('open');
      expect(res.body.pending_since).toBeNull();
      expect(res.body.paused_minutes).toBe(30);

      const statusEvents = res.body.events.filter(
        (e: { event_type: string }) => e.event_type === 'status_change'
      );
      expect(statusEvents).toHaveLength(1);
      expect(statusEvents[0].old_value).toBe('pending');
      expect(statusEvents[0].new_value).toBe('open');
    });

    it('accumulates across more than one pending interval', async () => {
      const id = await newTicket();

      await parkInPending(id, 30);
      await reply(id, agentACookie, { body: 'First answer.', author_type: 'customer' });

      await parkInPending(id, 15);
      const res = await reply(id, agentACookie, { body: 'Second answer.', author_type: 'customer' });

      expect(res.body.paused_minutes).toBe(45);
    });

    it('does not reopen when the agent is the one replying', async () => {
      const id = await newTicket();
      await parkInPending(id, 30);

      const res = await reply(id, agentACookie, { body: 'Chasing this up with you.' });

      expect(res.body.status).toBe('pending');
      expect(res.body.paused_minutes).toBe(0);
      expect(res.body.pending_since).not.toBeNull();
    });

    it('leaves a closed ticket closed even when the customer replies', async () => {
      const id = await newTicket();
      await testPrisma.ticket.update({ where: { id }, data: { status: 'closed', closedAt: new Date() } });

      const res = await reply(id, agentACookie, {
        body: 'This happened again.',
        author_type: 'customer',
      });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('closed');
    });

    it('does not change an open ticket', async () => {
      const id = await newTicket();
      await testPrisma.ticket.update({ where: { id }, data: { status: 'open' } });

      const res = await reply(id, agentACookie, { body: 'Any update?', author_type: 'customer' });

      expect(res.body.status).toBe('open');
      expect(res.body.paused_minutes).toBe(0);
    });
  });
});
