import type { InstalledApp, Category, Confidence } from '../shared/api'
import { basename } from 'node:path'

// Deliberately small and exact. No substring, fuzzy, or vendor-prefix deletion matches.
// Vendor directories are always shared/protected, even if only one app is installed.
export const KNOWN_ALIASES = [
  { name: 'Code', ids: ['com.microsoft.VSCode'] },
  { name: 'Slack', ids: ['com.tinyspeck.slackmacgap'] },
  { name: 'discord', ids: ['com.hnc.Discord'] },
  { name: 'Spotify', ids: ['com.spotify.client'] },
  { name: 'Firefox', ids: ['org.mozilla.firefox'] }
] as const
export const SHARED_NAMES = [
  'Google',
  'Microsoft',
  'Adobe',
  'Autodesk',
  'Apple',
  'Mozilla',
  'CrashReporter',
  'ByHost',
  'CloudKit',
  'com.apple.sharedfilelist',
  'BraveSoftware',
  'Citrix',
  'Bitdefender',
  'Netgear',
  'OpenAI',
  '4kdownload.com',
  'Raspberry Pi'
]
const SHARED_DOMAINS: Record<string, string[]> = {
  bravesoftware: ['com.brave.'],
  citrix: ['com.citrix.'],
  bitdefender: ['com.bitdefender.', 'com.netgear.'],
  netgear: ['com.netgear.'],
  openai: ['com.openai.'],
  '4kdownload.com': ['com.openmedia.', 'com.4kdownload.'],
  'raspberry pi': ['org.raspberrypi.'],
  mozilla: ['org.mozilla.']
}
const GENERIC_NAMES = new Set([
  'data',
  'cache',
  'caches',
  'logs',
  'preferences',
  'settings',
  'support',
  'application support',
  'temp',
  'tmp',
  'shared',
  'containers',
  'electron',
  'cef'
])
const SYSTEM_NAMES = new Set(['.globalpreferences', 'nsglobaldomain', 'loginwindow', '.ds_store'])

// Compare words rather than arbitrary substrings. Camel case and punctuation are
// common differences between bundle metadata and cross-platform data directories.
const words = (value: string) =>
  value
    .normalize('NFKC')
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? []
const compact = (value: string) => words(value).join('')
const PRODUCT_ROLES = new Set(['app', 'desktop', 'launcher', 'client', 'browser'])
const usableName = (name: string) =>
  compact(name).length >= 4 &&
  !GENERIC_NAMES.has(name.toLowerCase()) &&
  !['app', 'helper', 'updater', 'client', 'desktop', 'browser', 'editor', 'software'].includes(
    compact(name)
  )

export function createOwnershipMatcher(apps: InstalledApp[]) {
  const metadata = apps
    .filter((app) => app.bundleId)
    .map((app) => {
      const parts = app.bundleId!.toLowerCase().split('.')
      const names = new Set([
        app.name,
        basename(app.path).replace(/\.app$/i, ''),
        ...(app.ownershipNames ?? [])
      ])
      // Product identifiers can retain names omitted from the display name.
      if (parts.length >= 3 && usableName(parts.at(-1)!)) names.add(parts.at(-1)!)
      for (const name of [...names]) {
        const tokens = words(name)
        if (PRODUCT_ROLES.has(tokens.at(-1) ?? '')) names.add(tokens.slice(0, -1).join(' '))
      }
      return {
        app,
        names: [...names].filter(usableName),
        namespace: parts.length >= 3 ? parts.slice(0, 2).join('.') : null,
        vendor: parts.length >= 3 ? parts[1]! : null
      }
    })
  return (name: string, category: Category) => match(name, category, apps, metadata)
}

export function matchOwnership(name: string, category: Category, apps: InstalledApp[]) {
  return createOwnershipMatcher(apps)(name, category)
}

function match(
  name: string,
  category: Category,
  apps: InstalledApp[],
  metadata: {
    app: InstalledApp
    names: string[]
    namespace: string | null
    vendor: string | null
  }[]
): { ownerIds: string[]; confidence: Confidence; reason: string; protected: boolean } {
  const key = name.replace(
    category === 'preferences' ? /\.plist$/i : category === 'savedState' ? /\.savedState$/i : /$^/,
    ''
  )
  if (GENERIC_NAMES.has(key.toLowerCase()) || SYSTEM_NAMES.has(key.toLowerCase()))
    return {
      ownerIds: [],
      confidence: 'uncertain',
      reason: 'Generic or system name; ownership is uncertain and this item is protected.',
      protected: true
    }
  const shared = SHARED_NAMES.find((alias) => alias.toLowerCase() === key.toLowerCase())
  if (shared) {
    const vendor = shared.toLowerCase()
    const domains = SHARED_DOMAINS[vendor] ?? [`com.${vendor}.`]
    const owners = apps.filter((app) =>
      domains.some((domain) => app.bundleId?.toLowerCase().startsWith(domain))
    )
    return {
      ownerIds: owners.map((app) => app.id),
      confidence: 'shared',
      reason: `Known shared or system directory (${shared}); counted once and protected.`,
      protected: true
    }
  }
  const exact = apps.filter((app) => app.bundleId?.toLowerCase() === key.toLowerCase())
  if (exact.length)
    return {
      ownerIds: exact.map((app) => app.id),
      confidence: exact.length > 1 ? 'shared' : 'exact',
      reason:
        exact.length > 1
          ? `Exact bundle ID ${key} belongs to multiple installed bundles; counted once.`
          : `Exact bundle ID: ${exact[0]!.bundleId}.`,
      protected: exact.length > 1 || exact.some((app) => app.protected)
    }
  const alias = KNOWN_ALIASES.find((entry) => entry.name.toLowerCase() === key.toLowerCase())
  if (alias) {
    const owners = apps.filter((app) =>
      alias.ids.some((id) => id.toLowerCase() === app.bundleId?.toLowerCase())
    )
    if (owners.length)
      return {
        ownerIds: owners.map((app) => app.id),
        confidence: owners.length > 1 ? 'shared' : 'alias',
        reason: `Audited alias: ${alias.name} → ${alias.ids.join(', ')}.`,
        protected: owners.length > 1 || owners.some((app) => app.protected)
      }
  }
  // Embedded app/extension/XPC identities establish a relationship, not exclusive ownership.
  // The same helper can ship in multiple products, including apps outside the scan roots.
  const helpers = apps.filter(
    (app) =>
      app.bundleId && app.helperBundleIds?.some((id) => id.toLowerCase() === key.toLowerCase())
  )
  if (helpers.length)
    return {
      ownerIds: helpers.map((app) => app.id),
      confidence: helpers.length > 1 ? 'shared' : 'related',
      reason: `Exact embedded helper bundle ID: ${key}; found inside ${helpers.map((app) => app.name).join(', ')}. Protected and excluded from app totals.`,
      protected: true
    }
  // Require a full installed ID and a separator; never match vendor prefixes or partial tokens.
  // Only suggest the most specific ID when an installed app and its helper overlap.
  const identifiers = apps
    .flatMap((app) =>
      app.bundleId
        ? [app.bundleId, ...(app.helperBundleIds ?? [])].map((id) => ({
            app,
            id: id.toLowerCase()
          }))
        : []
    )
    .filter(
      ({ id }) =>
        key.toLowerCase().startsWith(`${id}.`) ||
        (category === 'preferences' &&
          key.toLowerCase().startsWith(`${id}_`) &&
          /\.sqlite3?(?:-(?:wal|shm))?$/i.test(key))
    )
  if (identifiers.length) {
    const length = Math.max(...identifiers.map(({ id }) => id.length))
    const owners = [
      ...new Set(identifiers.filter(({ id }) => id.length === length).map(({ app }) => app))
    ]
    return {
      ownerIds: owners.map((app) => app.id),
      confidence: 'related',
      reason: `Identifier extends an installed app or embedded helper ID (${identifiers.find(({ id }) => id.length === length)!.id}). Possible helper, updater, or settings data; protected and excluded from app totals.`,
      protected: true
    }
  }
  // Exact normalized names outrank prefixes (e.g. stable versus an installed beta).
  const normalized = compact(key)
  const exactNames = metadata.filter(({ names }) =>
    names.some((name) => compact(name) === normalized)
  )
  const prefixes = metadata.flatMap(({ app, names }) =>
    names.flatMap((name) => {
      const base = compact(name)
      if (!normalized.startsWith(base)) return []
      const keyWords = words(key)
      // Require an actual word boundary; "Code" must not match "Codec".
      const boundary = keyWords.some((_, index) => keyWords.slice(0, index + 1).join('') === base)
      return boundary ? [{ app, length: base.length }] : []
    })
  )
  const longest = Math.max(0, ...prefixes.map(({ length }) => length))
  const named = exactNames.length
    ? exactNames.map(({ app }) => app)
    : [...new Set(prefixes.filter(({ length }) => length === longest).map(({ app }) => app))]
  if (named.length)
    return {
      ownerIds: named.map((app) => app.id),
      confidence: 'related',
      reason: `Possible relation by ${exactNames.length ? 'normalized product name' : 'app name followed by a word or version suffix'} (${key}): ${named.map((app) => app.name).join(', ')}. Inferred from installed bundle metadata; protected and excluded from app totals.`,
      protected: true
    }
  // Discover vendor folders from installed reverse-domain IDs, without assigning
  // a vendor's other products exclusively to the one app that happens to be installed.
  const vendors = metadata.filter(
    ({ vendor, namespace }) =>
      vendor && namespace && (normalized === compact(vendor) || key.toLowerCase() === namespace)
  )
  if (vendors.length)
    return {
      ownerIds: vendors.map(({ app }) => app.id),
      confidence: 'shared',
      reason: `Vendor name or namespace inferred from installed bundle IDs (${key}); may serve multiple products. Counted once and protected.`,
      protected: true
    }
  if (key.toLowerCase().startsWith('com.apple.'))
    return {
      ownerIds: [],
      confidence: 'uncertain',
      reason:
        'Apple system identifier without an identified installed owner; protected from removal.',
      protected: true
    }
  return {
    ownerIds: [],
    confidence: 'unmatched',
    reason:
      'No installed owner or possible relation identified by installed bundle IDs or adaptive product-name rules.',
    protected: false
  }
}
