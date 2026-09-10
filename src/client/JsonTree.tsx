/**
 * Expandable JSON inspector.
 *
 * Session records are deeply nested and sometimes very large (an assembled
 * system prompt, a tool catalog, a compacted model stream), so the tree is
 * lazy: a collapsed node renders a one-line preview and never touches its
 * children, arrays reveal their tail in pages, and long strings stay truncated
 * until the reader asks for the rest.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/** Characters of a string shown before the reader expands it. */
const STRING_PREVIEW = 400

/** Array/object members rendered before a "show more" step. */
const CHILD_PAGE = 100

/** Upper bound on a collapsed preview line. */
const PREVIEW_LIMIT = 120

type JsonKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'undefined'

/** Expansion signal used by the view's expand-all / collapse-all controls. */
export interface JsonForce {
  version: number
  open: boolean
}

/** Props of one {@link JsonTree}. */
export interface JsonTreeProps {
  value: unknown
  /** Depth at or above which nodes start expanded (0 = root expanded). */
  defaultExpandDepth?: number
  /** Expansion signal from a parent control, applied to every node. */
  force?: JsonForce
}

function kindOf(value: unknown): JsonKind {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'object': return 'object'
    case 'string': return 'string'
    case 'number': return 'number'
    case 'boolean': return 'boolean'
    default: return 'undefined'
  }
}

function entriesOf(value: unknown, kind: JsonKind): [string, unknown][] {
  if (kind === 'array') return (value as unknown[]).map((entry, index) => [String(index), entry])
  if (kind === 'object') return Object.entries(value as Record<string, unknown>)
  return []
}

function previewOf(value: unknown, kind: JsonKind): string {
  const parts = entriesOf(value, kind).slice(0, 6).map(([key, entry]) => {
    const entryKind = kindOf(entry)
    const text = entryKind === 'string'
      ? JSON.stringify(entry)
      : entryKind === 'array' || entryKind === 'object'
        ? entryKind === 'array' ? '[…]' : '{…}'
        : String(entry)
    return kind === 'array' ? text : `${JSON.stringify(key)}: ${text}`
  })
  const joined = parts.join(', ')
  const total = entriesOf(value, kind).length
  const suffix = total > 6 ? ', …' : ''
  const head = kind === 'array' ? '[' : '{'
  const tail = kind === 'array' ? ']' : '}'
  const body = joined.length > PREVIEW_LIMIT ? `${joined.slice(0, PREVIEW_LIMIT)}…` : joined
  return `${head}${body}${suffix}${tail}`
}

function TypeTag({ kind }: { kind: JsonKind }): ReactNode {
  return <span className={`wf-json-tag wf-json-tag-${kind}`}>{kind}</span>
}

function CopyButton({ text, label, copiedLabel }: { text: string, label: string, copiedLabel: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])
  const onCopy = useCallback(() => {
    const clipboard = (globalThis as { navigator?: { clipboard?: { writeText(text: string): Promise<void> } } })
      .navigator?.clipboard
    void clipboard?.writeText(text).then(() => {
      setCopied(true)
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => { setCopied(false) }, 1400)
    }).catch(() => { /* clipboard unavailable: the text stays selectable */ })
  }, [text])
  return (
    <button type="button" className="wf-copy" onClick={onCopy} title={label}>
      {copied ? copiedLabel : label}
    </button>
  )
}

interface NodeProps {
  name: string
  value: unknown
  depth: number
  defaultExpandDepth: number
  force: JsonForce | undefined
  ancestors: readonly unknown[]
}

function JsonNode({ name, value, depth, defaultExpandDepth, force, ancestors }: NodeProps): ReactNode {
  const kind = kindOf(value)
  const container = kind === 'array' || kind === 'object'
  const [open, setOpen] = useState(container && depth < defaultExpandDepth)
  const [shown, setShown] = useState(CHILD_PAGE)
  const seenVersion = useRef(force?.version ?? 0)

  useEffect(() => {
    if (force === undefined || force.version === seenVersion.current) return
    seenVersion.current = force.version
    setOpen(force.open)
  }, [force?.version, force?.open])

  const toggle = useCallback(() => { setOpen(current => !current) }, [])

  if (!container) {
    return (
      <div className="wf-json-row" style={{ paddingLeft: `${depth * 14}px` }}>
        <span className="wf-json-key">{name}</span>
        <span className="wf-json-colon">:</span>
        <ValueLeaf value={value} kind={kind} />
      </div>
    )
  }

  // A cycle cannot occur in JSON, but a defensive guard keeps a malformed
  // record from recursing forever.
  if (ancestors.includes(value)) {
    return (
      <div className="wf-json-row" style={{ paddingLeft: `${depth * 14}px` }}>
        <span className="wf-json-key">{name}</span>
        <span className="wf-json-colon">:</span>
        <span className="wf-json-null">[circular]</span>
      </div>
    )
  }

  const all = entriesOf(value, kind)
  const count = all.length
  const visible = open ? all.slice(0, shown) : []
  const nextAncestors = [...ancestors, value]

  return (
    <div className="wf-json-node">
      <div className="wf-json-row" style={{ paddingLeft: `${depth * 14}px` }}>
        <button
          type="button"
          className="wf-json-toggle"
          onClick={toggle}
          aria-expanded={open}
          title={name}
        >
          <span className="wf-json-caret">{open ? '▾' : '▸'}</span>
        </button>
        {name !== '' && <><span className="wf-json-key">{name}</span><span className="wf-json-colon">:</span></>}
        <button type="button" className="wf-json-preview" onClick={toggle}>
          {open
            ? <>{kind === 'array' ? '[' : '{'}<span className="wf-json-count">{count}</span>{kind === 'array' ? ']' : '}'}</>
            : <span className="wf-json-preview-text">{previewOf(value, kind)}</span>}
        </button>
      </div>
      {open && (
        <div className="wf-json-children">
          {visible.map(([childName, childValue]) => (
            <JsonNode
              key={childName}
              name={kind === 'array' ? '' : childName}
              value={childValue}
              depth={depth + 1}
              defaultExpandDepth={defaultExpandDepth}
              force={force}
              ancestors={nextAncestors}
            />
          ))}
          {count > visible.length && (
            <button
              type="button"
              className="wf-json-more"
              style={{ marginLeft: `${(depth + 1) * 14}px` }}
              onClick={() => { setShown(current => current + CHILD_PAGE) }}
            >
              …
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function ValueLeaf({ value, kind }: { value: unknown, kind: JsonKind }): ReactNode {
  const [expanded, setExpanded] = useState(false)
  if (kind === 'string') {
    const text = value as string
    if (text.length <= STRING_PREVIEW) return <span className="wf-json-string">{JSON.stringify(text)}</span>
    return (
      <span className="wf-json-string wf-json-longstring">
        {expanded ? JSON.stringify(text) : `${JSON.stringify(text.slice(0, STRING_PREVIEW))}…`}
        <button type="button" className="wf-json-more" onClick={() => { setExpanded(current => !current) }}>
          {expanded ? '▴' : `+${text.length - STRING_PREVIEW}`}
        </button>
      </span>
    )
  }
  if (kind === 'number') return <span className="wf-json-number">{String(value)}</span>
  if (kind === 'boolean') return <span className="wf-json-boolean">{String(value)}</span>
  if (kind === 'null') return <span className="wf-json-null">null</span>
  return <span className="wf-json-null">{String(value)}</span>
}

/**
 * Render one JSON value as a collapsible tree.
 * @param props - value, default expansion depth, and optional expansion signal.
 * @returns the tree root.
 */
export function JsonTree({ value, defaultExpandDepth = 1, force }: JsonTreeProps): ReactNode {
  const kind = kindOf(value)
  if (kind !== 'array' && kind !== 'object') {
    return (
      <div className="wf-json">
        <div className="wf-json-row" style={{ paddingLeft: '0px' }}><ValueLeaf value={value} kind={kind} /></div>
      </div>
    )
  }
  return (
    <div className="wf-json">
      <JsonNode
        name=""
        value={value}
        depth={0}
        defaultExpandDepth={defaultExpandDepth}
        force={force}
        ancestors={[]}
      />
    </div>
  )
}

/** Re-exported so callers can build section headers with the same vocabulary. */
export { CopyButton, TypeTag }
