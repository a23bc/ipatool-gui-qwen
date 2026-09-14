import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.join(root, 'src/shared'),
      '@main': path.join(root, 'src/main'),
      '@renderer': path.join(root, 'src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    reporters: ['default'],
    coverage: { enabled: false }
  }
})
