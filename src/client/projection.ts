/**
 * Durable Session events -> Workflow model.
 *
 * Pure, dependency-free, and strictly additive: every field this module emits
 * is read from a field the Session log already recorded. Nothing is inferred
 * from harness source, and no request is ever re-assembled from scratch — the
 * system prompt, tool catalog, and message list shown for one model call are
 * the `request/header` snapshot in effect at that call plus the surface
 * messages that preceded it.
 */

import type { DshSessionEvent, DshSessionEventEntry } from '../dsh'

/* ------------------------------------------------------------------ shapes */

/** Token and cache accounting for one model call, or a sum over many. */
export interface WorkflowUsage {
  /** All prompt tokens: uncached input plus cache read plus cache write. */
  inputTokens: number
  /** Prompt tokens the provider did not serve from, or write to, its cache. */
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
}

/** One provider-neutral message in a request's ordered conversation. */
export interface NeutralMessage {
  seq: number
  role: 'user' | 'assistant' | 'tool'
  /** Durable producer discriminator (`user`, `plugin`, `model`, `tool`, …). */
  sourceKind: string
  sourceLabel: string
  blocks: NeutralBlock[]
  /** The logged message payload, kept for the raw-record inspector. */
  raw: unknown
}

/** One content block of a {@link NeutralMessage}. */
export type NeutralBlock =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'image'; label: string }
  | { kind: 'tool-call'; callId: string; name: string; arguments: string }
  | { kind: 'tool-result'; callId: string; text: string; isError: boolean }
  | { kind: 'other'; blockType: string; raw: unknown }

/** One tool schema as recorded in the request header. */
export interface ToolSchemaRecord {
  name: string
  description: string
  parameters: unknown
}

/** The request in effect for one model call. */
export interface RequestRecord {
  /** Sequence of the `request/header` event this state was read from. */
  seq: number
  time: number
  /** `initial` | `resume` | `change` | `series`. */
  reason: string
  config: Record<string, unknown>
  system: string
  tools: readonly ToolSchemaRecord[]
  /** Provider-neutral conversation as recorded before this call was dispatched. */
  messages: readonly NeutralMessage[]
}

/** The assistant answer recorded for one model call. */
export interface ResponseRecord {
  seq: number
  time: number
  reasoning: string
  content: string
  toolCalls: readonly { callId: string; name: string; arguments: string }[]
  interrupted: boolean
  usage: WorkflowUsage | null
  /** The `assistant/message` payload exactly as persisted. */
  raw: unknown
}

/** A settled attempt that committed no model-visible message. */
export interface AttemptRecord {
  seq: number
  time: number
  turn: number
  step: number
  raw: unknown
}

/** Live, not-yet-durable assistant output for one open model call. */
export interface LiveOutput {
  reasoning: string
  content: string
  toolCalls: readonly { callId: string; name: string }[]
}

/** One tool execution: its call, its result, and the timing between them. */
export interface ToolExecution {
  callId: string
  name: string
  argumentsRaw: string
  argumentsParsed: unknown
  startedAt: number
  endedAt: number | null
  durationMs: number | null
  status: 'running' | 'completed' | 'failed'
  error: { name: string; code: string; message: string } | null
  resultText: string
  resultRaw: unknown
  meta: unknown
  seq: number
  resultSeq: number | null
}

/** One model call (one agent-loop step) inside a user turn. */
export interface ModelCall {
  key: string
  turn: number
  step: number
  /** 1-based ordinal inside its turn. */
  index: number
  startedAt: number
  endedAt: number | null
  durationMs: number | null
  status: 'running' | 'complete' | 'error' | 'interrupted'
  usage: WorkflowUsage | null
  request: RequestRecord | null
  response: ResponseRecord | null
  attempts: readonly AttemptRecord[]
  /** Present only while the call is still streaming. */
  live: LiveOutput | null
  tools: ToolExecution[]
}

/** One user conversation round: everything between `turn/start` and `turn/end`. */
export interface WorkflowRound {
  turn: number
  startedAt: number
  endedAt: number | null
  /** Settled duration, or the elapsed span recorded so far for an open round. */
  durationMs: number | null
  /** True while the round has no closing `turn/end`. */
  live: boolean
  status: 'running' | 'completed' | 'failed' | 'aborted' | 'blocked'
  endKind: string
  endError: string | null
  /** Direct human prompts recorded in this round, in order. */
  prompts: readonly NeutralMessage[]
  promptSummary: string
  promptText: string
  calls: readonly ModelCall[]
  modelCallCount: number
  toolCallCount: number
  usage: WorkflowUsage
}

/** Whole-session workflow: the rounds plus the header totals. */
export interface WorkflowModel {
  rounds: readonly WorkflowRound[]
  stats: {
    rounds: number
    modelCalls: number
    toolCalls: number
    totalDurationMs: number
    usage: WorkflowUsage
    running: boolean
  }
}

/* ------------------------------------------------------------------- reads */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(source: Record<string, unknown> | null, key: string): string {
  const value = source?.[key]
  return typeof value === 'string' ? value : ''
}

function readNumber(source: Record<string, unknown> | null, key: string): number {
  const value = source?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readArray(source: Record<string, unknown> | null, key: string): readonly unknown[] {
  const value = source?.[key]
  return Array.isArray(value) ? value : []
}

function asBlocks(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== null)
    : []
}

/** Parse a raw tool-argument string without letting malformed JSON escape. */
export function parseArguments(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/* ---------------------------------------------------------------- messages */

function toNeutralBlock(block: Record<string, unknown>): NeutralBlock {
  const blockType = readString(block, 'type')
  switch (blockType) {
    case 'text':
      return { kind: 'text', text: readString(block, 'text') }
    case 'reasoning':
      return { kind: 'reasoning', text: readString(block, 'text') }
    case 'image': {
      const attachment = asRecord(block.attachment)
      const label = readString(attachment, 'name')
        || readString(attachment, 'mimeType')
        || readString(attachment, 'id')
        || 'image'
      return { kind: 'image', label }
    }
    case 'tool-call':
      return {
        kind: 'tool-call',
        callId: String(block.id ?? ''),
        name: readString(block, 'name'),
        arguments: readString(block, 'arguments'),
      }
    case 'tool-result': {
      const nested = asBlocks(block.content)
      const text = nested
        .map(entry => (readString(entry, 'type') === 'text' ? readString(entry, 'text') : ''))
        .filter(part => part !== '')
        .join('\n')
      return {
        kind: 'tool-result',
        callId: String(block.toolCallId ?? ''),
        text,
        isError: block.isError === true,
      }
    }
    default:
      return { kind: 'other', blockType: blockType === '' ? 'unknown' : blockType, raw: block }
  }
}

function sourceKindOf(source: Record<string, unknown> | null): string {
  return readString(source, 'kind') || 'unknown'
}

/** A short, human-readable producer label for one durable message source. */
function sourceLabelOf(source: Record<string, unknown> | null): string {
  const kind = sourceKindOf(source)
  if (source === null) return kind
  switch (kind) {
    case 'plugin': return readString(source, 'plugin') || kind
    case 'skill-invocation': return readString(source, 'name') || kind
    case 'model': {
      const provider = readString(source, 'provider')
      const model = readString(source, 'model')
      return provider === '' ? model || kind : `${provider}/${model}`
    }
    case 'tool': return readString(source, 'callId') || kind
    default: return readString(source, 'form') || kind
  }
}

function toNeutralMessage(role: NeutralMessage['role'], seq: number, payload: Record<string, unknown>): NeutralMessage {
  const source = asRecord(payload.source)
  return {
    seq,
    role,
    sourceKind: sourceKindOf(source),
    sourceLabel: sourceLabelOf(source),
    blocks: asBlocks(payload.content).map(toNeutralBlock),
    raw: payload,
  }
}

/** Flatten one neutral message to the plain text a summary or a preview needs. */
export function messageText(message: NeutralMessage): string {
  return message.blocks
    .map((block) => {
      switch (block.kind) {
        case 'text':
        case 'reasoning':
          return block.text
        case 'tool-call':
          return `${block.name}(${block.arguments})`
        case 'tool-result':
          return block.text
        case 'image':
          return `[image ${block.label}]`
        default:
          return ''
      }
    })
    .filter(part => part !== '')
    .join('\n')
}

/* ------------------------------------------------------------------ surface */

interface Surface {
  readonly order: NeutralMessage[]
}

/**
 * Apply one surface-eligible event to the ordered provider-neutral surface.
 * A `replace` op takes the position of the earliest node it shadows, which is
 * how compaction keeps the replacement where the summarized range used to be.
 */
function applySurface(
  surface: Surface,
  op: unknown,
  message: NeutralMessage,
): void {
  if (op === 'append' || op === undefined) {
    surface.order.push(message)
    return
  }
  const record = asRecord(op)
  if (record === null || readString(record, 'op') !== 'replace') {
    surface.order.push(message)
    return
  }
  const start = readNumber(record, 'start')
  const end = readNumber(record, 'end')
  let insertAt = -1
  const kept: NeutralMessage[] = []
  for (const candidate of surface.order) {
    if (candidate.seq >= start && candidate.seq <= end) {
      if (insertAt < 0) insertAt = kept.length
      continue
    }
    kept.push(candidate)
  }
  if (insertAt < 0) insertAt = kept.length
  kept.splice(insertAt, 0, message)
  surface.order.length = 0
  surface.order.push(...kept)
}

/* ------------------------------------------------------------------ usage */

const ZERO_USAGE: WorkflowUsage = {
  inputTokens: 0,
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
}

/**
 * Bucket one provider-reported usage record.
 *
 * The adapter's `inputTokens` is the *uncached* prompt count; cache reads and
 * writes are reported beside it, and the full prompt is their sum. This mirrors
 * `@deepseek-ai/dsh-token-meter`'s own bucketing so the totals reconcile with
 * the rest of the product.
 */
function toUsage(value: unknown): WorkflowUsage | null {
  const usage = asRecord(value)
  if (usage === null) return null
  const uncached = readNumber(usage, 'inputTokens')
  const cacheRead = readNumber(usage, 'cacheReadTokens')
  const cacheWrite = readNumber(usage, 'cacheWriteTokens')
  return {
    inputTokens: uncached + cacheRead + cacheWrite,
    uncachedInputTokens: uncached,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: readNumber(usage, 'outputTokens'),
    reasoningTokens: readNumber(usage, 'reasoningTokens'),
  }
}

/** Sum usage buckets over an iterable of calls, treating absent usage as zero. */
export function sumUsage(values: Iterable<WorkflowUsage | null>): WorkflowUsage {
  const total: WorkflowUsage = { ...ZERO_USAGE }
  for (const value of values) {
    if (value === null) continue
    total.inputTokens += value.inputTokens
    total.uncachedInputTokens += value.uncachedInputTokens
    total.cacheReadTokens += value.cacheReadTokens
    total.cacheWriteTokens += value.cacheWriteTokens
    total.outputTokens += value.outputTokens
    total.reasoningTokens += value.reasoningTokens
  }
  return total
}

/* -------------------------------------------------------------- projection */

function isDurableEvent(entry: DshSessionEventEntry): boolean {
  return entry.type === 'event' && typeof entry.event?.type === 'string'
}

function turnOf(event: DshSessionEvent): number | null {
  const data = asRecord(event.data)
  const turn = data?.turn
  return typeof turn === 'number' ? turn : null
}

function stepOf(event: DshSessionEvent): number | null {
  const data = asRecord(event.data)
  const step = data?.step
  return typeof step === 'number' ? step : null
}

/** Accumulator for one streaming attempt, discarded once its message settles. */
interface LiveAccumulator {
  reasoning: string
  content: string
  toolCalls: { callId: string; name: string }[]
}

function newLive(): LiveAccumulator {
  return { reasoning: '', content: '', toolCalls: [] }
}

function liveChunkOf(event: DshSessionEvent): { turn: number; step: number; chunk: Record<string, unknown> } | null {
  const data = asRecord(event.data)
  if (data === null) return null
  const chunk = asRecord(data.chunk)
  const turn = typeof data.turn === 'number' ? data.turn : null
  const step = typeof data.step === 'number' ? data.step : null
  if (chunk === null || turn === null || step === null) return null
  return { turn, step, chunk }
}

function applyLiveChunk(target: LiveAccumulator, chunk: Record<string, unknown>): void {
  switch (readString(chunk, 'type')) {
    case 'reasoning-delta':
      target.reasoning += readString(chunk, 'text')
      break
    case 'text-delta':
      target.content += readString(chunk, 'text')
      break
    case 'tool-call': {
      const callId = String(chunk.id ?? '')
      if (callId !== '' && !target.toolCalls.some(entry => entry.callId === callId)) {
        target.toolCalls.push({ callId, name: readString(chunk, 'name') })
      }
      break
    }
    default:
      break
  }
}

interface HeaderState {
  seq: number
  time: number
  reason: string
  config: Record<string, unknown>
  system: string
  tools: readonly ToolSchemaRecord[]
}

function readHeader(event: DshSessionEvent): HeaderState | null {
  const data = asRecord(event.data)
  const header = asRecord(data?.header)
  if (header === null) return null
  return {
    seq: event.seq,
    time: event.time,
    reason: readString(data, 'reason') || 'initial',
    config: asRecord(header.config) ?? {},
    system: readString(header, 'system'),
    tools: readArray(header, 'tools')
      .map(asRecord)
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .map(entry => ({
        name: readString(entry, 'name'),
        description: readString(entry, 'description'),
        parameters: entry.parameters,
      })),
  }
}

function firstLine(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`
}

/**
 * Project the loaded Session event window into the Workflow model.
 *
 * @param entries - durable and transient rows of one Session event window.
 * @returns per-round execution chains, ordered as the Session recorded them.
 */
export function projectWorkflow(entries: readonly DshSessionEventEntry[]): WorkflowModel {
  const rounds: WorkflowRound[] = []
  const roundsByTurn = new Map<number, WorkflowRound>()
  // `WorkflowRound.calls` is readonly in the published shape; these are the
  // mutable handles to the same arrays the projection appends to.
  const callsByTurn = new Map<number, ModelCall[]>()
  const callsByKey = new Map<string, ModelCall>()
  const toolsByCallId = new Map<string, ToolExecution>()
  const surface: Surface = { order: [] }
  const live = new Map<string, LiveAccumulator>()

  let header: HeaderState | null = null
  let currentTurn: number | null = null
  let currentStep: number | null = null
  let syntheticTurn = 0
  let lastTime = 0

  const ensureRound = (turn: number, time: number): WorkflowRound => {
    const existing = roundsByTurn.get(turn)
    if (existing !== undefined) return existing
    const calls: ModelCall[] = []
    const created: WorkflowRound = {
      turn,
      startedAt: time,
      endedAt: null,
      durationMs: null,
      live: true,
      status: 'running',
      endKind: '',
      endError: null,
      prompts: [],
      promptSummary: '',
      promptText: '',
      calls,
      modelCallCount: 0,
      toolCallCount: 0,
      usage: { ...ZERO_USAGE },
    }
    roundsByTurn.set(turn, created)
    rounds.push(created)
    callsByTurn.set(turn, calls)
    return created
  }

  const roundFor = (turn: number, time: number): WorkflowRound => ensureRound(turn, time)

  const callKey = (turn: number, step: number): string => `${turn}\u0000${step}`

  const ensureCall = (turn: number, step: number, time: number): ModelCall => {
    const key = callKey(turn, step)
    const existing = callsByKey.get(key)
    if (existing !== undefined) return existing
    const round = roundFor(turn, time)
    const created: ModelCall = {
      key,
      turn,
      step,
      index: round.calls.length + 1,
      startedAt: time,
      endedAt: null,
      durationMs: null,
      status: 'running',
      usage: null,
      request: null,
      response: null,
      attempts: [],
      live: null,
      tools: [],
    }
    callsByKey.set(key, created)
    callsByTurn.get(turn)?.push(created)
    return created
  }

  /** Freeze the request state in effect now, with the surface as it stands. */
  const snapshotRequest = (time: number): RequestRecord | null => {
    if (header === null) return null
    return {
      seq: header.seq,
      time: header.time === 0 ? time : header.time,
      reason: header.reason,
      config: header.config,
      system: header.system,
      tools: header.tools,
      // The array is cloned; the message objects themselves are shared.
      messages: surface.order.slice(),
    }
  }

  for (const entry of entries) {
    if (entry.type === 'transient') {
      const event = entry.event
      const parsed = liveChunkOf(event)
      if (parsed === null) continue
      const accumulator = live.get(callKey(parsed.turn, parsed.step)) ?? newLive()
      applyLiveChunk(accumulator, parsed.chunk)
      live.set(callKey(parsed.turn, parsed.step), accumulator)
      continue
    }
    if (!isDurableEvent(entry)) continue

    const event = entry.event
    const data = asRecord(event.data) ?? {}
    if (event.time > lastTime) lastTime = event.time

    switch (event.type) {
      case 'turn/start': {
        const turn = turnOf(event) ?? ++syntheticTurn
        currentTurn = turn
        currentStep = null
        ensureRound(turn, event.time)
        break
      }
      case 'turn/end': {
        const turn = turnOf(event) ?? currentTurn ?? ++syntheticTurn
        const round = ensureRound(turn, event.time)
        round.endedAt = event.time
        round.durationMs = Math.max(0, event.time - round.startedAt)
        const reason = asRecord(data.reason)
        const kind = readString(reason, 'kind') || 'completed'
        round.endKind = kind
        round.status = kind === 'completed'
          ? 'completed'
          : kind === 'aborted'
            ? 'aborted'
            : kind === 'blocked'
              ? 'blocked'
              : kind === 'error'
                ? 'failed'
                : 'completed'
        const failure = asRecord(reason?.error)
        round.endError = failure === null ? null : readString(failure, 'message') || null
        currentTurn = null
        currentStep = null
        break
      }
      case 'step/start': {
        // Explicit annotation: the fallback chain reads the variable this
        // assignment updates, which otherwise looks self-referential.
        const turn: number = turnOf(event) ?? currentTurn ?? ++syntheticTurn
        const step: number = stepOf(event) ?? 1
        currentTurn = turn
        currentStep = step
        ensureCall(turn, step, event.time).startedAt = event.time
        break
      }
      case 'step/end': {
        const turn = turnOf(event)
        const step = stepOf(event)
        if (turn === null || step === null) break
        const call = callsByKey.get(callKey(turn, step))
        if (call === undefined) break
        call.endedAt = event.time
        call.durationMs = Math.max(0, event.time - call.startedAt)
        if (call.status === 'running') {
          call.status = call.response === null && call.attempts.length > 0 ? 'error' : 'complete'
        }
        currentStep = null
        break
      }
      case 'request/header': {
        const next = readHeader(event)
        if (next !== null) header = next
        break
      }
      case 'request/context': {
        // Route metadata only; the header above already carries the effective config.
        break
      }
      case 'user/message': {
        const message = toNeutralMessage('user', event.seq, data)
        applySurface(surface, event.surfaceOp, message)
        const turn = currentTurn
        if (turn !== null && message.sourceKind === 'user') {
          const round = ensureRound(turn, event.time)
          ;(round.prompts as NeutralMessage[]).push(message)
        }
        break
      }
      case 'assistant/message': {
        const turn = turnOf(event) ?? currentTurn ?? ++syntheticTurn
        const step = stepOf(event) ?? currentStep ?? 1
        const call = ensureCall(turn, step, event.time)
        const payload = asRecord(data.message) ?? {}
        const blocks = asBlocks(payload.content).map(toNeutralBlock)
        call.response = {
          seq: event.seq,
          time: event.time,
          reasoning: blocks
            .filter((block): block is Extract<NeutralBlock, { kind: 'reasoning' }> => block.kind === 'reasoning')
            .map(block => block.text)
            .join('\n'),
          content: blocks
            .filter((block): block is Extract<NeutralBlock, { kind: 'text' }> => block.kind === 'text')
            .map(block => block.text)
            .join('\n'),
          toolCalls: blocks
            .filter((block): block is Extract<NeutralBlock, { kind: 'tool-call' }> => block.kind === 'tool-call')
            .map(block => ({ callId: block.callId, name: block.name, arguments: block.arguments })),
          interrupted: data.interrupted === true,
          usage: toUsage(data.usage),
          raw: data,
        }
        call.usage = call.response.usage
        call.live = null
        call.status = call.response.interrupted ? 'interrupted' : 'complete'
        if (call.request === null) call.request = snapshotRequest(event.time)
        applySurface(surface, event.surfaceOp, toNeutralMessage('assistant', event.seq, payload))
        break
      }
      case 'assistant/attempt': {
        const turn = turnOf(event) ?? currentTurn ?? ++syntheticTurn
        const step = stepOf(event) ?? currentStep ?? 1
        const call = ensureCall(turn, step, event.time)
        ;(call.attempts as AttemptRecord[]).push({
          seq: event.seq,
          time: event.time,
          turn,
          step,
          raw: data,
        })
        if (call.response === null) call.status = 'error'
        if (call.request === null) call.request = snapshotRequest(event.time)
        break
      }
      case 'tool/call': {
        const turn = turnOf(event) ?? currentTurn ?? ++syntheticTurn
        const step = stepOf(event) ?? currentStep ?? 1
        const call = ensureCall(turn, step, event.time)
        const callId = readString(data, 'callId')
        const argumentsRaw = readString(data, 'arguments')
        const execution: ToolExecution = {
          callId,
          name: readString(data, 'name'),
          argumentsRaw,
          argumentsParsed: parseArguments(argumentsRaw),
          startedAt: event.time,
          endedAt: null,
          durationMs: null,
          status: 'running',
          error: null,
          resultText: '',
          resultRaw: null,
          meta: null,
          seq: event.seq,
          resultSeq: null,
        }
        call.tools.push(execution)
        if (callId !== '') toolsByCallId.set(callId, execution)
        if (call.request === null) call.request = snapshotRequest(event.time)
        break
      }
      case 'tool/result': {
        const payload = asRecord(data.message) ?? {}
        const callId = readString(asRecord(payload.source), 'callId')
        const execution = callId === '' ? undefined : toolsByCallId.get(callId)
        const blocks = asBlocks(payload.content)
        const failure = asRecord(data.error)
        const isError = failure !== null || blocks.some(block => block.isError === true)
        const resultText = blocks
          .map(toNeutralBlock)
          .map((block) => (block.kind === 'tool-result' ? block.text : ''))
          .filter(text => text !== '')
          .join('\n')
        if (execution !== undefined) {
          execution.endedAt = event.time
          execution.durationMs = Math.max(0, event.time - execution.startedAt)
          execution.status = isError ? 'failed' : 'completed'
          execution.resultText = resultText
          execution.resultRaw = data
          execution.meta = data.meta ?? null
          execution.resultSeq = event.seq
          execution.error = failure === null
            ? isError
              ? { name: 'ToolError', code: '', message: resultText }
              : null
            : {
              name: readString(failure, 'name'),
              code: readString(failure, 'code'),
              message: readString(failure, 'message') || resultText,
            }
        }
        applySurface(surface, event.surfaceOp, toNeutralMessage('tool', event.seq, payload))
        break
      }
      default:
        break
    }
  }

  // Live rows belong to calls that are still open; anything already settled is stale.
  for (const [key, accumulator] of live) {
    const call = callsByKey.get(key)
    if (call === undefined || call.response !== null) continue
    call.live = {
      reasoning: accumulator.reasoning,
      content: accumulator.content,
      toolCalls: accumulator.toolCalls,
    }
  }

  let modelCalls = 0
  let toolCalls = 0
  let totalDurationMs = 0
  let running = false

  for (const round of rounds) {
    round.live = round.endedAt === null
    if (round.live) running = true

    round.modelCallCount = round.calls.length
    round.toolCallCount = round.calls.reduce((total, call) => total + call.tools.length, 0)
    round.usage = sumUsage(round.calls.map(call => call.usage))
    modelCalls += round.modelCallCount
    toolCalls += round.toolCallCount

    const primary = round.prompts[0]
    const text = primary === undefined ? '' : messageText(primary)
    round.promptText = text
    round.promptSummary = text === '' ? `第 ${round.turn} 轮` : firstLine(text, 96)

    // A settled round measures to its `turn/end`; an open one measures to the
    // last event the window has recorded so far, so the header total keeps
    // moving while the agent works.
    if (round.endedAt !== null) {
      round.durationMs = Math.max(0, round.endedAt - round.startedAt)
    } else if (round.calls.length > 0) {
      const last = round.calls.reduce(
        (max, call) => Math.max(max, call.endedAt ?? call.startedAt, ...call.tools.map(tool => tool.endedAt ?? tool.startedAt)),
        round.startedAt,
      )
      round.durationMs = Math.max(0, Math.max(last, lastTime) - round.startedAt)
    }
    totalDurationMs += round.durationMs ?? 0

    for (const call of round.calls) {
      if (call.status === 'running') running = true
    }
  }

  return {
    rounds,
    stats: {
      rounds: rounds.length,
      modelCalls,
      toolCalls,
      totalDurationMs,
      usage: sumUsage(rounds.map(round => round.usage)),
      running,
    },
  }
}

/* --------------------------------------------------------------- memoizing */

/** Empty model returned for a Session whose window has not loaded yet. */
export const EMPTY_WORKFLOW: WorkflowModel = {
  rounds: [],
  stats: {
    rounds: 0,
    modelCalls: 0,
    toolCalls: 0,
    totalDurationMs: 0,
    usage: { ...ZERO_USAGE },
    running: false,
  },
}

let cacheSignature = ''
let cacheModel: WorkflowModel = EMPTY_WORKFLOW

/**
 * Cheap identity of the durable rows: the projection only depends on durable
 * events, so a window that changed solely by appending live assistant chunks
 * reuses the previous model instead of re-folding the whole log.
 */
function durableSignature(entries: readonly DshSessionEventEntry[]): string {
  let count = 0
  let lastSeq = 0
  for (const entry of entries) {
    if (!isDurableEvent(entry)) continue
    count += 1
    if (entry.event.seq > lastSeq) lastSeq = entry.event.seq
  }
  return `${count}:${lastSeq}`
}

/**
 * Project a window, reusing the previous result while only live rows changed.
 * @param entries - durable and transient rows of one Session event window.
 * @returns the Workflow model for the current window.
 */
export function projectWorkflowMemo(entries: readonly DshSessionEventEntry[]): WorkflowModel {
  const signature = durableSignature(entries)
  if (signature === cacheSignature) {
    // Live rows may still have moved; refresh only the open calls' live output.
    if (cacheModel.rounds.length === 0) return cacheModel
    return projectLive(cacheModel, entries)
  }
  cacheSignature = signature
  cacheModel = projectWorkflow(entries)
  return cacheModel
}

/** Recompute only the live-output overlay for still-open calls. */
function projectLive(model: WorkflowModel, entries: readonly DshSessionEventEntry[]): WorkflowModel {
  const live = new Map<string, LiveAccumulator>()
  for (const entry of entries) {
    if (entry.type !== 'transient') continue
    const parsed = liveChunkOf(entry.event)
    if (parsed === null) continue
    const key = `${parsed.turn}\u0000${parsed.step}`
    const accumulator = live.get(key) ?? newLive()
    applyLiveChunk(accumulator, parsed.chunk)
    live.set(key, accumulator)
  }
  if (live.size === 0) {
    let changed = false
    for (const round of model.rounds) {
      for (const call of round.calls) if (call.live !== null) changed = true
    }
    if (!changed) return model
  }
  const rounds = model.rounds.map((round) => {
    let roundChanged = false
    const calls = round.calls.map((call) => {
      if (call.response !== null) return call
      const accumulator = live.get(call.key)
      const next: LiveOutput | null = accumulator === undefined
        ? null
        : {
          reasoning: accumulator.reasoning,
          content: accumulator.content,
          toolCalls: accumulator.toolCalls,
        }
      const same = next === null
        ? call.live === null
        : call.live !== null
          && call.live.reasoning === next.reasoning
          && call.live.content === next.content
          && call.live.toolCalls.length === next.toolCalls.length
      if (same) return call
      roundChanged = true
      return { ...call, live: next }
    })
    return roundChanged ? { ...round, calls } : round
  })
  return rounds.every((round, index) => round === model.rounds[index])
    ? model
    : { ...model, rounds }
}
