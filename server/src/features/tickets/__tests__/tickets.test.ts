import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../../.env.test') });

import { app } from '../../../app.js';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const testPrisma = new PrismaClient({ adapter });
const request = supertest(app);

const PASSWORD = 'testpass123';
const SUPERVISOR_EMAIL = 'tickets-test-sup@example.com';
const SUPERVISOR_2_EMAIL = 'tickets-test-sup2@example.com';
const AGENT_A_EMAIL = 'tickets-test-agent-a@example.com';
const AGENT_B_EMAIL = 'tickets-test-agent-b@example.com';

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

/** Create a ticket with sensible defaults; override whatever the test cares about. */
function createTicket(cookie: string, overrides: Record<string, unknown> = {}) {
  return request
    .post('/api/tickets')
    .set('Cookie', cookie)
    .send({
      subject: 'Printer will not print',
      description: 'It makes a noise and then stops.',
      requester: { name: 'Jane Customer', email: 'tickets-test-jane@example.com' },
      priority_code: 'normal',
      category: 'bug',
      ...overrides,
    });
}

describe('Ticket routes', () => {
  beforeAll(async () => {
    supervisorId = await upsertUser(SUPERVISOR_EMAIL, 'Test Supervisor', 'supervisor');
    supervisor2Id = await upsertUser(SUPERVISOR_2_EMAIL, 'Second Supervisor', 'supervisor');
    agentAId = await upsertUser(AGENT_A_EMAIL, 'Agent A', 'agent');
    agentBId = await upsertUser(AGENT_B_EMAIL, 'Agent B', 'agent');

    await testPrisma.priorityConfig.upsert({
      where: { code: 'normal' },
      update: {},
      create: { code: 'normal', targetResponseMinutes: 1440, sortOrder: 2 },
    });
    await testPrisma.priorityConfig.upsert({
      where: { code: 'high' },
      update: {},
      create: { code: 'high', targetResponseMinutes: 240, sortOrder: 3 },
    });

    supervisorCookie = await login(SUPERVISOR_EMAIL);
    agentACookie = await login(AGENT_A_EMAIL);
    agentBCookie = await login(AGENT_B_EMAIL);
  });

  afterAll(async () => {
    const tickets = await testPrisma.ticket.findMany({
      where: { requester: { email: { startsWith: 'tickets-test-' } } },
      select: { id: true },
    });
    const ids = tickets.map((t) => t.id);

    await testPrisma.ticketEvent.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.ticketCollaborator.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.reply.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.ticket.deleteMany({ where: { id: { in: ids } } });
    await testPrisma.requester.deleteMany({ where: { email: { startsWith: 'tickets-test-' } } });
    await testPrisma.user.deleteMany({ where: { email: { startsWith: 'tickets-test-' } } });
    await testPrisma.$disconnect();
  });

  describe('POST /api/tickets', () => {
    it('creates a ticket in status new and attaches the agent creator as a collaborator', async () => {
      const res = await createTicket(agentACookie);

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('new');
      expect(res.body.assignee).toBeNull();
      expect(res.body.collaborators.map((c: { id: string }) => c.id)).toContain(agentAId);
    });

    it('gives every ticket a unique, human-readable key', async () => {
      const first = await createTicket(agentACookie);
      const second = await createTicket(agentACookie);

      expect(first.body.key).toMatch(/^SUP-\d+$/);
      expect(second.body.key).toMatch(/^SUP-\d+$/);
      expect(second.body.key).not.toBe(first.body.key);

      // Also present on the list, not only the single-ticket response.
      const list = await request.get('/api/tickets').set('Cookie', agentACookie);
      const listed = list.body.items.find((t: { id: string }) => t.id === first.body.id);
      expect(listed.key).toBe(first.body.key);
    });

    it('lets an agent self-assign and still records them as a collaborator', async () => {
      const res = await createTicket(agentACookie, { assignee_id: agentAId });

      expect(res.status).toBe(201);
      expect(res.body.assignee.id).toBe(agentAId);
      expect(res.body.collaborators.map((c: { id: string }) => c.id)).toContain(agentAId);
    });

    it('refuses an agent assigning a ticket to another agent', async () => {
      const res = await createTicket(agentACookie, { assignee_id: agentBId });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('An agent can only assign a new ticket to themselves');
    });

    it('refuses an agent adding collaborators', async () => {
      const res = await createTicket(agentACookie, { collaborator_ids: [agentBId] });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Only a supervisor can add collaborators');
    });

    it('lets a supervisor assign an agent and add agent collaborators', async () => {
      const res = await createTicket(supervisorCookie, {
        assignee_id: agentAId,
        collaborator_ids: [agentBId],
      });

      expect(res.status).toBe(201);
      expect(res.body.assignee.id).toBe(agentAId);
      expect(res.body.collaborators.map((c: { id: string }) => c.id)).toEqual([agentBId]);
    });

    it('does not attach a supervisor creator as a collaborator', async () => {
      const res = await createTicket(supervisorCookie);

      expect(res.status).toBe(201);
      expect(res.body.collaborators).toEqual([]);
    });

    it('refuses a supervisor assigning the ticket to themselves', async () => {
      const res = await createTicket(supervisorCookie, { assignee_id: supervisorId });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Only agents');
    });

    it('refuses a supervisor adding the other supervisor as a collaborator', async () => {
      const res = await createTicket(supervisorCookie, { collaborator_ids: [supervisor2Id] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Only agents');
    });

    it('rejects a missing subject, an unknown priority and an unknown category', async () => {
      expect((await createTicket(agentACookie, { subject: '  ' })).status).toBe(400);
      expect((await createTicket(agentACookie, { priority_code: 'urgentish' })).status).toBe(400);
      expect((await createTicket(agentACookie, { category: 'hardware' })).status).toBe(400);
    });

    it('reuses one requester record regardless of email casing', async () => {
      const first = await createTicket(agentACookie, {
        requester: { name: 'Casing Test', email: 'tickets-test-CASING@example.com' },
      });
      const second = await createTicket(agentACookie, {
        requester: { name: 'Casing Test', email: 'tickets-test-casing@example.com' },
      });

      expect(first.body.requester.id).toBe(second.body.requester.id);
      expect(first.body.requester.email).toBe('tickets-test-casing@example.com');
    });

    it('rejects an unauthenticated request', async () => {
      const res = await request.post('/api/tickets').send({});
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/tickets', () => {
    it('shows an agent only their own tickets', async () => {
      const mine = await createTicket(agentACookie, { assignee_id: agentAId });
      const theirs = await createTicket(agentBCookie, { assignee_id: agentBId });

      // page_size=100 so this stays correct regardless of how many other tickets this
      // file's earlier tests have already attached to agent A — the default page size
      // (25) would otherwise make `total` and `items.length` diverge as the file grows.
      const res = await request.get('/api/tickets?page_size=100').set('Cookie', agentACookie);
      const ids = res.body.items.map((t: { id: string }) => t.id);

      expect(res.status).toBe(200);
      expect(ids).toContain(mine.body.id);
      expect(ids).not.toContain(theirs.body.id);
      expect(res.body.total).toBe(res.body.items.length);
    });

    it('shows a supervisor tickets they are not attached to', async () => {
      const agentTicket = await createTicket(agentACookie, { assignee_id: agentAId });

      const res = await request.get('/api/tickets').set('Cookie', supervisorCookie);
      const ids = res.body.items.map((t: { id: string }) => t.id);

      expect(ids).toContain(agentTicket.body.id);
    });

    it('hides archived tickets by default and includes them on request', async () => {
      const created = await createTicket(agentACookie, { assignee_id: agentAId });
      await request.post(`/api/tickets/${created.body.id}/archive`).set('Cookie', agentACookie);

      const def = await request.get('/api/tickets').set('Cookie', agentACookie);
      const withArchived = await request.get('/api/tickets?archived=true').set('Cookie', agentACookie);

      expect(def.body.items.map((t: { id: string }) => t.id)).not.toContain(created.body.id);
      expect(withArchived.body.items.map((t: { id: string }) => t.id)).toContain(created.body.id);
    });

    describe('search, filters, sort and pagination', () => {
      // A term unlikely to appear in any other test's fixture data, so assertions can
      // check what came back without needing to isolate the whole table.
      const MARKER = 'zqxywobble';

      it('matches a partial word, not just a whole one', async () => {
        const created = await createTicket(supervisorCookie, {
          subject: `Investigating ${MARKER}printer noise`,
          assignee_id: agentAId,
        });

        // "zqxywobble" is a fragment inside "zqxywoBBLEprinter" — a real substring match,
        // not a whole-word one full-text search would require.
        const res = await request.get(`/api/tickets?q=${MARKER}`).set('Cookie', supervisorCookie);

        expect(res.status).toBe(200);
        expect(res.body.items.map((t: { id: string }) => t.id)).toContain(created.body.id);
      });

      it('matches the description as well as the subject', async () => {
        const created = await createTicket(supervisorCookie, {
          subject: 'Ordinary subject line',
          description: `The customer mentioned ${MARKER} in their email.`,
          assignee_id: agentAId,
        });

        const res = await request.get(`/api/tickets?q=${MARKER}`).set('Cookie', supervisorCookie);
        expect(res.body.items.map((t: { id: string }) => t.id)).toContain(created.body.id);
      });

      it('is case-insensitive', async () => {
        const created = await createTicket(supervisorCookie, {
          subject: `Ticket about ${MARKER.toUpperCase()}`,
          assignee_id: agentAId,
        });

        const res = await request.get(`/api/tickets?q=${MARKER}`).set('Cookie', supervisorCookie);
        expect(res.body.items.map((t: { id: string }) => t.id)).toContain(created.body.id);
      });

      it('ANDs filters together rather than ORing them', async () => {
        const marker = `${MARKER}filter`;
        const matches = await createTicket(supervisorCookie, {
          subject: marker,
          priority_code: 'high',
          category: 'billing',
          assignee_id: agentAId,
        });
        const wrongPriority = await createTicket(supervisorCookie, {
          subject: marker,
          priority_code: 'low',
          category: 'billing',
          assignee_id: agentAId,
        });
        const wrongCategory = await createTicket(supervisorCookie, {
          subject: marker,
          priority_code: 'high',
          category: 'bug',
          assignee_id: agentAId,
        });

        const res = await request
          .get(`/api/tickets?q=${marker}&priority=high&category=billing`)
          .set('Cookie', supervisorCookie);
        const ids = res.body.items.map((t: { id: string }) => t.id);

        expect(ids).toContain(matches.body.id);
        expect(ids).not.toContain(wrongPriority.body.id);
        expect(ids).not.toContain(wrongCategory.body.id);
      });

      it('filters by assignee_id', async () => {
        const marker = `${MARKER}assignee`;
        const forA = await createTicket(supervisorCookie, {
          subject: marker,
          assignee_id: agentAId,
        });
        const forB = await createTicket(supervisorCookie, {
          subject: marker,
          assignee_id: agentBId,
        });

        const res = await request
          .get(`/api/tickets?q=${marker}&assignee_id=${agentAId}`)
          .set('Cookie', supervisorCookie);
        const ids = res.body.items.map((t: { id: string }) => t.id);

        expect(ids).toContain(forA.body.id);
        expect(ids).not.toContain(forB.body.id);
      });

      it('rejects an unrecognised status, priority or category filter with 400', async () => {
        const status = await request.get('/api/tickets?status=archived').set('Cookie', supervisorCookie);
        const priority = await request.get('/api/tickets?priority=critical').set('Cookie', supervisorCookie);
        const category = await request.get('/api/tickets?category=hardware').set('Cookie', supervisorCookie);

        expect(status.status).toBe(400);
        expect(priority.status).toBe(400);
        expect(category.status).toBe(400);
      });

      it('sorts by priority using sort_order, not the enum alphabetically', async () => {
        const marker = `${MARKER}sort`;
        const low = await createTicket(supervisorCookie, {
          subject: marker,
          priority_code: 'low',
          assignee_id: agentAId,
        });
        const urgent = await createTicket(supervisorCookie, {
          subject: marker,
          priority_code: 'urgent',
          assignee_id: agentAId,
        });

        const res = await request
          .get(`/api/tickets?q=${marker}&sort=priority&dir=desc`)
          .set('Cookie', supervisorCookie);
        const ids = res.body.items.map((t: { id: string }) => t.id);

        // Urgent (sort_order 4) must come before low (sort_order 1) — alphabetically it
        // would be the reverse.
        expect(ids.indexOf(urgent.body.id)).toBeLessThan(ids.indexOf(low.body.id));
      });

      it('rejects an unrecognised sort field or direction with 400', async () => {
        const field = await request.get('/api/tickets?sort=subject').set('Cookie', supervisorCookie);
        const dir = await request.get('/api/tickets?sort=created_at&dir=sideways').set('Cookie', supervisorCookie);

        expect(field.status).toBe(400);
        expect(dir.status).toBe(400);
      });

      it('paginates so total matches the filtered count, and pages are disjoint', async () => {
        const marker = `${MARKER}page`;
        const created = await Promise.all(
          [1, 2, 3].map(() => createTicket(supervisorCookie, { subject: marker, assignee_id: agentAId }))
        );
        const expectedIds = created.map((c) => c.body.id).sort();

        const first = await request
          .get(`/api/tickets?q=${marker}&page=1&page_size=2&sort=created_at&dir=asc`)
          .set('Cookie', supervisorCookie);
        const second = await request
          .get(`/api/tickets?q=${marker}&page=2&page_size=2&sort=created_at&dir=asc`)
          .set('Cookie', supervisorCookie);

        expect(first.body.total).toBe(3);
        expect(second.body.total).toBe(3);
        expect(first.body.items).toHaveLength(2);
        expect(second.body.items).toHaveLength(1);
        expect(first.body.page_size).toBe(2);

        const combined = [...first.body.items, ...second.body.items]
          .map((t: { id: string }) => t.id)
          .sort();
        expect(combined).toEqual(expectedIds);
      });

      it('clamps a page_size above the server maximum instead of rejecting it', async () => {
        const res = await request.get('/api/tickets?page_size=99999').set('Cookie', supervisorCookie);

        expect(res.status).toBe(200);
        expect(res.body.page_size).toBe(100);
      });
    });
  });

  describe('GET /api/tickets/:id', () => {
    it('is readable by the assignee, a collaborator and a supervisor', async () => {
      const created = await createTicket(supervisorCookie, {
        assignee_id: agentAId,
        collaborator_ids: [agentBId],
      });
      const id = created.body.id;

      expect((await request.get(`/api/tickets/${id}`).set('Cookie', agentACookie)).status).toBe(200);
      expect((await request.get(`/api/tickets/${id}`).set('Cookie', agentBCookie)).status).toBe(200);
      expect((await request.get(`/api/tickets/${id}`).set('Cookie', supervisorCookie)).status).toBe(200);
    });

    it('returns 403 to an agent with no connection to the ticket', async () => {
      const created = await createTicket(agentACookie, { assignee_id: agentAId });

      const res = await request.get(`/api/tickets/${created.body.id}`).set('Cookie', agentBCookie);
      expect(res.status).toBe(403);
    });

    it('returns 401 without a cookie', async () => {
      const created = await createTicket(agentACookie);
      const res = await request.get(`/api/tickets/${created.body.id}`);
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /api/tickets/:id', () => {
    it('edits subject, description, priority and category', async () => {
      const created = await createTicket(agentACookie, { assignee_id: agentAId });

      const res = await request
        .patch(`/api/tickets/${created.body.id}`)
        .set('Cookie', agentACookie)
        .send({ subject: 'Printer jams on page 2', priority_code: 'high', category: 'other' });

      expect(res.status).toBe(200);
      expect(res.body.subject).toBe('Printer jams on page 2');
      expect(res.body.priority_code).toBe('high');
      expect(res.body.category).toBe('other');
    });

    it('refuses status, assignee and archive changes with a pointer to the right endpoint', async () => {
      const created = await createTicket(agentACookie, { assignee_id: agentAId });
      const id = created.body.id;

      const status = await request.patch(`/api/tickets/${id}`).set('Cookie', agentACookie).send({ status: 'open' });
      const assignee = await request.patch(`/api/tickets/${id}`).set('Cookie', agentACookie).send({ assignee_id: agentBId });
      const archived = await request.patch(`/api/tickets/${id}`).set('Cookie', agentACookie).send({ archived_at: new Date() });

      expect(status.status).toBe(400);
      expect(status.body.error).toContain('/status');
      expect(assignee.status).toBe(400);
      expect(assignee.body.error).toContain('/reassign');
      expect(archived.status).toBe(400);
      expect(archived.body.error).toContain('/archive');
    });

    it('returns 403 to an unrelated agent', async () => {
      const created = await createTicket(agentACookie, { assignee_id: agentAId });

      const res = await request
        .patch(`/api/tickets/${created.body.id}`)
        .set('Cookie', agentBCookie)
        .send({ subject: 'Hijacked' });

      expect(res.status).toBe(403);
    });
  });

  describe('archive and restore', () => {
    it('archives, stays fully readable, then restores — writing one event each time', async () => {
      const created = await createTicket(agentACookie, { assignee_id: agentAId });
      const id = created.body.id;

      const archived = await request.post(`/api/tickets/${id}/archive`).set('Cookie', agentACookie);
      expect(archived.status).toBe(200);
      expect(archived.body.archived_at).not.toBeNull();

      // Archiving must not destroy history — the ticket is still readable in full.
      const read = await request.get(`/api/tickets/${id}`).set('Cookie', agentACookie);
      expect(read.status).toBe(200);
      expect(read.body.subject).toBe(created.body.subject);

      const restored = await request.post(`/api/tickets/${id}/restore`).set('Cookie', agentACookie);
      expect(restored.status).toBe(200);
      expect(restored.body.archived_at).toBeNull();

      const types = restored.body.events.map((e: { event_type: string }) => e.event_type);
      expect(types).toContain('archived');
      expect(types).toContain('restored');
    });

    it('returns 409 when archiving twice or restoring something not archived', async () => {
      const created = await createTicket(agentACookie, { assignee_id: agentAId });
      const id = created.body.id;

      const restoreFresh = await request.post(`/api/tickets/${id}/restore`).set('Cookie', agentACookie);
      expect(restoreFresh.status).toBe(409);

      await request.post(`/api/tickets/${id}/archive`).set('Cookie', agentACookie);
      const archiveAgain = await request.post(`/api/tickets/${id}/archive`).set('Cookie', agentACookie);
      expect(archiveAgain.status).toBe(409);
    });
  });

  describe('duplicate creation', () => {
    it('handles two agents filing for the same new customer at the same moment', async () => {
      const email = 'tickets-test-race@example.com';

      // Both requests find no requester for this email and both try to create one.
      // The unique index means only one insert can win; the endpoint has to cope.
      const [first, second] = await Promise.all([
        createTicket(agentACookie, {
          subject: 'Site is down',
          requester: { name: 'Race Customer', email },
        }),
        createTicket(agentBCookie, {
          subject: 'Site is down',
          requester: { name: 'Race Customer', email },
        }),
      ]);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      const requesters = await testPrisma.requester.findMany({ where: { email } });
      expect(requesters).toHaveLength(1);

      const tickets = await testPrisma.ticket.findMany({ where: { requester: { email } } });
      expect(tickets).toHaveLength(2);
    });

    it('lets a second agent file the same ticket later, and warns them it exists', async () => {
      const email = 'tickets-test-repeat@example.com';
      const payload = {
        subject: 'Cannot reset my password',
        description: 'The reset link in the email 404s.',
        requester: { name: 'Repeat Customer', email },
      };

      const first = await createTicket(agentACookie, { ...payload, assignee_id: agentAId });
      const second = await createTicket(agentBCookie, { ...payload, assignee_id: agentBId });

      // Duplicates are warned about, not blocked: a customer can legitimately raise
      // the same-sounding issue twice, and only a human can tell the difference.
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.id).not.toBe(first.body.id);

      expect(await testPrisma.requester.count({ where: { email } })).toBe(1);

      // Agent B could have seen agent A's ticket before filing, despite not being on it.
      const check = await request
        .get(`/api/tickets/duplicate-check?email=${encodeURIComponent(email)}`)
        .set('Cookie', agentBCookie);

      expect(check.body.total).toBe(2);
      expect(check.body.items.map((t: { id: string }) => t.id)).toContain(first.body.id);
    });
  });

  describe('GET /api/tickets/duplicate-check', () => {
    it("surfaces another agent's open ticket for the same requester", async () => {
      const email = 'tickets-test-dup@example.com';
      const created = await createTicket(agentACookie, {
        assignee_id: agentAId,
        requester: { name: 'Dup Customer', email },
      });

      // Agent B cannot read this ticket, but must still be warned it exists.
      const res = await request
        .get(`/api/tickets/duplicate-check?email=${encodeURIComponent(email)}`)
        .set('Cookie', agentBCookie);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.items[0].id).toBe(created.body.id);
      expect(res.body.items[0].assignee.name).toBe('Agent A');
      // Only enough to identify the duplicate — never the contents.
      expect(res.body.items[0].description).toBeUndefined();

      expect((await request.get(`/api/tickets/${created.body.id}`).set('Cookie', agentBCookie)).status).toBe(403);
    });

    it('ignores closed and archived tickets, and requires an email', async () => {
      const email = 'tickets-test-dup2@example.com';
      const closed = await createTicket(agentACookie, {
        assignee_id: agentAId,
        requester: { name: 'Dup Two', email },
      });
      await testPrisma.ticket.update({ where: { id: closed.body.id }, data: { status: 'closed' } });

      const archivedTicket = await createTicket(agentACookie, {
        assignee_id: agentAId,
        requester: { name: 'Dup Two', email },
      });
      await request.post(`/api/tickets/${archivedTicket.body.id}/archive`).set('Cookie', agentACookie);

      const res = await request
        .get(`/api/tickets/duplicate-check?email=${encodeURIComponent(email)}`)
        .set('Cookie', agentACookie);

      expect(res.body.total).toBe(0);

      const noEmail = await request.get('/api/tickets/duplicate-check').set('Cookie', agentACookie);
      expect(noEmail.status).toBe(400);
    });
  });
});
