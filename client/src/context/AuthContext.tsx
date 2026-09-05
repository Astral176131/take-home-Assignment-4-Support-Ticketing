import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api, SESSION_EXPIRED_EVENT } from '../lib/api';
import type { User } from '../types';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  /** True when the session ended under us, rather than the user signing out. */
  sessionExpired: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);

  /**
   * The server is the authority on whether the session still exists. When it says no,
   * drop the in-memory user so the protected routes send the person back to sign in,
   * instead of leaving them on a page whose every request fails.
   */
  useEffect(() => {
    function onExpired() {
      setUser((current) => {
        // Only worth announcing to somebody who thought they were signed in.
        if (current) setSessionExpired(true);
        return null;
      });
    }

    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  // Restore the session on mount: the cookie is httpOnly, so the only way to know
  // whether we are logged in is to ask the server.
  useEffect(() => {
    api
      .get<{ user: User }>('/api/auth/me')
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const data = await api.post<{ user: User }>('/api/auth/login', { email, password });
    setSessionExpired(false);
    setUser(data.user);
  }, []);

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout');
    setSessionExpired(false);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, sessionExpired, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
