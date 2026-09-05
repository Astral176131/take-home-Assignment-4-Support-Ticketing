import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { SortDirection, TicketSortField } from '../types';

export const PAGE_SIZE = 25;

/** '' hides archived tickets, 'true' includes them, 'only' shows nothing else. */
export type ArchivedMode = '' | 'true' | 'only';

/**
 * The queue's filter state, held in the URL.
 *
 * The filters live in the URL rather than in component state. That makes a filtered list
 * a place you can link to, which is what lets the dashboard send you straight to "Alice's
 * tickets" or "everything still open" by following an ordinary link, with no shared state
 * between the two pages. It also makes the browser's back button and a copied URL behave
 * the way people expect.
 *
 * Extracted from the queue page so my-tickets can offer the identical controls without a
 * second copy of this logic: two implementations of "what does ?status=open mean" would
 * eventually answer differently.
 */
export function useTicketQuery() {
  const [searchParams, setSearchParams] = useSearchParams();

  const q = searchParams.get('q') ?? '';
  const status = searchParams.get('status') ?? '';
  const priority = searchParams.get('priority') ?? '';
  const category = searchParams.get('category') ?? '';
  const assigneeId = searchParams.get('assignee_id') ?? '';
  const archived = (searchParams.get('archived') ?? '') as ArchivedMode;
  const breaching = searchParams.get('breaching') === 'true';
  const sort = (searchParams.get('sort') as TicketSortField | null) ?? 'created_at';
  const dir = (searchParams.get('dir') as SortDirection | null) ?? 'desc';
  const page = Math.max(1, Number(searchParams.get('page')) || 1);

  /**
   * Write one parameter, dropping it when empty so the URL stays readable.
   *
   * `resetPage` is on for everything except paging itself: any other change means a
   * different result set, and staying on page 4 of it would usually show nothing.
   */
  const setParam = useCallback(
    (key: string, value: string, resetPage = true) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value) next.set(key, value);
          else next.delete(key);
          if (resetPage) next.delete('page');
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const toggleSort = useCallback(
    (field: TicketSortField) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('sort', field);
          // A newly clicked column always starts descending - newest/highest first,
          // matching the default the page loads with. Clicking the active one flips it.
          next.set('dir', sort === field && dir === 'desc' ? 'asc' : 'desc');
          next.delete('page');
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams, sort, dir]
  );

  const clearFilters = useCallback(() => {
    setSearchParams(new URLSearchParams(), { replace: true });
  }, [setSearchParams]);

  // The text box updates immediately; the URL, which is what actually drives the fetch,
  // only catches up after a short pause, so typing doesn't fire a request per keystroke.
  const [qInput, setQInput] = useState(q);
  useEffect(() => {
    const id = setTimeout(() => {
      if (qInput !== q) setParam('q', qInput);
    }, 300);
    return () => clearTimeout(id);
  }, [qInput, q, setParam]);

  // A filter arriving from elsewhere - a dashboard link, the back button - has to reach
  // the search box too, or it would keep showing what was typed before.
  useEffect(() => {
    setQInput((current) => (current === q ? current : q));
  }, [q]);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    if (priority) params.set('priority', priority);
    if (category) params.set('category', category);
    if (assigneeId) params.set('assignee_id', assigneeId);
    if (archived) params.set('archived', archived);
    if (breaching) params.set('breaching', 'true');
    params.set('sort', sort);
    params.set('dir', dir);
    params.set('page', String(page));
    params.set('page_size', String(PAGE_SIZE));
    return params.toString();
  }, [q, status, priority, category, assigneeId, archived, breaching, sort, dir, page]);

  // An empty result means two different things, and the empty state should not say the
  // same thing for both: nothing matched what you asked for, or there is nothing here.
  const hasFilters = !!(q || status || priority || category || assigneeId || archived || breaching);

  return {
    q,
    status,
    priority,
    category,
    assigneeId,
    archived,
    breaching,
    sort,
    dir,
    page,
    qInput,
    setQInput,
    setParam,
    toggleSort,
    clearFilters,
    hasFilters,
    queryString,
  };
}

export type TicketQuery = ReturnType<typeof useTicketQuery>;
