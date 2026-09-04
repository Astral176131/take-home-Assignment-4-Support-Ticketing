import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient, Role, Priority, Category } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import supertest from 'supertest';
import { purgeTicketEvents } from '../src/lib/purgeTicketEvents.js';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

// `app.js` transitively imports the shared Prisma client in src/lib/prisma.ts, which
// reads DATABASE_URL at module-evaluation time. Static imports are hoisted above the
// dotenv.config() call above regardless of source order, so importing app statically here
// would build that client against an empty env — this project has hit exactly this trap
// before (see docs/architecture.md). Deferring to a dynamic import inside main(), which
// only runs after dotenv.config() has already populated process.env, avoids it.
let request: ReturnType<typeof supertest>;

const SALT_ROUNDS = 10;

/**
 * Every demo ticket's requester lives under this domain, which is how the script finds
 * its own previous output to clear before reseeding — nothing else in the database uses
 * it, so re-running this script is safe and idempotent rather than piling up duplicates.
 */
const DEMO_DOMAIN = 'demo.supportdesk.test';

interface DemoUser {
  email: string;
  name: string;
  role: Role;
  password: string;
}

const demoUsers: DemoUser[] = [
  { email: 'supervisor1@example.com', name: 'Sarah Chen', role: 'supervisor', password: 'super123' },
  { email: 'supervisor2@example.com', name: 'Mike Johnson', role: 'supervisor', password: 'super456' },
  { email: 'agent1@example.com', name: 'Alice Rivera', role: 'agent', password: 'agent123' },
  { email: 'agent2@example.com', name: 'Bob Thompson', role: 'agent', password: 'agent456' },
  { email: 'agent3@example.com', name: 'Carol Davis', role: 'agent', password: 'agent789' },
  { email: 'agent4@example.com', name: 'Dan Wilson', role: 'agent', password: 'agent101' },
];

const priorities = [
  { code: Priority.low, targetResponseMinutes: 4320, sortOrder: 1 }, // 3 days
  { code: Priority.normal, targetResponseMinutes: 1440, sortOrder: 2 }, // 1 day
  { code: Priority.high, targetResponseMinutes: 240, sortOrder: 3 }, // 4 hours
  { code: Priority.urgent, targetResponseMinutes: 60, sortOrder: 4 }, // 1 hour
];

// --- Demo content ------------------------------------------------------------

interface DemoRequester {
  name: string;
  email: string;
}

const requesterPool: DemoRequester[] = [
  { name: 'Jordan Lee', email: `jordan.lee@${DEMO_DOMAIN}` },
  { name: 'Priya Nair', email: `priya.nair@${DEMO_DOMAIN}` },
  { name: 'Marcus Webb', email: `marcus.webb@${DEMO_DOMAIN}` },
  { name: 'Elena Vasquez', email: `elena.vasquez@${DEMO_DOMAIN}` },
  { name: 'Tom Okafor', email: `tom.okafor@${DEMO_DOMAIN}` },
  { name: 'Nina Kowalski', email: `nina.kowalski@${DEMO_DOMAIN}` },
  { name: 'Ravi Patel', email: `ravi.patel@${DEMO_DOMAIN}` },
  { name: 'Grace Kim', email: `grace.kim@${DEMO_DOMAIN}` },
  { name: "Liam O'Brien", email: `liam.obrien@${DEMO_DOMAIN}` },
  { name: 'Aisha Bello', email: `aisha.bello@${DEMO_DOMAIN}` },
  { name: 'Diego Fernandez', email: `diego.fernandez@${DEMO_DOMAIN}` },
  { name: 'Hannah Cohen', email: `hannah.cohen@${DEMO_DOMAIN}` },
  { name: 'Kenji Sato', email: `kenji.sato@${DEMO_DOMAIN}` },
  { name: 'Olivia Brandt', email: `olivia.brandt@${DEMO_DOMAIN}` },
  { name: 'Samuel Osei', email: `samuel.osei@${DEMO_DOMAIN}` },
  { name: 'Ines Moreau', email: `ines.moreau@${DEMO_DOMAIN}` },
  { name: 'Victor Hale', email: `victor.hale@${DEMO_DOMAIN}` },
  { name: 'Freya Lindqvist', email: `freya.lindqvist@${DEMO_DOMAIN}` },
  { name: 'Anwar Siddiqui', email: `anwar.siddiqui@${DEMO_DOMAIN}` },
  { name: 'Chloe Martins', email: `chloe.martins@${DEMO_DOMAIN}` },
];

interface Template {
  subject: string;
  description: string;
}

const templates: Record<Category, Template[]> = {
  bug: [
    { subject: 'Export button throws a 500 error', description: 'Clicking "Export CSV" on the queue page fails every time with a server error. Happens on both Chrome and Firefox.' },
    { subject: 'Dashboard chart is missing the last two weeks', description: "The 8-week resolved chart seems to stop updating — it's been showing the same numbers for the last couple of days." },
    { subject: 'Search does not find tickets by partial word', description: 'Searching "print" does not return a ticket whose subject is "Printer will not print". Expected partial matches to work.' },
    { subject: 'App crashes when uploading a large attachment', description: 'Tried attaching a 40MB screen recording to a reply and the whole page went blank.' },
    { subject: 'Notifications are not arriving for new replies', description: "I haven't gotten an email notification for the last three customer replies on my assigned tickets." },
    { subject: 'Ticket list sometimes shows duplicate rows', description: 'After changing a filter and changing it back, the same ticket occasionally appears twice in the table.' },
    { subject: 'Priority badge shows the wrong colour for urgent', description: 'Urgent tickets are showing with the same badge colour as normal ones on my screen.' },
    { subject: 'Reassign dropdown is empty for me', description: 'As a supervisor, the reassign dropdown on a ticket shows no agents at all today, though it worked yesterday.' },
    { subject: 'Reply box loses my draft after a page refresh', description: "I was halfway through a long reply, the page refreshed itself, and everything I'd typed was gone." },
    { subject: 'SLA countdown shows a negative number oddly', description: 'A ticket that is well within its target is showing "-3m left" instead of a positive countdown.' },
    { subject: 'Archived tickets appear in the default queue view', description: 'I archived a ticket yesterday and it is still showing up in my main queue today.' },
    { subject: "Can't remove a collaborator from a ticket", description: 'The remove button next to a collaborator name does nothing when I click it.' },
    { subject: 'Login redirects back to the login page in a loop', description: 'After entering the right password, the page just bounces back to the login screen repeatedly.' },
  ],
  billing: [
    { subject: 'Invoice #4021 appears to be double-charged', description: "We were charged twice this month for the same invoice number. Can you confirm and refund the duplicate?" },
    { subject: 'Unable to update payment method on file', description: 'The "update card" button on the billing page does not respond when clicked.' },
    { subject: 'Requesting a refund for an accidental duplicate subscription', description: 'I signed up twice by mistake within the same hour and would like the second subscription refunded.' },
    { subject: 'Annual plan discount was not applied at checkout', description: "The pricing page advertises 20% off for annual billing, but my invoice shows the full monthly rate x12." },
    { subject: 'Received a billing email for an account we cancelled', description: 'We cancelled three months ago but just got an invoice reminder for this account.' },
    { subject: 'Need an itemised receipt for our accounting team', description: 'Our finance team needs a line-item breakdown of last quarter\'s charges rather than the summary invoice.' },
    { subject: 'Currency on the invoice does not match our contract', description: 'Our contract is in EUR but the last two invoices were issued in USD.' },
    { subject: 'Seat count on the invoice is higher than our actual usage', description: "We removed two seats last month but are still being billed for the old count." },
    { subject: 'Card was declined but the subscription still says active', description: 'We got a decline notice but access has not been suspended — just want to confirm the payment is actually pending.' },
    { subject: 'Requesting a copy of last year\'s tax invoice', description: 'Our accountant needs the 2025 annual tax invoice re-sent, the original seems to have been lost.' },
    { subject: 'Proration for a mid-cycle plan upgrade looks off', description: 'We upgraded plans on the 15th and the prorated charge does not match what the pricing page calculator showed.' },
    { subject: 'Trial ended but we were never given the option to add a card', description: 'Access was cut off with no warning or prompt to enter billing details.' },
  ],
  how_to: [
    { subject: 'How do I add a new collaborator to my team?', description: "I'd like a colleague to be able to see and reply to a ticket I'm working, but I don't see how to add them." },
    { subject: 'Is there a way to export my ticket history?', description: 'Looking for a way to get a CSV of everything assigned to me over the last quarter.' },
    { subject: 'How do I reset a forgotten password?', description: "I can't find a 'forgot password' link anywhere on the login page." },
    { subject: 'Can I customise the priority levels for our account?', description: 'We use a 5-tier priority system internally — is that something that can be configured?' },
    { subject: 'Where do I find an API key for our integration?', description: 'Trying to connect our internal tool but cannot locate any API credentials page.' },
    { subject: 'How does the response time target actually get calculated?', description: 'Trying to understand whether the SLA clock counts weekends, or pauses for any reason other than waiting on us.' },
    { subject: 'What happens to a ticket after it is archived?', description: 'Wondering whether archived tickets are deleted eventually, or just hidden from the default view.' },
    { subject: 'How can I see every ticket I am collaborating on?', description: "I know about 'my tickets' but I'm not sure if that includes ones I'm only a collaborator on." },
    { subject: 'Is there a bulk way to reassign several tickets at once?', description: 'One of our agents is on leave and I need to move about fifteen of their tickets to someone else.' },
    { subject: 'How do I tell the difference between a public reply and an internal note?', description: 'Want to make sure I never accidentally send an internal note to a customer.' },
    { subject: 'Can a closed ticket ever be reopened?', description: 'A customer wrote back a week after we closed their ticket — is there still a way to reopen it?' },
    { subject: 'How do alerts get cleared once I have looked at them?', description: 'Trying to understand what "acknowledging" an alert actually does.' },
  ],
  other: [
    { subject: 'Feature request: dark mode for the dashboard', description: 'Several of us work late shifts and would appreciate a dark theme option.' },
    { subject: 'Feedback on the new queue layout', description: 'The new table is a big improvement, though the priority column could use more contrast.' },
    { subject: 'Question about your data retention policy', description: 'Our compliance team is asking how long ticket data and reply history are retained after account closure.' },
    { subject: 'Requesting a demo for our enterprise team', description: "We're evaluating a few support platforms and would like to see a walkthrough with our own use case." },
    { subject: 'General inquiry about integration options', description: 'Do you have a way to connect this to a Slack channel for new ticket notifications?' },
    { subject: 'Suggestion: keyboard shortcuts for common actions', description: 'It would speed things up a lot to have a shortcut for adding a reply or changing status.' },
    { subject: 'Thank you for the quick turnaround on our last issue', description: "Just wanted to pass along that the team was impressed with how fast the last bug got fixed." },
    { subject: 'Asking about your uptime and status page', description: 'Is there a public status page we can subscribe to for outage notifications?' },
    { subject: 'Interested in your partner/reseller program', description: 'We work with several clients who could use this platform — is there a partner program to join?' },
    { subject: 'Clarifying what counts as a "collaborator" versus "assignee"', description: "Just want to understand the practical difference before we set up our workflow." },
  ],
};

const publicReplies = [
  'Thanks for reaching out — taking a look into this now.',
  "I've reproduced this on my end and I'm digging into the cause.",
  'Could you tell me which browser and version you were using when this happened?',
  "This should be resolved now — could you confirm on your end when you get a chance?",
  "Following up: were you able to try the workaround I mentioned?",
];

const internalNotes = [
  'Looks related to the caching layer — checking with the backend team.',
  'Customer is on the enterprise plan, worth prioritising.',
  "Can't reproduce yet, asking for more detail before escalating.",
  'This is the third report of the same issue this week — flagging for a wider look.',
];

const customerReplies = [
  "Still happening on my end, any update?",
  'That fixed it, thank you!',
  "I tried that but I'm still seeing the same error.",
  "No rush, just checking in on this.",
  'Appreciate the quick reply — will test and let you know.',
];

// --- Helpers -------------------------------------------------------------

function pick<T>(arr: T[], index: number): T {
  return arr[index % arr.length];
}

async function login(email: string, password: string): Promise<string> {
  const res = await request.post('/api/auth/login').send({ email, password });
  const cookies = res.headers['set-cookie'];
  const cookie = Array.isArray(cookies) ? cookies[0] : (cookies as unknown as string);
  if (res.status !== 200 || !cookie) {
    throw new Error(`Could not log in as ${email} while seeding: ${JSON.stringify(res.body)}`);
  }
  return cookie;
}

/**
 * Spreads a ticket's own timestamps and its replies'/events' `createdAt` across a
 * realistic window ending now, preserving the order the API actually produced them in.
 * The API has no way to backdate anything itself — every seeded ticket is created "right
 * now" from its point of view — so this is a deliberate, contained raw-Prisma pass applied
 * once a ticket's whole lifecycle has already been driven through the real routes.
 */
async function backdateTimeline(ticketId: string, daysAgoCreated: number) {
  const ticket = await prisma.ticket.findUniqueOrThrow({
    where: { id: ticketId },
    include: { events: { orderBy: { createdAt: 'asc' } }, replies: { orderBy: { createdAt: 'asc' } } },
  });

  const createdAt = new Date(Date.now() - daysAgoCreated * 24 * 60 * 60_000);

  type Moment = { id: string; kind: 'event' | 'reply'; at: Date; newValue?: string | null };
  const moments: Moment[] = [
    ...ticket.events.map((e) => ({ id: e.id, kind: 'event' as const, at: e.createdAt, newValue: e.newValue })),
    ...ticket.replies.map((r) => ({ id: r.id, kind: 'reply' as const, at: r.createdAt })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  // Interpolated within a short activity window after createdAt — a few hours to a few
  // days — not stretched out to "now" regardless of the ticket's age. Stretching to "now"
  // was tried first and rejected: it pulls a resolution disproportionately toward the
  // present for every ticket regardless of when it was created, since the interpolated
  // position is always roughly "createdAt plus most of the way to today". Confirmed by
  // inspecting a full run: created_at spread across 8 weeks correctly, but resolved_at
  // still collapsed into the most recent 3. Real support activity happens within days of
  // a ticket being opened, not spread across its entire age, so a short fixed window
  // after creation both looks realistic and keeps resolvedAt's week close to createdAt's.
  const activityWindowMs = (6 + moments.length * 8) * 60 * 60_000;
  const stamped = moments.map((m, i) => ({
    ...m,
    at: new Date(
      Math.min(
        createdAt.getTime() + (activityWindowMs * (i + 1)) / (moments.length + 1),
        Date.now() - 60_000
      )
    ),
  }));

  // resolvedAt/closedAt must land on the timestamp of the specific transition that set
  // them, and closedAt (if present) is always later than resolvedAt by construction,
  // since "closed" can only be reached after "resolved" — the sort above already
  // preserves that order.
  const resolvedMoment = stamped.find((m) => m.kind === 'event' && m.newValue === 'resolved');
  const closedMoment = stamped.find((m) => m.kind === 'event' && m.newValue === 'closed');

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE "ticket_events" DISABLE TRIGGER ticket_events_immutable');

    // updatedAt is set explicitly rather than left to Prisma's usual auto-now-on-write
    // behaviour, which would otherwise stamp it "now" here and undo the backdating this
    // whole pass exists to do — every ticket would show as updated today regardless of
    // its actual seeded history.
    const lastMoment = stamped[stamped.length - 1]?.at ?? createdAt;

    await tx.ticket.update({
      where: { id: ticketId },
      data: {
        createdAt,
        updatedAt: lastMoment,
        ...(resolvedMoment ? { resolvedAt: resolvedMoment.at } : {}),
        ...(closedMoment ? { closedAt: closedMoment.at } : {}),
      },
    });

    for (const m of stamped) {
      if (m.kind === 'event') {
        await tx.ticketEvent.update({ where: { id: m.id }, data: { createdAt: m.at } });
      } else {
        await tx.reply.update({ where: { id: m.id }, data: { createdAt: m.at } });
      }
    }

    await tx.$executeRawUnsafe('ALTER TABLE "ticket_events" ENABLE TRIGGER ticket_events_immutable');
  });
}

// --- Main ------------------------------------------------------------------

async function main() {
  const { app } = await import('../src/app.js');
  request = supertest(app);

  console.log('Seeding database...');

  for (const p of priorities) {
    await prisma.priorityConfig.upsert({
      where: { code: p.code },
      update: { targetResponseMinutes: p.targetResponseMinutes, sortOrder: p.sortOrder },
      create: p,
    });
  }
  console.log(`Seeded ${priorities.length} priority levels`);

  const userIds: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  for (const user of demoUsers) {
    const passwordHash = await bcrypt.hash(user.password, SALT_ROUNDS);
    const record = await prisma.user.upsert({
      where: { email: user.email },
      update: { name: user.name, role: user.role, passwordHash },
      create: { email: user.email, name: user.name, role: user.role, passwordHash },
    });
    userIds[user.email] = record.id;
    cookies[user.email] = await login(user.email, user.password);
  }
  console.log(`Seeded ${demoUsers.length} demo users`);

  const supervisors = demoUsers.filter((u) => u.role === 'supervisor');
  const agents = demoUsers.filter((u) => u.role === 'agent');

  // --- Clear any tickets from a previous run of this script, so re-running it is safe. ---
  const previous = await prisma.ticket.findMany({
    where: { requester: { email: { endsWith: `@${DEMO_DOMAIN}` } } },
    select: { id: true },
  });
  if (previous.length > 0) {
    const ids = previous.map((t) => t.id);
    await purgeTicketEvents(prisma, { ticketId: { in: ids } });
    await prisma.reply.deleteMany({ where: { ticketId: { in: ids } } });
    await prisma.ticketCollaborator.deleteMany({ where: { ticketId: { in: ids } } });
    await prisma.ticket.deleteMany({ where: { id: { in: ids } } });
    await prisma.requester.deleteMany({ where: { email: { endsWith: `@${DEMO_DOMAIN}` } } });
    console.log(`Cleared ${ids.length} demo tickets from a previous run`);
  }

  // --- Build the plan: 50 tickets with an exact, known mix. -------------------
  const TOTAL = 50;
  const categoryOrder: Category[] = ['bug', 'billing', 'how_to', 'other'];
  const priorityOrder: Priority[] = ['low', 'normal', 'high', 'urgent'];
  const statusPlan: Array<'new' | 'open' | 'pending' | 'resolved' | 'closed'> = [
    ...Array(6).fill('new'),
    ...Array(14).fill('open'),
    ...Array(8).fill('pending'),
    ...Array(14).fill('resolved'),
    ...Array(8).fill('closed'),
  ];

  // Index bands, matching statusPlan exactly: new 0-5, open 6-19, pending 20-27,
  // resolved 28-41, closed 42-49 — every index below is chosen to actually land in the
  // band its comment claims, not just a number that happened to work out.
  const archivedIndices = new Set([28, 29, 30, 31, 42, 43]); // 4 resolved + 2 closed
  const breachUnackedIndices = new Set([6, 7, 8, 9, 10]); // within the "open" band
  const breachAckedIndices = new Set([11, 12]); // also "open"
  const collaboratorIndices = new Set(Array.from({ length: TOTAL }, (_, i) => i).filter((i) => i % 4 === 0));
  const fullThreadIndices = new Set(Array.from({ length: TOTAL }, (_, i) => i).filter((i) => i % 6 === 0));
  const escalateIndices = new Set([13, 17]); // two "open" tickets, one per supervisor
  const agentSelfCreatedIndices = new Set(Array.from({ length: TOTAL }, (_, i) => i).filter((i) => i % 5 === 0));

  let created = 0;

  for (let i = 0; i < TOTAL; i++) {
    const category = pick(categoryOrder, i);
    const priority = pick(priorityOrder, i * 3);
    const template = pick(templates[category], Math.floor(i / 4));
    const requester = pick(requesterPool, i);
    const targetStatus = statusPlan[i];
    const primaryAgent = pick(agents, i);

    const selfCreated = agentSelfCreatedIndices.has(i);
    const creatorCookie = selfCreated ? cookies[primaryAgent.email] : cookies[supervisors[i % 2].email];

    const createRes = await request
      .post('/api/tickets')
      .set('Cookie', creatorCookie)
      .send({
        subject: template.subject,
        description: template.description,
        requester,
        priority_code: priority,
        category,
        assignee_id: userIds[primaryAgent.email],
      });

    if (createRes.status !== 201) {
      throw new Error(`Failed to create ticket ${i} ("${template.subject}"): ${JSON.stringify(createRes.body)}`);
    }
    const ticketId: string = createRes.body.id;
    const supervisorCookie = cookies[supervisors[i % 2].email];
    const agentCookie = cookies[primaryAgent.email];

    // Collaborator, added by a supervisor, drawn from a different agent than the assignee.
    if (collaboratorIndices.has(i)) {
      const collaborator = agents[(agents.indexOf(primaryAgent) + 1) % agents.length];
      await request
        .post(`/api/tickets/${ticketId}/collaborators`)
        .set('Cookie', supervisorCookie)
        .send({ agent_id: userIds[collaborator.email] });
    }

    // Move to open first, whatever the eventual target — every path in the state machine
    // runs through it.
    if (targetStatus !== 'new') {
      await request.post(`/api/tickets/${ticketId}/status`).set('Cookie', agentCookie).send({ status: 'open' });
    }

    // Reply thread, added while open so it never interferes with the pending
    // auto-transition or a later resolve/close.
    if (targetStatus !== 'new' && fullThreadIndices.has(i)) {
      const thread: Array<{ body: string; is_internal: boolean; author_type: 'agent' | 'customer' }> = [
        { body: pick(publicReplies, i), is_internal: false, author_type: 'agent' },
        { body: pick(internalNotes, i), is_internal: true, author_type: 'agent' },
        { body: pick(customerReplies, i), is_internal: false, author_type: 'customer' },
        { body: pick(publicReplies, i + 1), is_internal: false, author_type: 'agent' },
      ];
      for (const reply of thread) {
        await request.post(`/api/tickets/${ticketId}/replies`).set('Cookie', agentCookie).send(reply);
      }
    } else if (targetStatus !== 'new') {
      await request
        .post(`/api/tickets/${ticketId}/replies`)
        .set('Cookie', agentCookie)
        .send({ body: pick(publicReplies, i), is_internal: false, author_type: 'agent' });
    }

    if (targetStatus === 'pending') {
      await request.post(`/api/tickets/${ticketId}/status`).set('Cookie', agentCookie).send({ status: 'pending' });
    } else if (targetStatus === 'resolved' || targetStatus === 'closed') {
      await request.post(`/api/tickets/${ticketId}/status`).set('Cookie', agentCookie).send({ status: 'resolved' });
      if (targetStatus === 'closed') {
        await request.post(`/api/tickets/${ticketId}/status`).set('Cookie', supervisorCookie).send({ status: 'closed' });
      }
    }

    // Escalation: a supervisor personally takes over an active ticket.
    if (escalateIndices.has(i) && targetStatus === 'open') {
      const escalatingSupervisor = i === 13 ? supervisors[0] : supervisors[1];
      await request
        .post(`/api/tickets/${ticketId}/reassign`)
        .set('Cookie', cookies[escalatingSupervisor.email])
        .send({ assignee_id: userIds[escalatingSupervisor.email] });
    }

    // Breach: backdate the clock past *this ticket's own* target — low's 3-day target and
    // urgent's 1-hour target are 70x apart, so a single flat backdate cannot breach both.
    // Confirmed by inspecting seeded data during a dry run: a flat 3-hour backdate left
    // "breaching" `high`-priority tickets (240-minute target) not actually breaching.
    if ((breachUnackedIndices.has(i) || breachAckedIndices.has(i)) && (targetStatus === 'open' || targetStatus === 'new' || targetStatus === 'pending')) {
      const targetMinutes = priorities.find((p) => p.code === priority)!.targetResponseMinutes;
      await prisma.ticket.update({
        where: { id: ticketId },
        data: { clockStartedAt: new Date(Date.now() - (targetMinutes + 30) * 60_000) },
      });
      if (breachAckedIndices.has(i)) {
        await request.post(`/api/tickets/${ticketId}/alerts/ack`).set('Cookie', agentCookie);
      }
    }

    if (archivedIndices.has(i)) {
      await request.post(`/api/tickets/${ticketId}/archive`).set('Cookie', agentCookie);
    }

    // Spread across the last 8 weeks using i % 8 rather than a formula monotonic in i —
    // statusPlan is also built purely from i, in status order, so a monotonic age would
    // put every status in its own narrow age band. Confirmed by inspecting a full run:
    // that version put every "resolved" ticket's age within a ~15-day window, so
    // resolved_at (itself derived from a ticket's own age span) clustered into just 2 of
    // the 8 weekly buckets instead of spreading across them, defeating the point of an
    // 8-week chart. Decoupling week-bucket from status position fixes it.
    const weekOffset = i % 8;
    const daysAgo = weekOffset * 7 + ((i * 3) % 7) + 1;
    await backdateTimeline(ticketId, daysAgo);

    created++;
  }

  console.log(`Seeded ${created} demo tickets`);
  console.log('Seeding complete.');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
