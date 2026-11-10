// Launch the production renderer against real macOS data. Never call confirm().
import { _electron as electron, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readlink, rm, writeFile } from 'node:fs/promises'
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
  await page.getByRole('button', { name: /^Apps/ }).click()
  await expect(page.getByRole('heading', { name: /^Applications/ })).toBeVisible()
  await expect(page.locator('tbody > tr').first()).toBeVisible()
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
  let skywardRecognized = false
  if (
    (await readlink('/Applications/Skyward.app/WrappedBundle').catch(() => null)) ===
    'Wrapper/Mobile.iOS.app'
  ) {
    await search.fill('Skyward')
    const row = page.locator('.apps-table tbody > tr').filter({
      has: page.getByRole('button', { name: 'Details for Skyward', exact: true })
    })
    await expect(row).toContainText('com.skyward.mobileaccess')
    await expect(row).not.toContainText('Protected')
    await page.screenshot({ path: join(output, 'skyward-identified.png') })
    await search.fill('')
    skywardRecognized = true
  }
  // Docker supplies several uniquely matched, complete paths on this test Mac.
  // The fixture test covers this behavior when Docker is not installed.
  await search.fill('Docker')
  const dockerRow = page.locator('.apps-table tbody > tr').filter({
    has: page.getByRole('button', { name: 'Details for Docker', exact: true })
  })
  if (await dockerRow.count()) {
    await dockerRow.getByRole('button', { name: 'Review removal' }).click()
    const possible = page.getByRole('dialog').locator('.possible-choice input:enabled')
    expect(await possible.count()).toBeGreaterThan(0)
    await expect(possible.first()).not.toBeChecked()
    await page.screenshot({ path: join(output, 'possible-app-review.png') })
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  }
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
  const leftoverGroups = await page.locator('article.leftover').count()
  const leftoverPaths = Number(
    (await page.locator('.stats > div').nth(3).locator('small').textContent())
      ?.match(/^[\d,]+/)?.[0]
      .replaceAll(',', '')
  )
  expect(leftoverGroups).toBeLessThanOrEqual(leftoverPaths)
  await page.screenshot({ path: join(output, 'leftovers.png') })
  const grouped = page.locator('.grouped-leftover').first()
  if (await grouped.count()) {
    await grouped.getByRole('button', { name: /^Details for/ }).click()
    expect(await grouped.locator('.group-path').count()).toBeGreaterThan(1)
    await page.screenshot({ path: join(output, 'grouped-leftovers.png') })
    await grouped.getByRole('button', { name: /^Details for/ }).click()
  }
  const sizes = await page.locator('.leftover-title > strong').allTextContents()
  const factor = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }
  const bytes = sizes.map((value) => {
    const [number, unit] = value.replaceAll(',', '').split(' ')
    return Number(number) * factor[unit]
  })
  expect(bytes.every((value, index) => index === 0 || bytes[index - 1] >= value)).toBe(true)
  const leftoverSort = page.getByRole('combobox', { name: 'Sort leftovers' })
  await expect(leftoverSort).toHaveValue('size-desc')
  await leftoverSort.selectOption('age-asc')
  await expect(leftoverSort).toHaveValue('age-asc')
  await leftoverSort.selectOption('age-desc')
  await expect(leftoverSort).toHaveValue('age-desc')
  await leftoverSort.selectOption('size-desc')
  if (leftoverGroups) {
    const first = page.locator('article.leftover').first()
    const details = first.getByRole('button', { name: /^Details for/ })
    if (await details.count()) await details.click()
    await expect(first.getByRole('button', { name: 'Show in Finder ↗' }).first()).toBeVisible()
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
    leftovers: leftoverPaths,
    leftoverGroups,
    skywardRecognized,
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
      'iOS-style Skyward wrapper identified when installed',
      'uniquely related app paths appear unchecked in the review when present',
      'leftovers largest first',
      'leftover age sorting in both directions',
      'same-name leftovers grouped with inspectable paths',
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
