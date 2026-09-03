import { prisma } from '../../lib/prisma.js';

type Result = { ok: true } | { ok: false; error: string };

/**
 * Who a ticket may be handed to: any agent, or the acting supervisor personally as an
 * escalation (decision 4) — never the other supervisor.
 *
 * Shared by the single reassign endpoint and bulk-reassign so the rule cannot drift
 * between the two call sites that enforce it.
 */
export async function validateReassignTarget(actorUserId: string, targetId: string): Promise<Result> {
  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) {
    return { ok: false, error: 'Unknown user' };
  }

  const takingItOn = target.id === actorUserId;
  if (target.role !== 'agent' && !takingItOn) {
    return {
      ok: false,
      error: 'A ticket can only be assigned to an agent, or to yourself as an escalation',
    };
  }

  return { ok: true };
}
