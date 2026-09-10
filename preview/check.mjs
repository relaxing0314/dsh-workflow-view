/**
 * Structural + accessibility verification of the Workflow view (dev tooling only).
 *
 * Starts the preview server, drives a real Chromium through the rendered page,
 * and asserts the layout contract the plugin promises: tab label, header
 * metrics, the two independently scrolling panes, windowed model-call rows, and
 * horizontal overflow on wide recorded lines. It then measures the *computed*
 * foreground/background pairs of every status, role, and JSON token in BOTH
 * themes and requires WCAG AA — the failed-round badge once measured 1.00:1 in
 * dark mode (`--dsw-alias-state-error-primary` and `-secondary` are the same
 * opaque red there), so this is the regression guard for that class of bug.
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

/** Minimum contrast for small UI text (WCAG 2.1 AA). */
const AA = 4.5

/**
 * Every status / role / JSON token the view paints, measured in both themes.
 * `CONTRAST_REQUIRED` marks the pairs that must actually be on screen, so a
 * selector that silently stops rendering cannot pass as "nothing to check".
 */
const CONTRAST_TARGETS = [
  '.wf-status-bad',
  '.wf-detail-error',
  '.wf-status-running',
  '.wf-status-warn',
  '.wf-status-ok',
  '.wf-role-user',
  '.wf-role-assistant',
  '.wf-role-tool',
  '.wf-json-string',
  '.wf-json-number',
]
const CONTRAST_REQUIRED = {
  '.wf-status-bad': true,
  '.wf-detail-error': true,
  '.wf-status-running': true,
  '.wf-status-warn': true,
  '.wf-status-ok': false,
  '.wf-role-user': true,
  '.wf-role-assistant': false,
  '.wf-role-tool': false,
  '.wf-json-string': false,
  '.wf-json-number': false,
}

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

/* ------------------------------------------------------------ contrast math */

const channel = (value) => {
  const s = value / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
function contrastRatio(foreground, background) {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (light + 0.05) / (dark + 0.05)
}

/* ----------------------------------------------------------------- harness */

const failures = []
const notes = []
const check = (condition, message) => {
  if (condition) notes.push(`ok   ${message}`)
  else failures.push(message)
}

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

  // Sections remember their own open state (a section holding a failed tool
  // opens by default), so a blind click would close it. Open only when closed.
  const ensureOpen = async (toggle) => {
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
    await page.waitForTimeout(250)
  }

  /* ---------------------------------------------------------------- header */

  const activeTab = (await page.locator('.preview-tab.is-active').innerText()).trim()
  check(activeTab === '工作流', `tab label is 工作流 (got "${activeTab}")`)

  const metrics = await page.locator('.wf-metric').allInnerTexts()
  check(metrics.length === 4, `header shows 4 metrics (got ${metrics.length})`)
  notes.push(`info metrics: ${metrics.map(t => t.replace(/\n+/gu, '=')).join(' | ')}`)

  const tokenLabels = await page.locator('.wf-header .wf-token-label').allInnerTexts()
  check(
    ['输入', '未缓存输入', '缓存读取', '缓存写入', '输出'].every(label => tokenLabels.includes(label)),
    `header token strip shows input/uncached/cache-read/cache-write/output (got ${tokenLabels.join(',')})`,
  )

  /* ------------------------------------------------------- two panes + list */

  const rounds = await page.locator('.wf-round').count()
  check(rounds === 3, `left list renders every round (got ${rounds})`)
  const roundsBox = await box('.wf-rounds')
  const detailBox = await box('.wf-detail')
  check(
    roundsBox !== null && detailBox !== null && roundsBox.x + roundsBox.width <= detailBox.x + 1,
    'left column sits entirely left of the detail column',
  )
  notes.push(`info left width=${Math.round(roundsBox?.width ?? 0)}px, detail width=${Math.round(detailBox?.width ?? 0)}px`)

  const roundStatuses = (await page.locator('.wf-round .wf-status').allInnerTexts()).join(',')
  check(
    ['进行中', '已中止', '已失败'].every(label => roundStatuses.includes(label)),
    `round list shows running / aborted / failed states (got ${roundStatuses})`,
  )

  /* --------------------------------------------------- big round: windowing */

  // Round 1 is the 47-call recorded turn, so the virtualization assertion is
  // meaningful rather than trivially true on the one-call failure fixture.
  await page.locator('.wf-round').first().click()
  await page.waitForTimeout(300)
  const callsOverflow = await page.locator('.wf-calls').evaluate(el => el.scrollHeight > el.clientHeight)
  check(callsOverflow, 'model-call list scrolls inside its own pane')
  const renderedCalls = await page.locator('.wf-call').count()
  check(
    renderedCalls > 0 && renderedCalls < 30,
    `model-call rows are windowed (rendered ${renderedCalls} of 47)`,
  )
  const inventoryBox = await box('.wf-calls')
  notes.push(`info detail pane height=${Math.round(inventoryBox?.height ?? 0)}px`)

  /* -------------------------------------------------- call card structure */

  const card = page.locator('.wf-call').first()
  notes.push(`info call head: ${(await card.locator('.wf-call-head').innerText()).replace(/\n+/gu, ' · ')}`)
  const sectionTitles = await card.locator('.wf-section-title').allInnerTexts()
  check(
    ['请求', '响应', '工具调用'].every(title => sectionTitles.includes(title)),
    `call card exposes 请求 / 响应 / 工具调用 sections (got ${sectionTitles.join(',')})`,
  )

  await ensureOpen(card.locator('.wf-section-toggle').first())
  const blockTitles = (await card.locator('.wf-block-title').allInnerTexts())
    .map(text => text.replace(/\s+/gu, ' ').trim())
  notes.push(`info request blocks: ${blockTitles.join(' | ')}`)
  check(blockTitles.some(t => t.includes('系统提示词')), 'request shows the recorded system prompt')
  check(blockTitles.some(t => t.includes('messages[]')), 'request shows the provider-neutral messages[]')
  check(blockTitles.some(t => t.includes('tools[]')), 'request shows the recorded tools[]')
  check((await card.locator('.wf-role').count()) >= 1, 'messages[] render role-tagged entries')
  check((await card.locator('.wf-json-row').count()) > 0, 'JSON tree nodes rendered')

  const scrollx = page.locator('.wf-scrollx').first()
  const overflow = await scrollx.evaluate(el => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
  check(
    overflow.scrollWidth > overflow.clientWidth,
    `wide recorded lines overflow horizontally instead of wrapping (${overflow.scrollWidth} > ${overflow.clientWidth})`,
  )

  await ensureOpen(card.locator('.wf-section-toggle').nth(1))
  const responseBlocks = (await card.locator('.wf-block-title').allInnerTexts())
    .map(text => text.replace(/\s+/gu, ' ').trim()).join(' | ')
  check(responseBlocks.includes('推理 reasoning'), 'response shows recorded reasoning')
  check(responseBlocks.includes('内容 content'), 'response shows recorded content')
  check(responseBlocks.includes('响应原始记录'), 'response shows the raw response record')
  // The response pane renders reasoning as a plain code block (the
  // `.wf-pre-reasoning` modifier only exists on message cards), so assert on the
  // section's own body rather than a class that never appears here.
  const responseBody = await card.locator('.wf-section').nth(1).innerText()
  check(
    responseBody.includes('推理 reasoning') && responseBody.replace(/\s+/gu, '').length > 100,
    `response section renders its recorded bodies (${responseBody.replace(/\s+/gu, '').length} chars)`,
  )

  await ensureOpen(card.locator('.wf-section-toggle').nth(2))
  const toolTitles = (await card.locator('.wf-tool .wf-block-title').allInnerTexts()).join(',')
  check(
    toolTitles.includes('调用参数') && toolTitles.includes('执行结果'),
    `tool card shows 调用参数 / 执行结果 (got ${toolTitles})`,
  )

  await page.locator('.wf-detail-actions .wf-link').first().click()
  await page.waitForTimeout(400)
  const afterExpand = await page.evaluate(() => document.querySelectorAll('.wf-section.is-open').length)
  await page.locator('.wf-detail-actions .wf-link').nth(1).click()
  await page.waitForTimeout(300)
  const afterCollapse = await page.evaluate(() => document.querySelectorAll('.wf-section.is-open').length)
  check(afterExpand > afterCollapse, `展开全部 / 收起全部 work (${afterExpand} → ${afterCollapse} open)`)

  /* ------------------------------------------------- the reported failure */

  await page.locator('.wf-round').last().click()
  await page.waitForTimeout(300)
  check((await page.locator('.wf-detail-round').innerText()).includes('3'), 'selecting the failed round re-renders the detail pane')
  const failureText = await page.locator('.wf-detail-error').innerText().catch(() => '')
  check(failureText.includes('503'), `the recorded failure message is shown (got "${failureText.slice(0, 60)}")`)
  const failedToolStatus = await page.locator('.wf-call .wf-tool .wf-status').first().innerText().catch(() => '')
  check(failedToolStatus === '失败', `a failed tool execution is labelled 失败 (got "${failedToolStatus}")`)

  /* ---------------------------------------------------- contrast, 2 themes */

  await ensureOpen(page.locator('.wf-call').first().locator('.wf-section-toggle').first())

  /**
   * Resolve computed colours through a 1x1 canvas. `getComputedStyle` returns
   * `color(srgb …)` for anything derived with `color-mix()`, so a hand-rolled
   * rgb() regex silently yields null — and a null reading must never be mistaken
   * for "nothing to check". The canvas accepts any CSS colour and hands back the
   * exact sRGB bytes that end up on screen.
   */
  const measure = (selectors) => {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d')
    const resolve = (value) => {
      if (value === undefined || value === '') return null
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const data = context.getImageData(0, 0, 1, 1).data
      return { r: data[0], g: data[1], b: data[2], a: data[3] / 255 }
    }
    const out = {}
    for (const selector of selectors) {
      const element = document.querySelector(selector)
      if (element === null) { out[selector] = null; continue }
      let node = element
      let background = null
      while (node !== null) {
        const candidate = resolve(getComputedStyle(node).backgroundColor)
        if (candidate !== null && candidate.a > 0.95) { background = candidate; break }
        node = node.parentElement
      }
      out[selector] = {
        fg: resolve(getComputedStyle(element).color),
        bg: background ?? resolve(getComputedStyle(document.body).backgroundColor),
      }
    }
    return out
  }

  for (const theme of ['light', 'dark']) {
    await page.evaluate((next) => {
      if (next === 'dark') document.documentElement.dataset.theme = 'dark'
      else delete document.documentElement.dataset.theme
    }, theme)
    await page.waitForTimeout(250)
    const measured = await page.evaluate(measure, CONTRAST_TARGETS)

    for (const [selector, required] of Object.entries(CONTRAST_REQUIRED)) {
      const entry = measured[selector]
      if (entry === null || entry === undefined || entry.fg === null || entry.bg === null) {
        if (required) failures.push(`${theme}: ${selector} is not rendered, so its contrast is unverified`)
        continue
      }
      const ratio = contrastRatio(entry.fg, entry.bg)
      const label = `${theme.padEnd(5)} ${selector.padEnd(22)} ${ratio.toFixed(2).padStart(6)}:1`
      if (ratio >= AA) notes.push(`ok   contrast ${label}`)
      else failures.push(`contrast ${label} — below WCAG AA (${AA}:1)`)
    }
  }

  check(problems.length === 0, `no runtime errors in the page (${problems.join(' | ') || 'none'})`)

  await page.evaluate(() => { delete document.documentElement.dataset.theme })
  await page.waitForTimeout(150)
  await page.screenshot({ path: join(HERE, 'shot.png') })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await page.waitForTimeout(200)
  await page.screenshot({ path: join(HERE, 'shot-dark.png') })
} finally {
  await browser.close()
  stop()
}

process.stdout.write(`${notes.join('\n')}\n\n`)
if (failures.length > 0) {
  process.stdout.write(`FAIL ${failures.length}\n${failures.map(f => `  - ${f}`).join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('PASS: every layout, behaviour, and contrast assertion held\n')
}
void PLUGIN_ROOT
