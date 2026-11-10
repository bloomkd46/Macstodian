# Scan and removal behavior

## Review and removal

- Expand an app to inspect the bundle and every matched path, size, category, and match reason. Show in Finder resolves the current scan-item ID in main.
- Review removal separates the bundle, caches/logs, and settings/local data. Only the bundle is selected initially; data starts unchecked. A second screen lists every selected path and its estimated size before **Confirm move to Trash**.
- Possible leftovers require explicit selection and confirmation. Unmatched ownership does not establish that files are unused. Generic names are uncertain and protected. Shared/system data is protected and counted once outside individual app totals.
- Possible related paths appear in app details and in a separate list below either tab. These are suggestions with an explanation, not confirmed ownership. They cannot be selected or submitted for removal, and do not affect app size, data size, total size, or data-last-changed dates. The summary counts each shared or possible related path once, even when associated with several apps.
- Quit a running app before removing its bundle or data. Checks include NSWorkspace and bundle executables / surviving helpers; a process-check failure blocks removal. Known vendor uninstaller guidance is shown by bundle ID; bundle internals are not searched for uninstallers.
- Main accepts IDs, never renderer-supplied removal paths. Reviews expire after five minutes. A rescan invalidates old IDs/reviews. Identity, scope, bundle ownership, symlink ancestors/targets, and a recursive metadata fingerprint (native package manifest for bundles) are checked again before each Trash operation. Partial, shared, and system targets cannot be removed. If the bundle fails, all its selected data is skipped. Outcomes are reported individually and a new scan follows.
- Trashing does not immediately recover storage. Storage becomes available after Trash is emptied.

## Scan scope and limitations

Applications are discovered recursively in `/Applications`, `~/Applications`, and `/System/Applications`, stopping at `.app` bundles. System apps participate in ownership matching and remain protected. Each app is one opaque scan item: only its root `Contents/Info.plist` and Spotlight metadata are read for identity. Native macOS `du -s -A -k -P` (KiB converted to bytes) supplies the aggregate apparent size, and read-only `mtree -c -n -P` supplies a metadata fingerprint for removal revalidation. These native accounting passes must inspect package metadata to size it and detect internal changes, but do not follow links, discover candidates, or index embedded helpers. Internal package symlinks are ordinary package contents, not scan exclusions. Packages encountered inside Library data use the same boundary. Data candidates are only direct children of these user folders, measured recursively:

- `~/Library/Application Support`
- `~/Library/Caches`
- `~/Library/Preferences`
- `~/Library/Logs`
- `~/Library/Saved Application State`

Confirmed ownership uses exact bundle IDs (with `.plist` / `.savedState` suffix handling) and the small auditable alias table in `src/main/ownership.ts`. The matcher also suggests relationships using:

- Names derived from `CFBundleDisplayName`, `CFBundleName`, the `.app` filename, and distinctive product tokens in bundle IDs. Unicode normalization, camel-case word splitting, punctuation/spacing normalization, and optional product roles (Desktop, Launcher, Client, Browser) adapt across devices without a product alias table.
- Full product names followed by a word/version/channel suffix, such as `Audio Hijack 27`. Exact normalized names win first, then the longest word-boundary prefix; `Code` does not match `Codec`. All inferred relationships remain protected suggestions.
- Vendor folders and bare vendor namespaces inferred from installed reverse-domain bundle IDs. Known shared/system names remain an explicit protection list even when no vendor apps are installed.
- A full installed app ID followed by a dot, or by an underscore for preference SQLite databases and their WAL/SHM sidecars. The longest matching ID wins. These may be updater, helper, or per-feature settings paths; a prefix establishes only a possible relation.

All these additional relationships are protected and excluded from individual app totals, regardless of whether there is one candidate app or several. Missing bundle identities cannot produce suggestions. Generic names such as `Electron` and `CEF` stay uncertain/protected. Vendor/shared folders use explicit names and namespace mappings and remain protected even when only one vendor app is installed. The matcher does not associate every path in a vendor namespace with whichever vendor product happens to be installed.

Containers, Group Containers, `/Library`, launch agents, browser profiles elsewhere, and arbitrary disk locations are outside the scan. A possible leftover may belong to a CLI tool, helper, app installed elsewhere, or an app whose metadata could not be read. This is a conservative cleanup aid, not a complete uninstaller.

**Dates:** Last opened comes only from `mdls -raw -name kMDItemLastUsedDate`. Missing/unreadable Spotlight data is **Unknown**; no timestamp is substituted. Data last changed is the newest regular-file mtime observed recursively in matched app data, excluding top-level cache/log categories and recognized nested cache/log directories. Background processes can change data. Dates do not prove user activity, ownership, or that a file is safe to remove. Empty directories have no regular-file change date.

**Permissions:** macOS privacy controls and permissions can deny access. Skipped-location details and partial results remain visible; inaccessible bytes are not estimated. No permission elevation is requested by the app. Symlinks outside packages are skipped. Package accounting does not follow internal symlinks and does not report them as excluded locations. Directories changing during enumeration are marked partial. A scan is an observation over time, not an atomic filesystem snapshot.

**Storage:** Library sizes sum logical regular-file lengths, with hard links deduplicated within each measured item. Opaque package sizes use native apparent bytes, including internal directory and symlink metadata and native block rounding; packages are deduplicated independently. These estimates exclude resource forks and extended attributes. Compression, APFS clones, sparse allocation, purgeable storage, snapshots, and cross-item hard links can make these estimates differ from Finder, physical usage, or eventual recovered space. Shared candidate paths appear only once in the scan; they are excluded from each owner's data/total columns. App size means bundle only; Data size means confidently matched external paths; Total is their sum.

**Races:** Conservative identity/fingerprint checks reject observed changes and symlink replacements. `shell.trashItem()` is a path-based OS API; it cannot provide an atomic validate-and-trash transaction against a hostile process replacing paths at the final instant. The app does not hash file contents or stop applications. It fails closed on observed changes and unavailable running-app checks; rescan if a selection changes.

All filesystem and OS operations stay in main behind a narrow, typed, context-isolated preload API. The renderer is sandboxed without Node integration. Navigation, new windows, permissions, webviews, and external network requests are blocked (only the local Vite origin is allowed during development). No telemetry, remote API, or automatic deletion is included.

Vendor guidance sources: [Autodesk removal tools](https://www.autodesk.com/support/download-install/individuals/manage/uninstall-autodesk-software), [SoundSource uninstall](https://www.rogueamoeba.com/support/manuals/soundsource/?page=installing-uninstalling), and [older SoundSource / ACE](https://www.rogueamoeba.com/support/manuals/legacy/soundsource-ace/?page=etc-installinguninstalling). These are guidance only; Macstodian does not run vendor tools.
