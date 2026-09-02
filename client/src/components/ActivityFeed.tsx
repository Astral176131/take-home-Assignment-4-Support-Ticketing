import { useState } from 'react';
import type { Reply, Ticket, TicketEvent } from '../types';
import { timeAgo } from '../lib/format';

type Tab = 'comments' | 'history' | 'all';

/** One line of plain English per history row. */
function describe(event: TicketEvent): string {
  const who = event.actor?.name ?? 'Someone';
  const target = event.target?.name ?? 'someone';

  switch (event.event_type) {
    case 'status_change':
      return `${who} moved this from ${event.old_value} to ${event.new_value}`;
    case 'reassignment':
      return `${who} reassigned this to ${target}`;
    case 'collaborator_added':
      return `${who} added ${target} as a collaborator`;
    case 'collaborator_removed':
      return `${who} removed ${target} as a collaborator`;
    case 'archived':
      return `${who} archived this ticket`;
    case 'restored':
      return `${who} restored this ticket`;
    case 'sla_ack':
      return `${who} acknowledged the SLA alert`;
    case 'reply_added':
      // Shown as the reply itself under Comments, so it never appears as a bare line.
      return `${who} replied`;
  }
}

function ReplyItem({ reply }: { reply: Reply }) {
  const fromCustomer = reply.author_type === 'customer';

  return (
    <li className={`feed-item feed-reply${reply.is_internal ? ' feed-internal' : ''}`}>
      <div className="feed-meta">
        <span className="feed-author">{reply.author.name}</span>
        {fromCustomer && <span className="chip chip-customer">customer</span>}
        {reply.is_internal && <span className="chip chip-internal">internal</span>}
        <span className="muted">{timeAgo(reply.created_at)}</span>
      </div>
      <p className="feed-body">{reply.body}</p>
    </li>
  );
}

function EventItem({ event }: { event: TicketEvent }) {
  return (
    <li className="feed-item feed-event">
      <span className="feed-dot" aria-hidden="true" />
      <span className="feed-event-text">{describe(event)}</span>
      <span className="muted">{timeAgo(event.created_at)}</span>
    </li>
  );
}

type Entry =
  | { kind: 'reply'; at: string; reply: Reply }
  | { kind: 'event'; at: string; event: TicketEvent };

export function ActivityFeed({ ticket }: { ticket: Ticket }) {
  const [tab, setTab] = useState<Tab>('comments');

  const replies: Entry[] = ticket.replies.map((reply) => ({
    kind: 'reply',
    at: reply.created_at,
    reply,
  }));

  // `reply_added` rows are left out: the reply itself already appears under Comments,
  // and repeating it here would show every reply twice on the All tab.
  const events: Entry[] = ticket.events
    .filter((event) => event.event_type !== 'reply_added')
    .map((event) => ({ kind: 'event', at: event.created_at, event }));

  const entries = (tab === 'comments' ? replies : tab === 'history' ? events : [...replies, ...events]).sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()
  );

  return (
    <section className="activity">
      <div className="tabs" role="tablist">
        {(['comments', 'history', 'all'] as Tab[]).map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            className={`tab${tab === value ? ' active' : ''}`}
            onClick={() => setTab(value)}
          >
            {value === 'comments' ? 'Comments' : value === 'history' ? 'History' : 'All'}
          </button>
        ))}
      </div>

      {entries.length === 0 ? (
        <p className="muted feed-empty">Nothing here yet.</p>
      ) : (
        <ul className="feed">
          {entries.map((entry) =>
            entry.kind === 'reply' ? (
              <ReplyItem key={entry.reply.id} reply={entry.reply} />
            ) : (
              <EventItem key={entry.event.id} event={entry.event} />
            )
          )}
        </ul>
      )}
    </section>
  );
}
