import { defineConfig } from 'vitest/config'

/**
 * The client suite drives the real published `@deepseek-ai/dsh-client-store`
 * (plain ESM, importable from Node) — no stub alias needed.
 */
export default defineConfig({
  esbuild: {
    // Client sources use the automatic JSX runtime (matches build-client.cjs).
    jsx: 'automatic',
  },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    environment: 'node',
  },
})
