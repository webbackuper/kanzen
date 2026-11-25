import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    fileParallelism: false, // une seule base de test partagée
    testTimeout: 20000,
    hookTimeout: 60000,
  },
});
