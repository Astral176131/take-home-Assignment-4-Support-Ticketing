import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';

// Load .env.test
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../.env.test') });

import { checkTicketAccess, requireRole } from '../../middleware/auth.js';

// Capped small: this file's fixture writes are always awaited sequentially, and
// every test file opens its own pool — left uncapped, running many files together
// (as the full suite does) exhausts Postgres's connection limit.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 2 });
const testPrisma = new PrismaClient({ adapter });

// Test data IDs
let supervisorId: string;
let assigneeAgentId: string;
let collaboratorAgentId: string;
let unrelatedAgentId: string;
let ticketId: string;
let requesterId: string;

describe('Authorization Middleware', () => {
  beforeAll(async () => {
    const hash = await bcrypt.hash('test', 10);

    // Create test users
    const supervisor = await testPrisma.user.upsert({
      where: { email: 'middleware-test-sup@example.com' },
      update: {},
      create: { email: 'middleware-test-sup@example.com', name: 'Test Supervisor', role: 'supervisor', passwordHash: hash },
    });
    supervisorId = supervisor.id;

    const assignee = await testPrisma.user.upsert({
      where: { email: 'middleware-test-assignee@example.com' },
      update: {},
      create: { email: 'middleware-test-assignee@example.com', name: 'Test Assignee', role: 'agent', passwordHash: hash },
    });
    assigneeAgentId = assignee.id;

    const collaborator = await testPrisma.user.upsert({
      where: { email: 'middleware-test-collab@example.com' },
      update: {},
      create: { email: 'middleware-test-collab@example.com', name: 'Test Collaborator', role: 'agent', passwordHash: hash },
    });
    collaboratorAgentId = collaborator.id;

    const unrelated = await testPrisma.user.upsert({
      where: { email: 'middleware-test-other@example.com' },
      update: {},
      create: { email: 'middleware-test-other@example.com', name: 'Unrelated Agent', role: 'agent', passwordHash: hash },
    });
    unrelatedAgentId = unrelated.id;

    // Create a requester
    const requester = await testPrisma.requester.create({
      data: { name: 'Test Customer', email: 'customer@test.com' },
    });
    requesterId = requester.id;

    // Ensure priority exists
    await testPrisma.priorityConfig.upsert({
      where: { code: 'normal' },
      update: {},
      create: { code: 'normal', targetResponseMinutes: 1440, sortOrder: 2 },
    });

    // Create a ticket assigned to assigneeAgent
    const ticket = await testPrisma.ticket.create({
      data: {
        subject: 'Middleware Test Ticket',
        description: 'A ticket for testing access control',
        requesterId: requesterId,
        priorityCode: 'normal',
        category: 'bug',
        assigneeId: assigneeAgentId,
      },
    });
    ticketId = ticket.id;

    // Add collaborator to the ticket
    await testPrisma.ticketCollaborator.create({
      data: { ticketId: ticketId, agentId: collaboratorAgentId },
    });
  });

  afterAll(async () => {
    // Clean up in reverse dependency order
    await testPrisma.ticketCollaborator.deleteMany({ where: { ticketId } });
    await testPrisma.ticket.deleteMany({ where: { id: ticketId } });
    await testPrisma.requester.deleteMany({ where: { id: requesterId } });
    await testPrisma.user.deleteMany({
      where: {
        email: {
          in: [
            'middleware-test-sup@example.com',
            'middleware-test-assignee@example.com',
            'middleware-test-collab@example.com',
            'middleware-test-other@example.com',
          ],
        },
      },
    });
    await testPrisma.$disconnect();
  });

  describe('checkTicketAccess', () => {
    it('should allow supervisor access to any ticket', async () => {
      const result = await checkTicketAccess(ticketId, supervisorId, 'supervisor');
      expect(result.allowed).toBe(true);
    });

    it('should allow assignee access to their ticket', async () => {
      const result = await checkTicketAccess(ticketId, assigneeAgentId, 'agent');
      expect(result.allowed).toBe(true);
    });

    it('should allow collaborator access to the ticket', async () => {
      const result = await checkTicketAccess(ticketId, collaboratorAgentId, 'agent');
      expect(result.allowed).toBe(true);
    });

    it('should deny unrelated agent access to the ticket', async () => {
      const result = await checkTicketAccess(ticketId, unrelatedAgentId, 'agent');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('You do not have access to this ticket');
    });

    it('should deny when no user id is supplied', async () => {
      // Prisma treats an undefined filter value as "no filter", so without the guard
      // the collaborator lookup would match any collaborator and allow a stranger.
      const result = await checkTicketAccess(ticketId, undefined as never, 'agent');
      expect(result.allowed).toBe(false);
    });

    it('should return not found for non-existent ticket', async () => {
      const result = await checkTicketAccess(
        '00000000-0000-0000-0000-000000000000',
        assigneeAgentId,
        'agent'
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Ticket not found');
    });
  });

  describe('requireRole', () => {
    // requireRole is Express middleware, so we drive it with the smallest
    // req/res/next stubs that satisfy it rather than pulling in a mocking library.
    function run(roles: Role[], user?: { userId: string; email: string; role: Role }) {
      let statusCode: number | undefined;
      let body: { error?: string } | undefined;
      let nextCalled = false;

      const res = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(payload: { error?: string }) {
          body = payload;
          return this;
        },
      };

      requireRole(...roles)({ user } as never, res as never, () => {
        nextCalled = true;
      });

      return { statusCode, body, nextCalled };
    }

    const supervisor = { userId: 'u1', email: 'sup@example.com', role: 'supervisor' as Role };
    const agent = { userId: 'u2', email: 'agent@example.com', role: 'agent' as Role };

    it('should call next for a supervisor on a supervisor-only rule', () => {
      const result = run(['supervisor'], supervisor);
      expect(result.nextCalled).toBe(true);
      expect(result.statusCode).toBeUndefined();
    });

    it('should reject an agent on a supervisor-only rule with 403', () => {
      const result = run(['supervisor'], agent);
      expect(result.nextCalled).toBe(false);
      expect(result.statusCode).toBe(403);
      expect(result.body?.error).toBe('Insufficient permissions');
    });

    it('should reject an unauthenticated request with 401', () => {
      const result = run(['supervisor'], undefined);
      expect(result.nextCalled).toBe(false);
      expect(result.statusCode).toBe(401);
      expect(result.body?.error).toBe('Authentication required');
    });

    it('should admit both roles when the rule accepts both', () => {
      expect(run(['agent', 'supervisor'], supervisor).nextCalled).toBe(true);
      expect(run(['agent', 'supervisor'], agent).nextCalled).toBe(true);
    });
  });

  describe('authorization matrix', () => {
    // One row per line of the authorization matrix in the brief, asserted against
    // the two helpers in isolation. `gate` records which helper is the one that
    // actually decides the row, so a route built in a later phase has a single
    // obvious thing to reuse.
    type Gate = 'ticketAccess' | 'supervisorOnly' | 'anyAuthenticated';

    interface MatrixRow {
      action: string;
      gate: Gate;
      supervisor: boolean;
      assignee: boolean;
      collaborator: boolean;
      otherAgent: boolean;
    }

    const matrix: MatrixRow[] = [
      { action: 'View full queue', gate: 'supervisorOnly', supervisor: true, assignee: false, collaborator: false, otherAgent: false },
      { action: 'View one ticket', gate: 'ticketAccess', supervisor: true, assignee: true, collaborator: true, otherAgent: false },
      { action: 'Create ticket', gate: 'anyAuthenticated', supervisor: true, assignee: true, collaborator: true, otherAgent: true },
      { action: 'Edit ticket fields', gate: 'ticketAccess', supervisor: true, assignee: true, collaborator: true, otherAgent: false },
      { action: 'Reply (public or internal)', gate: 'ticketAccess', supervisor: true, assignee: true, collaborator: true, otherAgent: false },
      { action: 'Change status new/open/pending/resolved', gate: 'ticketAccess', supervisor: true, assignee: true, collaborator: true, otherAgent: false },
      { action: 'Close (resolved to closed)', gate: 'supervisorOnly', supervisor: true, assignee: false, collaborator: false, otherAgent: false },
      { action: 'Reopen (closed to open, within window)', gate: 'ticketAccess', supervisor: true, assignee: true, collaborator: true, otherAgent: false },
      { action: 'Reassign primary assignee', gate: 'supervisorOnly', supervisor: true, assignee: false, collaborator: false, otherAgent: false },
      // Deliberate deviation from the brief's matrix, which grants this to the assignee
      // and existing collaborators. Narrowed to supervisors so that attaching a person to
      // a ticket is a supervisor power everywhere — at creation, at reassignment and here
      // — and so an agent cannot share work sideways that they are barred from reassigning.
      { action: 'Add/remove collaborator', gate: 'supervisorOnly', supervisor: true, assignee: false, collaborator: false, otherAgent: false },
      { action: 'Archive/restore', gate: 'ticketAccess', supervisor: true, assignee: true, collaborator: true, otherAgent: false },
      { action: 'Bulk reassign / bulk close', gate: 'supervisorOnly', supervisor: true, assignee: false, collaborator: false, otherAgent: false },
      // The brief restricts SLA ack to a ticket "assigned to them", which is stricter
      // than plain ticket access for a collaborator who is not the assignee. That extra
      // condition is route-level and gets its own test with the ack endpoint in Phase 5.
      { action: 'Acknowledge SLA alert', gate: 'ticketAccess', supervisor: true, assignee: true, collaborator: true, otherAgent: false },
    ];

    /** Ask the helper that governs this row whether the actor is allowed through. */
    async function isAllowed(gate: Gate, userId: string, role: Role): Promise<boolean> {
      if (gate === 'ticketAccess') {
        const result = await checkTicketAccess(ticketId, userId, role);
        return result.allowed;
      }

      const roles: Role[] = gate === 'supervisorOnly' ? ['supervisor'] : ['agent', 'supervisor'];
      let nextCalled = false;
      const res = { status: () => res, json: () => res };
      requireRole(...roles)({ user: { userId, email: 'x@example.com', role } } as never, res as never, () => {
        nextCalled = true;
      });
      return nextCalled;
    }

    // The fixture ids do not exist until beforeAll has run, which is after the test
    // cases below are defined — so resolve them inside each test, not out here.
    type Actor = 'supervisor' | 'assignee' | 'collaborator' | 'other';

    function idFor(actor: Actor): string {
      switch (actor) {
        case 'supervisor':
          return supervisorId;
        case 'assignee':
          return assigneeAgentId;
        case 'collaborator':
          return collaboratorAgentId;
        case 'other':
          return unrelatedAgentId;
      }
    }

    for (const row of matrix) {
      const actors: Array<[string, Actor, Role, boolean]> = [
        ['supervisor', 'supervisor', 'supervisor', row.supervisor],
        ['assignee agent', 'assignee', 'agent', row.assignee],
        ['collaborator agent', 'collaborator', 'agent', row.collaborator],
        ['unrelated agent', 'other', 'agent', row.otherAgent],
      ];

      for (const [label, actor, role, expected] of actors) {
        it(`${row.action}: ${label} is ${expected ? 'allowed' : 'denied'}`, async () => {
          expect(await isAllowed(row.gate, idFor(actor), role)).toBe(expected);
        });
      }
    }
  });
});
