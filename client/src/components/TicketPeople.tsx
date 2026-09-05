import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Paged, Person, Ticket } from '../types';
import { useAuth } from '../context/AuthContext';

interface Props {
  ticket: Ticket;
  busy: boolean;
  onReassign: (assigneeId: string) => void;
  onAddCollaborator: (agentId: string) => void;
  onRemoveCollaborator: (agentId: string) => void;
}

/**
 * Reassignment and collaborator management, for supervisors only.
 *
 * The whole block is absent for an agent, not disabled but absent, because none of these
 * actions is available to them at all. The server refuses each one with a 403 regardless
 * of what the page renders; this only avoids offering a button that cannot work.
 */
export function TicketPeople({
  ticket,
  busy,
  onReassign,
  onAddCollaborator,
  onRemoveCollaborator,
}: Props) {
  const { user } = useAuth();
  const [agents, setAgents] = useState<Person[]>([]);
  const [newAssignee, setNewAssignee] = useState('');
  const [newCollaborator, setNewCollaborator] = useState('');

  const isSupervisor = user?.role === 'supervisor';

  useEffect(() => {
    if (!isSupervisor) return;
    api
      .get<Paged<Person>>('/api/agents')
      .then((data) => setAgents(data.items))
      .catch(() => setAgents([]));
  }, [isSupervisor]);

  if (!isSupervisor) return null;

  const collaboratorIds = new Set(ticket.collaborators.map((c) => c.id));
  const addable = agents.filter((a) => !collaboratorIds.has(a.id));

  return (
    <div className="sidebar-section">
      <h3>People</h3>

      <div className="people-control">
        <label className="sr-only" htmlFor="reassign-to">
          Reassign to
        </label>
        <select
          id="reassign-to"
          value={newAssignee}
          onChange={(e) => setNewAssignee(e.target.value)}
          disabled={busy}
        >
          <option value="">Reassign to…</option>
          {agents
            .filter((a) => a.id !== ticket.assignee?.id)
            .map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          {/* A supervisor may take a ticket on personally, but cannot hand it to the
              other supervisor — so this is the only non-agent option offered. */}
          {user && user.id !== ticket.assignee?.id && (
            <option value={user.id}>Take this on myself</option>
          )}
        </select>
        <button
          type="button"
          className="btn"
          disabled={busy || !newAssignee}
          onClick={() => {
            onReassign(newAssignee);
            setNewAssignee('');
          }}
        >
          Reassign
        </button>
      </div>

      <ul className="collaborator-list">
        {ticket.collaborators.length === 0 ? (
          <li className="muted">No collaborators</li>
        ) : (
          ticket.collaborators.map((agent) => (
            <li key={agent.id}>
              <span>{agent.name}</span>
              <button
                type="button"
                className="link-button"
                disabled={busy}
                aria-label={`Remove ${agent.name}`}
                onClick={() => onRemoveCollaborator(agent.id)}
              >
                Remove
              </button>
            </li>
          ))
        )}
      </ul>

      <div className="people-control">
        <label className="sr-only" htmlFor="add-collaborator">
          Add collaborator
        </label>
        <select
          id="add-collaborator"
          value={newCollaborator}
          onChange={(e) => setNewCollaborator(e.target.value)}
          disabled={busy || addable.length === 0}
        >
          <option value="">Add collaborator…</option>
          {addable.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn"
          disabled={busy || !newCollaborator}
          onClick={() => {
            onAddCollaborator(newCollaborator);
            setNewCollaborator('');
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}
