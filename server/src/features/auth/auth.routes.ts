import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { cookieOptions, getJwtSecret } from '../../lib/jwt.js';
import {
  clearFailures,
  isThrottled,
  recordFailure,
  retryAfterSeconds,
  throttleKeysFor,
} from './loginThrottle.js';

const router = Router();

const JWT_TTL = '1h'; // 1 hour
const COOKIE_MAX_AGE = 3600000; // 1 hour in milliseconds

/**
 * POST /api/auth/login
 * Accepts { email, password } and returns user info + sets JWT cookie.
 */
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body ?? {};

  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  // Both keys, so neither spreading guesses across addresses nor hammering one address
  // slips through. See loginThrottle.ts for why the two limits differ.
  const throttleKeys = throttleKeysFor(req.ip ?? 'unknown', email);

  if (isThrottled(throttleKeys)) {
    const retryAfter = retryAfterSeconds(throttleKeys);
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Too many failed sign-in attempts. Try again later.' });
    return;
  }

  try {
    // Find user by email
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      // Don't reveal whether the email exists
      recordFailure(throttleKeys);
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // Verify password
    const isValid = await bcrypt.compare(password, user.passwordHash);

    if (!isValid) {
      recordFailure(throttleKeys);
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // A correct password clears the counter, so a person who mistypes a few times and then
    // gets it right is not left throttled.
    clearFailures(throttleKeys);

    // Create JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      getJwtSecret(),
      { expiresIn: JWT_TTL }
    );

    // Set httpOnly cookie
    res.cookie('token', token, { ...cookieOptions(), maxAge: COOKIE_MAX_AGE });

    // Return user info (no password hash)
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/logout
 * Clears the auth cookie.
 */
router.post('/logout', (_req: Request, res: Response): void => {
  // clearCookie only matches a cookie whose attributes are identical to the one that set
  // it — reusing the same cookieOptions() is what makes this actually clear it.
  res.clearCookie('token', cookieOptions());

  res.json({ message: 'Logged out successfully' });
});

/**
 * GET /api/auth/me
 * Returns the current authenticated user's info.
 */
router.get('/me', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ user });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as authRouter };
