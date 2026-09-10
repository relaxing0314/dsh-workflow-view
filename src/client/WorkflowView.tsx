/**
 * The 工作流 conversation view.
 *
 * Left: one card per user conversation round. Right: that round's model calls
 * in recorded order, each rendered as a request / response / tool-execution
 * chain inside a windowed list so a long chain never grows the page.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { DshObservableSnapshot, DshSessionEventWindow } from '../dsh'
import { JsonTree, CopyButton, type JsonForce } from './JsonTree'
import { VirtualList } from './VirtualList'
import {
  projectWorkflowMemo,
  type ModelCall, type NeutralMessage, type ToolExecution, type WorkflowRound, type WorkflowUsage,
} from './projection'

/** Locale translate signature used by the view. */
type Translate = (key: string, params?: Record<string, string | number>) => string

/** Session-bound controls the plugin injects into the view registration. */
export interface WorkflowViewInjected {
  /** The Session's durable event window. */
  events: DshObservableSnapshot<DshSessionEventWindow>
  /** Page older history into the window; resolves false when nothing was added. */
  loadOlder: () => Promise<boolean>
}

/** Props the conversation view slot composes for this entry. */
export interface WorkflowViewProps extends WorkflowViewInjected {
  t: Translate
}

/* --------------------------------------------------------------- formatting */

/** Exact token count with digit grouping. */
export function formatTokens(value: number): string {
  return value.toLocaleString('en-US')
}

/** Compact token count for the header strip. */
export function formatCompactTokens(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(2)}M`
}

/** Human duration: milliseconds under a second, seconds under a minute, then m/s. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
}

/** Local wall-clock time with seconds, for round and call headers. */
export function formatClock(time: number): string {
  const date = new Date(time)
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(part => String(part).padStart(2, '0'))
    .join(':')
}

function statusKey(status: string): string {
  return `status.${status}`
}

function roundStatusClass(round: WorkflowRound): string {
  if (round.live) return 'wf-status-running'
  switch (round.status) {
    case 'completed': return 'wf-status-ok'
    case 'failed': return 'wf-status-bad'
    case 'aborted': return 'wf-status-warn'
    default: return 'wf-status-idle'
  }
}

/* ------------------------------------------------------------------ sections */

interface SectionProps {
  title: string
  meta?: string
  defaultOpen?: boolean
  force?: JsonForce
  copyText?: string
  t: Translate
  children: ReactNode
}

function Section({ title, meta, defaultOpen = false, force, copyText, t, children }: SectionProps): ReactNode {
  const [open, setOpen] = useState(defaultOpen)
  const seen = useRef(force?.version ?? 0)
  useEffect(() => {
    if (force === undefined || force.version === seen.current) return
    seen.current = force.version
    setOpen(force.open)
  }, [force?.version, force?.open])
  return (
    <section className={`wf-section ${open ? 'is-open' : ''}`}>
      <header className="wf-section-head">
        <button type="button" className="wf-section-toggle" onClick={() => { setOpen(value => !value) }} aria-expanded={open}>
          <span className="wf-caret">{open ? '▾' : '▸'}</span>
          <span className="wf-section-title">{title}</span>
          {meta !== undefined && <span className="wf-section-meta">{meta}</span>}
        </button>
        {open && copyText !== undefined && (
          <CopyButton text={copyText} label={t('action.copy')} copiedLabel={t('action.copied')} />
        )}
      </header>
      {open && <div className="wf-section-body">{children}</div>}
    </section>
  )
}

/** Horizontal-overflow container: one wide line scrolls instead of wrapping the page. */
function ScrollX({ children, className }: { children: ReactNode, className?: string }): ReactNode {
  return <div className={`wf-scrollx ${className ?? ''}`}>{children}</div>
}

function TextBlock({ text, empty }: { text: string, empty: string }): ReactNode {
  if (text.trim() === '') return <div className="wf-empty-inline">{empty}</div>
  return <ScrollX><pre className="wf-pre">{text}</pre></ScrollX>
}

/** Long strings start collapsed to keep a card scannable. */
function LongText({ text, limit = 1200 }: { text: string, limit?: number }): ReactNode {
  const [full, setFull] = useState(false)
  if (text.length <= limit) return <TextBlock text={text} empty="—" />
  return (
    <div className="wf-longtext">
      <ScrollX><pre className="wf-pre">{full ? text : `${text.slice(0, limit)}…`}</pre></ScrollX>
      <button type="button" className="wf-link" onClick={() => { setFull(value => !value) }}>
        {full ? '▴' : `▾ ${text.length - limit}`}
      </button>
    </div>
  )
}

/* -------------------------------------------------------------------- blocks */

function TokenStrip({ usage, t, compact = false }: { usage: WorkflowUsage, t: Translate, compact?: boolean }): ReactNode {
  const buckets: [string, number][] = [
    ['token.input', usage.inputTokens],
    ['token.uncached', usage.uncachedInputTokens],
    ['token.cacheRead', usage.cacheReadTokens],
    ['token.cacheWrite', usage.cacheWriteTokens],
    ['token.output', usage.outputTokens],
  ]
  if (usage.reasoningTokens > 0) buckets.push(['token.reasoning', usage.reasoningTokens])
  return (
    <div className={`wf-tokens ${compact ? 'is-compact' : ''}`}>
      {buckets.map(([key, value]) => (
        <span key={key} className="wf-token" title={`${t(key)}: ${formatTokens(value)}`}>
          <span className="wf-token-label">{t(key)}</span>
          <span className="wf-token-value">{compact ? formatCompactTokens(value) : formatTokens(value)}</span>
        </span>
      ))}
    </div>
  )
}

function MessageCard({ message, t }: { message: NeutralMessage, t: Translate }): ReactNode {
  const [showRaw, setShowRaw] = useState(false)
  const label = t(`message.role.${message.role}`)
  return (
    <article className={`wf-msg wf-msg-${message.role}`}>
      <header className="wf-msg-head">
        <span className={`wf-role wf-role-${message.role}`}>{label}</span>
        <span className="wf-msg-source" title={message.sourceKind}>{message.sourceLabel}</span>
        <span className="wf-msg-seq">#{message.seq}</span>
        <button type="button" className="wf-link" onClick={() => { setShowRaw(value => !value) }}>
          {showRaw ? '▾ JSON' : '▸ JSON'}
        </button>
      </header>
      {!showRaw && (
        <div className="wf-msg-blocks">
          {message.blocks.length === 0 && <div className="wf-empty-inline">{t('message.empty')}</div>}
          {message.blocks.map((block, index) => {
            switch (block.kind) {
              case 'text':
                return <ScrollX key={index}><pre className="wf-pre">{block.text}</pre></ScrollX>
              case 'reasoning':
                return <ScrollX key={index}><pre className="wf-pre wf-pre-reasoning">{block.text}</pre></ScrollX>
              case 'tool-call':
                return (
                  <ScrollX key={index}>
                    <pre className="wf-pre wf-pre-call">{block.name}({block.arguments})</pre>
                  </ScrollX>
                )
              case 'tool-result':
                return <ScrollX key={index}><pre className="wf-pre">{block.text}</pre></ScrollX>
              case 'image':
                return <div key={index} className="wf-chip">{block.label}</div>
              default:
                return <div key={index} className="wf-chip">{block.blockType}</div>
            }
          })}
        </div>
      )}
      {showRaw && <ScrollX><div className="wf-json-wrap"><JsonTree value={message.raw} defaultExpandDepth={2} /></div></ScrollX>}
    </article>
  )
}

function ToolCard({ tool, force, t }: { tool: ToolExecution, force: JsonForce | undefined, t: Translate }): ReactNode {
  const [open, setOpen] = useState(true)
  const seen = useRef(force?.version ?? 0)
  useEffect(() => {
    if (force === undefined || force.version === seen.current) return
    seen.current = force.version
    setOpen(force.open)
  }, [force?.version, force?.open])
  const statusClass = tool.status === 'running' ? 'wf-status-running' : tool.status === 'failed' ? 'wf-status-bad' : 'wf-status-ok'
  const statusLabel = t(`tool.status.${tool.status}`)
  const argsText = tool.argumentsParsed === undefined
    ? tool.argumentsRaw
    : JSON.stringify(tool.argumentsParsed, null, 2)
  return (
    <article className={`wf-tool wf-tool-${tool.status}`}>
      <header className="wf-tool-head">
        <button type="button" className="wf-section-toggle" onClick={() => { setOpen(value => !value) }} aria-expanded={open}>
          <span className="wf-caret">{open ? '▾' : '▸'}</span>
          <span className="wf-tool-name">{tool.name}</span>
        </button>
        <span className={`wf-status ${statusClass}`}>{statusLabel}</span>
        <span className="wf-tool-meta">{t('tool.duration')} {formatDuration(tool.durationMs)}</span>
        <span className="wf-tool-meta">{formatClock(tool.startedAt)}</span>
        <span className="wf-tool-callid" title={tool.callId}>{tool.callId}</span>
      </header>
      {open && (
        <div className="wf-tool-body">
          <div className="wf-block">
            <div className="wf-block-title">{t('tool.args')}</div>
            <ScrollX><pre className="wf-pre wf-pre-call">{argsText}</pre></ScrollX>
          </div>
          {tool.error !== null && (
            <div className="wf-block wf-block-error">
              <div className="wf-block-title">{t('tool.error')}</div>
              <ScrollX>
                <pre className="wf-pre">{[tool.error.name, tool.error.code].filter(Boolean).join(' · ')}{tool.error.message === '' ? '' : `\n${tool.error.message}`}</pre>
              </ScrollX>
            </div>
          )}
          <div className="wf-block">
            <div className="wf-block-title">{t('tool.result')}</div>
            {tool.status === 'running'
              ? <div className="wf-empty-inline">{t('tool.noResult')}</div>
              : tool.resultText.trim() === ''
                ? <div className="wf-empty-inline">{t('tool.emptyResult')}</div>
                : <LongText text={tool.resultText} />}
          </div>
          {tool.meta !== null && tool.meta !== undefined && (
            <div className="wf-block">
              <div className="wf-block-title">meta</div>
              <ScrollX><div className="wf-json-wrap"><JsonTree value={tool.meta} defaultExpandDepth={2} /></div></ScrollX>
            </div>
          )}
        </div>
      )}
    </article>
  )
}

/* ------------------------------------------------------------------ the call */

interface CallCardProps {
  call: ModelCall
  force: JsonForce | undefined
  t: Translate
}

function CallCard({ call, force, t }: CallCardProps): ReactNode {
  const request = call.request
  const response = call.response
  const config = request?.config ?? {}
  const provider = String(config.provider ?? '')
  const model = String(config.model ?? '')
  const route = provider === '' && model === '' ? '—' : `${provider}${provider === '' ? '' : '/'}${model}`
  const statusClass = call.status === 'running'
    ? 'wf-status-running'
    : call.status === 'complete'
      ? 'wf-status-ok'
      : call.status === 'interrupted'
        ? 'wf-status-warn'
        : 'wf-status-bad'
  const callStatus = call.status === 'complete' ? 'completed' : call.status === 'interrupted' ? 'interrupted' : call.status
  const messages = request?.messages ?? []

  return (
    <article className="wf-call">
      <header className="wf-call-head">
        <span className="wf-call-index">#{call.index}</span>
        <span className="wf-call-title">{t('call.title')}</span>
        <span className={`wf-status ${statusClass}`}>{t(statusKey(callStatus))}</span>
        <span className="wf-chip wf-chip-route" title={route}>{route}</span>
        <span className="wf-chip">{t('call.step', { step: call.step })}</span>
        <span className="wf-chip">{formatClock(call.startedAt)}</span>
        <span className="wf-chip">{formatDuration(call.durationMs)}</span>
        <span className="wf-chip">{t('call.tools', { count: call.tools.length })}</span>
        {call.usage !== null && <TokenStrip usage={call.usage} t={t} compact />}
      </header>

      <Section
        title={t('section.request')}
        meta={request === null ? undefined : `#${request.seq} · ${formatClock(request.time)}`}
        defaultOpen={false}
        force={force}
        copyText={request === null ? undefined : JSON.stringify({ system: request.system, tools: request.tools, config: request.config }, null, 2)}
        t={t}
      >
        {request === null
          ? <div className="wf-empty-inline">{t('empty.noRequest')}</div>
          : (
            <div className="wf-blocks">
              <div className="wf-block">
                <div className="wf-block-title">
                  {t('section.system')}
                  <span className="wf-block-count">{formatTokens(request.system.length)}</span>
                </div>
                <LongText text={request.system} limit={2000} />
              </div>
              <div className="wf-block">
                <div className="wf-block-title">
                  {t('section.messages')}
                  <span className="wf-block-count">{t('message.count', { count: messages.length })}</span>
                </div>
                {messages.length === 0
                  ? <div className="wf-empty-inline">{t('message.empty')}</div>
                  : <div className="wf-msgs">{messages.map((m, index) => <MessageCard key={`${m.seq}:${index}`} message={m} t={t} />)}</div>}
              </div>
              <div className="wf-block">
                <div className="wf-block-title">
                  {t('section.toolSchemas')}
                  <span className="wf-block-count">{request.tools.length}</span>
                </div>
                <ScrollX><div className="wf-json-wrap"><JsonTree value={request.tools} defaultExpandDepth={1} force={force} /></div></ScrollX>
              </div>
              <div className="wf-block">
                <div className="wf-block-title">{t('section.config')}</div>
                <ScrollX><div className="wf-json-wrap"><JsonTree value={config} defaultExpandDepth={2} force={force} /></div></ScrollX>
              </div>
            </div>
          )}
      </Section>

      <Section
        title={t('section.response')}
        meta={response === null ? undefined : `#${response.seq} · ${formatClock(response.time)}`}
        defaultOpen={false}
        force={force}
        copyText={response === null ? undefined : JSON.stringify(response.raw, null, 2)}
        t={t}
      >
        {response === null
          ? (
            <div className="wf-blocks">
              <div className="wf-empty-inline">{t('empty.noResponse')}</div>
              {call.live !== null && (call.live.reasoning !== '' || call.live.content !== '') && (
                <div className="wf-block">
                  <div className="wf-block-title">{t('section.live')}</div>
                  {call.live.reasoning !== '' && <TextBlock text={call.live.reasoning} empty="—" />}
                  {call.live.content !== '' && <TextBlock text={call.live.content} empty="—" />}
                </div>
              )}
            </div>
          )
          : (
            <div className="wf-blocks">
              <div className="wf-block">
                <div className="wf-block-title">{t('section.reasoning')}<span className="wf-block-count">{formatTokens(response.reasoning.length)}</span></div>
                <LongText text={response.reasoning} limit={1500} />
              </div>
              <div className="wf-block">
                <div className="wf-block-title">{t('section.content')}<span className="wf-block-count">{formatTokens(response.content.length)}</span></div>
                <LongText text={response.content} limit={2000} />
              </div>
              {response.toolCalls.length > 0 && (
                <div className="wf-block">
                  <div className="wf-block-title">{t('section.tools')}<span className="wf-block-count">{response.toolCalls.length}</span></div>
                  <ScrollX>
                    <pre className="wf-pre wf-pre-call">{response.toolCalls.map(c => `${c.name}(${c.arguments})`).join('\n')}</pre>
                  </ScrollX>
                </div>
              )}
              {call.usage !== null && (
                <div className="wf-block">
                  <div className="wf-block-title">Token</div>
                  <TokenStrip usage={call.usage} t={t} />
                </div>
              )}
              {call.attempts.length > 0 && (
                <div className="wf-block">
                  <div className="wf-block-title">{t('section.attempts')}<span className="wf-block-count">{call.attempts.length}</span></div>
                  <ScrollX><div className="wf-json-wrap"><JsonTree value={call.attempts.map(a => a.raw)} defaultExpandDepth={1} force={force} /></div></ScrollX>
                </div>
              )}
              <div className="wf-block">
                <div className="wf-block-title">{t('section.rawOutput')}</div>
                <ScrollX><div className="wf-json-wrap"><JsonTree value={response.raw} defaultExpandDepth={1} force={force} /></div></ScrollX>
              </div>
            </div>
          )}
      </Section>

      <Section
        title={t('section.tools')}
        meta={`${call.tools.length}`}
        defaultOpen={call.tools.length > 0 && call.tools.some(tool => tool.status !== 'completed')}
        force={force}
        t={t}
      >
        {call.tools.length === 0
          ? <div className="wf-empty-inline">—</div>
          : <div className="wf-tools">{call.tools.map((tool, index) => <ToolCard key={`${tool.callId || tool.seq}:${index}`} tool={tool} force={force} t={t} />)}</div>}
      </Section>
    </article>
  )
}

/* ------------------------------------------------------------------ the round */

function RoundItem({
  round, active, onSelect, t,
}: { round: WorkflowRound, active: boolean, onSelect: () => void, t: Translate }): ReactNode {
  return (
    <button
      type="button"
      className={`wf-round ${active ? 'is-active' : ''}`}
      onClick={onSelect}
      aria-current={active}
    >
      <div className="wf-round-top">
        <span className="wf-round-index">{round.turn}</span>
        <span className="wf-round-summary" title={round.promptText}>{round.promptSummary}</span>
      </div>
      <div className="wf-round-meta">
        <span className="wf-round-time">{formatClock(round.startedAt)}</span>
        <span className="wf-round-stat">{t('metric.modelCalls')} {round.modelCallCount}</span>
        <span className="wf-round-stat">{t('metric.toolCalls')} {round.toolCallCount}</span>
        <span className="wf-round-dur">{formatDuration(round.durationMs)}</span>
        <span className={`wf-status ${roundStatusClass(round)}`}>{t(statusKey(round.live ? 'running' : round.status))}</span>
      </div>
    </button>
  )
}

/* ------------------------------------------------------------------- the view */

const getCallKey = (call: ModelCall): string => call.key

/**
 * Render the Workflow view for the current Session.
 * @param props - the injected event window and the locale translate seat.
 * @returns the two-pane workflow surface.
 */
export function WorkflowView({ events, loadOlder, t }: WorkflowViewProps): ReactNode {
  const subscribe = useCallback((listener: () => void) => events.subscribe(listener), [events])
  const getSnapshot = useCallback(() => events.getSnapshot(), [events])
  const eventWindow = useSyncExternalStore(subscribe, getSnapshot)
  const model = useMemo(() => projectWorkflowMemo(eventWindow.entries), [eventWindow])

  const [selection, setSelection] = useState<number | null>(null)
  const [force, setForce] = useState<JsonForce>({ version: 0, open: false })
  const [loading, setLoading] = useState(false)

  const rounds = model.rounds
  const selected = useMemo(() => {
    if (rounds.length === 0) return null
    if (selection === null) return rounds[rounds.length - 1]
    return rounds.find(round => round.turn === selection) ?? rounds[rounds.length - 1]
  }, [rounds, selection])

  const expandAll = useCallback(() => { setForce(current => ({ version: current.version + 1, open: true })) }, [])
  const collapseAll = useCallback(() => { setForce(current => ({ version: current.version + 1, open: false })) }, [])
  const onLoadOlder = useCallback(() => {
    setLoading(true)
    void loadOlder().finally(() => { setLoading(false) })
  }, [loadOlder])

  return (
    <div className="wf-root" aria-label={t('view.aria')}>
      <header className="wf-header">
        <div className="wf-metrics">
          <div className="wf-metric"><span className="wf-metric-value">{model.stats.rounds}</span><span className="wf-metric-label">{t('metric.rounds')}</span></div>
          <div className="wf-metric"><span className="wf-metric-value">{model.stats.modelCalls}</span><span className="wf-metric-label">{t('metric.modelCalls')}</span></div>
          <div className="wf-metric"><span className="wf-metric-value">{model.stats.toolCalls}</span><span className="wf-metric-label">{t('metric.toolCalls')}</span></div>
          <div className="wf-metric">
            <span className="wf-metric-value">{formatDuration(model.stats.totalDurationMs)}</span>
            <span className="wf-metric-label">{t('metric.duration')}</span>
            {model.stats.running && <span className="wf-status wf-status-running">{t('metric.running')}</span>}
          </div>
        </div>
        <TokenStrip usage={model.stats.usage} t={t} compact />
      </header>

      <div className="wf-body">
        <aside className="wf-rounds">
          <div className="wf-rounds-head">
            <span>{t('list.rounds')}</span>
            <span className="wf-rounds-count">{rounds.length}</span>
          </div>
          <div className="wf-rounds-scroll">
            {rounds.length === 0 && <div className="wf-empty-inline">{t('empty.noRounds')}</div>}
            {rounds.map(round => (
              <RoundItem
                key={round.turn}
                round={round}
                active={selected?.turn === round.turn}
                onSelect={() => { setSelection(round.turn) }}
                t={t}
              />
            ))}
            {eventWindow.hasMore && (
              <button type="button" className="wf-loadmore" onClick={onLoadOlder} disabled={loading}>
                {loading ? t('list.loading') : t('list.loadOlder')}
              </button>
            )}
          </div>
        </aside>

        <main className="wf-detail">
          {selected === null
            ? <div className="wf-placeholder">{t('empty.noRounds')}</div>
            : (
              <>
                <header className="wf-detail-head">
                  <div className="wf-detail-title">
                    <span className="wf-detail-round">{t('list.round', { turn: selected.turn })}</span>
                    <span className={`wf-status ${roundStatusClass(selected)}`}>{t(statusKey(selected.live ? 'running' : selected.status))}</span>
                    <span className="wf-chip">{formatClock(selected.startedAt)}</span>
                    <span className="wf-chip">{formatDuration(selected.durationMs)}</span>
                    <span className="wf-chip">{t('metric.modelCalls')} {selected.modelCallCount}</span>
                    <span className="wf-chip">{t('metric.toolCalls')} {selected.toolCallCount}</span>
                    <span className="wf-detail-actions">
                      <button type="button" className="wf-link" onClick={expandAll}>{t('action.expandAll')}</button>
                      <button type="button" className="wf-link" onClick={collapseAll}>{t('action.collapseAll')}</button>
                    </span>
                  </div>
                  <div className="wf-detail-prompt" title={selected.promptText}>
                    {selected.promptText.trim() === '' ? t('empty.noMessages') : selected.promptText}
                  </div>
                  {selected.endError !== null && <div className="wf-detail-error">{selected.endError}</div>}
                  <TokenStrip usage={selected.usage} t={t} />
                </header>

                {selected.calls.length === 0
                  ? <div className="wf-placeholder">{t('empty.title')}</div>
                  : (
                    <VirtualList
                      items={selected.calls}
                      getKey={getCallKey}
                      estimateHeight={54}
                      overscan={3}
                      className="wf-calls"
                      renderItem={call => <CallCard call={call} force={force} t={t} />}
                    />
                  )}
              </>
            )}
        </main>
      </div>
    </div>
  )
}
