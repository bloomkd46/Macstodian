import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AppWindow,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  FolderSearch,
  HardDrive,
  Info,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-react'
import type {
  InstalledApp,
  RemovalPlan,
  RemovalResult,
  ScanItem,
  ScanProgress,
  ScanSnapshot
} from '../../shared/api'

type SortKey = 'name' | 'appBytes' | 'dataBytes' | 'totalBytes' | 'lastOpened' | 'dataLastChanged'
type LeftoverSort = 'size-desc' | 'size-asc' | 'age-asc' | 'age-desc'
const categoryNames = {
  bundle: 'Application bundle',
  support: 'Application support',
  cache: 'Cache',
  preferences: 'Preferences',
  logs: 'Logs',
  savedState: 'Saved state'
}
const changedHelp =
  'Newest regular-file modification in matched data, excluding caches and logs (including nested cache/log folders). Background processes can modify data; this is not the last time you opened the app.'
export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4)
  return `${(bytes / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: unit ? 1 : 0 })} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`
}
const date = (stamp: number | null) =>
  stamp === null
    ? 'Unknown'
    : new Date(stamp).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      })
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
    : String(error)
const removable = (item: ScanItem) =>
  !item.protected && !item.partial && !['shared', 'related'].includes(item.confidence)
type LeftoverGroup = {
  key: string
  name: string
  items: ScanItem[]
  bytes: number
  latestChange: number | null
  selectableIds: string[]
}
const groupLeftovers = (entries: ScanItem[]): LeftoverGroup[] => {
  const groups = new Map<string, LeftoverGroup>()
  for (const item of entries) {
    const key = item.name.toLowerCase()
    let group = groups.get(key)
    if (!group) {
      group = { key, name: item.name, items: [], bytes: 0, latestChange: null, selectableIds: [] }
      groups.set(key, group)
    }
    group.items.push(item)
    group.bytes += item.bytes
    if (item.latestChange !== null)
      group.latestChange = Math.max(group.latestChange ?? -Infinity, item.latestChange)
    if (removable(item)) group.selectableIds.push(item.id)
  }
  return [...groups.values()]
}

export function App() {
  const [tab, setTab] = useState<'apps' | 'leftovers'>('apps')
  const [snapshot, setSnapshot] = useState<ScanSnapshot | null>(null)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [busy, setBusy] = useState<'scan' | 'review' | 'remove' | null>(null)
  const operation = useRef(false)
  const modalRef = useRef<HTMLElement>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [selectableOnly, setSelectableOnly] = useState(false)
  const [leftoverSort, setLeftoverSort] = useState<LeftoverSort>('size-desc')
  const [sort, setSort] = useState<{ key: SortKey; ascending: boolean }>({
    key: 'totalBytes',
    ascending: false
  })
  const [expanded, setExpanded] = useState(new Set<string>())
  const [selected, setSelected] = useState(new Set<string>())
  const [reviewApp, setReviewApp] = useState<InstalledApp | null>(null)
  const [appSelection, setAppSelection] = useState(new Set<string>())
  const [plan, setPlan] = useState<RemovalPlan | null>(null)
  const [results, setResults] = useState<RemovalResult[] | null>(null)
  const items = useMemo(() => new Map(snapshot?.items.map((item) => [item.id, item])), [snapshot])
  const relatedBytes = useMemo(
    () =>
      new Map(
        (snapshot?.apps ?? []).map((app) => [
          app.id,
          app.relatedItemIds.reduce((total, id) => total + (items.get(id)?.bytes ?? 0), 0)
        ])
      ),
    [snapshot, items]
  )
  const { shared, related, leftovers } = useMemo(() => {
    const shared: ScanItem[] = [],
      related: ScanItem[] = [],
      leftovers: ScanItem[] = []
    for (const item of snapshot?.items ?? []) {
      if (item.confidence === 'shared') shared.push(item)
      else if (item.confidence === 'related') related.push(item)
      else if (item.category !== 'bundle' && !item.ownerIds.length) leftovers.push(item)
    }
    leftovers.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
    return { shared, related, leftovers }
  }, [snapshot])
  const totals = useMemo(
    () => ({
      bundles: snapshot?.apps.reduce((total, app) => total + app.appBytes, 0) ?? 0,
      data: snapshot?.apps.reduce((total, app) => total + app.dataBytes, 0) ?? 0,
      related: sum(shared) + sum(related),
      leftovers: sum(leftovers)
    }),
    [snapshot, shared, related, leftovers]
  )
  const visibleApps = useMemo(
    () =>
      (snapshot?.apps ?? [])
        .filter((app) =>
          `${app.name} ${app.bundleId} ${app.path}`.toLowerCase().includes(query.toLowerCase())
        )
        .sort((a, b) => {
          const av =
              sort.key === 'dataBytes' || sort.key === 'totalBytes'
                ? a[sort.key] + (relatedBytes.get(a.id) ?? 0)
                : a[sort.key],
            bv =
              sort.key === 'dataBytes' || sort.key === 'totalBytes'
                ? b[sort.key] + (relatedBytes.get(b.id) ?? 0)
                : b[sort.key]
          if (av === null) return bv === null ? a.name.localeCompare(b.name) : 1
          if (bv === null) return -1
          return (
            (typeof av === 'string' && typeof bv === 'string'
              ? av.localeCompare(bv)
              : Number(av) - Number(bv)) * (sort.ascending ? 1 : -1) || a.name.localeCompare(b.name)
          )
        }),
    [snapshot, query, sort, relatedBytes]
  )
  const leftoverGroups = useMemo(() => groupLeftovers(leftovers), [leftovers])
  const displayGroups = useMemo(
    () => (selectableOnly ? groupLeftovers(leftovers.filter(removable)) : leftoverGroups),
    [leftovers, leftoverGroups, selectableOnly]
  )
  const visibleGroups = useMemo(() => {
    const search = query.toLowerCase()
    return displayGroups
      .filter(
        (group) =>
          group.name.toLowerCase().includes(search) ||
          group.items.some((item) => item.path.toLowerCase().includes(search))
      )
      .sort((a, b) => {
        if (leftoverSort.startsWith('age')) {
          if (a.latestChange === null && b.latestChange !== null) return 1
          if (b.latestChange === null && a.latestChange !== null) return -1
          if (a.latestChange !== null && b.latestChange !== null) {
            const ageOrder =
              (a.latestChange - b.latestChange) * (leftoverSort === 'age-asc' ? 1 : -1)
            if (ageOrder) return ageOrder
          }
        } else {
          const sizeOrder = (a.bytes - b.bytes) * (leftoverSort === 'size-asc' ? 1 : -1)
          if (sizeOrder) return sizeOrder
        }
        return b.bytes - a.bytes || a.name.localeCompare(b.name)
      })
  }, [displayGroups, query, leftoverSort])
  const visibleLeftoverPaths = visibleGroups.reduce((total, group) => total + group.items.length, 0)
  const toggleSelected = useCallback(
    (id: string) => setSelected((values) => toggle(values, id)),
    []
  )
  const toggleGroupSelected = useCallback((ids: string[]) => {
    setSelected((values) => {
      const next = new Set(values)
      const allSelected = ids.every((id) => next.has(id))
      for (const id of ids) {
        if (allSelected) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }, [])
  const toggleExpanded = useCallback(
    (id: string) => setExpanded((values) => toggle(values, id)),
    []
  )

  async function scanMac() {
    if (operation.current) return
    operation.current = true
    setBusy('scan')
    setError('')
    setProgress(null)
    setSelected(new Set())
    setExpanded(new Set())
    setReviewApp(null)
    setPlan(null)
    setSnapshot(null)
    const unsubscribe = window.macstodian.onProgress(setProgress)
    try {
      setSnapshot(await window.macstodian.scan())
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      unsubscribe()
      operation.current = false
      setBusy(null)
    }
  }
  const reveal = useCallback(
    async (item: ScanItem) => {
      if (!snapshot) return
      try {
        await window.macstodian.reveal({ scanId: snapshot.id, itemId: item.id })
      } catch (error) {
        setError(errorMessage(error))
      }
    },
    [snapshot]
  )
  async function makePlan(ids: Set<string>, app?: InstalledApp) {
    if (!snapshot || operation.current) return
    operation.current = true
    setBusy('review')
    setError('')
    try {
      setPlan(
        await window.macstodian.review({
          scanId: snapshot.id,
          itemIds: [...ids],
          ...(app ? { appId: app.id } : {})
        })
      )
      setReviewApp(null)
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      operation.current = false
      setBusy(null)
    }
  }
  async function confirmRemoval() {
    if (!plan || operation.current) return
    operation.current = true
    setBusy('remove')
    setError('')
    let removalError = ''
    try {
      setResults(await window.macstodian.confirm(plan.id))
    } catch (error) {
      removalError = errorMessage(error)
    } finally {
      setPlan(null)
      operation.current = false
      setBusy(null)
      await scanMac()
      if (removalError) setError(removalError)
    }
  }
  const openAppReview = useCallback(
    (app: InstalledApp) => {
      setError('')
      setReviewApp(app)
      const bundle = items.get(app.bundleItemId)
      setAppSelection(new Set(bundle && removable(bundle) ? [bundle.id] : []))
    },
    [items]
  )
  const reviewItems = reviewApp
    ? [reviewApp.bundleItemId, ...reviewApp.dataItemIds]
        .map((id) => items.get(id))
        .filter((item): item is ScanItem => !!item)
    : []
  const selectedBytes = sum(
    [...selected].map((id) => items.get(id)).filter((item): item is ScanItem => !!item)
  )
  const modal = !!reviewApp || !!plan
  useEffect(() => {
    if (!modal) return
    const previous = document.activeElement
    modalRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [modal])

  return (
    <div className="shell">
      <div className="window-drag-strip" aria-hidden="true" />
      <aside className="sidebar" inert={modal || undefined}>
        <div className="brand">
          <div className="brand-mark">
            <HardDrive size={22} />
          </div>
          <div>
            Macstodian<small>A little room to breathe.</small>
          </div>
        </div>
        <div className="nav-label">YOUR STORAGE</div>
        <nav aria-label="Storage views">
          <button
            className={tab === 'apps' ? 'active' : ''}
            onClick={() => {
              setTab('apps')
              setQuery('')
            }}
          >
            <AppWindow size={18} />
            Apps<span>{snapshot?.apps.length ?? '—'}</span>
          </button>
          <button
            className={tab === 'leftovers' ? 'active' : ''}
            onClick={() => {
              setTab('leftovers')
              setQuery('')
            }}
          >
            <FolderSearch size={18} />
            Leftovers<span>{snapshot ? leftoverGroups.length : '—'}</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <ShieldCheck size={20} />
          <strong>On your Mac. Only.</strong>
          <p>
            Local scanning. No uploads.
            <br />
            You choose what goes to Trash.
          </p>
          <div className="version">MACSTODIAN / 0.1.0</div>
        </div>
      </aside>
      <main inert={modal || undefined}>
        <header>
          <div className="eyebrow">STORAGE, WITH CONTEXT</div>
          <div className="heading-row">
            <div>
              <h1>
                {tab === 'apps' ? 'Know what takes up space.' : 'A closer look at what’s left.'}
              </h1>
              <p>
                {tab === 'apps'
                  ? 'Your applications, confirmed data, and possible related data.'
                  : 'Possible leftovers in your user Library. A clue to review, never a verdict.'}
              </p>
            </div>
            <button className="primary" disabled={!!busy} onClick={() => void scanMac()}>
              <RefreshCw size={15} className={busy === 'scan' ? 'spin' : ''} />
              {busy === 'scan' ? 'Scanning…' : snapshot ? 'Rescan' : 'Scan this Mac'}
            </button>
          </div>
        </header>
        {error && (
          <div className="notice error" role="alert">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {results && (
          <section className="notice outcomes" aria-label="Removal outcomes">
            <div>
              <strong>Removal results</strong>
              <p>Storage becomes available after Trash is emptied.</p>
              {results.map((result) => (
                <p key={result.itemId}>
                  <b>
                    {result.status === 'trashed'
                      ? 'Moved to Trash'
                      : result.status === 'failed'
                        ? 'Failed'
                        : 'Skipped'}
                  </b>{' '}
                  — <code>{result.path}</code>
                  <br />
                  {result.message}
                </p>
              ))}
            </div>
            <button aria-label="Dismiss results" onClick={() => setResults(null)}>
              <X size={16} />
            </button>
          </section>
        )}
        {busy === 'scan' && (
          <section className="scan-progress" role="status">
            <div className="progress-line">
              <RefreshCw className="spin" size={18} />
              <strong>
                {progress?.phase === 'discovering' ? 'Discovering applications' : 'Measuring files'}
              </strong>
              <span>
                {progress?.completed.toLocaleString() ?? 0} items ·{' '}
                {progress?.files.toLocaleString() ?? 0} files ·{' '}
                {progress?.skipped.toLocaleString() ?? 0} skipped
              </span>
            </div>
            <div className="indeterminate" />
            <code>{progress?.currentPath || 'Starting a read-only scan…'}</code>
            <p>You can switch tabs while scanning. Large libraries can take several minutes.</p>
          </section>
        )}
        {!snapshot && !busy && (
          <section className="empty">
            <div className="empty-icon">
              <FolderSearch size={36} />
            </div>
            <h2>A clearer picture of your storage.</h2>
            <p>
              Scan Applications and five folders in your user Library.
              <br />
              Review sizes, ownership, and dates before making a change.
            </p>
            <button className="primary" onClick={() => void scanMac()}>
              Start read-only scan
            </button>
            <span>
              <LockKeyhole size={13} /> Nothing is removed during scanning
            </span>
          </section>
        )}
        {snapshot && (
          <>
            <section className="stats" aria-label="Scan summary">
              <div>
                <span>APPLICATION BUNDLES</span>
                <strong>{formatBytes(totals.bundles)}</strong>
                <small>{snapshot.apps.length} discovered · includes protected system apps</small>
              </div>
              <div>
                <span>MATCHED APP DATA</span>
                <strong>{formatBytes(totals.data)}</strong>
                <small>Confirmed data only · possible related data shown in app rows</small>
              </div>
              <div>
                <span>SHARED & POSSIBLE RELATED DATA</span>
                <strong>{formatBytes(totals.related)}</strong>
                <small>
                  {shared.length} shared · {related.length} possible related · protected
                </small>
              </div>
              <div>
                <span>POSSIBLE LEFTOVERS</span>
                <strong>{formatBytes(totals.leftovers)}</strong>
                <small>
                  {leftovers.length.toLocaleString()} {leftovers.length === 1 ? 'path' : 'paths'} ·
                  includes protected and uncertain data
                </small>
              </div>
            </section>
            <div className="scan-note">
              <CheckCircle2 size={14} />
              <span>
                Measured file sizes · storage estimates
                {snapshot.skipped.length ? ' · partial scan' : ''}
              </span>
              <span className="scan-time">
                {new Date(snapshot.createdAt).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit'
                })}{' '}
                · {(snapshot.durationMs / 1000).toFixed(1)}s
              </span>
            </div>
            {snapshot.skipped.length > 0 && (
              <SkippedLocations key={snapshot.id} skipped={snapshot.skipped} />
            )}
            <div className="table-toolbar">
              <div>
                <h2>
                  {tab === 'apps' ? 'Applications' : 'Possible leftovers'}{' '}
                  <span>{tab === 'apps' ? visibleApps.length : visibleGroups.length}</span>
                </h2>
                {tab === 'leftovers' && (
                  <p>
                    {visibleLeftoverPaths.toLocaleString()}{' '}
                    {visibleLeftoverPaths === 1 ? 'path' : 'paths'} grouped by name. The scanner
                    could not identify an installed owner; these files may still be useful.
                  </p>
                )}
              </div>
              <div className="toolbar-controls">
                {tab === 'leftovers' && (
                  <label className="leftover-sort">
                    Sort
                    <select
                      aria-label="Sort leftovers"
                      title="Age uses the latest observed file change in each group; unknown dates appear last."
                      value={leftoverSort}
                      onChange={(event) => setLeftoverSort(event.target.value as LeftoverSort)}
                    >
                      <option value="size-desc">Size: largest first</option>
                      <option value="size-asc">Size: smallest first</option>
                      <option value="age-asc">Age: oldest first</option>
                      <option value="age-desc">Age: newest first</option>
                    </select>
                  </label>
                )}
                {tab === 'leftovers' && (
                  <button
                    className={`filter-toggle${selectableOnly ? ' active' : ''}`}
                    aria-pressed={selectableOnly}
                    onClick={() => setSelectableOnly((value) => !value)}
                  >
                    Selectable only
                  </button>
                )}
                <label className="search">
                  <Search size={15} />
                  <input
                    aria-label={tab === 'apps' ? 'Search apps' : 'Search leftovers'}
                    placeholder={tab === 'apps' ? 'Search applications' : 'Search names or paths'}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
              </div>
            </div>
            {tab === 'apps' ? (
              <div className="table-wrap">
                <table className="apps-table">
                  <thead>
                    <tr>
                      <SortHeader sort={sort} setSort={setSort} label="Application" field="name" />
                      <SortHeader
                        sort={sort}
                        setSort={setSort}
                        label="App size"
                        field="appBytes"
                        title="Native aggregate apparent size of the application package, including directory and symlink metadata. Links are never followed."
                      />
                      <SortHeader
                        sort={sort}
                        setSort={setSort}
                        label="Data size"
                        field="dataBytes"
                        title="Confirmed data plus possible related paths outside the app bundle. The possible portion is shown below each value; shared data is counted separately."
                      />
                      <SortHeader
                        sort={sort}
                        setSort={setSort}
                        label="Total size"
                        field="totalBytes"
                        title="App bundle plus confirmed and possible related data. The confirmed total is shown below each value."
                      />
                      <SortHeader
                        sort={sort}
                        setSort={setSort}
                        label="Last opened"
                        field="lastOpened"
                        title="Spotlight kMDItemLastUsedDate. Unknown if missing or unreadable."
                      />
                      <SortHeader
                        sort={sort}
                        setSort={setSort}
                        label="Data last changed"
                        field="dataLastChanged"
                        title={changedHelp}
                      />
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleApps.map((app) => (
                      <AppRows
                        key={app.id}
                        app={app}
                        open={expanded.has(app.id)}
                        busy={!!busy}
                        items={items}
                        relatedBytes={relatedBytes.get(app.id) ?? 0}
                        onToggle={toggleExpanded}
                        onReview={openAppReview}
                        onReveal={reveal}
                      />
                    ))}
                  </tbody>
                </table>
                {!visibleApps.length && (
                  <p className="no-results">No applications match this search.</p>
                )}
              </div>
            ) : (
              <>
                <div className="notice subtle">
                  <Info size={17} />
                  <span>
                    Unmatched does not mean unused. Exact bundle IDs identify owners. Possible name
                    and helper associations appear under app details and in displayed app sizes, but
                    remain protected. Generic, shared, and protected data cannot be selected.
                  </span>
                </div>
                <div className="leftover-list">
                  {visibleGroups.map((group) =>
                    group.items.length === 1 ? (
                      <LeftoverRow
                        key={group.key}
                        item={group.items[0]!}
                        checked={selected.has(group.items[0]!.id)}
                        busy={!!busy}
                        onToggle={toggleSelected}
                        onReveal={reveal}
                      />
                    ) : (
                      <LeftoverGroupRow
                        key={group.key}
                        group={group}
                        selectedCount={group.selectableIds.filter((id) => selected.has(id)).length}
                        busy={!!busy}
                        onToggle={toggleSelected}
                        onToggleGroup={toggleGroupSelected}
                        onReveal={reveal}
                        selected={selected}
                      />
                    )
                  )}
                  {!visibleGroups.length && (
                    <p className="no-results">
                      {selectableOnly
                        ? 'No selectable leftovers match this view.'
                        : 'No possible leftovers match this view.'}
                    </p>
                  )}
                </div>
                {selected.size > 0 && (
                  <div className="selection-bar">
                    <span>
                      <strong>{selected.size}</strong> selected · {formatBytes(selectedBytes)}{' '}
                      estimated
                    </span>
                    <button disabled={!!busy} onClick={() => setSelected(new Set())}>
                      Clear selection
                    </button>
                    <button
                      className="danger"
                      disabled={!!busy}
                      onClick={() => void makePlan(selected)}
                    >
                      <Trash2 size={14} />
                      Review selected items
                    </button>
                  </div>
                )}
              </>
            )}
            {related.length > 0 && (tab !== 'leftovers' || !selectableOnly) && (
              <PathList
                key={`${snapshot.id}-related`}
                title="Possible related app data"
                caption={`${formatBytes(sum(related))} · protected · counted once in scan summary`}
                items={related}
                busy={!!busy}
                onReveal={reveal}
              />
            )}
            {shared.length > 0 && (tab !== 'leftovers' || !selectableOnly) && (
              <PathList
                key={`${snapshot.id}-shared`}
                title="Shared & system data"
                caption={`${formatBytes(sum(shared))} · protected · counted once`}
                items={shared}
                busy={!!busy}
                onReveal={reveal}
              />
            )}
            <footer>
              <ShieldCheck size={14} />
              <span>Conservative matches. Explicit review. Always to Trash.</span>
              <span>Logical file sizes can differ from space recovered on APFS.</span>
            </footer>
          </>
        )}
      </main>
      {modal && (
        <div className="modal-backdrop">
          <section
            ref={modalRef}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="review-title"
            onKeyDown={(event) => {
              if (event.key === 'Tab') {
                const controls = [
                  ...(modalRef.current?.querySelectorAll<HTMLElement>(
                    'button:not(:disabled), input:not(:disabled)'
                  ) ?? [])
                ]
                const first = controls[0],
                  last = controls.at(-1)
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault()
                  last?.focus()
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault()
                  first?.focus()
                }
              }
              if (event.key === 'Escape' && !busy) {
                setReviewApp(null)
                setPlan(null)
              }
            }}
          >
            <button
              className="close"
              aria-label="Close review"
              disabled={!!busy}
              onClick={() => {
                setReviewApp(null)
                setPlan(null)
              }}
            >
              <X size={20} />
            </button>
            <div className="eyebrow">YOU’RE IN CONTROL</div>
            <h2 id="review-title">
              {plan ? 'Confirm move to Trash' : `Review removal: ${reviewApp?.name}`}
            </h2>
            <p>
              {plan
                ? 'Every path below will be moved to Trash. Check the full list before confirming.'
                : 'Choose the bundle and any data separately. Cache and settings / local data start unchecked.'}
            </p>
            {error && (
              <div role="alert" className="notice error">
                {error}
              </div>
            )}
            {reviewApp?.uninstaller && (
              <div className="notice subtle">
                <Info size={18} />
                <span>{reviewApp.uninstaller}</span>
              </div>
            )}
            <div className="notice subtle">
              <Info size={17} />
              <span>
                Quit the application before removing its bundle or data. Storage becomes available
                after Trash is emptied.
              </span>
            </div>
            <div className="review-paths">
              {plan
                ? plan.items.map((item) => (
                    <PathItem item={item} key={item.id} busy={!!busy} onReveal={reveal} />
                  ))
                : ['bundle', 'cache', 'data'].map((group) => {
                    const groupItems = reviewItems.filter((item) =>
                      group === 'bundle'
                        ? item.category === 'bundle'
                        : group === 'cache'
                          ? ['cache', 'logs'].includes(item.category)
                          : !['bundle', 'cache', 'logs'].includes(item.category)
                    )
                    return (
                      groupItems.length > 0 && (
                        <div className="review-group" key={group}>
                          <h3>
                            {group === 'bundle'
                              ? 'Application bundle'
                              : group === 'cache'
                                ? 'Caches & logs'
                                : 'Settings & local data'}
                          </h3>
                          {groupItems.map((item) => (
                            <label className="review-choice" key={item.id}>
                              <input
                                type="checkbox"
                                aria-label={`Include ${item.path}`}
                                title={
                                  !removable(item)
                                    ? 'Unavailable: this item is protected or incompletely measured.'
                                    : busy
                                      ? 'Wait for the current operation to finish.'
                                      : 'Select this item'
                                }
                                disabled={!!busy || !removable(item)}
                                checked={appSelection.has(item.id)}
                                onChange={() =>
                                  setAppSelection((values) => toggle(values, item.id))
                                }
                              />
                              <div>
                                <code>{item.path}</code>
                                <small>
                                  {categoryNames[item.category]} · {formatBytes(item.bytes)}
                                  {!removable(item) ? ' · protected / incomplete' : ''}
                                </small>
                              </div>
                            </label>
                          ))}
                        </div>
                      )
                    )
                  })}
            </div>
            <div className="modal-actions">
              <strong>
                {formatBytes(
                  plan?.totalBytes ?? sum(reviewItems.filter((item) => appSelection.has(item.id)))
                )}{' '}
                estimated
              </strong>
              <button
                disabled={!!busy}
                onClick={() => {
                  setReviewApp(null)
                  setPlan(null)
                }}
              >
                Cancel
              </button>
              {plan ? (
                <button className="danger" disabled={!!busy} onClick={() => void confirmRemoval()}>
                  <Trash2 size={14} />
                  {busy === 'remove' ? 'Moving…' : 'Confirm move to Trash'}
                </button>
              ) : (
                <button
                  className="primary"
                  disabled={!!busy || !appSelection.size}
                  onClick={() => reviewApp && void makePlan(appSelection, reviewApp)}
                >
                  {busy === 'review' ? 'Validating…' : 'Review selected paths'}
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

const sum = (entries: ScanItem[]) => entries.reduce((total, item) => total + item.bytes, 0)
const toggle = (values: Set<string>, id: string) => {
  const next = new Set(values)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}
const PathItem = memo(function PathItem({
  item,
  busy,
  onReveal
}: {
  item: ScanItem
  busy: boolean
  onReveal: (item: ScanItem) => void
}) {
  return (
    <div className="path-item">
      <div className="path-top">
        <span className="category">{categoryNames[item.category]}</span>
        <strong>
          {formatBytes(item.bytes)}
          {item.partial ? ' · partial' : ''}
        </strong>
        <button className="text-button" disabled={!!busy} onClick={() => onReveal(item)}>
          Show in Finder ↗
        </button>
      </div>
      <code>{item.path}</code>
      <p>
        {item.reason}
        {item.skippedSymlinks > 0 &&
          ` ${item.skippedSymlinks} symlink(s) excluded from measurement.`}
      </p>
    </div>
  )
})
const SortHeader = memo(function SortHeader({
  label,
  field,
  title,
  sort,
  setSort
}: {
  label: string
  field: SortKey
  title?: string
  sort: { key: SortKey; ascending: boolean }
  setSort: (sort: { key: SortKey; ascending: boolean }) => void
}) {
  return (
    <th aria-sort={sort.key === field ? (sort.ascending ? 'ascending' : 'descending') : 'none'}>
      <button
        title={title}
        onClick={() =>
          setSort({
            key: field,
            ascending: sort.key === field ? !sort.ascending : field === 'name'
          })
        }
      >
        {label}
        {sort.key === field ? (
          sort.ascending ? (
            <ArrowUp size={12} />
          ) : (
            <ArrowDown size={12} />
          )
        ) : null}
        {title && <Info size={12} />}
      </button>
    </th>
  )
})
const AppRows = memo(function AppRows({
  app,
  open,
  busy,
  items,
  relatedBytes,
  onToggle,
  onReview,
  onReveal
}: {
  app: InstalledApp
  open: boolean
  busy: boolean
  items: Map<string, ScanItem>
  relatedBytes: number
  onToggle: (id: string) => void
  onReview: (app: InstalledApp) => void
  onReveal: (item: ScanItem) => void
}) {
  return (
    <>
      <tr className={open ? 'expanded-row' : ''}>
        <td>
          <button
            className="app-name"
            aria-expanded={open}
            aria-label={`Details for ${app.name}`}
            onClick={() => onToggle(app.id)}
          >
            {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            <span className="app-icon">
              <AppWindow size={21} />
            </span>
            <span>
              <strong>{app.name}</strong>
              <small>
                {app.protected ? 'Protected · ' : ''}
                {app.partial ? 'Partial · ' : ''}
                {app.bundleId ?? 'Bundle identity unknown'}
              </small>
            </span>
          </button>
        </td>
        <td>{formatBytes(app.appBytes)}</td>
        <td>
          {formatBytes(app.dataBytes + relatedBytes)}
          {!!app.relatedItemIds?.length && (
            <div className="date">
              {app.relatedItemIds.length} possible related{' '}
              {app.relatedItemIds.length === 1 ? 'path' : 'paths'} · {formatBytes(relatedBytes)}
            </div>
          )}
        </td>
        <td className="total">
          {formatBytes(app.totalBytes + relatedBytes)}
          {!!app.relatedItemIds?.length && (
            <div className="date">{formatBytes(app.totalBytes)} without possible related</div>
          )}
        </td>
        <td className="date">{date(app.lastOpened)}</td>
        <td className="date" title={changedHelp}>
          {date(app.dataLastChanged)}
        </td>
        <td>
          {app.protected ? (
            <span className="protected">
              <LockKeyhole size={13} />
              Protected
            </span>
          ) : (
            <button className="review-button" disabled={!!busy} onClick={() => onReview(app)}>
              Review removal
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} className="expanded-content">
            <div className="app-detail-heading">
              <strong>Bundle & every matched path</strong>
              <span>
                Possible related paths are protected and shown separately in the size estimates.
              </span>
            </div>
            {[app.bundleItemId, ...app.dataItemIds, ...app.sharedItemIds].map((id) => {
              const item = items.get(id)
              return item && <PathItem key={id} item={item} busy={busy} onReveal={onReveal} />
            })}
            {!!app.relatedItemIds?.length && (
              <>
                <div className="app-detail-heading">
                  <strong>Possible related paths</strong>
                  <span>
                    Ownership unconfirmed · protected · included in displayed size estimates
                  </span>
                </div>
                {app.relatedItemIds.map((id) => {
                  const item = items.get(id)
                  return item && <PathItem key={id} item={item} busy={busy} onReveal={onReveal} />
                })}
              </>
            )}
            {app.uninstaller && <p className="vendor-note">{app.uninstaller}</p>}
          </td>
        </tr>
      )}
    </>
  )
})
const LeftoverRow = memo(function LeftoverRow({
  item,
  checked,
  busy,
  onToggle,
  onReveal
}: {
  item: ScanItem
  checked: boolean
  busy: boolean
  onToggle: (id: string) => void
  onReveal: (item: ScanItem) => void
}) {
  return (
    <article className="leftover">
      <label>
        <input
          type="checkbox"
          aria-label={`Select ${item.path}`}
          title={
            !removable(item)
              ? 'Unavailable: this item is protected or incompletely measured.'
              : busy
                ? 'Wait for the current operation to finish.'
                : 'Select this item'
          }
          disabled={!!busy || !removable(item)}
          checked={checked}
          onChange={() => onToggle(item.id)}
        />
      </label>
      <div className="leftover-body">
        <div className="leftover-title">
          <h3>{item.name}</h3>
          <span className={`badge ${item.confidence === 'uncertain' ? 'amber' : ''}`}>
            {item.confidence === 'uncertain' ? 'Uncertain owner' : 'No owner identified'}
          </span>
          {!removable(item) && <span className="badge">Protected</span>}
          <strong>
            {formatBytes(item.bytes)}
            {item.partial ? ' · partial' : ''}
          </strong>
        </div>
        <code>{item.path}</code>
        <p>
          {categoryNames[item.category]} · Latest observed file change: {date(item.latestChange)}
        </p>
        <p>{item.reason}</p>
      </div>
      <button className="text-button" disabled={!!busy} onClick={() => onReveal(item)}>
        Show in Finder ↗
      </button>
    </article>
  )
})
const LeftoverGroupRow = memo(function LeftoverGroupRow({
  group,
  selectedCount,
  selected,
  busy,
  onToggle,
  onToggleGroup,
  onReveal
}: {
  group: LeftoverGroup
  selectedCount: number
  selected: Set<string>
  busy: boolean
  onToggle: (id: string) => void
  onToggleGroup: (ids: string[]) => void
  onReveal: (item: ScanItem) => void
}) {
  const [open, setOpen] = useState(false)
  const checkbox = useRef<HTMLInputElement>(null)
  const protectedCount = group.items.length - group.selectableIds.length
  useEffect(() => {
    if (checkbox.current)
      checkbox.current.indeterminate =
        selectedCount > 0 && selectedCount < group.selectableIds.length
  }, [selectedCount, group.selectableIds.length])
  return (
    <article className="leftover grouped-leftover">
      <div className="group-header">
        <label>
          <input
            ref={checkbox}
            type="checkbox"
            aria-label={`Select all selectable ${group.name} paths`}
            title={
              !group.selectableIds.length
                ? 'Unavailable: all paths are protected or incompletely measured.'
                : 'Select all selectable paths in this group'
            }
            disabled={!!busy || !group.selectableIds.length}
            checked={group.selectableIds.length > 0 && selectedCount === group.selectableIds.length}
            onChange={() => onToggleGroup(group.selectableIds)}
          />
        </label>
        <div className="leftover-body">
          <div className="leftover-title">
            <h3>
              <button
                className="group-expand"
                aria-expanded={open}
                aria-label={`Details for ${group.name}`}
                onClick={() => setOpen((value) => !value)}
              >
                {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                {group.name}
              </button>
            </h3>
            <span className="badge">{group.items.length} paths</span>
            {group.items.some((item) => item.confidence === 'uncertain') && (
              <span className="badge amber">Uncertain owner</span>
            )}
            {protectedCount > 0 && <span className="badge">{protectedCount} protected</span>}
            <strong>{formatBytes(group.bytes)}</strong>
          </div>
          <p className="group-categories">
            {[...new Set(group.items.map((item) => categoryNames[item.category]))].join(' · ')}
            {' · '}Latest observed file change: {date(group.latestChange)}
          </p>
        </div>
      </div>
      {open && (
        <div className="group-paths">
          {group.items.map((item) => (
            <div className="group-path" key={item.id}>
              <label>
                <input
                  type="checkbox"
                  aria-label={`Select ${item.path}`}
                  title={
                    !removable(item)
                      ? 'Unavailable: this item is protected or incompletely measured.'
                      : 'Select this path'
                  }
                  disabled={!!busy || !removable(item)}
                  checked={selected.has(item.id)}
                  onChange={() => onToggle(item.id)}
                />
              </label>
              <div className="group-path-body">
                <code>{item.path}</code>
                <p>
                  {categoryNames[item.category]} · Latest observed file change:{' '}
                  {date(item.latestChange)}
                  {!removable(item) ? ' · Protected' : ''}
                </p>
                <p>{item.reason}</p>
              </div>
              <strong>
                {formatBytes(item.bytes)}
                {item.partial ? ' · partial' : ''}
              </strong>
              <button className="text-button" disabled={!!busy} onClick={() => onReveal(item)}>
                Show in Finder ↗
              </button>
            </div>
          ))}
        </div>
      )}
    </article>
  )
})
const PathList = memo(function PathList({
  title,
  caption,
  items,
  busy,
  onReveal
}: {
  title: string
  caption: string
  items: ScanItem[]
  busy: boolean
  onReveal: (item: ScanItem) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <details className="shared" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {title} <span>{caption}</span>
      </summary>
      {open &&
        items.map((item) => <PathItem key={item.id} item={item} busy={busy} onReveal={onReveal} />)}
    </details>
  )
})
const SkippedLocations = memo(function SkippedLocations({
  skipped
}: {
  skipped: ScanSnapshot['skipped']
}) {
  const [open, setOpen] = useState(false)
  return (
    <details className="skipped" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {skipped.length.toLocaleString()} skipped locations or entries · inspect scan limitations
      </summary>
      {open && (
        <>
          <p>
            Denied access, missing locations, and symlinks outside app packages are excluded. Sizes
            may be lower than actual usage. Incomplete items are protected from removal.
          </p>
          <div className="skipped-list">
            {skipped.map((entry, index) => (
              <div key={index}>
                <code>{entry.path}</code>
                <small>{entry.reason}</small>
              </div>
            ))}
          </div>
        </>
      )}
    </details>
  )
})
