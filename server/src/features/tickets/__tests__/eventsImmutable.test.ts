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

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 2 });
const testPrisma = new PrismaClient({ adapter });
const request = supertest(app);

const PASSWORD = 'testpass123';
const SUPERVISOR_EMAIL = 'events-immutable-test-sup@example.com';
const AGENT_EMAIL = 'events-immutable-test-agent@example.com';
const REQUESTER_EMAIL = 'events-immutable-test-customer@example.com';

let supervisorCookie: string;
let ticketId: string;
let eventId: string;

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

/**
 * The database-level backstop for Goal 9: even the application's own database
 * credentials — the same ones every route uses — cannot rewrite or erase history. This is
 * deliberately proven with a raw Prisma call bypassing the API entirely, not an HTTP
 * request, since there is no route to even attempt this through and the point is that the
 * restriction holds regardless of which code is asking.
 */
describe('ticket_events is append-only at the database level', () => {
  beforeAll(async () => {
    const agentId = await upsertUser(AGENT_EMAIL, 'Immutable Agent', 'agent');
    await upsertUser(SUPERVISOR_EMAIL, 'Immutable Supervisor', 'supervisor');
    await testPrisma.priorityConfig.upsert({
      where: { code: 'normal' },
      update: {},
      create: { code: 'normal', targetResponseMinutes: 1440, sortOrder: 2 },
    });

    supervisorCookie = await login(SUPERVISOR_EMAIL);
    const created = await request
      .post('/api/tickets')
      .set('Cookie', supervisorCookie)
      .send({
        subject: 'Immutability test ticket',
        description: 'Created to prove its history cannot be rewritten.',
        requester: { name: 'Immutable Customer', email: REQUESTER_EMAIL },
        priority_code: 'normal',
        category: 'bug',
        assignee_id: agentId,
      });
    ticketId = created.body.id;

    // A supervisor-created ticket has no incidental event to reuse (decision 3), so a
    // known one is created directly — the point of this file is proving the trigger,
    // not deriving a fixture from unrelated behaviour.
    const event = await testPrisma.ticketEvent.create({
      data: { ticketId, eventType: 'archived', actorId: null },
    });
    eventId = event.id;
  });

  afterAll(async () => {
    // Exercises the escape hatch itself as real cleanup, not a special case — proving it
    // works is exactly what lets every other test file's afterAll keep functioning.
    await purgeTicketEvents(testPrisma, { ticketId });
    await testPrisma.ticketCollaborator.deleteMany({ where: { ticketId } });
    await testPrisma.ticket.deleteMany({ where: { id: ticketId } });
    await testPrisma.requester.deleteMany({ where: { email: REQUESTER_EMAIL } });
    await testPrisma.user.deleteMany({
      where: { email: { in: [SUPERVISOR_EMAIL, AGENT_EMAIL] } },
    });
    await testPrisma.$disconnect();
  });

  it('refuses to update an event row, even for the application\'s own database role', async () => {
    await expect(
      testPrisma.ticketEvent.update({ where: { id: eventId }, data: { oldValue: 'tampered' } })
    ).rejects.toThrow(/append-only/);
  });

  it('refuses to delete an event row the same way', async () => {
    await expect(testPrisma.ticketEvent.delete({ where: { id: eventId } })).rejects.toThrow(/append-only/);
  });

  it('leaves the row completely unchanged after a rejected update', async () => {
    const row = await testPrisma.ticketEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.oldValue).not.toBe('tampered');
  });

  it('purgeTicketEvents can clear rows via the escape hatch, and leaves the trigger re-armed afterward', async () => {
    // A disposable row, separate from the one the other tests in this file still need.
    const disposable = await testPrisma.ticket.create({
      data: {
        subject: 'Disposable',
        description: 'For the escape-hatch check only.',
        requesterId: (await testPrisma.requester.findUniqueOrThrow({ where: { email: REQUESTER_EMAIL } })).id,
        priorityCode: 'normal',
        category: 'bug',
      },
    });
    await testPrisma.ticketEvent.create({
      data: { ticketId: disposable.id, eventType: 'archived', actorId: null },
    });

    await purgeTicketEvents(testPrisma, { ticketId: disposable.id });
    expect(await testPrisma.ticketEvent.count({ where: { ticketId: disposable.id } })).toBe(0);

    // The trigger must be back on immediately after — not left disabled by the helper.
    await testPrisma.ticketEvent.create({
      data: { ticketId: disposable.id, eventType: 'archived', actorId: null },
    });
    const stillGuarded = await testPrisma.ticketEvent.findFirstOrThrow({ where: { ticketId: disposable.id } });
    await expect(
      testPrisma.ticketEvent.delete({ where: { id: stillGuarded.id } })
    ).rejects.toThrow(/append-only/);

    // Clean up this disposable ticket properly, now that the trigger is confirmed re-armed.
    await purgeTicketEvents(testPrisma, { ticketId: disposable.id });
    await testPrisma.ticket.delete({ where: { id: disposable.id } });
  });
});
