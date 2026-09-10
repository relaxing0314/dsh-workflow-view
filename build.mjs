/**
 * Build script for dsh-workflow-view.
 *
 * Produces the two artifacts the DSH client module system expects:
 *
 *   lib/index.js   — the Node half the host Loader imports for the row in
 *                    `cordis.patch.yml`. Inert by design.
 *   lib/client.js  — the browser bundle, wrapped in the closure-factory
 *                    handoff `window.__ModuleLoader__.load({id, factory})`.
 *                    Externals stay `require()` calls answered by the
 *                    module table (react, react/jsx-runtime, …); everything
 *                    else is inlined. CSS is inlined as text and injected by
 *                    the plugin's own lifecycle effect.
 *
 * esbuild is not a declared dependency of this package: a DSH checkout already
 * ships one, and the plugin has no other build-time need. Set
 * `DSH_WORKFLOW_ESBUILD` to an explicit `esbuild` entry point when building in
 * an environment where none of the probed locations apply.
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const ID = PKG.name

/** Every specifier the browser answers from the module table, per `dsh.client`. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

async function loadEsbuild() {
  const require = createRequire(import.meta.url)
  const tried = []
  if (process.env.DSH_WORKFLOW_ESBUILD !== undefined) {
    const url = pathToFileURL(process.env.DSH_WORKFLOW_ESBUILD).href
    return (await import(url)).default ?? (await import(url))
  }
  try {
    return require('esbuild')
  } catch {
    tried.push('esbuild (local resolution)')
  }
  for (const base of [
    '/Users/gaojing/Desktop/my-projects/ai-deepseek-harness/node_modules',
    join(ROOT, 'node_modules'),
  ]) {
    const store = join(base, '.pnpm')
    if (!existsSync(store)) continue
    const versions = require('node:fs').readdirSync(store)
      .filter(name => /^esbuild@\d/.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .reverse()
    for (const version of versions) {
      const entry = join(store, version, 'node_modules', 'esbuild', 'lib', 'main.js')
      if (!existsSync(entry)) continue
      tried.push(entry)
      try {
        const mod = await import(pathToFileURL(entry).href)
        return mod.default ?? mod
      } catch {
        // try the next candidate
      }
    }
  }
  throw new Error(
    'dsh-workflow-view: no esbuild runtime found.\n'
    + `Probed:\n  ${tried.join('\n  ')}\n`
    + 'Install esbuild here or point DSH_WORKFLOW_ESBUILD at an esbuild entry point.',
  )
}

const esbuild = await loadEsbuild()

mkdirSync(join(ROOT, 'lib'), { recursive: true })
mkdirSync(join(ROOT, 'lib/types/client'), { recursive: true })

/* ---------------------------------------------------------------- Node half */

await esbuild.build({
  entryPoints: [join(ROOT, 'src/index.ts')],
  outfile: join(ROOT, 'lib/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  packages: 'external',
  sourcemap: true,
  logLevel: 'warning',
})

/* ------------------------------------------------------------- Browser half */

const wrapperBanner = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
].join('\n')

await esbuild.build({
  entryPoints: [join(ROOT, 'src/client/index.ts')],
  outfile: join(ROOT, 'lib/client.js'),
  bundle: true,
  // CJS is the shape the module loader's factory handoff expects: every
  // external survives as a `require(...)` answered by the injected table.
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: CLIENT_EXTERNALS,
  jsx: 'automatic',
  jsxDev: false,
  loader: { '.css': 'text' },
  sourcemap: true,
  sourcesContent: true,
  legalComments: 'none',
  logLevel: 'warning',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  banner: { js: wrapperBanner },
  footer: { js: 'return module.exports; } });' },
})

/* ------------------------------------------------------ Declaration stubs */

writeFileSync(join(ROOT, 'lib/types/index.d.ts'), [
  '/** Host half of dsh-workflow-view: mounts the package so the client module system serves it. */',
  'export declare function apply(): void',
  '',
].join('\n'))

writeFileSync(join(ROOT, 'lib/types/client/index.d.ts'), [
  '/** Browser half of dsh-workflow-view: registers the 工作流 conversation view. */',
  "import type { Context } from '@deepseek-ai/cordis'",
  '',
  'export declare const inject: readonly string[]',
  'export declare function apply(ctx: Context): void',
  '',
].join('\n'))

const clientBytes = readFileSync(join(ROOT, 'lib/client.js')).byteLength
const nodeBytes = readFileSync(join(ROOT, 'lib/index.js')).byteLength
process.stdout.write(
  `${ID}: built lib/index.js (${nodeBytes} B) and lib/client.js (${clientBytes} B)\n`,
)
