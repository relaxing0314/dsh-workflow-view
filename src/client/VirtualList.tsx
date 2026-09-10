/**
 * Windowed list with measured row heights.
 *
 * The model-call list can be hundreds of rows long, each expandable into an
 * arbitrarily tall detail card, so nothing here assumes a fixed row height:
 * mounted rows are measured through one shared `ResizeObserver`, and the
 * offset table is rebuilt from those measurements (falling back to the
 * caller's estimate for rows that have never been on screen).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/** Props of one {@link VirtualList}. */
export interface VirtualListProps<T> {
  items: readonly T[]
  getKey: (item: T, index: number) => string
  /** Height assumed for a row that has not been measured yet. */
  estimateHeight: number
  /** Extra rows rendered above and below the viewport. */
  overscan?: number
  renderItem: (item: T, index: number) => ReactNode
  className?: string
}

/** Whether the runtime can measure rows; without it the list renders in full. */
const CAN_MEASURE = typeof globalThis.ResizeObserver === 'function'

function findStartIndex(offsets: readonly number[], scrollTop: number): number {
  let low = 0
  let high = offsets.length - 2
  if (high < 0) return 0
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (offsets[mid] <= scrollTop) low = mid
    else high = mid - 1
  }
  return low
}

/**
 * Render a scrollable list that mounts only the rows near the viewport.
 * @param props - items, key and height policy, and the row renderer.
 * @returns the scroll container.
 */
export function VirtualList<T>({
  items, getKey, estimateHeight, overscan = 4, renderItem, className,
}: VirtualListProps<T>): ReactNode {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const heights = useRef(new Map<string, number>())
  const observer = useRef<ResizeObserver | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(720)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return undefined
    const sync = (): void => { setViewport(element.clientHeight) }
    sync()
    if (typeof globalThis.ResizeObserver !== 'function') return undefined
    const resize = new globalThis.ResizeObserver(sync)
    resize.observe(element)
    return () => { resize.disconnect() }
  }, [])

  useEffect(() => {
    if (!CAN_MEASURE) return undefined
    const measure = new globalThis.ResizeObserver((entries) => {
      let changed = false
      for (const entry of entries) {
        const target = entry.target as HTMLElement
        const key = target.dataset.vkey
        if (key === undefined) continue
        const height = target.getBoundingClientRect().height
        const previous = heights.current.get(key)
        if (previous === undefined || Math.abs(previous - height) > 0.5) {
          heights.current.set(key, height)
          changed = true
        }
      }
      if (changed) setRevision(current => current + 1)
    })
    observer.current = measure
    return () => {
      measure.disconnect()
      observer.current = null
    }
  }, [])

  const registerRow = useCallback((key: string) => (element: HTMLDivElement | null) => {
    if (element === null) return
    element.dataset.vkey = key
    observer.current?.observe(element)
  }, [])

  const offsets = useMemo(() => {
    const table = new Array<number>(items.length + 1)
    table[0] = 0
    for (let index = 0; index < items.length; index += 1) {
      const key = getKey(items[index], index)
      table[index + 1] = table[index] + (heights.current.get(key) ?? estimateHeight)
    }
    return table
    // `revision` is the measurement generation; `items` covers inserts/removals.
  }, [items, getKey, estimateHeight, revision])

  const total = offsets.length === 0 ? 0 : offsets[offsets.length - 1]

  if (!CAN_MEASURE) {
    return (
      <div className={`wf-vlist ${className ?? ''}`}>
        {items.map((item, index) => (
          <div key={getKey(item, index)}>{renderItem(item, index)}</div>
        ))}
      </div>
    )
  }

  const start = Math.max(0, findStartIndex(offsets, scrollTop) - overscan)
  let end = start
  while (end < items.length && offsets[end] < scrollTop + viewport + estimateHeight * overscan) end += 1
  end = Math.min(items.length, end + 1)

  const visible: ReactNode[] = []
  for (let index = start; index < end; index += 1) {
    const item = items[index]
    const key = getKey(item, index)
    visible.push(
      <div
        key={key}
        ref={registerRow(key)}
        className="wf-vrow"
        style={{ transform: `translateY(${offsets[index]}px)` }}
      >
        {renderItem(item, index)}
      </div>,
    )
  }

  return (
    <div
      ref={scrollRef}
      className={`wf-vlist ${className ?? ''}`}
      onScroll={(event: { currentTarget: HTMLDivElement }) => { setScrollTop(event.currentTarget.scrollTop) }}
    >
      <div className="wf-vlist-inner" style={{ height: `${total}px` }}>
        {visible}
      </div>
    </div>
  )
}
