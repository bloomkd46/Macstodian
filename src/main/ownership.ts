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
// Observed product/legacy names. These are suggestions, never removal-authorizing aliases.
// Keep beta/version/channel names explicit: resemblance alone must not swallow another app's data.
export const RELATED_ALIASES = [
  { name: 'Audio Hijack 4', ids: ['com.rogueamoeba.audiohijack'] },
  { name: 'Farrago 2', ids: ['com.rogueamoeba.farrago'] },
  { name: 'Docker Desktop', ids: ['com.docker.docker'] },
  { name: 'com.docker.install', ids: ['com.docker.docker'] },
  { name: 'Codex', ids: ['com.openai.codex'] },
  { name: 'ChatGPT', ids: ['com.openai.chat', 'com.openai.codex'] },
  { name: 'ChatGPTHelper', ids: ['com.openai.chat', 'com.openai.codex'] },
  { name: 'Last.fm', ids: ['fm.last.Scrobbler'] },
  { name: 'fm.last', ids: ['fm.last.Scrobbler'] },
  { name: 'fm.last.Last.fm Scrobbler', ids: ['fm.last.Scrobbler'] },
  { name: 'minecraft', ids: ['com.mojang.minecraftlauncher'] },
  { name: 'ElectricSheep', ids: ['org.elecricsheep.ElectricSheep.app'] },
  { name: 'balena-etcher', ids: ['io.balena.etcher'] },
  { name: 'anker-charging-manager', ids: ['com.anker.120f.chargingmanager'] },
  { name: 't3code-v2', ids: ['com.t3tools.t3code'] },
  { name: 'copilot', ids: ['com.github.githubapp'] },
  { name: 'nanoleaf-updater', ids: ['me.nanoleaf.desktop-app'] },
  { name: 'org.raspberrypi.Imager', ids: ['org.raspberrypi.imagingutility'] },
  { name: 'com.4kdownload.4K Video Downloader+', ids: ['com.openmedia.4kvideodownloaderplus'] }
] as const
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
  const relatedAliases = RELATED_ALIASES.filter(
    (entry) => entry.name.toLowerCase() === key.toLowerCase()
  )
  const named = apps.filter(
    (app) =>
      app.bundleId &&
      ([app.name, basename(app.path).replace(/\.app$/i, ''), ...(app.ownershipNames ?? [])].some(
        (name) => name.toLowerCase() === key.toLowerCase()
      ) ||
        relatedAliases.some((entry) =>
          entry.ids.some((id) => id.toLowerCase() === app.bundleId?.toLowerCase())
        ))
  )
  if (named.length)
    return {
      ownerIds: named.map((app) => app.id),
      confidence: 'related',
      reason: `Possible relation by exact name or known product alias (${key}): ${named.map((app) => app.name).join(', ')}. A name does not prove ownership; protected and excluded from app totals.`,
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
    reason: 'No installed owner or possible relation identified by bundle metadata or known names.',
    protected: false
  }
}
