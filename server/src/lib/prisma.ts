import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pkg from 'pg';

const { Pool } = pkg;

// Prisma 7 requires a driver adapter for runtime connections. Capped: the test database
// connects on Postgres's direct port, whose connection limit is low on smaller tiers, and
// every test file that imports the app also opens its own separate pool for fixture setup
// — left uncapped, running the suite exhausts the limit with "too many connections".
const pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 5 });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

export { prisma };
