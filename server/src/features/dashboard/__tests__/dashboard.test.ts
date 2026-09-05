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
import { startOfWeekUtc, isoDate } from '../weeks.js';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 2 });
const testPrisma = new PrismaClient({ adapter });
const request = supertest(app);

const PASSWORD = 'testpass123';
const SUPERVISOR_EMAIL = 'dashboard-test-sup@example.com';
const AGENT_A_EMAIL = 'dashboard-test-agent-a@example.com';
const AGENT_B_EMAIL = 'dashboard-test-agent-b@example.com';
const REQUESTER_EMAIL = 'dashboard-test-customer@example.com';

let agentAId: string;
let agentBId: string;
let supervisorCookie: string;
let agentACookie: string;

interface Dashboard {
  open_count: number;
  pending_count: number;
  resolved_this_week: number;
  breaching_count: number;
  by_status: Record<string, number>;
  by_agent: { agent: { id: string; name: string }; count: number }[];
  resolved_per_week: { week_start: string; count: number }[];
}

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
    .set('Cookie', supervisorCookie)
    .send({
      subject: 'Dashboard test ticket',
      description: 'Created for dashboard aggregate tests.',
      requester: { name: 'Dashboard Customer', email: REQUESTER_EMAIL },
      priority_code: 'normal',
      category: 'bug',
      assignee_id: agentAId,
      ...overrides,
    });
}

async function getDashboard(): Promise<Dashboard> {
  const res = await request.get('/api/dashboard').set('Cookie', supervisorCookie);
  return res.body;
}

function agentCount(dashboard: Dashboard, agentId: string): number {
  return dashboard.by_agent.find((row) => row.agent.id === agentId)?.count ?? 0;
}

function weekCount(dashboard: Dashboard, weekStart: Date): number {
  return dashboard.resolved_per_week.find((row) => row.week_start === isoDate(weekStart))?.count ?? 0;
}

describe('GET /api/dashboard', () => {
  beforeAll(async () => {
    await upsertUser(SUPERVISOR_EMAIL, 'Dashboard Supervisor', 'supervisor');
    agentAId = await upsertUser(AGENT_A_EMAIL, 'Dashboard Agent A', 'agent');
    agentBId = await upsertUser(AGENT_B_EMAIL, 'Dashboard Agent B', 'agent');

    await testPrisma.priorityConfig.upsert({
      where: { code: 'normal' },
      update: {},
      create: { code: 'normal', targetResponseMinutes: 1440, sortOrder: 2 },
    });
    await testPrisma.priorityConfig.upsert({
      where: { code: 'urgent' },
      update: {},
      create: { code: 'urgent', targetResponseMinutes: 60, sortOrder: 4 },
    });

    supervisorCookie = await login(SUPERVISOR_EMAIL);
    agentACookie = await login(AGENT_A_EMAIL);
  });

  afterAll(async () => {
    const tickets = await testPrisma.ticket.findMany({
      where: { requester: { email: { startsWith: 'dashboard-test-' } } },
      select: { id: true },
    });
    const ids = tickets.map((t) => t.id);

    await purgeTicketEvents(testPrisma, { ticketId: { in: ids } });
    await testPrisma.reply.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.ticketCollaborator.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.ticket.deleteMany({ where: { id: { in: ids } } });
    await testPrisma.requester.deleteMany({ where: { email: { startsWith: 'dashboard-test-' } } });
    await testPrisma.user.deleteMany({ where: { email: { startsWith: 'dashboard-test-' } } });
    await testPrisma.$disconnect();
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request.get('/api/dashboard');
    expect(res.status).toBe(401);
  });

  it('is visible to an agent, not just a supervisor — the brief scopes it to nobody', async () => {
    const res = await request.get('/api/dashboard').set('Cookie', agentACookie);
    expect(res.status).toBe(200);
  });

  it('counts open, pending and by-status exactly against a known set of tickets', async () => {
    const before = await getDashboard();

    const newTicket = await createTicket();
    const openTicket = await createTicket();
    await request.post(`/api/tickets/${openTicket.body.id}/status`).set('Cookie', supervisorCookie).send({ status: 'open' });
    const pendingTicket = await createTicket();
    await request.post(`/api/tickets/${pendingTicket.body.id}/status`).set('Cookie', supervisorCookie).send({ status: 'open' });
    await request.post(`/api/tickets/${pendingTicket.body.id}/status`).set('Cookie', supervisorCookie).send({ status: 'pending' });

    const after = await getDashboard();

    expect(after.open_count - before.open_count).toBe(1);
    expect(after.pending_count - before.pending_count).toBe(1);
    expect(after.by_status.new - before.by_status.new).toBe(1);
    expect(after.by_status.open - before.by_status.open).toBe(1);
    expect(after.by_status.pending - before.by_status.pending).toBe(1);

    void newTicket; // created only to occupy the "new" bucket
  });

  it('breaks tickets down by agent, counting only tickets currently assigned to them', async () => {
    const before = await getDashboard();

    await createTicket({ assignee_id: agentAId });
    await createTicket({ assignee_id: agentAId });
    await createTicket({ assignee_id: agentBId });

    const after = await getDashboard();

    expect(agentCount(after, agentAId) - agentCount(before, agentAId)).toBe(2);
    expect(agentCount(after, agentBId) - agentCount(before, agentBId)).toBe(1);
  });

  it('counts a ticket as breaching only while it is still in progress', async () => {
    const before = await getDashboard();

    const ticket = await createTicket({ priority_code: 'urgent' });
    await request.post(`/api/tickets/${ticket.body.id}/status`).set('Cookie', supervisorCookie).send({ status: 'open' });
    // Urgent's target is 60 minutes; backdating the clock two hours guarantees a breach.
    await testPrisma.ticket.update({
      where: { id: ticket.body.id },
      data: { clockStartedAt: new Date(Date.now() - 2 * 60 * 60_000) },
    });

    const whileOpen = await getDashboard();
    expect(whileOpen.breaching_count - before.breaching_count).toBe(1);

    await request.post(`/api/tickets/${ticket.body.id}/status`).set('Cookie', supervisorCookie).send({ status: 'resolved' });

    const afterResolved = await getDashboard();
    // Resolving it took the response that was owed — there is nothing left to flag, even
    // though the same ticket would still read breached: true if queried directly.
    expect(afterResolved.breaching_count - before.breaching_count).toBe(0);
  });

  it('counts "resolved this week" from resolved_at, regardless of what happens afterward', async () => {
    const before = await getDashboard();
    const thisWeek = startOfWeekUtc(new Date());

    const ticket = await createTicket();
    await request.post(`/api/tickets/${ticket.body.id}/status`).set('Cookie', supervisorCookie).send({ status: 'open' });
    await request.post(`/api/tickets/${ticket.body.id}/status`).set('Cookie', supervisorCookie).send({ status: 'resolved' });

    const afterResolve = await getDashboard();
    expect(afterResolve.resolved_this_week - before.resolved_this_week).toBe(1);
    expect(weekCount(afterResolve, thisWeek) - weekCount(before, thisWeek)).toBe(1);

    // Closing it afterwards must not make it disappear from "resolved this week" — the
    // work of resolving it already happened, closing is a separate, later action.
    await request.post(`/api/tickets/${ticket.body.id}/status`).set('Cookie', supervisorCookie).send({ status: 'closed' });
    const afterClose = await getDashboard();

    expect(afterClose.resolved_this_week - before.resolved_this_week).toBe(1);
  });

  it('buckets a resolution from three weeks ago into that week, not the current one', async () => {
    const threeWeeksAgo = new Date();
    threeWeeksAgo.setUTCDate(threeWeeksAgo.getUTCDate() - 21);
    const targetWeek = startOfWeekUtc(threeWeeksAgo);
    // A safely mid-week instant, clear of any boundary ambiguity.
    const backdated = new Date(targetWeek.getTime() + 2 * 24 * 60 * 60_000);

    const before = await getDashboard();
    const beforeTarget = weekCount(before, targetWeek);
    const beforeThisWeek = weekCount(before, startOfWeekUtc(new Date()));

    const ticket = await createTicket();
    await request.post(`/api/tickets/${ticket.body.id}/status`).set('Cookie', supervisorCookie).send({ status: 'open' });
    await request.post(`/api/tickets/${ticket.body.id}/status`).set('Cookie', supervisorCookie).send({ status: 'resolved' });
    await testPrisma.ticket.update({ where: { id: ticket.body.id }, data: { resolvedAt: backdated } });

    const after = await getDashboard();

    expect(weekCount(after, targetWeek) - beforeTarget).toBe(1);
    // And it must not also show up in the current week's bucket or the headline count.
    expect(weekCount(after, startOfWeekUtc(new Date())) - beforeThisWeek).toBe(0);
  });

  it('excludes archived tickets from every count', async () => {
    const before = await getDashboard();

    const ticket = await createTicket();
    await request.post(`/api/tickets/${ticket.body.id}/archive`).set('Cookie', supervisorCookie);

    const after = await getDashboard();

    expect(after.by_status.new - before.by_status.new).toBe(0);
    expect(agentCount(after, agentAId) - agentCount(before, agentAId)).toBe(0);
  });
});

describe('GET /api/dashboard/week', () => {
  // Independent of the describe block above: that one's afterAll deletes its own
  // supervisor and agent once its tests finish, so a cookie or id borrowed from it would
  // belong to a since-deleted user by the time these tests run.
  const WEEK_SUPERVISOR_EMAIL = 'dashboard-week-test-sup@example.com';
  const WEEK_AGENT_EMAIL = 'dashboard-week-test-agent@example.com';
  const WEEK_REQUESTER_EMAIL = 'dashboard-week-test-customer@example.com';

  let weekSupervisorCookie: string;
  let weekAgentId: string;

  function createWeekTicket(overrides: Record<string, unknown> = {}) {
    return request
      .post('/api/tickets')
      .set('Cookie', weekSupervisorCookie)
      .send({
        subject: 'Dashboard week-detail test ticket',
        description: 'Created for the week drill-down tests.',
        requester: { name: 'Dashboard Week Customer', email: WEEK_REQUESTER_EMAIL },
        priority_code: 'normal',
        category: 'bug',
        assignee_id: weekAgentId,
        ...overrides,
      });
  }

  beforeAll(async () => {
    await upsertUser(WEEK_SUPERVISOR_EMAIL, 'Dashboard Week Supervisor', 'supervisor');
    weekAgentId = await upsertUser(WEEK_AGENT_EMAIL, 'Dashboard Week Agent', 'agent');
    weekSupervisorCookie = await login(WEEK_SUPERVISOR_EMAIL);
  });

  afterAll(async () => {
    const tickets = await testPrisma.ticket.findMany({
      where: { requester: { email: WEEK_REQUESTER_EMAIL } },
      select: { id: true },
    });
    const ids = tickets.map((t) => t.id);

    await purgeTicketEvents(testPrisma, { ticketId: { in: ids } });
    await testPrisma.reply.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.ticketCollaborator.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.ticket.deleteMany({ where: { id: { in: ids } } });
    await testPrisma.requester.deleteMany({ where: { email: WEEK_REQUESTER_EMAIL } });
    await testPrisma.user.deleteMany({ where: { email: { startsWith: 'dashboard-week-test-' } } });
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request.get('/api/dashboard/week?start=2026-01-05');
    expect(res.status).toBe(401);
  });

  it('rejects a start that does not parse as a date', async () => {
    const res = await request.get('/api/dashboard/week?start=not-a-date').set('Cookie', weekSupervisorCookie);
    expect(res.status).toBe(400);
  });

  it("floors an arbitrary day within the week to that week's Monday", async () => {
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setUTCDate(twoWeeksAgo.getUTCDate() - 14);
    const weekStart = startOfWeekUtc(twoWeeksAgo);
    const thursday = new Date(weekStart.getTime() + 3 * 24 * 60 * 60_000);

    const res = await request
      .get(`/api/dashboard/week?start=${isoDate(thursday)}`)
      .set('Cookie', weekSupervisorCookie);

    expect(res.status).toBe(200);
    expect(res.body.week_start).toBe(isoDate(weekStart));
    expect(res.body.days).toHaveLength(7);
    expect(res.body.days[0].date).toBe(isoDate(weekStart));
  });

  it('buckets a resolution on the day it happened, and credits the agent who holds it', async () => {
    // A week nothing else in this file touches (the other describe block's tests use
    // "this week" or "three weeks ago"), so every count read back here is this test's own.
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setUTCDate(twoWeeksAgo.getUTCDate() - 14);
    const weekStart = startOfWeekUtc(twoWeeksAgo);
    const wednesday = new Date(weekStart.getTime() + 2 * 24 * 60 * 60_000);

    const ticket = await createWeekTicket();
    await request.post(`/api/tickets/${ticket.body.id}/status`).set('Cookie', weekSupervisorCookie).send({ status: 'open' });
    await request.post(`/api/tickets/${ticket.body.id}/status`).set('Cookie', weekSupervisorCookie).send({ status: 'resolved' });
    await testPrisma.ticket.update({ where: { id: ticket.body.id }, data: { resolvedAt: wednesday } });

    const res = await request
      .get(`/api/dashboard/week?start=${isoDate(weekStart)}`)
      .set('Cookie', weekSupervisorCookie);

    expect(res.status).toBe(200);
    const totalForWeek = res.body.days.reduce((sum: number, d: { count: number }) => sum + d.count, 0);
    expect(totalForWeek).toBe(1);
    const wednesdayRow = res.body.days.find((d: { date: string }) => d.date === isoDate(wednesday));
    expect(wednesdayRow.count).toBe(1);

    const agentRow = res.body.by_agent.find((r: { agent: { id: string } }) => r.agent.id === weekAgentId);
    expect(agentRow.count).toBe(1);
  });
});
