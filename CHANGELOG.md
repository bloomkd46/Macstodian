# Changelog

## 1.2.0-beta.1

- Keep scan results available after moving items to Trash so more apps can be removed without rescanning.
- Mark moved items in the list and recommend a rescan to refresh storage estimates.
- Make removal failures prominent in the banner and mark failed items in red.

## 1.1.0-beta.1

- Change the sidebar tagline to "The custodian for your Mac".
- Clarify that grouped leftover sizes are totals across their paths.

## 1.0.1-beta.3

- Make GitHub release notes match the changelog entries added for the release.

## 1.0.1-beta.2

- Show the package version in the app's sidebar instead of a hardcoded version.

## 1.0.1-beta.1

- Update Node, Yarn, Electron, and the app's build and UI dependencies, including Electron's binary installation.
- Update GitHub Actions used for pull request checks and unsigned releases.
- Document the quarantine removal step needed to open unsigned macOS builds.

## 1.0.0

- Initial macOS storage inspector with conservative application and leftover matching.
- Review and confirm selected items before moving them to Trash.
- Inspect scan progress, protected paths, and size estimates in the desktop app.
