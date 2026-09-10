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
import events from './fixtures/events.json'

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
const window = { entries: events, hasMore: false, revision: 1 }
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
