import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, sep } from 'node:path'

const exec = promisify(execFile)
export interface BundleInfo {
  bundleId: string | null
  name: string | null
  names?: string[]
}
export interface Platform {
  readBundleInfo(path: string): Promise<BundleInfo>
  lastOpened(path: string): Promise<number | null>
  isRunning(path: string): Promise<boolean>
}

export function parseSpotlightDate(raw: string): number | null {
  const value = raw.trim()
  if (!value || value === '(null)' || value === 'null') return null
  // mdls emits e.g. 2026-01-02 12:34:56 +0000.
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}$/.test(value)) return null
  const stamp = Date.parse(value)
  return Number.isFinite(stamp) ? stamp : null
}

export function processBelongsToBundle(executable: string, bundle: string): boolean {
  return executable.trim().startsWith(`${resolve(bundle)}${sep}`)
}

export type CommandRunner = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer?: number }
) => Promise<{ stdout: string }>
export function createMacPlatform(run: CommandRunner = exec): Platform {
  return {
    async readBundleInfo(path) {
      try {
        const { stdout } = await run(
          '/usr/bin/plutil',
          ['-convert', 'json', '-o', '-', `${path}/Contents/Info.plist`],
          { timeout: 5000, maxBuffer: 2 * 1024 * 1024 }
        )
        const info = JSON.parse(stdout) as Record<string, unknown>
        const str = (key: string) =>
          typeof info[key] === 'string' && info[key] ? String(info[key]) : null
        return {
          bundleId: str('CFBundleIdentifier'),
          name: str('CFBundleDisplayName') ?? str('CFBundleName'),
          names: [
            ...new Set(
              [str('CFBundleDisplayName'), str('CFBundleName')].filter(
                (value): value is string => value !== null
              )
            )
          ]
        }
      } catch {
        // An unreadable bundle stays visible, but can never own data or be removed.
        return { bundleId: null, name: null }
      }
    },
    async lastOpened(path) {
      try {
        const { stdout } = await run(
          '/usr/bin/mdls',
          ['-raw', '-name', 'kMDItemLastUsedDate', path],
          { timeout: 5000 }
        )
        return parseSpotlightDate(stdout)
      } catch {
        return null
      }
    },
    async isRunning(path) {
      // NSWorkspace includes GUI apps and agents; ps also catches surviving bundle helpers.
      // Use executable names, never command arguments (which can merely mention a path).
      // Failure of either check rejects removal rather than assuming an app has quit.
      const [workspace, processes] = await Promise.all([
        run(
          '/usr/bin/osascript',
          [
            '-l',
            'JavaScript',
            '-e',
            `ObjC.import('AppKit'); JSON.stringify(ObjC.unwrap($.NSWorkspace.sharedWorkspace.runningApplications).map(a => a.bundleURL ? ObjC.unwrap(a.bundleURL.path) : null).filter(Boolean));`
          ],
          { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }
        ),
        run('/bin/ps', ['-ww', '-axo', 'comm='], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 })
      ])
      const paths: unknown = JSON.parse(workspace.stdout)
      if (!Array.isArray(paths) || paths.some((value) => typeof value !== 'string'))
        throw new Error('Could not verify running applications. Try again after quitting the app.')
      return (
        paths.some((value) => resolve(value as string) === resolve(path)) ||
        processes.stdout.split('\n').some((line) => processBelongsToBundle(line, path))
      )
    }
  }
}
export const macPlatform = createMacPlatform()
