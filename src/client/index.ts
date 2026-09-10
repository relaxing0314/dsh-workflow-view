/**
 * Browser entry for the 工作流 (Workflow) conversation view.
 *
 * The plugin adds exactly one `conversation.view` entry — it does not touch,
 * wrap, or replace the shipped 轨迹 (Trajectory) view, and it reads the
 * Session's own event window without publishing a service or a projection.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { DshObservableSnapshot, DshSessionEventWindow } from '../dsh'
import { en, NS, zh } from './locales'
import { WorkflowView, type WorkflowViewInjected } from './WorkflowView'
import styles from './styles.css'

export type { WorkflowViewProps, WorkflowViewInjected } from './WorkflowView'

/** Cordis services this plugin cannot work without. */
export const inject = ['slots', 'sessions', 'locale'] as const

/** Stable empty window used before a Session binding is addressable. */
const EMPTY_WINDOW: DshObservableSnapshot<DshSessionEventWindow> = {
  getSnapshot: () => ({ entries: [], hasMore: false, revision: 0 }),
  subscribe: () => () => {},
}

/** The minimal shape of the client `sessions` service this plugin uses. */
interface ClientSessions {
  binding(sessionId: string): {
    eventSource: DshObservableSnapshot<DshSessionEventWindow>
    session: { loadOlder(): Promise<boolean> }
  } | undefined
}

/** The `slots` service face this plugin consumes. */
interface ClientSlots {
  inject(name: string, callback: () => () => void): void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** The `locale` service face this plugin consumes. */
interface ClientLocale {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string
}

/**
 * Client plugin body: publish the Workflow view tab.
 *
 * The registration rides the slot service's effect wrapper, so unloading the
 * plugin removes the tab and its stylesheet with it.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const slots = ctx.get('slots') as ClientSlots | undefined
  const sessions = ctx.get('sessions') as ClientSessions | undefined
  const locale = ctx.get('locale') as ClientLocale | undefined
  if (slots === undefined) return

  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-workflow-view'
    tag.textContent = styles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'dsh-workflow-view: styles')

  if (locale !== undefined) {
    ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-workflow-view: dictionaries')
  }
  const t = locale?.bind(NS) ?? ((key: string) => key)

  slots.inject('conversation.view', () => slots.register({
    name: 'conversation.view',
    id: 'workflow',
    // After Chat (0) and Trajectory (10): the tab list reads 对话 / 轨迹 / 工作流.
    order: 20,
    locale: NS,
    label: () => t('view.workflow'),
    inject: (sessionId: string): WorkflowViewInjected => {
      const binding = sessions?.binding(sessionId)
      if (binding === undefined) {
        return { events: EMPTY_WINDOW, loadOlder: async () => false }
      }
      return {
        events: binding.eventSource,
        loadOlder: () => binding.session.loadOlder(),
      }
    },
  }, WorkflowView))
}
