import type { InstalledApp, Category, Confidence } from '../shared/api'
import { basename } from 'node:path'

// These are generic data/framework terms and macOS infrastructure, not product aliases.
const RUNTIME_NAMES = new Set(['electron', 'cef'])
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
  ...RUNTIME_NAMES
])
const SYSTEM_NAMES = new Set(['.globalpreferences', 'nsglobaldomain', 'loginwindow', '.ds_store'])
const PRODUCT_ROLES = new Set(['app', 'desktop', 'launcher', 'client', 'browser'])
const UNINFORMATIVE_NAMES = new Set([
  ...GENERIC_NAMES,
  'helper',
  'updater',
  'installer',
  'uninstaller',
  'editor',
  'software',
  'service',
  'core',
  'agent',
  'renderer',
  'gpu',
  'mac',
  'macos',
  'mobile',
  'com',
  'org',
  'net'
])
const sharedInfrastructure =
  /^(?:byhost|cloudkit|(?:crash|diagnostic)(?:reporter|reports?)(?:\p{L})*|shared\p{L}*)$/u
const companySuffix = /(?:software|incorporated|corporation|company|corp|inc|llc|ltd)$/
const serviceSuffix =
  /^(?:(?:standalone|auto|background)?(?:install(?:er|ation)?|updat(?:e|er)|helper|agent|service|daemon|launcher|channel|menu|renderer|gpu|settings|preferences|config|logs?))+\d*$/

export interface OwnershipCandidate {
  name: string
  category: Category
}
interface OwnershipMatch {
  ownerIds: string[]
  confidence: Confidence
  reason: string
  protected: boolean
}
interface AppMetadata {
  app: InstalledApp
  names: string[]
  fullNames: string[]
  namespace: string | null
}
interface Vendor {
  namespace: string
  key: string
  owners: InstalledApp[]
}

const words = (value: string) =>
  value
    .normalize('NFKC')
    .replace(/\+/g, ' Plus ')
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/(\p{L})(\d+)/gu, '$1 $2')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? []
const compact = (value: string) => words(value).join('')
const genericKeys = new Set([...UNINFORMATIVE_NAMES].map(compact))
const systemKeys = new Set([...SYSTEM_NAMES].map(compact))
const usableName = (value: string) => !!compact(value) && !genericKeys.has(compact(value))
const keyFor = ({ name, category }: OwnershipCandidate) =>
  name.replace(
    category === 'preferences' ? /\.plist$/i : category === 'savedState' ? /\.savedState$/i : /$^/,
    ''
  )
// Bundle IDs have no universal TLD allowlist. Require two namespace labels and a
// product component; names alone never establish exclusive ownership.
const identifier = (value: string) => {
  const match = /^([a-z][a-z0-9-]*\.[a-z0-9][a-z0-9-]*)\.(.+)$/i.exec(
    value.replace(/^(?:system)?group\./i, '')
  )
  return match ? { namespace: match[1]!.toLowerCase(), product: match[2]! } : null
}
const namespaceVendor = (namespace: string) => compact(namespace.split('.')[1]!)
const reusableNamespace = (namespace: string) =>
  namespace !== 'com.apple' &&
  !genericKeys.has(namespaceVendor(namespace)) &&
  !/^install\d+[a-z]*$/.test(namespaceVendor(namespace))
const namePrefixLength = (value: string, names: string[], identifierSuffix = false) => {
  const normalized = compact(value)
  const boundaries = new Set(
    words(value).map((_, index, tokens) => tokens.slice(0, index + 1).join(''))
  )
  let longest = 0
  for (const name of names) {
    const base = compact(name)
    if (base.length < 3 || !normalized.startsWith(base)) continue
    if (
      boundaries.has(base) ||
      (identifierSuffix && serviceSuffix.test(normalized.slice(base.length)))
    )
      longest = Math.max(longest, base.length)
  }
  return longest
}
const completeProduct = (product: string, fullNames: string[]) =>
  product.length >= 8 &&
  fullNames.some((name) => {
    const base = compact(name)
    return (
      base === product ||
      (base.length >= 4 && [...PRODUCT_ROLES].some((role) => product === base + role))
    )
  })
const uniqueApps = (apps: InstalledApp[]) => [...new Map(apps.map((app) => [app.id, app])).values()]
const related = (owners: InstalledApp[], evidence: string): OwnershipMatch => ({
  ownerIds: uniqueApps(owners).map((app) => app.id),
  confidence: 'related',
  protected: true,
  reason: `${evidence}: ${uniqueApps(owners)
    .map((app) => app.name)
    .join(', ')}. Ownership unconfirmed.`
})
const shared = (vendors: Vendor[], evidence: string): OwnershipMatch => ({
  ownerIds: uniqueApps(vendors.flatMap((vendor) => vendor.owners)).map((app) => app.id),
  confidence: 'shared',
  protected: true,
  reason: `${evidence} (${[...new Set(vendors.map((vendor) => vendor.namespace))].join(', ')}). Vendor-family context can include other or uninstalled products; counted once, protected, and excluded from app totals.`
})

export function createOwnershipMatcher(
  apps: InstalledApp[],
  candidates: OwnershipCandidate[] = []
) {
  const metadata: AppMetadata[] = apps
    .filter((app) => app.bundleId)
    .map((app) => {
      const id = identifier(app.bundleId!)
      const fullNames = [
        ...new Set([
          app.name,
          basename(app.path).replace(/\.app$/i, ''),
          ...(app.ownershipNames ?? [])
        ])
      ].filter(usableName)
      const names = new Set(fullNames)
      if (id) {
        const domain = id.namespace.split('.').reverse().join('.')
        if (fullNames.some((name) => name.toLowerCase() === domain))
          names.add(namespaceVendor(id.namespace))
      }
      const product = app.bundleId!.split('.').at(-1)!
      if (compact(product).length >= 4 && usableName(product)) names.add(product)
      for (const name of [...names]) {
        const tokens = words(name)
        if (PRODUCT_ROLES.has(tokens.at(-1) ?? '')) names.add(tokens.slice(0, -1).join(' '))
        // Vendor-qualified names also expose a product stem within that namespace.
        if (id) {
          const vendor = namespaceVendor(id.namespace)
          const end = tokens.findIndex((_, index) => tokens.slice(0, index + 1).join('') === vendor)
          if (end >= 0) names.add(tokens.slice(end + 1).join(' '))
        }
      }
      return {
        app,
        names: [...names].filter(usableName),
        fullNames,
        namespace: id?.namespace ?? null
      }
    })
  const vendors = new Map<string, Vendor>()
  const addVendor = (namespace: string, owners: InstalledApp[] = []) => {
    if (!reusableNamespace(namespace)) return
    const prior = vendors.get(namespace)
    vendors.set(namespace, {
      namespace,
      key: namespaceVendor(namespace),
      owners: uniqueApps([...(prior?.owners ?? []), ...owners])
    })
  }
  for (const entry of metadata) if (entry.namespace) addVendor(entry.namespace, [entry.app])
  // The direct-child inventory supplies vendor evidence even when no app remains
  // installed (e.g. a plain vendor folder alongside its reverse-domain preferences).
  for (const candidate of candidates) {
    const id = identifier(keyFor(candidate))
    if (!id) continue
    const knownNamespace = metadata.some((entry) => entry.namespace === id.namespace)
    addVendor(id.namespace)
    if (knownNamespace) continue
    // Learn an alternate namespace only from a complete, distinctive product name.
    // Never spread a product match across a generic runtime's namespace.
    const product = compact(id.product)
    if (product.length < 8 || !reusableNamespace(id.namespace)) continue
    const owners = metadata.filter(({ fullNames }) => completeProduct(product, fullNames))
    if (owners.length === 1) addVendor(id.namespace, [owners[0]!.app])
  }
  const identifiers = metadata.flatMap(({ app }) =>
    [app.bundleId!, ...(app.helperBundleIds ?? [])].map((id) => ({ app, id: id.toLowerCase() }))
  )

  return (name: string, category: Category): OwnershipMatch => {
    const key = keyFor({ name, category }),
      lower = key.toLowerCase(),
      normalized = compact(key)
    if (genericKeys.has(normalized) || systemKeys.has(normalized))
      return {
        ownerIds: [],
        confidence: 'uncertain',
        protected: true,
        reason:
          'Generic, framework, or system name; ownership is uncertain and this item is protected.'
      }
    const exact = metadata
      .filter(({ app }) => app.bundleId!.toLowerCase() === lower)
      .map(({ app }) => app)
    if (exact.length)
      return {
        ownerIds: exact.map((app) => app.id),
        confidence: exact.length > 1 ? 'shared' : 'exact',
        protected: exact.length > 1 || exact.some((app) => app.protected),
        reason:
          exact.length > 1
            ? `Exact bundle ID ${key} belongs to multiple installed bundles; counted once.`
            : `Exact bundle ID: ${exact[0]!.bundleId}.`
      }
    if (sharedInfrastructure.test(normalized))
      return {
        ownerIds: [],
        confidence: 'shared',
        protected: true,
        reason: 'Shared macOS infrastructure or diagnostic directory; counted once and protected.'
      }
    const helpers = metadata.filter(({ app }) =>
      app.helperBundleIds?.some((id) => id.toLowerCase() === lower)
    )
    if (helpers.length)
      return {
        ...related(
          helpers.map(({ app }) => app),
          `Exact embedded helper ID (${key})`
        ),
        confidence: helpers.length > 1 ? 'shared' : 'related'
      }
    const extended = identifiers.filter(
      ({ id }) =>
        lower.startsWith(`${id}.`) ||
        (category === 'preferences' &&
          lower.startsWith(`${id}_`) &&
          /\.sqlite3?(?:-(?:wal|shm))?$/i.test(key))
    )
    if (extended.length) {
      const length = Math.max(...extended.map(({ id }) => id.length))
      return related(
        extended.filter(({ id }) => id.length === length).map(({ app }) => app),
        `Identifier extends a complete installed app ID (${extended.find(({ id }) => id.length === length)!.id})`
      )
    }
    const id = identifier(key)
    const vendorPrefixed = [...vendors.values()].filter(
      (vendor) => vendor.owners.length && lower.startsWith(`${vendor.key}.`)
    )
    if (vendorPrefixed.length)
      return shared(vendorPrefixed, 'Vendor-prefixed data or log name inferred from installed IDs')
    if (id) {
      if (id.namespace === 'com.apple' && sharedInfrastructure.test(compact(id.product)))
        return {
          ownerIds: [],
          confidence: 'shared',
          protected: true,
          reason: 'Shared Apple system infrastructure; counted once and protected.'
        }
      if (id.namespace === 'com.apple')
        return {
          ownerIds: [],
          confidence: 'uncertain',
          protected: true,
          reason:
            'Apple system identifier without an identified installed owner; protected from removal.'
        }
      if (RUNTIME_NAMES.has(compact(id.product)))
        return {
          ownerIds: [],
          confidence: 'uncertain',
          protected: true,
          reason:
            'Generic runtime identifier without product-specific ownership evidence; protected.'
        }
      // Prefer a product stem inside the same namespace before considering its family.
      const sameNamespace = metadata.filter((entry) => entry.namespace === id.namespace)
      const productMatches = sameNamespace.map((entry) => ({
        ...entry,
        length: namePrefixLength(id.product, entry.names, true)
      }))
      const longest = Math.max(0, ...productMatches.map(({ length }) => length))
      if (longest)
        return related(
          productMatches.filter(({ length }) => length === longest).map(({ app }) => app),
          `Product stem with a version/helper suffix in the installed namespace (${id.namespace})`
        )
      // A fully spelled product name can survive a vendor/domain change.
      const product = compact(id.product)
      const renamed = metadata.filter(({ fullNames }) => completeProduct(product, fullNames))
      if (renamed.length)
        return related(
          renamed.map(({ app }) => app),
          `Complete product name under an alternate namespace (${key})`
        )
      const vendor = vendors.get(id.namespace)
      if (vendor?.owners.length) {
        // A one-product vendor's installer/updater can be suggested directly.
        // Merely being the only app in a namespace is insufficient evidence.
        const brandApp = sameNamespace.filter(
          ({ app, fullNames }) =>
            vendor.owners.length === 1 &&
            vendor.owners[0]!.id === app.id &&
            fullNames.some((name) => compact(name) === vendor.key)
        )
        if (brandApp.length && serviceSuffix.test(product))
          return related(
            brandApp.map(({ app }) => app),
            `Installer/helper role under the app's own brand namespace (${id.namespace})`
          )
        return shared(
          [vendor],
          'Reverse-domain namespace inferred from installed apps or scanned identifiers'
        )
      }
    }
    const companyKey = normalized.replace(companySuffix, '')
    const namedCompanies = [...vendors.values()].filter(
      (vendor) =>
        lower === vendor.namespace || (companyKey !== normalized && companyKey === vendor.key)
    )
    if (namedCompanies.length)
      return shared(
        namedCompanies,
        'Vendor namespace or company-style folder inferred from scan identifiers'
      )
    const exactNames = metadata.filter(({ names }) =>
      names.some((name) => compact(name) === normalized)
    )
    if (exactNames.length)
      return related(
        exactNames.map(({ app }) => app),
        `Normalized installed product name (${key})`
      )
    const prefixes = metadata.map((entry) => ({
      ...entry,
      length: namePrefixLength(key, entry.names)
    }))
    const longest = Math.max(0, ...prefixes.map(({ length }) => length))
    if (longest)
      return related(
        prefixes.filter(({ length }) => length === longest).map(({ app }) => app),
        `App name followed by a word or version suffix (${key})`
      )
    const vendorName = normalized.replace(companySuffix, '')
    const forwardDomain = /^([a-z0-9-]+)\.([a-z][a-z0-9-]+)$/i.exec(key)
    const matchingVendors = [...vendors.values()].filter(
      (vendor) =>
        lower === vendor.namespace ||
        vendor.key === vendorName ||
        (forwardDomain &&
          vendor.namespace === `${forwardDomain[2]}.${forwardDomain[1]}`.toLowerCase()) ||
        namePrefixLength(key, [vendor.key]) > 0
    )
    if (matchingVendors.length)
      return shared(matchingVendors, 'Vendor name/domain inferred from the scan inventory')
    // A company-style suffix itself is shared-directory evidence, without an app claim.
    if (companySuffix.test(normalized) && vendorName.length >= 3)
      return {
        ownerIds: [],
        confidence: 'shared',
        protected: true,
        reason:
          'Company-style directory name without an identified installed owner; shared context only, counted once and protected.'
      }
    return {
      ownerIds: [],
      confidence: 'unmatched',
      protected: false,
      reason:
        'No installed owner or possible relation identified by bundle IDs, product-name patterns, or scanned vendor namespaces.'
    }
  }
}

export function matchOwnership(
  name: string,
  category: Category,
  apps: InstalledApp[],
  candidates: OwnershipCandidate[] = []
) {
  return createOwnershipMatcher(apps, candidates)(name, category)
}
