import fs from 'node:fs';
import { defineConfig } from 'prisma/config';

// Comme l'application : DATABASE_URL, ou son contenu lu dans le fichier DATABASE_URL_FILE
const url = process.env.DATABASE_URL
  ?? (process.env.DATABASE_URL_FILE ? fs.readFileSync(process.env.DATABASE_URL_FILE, 'utf8').trim() : '');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node prisma/seed.js',
  },
  // DATABASE_URL n'est requise que pour migrate / db (pas pour generate, lors du build)
  datasource: { url },
});
