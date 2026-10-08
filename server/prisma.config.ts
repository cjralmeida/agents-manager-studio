import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Undefined at image build time: `prisma generate` does not need a database.
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
