import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';

// Load .env.test
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../.env.test') });

import { checkTicketAccess } from '../../middleware/auth.js';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
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
});
