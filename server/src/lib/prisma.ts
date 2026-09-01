import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pkg from 'pg';

const { Pool } = pkg;

// Prisma 7 requires a driver adapter for runtime connections
const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

export { prisma };
