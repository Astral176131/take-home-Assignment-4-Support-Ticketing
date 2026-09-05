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
const SUPERVISOR_EMAIL = 'bulk-test-sup@example.com';
const SUPERVISOR_2_EMAIL = 'bulk-test-sup2@example.com';
const AGENT_A_EMAIL = 'bulk-test-agent-a@example.com';
const AGENT_B_EMAIL = 'bulk-test-agent-b@example.com';
const REQUESTER_EMAIL = 'bulk-test-customer@example.com';

let supervisorId: string;
let supervisor2Id: string;
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

async function newTicket(): Promise<string> {
  const res = await request
    .post('/api/tickets')
    .set('Cookie', supervisorCookie)
    .send({
      subject: 'Bulk action test ticket',
      description: 'Created for bulk endpoint tests.',
      requester: { name: 'Bulk Customer', email: REQUESTER_EMAIL },
      priority_code: 'normal',
      category: 'bug',
      assignee_id: agentAId,
    });
  return res.body.id;
}

/** Walk a ticket to `resolved` through the real endpoint, so state stays consistent. */
async function resolvedTicket(): Promise<string> {
  const id = await newTicket();
  await request.post(`/api/tickets/${id}/status`).set('Cookie', supervisorCookie).send({ status: 'open' });
  await request
    .post(`/api/tickets/${id}/status`)
    .set('Cookie', supervisorCookie)
    .send({ status: 'resolved' });
  return id;
}

function findResult(results: { ticket_id: string }[], id: string) {
  return results.find((r) => r.ticket_id === id);
}

describe('Bulk actions', () => {
  beforeAll(async () => {
    supervisorId = await upsertUser(SUPERVISOR_EMAIL, 'Bulk Supervisor', 'supervisor');
    supervisor2Id = await upsertUser(SUPERVISOR_2_EMAIL, 'Second Supervisor', 'supervisor');
    agentAId = await upsertUser(AGENT_A_EMAIL, 'Bulk Agent A', 'agent');
    agentBId = await upsertUser(AGENT_B_EMAIL, 'Bulk Agent B', 'agent');

    await testPrisma.priorityConfig.upsert({
      where: { code: 'normal' },
      update: {},
      create: { code: 'normal', targetResponseMinutes: 1440, sortOrder: 2 },
    });

    supervisorCookie = await login(SUPERVISOR_EMAIL);
    agentACookie = await login(AGENT_A_EMAIL);
  });

  afterAll(async () => {
    const tickets = await testPrisma.ticket.findMany({
      where: { requester: { email: { startsWith: 'bulk-test-' } } },
      select: { id: true },
    });
    const ids = tickets.map((t) => t.id);

    await purgeTicketEvents(testPrisma, { ticketId: { in: ids } });
    await testPrisma.reply.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.ticketCollaborator.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.ticket.deleteMany({ where: { id: { in: ids } } });
    await testPrisma.requester.deleteMany({ where: { email: { startsWith: 'bulk-test-' } } });
    await testPrisma.user.deleteMany({ where: { email: { startsWith: 'bulk-test-' } } });
    await testPrisma.$disconnect();
  });

  describe('POST /api/tickets/bulk-reassign', () => {
    it('reassigns every ticket in the selection and records each on its timeline', async () => {
      const a = await newTicket();
      const b = await newTicket();

      const res = await request
        .post('/api/tickets/bulk-reassign')
        .set('Cookie', supervisorCookie)
        .send({ ticket_ids: [a, b], assignee_id: agentBId });

      expect(res.status).toBe(200);
      expect(findResult(res.body, a)).toEqual({ ticket_id: a, success: true });
      expect(findResult(res.body, b)).toEqual({ ticket_id: b, success: true });

      const ticketA = await request.get(`/api/tickets/${a}`).set('Cookie', supervisorCookie);
      expect(ticketA.body.assignee.id).toBe(agentBId);
      expect(
        ticketA.body.events.some((e: { event_type: string }) => e.event_type === 'reassignment')
      ).toBe(true);
    });

    it('returns 200 with a mixed report for a batch of valid and invalid ids', async () => {
      const valid = await newTicket();
      const archived = await newTicket();
      await request.post(`/api/tickets/${archived}/archive`).set('Cookie', supervisorCookie);
      const missing = '00000000-0000-0000-0000-000000000000';

      const res = await request
        .post('/api/tickets/bulk-reassign')
        .set('Cookie', supervisorCookie)
        .send({ ticket_ids: [valid, archived, missing], assignee_id: agentBId });

      expect(res.status).toBe(200);
      expect(findResult(res.body, valid)?.success).toBe(true);
      expect(findResult(res.body, archived)).toEqual({
        ticket_id: archived,
        success: false,
        reason: expect.stringContaining('archived'),
      });
      expect(findResult(res.body, missing)).toEqual({
        ticket_id: missing,
        success: false,
        reason: 'Ticket not found',
      });
    });

    it('treats a ticket already held by the target as success in a mixed batch', async () => {
      const alreadyB = await newTicket();
      await request
        .post(`/api/tickets/${alreadyB}/reassign`)
        .set('Cookie', supervisorCookie)
        .send({ assignee_id: agentBId });

      const needsMove = await newTicket(); // still on agent A

      const res = await request
        .post('/api/tickets/bulk-reassign')
        .set('Cookie', supervisorCookie)
        .send({ ticket_ids: [alreadyB, needsMove], assignee_id: agentBId });

      expect(findResult(res.body, alreadyB)).toEqual({ ticket_id: alreadyB, success: true });
      expect(findResult(res.body, needsMove)).toEqual({ ticket_id: needsMove, success: true });
    });

    it('fails the whole request when the target itself is invalid', async () => {
      const a = await newTicket();

      const toOtherSupervisor = await request
        .post('/api/tickets/bulk-reassign')
        .set('Cookie', supervisorCookie)
        .send({ ticket_ids: [a], assignee_id: supervisor2Id });

      expect(toOtherSupervisor.status).toBe(400);
      expect(toOtherSupervisor.body.error).toContain('only be assigned to an agent');

      const unknown = await request
        .post('/api/tickets/bulk-reassign')
        .set('Cookie', supervisorCookie)
        .send({ ticket_ids: [a], assignee_id: '00000000-0000-0000-0000-000000000000' });

      expect(unknown.status).toBe(400);

      // Untouched by either rejected request.
      const check = await request.get(`/api/tickets/${a}`).set('Cookie', supervisorCookie);
      expect(check.body.assignee.id).toBe(agentAId);
    });

    it('lets a supervisor take tickets on personally, as an escalation', async () => {
      const a = await newTicket();

      const res = await request
        .post('/api/tickets/bulk-reassign')
        .set('Cookie', supervisorCookie)
        .send({ ticket_ids: [a], assignee_id: supervisorId });

      expect(findResult(res.body, a)?.success).toBe(true);
    });

    it('de-duplicates a repeated id into one result', async () => {
      const a = await newTicket();

      const res = await request
        .post('/api/tickets/bulk-reassign')
        .set('Cookie', supervisorCookie)
        .send({ ticket_ids: [a, a, a], assignee_id: agentBId });

      expect(res.body.filter((r: { ticket_id: string }) => r.ticket_id === a)).toHaveLength(1);
    });

    it('rejects an empty selection, a missing assignee_id, and an oversized batch', async () => {
      const empty = await request
        .post('/api/tickets/bulk-reassign')
        .set('Cookie', supervisorCookie)
        .send({ ticket_ids: [], assignee_id: agentBId });
      expect(empty.status).toBe(400);

      const a = await newTicket();
      const noTarget = await request
        .post('/api/tickets/bulk-reassign')
        .set('Cookie', supervisorCookie)
        .send({ ticket_ids: [a] });
      expect(noTarget.status).toBe(400);

      const tooMany = await request
        .post('/api/tickets/bulk-reassign')
        .set('Cookie', supervisorCookie)
        .send({ ticket_ids: Array.from({ length: 101 }, (_, i) => `id-${i}`), assignee_id: agentBId });
      expect(tooMany.status).toBe(400);
    });

    it('refuses an agent, and refuses without a session', async () => {
      const a = await newTicket();

      const asAgent = await request
        .post('/api/tickets/bulk-reassign')
        .set('Cookie', agentACookie)
        .send({ ticket_ids: [a], assignee_id: agentBId });
      expect(asAgent.status).toBe(403);

      const anonymous = await request
        .post('/api/tickets/bulk-reassign')
        .send({ ticket_ids: [a], assignee_id: agentBId });
      expect(anonymous.status).toBe(401);
    });

    it('each ticket writes in its own transaction: one failure does not roll back another success', async () => {
      const succeeds = await newTicket();
      const missing = '00000000-0000-0000-0000-000000000000';

      await request
        .post('/api/tickets/bulk-reassign')
        .set('Cookie', supervisorCookie)
        .send({ ticket_ids: [missing, succeeds], assignee_id: agentBId });

      const check = await request.get(`/api/tickets/${succeeds}`).set('Cookie', supervisorCookie);
      expect(check.body.assignee.id).toBe(agentBId);
    });
  });

  describe('POST /api/tickets/bulk-close', () => {
    it('closes every resolved ticket in the selection', async () => {
      const a = await resolvedTicket();
      const b = await resolvedTicket();

      const res = await request
        .post('/api/tickets/bulk-close')
        .set('Cookie', supervisorCookie)
        .send({ ticket_ids: [a, b] });

      expect(res.status).toBe(200);
      expect(findResult(res.body, a)).toEqual({ ticket_id: a, success: true });
      expect(findResult(res.body, b)).toEqual({ ticket_id: b, success: true });

      const check = await request.get(`/api/tickets/${a}`).set('Cookie', supervisorCookie);
      expect(check.body.status).toBe('closed');
    });

    it('reports, rather than skips, a ticket that is not resolved — with the state machine reason', async () => {
      const open = await newTicket();
      await request.post(`/api/tickets/${open}/status`).set('Cookie', supervisorCookie).send({ status: 'open' });

      const closable = await resolvedTicket();

      const res = await request
        .post('/api/tickets/bulk-close')
        .set('Cookie', supervisorCookie)
        .send({ ticket_ids: [open, closable] });

      expect(findResult(res.body, open)).toEqual({
        ticket_id: open,
        success: false,
        reason: 'A ticket cannot move from open to closed',
      });
      expect(findResult(res.body, closable)?.success).toBe(true);
    });

    it('returns a mixed report for archived and missing tickets', async () => {
      const closable = await resolvedTicket();
      const archived = await resolvedTicket();
      await request.post(`/api/tickets/${archived}/archive`).set('Cookie', supervisorCookie);
      const missing = '00000000-0000-0000-0000-000000000000';

      const res = await request
        .post('/api/tickets/bulk-close')
        .set('Cookie', supervisorCookie)
        .send({ ticket_ids: [closable, archived, missing] });

      expect(res.status).toBe(200);
      expect(findResult(res.body, closable)?.success).toBe(true);
      expect(findResult(res.body, archived)?.success).toBe(false);
      expect(findResult(res.body, missing)).toEqual({
        ticket_id: missing,
        success: false,
        reason: 'Ticket not found',
      });
    });

    it('writes exactly one status_change event per closed ticket', async () => {
      const a = await resolvedTicket();
      await request.post('/api/tickets/bulk-close').set('Cookie', supervisorCookie).send({ ticket_ids: [a] });

      const events = await testPrisma.ticketEvent.count({
        where: { ticketId: a, eventType: 'status_change', newValue: 'closed' },
      });
      expect(events).toBe(1);
    });

    it('refuses an agent, and refuses without a session', async () => {
      const a = await resolvedTicket();

      const asAgent = await request
        .post('/api/tickets/bulk-close')
        .set('Cookie', agentACookie)
        .send({ ticket_ids: [a] });
      expect(asAgent.status).toBe(403);

      const anonymous = await request.post('/api/tickets/bulk-close').send({ ticket_ids: [a] });
      expect(anonymous.status).toBe(401);
    });

    it('rejects an empty selection', async () => {
      const res = await request
        .post('/api/tickets/bulk-close')
        .set('Cookie', supervisorCookie)
        .send({ ticket_ids: [] });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/tickets/bulk-collaborators', () => {
    function bulkCollaborators(body: Record<string, unknown>, cookie = supervisorCookie) {
      return request.post('/api/tickets/bulk-collaborators').set('Cookie', cookie).send(body);
    }

    it('adds one agent across the selection and records each on its timeline', async () => {
      const a = await newTicket();
      const b = await newTicket();

      const res = await bulkCollaborators({ ticket_ids: [a, b], agent_id: agentBId, action: 'add' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body.every((r: { success: boolean }) => r.success)).toBe(true);

      for (const id of [a, b]) {
        expect(
          await testPrisma.ticketCollaborator.count({ where: { ticketId: id, agentId: agentBId } })
        ).toBe(1);
        expect(
          await testPrisma.ticketEvent.count({
            where: { ticketId: id, eventType: 'collaborator_added', newValue: agentBId },
          })
        ).toBe(1);
      }
    });

    it('grants the new collaborator access on their very next request', async () => {
      const id = await newTicket();
      const agentBCookie = await login(AGENT_B_EMAIL);

      expect((await request.get(`/api/tickets/${id}`).set('Cookie', agentBCookie)).status).toBe(403);

      await bulkCollaborators({ ticket_ids: [id], agent_id: agentBId, action: 'add' });

      expect((await request.get(`/api/tickets/${id}`).set('Cookie', agentBCookie)).status).toBe(200);
    });

    it('removes the collaborator again, revoking access', async () => {
      const id = await newTicket();
      const agentBCookie = await login(AGENT_B_EMAIL);
      await bulkCollaborators({ ticket_ids: [id], agent_id: agentBId, action: 'add' });

      const res = await bulkCollaborators({ ticket_ids: [id], agent_id: agentBId, action: 'remove' });

      expect(res.status).toBe(200);
      expect(res.body[0].success).toBe(true);
      expect(
        await testPrisma.ticketCollaborator.count({ where: { ticketId: id, agentId: agentBId } })
      ).toBe(0);
      expect((await request.get(`/api/tickets/${id}`).set('Cookie', agentBCookie)).status).toBe(403);
    });

    it('reports per ticket rather than failing the batch on a mixed selection', async () => {
      const already = await newTicket();
      const fresh = await newTicket();
      await bulkCollaborators({ ticket_ids: [already], agent_id: agentBId, action: 'add' });
      const missing = '00000000-0000-0000-0000-000000000000';

      const res = await bulkCollaborators({
        ticket_ids: [already, fresh, missing],
        agent_id: agentBId,
        action: 'add',
      });

      expect(res.status).toBe(200);
      expect(findResult(res.body, fresh)).toEqual({ ticket_id: fresh, success: true });
      // Already a collaborator is reported, not silently counted as success: across a
      // selection that distinction is the difference between "done" and "nothing happened".
      expect(findResult(res.body, already)).toMatchObject({ success: false, reason: expect.stringContaining('already') });
      expect(findResult(res.body, missing)).toMatchObject({ success: false, reason: 'Ticket not found' });
    });

    it('reports removing someone who was never a collaborator', async () => {
      const id = await newTicket();

      const res = await bulkCollaborators({ ticket_ids: [id], agent_id: agentBId, action: 'remove' });

      expect(res.status).toBe(200);
      expect(res.body[0]).toMatchObject({ success: false, reason: expect.stringContaining('not a collaborator') });
      // A refused removal must not leave a history row claiming one happened.
      expect(
        await testPrisma.ticketEvent.count({
          where: { ticketId: id, eventType: 'collaborator_removed' },
        })
      ).toBe(0);
    });

    it('fails the whole request when the target is not an agent', async () => {
      const id = await newTicket();

      const supervisorTarget = await bulkCollaborators({
        ticket_ids: [id],
        agent_id: supervisor2Id,
        action: 'add',
      });
      const unknown = await bulkCollaborators({
        ticket_ids: [id],
        agent_id: '00000000-0000-0000-0000-000000000000',
        action: 'add',
      });

      // The target does not depend on any individual ticket, so a bad one fails up front
      // rather than repeating the same reason on every line.
      expect(supervisorTarget.status).toBe(400);
      expect(unknown.status).toBe(400);
    });

    it('rejects a missing agent_id, an unknown action and an empty selection', async () => {
      const id = await newTicket();

      expect((await bulkCollaborators({ ticket_ids: [id], action: 'add' })).status).toBe(400);
      expect(
        (await bulkCollaborators({ ticket_ids: [id], agent_id: agentBId, action: 'toggle' })).status
      ).toBe(400);
      expect(
        (await bulkCollaborators({ ticket_ids: [], agent_id: agentBId, action: 'add' })).status
      ).toBe(400);
    });

    it('refuses an agent, and refuses without a session', async () => {
      const id = await newTicket();

      const asAgent = await bulkCollaborators(
        { ticket_ids: [id], agent_id: agentBId, action: 'add' },
        agentACookie
      );
      const anonymous = await request
        .post('/api/tickets/bulk-collaborators')
        .send({ ticket_ids: [id], agent_id: agentBId, action: 'add' });

      expect(asAgent.status).toBe(403);
      expect(anonymous.status).toBe(401);
      expect(await testPrisma.ticketCollaborator.count({ where: { ticketId: id, agentId: agentBId } })).toBe(0);
    });
  });

  describe('bulk assignment covers unassigned tickets', () => {
    it('assigns a ticket that nobody holds, not only reassigns held ones', async () => {
      // "Assign" and "reassign" are the same operation — there is one holder either way.
      const res = await request
        .post('/api/tickets')
        .set('Cookie', supervisorCookie)
        .send({
          subject: 'Nobody holds this yet',
          description: 'Left unassigned for triage.',
          requester: { name: 'Bulk Customer', email: REQUESTER_EMAIL },
          priority_code: 'normal',
          category: 'bug',
        });
      const id = res.body.id;
      expect(res.body.assignee).toBeNull();

      const bulk = await request
        .post('/api/tickets/bulk-reassign')
        .set('Cookie', supervisorCookie)
        .send({ ticket_ids: [id], assignee_id: agentBId });

      expect(bulk.status).toBe(200);
      expect(bulk.body[0]).toEqual({ ticket_id: id, success: true });

      const after = await testPrisma.ticket.findUniqueOrThrow({ where: { id } });
      expect(after.assigneeId).toBe(agentBId);

      // The history row records that it came from nobody.
      const event = await testPrisma.ticketEvent.findFirstOrThrow({
        where: { ticketId: id, eventType: 'reassignment' },
      });
      expect(event.oldValue).toBeNull();
      expect(event.newValue).toBe(agentBId);
    });
  });
});
