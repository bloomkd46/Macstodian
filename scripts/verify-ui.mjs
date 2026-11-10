// Exercise destructive UI states with fixture IPC. This harness has no Trash handler.
import { _electron as electron, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'macstodian-ui-'))
const output = join(root, 'verification')
await mkdir(output, { recursive: true })
const item = (id, category, path, bytes, ownerIds = [], protectedItem = false) => ({
  id,
  category,
  path,
  bytes,
  ownerIds,
  protected: protectedItem,
  name: path.split('/').at(-1),
  latestChange: Date.UTC(2025, 0, 2),
  partial: false,
  skippedSymlinks: 0,
  confidence: ownerIds.length ? 'exact' : 'unmatched',
  reason: 'Disposable UI fixture.'
})
const items = [
  item('bundle', 'bundle', '/fixture/Applications/Alpha.app', 100, ['alpha']),
  item('cache', 'cache', '/fixture/Library/Caches/dev.alpha', 25, ['alpha']),
  item('data', 'support', '/fixture/Library/Application Support/dev.alpha', 50, ['alpha']),
  item('running-bundle', 'bundle', '/fixture/Applications/Running.app', 10, ['running']),
  item('orphan', 'support', '/fixture/Library/Application Support/orphan', 45),
  {
    ...item(
      'shared',
      'support',
      '/fixture/Library/Application Support/Microsoft',
      80,
      ['alpha'],
      true
    ),
    confidence: 'shared'
  }
]
const app = (id, name, bundleItemId, path, appBytes, dataItemIds = [], dataBytes = 0) => ({
  id,
  name,
  bundleItemId,
  path,
  appBytes,
  dataItemIds,
  dataBytes,
  totalBytes: appBytes + dataBytes,
  bundleId: `dev.${id}`,
  sharedItemIds: id === 'alpha' ? ['shared'] : [],
  lastOpened: null,
  dataLastChanged: dataBytes ? Date.UTC(2025, 0, 2) : null,
  partial: false,
  protected: false,
  uninstaller: null
})
const apps = [
  app('alpha', 'Alpha', 'bundle', '/fixture/Applications/Alpha.app', 100, ['cache', 'data'], 75),
  app('running', 'Running App', 'running-bundle', '/fixture/Applications/Running.app', 10)
]
const main = join(temporary, 'main.cjs')
await writeFile(
  main,
  `
const { app, BrowserWindow, ipcMain } = require('electron');
const items = ${JSON.stringify(items)}, apps = ${JSON.stringify(apps)};
globalThis.__uiTest = { scans: 0, requests: [], confirmations: 0, reveals: [], orphan: true };
let snapshot, plan;
ipcMain.handle('storage:scan', () => { globalThis.__uiTest.scans++; snapshot = { id: 'scan-' + globalThis.__uiTest.scans, createdAt: Date.now(), durationMs: 1, apps, items: items.filter(i => i.id !== 'orphan' || globalThis.__uiTest.orphan), skipped: [], roots: ['/fixture'] }; return snapshot; });
ipcMain.handle('storage:review', (_event, request) => { globalThis.__uiTest.requests.push(request); if (request.scanId !== snapshot.id) throw new Error('Stale selection.'); if (request.appId === 'running') throw new Error('Quit Running App before removing its bundle or data, then try again.'); const selected = request.itemIds.map(id => snapshot.items.find(i => i.id === id)); if (selected.some(i => !i)) throw new Error('Unknown ID'); plan = { id: 'plan-' + globalThis.__uiTest.requests.length, items: selected, appName: request.appId ? 'Alpha' : null, totalBytes: selected.reduce((n, i) => n + i.bytes, 0), expiresAt: Date.now() + 300000 }; return plan; });
ipcMain.handle('storage:confirm', (_event, id) => { if (id !== plan.id) throw new Error('Invalid plan'); globalThis.__uiTest.confirmations++; if (!plan.appName) globalThis.__uiTest.orphan = false; return plan.items.map(i => ({ itemId: i.id, path: i.path, status: plan.appName ? i.category === 'bundle' ? 'failed' : 'skipped' : 'trashed', message: plan.appName ? 'Fixture bundle failure: data left untouched.' : 'Moved to Trash (fixture only).' })); });
ipcMain.handle('storage:reveal', (_event, request) => { globalThis.__uiTest.reveals.push(request); });
app.whenReady().then(() => { const win = new BrowserWindow({ width: 1380, height: 900, webPreferences: { preload: ${JSON.stringify(join(root, 'out/preload/index.js'))}, contextIsolation: true, sandbox: true, nodeIntegration: false } }); win.loadFile(${JSON.stringify(join(root, 'out/renderer/index.html'))}); });
app.on('window-all-closed', () => app.quit());
`
)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
let electronApp
try {
  electronApp = await electron.launch({
    colorScheme: null,
    executablePath: require('electron'),
    args: [main, `--user-data-dir=${join(temporary, 'user-data')}`],
    env
  })
  const page = await electronApp.firstWindow(),
    errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  async function checkAppearance(theme, view, surfaces) {
    // Exercise Electron's native preference propagation, not just a CSS class override.
    await electronApp.evaluate(({ nativeTheme }, source) => {
      nativeTheme.themeSource = source
    }, theme)
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
      .toBe(theme)
    const expectedCanvas = theme === 'dark' ? 'rgb(20, 26, 23)' : 'rgb(248, 250, 248)'
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor))
      .toBe(expectedCanvas)
    for (const selector of surfaces) {
      const background = await page
        .locator(selector)
        .first()
        .evaluate((element) => getComputedStyle(element).backgroundColor)
      expect(background).toBe(theme === 'dark' ? 'rgb(29, 39, 32)' : 'rgb(255, 255, 255)')
    }
    await page.screenshot({ path: join(output, `${theme}-${view}.png`) })
  }
  await checkAppearance('dark', 'empty', [])
  await page.getByRole('button', { name: 'Scan this Mac', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Scan summary' })).toBeVisible()
  await checkAppearance('dark', 'apps', ['.stats', '.table-wrap'])
  await checkAppearance('light', 'apps', ['.stats', '.table-wrap'])
  await checkAppearance('dark', 'apps', ['.stats', '.table-wrap'])
  await page.getByRole('button', { name: 'Review removal', exact: true }).first().click()
  let dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('checkbox').first()).toBeChecked()
  await expect(dialog.getByRole('checkbox').nth(1)).not.toBeChecked()
  await expect(dialog.getByRole('checkbox').nth(2)).not.toBeChecked()
  await dialog.getByRole('checkbox').nth(1).check()
  await dialog.getByRole('checkbox').nth(2).check()
  await checkAppearance('dark', 'review', ['.modal', '.review-choice'])
  await checkAppearance('light', 'review', ['.modal', '.review-choice'])
  await expect(dialog.getByRole('checkbox').nth(1)).toBeChecked()
  await expect(dialog.getByRole('checkbox').nth(2)).toBeChecked()
  await checkAppearance('dark', 'review', ['.modal', '.review-choice'])
  await dialog.getByRole('button', { name: 'Review selected paths' }).click()
  await expect(page.getByRole('heading', { name: 'Confirm move to Trash' })).toBeVisible()
  expect(await dialog.locator('.path-item').count()).toBe(3)
  const request = await electronApp.evaluate(() => globalThis.__uiTest.requests[0])
  expect(request).toEqual({
    scanId: 'scan-1',
    appId: 'alpha',
    itemIds: ['bundle', 'cache', 'data']
  })
  expect(await electronApp.evaluate(() => globalThis.__uiTest.confirmations)).toBe(0)
  await dialog.getByRole('button', { name: 'Confirm move to Trash' }).click()
  await expect(page.getByRole('region', { name: 'Removal outcomes' })).toContainText('Failed')
  await expect(page.getByRole('region', { name: 'Removal outcomes' })).toContainText('Skipped')
  await expect.poll(() => electronApp.evaluate(() => globalThis.__uiTest.scans)).toBe(2)
  await page.getByRole('button', { name: 'Dismiss results' }).click()
  await page.getByRole('button', { name: 'Review removal', exact: true }).nth(1).click()
  await dialog.getByRole('button', { name: 'Review selected paths' }).click()
  await expect(dialog.getByRole('alert')).toContainText('Quit Running App')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: /^Leftovers/ }).click()
  await expect(page.locator('article.leftover')).toHaveCount(1)
  await checkAppearance('dark', 'leftovers', ['.leftover-list'])
  await checkAppearance('light', 'leftovers', ['.leftover-list'])
  await checkAppearance('dark', 'leftovers', ['.leftover-list'])
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Review selected items' }).click()
  await expect(page.getByRole('heading', { name: 'Confirm move to Trash' })).toBeVisible()
  await page.screenshot({ path: join(output, 'fixture-confirmation.png') })
  await dialog.getByRole('button', { name: 'Confirm move to Trash' }).click()
  await expect(page.getByRole('region', { name: 'Removal outcomes' })).toContainText(
    'Moved to Trash'
  )
  await expect(page.locator('article.leftover')).toHaveCount(0)
  expect(await electronApp.evaluate(() => globalThis.__uiTest.scans)).toBe(3)
  expect(await electronApp.evaluate(() => globalThis.__uiTest.confirmations)).toBe(2)
  expect(errors).toEqual([])
  const report = {
    passed: [
      'app bundle selected; all data unchecked by default',
      'separate cache and settings choices',
      'review lists all selected paths before confirmation',
      'renderer submits IDs only',
      'bundle failure / skipped data outcomes displayed',
      'automatic rescan after confirmation',
      'running-app rejection displayed',
      'leftover explicit selection / confirmation',
      'successful fixture removal outcome displayed',
      'refresh clears removed leftover',
      'native light/dark appearance changes propagate live across both tabs and dialogs',
      'native dark controls and themed surfaces',
      'theme changes preserve removal selections'
    ],
    realUserDataTrashed: false,
    rendererErrors: errors
  }
  await writeFile(join(output, 'fixture-report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  if (electronApp) await electronApp.close()
  await rm(temporary, { recursive: true, force: true })
}
