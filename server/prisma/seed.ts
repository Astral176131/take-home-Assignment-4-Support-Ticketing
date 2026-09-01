import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient, Role, Priority } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const SALT_ROUNDS = 10;

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
  { code: Priority.low, targetResponseMinutes: 4320, sortOrder: 1 },      // 3 days
  { code: Priority.normal, targetResponseMinutes: 1440, sortOrder: 2 },   // 1 day
  { code: Priority.high, targetResponseMinutes: 240, sortOrder: 3 },      // 4 hours
  { code: Priority.urgent, targetResponseMinutes: 60, sortOrder: 4 },     // 1 hour
];

async function main() {
  console.log('Seeding database...');

  // Seed priorities (upsert to be idempotent)
  for (const p of priorities) {
    await prisma.priorityConfig.upsert({
      where: { code: p.code },
      update: { targetResponseMinutes: p.targetResponseMinutes, sortOrder: p.sortOrder },
      create: p,
    });
  }
  console.log(`Seeded ${priorities.length} priority levels`);

  // Seed demo users (upsert to be idempotent)
  for (const user of demoUsers) {
    const passwordHash = await bcrypt.hash(user.password, SALT_ROUNDS);
    await prisma.user.upsert({
      where: { email: user.email },
      update: { name: user.name, role: user.role, passwordHash },
      create: {
        email: user.email,
        name: user.name,
        role: user.role,
        passwordHash,
      },
    });
  }
  console.log(`Seeded ${demoUsers.length} demo users`);

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
