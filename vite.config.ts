import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const root = fileURLToPath(new URL('./src/renderer', import.meta.url))

// Renderer-only Vite config. The main/preload processes are bundled by
// scripts/build-main.mjs with esbuild (see `npm run build:main`).
export default defineConfig({
  root,
  base: './',
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@renderer': fileURLToPath(new URL('./src/renderer/src', import.meta.url))
    }
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    // Electron loads assets from the filesystem, so relative paths are required.
    assetsInlineLimit: 4096,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Split the heavy, rarely-changing vendor code so the app shell stays tiny
        // and repeat launches hit the disk cache.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('@tanstack')) return 'vendor-virtual'
          if (id.includes('react') || id.includes('scheduler')) return 'vendor-react'
          return 'vendor'
        }
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true
  },
  esbuild: {
    legalComments: 'none'
  }
})
