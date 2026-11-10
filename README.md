# Macstodian

A local-only macOS storage inspector built with Electron, React, and TypeScript. Apps and Possible leftovers share one asynchronous, read-only scanner. Removal always requires selection, review, and explicit confirmation.

The summary shows application bundles, confirmed matched data, shared/possible related data, and all possible leftover bytes (including protected and uncertain paths). Search, the Selectable only filter, and selection do not change these scan-wide totals. App table data and total sizes also show possible related paths; muted details identify their contribution and the confirmed total. These display estimates do not change what can be selected for removal.

The Leftovers list groups paths with the same name into one row and shows their combined size. Expand a group to inspect its locations or select paths individually. Group selection includes only eligible paths; protected and incomplete paths stay unavailable.

Appearance follows macOS automatically, including changes between Light and Dark Mode while the app is open.

## Install and run

Node **24.16.0** is pinned in `.nvmrc`; Yarn **4.9.2** is pinned in `package.json`.

```sh
source "$HOME/.nvm/nvm.sh"
nvm install
nvm use
corepack enable
corepack yarn install --immutable
corepack yarn dev
```

Use Yarn, not npm. After enabling Corepack, `yarn` is equivalent to `corepack yarn`. The project uses the node-modules linker and a committed `yarn.lock`.

TypeScript is pinned to **5.9.3** for Yarn compatibility. The scoped `extract-zip/yauzl` resolution to **3.3.1** fixes [silent Electron extraction failure on Node 24.16.0](https://github.com/nodejs/node/issues/63487). To repair an older incomplete install, run `corepack yarn rebuild electron`. A working installation includes `node_modules/electron/path.txt` and its executable. Windows-only electron-builder peer warnings do not affect this macOS app.

If your terminal inherits `ELECTRON_RUN_AS_NODE=1`, unset it when launching: `env -u ELECTRON_RUN_AS_NODE corepack yarn dev`.

## Validate and package

```sh
corepack yarn test          # temporary-fixture tests with mocked Trash
corepack yarn typecheck
corepack yarn build         # type check and production bundles
corepack yarn start         # launch the production build
corepack yarn test:ui       # Electron UI tests with fixture IPC; no real Trash
corepack yarn verify:mac    # production Electron; real read-only macOS scan
corepack yarn format:check
corepack yarn package       # local unsigned .app under release/mac-arm64 (or mac)
corepack yarn dist          # local unsigned DMG under release/
```

`verify:mac` requires a logged-in macOS desktop session. It checks both tabs, progress, sorting, search, expanded paths, review defaults, and the leftover confirmation screen. It never confirms removal, and a development guard disables Trash. Screenshots and reports go to `verification/` (gitignored). Fixture UI tests separately exercise confirmation, failures, per-item outcomes, running-app rejection, and automatic refresh.

Local packaging is unsigned. Distribution requires your own signing identity, notarization, and release process.

## Scope and limitations

- Apps are discovered recursively in `/Applications`, `~/Applications`, and `/System/Applications`, stopping at bundles. Packages are measured as opaque native aggregates, without indexing their contents or reporting internal symlinks as exclusions. System apps participate in matching and are protected.
- Data scanning covers only direct children of `~/Library/{Application Support,Caches,Preferences,Logs,Saved Application State}`, measured recursively. Containers, Group Containers, `/Library`, services, and arbitrary disk locations are outside scope.
- Confirmed ownership uses exact bundle IDs. Product names come from installed bundle metadata, with no product/vendor alias tables. Adaptive product-name rules, installer/helper/version suffixes, inferred vendor namespaces, and identifiers extending an installed ID produce **possible related paths**, protected from removal and excluded from confirmed totals. Their bytes appear in the app table as labeled estimates. Shared/vendor/system data is protected and counted once. **Possible leftovers** means neither an installed owner nor a possible association was identified; files may still be useful. Generic names remain uncertain.
- **Last opened** uses only Spotlight `kMDItemLastUsedDate`; missing/unreadable values are **Unknown**. **Data last changed** uses the newest nested regular-file mtime, excluding caches/logs. Background processes can modify data.
- Denied access, missing locations, and skipped symlinks are reported. Incomplete targets cannot be removed. Sizes use logical file lengths for Library data and native apparent bytes for opaque packages; APFS clones, compression, sparse files, metadata, snapshots, and hard links across items can affect actual usage and recovered space.
- Data starts unchecked. Main resolves IDs and rechecks identity, scope, metadata fingerprints, symlinks, and running apps before Trash. Bundle failure stops data removal. Reviews expire and rescans invalidate old IDs. OS path-based Trash cannot make validation and mutation atomic against hostile path replacement.
- Production uses Electron `shell.trashItem()`. Storage becomes available after Trash is emptied. Known vendor uninstallers are suggested for components outside scope.

All filesystem access stays in main behind a typed, sandboxed preload. Navigation, new windows, permissions, and external network requests are blocked. No telemetry or uploads.

See [scan and removal details](docs/scan-behavior.md) for accounting rules, race limitations, and vendor guidance sources.
See [matching investigation](docs/adaptive-matching-findings.md) for the local scan findings and remaining opportunities.
