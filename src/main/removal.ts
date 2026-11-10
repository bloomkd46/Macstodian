import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import type { InstalledApp, RemovalPlan, RemovalResult, ReviewRequest } from '../shared/api'
import type { Platform } from './platform'
import {
  assertNoSymlink,
  errorText,
  identity,
  isInside,
  measure,
  sameIdentity,
  type InternalItem,
  type InternalScan,
  type ScanConfig
} from './scanner'

interface StoredPlan {
  view: RemovalPlan
  scanId: string
  appId?: string
  itemIds: string[]
}
export class RemovalService {
  private plans = new Map<string, StoredPlan>()
  private snapshot: InternalScan | null = null
  private busy = false
  private config: ScanConfig
  private platform: Platform
  private trash: (path: string) => Promise<void>
  constructor(config: ScanConfig, platform: Platform, trash: (path: string) => Promise<void>) {
    this.config = config
    this.platform = platform
    this.trash = trash
  }
  setSnapshot(snapshot: InternalScan | null) {
    this.snapshot = snapshot
    this.plans.clear()
  }
  private current(scanId: string): InternalScan {
    if (!this.snapshot || this.snapshot.view.id !== scanId)
      throw new Error('Stale selection. Rescan and select the items again.')
    return this.snapshot
  }
  private resolveItem(snapshot: InternalScan, id: string): InternalItem {
    const record = snapshot.records.get(id)
    if (!record) throw new Error('Unknown scan item. Rescan and select the items again.')
    return record
  }
  private allowed(record: InternalItem, app?: InstalledApp): void {
    const item = record.view,
      path = resolve(item.path)
    if (
      path !== item.path ||
      item.protected ||
      item.confidence === 'shared' ||
      item.confidence === 'related' ||
      item.ownerIds.length > 1
    )
      throw new Error(`Protected or shared item cannot be removed: ${item.path}`)
    if (item.partial)
      throw new Error(`Access was incomplete. This item cannot be safely removed: ${item.path}`)
    if (item.category === 'bundle') {
      if (
        !app ||
        app.protected ||
        app.bundleItemId !== item.id ||
        !path.endsWith('.app') ||
        !this.config.appRoots.some((root) => isInside(path, root)) ||
        this.config.systemRoots.some((root) => isInside(path, root))
      )
        throw new Error('Application is outside the removable scope.')
    } else if (
      !this.config.dataRoots.some(
        (root) => root.category === item.category && dirname(path) === resolve(root.path)
      )
    )
      throw new Error('Data path is outside the scan scope.')
    if (app) {
      if (app.protected || (item.category !== 'bundle' && !app.dataItemIds.includes(item.id)))
        throw new Error('Selection does not belong to this removable app.')
    } else if (item.ownerIds.length)
      throw new Error('Installed application data must be reviewed with its app.')
  }
  private async validate(record: InternalItem, app?: InstalledApp): Promise<void> {
    this.allowed(record, app)
    const stat = await assertNoSymlink(record.view.path)
    if ((!stat.isFile() && !stat.isDirectory()) || !sameIdentity(record.identity, identity(stat)))
      throw new Error(`Item identity changed. Rescan: ${record.view.path}`)
    const fresh = await measure(record.view.path, record.view.category)
    if (fresh.partial || fresh.fingerprint !== record.fingerprint)
      throw new Error(`Item changed since scanning. Rescan: ${record.view.path}`)
    const finalStat = await assertNoSymlink(record.view.path)
    if (!sameIdentity(record.identity, identity(finalStat)))
      throw new Error(`Item identity changed. Rescan: ${record.view.path}`)
  }
  private async validateOwner(snapshot: InternalScan, app: InstalledApp): Promise<void> {
    const bundle = this.resolveItem(snapshot, app.bundleItemId)
    const stat = await assertNoSymlink(app.path)
    if (!sameIdentity(bundle.identity, identity(stat)))
      throw new Error('Application identity changed. Rescan before removal.')
    const info = await this.platform.readBundleInfo(app.path)
    if (!info.bundleId || info.bundleId !== app.bundleId)
      throw new Error('Application bundle ID changed. Rescan before removal.')
    if (await this.platform.isRunning(app.path))
      throw new Error(`Quit ${app.name} before removing its bundle or data, then try again.`)
  }
  async review(request: ReviewRequest): Promise<RemovalPlan> {
    if (this.busy) throw new Error('A removal is already in progress.')
    if (
      !request ||
      typeof request.scanId !== 'string' ||
      !Array.isArray(request.itemIds) ||
      !request.itemIds.length ||
      request.itemIds.length > 500 ||
      request.itemIds.some((id) => typeof id !== 'string') ||
      new Set(request.itemIds).size !== request.itemIds.length ||
      (request.appId !== undefined && typeof request.appId !== 'string')
    )
      throw new Error('Select valid scan items for review.')
    const snapshot = this.current(request.scanId)
    const app = request.appId
      ? snapshot.view.apps.find((app) => app.id === request.appId)
      : undefined
    if (request.appId && !app) throw new Error('Unknown application.')
    const records = request.itemIds.map((id) => this.resolveItem(snapshot, id))
    records.forEach((record) => this.allowed(record, app))
    if (app) await this.validateOwner(snapshot, app)
    for (const record of records) await this.validate(record, app)
    this.current(request.scanId)
    if (this.busy) throw new Error('A removal is already in progress.')
    this.plans.clear()
    const view: RemovalPlan = {
      id: randomUUID(),
      items: records.map((record) => record.view),
      totalBytes: records.reduce((total, record) => total + record.view.bytes, 0),
      appName: app?.name ?? null,
      expiresAt: Date.now() + 5 * 60 * 1000
    }
    this.plans.set(view.id, {
      view,
      scanId: snapshot.view.id,
      appId: app?.id,
      itemIds: records.map((record) => record.view.id)
    })
    return view
  }
  async confirm(planId: string): Promise<RemovalResult[]> {
    if (this.busy) throw new Error('A removal is already in progress.')
    const plan = this.plans.get(planId)
    if (!plan || Date.now() > plan.view.expiresAt)
      throw new Error('Removal review expired. Review your selection again.')
    this.plans.delete(planId)
    this.busy = true
    try {
      const snapshot = this.current(plan.scanId)
      const app = snapshot.view.apps.find((app) => app.id === plan.appId)
      const records = plan.itemIds
        .map((id) => this.resolveItem(snapshot, id))
        .sort((a, b) => Number(b.view.category === 'bundle') - Number(a.view.category === 'bundle'))
      // Preflight the entire selection before any Trash operation.
      if (app) await this.validateOwner(snapshot, app)
      for (const record of records) await this.validate(record, app)
      const results: RemovalResult[] = []
      let bundleTrashed = false,
        stop = false
      for (const record of records) {
        const item = record.view
        if (stop) {
          results.push({
            itemId: item.id,
            path: item.path,
            status: 'skipped',
            message: 'App bundle could not be trashed; its data was left untouched.'
          })
          continue
        }
        try {
          // Repeat immediately before every mutation; a review is never authorization for a changed path.
          this.current(plan.scanId)
          // Recursive validation can take time. Check running state after it, close to Trash.
          await this.validate(record, app)
          if (app) {
            if (!bundleTrashed) await this.validateOwner(snapshot, app)
            else if (await this.platform.isRunning(app.path))
              throw new Error(`Quit ${app.name} before removing its data.`)
          }
          this.allowed(record, app)
          const finalStat = await assertNoSymlink(item.path)
          if (!sameIdentity(record.identity, identity(finalStat)))
            throw new Error(`Item identity changed. Rescan: ${item.path}`)
          await this.trash(item.path)
          if (item.category === 'bundle') bundleTrashed = true
          results.push({
            itemId: item.id,
            path: item.path,
            status: 'trashed',
            message: 'Moved to Trash. Storage becomes available after Trash is emptied.'
          })
        } catch (error) {
          results.push({
            itemId: item.id,
            path: item.path,
            status: 'failed',
            message: errorText(error)
          })
          if (item.category === 'bundle') stop = true
        }
      }
      // Any attempted mutation invalidates all old IDs and reviews.
      this.setSnapshot(null)
      return results
    } finally {
      this.busy = false
    }
  }
  async reveal(scanId: string, itemId: string): Promise<string> {
    const record = this.resolveItem(this.current(scanId), itemId)
    const stat = await assertNoSymlink(record.view.path)
    if (!sameIdentity(record.identity, identity(stat)))
      throw new Error('Item changed. Rescan before revealing it.')
    return record.view.path
  }
}
