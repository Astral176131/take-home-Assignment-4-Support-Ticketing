import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../../.env.test') });

import { app } from '../../../app.js';

// Capped small: this file's fixture writes are always awaited sequentially, and
// every test file opens its own pool — left uncapped, running many files together
// (as the full suite does) exhausts Postgres's connection limit.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 2 });
const testPrisma = new PrismaClient({ adapter });
const request = supertest(app);

const PASSWORD = 'testpass123';
const SUPERVISOR_EMAIL = 'agents-test-sup@example.com';
const AGENT_EMAIL = 'agents-test-agent@example.com';

let supervisorCookie: string;
let agentCookie: string;

async function upsertUser(email: string, name: string, role: 'agent' | 'supervisor') {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await testPrisma.user.upsert({
    where: { email },
    update: { passwordHash, role, name },
    create: { email, name, role, passwordHash },
  });
}

async function login(email: string): Promise<string> {
  const res = await request.post('/api/auth/login').send({ email, password: PASSWORD });
  const cookies = res.headers['set-cookie'];
  return Array.isArray(cookies) ? cookies[0] : (cookies as unknown as string);
}

describe('GET /api/agents', () => {
  beforeAll(async () => {
    await upsertUser(SUPERVISOR_EMAIL, 'Agents Supervisor', 'supervisor');
    await upsertUser(AGENT_EMAIL, 'Agents Agent', 'agent');

    supervisorCookie = await login(SUPERVISOR_EMAIL);
    agentCookie = await login(AGENT_EMAIL);
  });

  afterAll(async () => {
    await testPrisma.user.deleteMany({ where: { email: { startsWith: 'agents-test-' } } });
    await testPrisma.$disconnect();
  });

  it('returns agents to a supervisor, sorted by name', async () => {
    const res = await request.get('/api/agents').set('Cookie', supervisorCookie);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(res.body.items.length);
    expect(res.body.items.some((a: { email: string }) => a.email === AGENT_EMAIL)).toBe(true);

    const names = res.body.items.map((a: { name: string }) => a.name);
    expect(names).toEqual([...names].sort());
  });

  it('never includes supervisors, who cannot be assignees or collaborators', async () => {
    const res = await request.get('/api/agents').set('Cookie', supervisorCookie);

    expect(res.body.items.some((a: { email: string }) => a.email === SUPERVISOR_EMAIL)).toBe(false);
  });

  it('returns 403 to an agent and 401 without a cookie', async () => {
    expect((await request.get('/api/agents').set('Cookie', agentCookie)).status).toBe(403);
    expect((await request.get('/api/agents')).status).toBe(401);
  });

  it('exposes no password hashes', async () => {
    const res = await request.get('/api/agents').set('Cookie', supervisorCookie);

    for (const agent of res.body.items) {
      expect(agent.passwordHash).toBeUndefined();
      expect(agent.password_hash).toBeUndefined();
    }
  });
});
