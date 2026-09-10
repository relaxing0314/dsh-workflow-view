/**
 * Projection-level checks (dev tooling only).
 *
 * `preview/check.mjs` proves the view renders; this proves the model behind it
 * classifies the durable Session events correctly for the cases a live session
 * actually produces: an open tool call, streamed-but-unsettled assistant output,
 * a failed turn, a compaction surface replacement, and a request header that
 * carries forward until it changes.
 *
 * Usage: node preview/projection-check.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { readdirSync, existsSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = dirname(HERE)
const CHECKOUT = process.env.DSH_CHECKOUT ?? '/Users/gaojing/Desktop/my-projects/ai-deepseek-harness'
const require = createRequire(import.meta.url)

async function loadEsbuild() {
  try {
    return require('esbuild')
  } catch { /* fall back to the checkout store */ }
  const store = join(CHECKOUT, 'node_modules/.pnpm')
  for (const name of readdirSync(store).filter(entry => /^esbuild@\d/u.test(entry)).sort().reverse()) {
    const entry = join(store, name, 'node_modules/esbuild/lib/main.js')
    if (existsSync(entry)) return (await import(pathToFileURL(entry).href)).default
  }
  throw new Error('projection-check: no esbuild runtime found')
}

const esbuild = await loadEsbuild()
const OUT = join(PLUGIN_ROOT, '.tmp')
mkdirSync(OUT, { recursive: true })
const BUNDLE = join(OUT, 'projection.mjs')
await esbuild.build({
  entryPoints: [join(PLUGIN_ROOT, 'src/client/projection.ts')],
  outfile: BUNDLE,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  logLevel: 'warning',
})
const { projectWorkflow, projectWorkflowMemo } = await import(pathToFileURL(BUNDLE).href)

const failures = []
const notes = []
const check = (condition, message) => {
  if (condition) notes.push(`ok   ${message}`)
  else failures.push(message)
}

const durable = (type, seq, time, data, extra = {}) => ({ type: 'event', event: { type, seq, time, data, ...extra } })
const transient = (seq, time, turn, step, chunk) => ({
  type: 'transient',
  event: { type: 'assistant/live-chunk', seq, time, data: { turn, step, attemptId: 'a1', chunk } },
})

/* ------------------------------------------------------------ live session */

const header = {
  header: {
    config: { provider: 'p', model: 'm' },
    system: 'SYS',
    tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }],
  },
  reason: 'initial',
}

const events = [
  durable('turn/start', 1, 1000, { turn: 1 }),
  durable('request/header', 2, 1001, header),
  durable('user/message', 3, 1002, {
    role: 'user', id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我修复构建' }],
  }, { surfaceOp: 'append' }),
  durable('step/start', 4, 1003, { turn: 1, step: 1 }),
  // streaming, not yet settled
  transient(100, 1100, 1, 1, { type: 'reasoning-delta', text: '想一想' }),
  transient(101, 1101, 1, 1, { type: 'text-delta', text: '好的' }),

  durable('assistant/message', 5, 1200, {
    turn: 1,
    step: 1,
    message: { role: 'assistant', id: 'a1', content: [{ type: 'reasoning', text: 'R1' }, { type: 'text', text: 'C1' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }] },
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 5, reasoningTokens: 7 },
  }, { surfaceOp: 'append' }),
  durable('tool/call', 6, 1205, { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }),
  durable('tool/result', 7, 1305, {
    turn: 1, step: 1,
    message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'file-a\nfile-b' }] }] },
  }, { surfaceOp: 'append' }),
  durable('step/end', 8, 1310, { turn: 1, step: 1 }),

  durable('step/start', 9, 1400, { turn: 1, step: 2 }),
  // still open: a call with no result yet
  durable('tool/call', 10, 1450, { turn: 1, step: 2, callId: 'c2', name: 'bash', arguments: '{"command":"sleep"}' }),
  durable('assistant/message', 11, 1460, {
    turn: 1, step: 2,
    message: { role: 'assistant', id: 'a2', content: [{ type: 'tool-call', id: 'c2', name: 'bash', arguments: '{"command":"sleep"}' }] },
    usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 100 },
  }, { surfaceOp: 'append' }),
  durable('tool/call', 12, 1470, { turn: 1, step: 2, callId: 'c2', name: 'bash', arguments: '{"command":"sleep"}' }),
]

const model = projectWorkflow(events)
check(model.rounds.length === 1, 'one turn produces one round')
const round = model.rounds[0]
check(round.modelCallCount === 2, `two model calls recorded (got ${round.modelCallCount})`)
check(round.live === true && round.status === 'running', 'an open turn is running')
check(round.promptSummary.includes('帮我修复构建'), 'round summary comes from the human prompt')
check(round.toolCallCount === 3, `three tool calls recorded (got ${round.toolCallCount})`)

const first = round.calls[0]
check(first.request?.system === 'SYS', 'request carries the recorded system prompt')
check(first.request?.tools.length === 1, 'request carries the recorded tool catalog')
check(first.request?.messages.length === 1, `first request sees the user prompt only (got ${first.request?.messages.length})`)
check(first.response?.reasoning === 'R1' && first.response?.content === 'C1', 'response splits reasoning and content')
check(first.response?.toolCalls.length === 1, 'response lists the recorded tool calls')
check(first.live === null, 'a settled call clears its live overlay')
check(first.status === 'complete', `settled call is complete (got ${first.status})`)
check(first.usage?.inputTokens === 1005, `input tokens = uncached + cache read + cache write (got ${first.usage?.inputTokens})`)
check(first.usage?.uncachedInputTokens === 100, 'uncached input is the adapter inputTokens bucket')
check(first.usage?.cacheReadTokens === 900 && first.usage?.cacheWriteTokens === 5, 'cache read/write buckets are preserved')
check(first.usage?.outputTokens === 20, 'output tokens are preserved')
check(first.durationMs === 307, `call duration spans step start to step end (got ${first.durationMs})`)

const second = round.calls[1]
check(second.request === first.request || second.request?.seq === first.request?.seq,
  'the request header carries forward: step 2 reuses the same recorded header')
check(second.request?.messages.length === 3,
  `step 2 sees user + assistant + tool result (got ${second.request?.messages.length})`)
const openTool = second.tools[0]
check(openTool?.status === 'running' && openTool.durationMs === null, 'a tool call without a result stays 运行中')
// The model call itself settled when its assistant message landed; the step is
// still open, so it has no measured duration until step/end.
check(second.status === 'complete' && second.endedAt === null,
  'a settled model call inside an open step has no duration yet')

/* -------------------------------------------------------- live-only change */

// A third step that has streamed but not settled: this is the only state in
// which live deltas are authoritative.
const withLive = [
  ...events,
  durable('step/start', 13, 1500, { turn: 1, step: 3 }),
  transient(200, 1550, 1, 3, { type: 'reasoning-delta', text: '推理中' }),
  transient(201, 1551, 1, 3, { type: 'text-delta', text: '生成中' }),
]
const liveModel = projectWorkflow(withLive)
check(liveModel.rounds[0].calls[2].live?.content === '生成中',
  `streamed deltas surface as live output on the open call (got ${String(liveModel.rounds[0].calls[2].live?.content)})`)
check(liveModel.rounds[0].calls[2].live?.reasoning === '推理中', 'streamed reasoning deltas are kept separately')
check(liveModel.rounds[0].calls[0].live === null, 'a settled call never shows live output')
const memoA = projectWorkflowMemo(withLive)
const memoB = projectWorkflowMemo(withLive)
check(memoA === memoB, 'the durable signature lets a live-only change reuse the memoized model')

/* ------------------------------------------------------------- failed turn */

const failed = [
  ...events,
  durable('turn/end', 20, 2000, { turn: 1, reason: { kind: 'error', error: { message: 'provider exploded', code: 'X' } } }),
]
const failedModel = projectWorkflow(failed)
check(failedModel.rounds[0].status === 'failed', `turn/end error marks the round failed (got ${failedModel.rounds[0].status})`)
check(failedModel.rounds[0].endError === 'provider exploded', 'the failure message is retained')
check(failedModel.rounds[0].live === false, 'a closed turn is no longer live')
check(failedModel.stats.totalDurationMs === 1000, `total duration spans the turn (got ${failedModel.stats.totalDurationMs})`)

/* ------------------------------------------------- compaction replacement */

const compacted = [
  durable('turn/start', 1, 1, { turn: 1 }),
  durable('request/header', 1, 1, header),
  durable('user/message', 2, 2, { role: 'user', id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'a' }] }, { surfaceOp: 'append' }),
  durable('user/message', 3, 3, { role: 'user', id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: 'b' }] }, { surfaceOp: 'append' }),
  durable('user/message', 4, 4, { role: 'user', id: 'u3', source: { kind: 'user' }, content: [{ type: 'text', text: 'c' }] }, { surfaceOp: 'append' }),
  durable('step/start', 5, 5, { turn: 1, step: 1 }),
  durable('assistant/message', 6, 6, {
    turn: 1, step: 1, message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'x' }] },
  }, { surfaceOp: 'append' }),
  // compaction replaces the seq range 2..3 with one summary message
  durable('user/message', 7, 7, { role: 'user', id: 's1', source: { kind: 'plugin', plugin: 'compaction' }, content: [{ type: 'text', text: 'summary' }] },
    { surfaceOp: { op: 'replace', start: 2, end: 3 }, sourceEventSeqs: [2, 3] }),
  durable('step/start', 8, 8, { turn: 1, step: 2 }),
  durable('assistant/message', 9, 9, {
    turn: 1, step: 2, message: { role: 'assistant', id: 'a2', content: [{ type: 'text', text: 'y' }] },
  }, { surfaceOp: 'append' }),
]
const compactedModel = projectWorkflow(compacted)
const step2 = compactedModel.rounds[0].calls[1]
const texts = step2.request?.messages.map(m => m.blocks.map(b => (b.kind === 'text' ? b.text : '')).join('')) ?? []
check(texts.join(',') === 'summary,c,x', `compaction replacement keeps the summarized position (got ${texts.join(',')})`)

/* -------------------------------------------------- empty and no-header case */

const bare = projectWorkflow([durable('assistant/message', 1, 1, {
  turn: 1, step: 1, message: { role: 'assistant', id: 'a', content: [{ type: 'text', text: 'hi' }] },
}, { surfaceOp: 'append' })])
check(bare.rounds.length === 1, 'a window without turn/start still yields a round')
check(bare.rounds[0].calls[0].request === null, 'a request with no loaded header reports null instead of guessing')

const empty = projectWorkflow([])
check(empty.rounds.length === 0 && empty.stats.modelCalls === 0, 'an empty window projects an empty model')

writeFileSync(join(OUT, 'projection-check.txt'), `${notes.join('\n')}\n`)
process.stdout.write(`${notes.join('\n')}\n\n`)
if (failures.length > 0) {
  process.stdout.write(`FAIL ${failures.length}\n${failures.map(f => `  - ${f}`).join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('PASS: every projection assertion held\n')
}
