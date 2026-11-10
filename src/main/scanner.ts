import { lstat, readdir } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import type {
  Category,
  InstalledApp,
  ScanItem,
  ScanProgress,
  ScanSnapshot,
  SkippedLocation
} from '../shared/api'
import { matchOwnership } from './ownership'
import type { Platform } from './platform'
import { vendorUninstaller } from './uninstallers'

export interface ScanConfig {
  appRoots: string[]
  dataRoots: { path: string; category: Exclude<Category, 'bundle'> }[]
  systemRoots: string[]
}
export const defaultConfig = (): ScanConfig => ({
  appRoots: ['/Applications', join(homedir(), 'Applications'), '/System/Applications'],
  systemRoots: ['/System/Applications'],
  dataRoots: [
    { path: join(homedir(), 'Library/Application Support'), category: 'support' },
    { path: join(homedir(), 'Library/Caches'), category: 'cache' },
    { path: join(homedir(), 'Library/Preferences'), category: 'preferences' },
    { path: join(homedir(), 'Library/Logs'), category: 'logs' },
    { path: join(homedir(), 'Library/Saved Application State'), category: 'savedState' }
  ]
})
export interface Identity {
  dev: number
  ino: number
  birthtimeMs: number
}
export interface InternalItem {
  view: ScanItem
  identity: Identity
  fingerprint: string
  dataLastChanged: number | null
}
export interface InternalScan {
  view: ScanSnapshot
  records: Map<string, InternalItem>
}
export interface Measurement {
  bytes: number
  latestChange: number | null
  latestObservedChange: number | null
  partial: boolean
  skippedSymlinks: number
  fingerprint: string
}
export const identity = (stat: Stats): Identity => ({
  dev: stat.dev,
  ino: stat.ino,
  birthtimeMs: stat.birthtimeMs
})
export const sameIdentity = (a: Identity, b: Identity): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs
export const isInside = (path: string, root: string): boolean => {
  const rel = relative(resolve(root), resolve(path))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep)
}
export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
const isVolatileDirectory = (name: string) =>
  /^(caches?|logs?|gpucache|code cache|cachestorage|shadercache|dawncache|grshadercache)$/i.test(
    name
  )

// lstat every ancestor, including the target. realpath alone would silently accept links.
export async function assertNoSymlink(path: string): Promise<Stats> {
  const target = resolve(path)
  const components: string[] = []
  for (let current = target; dirname(current) !== current; current = dirname(current))
    components.unshift(current)
  let stat: Stats | undefined
  for (const component of components) {
    stat = await lstat(component)
    if (stat.isSymbolicLink()) throw new Error(`Symlinked path is not allowed: ${component}`)
  }
  if (!stat) throw new Error('Filesystem roots are not valid scan items.')
  return stat
}

export async function measure(
  path: string,
  category: Category,
  skip: (path: string, reason: string) => void = () => {},
  tick: () => void = () => {}
): Promise<Measurement> {
  let bytes = 0,
    latestChange: number | null = null,
    latestObservedChange: number | null = null,
    partial = false,
    skippedSymlinks = 0
  const hash = createHash('sha256')
  const seen = new Set<string>()
  const stack = [
    { path, excludeDate: category === 'cache' || category === 'logs' || category === 'bundle' }
  ]
  await assertNoSymlink(path)
  while (stack.length) {
    const entry = stack.pop()!
    try {
      const stat = await lstat(entry.path)
      hash.update(
        JSON.stringify([
          relative(path, entry.path),
          stat.dev,
          stat.ino,
          stat.mode,
          stat.size,
          stat.mtimeMs,
          stat.ctimeMs,
          stat.birthtimeMs
        ])
      )
      if (stat.isSymbolicLink()) {
        skippedSymlinks++
        skip(entry.path, 'Symlink skipped; never followed.')
        continue
      }
      if (stat.isFile()) {
        const inodeKey = `${stat.dev}:${stat.ino}`
        if (!seen.has(inodeKey)) {
          bytes += stat.size
          seen.add(inodeKey)
        }
        latestObservedChange = Math.max(latestObservedChange ?? -Infinity, stat.mtimeMs)
        if (!entry.excludeDate) latestChange = Math.max(latestChange ?? -Infinity, stat.mtimeMs)
        tick()
      } else if (stat.isDirectory()) {
        await assertNoSymlink(entry.path)
        const entries = (await readdir(entry.path)).sort().reverse()
        const after = await lstat(entry.path)
        if (
          !after.isDirectory() ||
          !sameIdentity(identity(stat), identity(after)) ||
          stat.mtimeMs !== after.mtimeMs ||
          stat.ctimeMs !== after.ctimeMs
        )
          throw new Error('Directory changed during traversal; rescan required.')
        for (const name of entries)
          stack.push({
            path: join(entry.path, name),
            excludeDate: entry.excludeDate || isVolatileDirectory(name)
          })
      } else {
        partial = true
        skip(entry.path, 'Special filesystem entry skipped.')
      }
    } catch (error) {
      partial = true
      skip(entry.path, errorText(error))
      hash.update(`unreadable:${entry.path}`)
    }
  }
  return {
    bytes,
    latestChange,
    latestObservedChange,
    partial,
    skippedSymlinks,
    fingerprint: hash.digest('hex')
  }
}

async function mapLimited<T>(values: T[], fn: (value: T) => Promise<void>): Promise<void> {
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(4, values.length) }, async () => {
      while (cursor < values.length) {
        const value = values[cursor++]
        if (value !== undefined) await fn(value)
      }
    })
  )
}

export async function scan(
  config: ScanConfig,
  platform: Platform,
  progress: (event: ScanProgress) => void = () => {}
): Promise<InternalScan> {
  const started = Date.now(),
    scanId = randomUUID()
  const skipped: SkippedLocation[] = [],
    apps: InstalledApp[] = [],
    records = new Map<string, InternalItem>()
  let completed = 0,
    files = 0,
    lastProgress = 0
  const report = (phase: ScanProgress['phase'], path: string, force = false) => {
    if (force || Date.now() - lastProgress > 100) {
      lastProgress = Date.now()
      progress({ phase, currentPath: path, completed, files, skipped: skipped.length })
    }
  }
  const skip = (path: string, reason: string) => {
    skipped.push({ path, reason })
  }
  const appPaths = new Set<string>()
  report('discovering', config.appRoots[0] ?? '', true)
  for (const root of config.appRoots) {
    const stack = [root]
    try {
      await assertNoSymlink(root)
    } catch (error) {
      skip(root, errorText(error))
      continue
    }
    while (stack.length) {
      const path = stack.pop()!
      report('discovering', path)
      try {
        await assertNoSymlink(path)
        const entries = await readdir(path, { withFileTypes: true })
        for (const entry of entries) {
          const child = join(path, entry.name)
          if (entry.isSymbolicLink()) {
            skip(child, 'Symlink skipped; never followed.')
            continue
          }
          if (!entry.isDirectory()) continue
          if (entry.name.toLowerCase().endsWith('.app')) appPaths.add(child)
          else stack.push(child)
        }
      } catch (error) {
        skip(path, errorText(error))
      }
    }
  }
  await mapLimited([...appPaths].sort(), async (path) => {
    try {
      const stat = await assertNoSymlink(path)
      const [info, lastOpened] = await Promise.all([
        platform.readBundleInfo(path),
        platform.lastOpened(path)
      ])
      const protectedApp =
        !info.bundleId ||
        config.systemRoots.some((root) => isInside(path, root)) ||
        !!info.bundleId?.startsWith('com.apple.')
      if (!info.bundleId)
        skip(
          join(path, 'Contents/Info.plist'),
          'Bundle identity unreadable or missing; app protected and ownership unavailable.'
        )
      const measurement = await measure(path, 'bundle', skip, () => {
        files++
        report('measuring', path)
      })
      if (!sameIdentity(identity(stat), identity(await assertNoSymlink(path))))
        throw new Error('Bundle changed during scan; rescan required.')
      const appId = randomUUID(),
        bundleItemId = randomUUID()
      const item: ScanItem = {
        id: bundleItemId,
        path,
        name: basename(path),
        category: 'bundle',
        bytes: measurement.bytes,
        latestChange: null,
        partial: measurement.partial || !info.bundleId,
        skippedSymlinks: measurement.skippedSymlinks,
        confidence: 'exact',
        ownerIds: [appId],
        reason: 'Installed application bundle; measured separately from its data.',
        protected: protectedApp
      }
      records.set(item.id, {
        view: item,
        identity: identity(stat),
        fingerprint: measurement.fingerprint,
        dataLastChanged: null
      })
      const app: InstalledApp = {
        id: appId,
        name: info.name ?? basename(path, '.app'),
        bundleId: info.bundleId,
        path,
        bundleItemId,
        dataItemIds: [],
        sharedItemIds: [],
        appBytes: item.bytes,
        dataBytes: 0,
        totalBytes: item.bytes,
        lastOpened,
        dataLastChanged: null,
        partial: item.partial,
        protected: protectedApp,
        uninstaller: vendorUninstaller(info.bundleId)
      }
      apps.push(app)
      // Only known, explicit uninstaller paths; never execute a discovered script.
      if (!app.uninstaller) {
        for (const suffix of [
          'Contents/Helpers/Uninstaller.app',
          'Contents/Resources/Uninstaller.app',
          'Contents/Helpers/Uninstall.app'
        ]) {
          try {
            const helper = join(path, suffix)
            if ((await lstat(helper)).isDirectory()) {
              app.uninstaller = `This app includes a vendor uninstaller at ${helper}. Use it for a complete removal.`
              break
            }
          } catch {
            /* optional helper */
          }
        }
      }
      completed++
      report('measuring', path, true)
    } catch (error) {
      skip(path, errorText(error))
    }
  })
  const dataCandidates: { path: string; category: Exclude<Category, 'bundle'> }[] = []
  for (const root of config.dataRoots) {
    try {
      await assertNoSymlink(root.path)
      for (const entry of await readdir(root.path, { withFileTypes: true })) {
        const path = join(root.path, entry.name)
        if (entry.isSymbolicLink()) {
          skip(path, 'Symlink skipped; never followed.')
          continue
        }
        if (!entry.isDirectory() && !entry.isFile()) {
          skip(path, 'Special filesystem entry skipped.')
          continue
        }
        dataCandidates.push({ path, category: root.category })
      }
    } catch (error) {
      skip(root.path, errorText(error))
    }
  }
  await mapLimited(dataCandidates, async ({ path, category }) => {
    try {
      const stat = await assertNoSymlink(path)
      const result = await measure(path, category, skip, () => {
        files++
        report('measuring', path)
      })
      if (!sameIdentity(identity(stat), identity(await assertNoSymlink(path))))
        throw new Error('Item changed during scan; rescan required.')
      const match = matchOwnership(basename(path), category, apps)
      const item: ScanItem = {
        id: randomUUID(),
        path,
        name: basename(path),
        category,
        bytes: result.bytes,
        latestChange: result.latestObservedChange,
        partial: result.partial,
        skippedSymlinks: result.skippedSymlinks,
        ...match
      }
      records.set(item.id, {
        view: item,
        identity: identity(stat),
        fingerprint: result.fingerprint,
        dataLastChanged: result.latestChange
      })
      completed++
      report('measuring', path, true)
    } catch (error) {
      skip(path, errorText(error))
    }
  })
  for (const app of apps) {
    for (const { view: item, dataLastChanged } of records.values()) {
      if (item.category === 'bundle' || !item.ownerIds.includes(app.id)) continue
      if (item.confidence === 'shared') {
        app.sharedItemIds.push(item.id)
        continue
      }
      app.dataItemIds.push(item.id)
      app.dataBytes += item.bytes
      app.partial ||= item.partial
      if (dataLastChanged !== null)
        app.dataLastChanged = Math.max(app.dataLastChanged ?? -Infinity, dataLastChanged)
    }
    app.totalBytes = app.appBytes + app.dataBytes
  }
  apps.sort((a, b) => b.totalBytes - a.totalBytes || a.name.localeCompare(b.name))
  report('complete', '', true)
  return {
    view: {
      id: scanId,
      createdAt: Date.now(),
      durationMs: Date.now() - started,
      apps,
      items: [...records.values()].map((record) => record.view),
      skipped,
      roots: [...config.appRoots, ...config.dataRoots.map((root) => root.path)]
    },
    records
  }
}
