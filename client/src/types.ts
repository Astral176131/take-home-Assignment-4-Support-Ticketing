/** Mirrors the JSON the API returns. Kept in one file so a change to the contract
 *  shows up as a type error rather than an undefined at runtime. */

export type Role = 'agent' | 'supervisor';
export type TicketStatus = 'new' | 'open' | 'pending' | 'resolved' | 'closed';
export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export type Category = 'bug' | 'billing' | 'how_to' | 'other';
export type AuthorType = 'agent' | 'customer';

export type EventType =
  | 'status_change'
  | 'reassignment'
  | 'collaborator_added'
  | 'collaborator_removed'
  | 'archived'
  | 'restored'
  | 'reply_added'
  | 'sla_ack';

/** GET /api/dashboard — one shared dashboard, not scoped by role. */
export interface Dashboard {
  open_count: number;
  pending_count: number;
  resolved_this_week: number;
  breaching_count: number;
  unassigned_count: number;
  by_status: Record<TicketStatus, number>;
  by_agent: { agent: Person; count: number }[];
  resolved_per_week: { week_start: string; count: number }[];
  mine: {
    open_count: number;
    pending_count: number;
    resolved_this_week: number;
    breaching_count: number;
  };
}

/** GET /api/dashboard/week — one week's resolutions, day by day and by agent. */
export interface WeekDetail {
  week_start: string;
  days: { date: string; count: number }[];
  by_agent: { agent: Person; count: number }[];
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
}

/** A person as embedded in a ticket payload. */
export interface Person {
  id: string;
  name: string;
  email?: string;
}

export interface Requester {
  id: string;
  name: string;
  email: string;
}

export interface Reply {
  id: string;
  body: string;
  author: Person;
  /** Whose words these are. The author is always the user who recorded them. */
  author_type: AuthorType;
  is_internal: boolean;
  created_at: string;
}

export interface TicketEvent {
  id: string;
  event_type: EventType;
  /** Who performed the action. */
  actor: Person | null;
  old_value: string | null;
  new_value: string | null;
  /** Who the action was about, for collaborator and reassignment rows. */
  target: Person | null;
  created_at: string;
}

export interface Sla {
  elapsed_minutes: number;
  target_minutes: number;
  remaining_minutes: number;
  breached: boolean;
  warning: boolean;
  alert_active: boolean;
  /** Minutes until an acknowledged alert comes back, or null when it is not snoozed. */
  snoozed_for_minutes: number | null;
}

export interface TicketListItem {
  id: string;
  /** Human-readable label, e.g. "SUP-14". The id above remains the real identifier. */
  key: string;
  subject: string;
  status: TicketStatus;
  priority_code: Priority;
  category: Category;
  requester: Requester;
  assignee: Person | null;
  sla: Sla;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Ticket {
  id: string;
  key: string;
  subject: string;
  description: string;
  status: TicketStatus;
  priority_code: Priority;
  category: Category;
  requester: Requester;
  assignee: Person | null;
  collaborators: Person[];
  replies: Reply[];
  events: TicketEvent[];
  /** Computed server-side, so the UI never needs its own copy of the state machine. */
  allowed_transitions: TicketStatus[];
  sla: Sla;
  pending_since: string | null;
  paused_minutes: number;
  resolved_at: string | null;
  closed_at: string | null;
  archived_at: string | null;
  ack_cycle: number;
  acked_through_cycle: number | null;
  clock_started_at: string;
  created_at: string;
  updated_at: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
  /** Present on the queue list and export; absent on endpoints with no pagination. */
  page?: number;
  page_size?: number;
}

/**
 * GET /api/alerts. `acknowledged` counts tickets that are breaching or close to it but
 * have been acknowledged, so they are deliberately absent from `items` — without it an
 * empty list cannot say whether nothing is wrong or everything wrong has been silenced.
 */
export interface AlertsResponse extends Paged<TicketListItem> {
  acknowledged: number;
}

export type TicketSortField = 'created_at' | 'priority' | 'updated_at';
export type SortDirection = 'asc' | 'desc';

/** A ticket the same requester already has open, shown before filing a duplicate. */
export interface DuplicateHit {
  id: string;
  subject: string;
  status: TicketStatus;
  assignee: Person | null;
}
