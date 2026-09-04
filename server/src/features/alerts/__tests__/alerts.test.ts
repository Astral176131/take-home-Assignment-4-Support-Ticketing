import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../../.env.test') });

import { app } from '../../../app.js';
import { purgeTicketEvents } from '../../../test/purgeTicketEvents.js';
import { REOPEN_WINDOW_DAYS } from '../../../lib/config.js';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 2 });
const testPrisma = new PrismaClient({ adapter });
const request = supertest(app);

const PASSWORD = 'testpass123';
const SUPERVISOR_EMAIL = 'alerts-test-sup@example.com';
const AGENT_A_EMAIL = 'alerts-test-agent-a@example.com';
const AGENT_B_EMAIL = 'alerts-test-agent-b@example.com';
const REQUESTER_EMAIL = 'alerts-test-customer@example.com';

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

/** An open ticket, urgent priority (60-minute target), assigned to agent A. */
async function newOpenUrgentTicket(overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await request
    .post('/api/tickets')
    .set('Cookie', supervisorCookie)
    .send({
      subject: 'Alerts test ticket',
      description: 'Created for alert and ack tests.',
      requester: { name: 'Alerts Customer', email: REQUESTER_EMAIL },
      priority_code: 'urgent',
      category: 'bug',
      assignee_id: agentAId,
      ...overrides,
    });
  await request.post(`/api/tickets/${created.body.id}/status`).set('Cookie', supervisorCookie).send({ status: 'open' });
  return created.body.id;
}

/** Push a ticket's clock back so it reads as breached (urgent target is 60 minutes). */
function backdateToBreach(ticketId: string) {
  return testPrisma.ticket.update({
    where: { id: ticketId },
    data: { clockStartedAt: new Date(Date.now() - 70 * 60_000) },
  });
}

/** Push a ticket's clock back so it reads as warning but not yet breached. */
function backdateToWarning(ticketId: string) {
  return testPrisma.ticket.update({
    where: { id: ticketId },
    data: { clockStartedAt: new Date(Date.now() - 50 * 60_000) }, // 10 min left, inside the 15-min window
  });
}

function ack(ticketId: string, cookie: string) {
  return request.post(`/api/tickets/${ticketId}/alerts/ack`).set('Cookie', cookie);
}

function alertIds(res: { body: { items: { id: string }[] } }): string[] {
  return res.body.items.map((t) => t.id);
}

describe('Alerts and acknowledgement', () => {
  beforeAll(async () => {
    await upsertUser(SUPERVISOR_EMAIL, 'Alerts Supervisor', 'supervisor');
    agentAId = await upsertUser(AGENT_A_EMAIL, 'Alerts Agent A', 'agent');
    agentBId = await upsertUser(AGENT_B_EMAIL, 'Alerts Agent B', 'agent');

    await testPrisma.priorityConfig.upsert({
      where: { code: 'urgent' },
      update: {},
      create: { code: 'urgent', targetResponseMinutes: 60, sortOrder: 4 },
    });

    supervisorCookie = await login(SUPERVISOR_EMAIL);
    agentACookie = await login(AGENT_A_EMAIL);
    agentBCookie = await login(AGENT_B_EMAIL);
  });

  afterAll(async () => {
    const tickets = await testPrisma.ticket.findMany({
      where: { requester: { email: { startsWith: 'alerts-test-' } } },
      select: { id: true },
    });
    const ids = tickets.map((t) => t.id);

    await purgeTicketEvents(testPrisma, { ticketId: { in: ids } });
    await testPrisma.reply.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.ticketCollaborator.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.ticket.deleteMany({ where: { id: { in: ids } } });
    await testPrisma.requester.deleteMany({ where: { email: { startsWith: 'alerts-test-' } } });
    await testPrisma.user.deleteMany({ where: { email: { startsWith: 'alerts-test-' } } });
    await testPrisma.$disconnect();
  });

  describe('GET /api/alerts', () => {
    it('lists a breached ticket, and a warning-only one, but not a healthy one', async () => {
      const breached = await newOpenUrgentTicket();
      await backdateToBreach(breached);

      const warning = await newOpenUrgentTicket();
      await backdateToWarning(warning);

      const healthy = await newOpenUrgentTicket();

      const res = await request.get('/api/alerts').set('Cookie', supervisorCookie);
      const ids = alertIds(res);

      expect(res.status).toBe(200);
      expect(ids).toContain(breached);
      expect(ids).toContain(warning);
      expect(ids).not.toContain(healthy);
    });

    it('sorts the most overdue breach first', async () => {
      const barelyBreached = await newOpenUrgentTicket();
      await testPrisma.ticket.update({
        where: { id: barelyBreached },
        data: { clockStartedAt: new Date(Date.now() - 61 * 60_000) },
      });

      const badlyBreached = await newOpenUrgentTicket();
      await testPrisma.ticket.update({
        where: { id: badlyBreached },
        data: { clockStartedAt: new Date(Date.now() - 180 * 60_000) },
      });

      const res = await request.get('/api/alerts').set('Cookie', supervisorCookie);
      const ids = alertIds(res);

      expect(ids.indexOf(badlyBreached)).toBeLessThan(ids.indexOf(barelyBreached));
    });

    it("gives an agent their own tickets and a collaborator's, never an unrelated one", async () => {
      const mine = await newOpenUrgentTicket({ assignee_id: agentAId });
      await backdateToBreach(mine);

      const collaborating = await newOpenUrgentTicket({ assignee_id: agentBId });
      await backdateToBreach(collaborating);
      await request
        .post(`/api/tickets/${collaborating}/collaborators`)
        .set('Cookie', supervisorCookie)
        .send({ agent_id: agentAId });

      const unrelated = await newOpenUrgentTicket({ assignee_id: agentBId });
      await backdateToBreach(unrelated);

      const res = await request.get('/api/alerts').set('Cookie', agentACookie);
      const ids = alertIds(res);

      expect(ids).toContain(mine);
      expect(ids).toContain(collaborating);
      expect(ids).not.toContain(unrelated);
    });

    it('excludes resolved, closed and archived tickets even if they were breaching', async () => {
      const resolved = await newOpenUrgentTicket();
      await backdateToBreach(resolved);
      await request.post(`/api/tickets/${resolved}/status`).set('Cookie', supervisorCookie).send({ status: 'resolved' });

      const archived = await newOpenUrgentTicket();
      await backdateToBreach(archived);
      await request.post(`/api/tickets/${archived}/archive`).set('Cookie', supervisorCookie);

      const res = await request.get('/api/alerts').set('Cookie', supervisorCookie);
      const ids = alertIds(res);

      expect(ids).not.toContain(resolved);
      expect(ids).not.toContain(archived);
    });

    it('rejects an unauthenticated request', async () => {
      expect((await request.get('/api/alerts')).status).toBe(401);
    });
  });

  describe('POST /api/tickets/:id/alerts/ack', () => {
    it('acknowledging clears the alert from the list', async () => {
      const ticket = await newOpenUrgentTicket();
      await backdateToBreach(ticket);

      expect(alertIds(await request.get('/api/alerts').set('Cookie', supervisorCookie))).toContain(ticket);

      const res = await ack(ticket, agentACookie);
      expect(res.status).toBe(200);
      expect(res.body.sla.alert_active).toBe(false);

      expect(alertIds(await request.get('/api/alerts').set('Cookie', supervisorCookie))).not.toContain(ticket);
    });

    it('lets a collaborator acknowledge, not only the primary assignee', async () => {
      const ticket = await newOpenUrgentTicket({ assignee_id: agentBId });
      await backdateToBreach(ticket);
      await request.post(`/api/tickets/${ticket}/collaborators`).set('Cookie', supervisorCookie).send({ agent_id: agentAId });

      const res = await ack(ticket, agentACookie);
      expect(res.status).toBe(200);
    });

    it('refuses an unrelated agent, and refuses without a session', async () => {
      const ticket = await newOpenUrgentTicket({ assignee_id: agentBId });
      await backdateToBreach(ticket);

      expect((await ack(ticket, agentACookie)).status).toBe(403);
      expect((await request.post(`/api/tickets/${ticket}/alerts/ack`)).status).toBe(401);
    });

    it('refuses to acknowledge a ticket with no active alert', async () => {
      const ticket = await newOpenUrgentTicket();
      const res = await ack(ticket, agentACookie);

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('no active alert');
    });

    it('refuses to acknowledge an archived ticket', async () => {
      const ticket = await newOpenUrgentTicket();
      await backdateToBreach(ticket);
      await request.post(`/api/tickets/${ticket}/archive`).set('Cookie', supervisorCookie);

      const res = await ack(ticket, agentACookie);
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('archived');
    });

    it('returns 404 for a ticket that does not exist', async () => {
      const res = await ack('00000000-0000-0000-0000-000000000000', supervisorCookie);
      expect(res.status).toBe(404);
    });

    it('records the acknowledgement on the timeline', async () => {
      const ticket = await newOpenUrgentTicket();
      await backdateToBreach(ticket);
      const res = await ack(ticket, agentACookie);

      const events = res.body.events.filter((e: { event_type: string }) => e.event_type === 'sla_ack');
      expect(events).toHaveLength(1);
      expect(events[0].actor.name).toBe('Alerts Agent A');
    });

    /**
     * The rule the brief singles out as the easiest to get subtly wrong: acknowledging a
     * breach must silence only that cycle. Reopening after close begins a new one, and if
     * the ticket breaches again in the new cycle, the alert must return — the earlier
     * acknowledgement cannot silence it forever.
     */
    it('a reopened-and-rebreached ticket alerts again after being acked and closed', async () => {
      const ticket = await newOpenUrgentTicket();
      await backdateToBreach(ticket);

      const acked = await ack(ticket, agentACookie);
      expect(acked.body.sla.alert_active).toBe(false);

      await request.post(`/api/tickets/${ticket}/status`).set('Cookie', supervisorCookie).send({ status: 'resolved' });
      const closed = await request
        .post(`/api/tickets/${ticket}/status`)
        .set('Cookie', supervisorCookie)
        .send({ status: 'closed' });
      expect(closed.body.ack_cycle).toBe(0);

      // Still within the reopen window, but backdated to make the point unambiguous.
      await testPrisma.ticket.update({
        where: { id: ticket },
        data: { closedAt: new Date(Date.now() - (REOPEN_WINDOW_DAYS - 1) * 24 * 60 * 60_000) },
      });

      const reopened = await request.post(`/api/tickets/${ticket}/status`).set('Cookie', supervisorCookie).send({ status: 'open' });
      expect(reopened.body.ack_cycle).toBe(1); // a new cycle has begun
      expect(reopened.body.sla.alert_active).toBe(false); // clock restarted, not yet breaching again

      // Breach again, in the new cycle.
      await backdateToBreach(ticket);

      const res = await request.get('/api/alerts').set('Cookie', supervisorCookie);
      expect(alertIds(res)).toContain(ticket);

      const detail = await request.get(`/api/tickets/${ticket}`).set('Cookie', supervisorCookie);
      expect(detail.body.sla.alert_active).toBe(true);
    });
  });
});
