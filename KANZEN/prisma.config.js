import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node prisma/seed.js',
  },
  // DATABASE_URL n'est requise que pour migrate / db (pas pour generate, lors du build)
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
