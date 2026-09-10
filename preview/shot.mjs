/**
 * Screenshot + console-error driver for the preview harness (dev tooling only).
 *
 * Usage: node preview/shot.mjs <output.png> [--expand] [--round N]
 */

import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const CHECKOUT = process.env.DSH_CHECKOUT ?? '/Users/gaojing/Desktop/my-projects/ai-deepseek-harness'
const store = join(CHECKOUT, 'node_modules/.pnpm')
const entry = readdirSync(store).filter(name => /^playwright@\d/u.test(name)).sort().reverse()
  .map(name => join(store, name, 'node_modules/playwright/index.js'))
  .find(candidate => existsSync(candidate))
if (entry === undefined) throw new Error('shot: playwright not found in the checkout store')
const loaded = await import(pathToFileURL(entry).href)
const { chromium } = loaded.default ?? loaded

const out = process.argv[2] ?? 'preview/shot.png'
const expand = process.argv.includes('--expand')
const url = process.env.PREVIEW_URL ?? 'http://127.0.0.1:5199/preview/index.html'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1680, height: 980 }, deviceScaleFactor: 2 })
const problems = []
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.push(`${message.type()}: ${message.text()}`)
})
page.on('pageerror', (error) => { problems.push(`pageerror: ${error.message}`) })

await page.goto(url, { waitUntil: 'networkidle' })
await page.waitForTimeout(600)

const roundButtons = await page.locator('.wf-round').count()
const callCards = await page.locator('.wf-call').count()
const header = await page.locator('.wf-header').innerText().catch(() => '')

if (expand) {
  const sections = await page.locator('.wf-call .wf-section-toggle').count()
  for (let index = 0; index < Math.min(sections, 3); index += 1) {
    await page.locator('.wf-call .wf-section-toggle').nth(index).click()
    await page.waitForTimeout(80)
  }
  await page.waitForTimeout(400)
}

await page.screenshot({ path: out })
console.log(JSON.stringify({ out, rounds: roundButtons, renderedCalls: callCards, header, problems }, null, 2))
await browser.close()
