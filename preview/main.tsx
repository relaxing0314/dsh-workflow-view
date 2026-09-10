/**
 * Standalone preview driver for the Workflow client bundle.
 *
 * Loads the real `lib/client.js`, calls the captured module-loader factory with
 * a React shim, drives the plugin's `apply(ctx)` through the same service calls
 * the harness makes, and mounts the registered `conversation.view` component
 * with a real Session event window. Used only for local visual verification.
 */

import { createRoot } from 'react-dom/client'
import { createElement } from 'react'
import * as React from 'react'
import * as JsxRuntime from 'react/jsx-runtime'
import { apply } from '../src/client/index'
import { WorkflowView } from '../src/client/WorkflowView'
import { zh } from '../src/client/locales'
import fixture from './fixtures/events.json'

/**
 * The recorded fixtures contain no failed turn, which is exactly why the
 * low-contrast failure badge shipped: nothing rendered that state. This appends
 * one synthetic failed round in the same shape the agent loop writes, so the
 * failed status badge, the error callout, and a failed tool execution are all
 * on screen for both the layout checks and the contrast measurements.
 */
const FAILED_TURN = 3
// Anchor the synthetic round just after the recorded history so the header's
// elapsed time stays meaningful instead of spanning a year of clock skew.
const lastRecordedTime = (fixture as { event?: { time?: number } }[])
  .reduce((max, entry) => Math.max(max, entry.event?.time ?? 0), 0)
const T0 = lastRecordedTime + 1000
const failureEvents = [
  { type: 'turn/start', seq: 9001, time: T0, data: { turn: FAILED_TURN } },
  {
    type: 'request/header',
    seq: 9002,
    time: T0 + 1,
    data: {
      reason: 'change',
      header: {
        config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
        system: 'You are an AI agent powered by DeepSeek Harness.',
        tools: [{ name: 'bash', description: 'Run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }],
      },
    },
  },
  {
    type: 'user/message',
    seq: 9003,
    time: T0 + 2,
    surfaceOp: 'append',
    data: { role: 'user', id: 'u-fail', source: { kind: 'user' }, content: [{ type: 'text', text: '把构建产物发布到线上环境' }] },
  },
  { type: 'step/start', seq: 9004, time: T0 + 10, data: { turn: FAILED_TURN, step: 1 } },
  {
    type: 'assistant/message',
    seq: 9005,
    time: T0 + 420,
    surfaceOp: 'append',
    data: {
      turn: FAILED_TURN,
      step: 1,
      message: {
        role: 'assistant',
        id: 'a-fail',
        content: [
          { type: 'reasoning', text: '需要先确认发布脚本是否存在。' },
          { type: 'tool-call', id: 'call_fail_1', name: 'bash', arguments: '{"command":"pnpm run deploy --production"}' },
        ],
      },
      usage: { inputTokens: 512, outputTokens: 96, cacheReadTokens: 4096, reasoningTokens: 18 },
    },
  },
  { type: 'tool/call', seq: 9006, time: T0 + 425, data: { turn: FAILED_TURN, step: 1, callId: 'call_fail_1', name: 'bash', arguments: '{"command":"pnpm run deploy --production"}' } },
  {
    type: 'tool/result',
    seq: 9007,
    time: T0 + 980,
    surfaceOp: 'append',
    data: {
      turn: FAILED_TURN,
      step: 1,
      error: { name: 'ShellError', code: 'ENOENT' },
      message: {
        source: { kind: 'tool', callId: 'call_fail_1' },
        content: [{ type: 'tool-result', toolCallId: 'call_fail_1', isError: true, content: [{ type: 'text', text: 'ERR_PNPM_NO_SCRIPT  Missing script: deploy' }] }],
      },
    },
  },
  { type: 'step/end', seq: 9008, time: T0 + 990, data: { turn: FAILED_TURN, step: 1 } },
  {
    type: 'turn/end',
    seq: 9009,
    time: T0 + 1000,
    data: { turn: FAILED_TURN, reason: { kind: 'error', error: { message: 'provider request failed: upstream returned 503 after 3 retries', code: 'UPSTREAM' } } },
  },
]

const events = [
  ...(fixture as { type: string, event: unknown }[]),
  ...failureEvents.map(event => ({ type: 'event', event })),
]

const extra = { ...React, ...JsxRuntime }

function shimRequire(specifier: string): unknown {
  if (specifier === 'react') return extra
  if (specifier === 'react/jsx-runtime' || specifier === 'react/jsx-runtime.js') return JsxRuntime
  throw new Error(`preview: unexpected external ${specifier}`)
}

interface Registration { id: string; factory: (require: (specifier: string) => unknown) => unknown }

const loader = (globalThis as unknown as { __ModuleLoader__: { registrations: Registration[] } }).__ModuleLoader__
const registration = loader.registrations.find(entry => entry.id === 'dsh-workflow-view')
if (registration === undefined) throw new Error('preview: client bundle did not register')
const moduleExports = registration.factory(shimRequire) as {
  apply(ctx: unknown): void
  inject: readonly string[]
}
void moduleExports

function translate(key: string, params?: Record<string, string | number>): string {
  const template = (zh as Record<string, string>)[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (match, name: string) =>
    (name in params ? String(params[name]) : match))
}

/** The same window shape the Session binding publishes. */
const listeners = new Set<() => void>()
const window = { entries: events as never, hasMore: false, revision: 1 }
const source = {
  getSnapshot: () => window,
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}

let registered: { options: Record<string, unknown>, component: unknown } | null = null

const ctx = {
  get(name: string): unknown {
    if (name === 'slots') {
      return {
        inject(_slot: string, callback: () => void) { callback() },
        register(options: Record<string, unknown>, component: unknown) {
          registered = { options, component }
          return () => {}
        },
      }
    }
    if (name === 'sessions') {
      return {
        binding: () => ({ eventSource: source, session: { loadOlder: async () => false } }),
      }
    }
    if (name === 'locale') {
      return {
        register: () => () => {},
        bind: () => translate,
      }
    }
    return undefined
  },
  effect(callback: () => (() => void) | void) {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  on() { return () => {} },
}

apply(ctx)
if (registered === null) throw new Error('preview: plugin registered no conversation.view entry')

const injected = (registered.options.inject as (sessionId: string) => Record<string, unknown>)('preview-session')
// The harness reads the tab label through the thunk so it follows the active
// locale without re-registration.
const labelOption = registered.options.label
const tabLabel = typeof labelOption === 'function' ? (labelOption as () => string)() : String(labelOption ?? '')

const root = createRoot(document.getElementById('app') as HTMLElement)
root.render(createElement(
  'div',
  { className: 'preview-shell' },
  createElement(
    'div',
    { className: 'preview-tabs' },
    createElement('div', { className: 'preview-tab' }, '对话'),
    createElement('div', { className: 'preview-tab' }, '轨迹'),
    createElement('div', { className: 'preview-tab is-active' }, tabLabel),
  ),
  createElement(
    'div',
    { className: 'preview-view' },
    createElement(WorkflowView, { ...injected, t: translate }),
  ),
))

void WorkflowView
