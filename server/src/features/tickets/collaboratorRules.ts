import { prisma } from '../../lib/prisma.js';

type Result = { ok: true } | { ok: false; error: string };

/**
 * Who may be attached to a ticket as a collaborator: any agent, and nobody else.
 *
 * Supervisors are excluded because they already reach every ticket, so a collaborator row
 * naming one grants nothing and only adds noise to the list on screen (decision 3).
 *
 * Shared by the single add endpoint and the bulk one so the rule cannot drift between the
 * two places that enforce it — the same reason `reassignRules` exists next door.
 */
export async function validateCollaboratorTarget(agentId: string): Promise<Result> {
  const agent = await prisma.user.findUnique({ where: { id: agentId } });

  if (!agent) {
    return { ok: false, error: 'Unknown user' };
  }
  if (agent.role !== 'agent') {
    return { ok: false, error: 'Only agents can be added as collaborators' };
  }

  return { ok: true };
}
