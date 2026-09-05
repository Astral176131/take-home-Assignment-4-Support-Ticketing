import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { AlertsResponse, TicketListItem } from '../types';

/**
 * The active alerts, held once for the whole signed-in app.
 *
 * This exists because two places need the same answer and one of them can change it: the
 * nav badge counts the alerts, the alerts page lists them, and acknowledging from either
 * the alerts page or a ticket page makes one disappear. Held privately by the nav, the
 * badge could only find out on its next poll — so a ticket you had just acknowledged went
 * on being counted for up to a minute, and the only way to correct it was to reload the
 * page.
 *
 * So the fetch lives here, and anything that changes a ticket's alert standing calls
 * `refresh()`. The badge and the list are then re-rendered from the same response and
 * cannot disagree with each other.
 */

const ALERT_POLL_MS = 60_000;

interface AlertsContextValue {
  items: TicketListItem[];
  total: number;
  /** Breaching or nearly, but already acknowledged — silenced, not resolved. */
  acknowledged: number;
  loading: boolean;
  /** Set when a fetch fails. The last known alerts are kept rather than cleared. */
  error: string;
  refresh: () => Promise<void>;
}

const AlertsContext = createContext<AlertsContextValue | undefined>(undefined);

export function AlertsProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<TicketListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [acknowledged, setAcknowledged] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const data = await api.get<AlertsResponse>('/api/alerts');
      setItems(data.items);
      setTotal(data.total);
      setAcknowledged(data.acknowledged ?? 0);
      setError('');
    } catch (err) {
      // Deliberately leaves the last known alerts in place. A badge that flickers to "no
      // alerts" on a network blip is worse than one that is briefly stale.
      setError(err instanceof ApiError ? err.message : 'Could not load alerts');
    } finally {
      setLoading(false);
    }
  }, []);

  // Polled as well as refreshed on demand: `refresh()` covers what this user just did,
  // while the interval covers what everyone else did and the simple passage of time —
  // a ticket breaches its target with nobody touching it.
  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, ALERT_POLL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <AlertsContext.Provider value={{ items, total, acknowledged, loading, error, refresh }}>
      {children}
    </AlertsContext.Provider>
  );
}

export function useAlerts() {
  const context = useContext(AlertsContext);
  if (!context) {
    throw new Error('useAlerts must be used within an AlertsProvider');
  }
  return context;
}
