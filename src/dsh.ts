/**
 * Structural contracts this plugin reads at runtime, restated locally.
 *
 * The plugin is authored outside the DSH checkout, so it does not link the
 * `@deepseek-ai/*` type packages. These declarations cover exactly the leaf
 * fields the Workflow projection and view consume; they are deliberately
 * narrow, and every runtime read is additionally guarded in `projection.ts`
 * because a DSH pre-release may add or move a field.
 *
 * Nothing here is imported by the emitted bundles — `build.mjs` strips types.
 */

/** One durable Session event, narrowed to the fields the projection reads. */
export interface DshSessionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data?: unknown
  readonly surfaceOp?: unknown
}

/** Client history entry: a durable event or a live assistant chunk. */
export interface DshSessionEventEntry {
  readonly type: 'event' | 'transient'
  readonly event: DshSessionEvent
}

/** Contiguous Session event window published by a Session binding. */
export interface DshSessionEventWindow {
  readonly entries: readonly DshSessionEventEntry[]
  readonly hasMore: boolean
  readonly revision: number
}

/** Observable snapshot: the subscription shape the view binds to. */
export interface DshObservableSnapshot<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}
