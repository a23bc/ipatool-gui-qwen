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
    // No manual chunk splitting, deliberately.
    //
    // Splitting only pays off for (a) HTTP cache reuse across deploys and
    // (b) lazy loading via dynamic import. Neither applies to an Electron
    // renderer: the whole bundle ships inside the installer, every module is
    // loaded at start-up, and there are no dynamic imports. Splitting would just
    // add chunk-boundary wrappers and extra file reads (it previously produced a
    // 344-byte orphan chunk holding zustand alone), for ~zero gzip difference.
  },
  server: {
    port: 5173,
    strictPort: true
  },
  esbuild: {
    legalComments: 'none'
  }
})
