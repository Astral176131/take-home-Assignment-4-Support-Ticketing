import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from './AuthContext';
import type { Paged, TicketListItem } from '../types';

/**
 * The count behind the "Unassigned" nav badge, held once for the whole signed-in app —
 * same reasoning as AlertsContext: the nav badge and the unassigned page would otherwise
 * each poll on their own schedule, and assigning a ticket from the page would leave the
 * badge showing a stale count until its next tick.
 *
 * Only a supervisor can reach GET /api/tickets/unassigned at all (decision 1: routing an
 * unassigned ticket is a supervisor action), so this skips fetching entirely for an agent
 * rather than polling an endpoint that can only ever answer 403 for them.
 */

const POLL_MS = 60_000;

interface UnassignedContextValue {
  total: number;
  loading: boolean;
  refresh: () => Promise<void>;
}

const UnassignedContext = createContext<UnassignedContextValue | undefined>(undefined);

export function UnassignedProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const isSupervisor = user?.role === 'supervisor';

  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!isSupervisor) {
      setTotal(0);
      setLoading(false);
      return;
    }
    try {
      // page_size=1: only the total is needed here, the page itself fetches the real list.
      const data = await api.get<Paged<TicketListItem>>('/api/tickets/unassigned?page_size=1');
      setTotal(data.total);
    } catch (err) {
      // A network blip should not flicker the badge to zero; the last known count stays.
      if (!(err instanceof ApiError)) return;
    } finally {
      setLoading(false);
    }
  }, [isSupervisor]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <UnassignedContext.Provider value={{ total, loading, refresh }}>
      {children}
    </UnassignedContext.Provider>
  );
}

export function useUnassigned() {
  const context = useContext(UnassignedContext);
  if (!context) {
    throw new Error('useUnassigned must be used within an UnassignedProvider');
  }
  return context;
}
