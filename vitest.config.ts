import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * The published `@deepseek-ai/dsh-client-runtime` ships its `/client` subpath
 * as a browser `window.__ModuleLoader__` bundle that Node/jsdom cannot import
 * (docs/CLIENT_UI_LESSONS.zh-CN.md §1). The jsdom client suite aliases that
 * one module to a contract-identical stub; every other test is unaffected.
 */
const clientRuntimeStub = fileURLToPath(new URL('./tests/stubs/client-runtime.ts', import.meta.url))

export default defineConfig({
  esbuild: {
    // Client sources use the automatic JSX runtime (matches build-client.cjs).
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-runtime/client': clientRuntimeStub,
    },
  },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    environment: 'node',
  },
})
