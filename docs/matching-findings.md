# Matching investigation — November 9, 2026

This is a historical report of the previous matcher. The current implementation uses adaptive product-name/vendor rules and treats app bundles as opaque packages; embedded helper IDs are no longer indexed. See [current scan behavior](scan-behavior.md).

A separate production Electron instance ran the real scanner with Trash disabled. Application bundle metadata and direct-child Library candidates were inspected locally. The scan found 202 installed apps and 1,375 data candidates. Permission failures, skipped symlinks, and partial items were retained; this is not a complete inventory of the disk.

The old matcher recognized only exact root bundle IDs and five audited folder aliases. It left 1,172 candidates (49.77 GiB) under Possible leftovers, including many paths associated with installed software. The updated matcher was evaluated against that same snapshot using embedded metadata from a fresh scan; the fresh scan independently produced the same counts and byte totals.

| Result                                      | Paths |   Logical size |
| ------------------------------------------- | ----: | -------------: |
| Previously possible leftovers               | 1,172 |      49.77 GiB |
| Newly associated, protected app suggestions |   149 | Included below |
| Newly associated, protected shared data     |    15 | Included below |
| All newly associated paths, counted once    |   164 |      18.55 GiB |
| Remaining possible leftovers                | 1,008 |      31.23 GiB |

These are classification changes, not recovered space or newly confirmed exclusive ownership. All 164 new associations are protected, excluded from app totals, and unavailable in removal reviews. Existing confirmed matching rules remain in place. Scan duration was approximately 49 seconds before and after on this machine; timings are not a benchmark.

## Evidence and implemented rules

| Previously unmatched example                                             | Installed app or family             | Evidence / treatment                                                            |
| ------------------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------- |
| `Application Support/DigiGoat` (2.22 GiB)                                | DigiGoat                            | Exact app name; protected suggestion                                            |
| `Application Support/BambuStudio` (1.31 GiB)                             | Bambu Studio                        | Exact `.app` filename despite a different display name; protected suggestion    |
| `Application Support/Code - Insiders`                                    | VS Code Insiders                    | Exact bundle metadata name; stable and Insiders remain distinct                 |
| `Application Support/Audio Hijack 4` (2.88 GiB)                          | Audio Hijack                        | Explicit versioned product alias; protected suggestion                          |
| `Application Support/minecraft` (2.87 GiB)                               | Minecraft Launcher                  | Explicit product alias; protected suggestion                                    |
| `Application Support/com.docker.install` (2.12 GiB) and `Docker Desktop` | Docker                              | Explicit installer/product aliases; protected suggestions                       |
| `Caches/com.microsoft.SharePoint-mac`, OneDrive updater IDs              | OneDrive                            | Exact IDs declared by bundles embedded in OneDrive                              |
| `Caches/com.citrix.AuthManagerMac` and other Citrix helper IDs           | Citrix Workspace                    | Exact IDs declared by embedded app bundles                                      |
| `Caches/us.zoom.updater`                                                 | Zoom                                | Exact embedded updater ID                                                       |
| `Caches/com.hnc.Discord.ShipIt`                                          | Discord                             | Complete installed bundle ID plus a dot suffix; protected suggestion            |
| `Preferences/com.apphousekitchen.aldente-pro_stats.sqlite3`              | AlDente                             | Complete bundle ID plus an underscore-delimited SQLite sidecar name             |
| `BraveSoftware`, `4kdownload.com`, `Citrix`, `OpenAI`, `Raspberry Pi`    | Corresponding installed vendor apps | Explicit shared-folder names and vendor namespaces; protected even with one app |
| `Preferences/org.sparkle-project.Sparkle.Autoupdate.plist`               | Multiple apps                       | Same embedded helper ID found in many apps; shared and counted once             |

The scan indexed 418 embedded helper ID entries across installed apps. By rule, 73 newly associated paths used exact names or explicit aliases, 40 used embedded helper IDs, 40 used full-ID derivatives, and 11 used vendor folder mappings. Four of the embedded-helper matches had multiple app owners, yielding 15 new shared paths overall.

The UI lists suggested paths under each app, shows a possible-path count in its data column, and provides a separate aggregate list below both tabs. The aggregate summary counts each path once. Main rejects suggested paths independently of their protected flag, and the renderer excludes them from removal review.

## Remaining opportunities

- **CLI tools and editor extensions:** `ms-playwright`, `node-gyp`, `typescript`, `pnpm`, `vscode-cpptools`, and GitHub Copilot SDK caches can be useful without an installed `.app` owner. A separate tool/extension inventory would represent these more accurately than assigning them to an arbitrary editor.
- **Apps launched outside application roots:** `Canscope`, `angular-electron`, and `Web-Builder` have no identified owner within the current roots. A future read-only running-app or user-selected application-root inventory could discover development builds. Presence of source code alone should not establish exclusive ownership of a data folder.
- **Shared vendor contents:** `ETC`, Adobe service data, and other vendor folders need explicit product/service metadata or child-level accounting. Do not assign an entire vendor namespace to one installed product. Child-level removal would require corresponding changes to scope checks and fingerprint validation.
- **Containers and app groups:** reading app entitlements could establish relationships for sandbox containers and shared app groups. This is outside the current scan/removal scope and should preserve shared accounting and symlink protections.
- **ByHost preferences:** the current scanner protects the entire `ByHost` directory as one candidate. A separate child-level model could match bundle IDs after stripping a valid host UUID, without making the whole directory app-owned.
- **Channel/version distinctions:** `BambuStudioBeta` remains unmatched when only stable Bambu Studio is identified. Broad punctuation stripping or substring matching would hide this distinction. Any association should remain a protected suggestion unless specific metadata establishes the relationship.

About 22.88 GiB of the remaining set is protected `com.apple.wallpaper` data, and another 1.45 GiB is the generic protected `electron` cache. Neither is evidence of an uninstalled app or safe-to-delete data.

Validation includes 34 fixture tests for scanner/accounting/removal behavior, a production build/typecheck, fixture Electron UI tests, and a real production Electron UI scan. Local scan snapshots and the per-path comparison are saved under gitignored `verification/scan-before.json`, `verification/scan-after.json`, and `verification/matching-report.json`.
