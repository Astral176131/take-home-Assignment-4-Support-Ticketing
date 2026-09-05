import { useState } from 'react';
import { CATEGORY_OPTIONS, PRIORITY_OPTIONS } from '../lib/options';
import type { Category, Priority, Ticket } from '../types';

/** The four fields `PATCH /api/tickets/:id` accepts. Everything else about a ticket
 *  (status, assignee, archived) carries its own rules and has its own endpoint. */
export interface TicketEdits {
  subject?: string;
  description?: string;
  priority_code?: Priority;
  category?: Category;
}

interface Props {
  ticket: Ticket;
  busy: boolean;
  /** Resolves to whether the save actually went through, so a failure keeps the form
   *  open with the user's edits intact rather than discarding them. */
  onSave: (edits: TicketEdits) => Promise<boolean>;
  onCancel: () => void;
}

/**
 * Editing a ticket's own fields, in place on the ticket page.
 *
 * Only the fields that actually changed are sent. The endpoint takes a partial body and
 * refuses an empty one with a 400, so Save stays disabled until something differs, which
 * turns "there is nothing to save" into a button that cannot be pressed rather than an
 * error message after the fact.
 */
export function TicketEditForm({ ticket, busy, onSave, onCancel }: Props) {
  const [subject, setSubject] = useState(ticket.subject);
  const [description, setDescription] = useState(ticket.description);
  const [priority, setPriority] = useState<Priority>(ticket.priority_code);
  const [category, setCategory] = useState<Category>(ticket.category);

  // Compared trimmed, because that is what the server stores. Otherwise adding a trailing
  // space would look like a change here and then save as no change at all.
  const edits: TicketEdits = {};
  if (subject.trim() !== ticket.subject) edits.subject = subject.trim();
  if (description.trim() !== ticket.description) edits.description = description.trim();
  if (priority !== ticket.priority_code) edits.priority_code = priority;
  if (category !== ticket.category) edits.category = category;

  const emptyField = !subject.trim() || !description.trim();
  const nothingToSave = Object.keys(edits).length === 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (emptyField || nothingToSave) return;
    if (await onSave(edits)) onCancel();
  }

  return (
    <form className="ticket-form ticket-edit-form" onSubmit={handleSubmit}>
      <div className="form-group">
        <label htmlFor="edit-subject">Subject</label>
        <input
          id="edit-subject"
          autoComplete="off"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          required
        />
      </div>

      <div className="form-group">
        <label htmlFor="edit-description">Description</label>
        <textarea
          id="edit-description"
          rows={6}
          autoComplete="off"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
        />
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="edit-priority">Priority</label>
          <select
            id="edit-priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority)}
          >
            {PRIORITY_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="edit-category">Category</label>
          <select
            id="edit-category"
            value={category}
            onChange={(e) => setCategory(e.target.value as Category)}
          >
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="form-actions">
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || emptyField || nothingToSave}
        >
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
