import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
  stat
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { matchOwnership } from '../src/main/ownership'
import {
  createMacPlatform,
  parseSpotlightDate,
  processBelongsToBundle,
  type Platform
} from '../src/main/platform'
import { scan, measure, type ScanConfig } from '../src/main/scanner'
import { RemovalService } from '../src/main/removal'

let root: string, config: ScanConfig, platform: Platform
async function file(path: string, text = 'data') {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
  return path
}
async function bundle(name = 'Acme', id = 'dev.acme.Editor', system = false) {
  const path = join(system ? config.systemRoots[0]! : config.appRoots[0]!, `${name}.app`)
  await file(join(path, 'Contents/fixture.json'), JSON.stringify({ bundleId: id, name }))
  await file(join(path, 'Contents/MacOS/app'), 'disposable app')
  return path
}
async function data(name = 'dev.acme.Editor', text = 'local data', category = 'support') {
  const location = config.dataRoots.find((entry) => entry.category === category)!
  return file(join(location.path, name, 'nested/file'), text)
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'macstodian-test-')))
  config = {
    appRoots: [
      join(root, 'Applications'),
      join(root, 'UserApps'),
      join(root, 'System/Applications')
    ],
    systemRoots: [join(root, 'System/Applications')],
    dataRoots: [
      { path: join(root, 'Library/Application Support'), category: 'support' },
      { path: join(root, 'Library/Caches'), category: 'cache' },
      { path: join(root, 'Library/Preferences'), category: 'preferences' },
      { path: join(root, 'Library/Logs'), category: 'logs' },
      { path: join(root, 'Library/Saved Application State'), category: 'savedState' }
    ]
  }
  await Promise.all(
    [...config.appRoots, ...config.dataRoots.map((entry) => entry.path)].map((path) =>
      mkdir(path, { recursive: true })
    )
  )
  platform = {
    readBundleInfo: async (path) => {
      try {
        return JSON.parse(await readFile(join(path, 'Contents/fixture.json'), 'utf8'))
      } catch {
        return { bundleId: null, name: null }
      }
    },
    lastOpened: async () => null,
    isRunning: vi.fn(async () => false)
  }
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

describe('scanner and conservative ownership', () => {
  it('recurses through application folders and stops at bundles', async () => {
    await bundle()
    await bundle('Built in', 'com.apple.fixture', true)
    await file(
      join(config.appRoots[0]!, 'Utilities/Nested.app/Contents/fixture.json'),
      JSON.stringify({ bundleId: 'dev.nested', name: 'Nested' })
    )
    await file(
      join(config.appRoots[0]!, 'Acme.app/Contents/Hidden.app/Contents/fixture.json'),
      '{}'
    )
    const result = await scan(config, platform)
    expect(result.view.apps.map((app) => app.name).sort()).toEqual(['Acme', 'Built in', 'Nested'])
    expect(result.view.apps.find((app) => app.name === 'Built in')?.protected).toBe(true)
  })
  it('reserves confirmed ownership for exact IDs / audited aliases and protects name suggestions', async () => {
    await bundle('Acme')
    await bundle('Visual Studio Code', 'com.microsoft.VSCode')
    const { view } = await scan(config, platform)
    expect(matchOwnership('dev.acme.Editor.plist', 'preferences', view.apps).confidence).toBe(
      'exact'
    )
    expect(matchOwnership('Code', 'support', view.apps).confidence).toBe('alias')
    expect(matchOwnership('Acme', 'support', view.apps)).toMatchObject({
      confidence: 'related',
      protected: true,
      ownerIds: [view.apps.find((app) => app.name === 'Acme')!.id]
    })
    expect(matchOwnership('data', 'support', view.apps)).toMatchObject({
      confidence: 'uncertain',
      protected: true,
      ownerIds: []
    })
    expect(matchOwnership('dev.acme.Editor.extra', 'cache', view.apps)).toMatchObject({
      confidence: 'related',
      protected: true
    })
    expect(matchOwnership('com.apple.finder.plist', 'preferences', view.apps)).toMatchObject({
      protected: true,
      confidence: 'uncertain'
    })
    expect(matchOwnership('.GlobalPreferences.plist', 'preferences', view.apps)).toMatchObject({
      protected: true,
      confidence: 'uncertain'
    })
  })
  it('uses metadata and filename words adaptively, including channel suffixes', async () => {
    const path = await bundle('BambuStudio', 'com.bambulab.bambu-studio')
    await file(
      join(path, 'Contents/fixture.json'),
      JSON.stringify({
        bundleId: 'com.bambulab.bambu-studio',
        name: 'Bambu Studio',
        names: ['Bambu Studio', 'Bambu']
      })
    )
    await data('BambuStudio')
    await data('Bambu Studio')
    await data('Bambu')
    await data('BambuStudioBeta')
    const { view } = await scan(config, platform),
      app = view.apps[0]!
    expect(app.relatedItemIds).toHaveLength(4)
    expect(app.dataItemIds).toEqual([])
    expect(app.dataBytes).toBe(0)
    expect(app.totalBytes).toBe(app.appBytes)
    expect(app.dataLastChanged).toBeNull()
    expect(view.items.find((item) => item.name === 'BambuStudioBeta')).toMatchObject({
      ownerIds: [app.id],
      confidence: 'related',
      protected: true
    })
  })
  it('keeps duplicate names as multiple protected suggestions and unreadable identities unassociated', async () => {
    await bundle('One', 'dev.one')
    await bundle('Two', 'dev.two')
    await file(join(config.appRoots[0]!, 'Broken.app/file'))
    const { view } = await scan(config, platform)
    for (const app of view.apps.filter((app) => app.bundleId)) app.ownershipNames = ['Same Name']
    expect(matchOwnership('Same Name', 'logs', view.apps)).toMatchObject({
      confidence: 'related',
      protected: true,
      ownerIds: expect.arrayContaining(view.apps.filter((app) => app.bundleId).map((app) => app.id))
    })
    expect(matchOwnership('Broken', 'support', view.apps).ownerIds).toEqual([])
    for (const name of ['data', 'electron', 'CEF']) {
      view.apps[0]!.ownershipNames = [name]
      expect(matchOwnership(name, 'support', view.apps)).toMatchObject({
        ownerIds: [],
        confidence: 'uncertain',
        protected: true
      })
    }
  })
  it('suggests only complete identifier boundaries and the most specific installed owner', async () => {
    await bundle()
    await bundle('Helper', 'dev.acme.Editor.helper')
    const { view } = await scan(config, platform)
    const helper = view.apps.find((app) => app.name === 'Helper')!
    for (const name of ['dev.acme.Editor.ShipIt', 'dev.acme.Editor.extra'])
      expect(matchOwnership(name, 'cache', view.apps)).toMatchObject({
        confidence: 'related',
        protected: true
      })
    expect(
      matchOwnership('dev.acme.Editor.helper.settings.plist', 'preferences', view.apps).ownerIds
    ).toEqual([helper.id])
    expect(
      matchOwnership('dev.acme.Editor_stats.sqlite3-wal', 'preferences', view.apps).confidence
    ).toBe('related')
    for (const name of [
      'dev.acme.EditorBeta',
      'dev.acme.Edit',
      'dev.acme.Other',
      'not-dev.acme.Editor',
      'dev.acme.Editor_stats.txt'
    ])
      expect(matchOwnership(name, 'preferences', view.apps).ownerIds).toEqual([])
    expect(matchOwnership('dev.acme.Editor.plist', 'preferences', view.apps).confidence).toBe(
      'exact'
    )
  })
  it('indexes embedded app/XPC/extension IDs, shares duplicate helpers, and skips linked metadata trees', async () => {
    const first = await bundle(),
      second = await bundle('Other', 'dev.other')
    for (const [path, suffix, id] of [
      [first, 'Contents/Helpers/Worker.app', 'dev.worker'],
      [first, 'Contents/XPCServices/Service.xpc', 'dev.service'],
      [first, 'Contents/PlugIns/Extension.appex', 'dev.extension'],
      [second, 'Contents/Helpers/Worker.app', 'dev.worker']
    ])
      await file(
        join(path!, suffix!, 'Contents/fixture.json'),
        JSON.stringify({ bundleId: id, name: id })
      )
    const external = join(root, 'Outside.app')
    await file(join(external, 'Contents/fixture.json'), JSON.stringify({ bundleId: 'dev.linked' }))
    await symlink(external, join(first, 'Contents/Helpers/Linked.app'))
    for (const name of ['dev.worker', 'dev.service', 'dev.extension', 'dev.linked'])
      await data(name)
    const { view } = await scan(config, platform)
    expect(view.apps).toHaveLength(2)
    expect(view.items.find((item) => item.name === 'dev.worker')).toMatchObject({
      confidence: 'shared',
      protected: true,
      ownerIds: expect.any(Array)
    })
    expect(view.items.find((item) => item.name === 'dev.worker')!.ownerIds).toHaveLength(2)
    expect(view.items.find((item) => item.name === 'dev.service')).toMatchObject({
      confidence: 'related',
      protected: true
    })
    expect(view.items.find((item) => item.name === 'dev.extension')).toMatchObject({
      confidence: 'related',
      protected: true
    })
    expect(view.items.find((item) => item.name === 'dev.linked')!.ownerIds).toEqual([])
    expect(view.apps.every((app) => app.dataBytes === 0)).toBe(true)
  })
  it('associates observed product names conservatively and treats vendor folders as shared', async () => {
    await bundle('Docker', 'com.docker.docker')
    await bundle('Brave Browser', 'com.brave.Browser')
    await data('Docker Desktop')
    await data('BraveSoftware')
    const { view } = await scan(config, platform)
    expect(view.items.find((item) => item.name === 'Docker Desktop')).toMatchObject({
      confidence: 'related',
      protected: true
    })
    expect(view.items.find((item) => item.name === 'BraveSoftware')).toMatchObject({
      confidence: 'shared',
      protected: true
    })
    expect(view.apps.every((app) => app.totalBytes === app.appBytes)).toBe(true)
    expect(matchOwnership('Docker Desktop', 'support', []).ownerIds).toEqual([])
    expect(matchOwnership('BraveSoftware', 'support', [])).toMatchObject({
      confidence: 'shared',
      protected: true,
      ownerIds: []
    })
  })
  it('infers unseen versions, helper names, punctuation, and product ID names', async () => {
    await bundle('Audio Hijack', 'com.rogueamoeba.audiohijack')
    await bundle('Farrago', 'com.rogueamoeba.farrago')
    await bundle('Nebula Studio', 'io.newvendor.nebulastudio')
    await bundle('Minecraft Launcher', 'com.mojang.minecraftlauncher')
    const { view } = await scan(config, platform)
    for (const [folder, owner] of [
      ['Audio Hijack 27', 'Audio Hijack'],
      ['audio-hijack-28-beta', 'Audio Hijack'],
      ['Farrago 9', 'Farrago'],
      ['NebulaStudioHelper', 'Nebula Studio'],
      ['nebula_studio-v3', 'Nebula Studio'],
      ['minecraft', 'Minecraft Launcher']
    ]) {
      expect(matchOwnership(folder!, 'support', view.apps)).toMatchObject({
        ownerIds: [view.apps.find((app) => app.name === owner)!.id],
        confidence: 'related',
        protected: true
      })
    }
    for (const folder of ['Audio Hijacker', 'Nebula Studios', 'Not Nebula Studio', 'Studio'])
      expect(matchOwnership(folder, 'support', view.apps).ownerIds).toEqual([])
    expect(matchOwnership('NewVendor', 'support', view.apps)).toMatchObject({
      confidence: 'shared',
      protected: true,
      ownerIds: [view.apps.find((app) => app.name === 'Nebula Studio')!.id]
    })
  })
  it('prefers exact channel names and the longest app-name prefix', async () => {
    await bundle('Nebula', 'dev.vendor.nebula')
    await bundle('Nebula Studio', 'dev.vendor.studio')
    await bundle('Nebula Studio Beta', 'dev.vendor.studiobeta')
    const { view } = await scan(config, platform)
    for (const folder of ['Nebula Studio Beta', 'Nebula Studio Beta 4'])
      expect(matchOwnership(folder, 'support', view.apps).ownerIds).toEqual([
        view.apps.find((app) => app.name === 'Nebula Studio Beta')!.id
      ])
    expect(matchOwnership('Nebula Studio 4', 'support', view.apps).ownerIds).toEqual([
      view.apps.find((app) => app.name === 'Nebula Studio')!.id
    ])
  })
  it('counts a shared vendor directory once, outside all individual app totals', async () => {
    await bundle('One', 'com.microsoft.One')
    await bundle('Two', 'com.microsoft.Two')
    await data('Microsoft', '1234567890')
    const { view } = await scan(config, platform)
    const shared = view.items.filter((item) => item.confidence === 'shared')
    expect(shared).toHaveLength(1)
    expect(shared[0]?.bytes).toBe(10)
    expect(shared[0]?.protected).toBe(true)
    for (const app of view.apps) {
      expect(app.dataBytes).toBe(0)
      expect(app.sharedItemIds).toEqual([shared[0]!.id])
      expect(app.totalBytes).toBe(app.appBytes)
    }
  })
  it('treats duplicate installed bundle IDs as shared owners', async () => {
    await bundle('One')
    await bundle('Two')
    await data()
    const result = await scan(config, platform)
    const shared = result.view.items.find((item) => item.category === 'support')!
    expect(shared).toMatchObject({ confidence: 'shared', protected: true })
    expect(shared.ownerIds).toHaveLength(2)
    expect(result.view.apps.every((app) => app.dataBytes === 0)).toBe(true)
  })
  it('includes system apps in ownership matching and protects their data', async () => {
    await bundle('System', 'com.apple.fixture', true)
    await data('com.apple.fixture')
    const result = await scan(config, platform)
    expect(result.view.items.find((item) => item.category === 'support')).toMatchObject({
      protected: true,
      confidence: 'exact'
    })
    expect(result.view.apps[0]?.dataBytes).toBe(10)
  })
  it('observes nested file modifications even when parent timestamps are restored; excludes cache/log dates', async () => {
    await bundle()
    const nested = await data()
    const owner = dirname(dirname(nested)),
      parentStamp = await stat(owner)
    const first = new Date('2024-01-01T00:00:00Z'),
      changed = new Date('2025-05-06T00:00:00Z'),
      cacheDate = new Date('2026-09-01T00:00:00Z')
    await utimes(nested, first, first)
    const before = await scan(config, platform)
    await writeFile(nested, 'modified')
    await utimes(nested, changed, changed)
    const cache = await file(join(owner, 'Caches/ignored'), 'cache')
    await utimes(cache, cacheDate, cacheDate)
    const log = await data('dev.acme.Editor', 'logs', 'logs')
    await utimes(log, cacheDate, cacheDate)
    await utimes(owner, parentStamp.atime, parentStamp.mtime)
    const after = await scan(config, platform)
    expect(before.view.apps[0]?.dataLastChanged).toBe(first.getTime())
    expect(after.view.apps[0]?.dataLastChanged).toBe(changed.getTime())
    expect(after.view.apps[0]?.lastOpened).toBeNull()
    expect(Math.abs((await stat(owner)).mtimeMs - parentStamp.mtimeMs)).toBeLessThan(1)
  })
  it('scans only configured Library roots and skips symlinks without following them', async () => {
    await data('Unknown')
    const outside = await file(join(root, 'outside/secret'), 'secret')
    await symlink(dirname(outside), join(config.dataRoots[0]!.path, 'linked'))
    await symlink(outside, join(config.dataRoots[0]!.path, 'Unknown/nested/link'))
    const result = await scan(config, platform)
    expect(result.view.items.map((item) => item.name)).toEqual(['Unknown'])
    expect(result.view.items[0]?.bytes).toBe(10)
    expect(result.view.items[0]?.skippedSymlinks).toBe(1)
    expect(result.view.skipped.filter((entry) => entry.reason.includes('Symlink'))).toHaveLength(2)
  })
  it('reports missing roots and unreadable bundle metadata rather than claiming a complete scan', async () => {
    await file(join(config.appRoots[0]!, 'Broken.app/file'))
    config.dataRoots.push({ path: join(root, 'unavailable'), category: 'support' })
    const result = await scan(config, platform)
    expect(result.view.apps[0]).toMatchObject({ protected: true, partial: true, bundleId: null })
    expect(result.view.skipped.some((entry) => entry.path.endsWith('unavailable'))).toBe(true)
    expect(result.view.skipped.some((entry) => entry.path.endsWith('Info.plist'))).toBe(true)
  })
  it('reports denied traversal as partial with skipped-location details', async () => {
    const path = await file(join(root, 'denied/file'))
    const skipped: string[] = []
    await chmod(dirname(path), 0)
    try {
      const measured = await measure(dirname(path), 'support', (_path, reason) =>
        skipped.push(reason)
      )
      expect(measured.partial).toBe(true)
      expect(skipped.join(' ')).toMatch(/EACCES|EPERM/)
    } finally {
      await chmod(dirname(path), 0o700)
    }
  })
})

describe('macOS metadata and running checks', () => {
  it('retains both bundle names for ownership suggestions', async () => {
    const mac = createMacPlatform(async () => ({
      stdout: JSON.stringify({
        CFBundleIdentifier: 'dev.example',
        CFBundleDisplayName: 'Example Display',
        CFBundleName: 'Example'
      })
    }))
    expect(await mac.readBundleInfo('/Applications/Example.app')).toEqual({
      bundleId: 'dev.example',
      name: 'Example Display',
      names: ['Example Display', 'Example']
    })
  })
  it('uses the exact mdls last-used field and handles null, unreadable, and invalid metadata as Unknown', async () => {
    const run = vi.fn(async () => ({ stdout: '(null)' }))
    const mac = createMacPlatform(run)
    expect(await mac.lastOpened('/Applications/Test.app')).toBeNull()
    expect(run).toHaveBeenCalledWith(
      '/usr/bin/mdls',
      ['-raw', '-name', 'kMDItemLastUsedDate', '/Applications/Test.app'],
      { timeout: 5000 }
    )
    run.mockRejectedValueOnce(new Error('permission denied'))
    expect(await mac.lastOpened('/unreadable')).toBeNull()
    expect(parseSpotlightDate('garbage')).toBeNull()
    expect(parseSpotlightDate('123')).toBeNull()
    expect(parseSpotlightDate('2025-01-02 12:34:56 +0000')).toBe(Date.UTC(2025, 0, 2, 12, 34, 56))
  })
  it('matches executable paths on a bundle boundary, not names or command arguments', () => {
    expect(
      processBelongsToBundle('/Applications/Acme.app/Contents/MacOS/Acme', '/Applications/Acme.app')
    ).toBe(true)
    expect(
      processBelongsToBundle(
        '/Applications/Acme.app.extra/Contents/MacOS/App',
        '/Applications/Acme.app'
      )
    ).toBe(false)
    expect(
      processBelongsToBundle('/bin/echo /Applications/Acme.app/file', '/Applications/Acme.app')
    ).toBe(false)
  })
  it('detects NSWorkspace apps and surviving helpers, and fails closed on unavailable process checks', async () => {
    const mac = createMacPlatform(async (command) => ({
      stdout: command.endsWith('osascript') ? '["/Applications/Acme.app"]' : ''
    }))
    expect(await mac.isRunning('/Applications/Acme.app')).toBe(true)
    const helper = createMacPlatform(async (command) => ({
      stdout: command.endsWith('osascript')
        ? '[]'
        : '/Applications/Acme.app/Contents/Helpers/worker'
    }))
    expect(await helper.isRunning('/Applications/Acme.app')).toBe(true)
    const broken = createMacPlatform(async () => {
      throw new Error('ps denied')
    })
    await expect(broken.isRunning('/Applications/Acme.app')).rejects.toThrow('ps denied')
  })
})

describe('removal review, confirmation and revalidation', () => {
  it('rejects related paths in app and leftover reviews, even if a protected flag is lost', async () => {
    await bundle()
    await data('Acme')
    const snapshot = await scan(config, platform),
      app = snapshot.view.apps[0]!
    const related = snapshot.view.items.find((item) => item.name === 'Acme')!
    expect(app.relatedItemIds).toEqual([related.id])
    related.protected = false
    const trash = vi.fn(),
      service = new RemovalService(config, platform, trash)
    service.setSnapshot(snapshot)
    for (const appId of [undefined, app.id])
      await expect(
        service.review({ scanId: snapshot.view.id, itemIds: [related.id], appId })
      ).rejects.toThrow('Protected')
    expect(trash).not.toHaveBeenCalled()
  })
  async function setup() {
    const appPath = await bundle()
    await data()
    const snapshot = await scan(config, platform)
    const app = snapshot.view.apps[0]!,
      trash = vi.fn(async (_path: string) => {})
    const service = new RemovalService(config, platform, trash)
    service.setSnapshot(snapshot)
    const request = {
      scanId: snapshot.view.id,
      appId: app.id,
      itemIds: [app.bundleItemId, ...app.dataItemIds]
    }
    return { appPath, snapshot, app, trash, service, request }
  }
  it('requires review plus explicit confirmation; resolves IDs, lists all paths, and trashes the bundle first', async () => {
    const { service, trash, request, appPath } = await setup()
    const plan = await service.review({ ...request, itemIds: [...request.itemIds].reverse() })
    expect(trash).not.toHaveBeenCalled()
    expect(plan.items).toHaveLength(2)
    expect(plan.totalBytes).toBe(plan.items.reduce((total, item) => total + item.bytes, 0))
    const results = await service.confirm(plan.id)
    expect(results.map((result) => result.status)).toEqual(['trashed', 'trashed'])
    expect(trash.mock.calls[0]?.[0]).toBe(appPath)
    await expect(service.confirm(plan.id)).rejects.toThrow('expired')
    await expect(service.review(request)).rejects.toThrow('Stale')
  })
  it('stops before all app data if trashing the bundle fails', async () => {
    const { service, trash, request } = await setup()
    trash.mockRejectedValueOnce(new Error('Trash denied'))
    const plan = await service.review(request),
      results = await service.confirm(plan.id)
    expect(trash).toHaveBeenCalledTimes(1)
    expect(results.map((result) => result.status)).toEqual(['failed', 'skipped'])
  })
  it('supports explicit leftover selection using disposable fixtures and injected Trash', async () => {
    await data('orphan')
    const snapshot = await scan(config, platform),
      trash = vi.fn(async () => {})
    const service = new RemovalService(config, platform, trash)
    service.setSnapshot(snapshot)
    const plan = await service.review({
      scanId: snapshot.view.id,
      itemIds: [snapshot.view.items[0]!.id]
    })
    expect(plan.appName).toBeNull()
    expect(trash).not.toHaveBeenCalled()
    expect((await service.confirm(plan.id))[0]?.status).toBe('trashed')
    expect(trash).toHaveBeenCalledOnce()
  })
  it('rejects arbitrary paths, unknown IDs, duplicates, empty requests, and old scan IDs', async () => {
    const { service, request } = await setup()
    for (const itemIds of [[], ['/tmp/arbitrary'], [request.itemIds[0]!, request.itemIds[0]!]])
      await expect(service.review({ ...request, itemIds })).rejects.toThrow()
    await expect(service.review({ ...request, scanId: 'old' })).rejects.toThrow('Stale')
    await expect(service.confirm('unreviewed')).rejects.toThrow('expired')
  })
  it('invalidates reviewed plans on rescan and rejects expired plans', async () => {
    const { service, request, snapshot } = await setup()
    const first = await service.review(request)
    service.setSnapshot(snapshot)
    await expect(service.confirm(first.id)).rejects.toThrow('expired')
    const second = await service.review(request)
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 301000)
    await expect(service.confirm(second.id)).rejects.toThrow('expired')
  })
  it('rejects a changed nested file even when the top directory identity stays the same', async () => {
    const { service, request, trash } = await setup(),
      plan = await service.review(request)
    await data('dev.acme.Editor', 'changed since the review')
    await expect(service.confirm(plan.id)).rejects.toThrow('changed since scanning')
    expect(trash).not.toHaveBeenCalled()
  })
  it('rejects target replacement, including a symlink, between review and confirmation', async () => {
    const { service, request, appPath, trash } = await setup(),
      plan = await service.review(request)
    await rename(appPath, `${appPath}.original`)
    await symlink(`${appPath}.original`, appPath)
    await expect(service.confirm(plan.id)).rejects.toThrow('Symlink')
    expect(trash).not.toHaveBeenCalled()
  })
  it('rejects a symlinked ancestor introduced after review', async () => {
    const { service, request, trash } = await setup(),
      plan = await service.review(request)
    const directory = config.dataRoots[0]!.path
    await rename(directory, `${directory}-original`)
    await symlink(`${directory}-original`, directory)
    await expect(service.confirm(plan.id)).rejects.toThrow('Symlink')
    expect(trash).not.toHaveBeenCalled()
  })
  it('rejects out-of-scope paths even if a malicious internal record were supplied', async () => {
    const { service, request, snapshot, trash } = await setup()
    snapshot.records.get(request.itemIds[1]!)!.view.path = join(root, 'outside')
    await expect(service.review(request)).rejects.toThrow('outside')
    expect(trash).not.toHaveBeenCalled()
  })
  it('rejects protected system apps, shared data, and partial items', async () => {
    await bundle('System', 'com.apple.fixture', true)
    await data('Microsoft')
    const snapshot = await scan(config, platform),
      service = new RemovalService(config, platform, vi.fn()),
      app = snapshot.view.apps[0]!
    service.setSnapshot(snapshot)
    await expect(
      service.review({ scanId: snapshot.view.id, itemIds: [app.bundleItemId], appId: app.id })
    ).rejects.toThrow('Protected')
    const shared = snapshot.view.items.find((item) => item.confidence === 'shared')!
    await expect(
      service.review({ scanId: snapshot.view.id, itemIds: [shared.id] })
    ).rejects.toThrow('Protected')
    const { service: other, request, snapshot: another } = await setup()
    another.records.get(request.itemIds[1]!)!.view.partial = true
    await expect(other.review(request)).rejects.toThrow('incomplete')
  })
  it('checks running apps at review AND confirmation, including data-only removal', async () => {
    const { service, request, trash } = await setup()
    vi.mocked(platform.isRunning).mockResolvedValueOnce(true)
    await expect(service.review(request)).rejects.toThrow('Quit Acme')
    const plan = await service.review({ ...request, itemIds: [request.itemIds[1]!] })
    vi.mocked(platform.isRunning).mockResolvedValue(true)
    await expect(service.confirm(plan.id)).rejects.toThrow('Quit Acme')
    expect(trash).not.toHaveBeenCalled()
  })
  it('catches a target change after preflight and reports remaining outcomes independently', async () => {
    const { service, request, trash, snapshot } = await setup()
    const dataPath = snapshot.records.get(request.itemIds[1]!)!.view.path
    trash.mockImplementationOnce(async () => {
      await file(join(dataPath, 'new-file'), 'changed during trash')
    })
    const plan = await service.review(request),
      results = await service.confirm(plan.id)
    expect(results.map((result) => result.status)).toEqual(['trashed', 'failed'])
    expect(trash).toHaveBeenCalledOnce()
  })
  it('stops if an app starts after preflight and leaves all selected data untouched', async () => {
    const { service, request, trash } = await setup()
    const plan = await service.review(request)
    vi.mocked(platform.isRunning).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const results = await service.confirm(plan.id)
    expect(results.map((result) => result.status)).toEqual(['failed', 'skipped'])
    expect(results[0]?.message).toContain('Quit Acme')
    expect(trash).not.toHaveBeenCalled()
  })
  it('rejects data of an installed owner outside that app review', async () => {
    const { service, request } = await setup()
    await expect(
      service.review({ scanId: request.scanId, itemIds: [request.itemIds[1]!] })
    ).rejects.toThrow('reviewed with its app')
  })
  it('validates Show in Finder against scan IDs and current identity', async () => {
    const { service, snapshot, app, appPath } = await setup()
    expect(await service.reveal(snapshot.view.id, app.bundleItemId)).toBe(appPath)
    await expect(service.reveal('old', app.bundleItemId)).rejects.toThrow('Stale')
    await rename(appPath, `${appPath}.old`)
    await mkdir(appPath)
    await expect(service.reveal(snapshot.view.id, app.bundleItemId)).rejects.toThrow('changed')
  })
})
