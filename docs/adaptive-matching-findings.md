# Adaptive matching investigation — November 10, 2026

This is a historical matching study. The current app allows uniquely linked possible paths to be selected, unchecked by default, in the associated app's removal review.

A fresh production Electron scan with Trash disabled found 203 apps and 1,378 external data candidates. Before these changes, 1,029 candidates were classified as possible leftovers. The saved scan was reclassified with the new rules so file growth and background activity cannot distort the classification comparison.

| Newly recognized context                                            | Paths | Logical/native apparent size |
| ------------------------------------------------------------------- | ----: | ---------------------------: |
| Specific installed product suggestions                              |    27 |                     2.16 GiB |
| Installed vendor-family context                                     |   116 |                    299.6 MiB |
| Shared infrastructure or observed vendor without an installed owner |    12 |                     29.3 MiB |
| Total, counted once                                                 |   155 |                     2.48 GiB |

Possible leftovers decrease from **1,029 to 874** on that same inventory. No previously associated path becomes unmatched. All newly recognized paths are protected and excluded from app totals/removal; this is a classification change, not recovered space.

Representative results:

- `com.docker.install` → Docker, using an installer role under the app's own brand namespace.
- `com.microsoft.OneDriveStandaloneUpdater` → OneDrive, using a product stem plus helper suffix within Microsoft's namespace.
- `us.zoom.ZoomAutoUpdater` → zoom.us, deriving the product stem from its domain-style app name.
- `org.raspberrypi.Imager` → Raspberry Pi Imager, separating the multiword vendor prefix from the product.
- `com.citrix.AuthManagerMac` → protected Citrix-family context. A shared namespace does not prove exclusive ownership by Citrix Workspace.
- `autodesk.webdeploy.streamer.log` → protected Autodesk-family context, through a vendor-prefixed log name.
- `4kdownload.com` → protected family context for 4K Video Downloader+, supported by the complete product name in a scanned preference identifier under that alternate namespace.

There are no product/vendor alias tables. Names formerly authorized by the five audited aliases, such as `Code`, are now metadata-derived protected suggestions. Exact bundle IDs remain the only removal-authorizing app-data matches. Generic data/framework terms, company suffixes, and macOS infrastructure remain semantic protection rules.

Negative checks retain unrelated Electron projects, unknown uninstalled product identifiers, and CLI/tool data as unmatched. `com.github.Electron` is protected as generic runtime data without associating it with GitHub Copilot. Namespace evidence alone does not turn an uninstalled product into an installed app.

Validation: 49 fixture tests, typecheck/production build, fixture Electron UI checks, and a new real read-only scan. The fresh scan contains the same candidate count; reclassifying it with the final rules also yields 874 leftovers. Local snapshots and the per-path report are in gitignored `verification/scan-patterns-before.json`, `verification/scan-patterns-after.json`, and `verification/pattern-matching-report.json`.

See [current scan behavior](scan-behavior.md) for the matching policy and [the earlier investigation](matching-findings.md) for historical results.
