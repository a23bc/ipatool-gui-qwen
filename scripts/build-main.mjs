#!/usr/bin/env node
/**
 * Bundles the Electron main + preload processes with esbuild.
 *
 * Everything is bundled into a single CJS file per entry (only `electron` and
 * Node builtins stay external), which means the packaged app ships no
 * node_modules at all. This keeps the installer small and start-up fast.
 *
 * Top-level await is used, so this file must stay ESM (.mjs) on Node >= 18.
 */
import { fileURLToPath } from 'node:url'
import { rm, mkdir, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')
const outDir = path.join(projectRoot, 'dist')

const watch = process.argv.includes('--watch')
const production = !watch

// Injected at build time. APP_REPO is supplied by CI as ${{ github.repository }}
// so "check for updates" works without hard-coding an owner into the source.
const pkg = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
const defines = {
  'process.env.NODE_ENV': production ? '"production"' : '"development"',
  // Empty string means "unset" (CI passes '' for non-tag runs), so use || not ??.
  __APP_VERSION__: JSON.stringify(process.env.APP_VERSION || pkg.version || '0.0.0'),
  __APP_REPO__: JSON.stringify(process.env.APP_REPO ?? ''),
  __APP_PRODUCT__: JSON.stringify(pkg.productName ?? pkg.name ?? 'IPATool GUI')
}

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: production ? false : 'inline',
  minify: production,
  legalComments: 'none',
  logLevel: 'info',
  // Electron itself, and anything it injects at runtime, must stay external.
  external: ['electron'],
  define: defines,
  tsconfig: path.join(projectRoot, 'tsconfig.node.json'),
  absWorkingDir: projectRoot,
  logOverride: {
    'empty-import-meta': 'silent'
  }
}

const entries = [
  {
    ...shared,
    entryPoints: [path.join(projectRoot, 'src/main/index.ts')],
    outfile: path.join(outDir, 'main/index.js')
  },
  {
    ...shared,
    entryPoints: [path.join(projectRoot, 'src/preload/index.ts')],
    outfile: path.join(outDir, 'preload/index.js'),
    // Preload runs in a sandboxed-ish isolated world; keep it self contained.
    minify: production
  }
]

async function main() {
  await rm(outDir, { recursive: true, force: true })
  await mkdir(path.join(outDir, 'main'), { recursive: true })
  await mkdir(path.join(outDir, 'preload'), { recursive: true })

  if (watch) {
    for (const options of entries) {
      const ctx = await (await import('esbuild')).context(options)
      await ctx.watch()
    }
    console.log('[build-main] watching src/main + src/preload …')
    return
  }

  await Promise.all(entries.map((options) => build(options)))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
