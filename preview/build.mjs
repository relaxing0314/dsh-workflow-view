/**
 * Build the standalone preview driver (not part of the published package).
 *
 * `lib/client.js` is a browser artifact, so the only faithful way to exercise it
 * outside the harness page is to load it in a real page with a stub module
 * loader. This bundles `preview/main.tsx` — which captures the registration,
 * drives `apply(ctx)` against the same services the harness provides, and mounts
 * the registered view — with React resolved from the local DSH checkout.
 */

import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = dirname(ROOT)
const CHECKOUT = process.env.DSH_CHECKOUT ?? '/Users/gaojing/Desktop/my-projects/ai-deepseek-harness'

const require = createRequire(import.meta.url)

async function loadEsbuild() {
  try {
    return require('esbuild')
  } catch { /* fall through to the checkout store */ }
  const store = join(CHECKOUT, 'node_modules/.pnpm')
  for (const name of readdirSync(store).filter(entry => /^esbuild@\d/u.test(entry)).sort().reverse()) {
    const entry = join(store, name, 'node_modules/esbuild/lib/main.js')
    if (existsSync(entry)) return (await import(pathToFileURL(entry).href)).default
  }
  throw new Error('preview: no esbuild runtime found')
}

/** Resolve react/react-dom out of the pnpm store that the checkout already has. */
function reactAlias() {
  const store = join(CHECKOUT, 'node_modules/.pnpm')
  const version = readdirSync(store).find(entry => /^react@18\./u.test(entry))
  const domVersion = readdirSync(store).find(entry => entry.startsWith('react-dom@18.') && entry.includes('react@18.'))
  if (version === undefined || domVersion === undefined) {
    throw new Error('preview: react 18 is not present in the checkout pnpm store')
  }
  const react = join(store, version, 'node_modules/react')
  const reactDom = join(store, domVersion, 'node_modules/react-dom')
  return {
    react,
    'react/jsx-runtime': join(react, 'jsx-runtime.js'),
    'react/jsx-dev-runtime': join(react, 'jsx-dev-runtime.js'),
    'react-dom/client': join(reactDom, 'client.js'),
    'react-dom': reactDom,
  }
}

const esbuild = await loadEsbuild()

await esbuild.build({
  entryPoints: [join(ROOT, 'main.tsx')],
  outfile: join(ROOT, 'main.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  loader: { '.css': 'text', '.json': 'json' },
  alias: reactAlias(),
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'warning',
})

process.stdout.write(`preview: built ${join(ROOT, 'main.js')}\n`)
void PLUGIN_ROOT
