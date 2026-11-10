import type { InstalledApp, Category, Confidence } from '../shared/api'

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
  'com.apple.sharedfilelist'
]
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
  'containers'
])
const SYSTEM_NAMES = new Set(['.globalpreferences', 'nsglobaldomain', 'loginwindow', '.ds_store'])

export function matchOwnership(
  name: string,
  category: Category,
  apps: InstalledApp[]
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
    const owners = apps.filter(
      (app) =>
        app.bundleId?.toLowerCase().startsWith(`com.${vendor}.`) ||
        (vendor === 'mozilla' && app.bundleId?.startsWith('org.mozilla.'))
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
  if (key.toLowerCase().startsWith('com.apple.'))
    return {
      ownerIds: [],
      confidence: 'uncertain',
      reason:
        'Apple system identifier without an identified installed owner; protected from removal.',
      protected: true
    }
  const similar = apps.filter((app) => app.name.toLowerCase() === key.toLowerCase())
  if (GENERIC_NAMES.has(key.toLowerCase()) || similar.length)
    return {
      ownerIds: [],
      confidence: 'uncertain',
      reason: similar.length
        ? `Name resembles ${similar.map((app) => app.name).join(', ')}, but a display name does not prove ownership.`
        : 'Generic name; ownership is uncertain. Review its contents before removal.',
      protected: GENERIC_NAMES.has(key.toLowerCase())
    }
  return {
    ownerIds: [],
    confidence: 'unmatched',
    reason: 'No installed owner identified by exact bundle ID or an audited alias.',
    protected: false
  }
}
