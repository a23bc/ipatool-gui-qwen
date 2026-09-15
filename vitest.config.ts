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
    // M12: coverage is a regression gate for a security-sensitive codebase.
    // `npm run test:watch` opts out (via CLI flag) to stay fast; CI runs with
    // it on, so new code that drops a directory below its floor fails the build.
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/shared/**/*.ts', 'src/main/**/*.ts'],
      // Process entry points are glue (app lifecycle, window chrome) that
      // cannot be meaningfully unit-tested without booting Electron.
      exclude: ['src/main/index.ts', 'src/main/window.ts'],
      thresholds: {
        // Regression floors, calibrated just below the current baseline
        // (shared ~87%, main partial): new code that drags a directory down
        // fails the build. Ratchet these upward as main-process coverage grows
        // toward the report's target (shared 90 / main 60+).
        statements: 40,
        branches: 40,
        functions: 45,
        lines: 40,
        // The pure shared layer is fully testable - hold it to a high bar.
        'src/shared/**': {
          statements: 82,
          branches: 78,
          functions: 85,
          lines: 82
        }
      }
    }
  }
})
