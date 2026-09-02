import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../../.env.test') });

import { app } from '../../../app.js';
import { REOPEN_WINDOW_DAYS } from '../../../lib/config.js';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const testPrisma = new PrismaClient({ adapter });
const request = supertest(app);

const PASSWORD = 'testpass123';
const SUPERVISOR_EMAIL = 'status-test-sup@example.com';
const AGENT_A_EMAIL = 'status-test-agent-a@example.com';
const AGENT_B_EMAIL = 'status-test-agent-b@example.com';
const REQUESTER_EMAIL = 'status-test-customer@example.com';

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

async function newTicket(assign = true): Promise<string> {
  const res = await request
    .post('/api/tickets')
    .set('Cookie', agentACookie)
    .send({
      subject: 'Status test ticket',
      description: 'Something to move through the lifecycle.',
      requester: { name: 'Status Customer', email: REQUESTER_EMAIL },
      priority_code: 'normal',
      category: 'bug',
      ...(assign ? { assignee_id: agentAId } : {}),
    });
  return res.body.id;
}

function setStatus(ticketId: string, cookie: string, status: string) {
  return request.post(`/api/tickets/${ticketId}/status`).set('Cookie', cookie).send({ status });
}

/** Walk a ticket to a given status using the real endpoint, so state stays consistent. */
async function moveTo(ticketId: string, status: 'open' | 'resolved' | 'closed') {
  await setStatus(ticketId, agentACookie, 'open');
  if (status === 'open') return;
  await setStatus(ticketId, agentACookie, 'resolved');
  if (status === 'resolved') return;
  await setStatus(ticketId, supervisorCookie, 'closed');
}

describe('Ticket status transitions', () => {
  beforeAll(async () => {
    await upsertUser(SUPERVISOR_EMAIL, 'Status Supervisor', 'supervisor');
    agentAId = await upsertUser(AGENT_A_EMAIL, 'Status Agent A', 'agent');
    await upsertUser(AGENT_B_EMAIL, 'Status Agent B', 'agent');

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
      where: { requester: { email: { startsWith: 'status-test-' } } },
      select: { id: true },
    });
    const ids = tickets.map((t) => t.id);

    await testPrisma.ticketEvent.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.reply.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.ticketCollaborator.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.ticket.deleteMany({ where: { id: { in: ids } } });
    await testPrisma.requester.deleteMany({ where: { email: { startsWith: 'status-test-' } } });
    await testPrisma.user.deleteMany({ where: { email: { startsWith: 'status-test-' } } });
    await testPrisma.$disconnect();
  });

  describe('the happy path', () => {
    it('walks new → open → pending → open → resolved → closed', async () => {
      const id = await newTicket();

      const opened = await setStatus(id, agentACookie, 'open');
      expect(opened.status).toBe(200);
      expect(opened.body.status).toBe('open');

      const pending = await setStatus(id, agentACookie, 'pending');
      expect(pending.body.status).toBe('pending');
      expect(pending.body.pending_since).not.toBeNull();

      const backOpen = await setStatus(id, agentACookie, 'open');
      expect(backOpen.body.status).toBe('open');
      expect(backOpen.body.pending_since).toBeNull();

      const resolved = await setStatus(id, agentACookie, 'resolved');
      expect(resolved.body.status).toBe('resolved');
      expect(resolved.body.resolved_at).not.toBeNull();

      const closed = await setStatus(id, supervisorCookie, 'closed');
      expect(closed.body.status).toBe('closed');
      expect(closed.body.closed_at).not.toBeNull();

      // Six moves, six history rows, each naming where it came from and went to.
      const changes = closed.body.events.filter(
        (e: { event_type: string }) => e.event_type === 'status_change'
      );
      expect(changes.map((e: { old_value: string; new_value: string }) => `${e.old_value}->${e.new_value}`)).toEqual([
        'new->open',
        'open->pending',
        'pending->open',
        'open->resolved',
        'resolved->closed',
      ]);
    });

    it('credits paused time when leaving pending by hand', async () => {
      const id = await newTicket();
      await setStatus(id, agentACookie, 'open');
      await setStatus(id, agentACookie, 'pending');

      await testPrisma.ticket.update({
        where: { id },
        data: { pendingSince: new Date(Date.now() - 45 * 60_000) },
      });

      const res = await setStatus(id, agentACookie, 'open');
      expect(res.body.paused_minutes).toBe(45);
      expect(res.body.pending_since).toBeNull();
    });
  });

  describe('guards', () => {
    it('refuses to open a ticket with no assignee', async () => {
      const id = await newTicket(false);
      const res = await setStatus(id, agentACookie, 'open');

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('Cannot open a ticket with no assignee');
    });

    it('refuses illegal moves with 409 and an explanation', async () => {
      const id = await newTicket();

      const newToResolved = await setStatus(id, agentACookie, 'resolved');
      expect(newToResolved.status).toBe(409);
      expect(newToResolved.body.error).toBe('A ticket cannot move from new to resolved');

      await setStatus(id, agentACookie, 'open');
      const openToClosed = await setStatus(id, supervisorCookie, 'closed');
      expect(openToClosed.status).toBe(409);

      const alreadyOpen = await setStatus(id, agentACookie, 'open');
      expect(alreadyOpen.status).toBe(409);
      expect(alreadyOpen.body.error).toBe('This ticket is already open');
    });

    it('separates an unknown status value from an illegal move', async () => {
      const id = await newTicket();
      const res = await setStatus(id, agentACookie, 'frozen');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('status must be one of');
    });

    it('lets only a supervisor close, even the assignee', async () => {
      const id = await newTicket();
      await moveTo(id, 'resolved');

      const byAgent = await setStatus(id, agentACookie, 'closed');
      expect(byAgent.status).toBe(403);
      expect(byAgent.body.error).toBe('Only a supervisor can close a ticket');

      const bySupervisor = await setStatus(id, supervisorCookie, 'closed');
      expect(bySupervisor.status).toBe(200);
    });

    it('returns 403 to an unrelated agent and 401 without a cookie', async () => {
      const id = await newTicket();

      expect((await setStatus(id, agentBCookie, 'open')).status).toBe(403);
      expect(
        (await request.post(`/api/tickets/${id}/status`).send({ status: 'open' })).status
      ).toBe(401);
    });

    it('refuses a status change on an archived ticket', async () => {
      const id = await newTicket();
      await request.post(`/api/tickets/${id}/archive`).set('Cookie', agentACookie);

      const res = await setStatus(id, agentACookie, 'open');
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('archived');
    });

    it('writes no history row when a transition is refused', async () => {
      const id = await newTicket();
      await setStatus(id, agentACookie, 'resolved'); // illegal from new

      const changes = await testPrisma.ticketEvent.count({
        where: { ticketId: id, eventType: 'status_change' },
      });
      expect(changes).toBe(0);
    });
  });

  describe('the reopen window', () => {
    /** Close a ticket and backdate the closure by the given number of days. */
    async function closedDaysAgo(days: number): Promise<string> {
      const id = await newTicket();
      await moveTo(id, 'closed');
      await testPrisma.ticket.update({
        where: { id },
        data: { closedAt: new Date(Date.now() - days * 24 * 60 * 60_000) },
      });
      return id;
    }

    it('reopens just inside the window and increments ack_cycle', async () => {
      const id = await closedDaysAgo(REOPEN_WINDOW_DAYS - 0.05); // ~6 days 23 hours

      const before = await testPrisma.ticket.findUnique({ where: { id } });
      expect(before!.ackCycle).toBe(0);

      const res = await setStatus(id, agentACookie, 'open');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('open');
      expect(res.body.ack_cycle).toBe(1);
    });

    it('refuses a reopen just outside the window', async () => {
      const id = await closedDaysAgo(REOPEN_WINDOW_DAYS + 0.001); // ~7 days and change

      const res = await setStatus(id, agentACookie, 'open');
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('The reopen window has expired');
    });

    it('restarts the SLA clock on reopen, dropping inherited paused time', async () => {
      const id = await closedDaysAgo(1);
      await testPrisma.ticket.update({ where: { id }, data: { pausedMinutes: 120 } });

      const before = await testPrisma.ticket.findUnique({ where: { id } });
      const res = await setStatus(id, agentACookie, 'open');

      expect(res.body.paused_minutes).toBe(0);
      expect(new Date(res.body.clock_started_at).getTime()).toBeGreaterThan(
        before!.clockStartedAt.getTime()
      );
      expect(res.body.sla.elapsed_minutes).toBe(0);
    });

    it('leaves ack_cycle alone on every other transition', async () => {
      const id = await newTicket();
      await setStatus(id, agentACookie, 'open');
      await setStatus(id, agentACookie, 'pending');
      await setStatus(id, agentACookie, 'open');
      await setStatus(id, agentACookie, 'resolved');
      const reopened = await setStatus(id, agentACookie, 'open'); // resolved → open

      expect(reopened.body.ack_cycle).toBe(0);
    });
  });

  describe('allowed_transitions in the ticket payload', () => {
    it('offers the assignee everything except closing', async () => {
      const id = await newTicket();

      const asNew = await request.get(`/api/tickets/${id}`).set('Cookie', agentACookie);
      expect(asNew.body.allowed_transitions).toEqual(['open']);

      await moveTo(id, 'resolved');

      const agentView = await request.get(`/api/tickets/${id}`).set('Cookie', agentACookie);
      const supervisorView = await request.get(`/api/tickets/${id}`).set('Cookie', supervisorCookie);

      expect(agentView.body.allowed_transitions).toEqual(['open']);
      expect(supervisorView.body.allowed_transitions).toEqual(['open', 'closed']);
    });

    it('offers nothing on an unassigned new ticket', async () => {
      const id = await newTicket(false);
      const res = await request.get(`/api/tickets/${id}`).set('Cookie', agentACookie);

      expect(res.body.allowed_transitions).toEqual([]);
    });
  });
});
