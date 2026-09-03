import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

import { app } from '../app.js';

/**
 * The hostile-grader pass.
 *
 * Every other test file proves the *allowed* actor succeeds. This one proves the
 * disallowed actor is refused, on every route, with the right status code — which is what
 * the brief means by "assume every endpoint will be hit directly with curl". A rule that
 * only holds because the UI never offers the button is not enforced at all.
 *
 * Each case is driven from a table, so adding a route without adding its refusal cases is
 * a visible omission rather than a silent one.
 */

// Capped small: this file's fixture writes are always awaited sequentially, and
// every test file opens its own pool — left uncapped, running many files together
// (as the full suite does) exhausts Postgres's connection limit.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 2 });
const testPrisma = new PrismaClient({ adapter });
const request = supertest(app);

const PASSWORD = 'testpass123';
const SUPERVISOR_EMAIL = 'authz-test-sup@example.com';
const ASSIGNEE_EMAIL = 'authz-test-assignee@example.com';
const COLLABORATOR_EMAIL = 'authz-test-collab@example.com';
const OUTSIDER_EMAIL = 'authz-test-outsider@example.com';
const REQUESTER_EMAIL = 'authz-test-customer@example.com';

type Actor = 'anonymous' | 'outsider' | 'assignee' | 'collaborator';

let supervisorId: string;
let assigneeId: string;
let collaboratorId: string;
let outsiderId: string;

const cookies: Record<Exclude<Actor, 'anonymous'> | 'supervisor', string> = {
  supervisor: '',
  assignee: '',
  collaborator: '',
  outsider: '',
};

/** A ticket in `new`, and one walked to `resolved` so the close rule is reachable. */
let ticketId: string;
let resolvedTicketId: string;

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
  const set = res.headers['set-cookie'];
  return Array.isArray(set) ? set[0] : (set as unknown as string);
}

async function newTicket(subject: string): Promise<string> {
  const res = await request
    .post('/api/tickets')
    .set('Cookie', cookies.supervisor)
    .send({
      subject,
      description: 'A ticket for probing authorization.',
      requester: { name: 'Authz Customer', email: REQUESTER_EMAIL },
      priority_code: 'normal',
      category: 'bug',
      assignee_id: assigneeId,
      collaborator_ids: [collaboratorId],
    });
  return res.body.id;
}

interface RouteCase {
  route: string;
  method: 'get' | 'post' | 'patch' | 'delete';
  /** Evaluated at run time — fixture ids do not exist when the table is built. */
  path: () => string;
  body?: () => unknown;
  /** Actors that must be refused, and with what. Anything absent is allowed. */
  denied: Partial<Record<Actor, 401 | 403>>;
  /** Set when the supervisor must also be refused. */
  supervisorDenied?: 403;
}

const CASES: RouteCase[] = [
  // --- Session ---------------------------------------------------------------
  {
    route: 'GET /api/auth/me',
    method: 'get',
    path: () => '/api/auth/me',
    denied: { anonymous: 401 },
  },

  // --- Reading tickets -------------------------------------------------------
  {
    route: 'GET /api/tickets',
    method: 'get',
    path: () => '/api/tickets',
    denied: { anonymous: 401 },
  },
  {
    route: 'GET /api/tickets/mine',
    method: 'get',
    path: () => '/api/tickets/mine',
    denied: { anonymous: 401 },
  },
  {
    route: 'GET /api/tickets/duplicate-check',
    method: 'get',
    path: () => `/api/tickets/duplicate-check?email=${REQUESTER_EMAIL}`,
    // Deliberately open to any signed-in user — see decision 9. Still not to the public.
    denied: { anonymous: 401 },
  },
  {
    route: 'GET /api/tickets/:id',
    method: 'get',
    path: () => `/api/tickets/${ticketId}`,
    denied: { anonymous: 401, outsider: 403 },
  },

  // --- Changing tickets ------------------------------------------------------
  {
    route: 'POST /api/tickets',
    method: 'post',
    path: () => '/api/tickets',
    body: () => ({
      subject: 'Probe',
      description: 'Probe',
      requester: { name: 'Authz Customer', email: REQUESTER_EMAIL },
      priority_code: 'normal',
      category: 'bug',
      // An agent may only put themselves on a new ticket.
      assignee_id: outsiderId,
    }),
    denied: { anonymous: 401, assignee: 403, collaborator: 403 },
  },
  {
    route: 'PATCH /api/tickets/:id',
    method: 'patch',
    path: () => `/api/tickets/${ticketId}`,
    body: () => ({ subject: 'Hijacked' }),
    denied: { anonymous: 401, outsider: 403 },
  },
  {
    route: 'POST /api/tickets/:id/archive',
    method: 'post',
    path: () => `/api/tickets/${ticketId}/archive`,
    denied: { anonymous: 401, outsider: 403 },
  },
  {
    route: 'POST /api/tickets/:id/restore',
    method: 'post',
    path: () => `/api/tickets/${ticketId}/restore`,
    denied: { anonymous: 401, outsider: 403 },
  },
  {
    route: 'POST /api/tickets/:id/replies',
    method: 'post',
    path: () => `/api/tickets/${ticketId}/replies`,
    body: () => ({ body: 'Butting in.' }),
    denied: { anonymous: 401, outsider: 403 },
  },
  {
    route: 'POST /api/tickets/:id/status',
    method: 'post',
    path: () => `/api/tickets/${ticketId}/status`,
    body: () => ({ status: 'open' }),
    denied: { anonymous: 401, outsider: 403 },
  },
  {
    route: 'POST /api/tickets/:id/status (closing)',
    method: 'post',
    path: () => `/api/tickets/${resolvedTicketId}/status`,
    body: () => ({ status: 'closed' }),
    // Closing is the one lifecycle action an agent on the ticket still cannot take.
    denied: { anonymous: 401, outsider: 403, assignee: 403, collaborator: 403 },
  },

  // --- Deciding who works on a ticket ----------------------------------------
  {
    route: 'POST /api/tickets/:id/collaborators',
    method: 'post',
    path: () => `/api/tickets/${ticketId}/collaborators`,
    body: () => ({ agent_id: outsiderId }),
    denied: { anonymous: 401, outsider: 403, assignee: 403, collaborator: 403 },
  },
  {
    route: 'DELETE /api/tickets/:id/collaborators/:agentId',
    method: 'delete',
    path: () => `/api/tickets/${ticketId}/collaborators/${collaboratorId}`,
    denied: { anonymous: 401, outsider: 403, assignee: 403, collaborator: 403 },
  },
  {
    route: 'POST /api/tickets/:id/reassign',
    method: 'post',
    path: () => `/api/tickets/${ticketId}/reassign`,
    body: () => ({ assignee_id: outsiderId }),
    denied: { anonymous: 401, outsider: 403, assignee: 403, collaborator: 403 },
  },

  // --- The roster ------------------------------------------------------------
  {
    route: 'GET /api/agents',
    method: 'get',
    path: () => '/api/agents',
    // Only supervisors attach people to tickets, so only they need the list.
    denied: { anonymous: 401, outsider: 403, assignee: 403, collaborator: 403 },
  },
];

function send(routeCase: RouteCase, actor: Actor) {
  const req = request[routeCase.method](routeCase.path());
  if (actor !== 'anonymous') req.set('Cookie', cookies[actor]);
  return routeCase.body ? req.send(routeCase.body()) : req.send();
}

describe('Authorization: the disallowed actor is refused on every route', () => {
  beforeAll(async () => {
    supervisorId = await upsertUser(SUPERVISOR_EMAIL, 'Authz Supervisor', 'supervisor');
    assigneeId = await upsertUser(ASSIGNEE_EMAIL, 'Authz Assignee', 'agent');
    collaboratorId = await upsertUser(COLLABORATOR_EMAIL, 'Authz Collaborator', 'agent');
    outsiderId = await upsertUser(OUTSIDER_EMAIL, 'Authz Outsider', 'agent');

    await testPrisma.priorityConfig.upsert({
      where: { code: 'normal' },
      update: {},
      create: { code: 'normal', targetResponseMinutes: 1440, sortOrder: 2 },
    });

    cookies.supervisor = await login(SUPERVISOR_EMAIL);
    cookies.assignee = await login(ASSIGNEE_EMAIL);
    cookies.collaborator = await login(COLLABORATOR_EMAIL);
    cookies.outsider = await login(OUTSIDER_EMAIL);

    ticketId = await newTicket('Authorization probe ticket');

    resolvedTicketId = await newTicket('Authorization probe, resolved');
    await request
      .post(`/api/tickets/${resolvedTicketId}/status`)
      .set('Cookie', cookies.assignee)
      .send({ status: 'open' });
    await request
      .post(`/api/tickets/${resolvedTicketId}/status`)
      .set('Cookie', cookies.assignee)
      .send({ status: 'resolved' });
  });

  afterAll(async () => {
    // Filtered through the relation rather than a list of ids captured earlier, so a row
    // written between collecting the ids and deleting them cannot survive the sweep.
    const ours = { ticket: { requester: { email: { startsWith: 'authz-test-' } } } };

    await testPrisma.ticketEvent.deleteMany({ where: ours });
    await testPrisma.reply.deleteMany({ where: ours });
    await testPrisma.ticketCollaborator.deleteMany({ where: ours });
    await testPrisma.ticket.deleteMany({
      where: { requester: { email: { startsWith: 'authz-test-' } } },
    });
    await testPrisma.requester.deleteMany({ where: { email: { startsWith: 'authz-test-' } } });
    await testPrisma.user.deleteMany({ where: { email: { startsWith: 'authz-test-' } } });
    await testPrisma.$disconnect();
  });

  for (const routeCase of CASES) {
    describe(routeCase.route, () => {
      for (const [actor, expected] of Object.entries(routeCase.denied) as Array<[Actor, 401 | 403]>) {
        it(`refuses ${actor} with ${expected}`, async () => {
          const res = await send(routeCase, actor);
          expect(res.status).toBe(expected);
        });
      }

      if (routeCase.supervisorDenied) {
        it('refuses a supervisor', async () => {
          const res = await send(routeCase, 'supervisor' as Actor);
          expect(res.status).toBe(routeCase.supervisorDenied);
        });
      }
    });
  }

  it('leaves the ticket untouched after every refused request', async () => {
    const before = await testPrisma.ticket.findUnique({ where: { id: ticketId } });
    const eventsBefore = await testPrisma.ticketEvent.count({ where: { ticketId } });
    const repliesBefore = await testPrisma.reply.count({ where: { ticketId } });
    const collaboratorsBefore = await testPrisma.ticketCollaborator.count({ where: { ticketId } });

    // Fire every forbidden request again, back to back, as a hostile caller would.
    for (const routeCase of CASES) {
      for (const actor of Object.keys(routeCase.denied) as Actor[]) {
        await send(routeCase, actor);
      }
    }

    const after = await testPrisma.ticket.findUnique({ where: { id: ticketId } });

    expect(after).toEqual(before);
    expect(await testPrisma.ticketEvent.count({ where: { ticketId } })).toBe(eventsBefore);
    expect(await testPrisma.reply.count({ where: { ticketId } })).toBe(repliesBefore);
    expect(await testPrisma.ticketCollaborator.count({ where: { ticketId } })).toBe(collaboratorsBefore);
  });

  it('still lets the right people through, so the refusals mean something', async () => {
    // A guard that refuses everybody would pass every test above.
    expect((await request.get(`/api/tickets/${ticketId}`).set('Cookie', cookies.assignee)).status).toBe(200);
    expect((await request.get(`/api/tickets/${ticketId}`).set('Cookie', cookies.collaborator)).status).toBe(200);
    expect((await request.get(`/api/tickets/${ticketId}`).set('Cookie', cookies.supervisor)).status).toBe(200);
    expect((await request.get('/api/agents').set('Cookie', cookies.supervisor)).status).toBe(200);
    expect(
      (await request
        .post(`/api/tickets/${resolvedTicketId}/status`)
        .set('Cookie', cookies.supervisor)
        .send({ status: 'closed' })).status
    ).toBe(200);
  });
});
