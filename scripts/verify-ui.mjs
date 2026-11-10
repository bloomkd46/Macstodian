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
  item('running-bundle', 'bundle', '/fixture/Applications/Running.app', 200, ['running']),
  item('orphan', 'support', '/fixture/Library/Application Support/orphan', 45),
  {
    ...item('orphan-preferences', 'preferences', '/fixture/Library/Preferences/orphan', 15),
    latestChange: Date.UTC(2025, 0, 4, 12)
  },
  {
    ...item(
      'related',
      'support',
      '/fixture/Library/Application Support/Alpha',
      90,
      ['alpha'],
      true
    ),
    confidence: 'related',
    reason: 'Possible relation by exact product name; ownership unconfirmed.'
  },
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
  relatedItemIds: id === 'alpha' ? ['related'] : [],
  lastOpened: null,
  dataLastChanged: dataBytes ? Date.UTC(2025, 0, 2) : null,
  partial: false,
  protected: false,
  uninstaller: null
})
const apps = [
  app('alpha', 'Alpha', 'bundle', '/fixture/Applications/Alpha.app', 100, ['cache', 'data'], 75),
  app('running', 'Running App', 'running-bundle', '/fixture/Applications/Running.app', 200)
]
const main = join(temporary, 'main.cjs')
await writeFile(
  main,
  `
const { app, BrowserWindow, ipcMain } = require('electron');
const items = ${JSON.stringify(items)}, apps = ${JSON.stringify(apps)};
globalThis.__uiTest = { scans: 0, requests: [], confirmations: 0, reveals: [], orphan: true };
let snapshot, plan;
ipcMain.handle('storage:scan', () => { globalThis.__uiTest.scans++; snapshot = { id: 'scan-' + globalThis.__uiTest.scans, createdAt: Date.now(), durationMs: 1, apps, items: globalThis.__uiTest.stress ? [...Array.from({ length: 3000 }, (_, n) => ({ ...items[4], id: 'stress-' + n, name: 'stress-' + n, path: '/fixture/Library/Application Support/stress-' + n, bytes: 4000 - n, latestChange: Date.UTC(2025, 0, n + 2) })), { ...items[4], id: 'protected-stress', name: 'protected-stress', path: '/fixture/Library/Application Support/protected-stress', protected: true, latestChange: null }, ...Array.from({ length: 2000 }, (_, n) => ({ ...items[6], id: 'related-' + n }))] : items.filter(i => !i.id.startsWith('orphan') || globalThis.__uiTest.orphan), skipped: globalThis.__uiTest.stress ? Array.from({ length: 2000 }, (_, n) => ({ path: '/fixture/denied/' + n, reason: 'Fixture denial' })) : [], roots: ['/fixture'] }; return snapshot; });
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
  const dragStrip = await page.locator('.window-drag-strip').evaluate((element) => ({
    region: getComputedStyle(element).getPropertyValue('-webkit-app-region'),
    top: element.getBoundingClientRect().top,
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height
  }))
  expect(dragStrip).toMatchObject({ region: 'drag', top: 0, height: 44 })
  expect(dragStrip.width).toBe(await page.evaluate(() => window.innerWidth))
  await checkAppearance('dark', 'empty', [])
  await page.getByRole('button', { name: 'Scan this Mac', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Scan summary' })).toBeVisible()
  await expect(page.locator('.stats > div').nth(1).locator('strong')).toHaveText('75 B')
  await expect(page.locator('.stats > div').nth(2).locator('strong')).toHaveText('170 B')
  await expect(page.locator('.stats > div')).toHaveCount(4)
  await expect(page.locator('.stats > div').nth(3).locator('strong')).toHaveText('60 B')
  const alphaRow = page.locator('.apps-table tbody > tr').first()
  await expect(alphaRow.locator('td').nth(2)).toContainText('165 B')
  await expect(alphaRow.locator('td').nth(2)).toContainText('1 possible related path · 90 B')
  await expect(alphaRow.locator('td').nth(3)).toContainText('265 B')
  await expect(alphaRow.locator('td').nth(3)).toContainText('175 B without possible related')
  await checkAppearance('dark', 'apps', ['.stats', '.table-wrap'])
  await checkAppearance('light', 'apps', ['.stats', '.table-wrap'])
  await checkAppearance('dark', 'apps', ['.stats', '.table-wrap'])
  await expect(page.getByRole('button', { name: 'Details for Alpha', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Details for Alpha', exact: true }).click()
  await expect(page.locator('.expanded-content')).toContainText('Possible related paths')
  await expect(page.locator('.expanded-content')).toContainText(
    '/fixture/Library/Application Support/Alpha'
  )
  await expect(page.locator('.expanded-content')).toContainText('Ownership unconfirmed')
  await page.getByRole('button', { name: 'Details for Alpha', exact: true }).click()
  await page.getByRole('button', { name: 'Review removal', exact: true }).first().click()
  let dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('checkbox')).toHaveCount(4)
  await expect(dialog).toContainText('Possible related data · ownership unconfirmed')
  await expect(dialog).toContainText('/fixture/Library/Application Support/Alpha')
  await expect(dialog.getByRole('checkbox').first()).toBeChecked()
  await expect(dialog.getByRole('checkbox').nth(1)).not.toBeChecked()
  await expect(dialog.getByRole('checkbox').nth(2)).not.toBeChecked()
  const possiblePath = dialog.getByRole('checkbox', {
    name: 'Include /fixture/Library/Application Support/Alpha'
  })
  await expect(possiblePath).toBeEnabled()
  await expect(possiblePath).not.toBeChecked()
  await dialog.getByRole('checkbox').nth(1).check()
  await dialog.getByRole('checkbox').nth(2).check()
  await possiblePath.check()
  await checkAppearance('dark', 'review', ['.modal', '.review-choice'])
  await checkAppearance('light', 'review', ['.modal', '.review-choice'])
  await expect(dialog.getByRole('checkbox').nth(1)).toBeChecked()
  await expect(dialog.getByRole('checkbox').nth(2)).toBeChecked()
  await expect(possiblePath).toBeChecked()
  await checkAppearance('dark', 'review', ['.modal', '.review-choice'])
  await dialog.getByRole('button', { name: 'Review selected paths' }).click()
  await expect(page.getByRole('heading', { name: 'Confirm move to Trash' })).toBeVisible()
  expect(await dialog.locator('.path-item').count()).toBe(4)
  const request = await electronApp.evaluate(() => globalThis.__uiTest.requests[0])
  expect(request).toEqual({
    scanId: 'scan-1',
    appId: 'alpha',
    itemIds: ['bundle', 'cache', 'data', 'related']
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
  await expect(page.locator('.leftover-title > strong')).toHaveText('60 B')
  await expect(page.locator('.leftover-title')).toContainText('2 paths')
  const newestGroupDate = await page.evaluate(() =>
    new Date(Date.UTC(2025, 0, 4, 12)).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    })
  )
  await expect(page.locator('.group-categories')).toContainText(newestGroupDate)
  await checkAppearance('dark', 'leftovers', ['.leftover-list'])
  await checkAppearance('light', 'leftovers', ['.leftover-list'])
  await checkAppearance('dark', 'leftovers', ['.leftover-list'])
  await page.getByRole('button', { name: 'Details for orphan' }).click()
  await expect(page.locator('.group-path')).toHaveCount(2)
  await expect(page.locator('.group-path')).toContainText([
    '/fixture/Library/Application Support/orphan',
    '/fixture/Library/Preferences/orphan'
  ])
  await page.getByRole('textbox', { name: 'Search leftovers' }).fill('Preferences/orphan')
  await expect(page.locator('article.leftover')).toHaveCount(1)
  await expect(page.locator('.leftover-title > strong')).toHaveText('60 B')
  await expect(page.locator('.group-path')).toHaveCount(2)
  await page.getByRole('textbox', { name: 'Search leftovers' }).fill('')
  await page.getByRole('checkbox', { name: 'Select /fixture/Library/Preferences/orphan' }).check()
  await expect(
    page.getByRole('checkbox', { name: 'Select all selectable orphan paths' })
  ).toHaveJSProperty('indeterminate', true)
  await page.getByRole('checkbox', { name: 'Select all selectable orphan paths' }).check()
  await expect(page.locator('.selection-bar')).toContainText('2 selected · 60 B')
  await page.getByRole('button', { name: 'Review selected items' }).click()
  await expect(page.getByRole('heading', { name: 'Confirm move to Trash' })).toBeVisible()
  await expect(dialog.locator('.path-item')).toHaveCount(2)
  await page.screenshot({ path: join(output, 'fixture-confirmation.png') })
  await dialog.getByRole('button', { name: 'Confirm move to Trash' }).click()
  await expect(page.getByRole('region', { name: 'Removal outcomes' })).toContainText(
    'Moved to Trash'
  )
  await expect(page.locator('article.leftover')).toHaveCount(0)
  expect(await electronApp.evaluate(() => globalThis.__uiTest.scans)).toBe(3)
  expect(await electronApp.evaluate(() => globalThis.__uiTest.confirmations)).toBe(2)
  await expect(page.locator('.stats > div').nth(3).locator('strong')).toHaveText('0 B')
  // A large fixture catches whole-list remounts and expensive selection renders.
  await electronApp.evaluate(() => {
    globalThis.__uiTest.stress = true
  })
  await page.getByRole('button', { name: 'Rescan', exact: true }).click()
  await expect(page.locator('article.leftover')).toHaveCount(3001)
  const sortLeftovers = page.getByRole('combobox', { name: 'Sort leftovers' })
  await expect(sortLeftovers).toHaveValue('size-desc')
  await sortLeftovers.selectOption('size-asc')
  await expect(page.locator('article.leftover').first()).toContainText('protected-stress')
  await sortLeftovers.selectOption('age-asc')
  await expect(page.locator('article.leftover').first()).toContainText('stress-0')
  await expect(page.locator('article.leftover').last()).toContainText('protected-stress')
  await sortLeftovers.selectOption('age-desc')
  await expect(page.locator('article.leftover').first()).toContainText('stress-2999')
  await expect(page.locator('article.leftover').last()).toContainText('protected-stress')
  await sortLeftovers.selectOption('size-desc')
  await expect(page.locator('article.leftover').first()).toContainText('stress-0')
  const leftoverTotal = await page.locator('.stats > div').nth(3).locator('strong').textContent()
  await expect(page.locator('.stats > div').nth(3).locator('small')).toContainText('3,001 paths')
  await expect(page.locator('.shared .path-item')).toHaveCount(0)
  await expect(page.locator('.skipped-list')).toHaveCount(0)
  const selectableFilter = page.getByRole('button', { name: 'Selectable only' })
  await selectableFilter.click()
  await expect(selectableFilter).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('article.leftover')).toHaveCount(3000)
  await expect(page.locator('article.leftover input:disabled')).toHaveCount(0)
  await expect(page.locator('.shared')).toHaveCount(0)
  await expect(page.locator('.stats > div').nth(3).locator('strong')).toHaveText(leftoverTotal)
  await selectableFilter.click()
  await expect(selectableFilter).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('article.leftover')).toHaveCount(3001)
  const disabled = page.locator('input[type="checkbox"]:disabled')
  await expect(disabled).toHaveCount(1)
  for (const theme of ['light', 'dark']) {
    await electronApp.evaluate(({ nativeTheme }, theme) => {
      nativeTheme.themeSource = theme
    }, theme)
    const styles = await page.evaluate(() => {
      const disabled = getComputedStyle(document.querySelector('input[type="checkbox"]:disabled'))
      const enabled = getComputedStyle(document.querySelector('input[type="checkbox"]:enabled'))
      return {
        disabled: {
          border: disabled.borderStyle,
          fill: disabled.backgroundImage,
          cursor: disabled.cursor
        },
        enabled: { border: enabled.borderStyle, fill: enabled.backgroundImage }
      }
    })
    expect(styles.disabled.border).toBe('dashed')
    expect(styles.disabled.fill).toContain('repeating-linear-gradient')
    expect(styles.disabled.cursor).toBe('not-allowed')
    expect(styles.enabled.border).toBe('solid')
    expect(styles.enabled.fill).toBe('none')
  }
  const selectionPaintMs = await page.evaluate(async () => {
    const inputs = [...document.querySelectorAll('article.leftover input:enabled')].slice(0, 6)
    const unchangedRow = inputs[5].closest('article')
    const times = []
    for (const input of inputs) {
      input.scrollIntoView({ block: 'center' })
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const start = performance.now()
      input.click()
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      if (!input.checked || !input.isConnected) throw new Error('Selection remounted or failed')
      times.push(performance.now() - start)
    }
    if (unchangedRow !== inputs[5].closest('article')) throw new Error('Unchanged row was replaced')
    return times
  })
  expect(Math.max(...selectionPaintMs)).toBeLessThan(250)
  await expect(page.locator('.selection-bar')).toContainText('6 selected')
  await selectableFilter.click()
  await expect(page.locator('article.leftover')).toHaveCount(3000)
  await expect(page.locator('.selection-bar')).toContainText('6 selected')
  await selectableFilter.click()
  // Search must preserve selections and closed sections must reveal their data on demand.
  await page.getByRole('textbox', { name: 'Search leftovers' }).fill('stress-0')
  await expect(page.locator('article.leftover')).toHaveCount(1)
  await expect(page.locator('.stats > div').nth(3).locator('strong')).toHaveText(leftoverTotal)
  await expect(page.getByRole('checkbox')).toBeChecked()
  await page.getByRole('textbox', { name: 'Search leftovers' }).fill('')
  await expect(page.locator('article.leftover')).toHaveCount(3001)
  await page.locator('.skipped summary').click()
  await expect(page.locator('.skipped-list > div')).toHaveCount(2000)
  await page.locator('.skipped summary').click()
  await expect(page.locator('.skipped-list')).toHaveCount(0)
  expect(errors).toEqual([])
  const report = {
    passed: [
      'app bundle selected; all data unchecked by default',
      'possible related paths offered unchecked in their app review and included only by choice',
      'possible associations excluded from leftovers and counted once in the scan summary',
      'separate cache and settings choices',
      'review lists all selected paths before confirmation',
      'renderer submits IDs only',
      'bundle failure / skipped data outcomes displayed',
      'automatic rescan after confirmation',
      'running-app rejection displayed',
      'leftover explicit selection / confirmation',
      'same-name leftovers grouped with combined size and individual path controls',
      'leftovers sort by size and latest observed change with unknown ages last',
      'successful fixture removal outcome displayed',
      'refresh clears removed leftover',
      'native light/dark appearance changes propagate live across both tabs and dialogs',
      'native dark controls and themed surfaces',
      'theme changes preserve removal selections',
      'full-width draggable top strip',
      'disabled checkboxes have distinct patterns in light and dark mode',
      '3000-row selections paint within 250ms and preserve row identity',
      'closed related/skipped sections mount contents only when opened',
      'search preserves selected leftovers',
      'leftover summary includes protected data, ignores search and selection, and refreshes after removal'
    ],
    selectionPaintMs,
    realUserDataTrashed: false,
    rendererErrors: errors
  }
  await writeFile(join(output, 'fixture-report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  if (electronApp) await electronApp.close()
  await rm(temporary, { recursive: true, force: true })
}
