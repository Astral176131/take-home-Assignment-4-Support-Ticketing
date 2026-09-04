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

// Capped small: this file's fixture writes are always awaited sequentially, and
// every test file opens its own pool — left uncapped, running many files together
// (as the full suite does) exhausts Postgres's connection limit.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 2 });
const testPrisma = new PrismaClient({ adapter });
const request = supertest(app);

const PASSWORD = 'testpass123';
const SUPERVISOR_EMAIL = 'export-test-sup@example.com';
const AGENT_A_EMAIL = 'export-test-agent-a@example.com';
const AGENT_B_EMAIL = 'export-test-agent-b@example.com';
const REQUESTER_EMAIL = 'export-test-customer@example.com';

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

function createTicket(cookie: string, overrides: Record<string, unknown> = {}) {
  return request
    .post('/api/tickets')
    .set('Cookie', cookie)
    .send({
      subject: 'Export test ticket',
      description: 'Created for CSV export tests.',
      requester: { name: 'Export Customer', email: REQUESTER_EMAIL },
      priority_code: 'normal',
      category: 'bug',
      ...overrides,
    });
}

/** Minimal RFC 4180 parser: enough to round-trip what csv.ts produces. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else {
      field += c;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe('GET /api/tickets/export.csv', () => {
  beforeAll(async () => {
    await upsertUser(SUPERVISOR_EMAIL, 'Export Supervisor', 'supervisor');
    agentAId = await upsertUser(AGENT_A_EMAIL, 'Export Agent A', 'agent');
    agentBId = await upsertUser(AGENT_B_EMAIL, 'Export Agent B', 'agent');

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
      where: { requester: { email: { startsWith: 'export-test-' } } },
      select: { id: true },
    });
    const ids = tickets.map((t) => t.id);

    await purgeTicketEvents(testPrisma, { ticketId: { in: ids } });
    await testPrisma.reply.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.ticketCollaborator.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.ticket.deleteMany({ where: { id: { in: ids } } });
    await testPrisma.requester.deleteMany({ where: { email: { startsWith: 'export-test-' } } });
    await testPrisma.user.deleteMany({ where: { email: { startsWith: 'export-test-' } } });
    await testPrisma.$disconnect();
  });

  it('is not swallowed by GET /:id — the route ordering bug this pattern is prone to', async () => {
    const res = await request.get('/api/tickets/export.csv').set('Cookie', supervisorCookie);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
  });

  it('has the expected header row', async () => {
    const res = await request.get('/api/tickets/export.csv').set('Cookie', supervisorCookie);
    const [header] = parseCsv(res.text);

    expect(header).toEqual([
      'key',
      'subject',
      'status',
      'priority',
      'category',
      'requester_name',
      'requester_email',
      'assignee',
      'created_at',
      'updated_at',
      'breached',
    ]);
  });

  it('row count matches the filtered total exactly', async () => {
    const marker = 'exportmarkerqzxy';
    await createTicket(supervisorCookie, { subject: marker, assignee_id: agentAId });
    await createTicket(supervisorCookie, { subject: marker, assignee_id: agentAId });
    await createTicket(supervisorCookie, { subject: marker, assignee_id: agentAId });

    const list = await request.get(`/api/tickets?q=${marker}&page_size=100`).set('Cookie', supervisorCookie);
    const csv = await request.get(`/api/tickets/export.csv?q=${marker}`).set('Cookie', supervisorCookie);

    const rows = parseCsv(csv.text);
    const dataRows = rows.slice(1).filter((r) => r.length > 1 || r[0] !== '');

    expect(dataRows).toHaveLength(list.body.total);
  });

  it('applies the same filters as the list endpoint', async () => {
    const marker = 'exportfiltermarker';
    const highBilling = await createTicket(supervisorCookie, {
      subject: marker,
      priority_code: 'high',
      category: 'billing',
      assignee_id: agentAId,
    });
    await createTicket(supervisorCookie, {
      subject: marker,
      priority_code: 'low',
      category: 'billing',
      assignee_id: agentAId,
    });

    const csv = await request
      .get(`/api/tickets/export.csv?q=${marker}&priority=high&category=billing`)
      .set('Cookie', supervisorCookie);

    const rows = parseCsv(csv.text).slice(1).filter((r) => r[0]);
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toBe(highBilling.body.key);
  });

  it('escapes a field containing a comma so it round-trips correctly', async () => {
    const created = await createTicket(supervisorCookie, {
      subject: 'Invoice, receipt and refund all missing',
      assignee_id: agentAId,
    });

    const csv = await request
      .get(`/api/tickets/export.csv?q=${encodeURIComponent('Invoice, receipt')}`)
      .set('Cookie', supervisorCookie);

    const rows = parseCsv(csv.text).slice(1).filter((r) => r[0]);
    const match = rows.find((r) => r[0] === created.body.key);

    expect(match?.[1]).toBe('Invoice, receipt and refund all missing');
  });

  it("an agent's export excludes tickets they cannot see", async () => {
    const marker = 'exportscopemarker';
    const forA = await createTicket(agentACookie, { subject: marker, assignee_id: agentAId });
    const forB = await createTicket(agentBCookie, { subject: marker, assignee_id: agentBId });

    const csv = await request.get(`/api/tickets/export.csv?q=${marker}`).set('Cookie', agentACookie);
    const keys = parseCsv(csv.text)
      .slice(1)
      .filter((r) => r[0])
      .map((r) => r[0]);

    expect(keys).toContain(forA.body.key);
    expect(keys).not.toContain(forB.body.key);
  });

  it('breached matches what the ticket detail endpoint reports', async () => {
    const created = await createTicket(supervisorCookie, {
      subject: 'exportbreachmarker',
      priority_code: 'urgent',
      assignee_id: agentAId,
    });
    await request.post(`/api/tickets/${created.body.id}/status`).set('Cookie', supervisorCookie).send({ status: 'open' });
    await testPrisma.ticket.update({
      where: { id: created.body.id },
      data: { clockStartedAt: new Date(Date.now() - 2 * 60 * 60_000) }, // 2h ago, urgent target is 1h
    });

    const detail = await request.get(`/api/tickets/${created.body.id}`).set('Cookie', supervisorCookie);
    expect(detail.body.sla.breached).toBe(true);

    const csv = await request
      .get('/api/tickets/export.csv?q=exportbreachmarker')
      .set('Cookie', supervisorCookie);
    const row = parseCsv(csv.text)
      .slice(1)
      .find((r) => r[0] === created.body.key);

    expect(row?.[10]).toBe('yes');
  });

  it('produces just the header row when nothing matches', async () => {
    const csv = await request
      .get('/api/tickets/export.csv?q=nothingwilleverbethisexactstring')
      .set('Cookie', supervisorCookie);

    const rows = parseCsv(csv.text).filter((r) => r.length > 1 || r[0] !== '');
    expect(rows).toHaveLength(1);
  });

  it('rejects an unrecognised filter with 400, same as the list endpoint', async () => {
    const res = await request.get('/api/tickets/export.csv?priority=critical').set('Cookie', supervisorCookie);
    expect(res.status).toBe(400);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request.get('/api/tickets/export.csv');
    expect(res.status).toBe(401);
  });
});
