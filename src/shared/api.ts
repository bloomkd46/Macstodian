export type Category = 'bundle' | 'support' | 'cache' | 'preferences' | 'logs' | 'savedState'
export type Confidence = 'exact' | 'alias' | 'related' | 'uncertain' | 'unmatched' | 'shared'

export interface ScanItem {
  id: string
  path: string
  name: string
  category: Category
  bytes: number
  latestChange: number | null
  partial: boolean
  skippedSymlinks: number
  confidence: Confidence
  ownerIds: string[]
  reason: string
  protected: boolean
}
export interface InstalledApp {
  id: string
  name: string
  bundleId: string | null
  path: string
  bundleItemId: string
  dataItemIds: string[]
  sharedItemIds: string[]
  relatedItemIds: string[]
  ownershipNames?: string[]
  helperBundleIds?: string[]
  appBytes: number
  dataBytes: number
  totalBytes: number
  lastOpened: number | null
  dataLastChanged: number | null
  partial: boolean
  protected: boolean
  uninstaller: string | null
}
export interface SkippedLocation {
  path: string
  reason: string
}
export interface ScanSnapshot {
  id: string
  createdAt: number
  durationMs: number
  apps: InstalledApp[]
  items: ScanItem[]
  skipped: SkippedLocation[]
  roots: string[]
}
export interface ScanProgress {
  phase: 'discovering' | 'measuring' | 'complete'
  currentPath: string
  completed: number
  files: number
  skipped: number
}
export interface ReviewRequest {
  scanId: string
  itemIds: string[]
  appId?: string
}
export interface RemovalPlan {
  id: string
  items: ScanItem[]
  totalBytes: number
  appName: string | null
  expiresAt: number
}
export interface RemovalResult {
  itemId: string
  path: string
  status: 'trashed' | 'failed' | 'skipped'
  message: string
}
export interface MacstodianAPI {
  scan(): Promise<ScanSnapshot>
  onProgress(callback: (progress: ScanProgress) => void): () => void
  review(request: ReviewRequest): Promise<RemovalPlan>
  confirm(planId: string): Promise<RemovalResult[]>
  reveal(request: { scanId: string; itemId: string }): Promise<void>
}
