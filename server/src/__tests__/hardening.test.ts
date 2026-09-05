import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

import { app } from '../app.js';
import { purgeTicketEvents } from '../lib/purgeTicketEvents.js';
import { resetThrottle, THROTTLE } from '../features/auth/loginThrottle.js';

/**
 * The things that are true of the API as a whole rather than of any one feature: how a
 * malformed request is answered, what a browser from another origin is allowed to do, and
 * what a token proves.
 */

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 2 });
const testPrisma = new PrismaClient({ adapter });
const request = supertest(app);

const PASSWORD = 'testpass123';
const AGENT_EMAIL = 'harden-test-agent@example.com';
const DOOMED_EMAIL = 'harden-test-doomed@example.com';

let agentId: string;
let doomedId: string;
let agentCookie: string;
let doomedCookie: string;

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

describe('API hardening', () => {
  beforeAll(async () => {
    agentId = await upsertUser(AGENT_EMAIL, 'Hardening Agent', 'agent');
    doomedId = await upsertUser(DOOMED_EMAIL, 'Doomed Agent', 'agent');
    agentCookie = await login(AGENT_EMAIL);
    doomedCookie = await login(DOOMED_EMAIL);
  });

  afterAll(async () => {
    // Full teardown in dependency order. A ticket created through the API attaches its
    // agent creator as a collaborator, so deleting either the ticket or the user first
    // trips `ticket_collaborators`' foreign keys.
    const tickets = await testPrisma.ticket.findMany({
      where: { requester: { email: { startsWith: 'harden-test-' } } },
      select: { id: true },
    });
    const ids = tickets.map((t) => t.id);

    await purgeTicketEvents(testPrisma, { ticketId: { in: ids } });
    await testPrisma.ticketCollaborator.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.reply.deleteMany({ where: { ticketId: { in: ids } } });
    await testPrisma.ticket.deleteMany({ where: { id: { in: ids } } });
    await testPrisma.requester.deleteMany({ where: { email: { startsWith: 'harden-test-' } } });
    await testPrisma.user.deleteMany({ where: { email: { startsWith: 'harden-test-' } } });
    await testPrisma.$disconnect();
  });

  beforeEach(() => {
    // The counters are process-wide, so one test's failures would otherwise be another's.
    resetThrottle();
  });

  describe('malformed and unknown requests', () => {
    it('answers a malformed JSON body with 400, not 500', () => {
      // body-parser throws an error already carrying status 400 and expose: true. The
      // handler used to flatten every error to 500, blaming the server for a request the
      // client got wrong.
      return request
        .post('/api/tickets')
        .set('Cookie', agentCookie)
        .set('Content-Type', 'application/json')
        .send('{"subject": "unclosed')
        .expect(400);
    });

    it('answers an unknown route with JSON, not an HTML error page', async () => {
      const res = await request.get('/api/definitely-not-a-route').set('Cookie', agentCookie);

      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.body.error).toBe('Not found');
    });

    it('does not advertise the framework, and sets the basic response headers', async () => {
      const res = await request.get('/api/health');

      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });
  });

  describe('cross-origin state changes', () => {
    /**
     * CORS stops an attacker reading a response; it does not stop the request happening.
     * A cross-site form post is a "simple request" — no preflight — so by the time CORS is
     * consulted the side effect has already landed. Most routes are incidentally safe
     * because they need `application/json`, which does force a preflight. The ones taking
     * no body at all were not, and in production the session cookie is SameSite=None
     * because the client and API are genuinely cross-origin, so the browser attaches it.
     */
    it('refuses a state-changing request that claims another origin', async () => {
      const created = await request
        .post('/api/tickets')
        .set('Cookie', agentCookie)
        .send({
          subject: 'Cross-origin target',
          description: 'Should not be archivable from another site.',
          requester: { name: 'Harden Requester', email: 'harden-test-req@example.com' },
          priority_code: 'normal',
          category: 'bug',
          assignee_id: agentId,
        });

      const res = await request
        .post(`/api/tickets/${created.body.id}/archive`)
        .set('Cookie', agentCookie)
        .set('Origin', 'https://evil.example.com')
        .set('Content-Type', 'text/plain')
        .send('');

      expect(res.status).toBe(403);

      // And the side effect must not have happened.
      const after = await testPrisma.ticket.findUniqueOrThrow({ where: { id: created.body.id } });
      expect(after.archivedAt).toBeNull();
    });

    it('allows a read from another origin, since CORS already governs the response', async () => {
      const res = await request
        .get('/api/tickets')
        .set('Cookie', agentCookie)
        .set('Origin', 'https://evil.example.com');

      expect(res.status).toBe(200);
    });

    it('allows a state change with no Origin header at all', async () => {
      // curl, the seed script and this suite send no Origin. Only a browser sets it, and
      // only a browser is subject to the attack.
      const res = await request.post('/api/auth/logout').set('Cookie', agentCookie);
      expect(res.status).toBe(200);
    });
  });

  describe('what a token proves', () => {
    it('refuses a validly-signed token for a user who no longer exists', async () => {
      // The signature only proves this server issued it. Without checking the row, a
      // deleted account keeps working until the token expires an hour later.
      await testPrisma.user.delete({ where: { id: doomedId } });

      const res = await request.get('/api/tickets').set('Cookie', doomedCookie);
      expect(res.status).toBe(401);

      doomedId = await upsertUser(DOOMED_EMAIL, 'Doomed Agent', 'agent');
    });

    it('takes the role from the database, not from the token payload', async () => {
      // Forged with the real secret but claiming a role the user does not hold. Reading
      // the role from the row means a demotion takes effect on the next request rather
      // than at the next login.
      const forged = jwt.sign(
        { userId: agentId, email: AGENT_EMAIL, role: 'supervisor' },
        process.env.JWT_SECRET!
      );

      const res = await request.get('/api/agents').set('Cookie', `token=${forged}`);
      expect(res.status).toBe(403);
    });
  });

  describe('login throttling', () => {
    it('refuses further attempts for one email after repeated failures', async () => {
      const attempts: number[] = [];
      for (let i = 0; i < THROTTLE.MAX_FAILURES_PER_EMAIL + 1; i++) {
        const res = await request.post('/api/auth/login').send({ email: AGENT_EMAIL, password: 'wrong' });
        attempts.push(res.status);
      }

      expect(attempts.slice(0, THROTTLE.MAX_FAILURES_PER_EMAIL)).toEqual(
        Array(THROTTLE.MAX_FAILURES_PER_EMAIL).fill(401)
      );
      expect(attempts[attempts.length - 1]).toBe(429);

      // Refused before the password is checked, so the right password does not get in
      // either while the window is open.
      const blocked = await request.post('/api/auth/login').send({ email: AGENT_EMAIL, password: PASSWORD });
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('clears the count on a successful sign-in', async () => {
      for (let i = 0; i < 3; i++) {
        await request.post('/api/auth/login').send({ email: AGENT_EMAIL, password: 'wrong' });
      }

      const ok = await request.post('/api/auth/login').send({ email: AGENT_EMAIL, password: PASSWORD });
      expect(ok.status).toBe(200);

      // Someone who mistypes a few times and then gets it right is not left throttled.
      for (let i = 0; i < THROTTLE.MAX_FAILURES_PER_EMAIL - 1; i++) {
        const res = await request.post('/api/auth/login').send({ email: AGENT_EMAIL, password: 'wrong' });
        expect(res.status).toBe(401);
      }
    });

    it('throttles one email without locking out a different one', async () => {
      for (let i = 0; i < THROTTLE.MAX_FAILURES_PER_EMAIL; i++) {
        await request.post('/api/auth/login').send({ email: AGENT_EMAIL, password: 'wrong' });
      }

      expect(
        (await request.post('/api/auth/login').send({ email: AGENT_EMAIL, password: PASSWORD })).status
      ).toBe(429);

      // Counting only per IP would let one person's typos lock out everyone sharing an
      // office NAT; counting only per email lets anyone lock a colleague out on purpose.
      expect(
        (await request.post('/api/auth/login').send({ email: DOOMED_EMAIL, password: PASSWORD })).status
      ).toBe(200);
    });
  });
});
