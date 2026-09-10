/**
 * Tiny static server for the preview harness (not part of the published package).
 * Serves the plugin directory so `preview/index.html` can load `../lib/client.js`.
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.env.PREVIEW_PORT ?? 5199)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/u, '')
  const path = join(PLUGIN_ROOT, relative === '/' ? 'preview/index.html' : relative)
  readFile(path)
    .then((body) => {
      response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' })
      response.end(body)
    })
    .catch(() => {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found\n')
    })
}).listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`preview: http://127.0.0.1:${PORT}/preview/index.html\n`)
})
