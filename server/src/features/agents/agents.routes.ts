import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate, requireRole } from '../../middleware/auth.js';

const router = Router();

router.use(authenticate);

/**
 * GET /api/agents
 *
 * The roster a supervisor picks from when assigning a ticket or managing collaborators.
 *
 * Supervisor-only, because attaching a person to a ticket is a supervisor power
 * throughout this system — at creation, at reassignment, and when adding collaborators.
 * An agent has no action that takes another agent's id, so none needs the list.
 *
 * Supervisors are excluded from the results: only agents are ever assignees or
 * collaborators. A supervisor can still end up assigned by taking over an escalation
 * through the reassign endpoint, which is a different path.
 */
router.get('/', requireRole('supervisor'), async (_req: Request, res: Response): Promise<void> => {
  const agents = await prisma.user.findMany({
    where: { role: 'agent' },
    select: { id: true, name: true, email: true },
    orderBy: { name: 'asc' },
  });

  res.json({ items: agents, total: agents.length });
});

export { router as agentsRouter };
