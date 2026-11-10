# Macstodian

A local-only macOS storage inspector built with Electron, React, and TypeScript. Apps and Possible leftovers share one asynchronous, read-only scanner. Removal always requires selection, review, and explicit confirmation.

The summary shows application bundles, confirmed matched data, shared/possible related data, and all possible leftover bytes (including protected and uncertain paths). Search, the Selectable only filter, and selection do not change these scan-wide totals. App table data and total sizes also show possible related paths; muted details identify their contribution and the confirmed total. Uniquely linked possible paths can be added individually in that app's removal review; they start unchecked.

The Leftovers list groups paths with the same name into one row and shows their combined size. Expand a group to inspect its locations or select paths individually. Sort by combined size or the latest observed file change (oldest or newest first); unknown dates appear last. Group selection includes only eligible paths; protected and incomplete paths stay unavailable.

Appearance follows macOS automatically, including changes between Light and Dark Mode while the app is open.

## Install and run

Node **24.22.2** is pinned in `.nvmrc`; Yarn **4.18.1** is pinned in `package.json`.

```sh
source "$HOME/.nvm/nvm.sh"
nvm install
nvm use
corepack enable
corepack yarn install --immutable
corepack yarn dev
```

Use Yarn, not npm. After enabling Corepack, `yarn` is equivalent to `corepack yarn`. The project uses the node-modules linker and a committed `yarn.lock`.

TypeScript is pinned to **5.9.3** for Yarn compatibility. Electron 45 downloads its app binary through the project's `postinstall` script. To repair an incomplete install, run `corepack yarn postinstall`. A working installation includes `node_modules/electron/path.txt` and its executable. Windows-only electron-builder peer warnings do not affect this macOS app.

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

## Release unsigned builds

The [release workflow](.github/workflows/release.yml) runs on pushes to `main` and `beta`. It tests and builds on native Apple Silicon and Intel GitHub runners, creates separate unsigned DMGs and SHA-256 checksums, and publishes a GitHub release only after both builds succeed. The workflow creates the `v`-prefixed tag automatically at the pushed commit. A public release with the same version is skipped; a draft can be retried. Release notes are generated from GitHub history. The workflow uses the repository's `GITHUB_TOKEN`; no Apple Developer account or signing secrets are required.

The [pull request pre-check](.github/workflows/pre-check.yml) requires an increased release version and a `CHANGELOG.md` update. Only this repository's `beta` branch can merge into `main`. For same-repository pull requests, it posts or updates a check comment and, when checks pass, sets the PR title to the package version and its body to the new changelog text. Keep `package.json` on `beta` at an `X.Y.Z-beta.N` version; the release workflow strips the beta suffix when the change lands on `main`. That conversion happens only in CI, so the package file in Git retains its beta version. To make a beta release, update the version and changelog in a pull request to `beta`, merge it, and let the push workflow run. To make a stable release, merge `beta` into `main`; the workflow publishes the corresponding `X.Y.Z` version.

Check the Actions run and the resulting [GitHub Releases page](https://github.com/bloomkd46/Macstodian/releases). Local commits that have not been pushed are absent from the release. A push that keeps the same package version does not replace an already public release.

These DMGs are **unsigned and not notarized**. macOS may block the app on first launch. After verifying that the download came from this repository and copying `Macstodian.app` to `/Applications`, remove the quarantine flag in Terminal before opening it:

```sh
xattr -dr com.apple.quarantine /Applications/Macstodian.app
```

If macOS offers **System Settings → Privacy & Security → Open Anyway**, that is another way to allow the app. See [Apple's guidance](https://support.apple.com/en-us/102445). To check a DMG against its release checksum, run `shasum -a 256 -c SHA256SUMS-arm64.txt` or `shasum -a 256 -c SHA256SUMS-x64.txt` from the directory containing the downloaded files.

## Scope and limitations

- Apps are discovered recursively in `/Applications`, `~/Applications`, and `/System/Applications`, stopping at bundles. Standard and iOS-style wrapped apps can provide bundle identity; unreadable or unsafe wrapper metadata stays protected. Packages are measured as opaque native aggregates, without indexing their contents or reporting internal symlinks as exclusions. System apps participate in matching and are protected.
- Data scanning covers only direct children of `~/Library/{Application Support,Caches,Preferences,Logs,Saved Application State}`, measured recursively. Containers, Group Containers, `/Library`, services, and arbitrary disk locations are outside scope.
- Confirmed ownership uses exact bundle IDs. Product names come from installed bundle metadata, with no product/vendor alias tables. Adaptive product-name rules, installer/helper/version suffixes, inferred vendor namespaces, and identifiers extending an installed ID produce **possible related paths** excluded from confirmed totals. Their bytes appear in the app table as labeled estimates. When a possible path links to exactly one installed app, the user can choose it in that app's review after inspecting the path and match reason; it is never preselected. Shared/vendor/system data stays protected and counted once. **Possible leftovers** means neither an installed owner nor a possible association was identified; files may still be useful. Generic names remain uncertain.
- **Last opened** uses only Spotlight `kMDItemLastUsedDate`; missing/unreadable values are **Unknown**. **Data last changed** uses the newest nested regular-file mtime, excluding caches/logs. Background processes can modify data.
- Denied access, missing locations, and skipped symlinks are reported. Incomplete targets cannot be removed. Sizes use logical file lengths for Library data and native apparent bytes for opaque packages; APFS clones, compression, sparse files, metadata, snapshots, and hard links across items can affect actual usage and recovered space.
- Data starts unchecked. Main resolves IDs and rechecks identity, scope, metadata fingerprints, symlinks, and running apps before Trash. Bundle failure stops data removal. Reviews expire and rescans invalidate old IDs. OS path-based Trash cannot make validation and mutation atomic against hostile path replacement.
- Production uses Electron `shell.trashItem()`. Storage becomes available after Trash is emptied. Known vendor uninstallers are suggested for components outside scope.

All filesystem access stays in main behind a typed, sandboxed preload. Navigation, new windows, permissions, and external network requests are blocked. No telemetry or uploads.

See [scan and removal details](docs/scan-behavior.md) for accounting rules, race limitations, and vendor guidance sources.
See [matching investigation](docs/adaptive-matching-findings.md) for the local scan findings and remaining opportunities.
