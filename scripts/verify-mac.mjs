// Launch the production renderer against real macOS data. Never call confirm().
import { _electron as electron, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const require = createRequire(import.meta.url)
if (process.platform !== 'darwin') throw new Error('This verification requires macOS.')
const root = resolve(import.meta.dirname, '..')
const userData = await mkdtemp(join(tmpdir(), 'macstodian-electron-'))
const output = join(root, 'verification')
await mkdir(output, { recursive: true })
const env = { ...process.env, MACSTODIAN_VERIFY_READ_ONLY: '1' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const errors = [],
  network = []
let app, heartbeat
try {
  app = await electron.launch({
    colorScheme: null,
    executablePath: require('electron'),
    args: [root, `--user-data-dir=${userData}`],
    env,
    timeout: 60000
  })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    if (/^https?:/.test(request.url())) network.push(request.url())
  })
  await expect(page.getByRole('heading', { name: 'Know what takes up space.' })).toBeVisible()
  const security = await app.evaluate(({ BrowserWindow }) => {
    const settings = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
    return {
      contextIsolation: settings.contextIsolation,
      nodeIntegration: settings.nodeIntegration,
      sandbox: settings.sandbox
    }
  })
  expect(security).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true })
  expect(await page.evaluate(() => typeof window.require)).toBe('undefined')
  console.log('Electron launched; sandboxed preload and production renderer loaded.')
  await page.evaluate(() =>
    window.macstodian.onProgress((p) => {
      window.__verifyProgress = {
        phase: p.phase,
        completed: p.completed,
        files: p.files,
        skipped: p.skipped
      }
    })
  )
  await page.getByRole('button', { name: 'Scan this Mac', exact: true }).click()
  await expect(page.getByRole('status')).toBeVisible()
  await page.getByRole('button', { name: /^Leftovers/ }).click()
  await expect(page.getByRole('heading', { name: 'A closer look at what’s left.' })).toBeVisible()
  await page.getByRole('button', { name: /^Apps/ }).click()
  heartbeat = setInterval(async () => {
    try {
      console.log(
        'Scan progress:',
        JSON.stringify(await page.evaluate(() => window.__verifyProgress))
      )
    } catch {
      /* app closed */
    }
  }, 10000)
  await expect(page.getByRole('region', { name: 'Scan summary' })).toBeVisible({
    timeout: 20 * 60 * 1000
  })
  clearInterval(heartbeat)
  await expect(page.locator('.stats > div')).toHaveCount(4)
  await expect(page.locator('.stats > div').nth(3)).toContainText('POSSIBLE LEFTOVERS')
  let skippedCount = 0
  if (await page.locator('.skipped').count()) {
    await page.locator('.skipped summary').click()
    const skippedPaths = await page.locator('.skipped-list code').allTextContents()
    skippedCount = skippedPaths.length
    // Root identity failures can reference Info.plist. Package internals must not
    // leak into the exclusion list from size measurement or helper discovery.
    const packageInternalExclusions = skippedPaths.filter(
      (path) => /\.app\//i.test(path) && !/\.app\/Contents\/Info\.plist$/i.test(path)
    )
    expect(packageInternalExclusions).toEqual([])
    await page.locator('.skipped summary').click()
  }
  const apps = await page.locator('tbody > tr').count()
  expect(apps).toBeGreaterThan(0)
  await page.screenshot({ path: join(output, 'apps.png') })
  await page.getByRole('button', { name: 'App size', exact: true }).click()
  await expect(page.getByRole('columnheader', { name: 'App size' })).toHaveAttribute(
    'aria-sort',
    'descending'
  )
  await page.getByRole('button', { name: 'App size', exact: true }).click()
  await expect(page.getByRole('columnheader', { name: 'App size' })).toHaveAttribute(
    'aria-sort',
    'ascending'
  )
  await page.getByRole('button', { name: 'Data last changed', exact: true }).click()
  const detail = page.getByRole('button', { name: /^Details for/ }).first()
  await detail.click()
  await expect(page.getByText('Bundle & every matched path')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Show in Finder ↗' }).first()).toBeVisible()
  await page.screenshot({ path: join(output, 'app-details.png') })
  await detail.click()
  const search = page.getByRole('textbox', { name: 'Search apps' })
  await search.fill('no-such-macstodian-app-093235')
  await expect(page.getByText('No applications match this search.')).toBeVisible()
  await search.fill('')
  let reviewed = false
  const reviews = page.getByRole('button', { name: 'Review removal', exact: true })
  const reviewCount = await reviews.count()
  if (reviewCount) {
    await reviews.first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const checks = dialog.getByRole('checkbox')
    expect(await checks.count()).toBeGreaterThan(0)
    expect(await checks.first().isChecked()).toBe(await checks.first().isEnabled())
    for (const checkbox of (await checks.all()).slice(1))
      expect(await checkbox.isChecked()).toBe(false)
    await page.screenshot({ path: join(output, 'review-defaults.png') })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    reviewed = true
  }
  await page.getByRole('button', { name: /^Leftovers/ }).click()
  await expect(page.getByRole('heading', { name: /^Possible leftovers/ })).toBeVisible()
  const leftovers = await page.locator('article.leftover').count()
  await page.screenshot({ path: join(output, 'leftovers.png') })
  const sizes = await page.locator('.leftover-title > strong').allTextContents()
  const factor = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }
  const bytes = sizes.map((value) => {
    const [number, unit] = value.replaceAll(',', '').split(' ')
    return Number(number) * factor[unit]
  })
  expect(bytes.every((value, index) => index === 0 || bytes[index - 1] >= value)).toBe(true)
  if (leftovers) {
    const first = page.locator('article.leftover').first()
    await expect(first.getByRole('button', { name: 'Show in Finder ↗' })).toBeVisible()
    const select = page.getByRole('checkbox')
    for (const checkbox of await select.all()) {
      if (await checkbox.isEnabled()) {
        await checkbox.check()
        await expect(page.getByRole('button', { name: 'Review selected items' })).toBeVisible()
        await page.getByRole('button', { name: 'Review selected items' }).click()
        await expect(page.getByRole('heading', { name: 'Confirm move to Trash' })).toBeVisible({
          timeout: 120000
        })
        await expect(page.getByRole('button', { name: 'Confirm move to Trash' })).toBeVisible()
        await page.screenshot({ path: join(output, 'leftover-confirmation.png') })
        await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
        break
      }
    }
  }
  expect(errors).toEqual([])
  expect(network).toEqual([])
  const report = {
    verifiedAt: new Date().toISOString(),
    platform: process.platform,
    electron: await app.evaluate(() => process.versions.electron),
    apps,
    leftovers,
    appReviewDefaultsChecked: reviewed,
    skippedCount,
    packageInternalExclusions: 0,
    security,
    rendererErrors: errors,
    networkRequests: network,
    realUserDataTrashed: false,
    checks: [
      'production Electron launch',
      'real read-only scan',
      'four scan-wide summary cards including possible leftover bytes',
      'no package-internal paths in scanner exclusions',
      'both tabs during scan',
      'app size sorting in both directions',
      'expanded matched paths',
      'search / empty results',
      'leftovers largest first',
      'leftovers review / explicit confirmation screen',
      'no Trash confirmation invoked'
    ]
  }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  clearInterval(heartbeat)
  if (app) await app.close()
  await rm(userData, { recursive: true, force: true })
}
