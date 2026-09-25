import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Load @graphql-tools/utils through vite so it shares the test's ESM copy
    // of graphql. Otherwise it pulls in the CJS build, and graphql's
    // instanceof checks fail across the two copies.
    server: { deps: { inline: ['@graphql-tools/utils'] } },
  },
})
