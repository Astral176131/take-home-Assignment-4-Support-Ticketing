import { describe, it, expect, afterEach } from 'vitest';
import { cookieOptions, getJwtSecret } from '../jwt.js';

describe('getJwtSecret', () => {
  const original = process.env.JWT_SECRET;
  afterEach(() => {
    process.env.JWT_SECRET = original;
  });

  it('returns the configured secret', () => {
    process.env.JWT_SECRET = 'test-secret';
    expect(getJwtSecret()).toBe('test-secret');
  });

  it('throws a clear error when unset, rather than signing with undefined', () => {
    delete process.env.JWT_SECRET;
    expect(() => getJwtSecret()).toThrow('JWT_SECRET environment variable is required');
  });
});

describe('cookieOptions', () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  it('uses Lax and non-Secure outside production, so it works over plain HTTP locally', () => {
    process.env.NODE_ENV = 'development';
    expect(cookieOptions()).toMatchObject({ sameSite: 'lax', secure: false });
  });

  it('uses None and Secure in production, required once client and API are on different origins', () => {
    process.env.NODE_ENV = 'production';
    expect(cookieOptions()).toMatchObject({ sameSite: 'none', secure: true });
  });

  it('always sets httpOnly and the root path, regardless of environment', () => {
    process.env.NODE_ENV = 'production';
    expect(cookieOptions()).toMatchObject({ httpOnly: true, path: '/' });
  });
});
