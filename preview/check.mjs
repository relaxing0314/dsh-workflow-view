/**
 * Structural verification of the Workflow view (dev tooling only).
 *
 * Starts the preview server, drives a real Chromium through the rendered page,
 * and asserts the layout contract the plugin promises: tab label, header
 * metrics, the two independently scrolling panes, windowed model-call rows, and
 * horizontal overflow on wide recorded lines. Prints element geometry so the
 * layout can be reviewed without looking at a screenshot.
 *
 * Usage: node preview/check.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = dirname(HERE)
const CHECKOUT = process.env.DSH_CHECKOUT ?? '/Users/gaojing/Desktop/my-projects/ai-deepseek-harness'
const PORT = Number(process.env.PREVIEW_PORT ?? 5199)
const URL_BASE = `http://127.0.0.1:${PORT}/preview/index.html`

const store = join(CHECKOUT, 'node_modules/.pnpm')
const playwrightEntry = readdirSync(store).filter(name => /^playwright@\d/u.test(name)).sort().reverse()
  .map(name => join(store, name, 'node_modules/playwright/index.js'))
  .find(candidate => existsSync(candidate))
if (playwrightEntry === undefined) throw new Error('check: playwright not found')
const loaded = await import(pathToFileURL(playwrightEntry).href)
const { chromium } = loaded.default ?? loaded

const server = spawn(process.execPath, [join(HERE, 'serve.mjs')], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PREVIEW_PORT: String(PORT) },
})
const stop = () => { if (!server.killed) server.kill('SIGTERM') }
process.on('exit', stop)

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { reject(new Error('check: preview server did not start')) }, 8000)
  server.stdout.on('data', (chunk) => {
    if (String(chunk).includes('http://')) { clearTimeout(timer); resolve() }
  })
  server.on('error', reject)
})

const failures = []
const notes = []
const check = (condition, message) => { if (!condition) failures.push(message); else notes.push(`ok   ${message}`) }

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 980 }, deviceScaleFactor: 2 })
  const problems = []
  page.on('pageerror', error => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`)
  })

  await page.goto(URL_BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('.wf-root', { timeout: 10000 })
  await page.waitForTimeout(500)

  const box = async selector => page.locator(selector).first().boundingBox()

  // --- header -------------------------------------------------------------
  const activeTab = await page.locator('.preview-tab.is-active').innerText()
  check(activeTab.trim() === '工作流', `tab label is 工作流 (got "${activeTab.trim()}")`)

  const metrics = await page.locator('.wf-metric').allInnerTexts()
  check(metrics.length === 4, `header shows 4 metrics (got ${metrics.length})`)
  const metricText = metrics.map(text => text.replace(/\n+/gu, '=')).join(' | ')
  notes.push(`info metrics: ${metricText}`)

  const tokenLabels = await page.locator('.wf-header .wf-token-label').allInnerTexts()
  check(
    ['输入', '未缓存输入', '缓存读取', '缓存写入', '输出'].every(label => tokenLabels.includes(label)),
    `header token strip shows input/uncached/cache-read/cache-write/output (got ${tokenLabels.join(',')})`,
  )

  // --- two independent panes ---------------------------------------------
  const rounds = await page.locator('.wf-round').count()
  check(rounds >= 1, `left list renders rounds (got ${rounds})`)
  const roundsBox = await box('.wf-rounds')
  const detailBox = await box('.wf-detail')
  check(
    roundsBox !== null && detailBox !== null && roundsBox.x + roundsBox.width <= detailBox.x + 1,
    'left column sits entirely left of the detail column',
  )
  notes.push(`info left width=${Math.round(roundsBox?.width ?? 0)}px, detail width=${Math.round(detailBox?.width ?? 0)}px`)

  const roundsOverflow = await page.locator('.wf-rounds-scroll').evaluate(el => el.scrollHeight > el.clientHeight)
  const callsOverflow = await page.locator('.wf-calls').evaluate(el => el.scrollHeight > el.clientHeight)
  check(callsOverflow, 'model-call list scrolls inside its own pane')
  notes.push(`info left list scrolls on its own: ${String(roundsOverflow)}`)

  // --- virtualization -----------------------------------------------------
  const totalCalls = await page.evaluate(() => {
    const selected = document.querySelector('.wf-round.is-active .wf-round-stat')
    return selected === null ? -1 : -1
  })
  void totalCalls
  const renderedCalls = await page.locator('.wf-call').count()
  const inventoryBox = await box('.wf-calls')
  check(
    renderedCalls > 0 && renderedCalls < 30,
    `model-call rows are windowed (rendered ${renderedCalls} nodes)`,
  )
  notes.push(`info detail pane height=${Math.round(inventoryBox?.height ?? 0)}px`)

  // --- a call card's structure -------------------------------------------
  const card = page.locator('.wf-call').first()
  const headText = (await card.locator('.wf-call-head').innerText()).replace(/\n+/gu, ' · ')
  notes.push(`info call head: ${headText}`)
  const sectionTitles = await card.locator('.wf-section-title').allInnerTexts()
  check(
    ['请求', '响应', '工具调用'].every(title => sectionTitles.includes(title)),
    `call card exposes 请求 / 响应 / 工具调用 sections (got ${sectionTitles.join(',')})`,
  )

  // expand the request section and inspect its sub-blocks
  await card.locator('.wf-section-toggle').first().click()
  await page.waitForTimeout(300)
  const blockTitles = await card.locator('.wf-block-title').allInnerTexts()
  const blockText = blockTitles.map(text => text.replace(/\s+/gu, ' ').trim()).join(' | ')
  notes.push(`info request blocks: ${blockText}`)
  check(
    blockTitles.some(title => title.includes('系统提示词')),
    'request shows the recorded system prompt',
  )
  check(
    blockTitles.some(title => title.includes('messages[]')),
    'request shows the provider-neutral messages[]',
  )
  check(
    blockTitles.some(title => title.includes('tools[]')),
    'request shows the recorded tools[]',
  )

  const roles = await card.locator('.wf-role').allInnerTexts()
  check(roles.length >= 1, `messages[] render role-tagged entries (got ${roles.join(',')})`)

  const jsonRows = await card.locator('.wf-json-row').count()
  check(jsonRows > 0, `JSON tree nodes rendered (${jsonRows} rows)`)

  // --- horizontal overflow ------------------------------------------------
  const scrollx = page.locator('.wf-scrollx').first()
  const overflow = await scrollx.evaluate(el => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
  check(
    overflow.scrollWidth > overflow.clientWidth,
    `wide recorded lines overflow horizontally instead of wrapping (${overflow.scrollWidth} > ${overflow.clientWidth})`,
  )

  // --- tool execution states ---------------------------------------------
  await card.locator('.wf-section-toggle').nth(1).click()
  await page.waitForTimeout(300)
  const responseBlocks = (await card.locator('.wf-block-title').allInnerTexts())
    .map(text => text.replace(/\s+/gu, ' ').trim()).join(' | ')
  notes.push(`info response blocks: ${responseBlocks}`)
  check(responseBlocks.includes('推理 reasoning'), 'response shows recorded reasoning')
  check(responseBlocks.includes('内容 content'), 'response shows recorded content')
  check(responseBlocks.includes('响应原始记录'), 'response shows the raw response record')
  const reasoningText = await card.locator('.wf-pre-reasoning').first().innerText().catch(() => '')
  check(reasoningText.trim().length > 0, 'response reasoning body is rendered')

  await card.locator('.wf-section-toggle').nth(2).click()
  await page.waitForTimeout(300)
  const toolStatuses = await card.locator('.wf-tool .wf-status').allInnerTexts()
  notes.push(`info tool statuses on first card: ${toolStatuses.join(',')}`)
  check(toolStatuses.length >= 1, 'tool executions render a status badge')
  const toolTitles = (await card.locator('.wf-tool .wf-block-title').allInnerTexts()).join(',')
  check(toolTitles.includes('调用参数') && toolTitles.includes('执行结果'), `tool card shows 调用参数 / 执行结果 (got ${toolTitles})`)

  // --- expand-all control -------------------------------------------------
  await page.locator('.wf-detail-actions .wf-link').first().click()
  await page.waitForTimeout(400)
  const afterExpand = await page.evaluate(() => document.querySelectorAll('.wf-section.is-open').length)
  check(afterExpand > 0, `展开全部 opens sections (${afterExpand} open)`)
  await page.locator('.wf-detail-actions .wf-link').nth(1).click()
  await page.waitForTimeout(300)
  const afterCollapse = await page.evaluate(() => document.querySelectorAll('.wf-section.is-open').length)
  check(afterCollapse < afterExpand, `收起全部 closes them again (${afterCollapse} open)`)

  // --- round switching ----------------------------------------------------
  if (rounds > 1) {
    await page.locator('.wf-round').first().click()
    await page.waitForTimeout(300)
    const headAfter = await page.locator('.wf-detail-round').innerText()
    notes.push(`info after switching to first round: ${headAfter}`)
    check(headAfter.includes('1'), 'selecting another round re-renders the detail pane')
  }

  check(problems.length === 0, `no runtime errors in the page (${problems.join(' | ') || 'none'})`)

  await page.screenshot({ path: join(HERE, 'shot.png') })
} finally {
  await browser.close()
  stop()
}

process.stdout.write(`${notes.join('\n')}\n\n`)
if (failures.length > 0) {
  process.stdout.write(`FAIL ${failures.length}\n${failures.map(f => `  - ${f}`).join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('PASS: every layout and behaviour assertion held\n')
}
void PLUGIN_ROOT
