import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
  migrations: {
    path: 'prisma/migrations',
    // Prisma 7 reads the seed command from here, not from package.json's `prisma.seed`
    // field (the pre-7 convention, still present below for tools that only check there).
    // Without this, `npx prisma db seed` — the standard, documented way to run it —
    // silently does nothing.
    seed: 'tsx prisma/seed.ts',
  },
});
