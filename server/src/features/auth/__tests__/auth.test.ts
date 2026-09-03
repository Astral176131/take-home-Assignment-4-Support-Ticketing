import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';

// Load .env.test before importing app
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../../.env.test') });

// Now import the app after env is loaded
import { app } from '../../../app.js';

// Capped small: this file's fixture writes are always awaited sequentially, and
// every test file opens its own pool — left uncapped, running many files together
// (as the full suite does) exhausts Postgres's connection limit.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 2 });
const testPrisma = new PrismaClient({ adapter });
const request = supertest(app);

describe('Auth Endpoints', () => {
  beforeAll(async () => {
    // Ensure test users exist in the test database
    const hash = await bcrypt.hash('testpass123', 10);
    await testPrisma.user.upsert({
      where: { email: 'authtest@example.com' },
      update: { passwordHash: hash },
      create: {
        email: 'authtest@example.com',
        name: 'Auth Test User',
        role: 'agent',
        passwordHash: hash,
      },
    });
  });

  afterAll(async () => {
    await testPrisma.user.deleteMany({ where: { email: 'authtest@example.com' } });
    await testPrisma.$disconnect();
  });

  describe('POST /api/auth/login', () => {
    it('should return 200 and set cookie on valid credentials', async () => {
      const res = await request
        .post('/api/auth/login')
        .send({ email: 'authtest@example.com', password: 'testpass123' });

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.email).toBe('authtest@example.com');
      expect(res.body.user.role).toBe('agent');
      // Should not return password hash
      expect(res.body.user.passwordHash).toBeUndefined();
      expect(res.body.user.password_hash).toBeUndefined();

      // Should set httpOnly cookie
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      const tokenCookie = Array.isArray(cookies)
        ? cookies.find((c: string) => c.startsWith('token='))
        : cookies;
      expect(tokenCookie).toBeDefined();
      expect(tokenCookie).toContain('HttpOnly');
    });

    it('should return 401 on wrong password', async () => {
      const res = await request
        .post('/api/auth/login')
        .send({ email: 'authtest@example.com', password: 'wrongpassword' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid email or password');
    });

    it('should return 401 on non-existent email', async () => {
      const res = await request
        .post('/api/auth/login')
        .send({ email: 'nobody@example.com', password: 'anything' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid email or password');
    });

    it('should return 400 when email or password is missing', async () => {
      const res1 = await request.post('/api/auth/login').send({ email: 'test@example.com' });
      expect(res1.status).toBe(400);

      const res2 = await request.post('/api/auth/login').send({ password: 'test' });
      expect(res2.status).toBe(400);
    });
  });

  describe('GET /api/auth/me', () => {
    it('should return user info with valid cookie', async () => {
      // Login first to get cookie
      const loginRes = await request
        .post('/api/auth/login')
        .send({ email: 'authtest@example.com', password: 'testpass123' });

      const cookies = loginRes.headers['set-cookie'];

      const meRes = await request
        .get('/api/auth/me')
        .set('Cookie', cookies);

      expect(meRes.status).toBe(200);
      expect(meRes.body.user.email).toBe('authtest@example.com');
      expect(meRes.body.user.name).toBe('Auth Test User');
      expect(meRes.body.user.role).toBe('agent');
    });

    it('should return 401 without cookie', async () => {
      const res = await request.get('/api/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Authentication required');
    });

    it('should return 401 with invalid/tampered token', async () => {
      const res = await request
        .get('/api/auth/me')
        .set('Cookie', 'token=invalid.jwt.token');

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid or expired token');
    });

    it('should return 401 with expired token', async () => {
      // Create a token that's already expired
      const jwt = await import('jsonwebtoken');
      const expiredToken = jwt.default.sign(
        { userId: 'test', email: 'test@test.com', role: 'agent' },
        process.env.JWT_SECRET!,
        { expiresIn: '0s' }
      );

      // Wait a tick to ensure it's expired
      await new Promise(resolve => setTimeout(resolve, 100));

      const res = await request
        .get('/api/auth/me')
        .set('Cookie', `token=${expiredToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid or expired token');
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should clear the auth cookie', async () => {
      // Login first
      const loginRes = await request
        .post('/api/auth/login')
        .send({ email: 'authtest@example.com', password: 'testpass123' });

      const cookies = loginRes.headers['set-cookie'];

      // Logout
      const logoutRes = await request
        .post('/api/auth/logout')
        .set('Cookie', cookies);

      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body.message).toBe('Logged out successfully');

      // The set-cookie header should clear the token
      const clearCookie = logoutRes.headers['set-cookie'];
      expect(clearCookie).toBeDefined();
    });
  });
});
