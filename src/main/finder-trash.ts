import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
type FinderCommand = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number }
) => Promise<unknown>

export function isPermissionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const coded = error as { code?: unknown; message?: unknown }
  return (
    coded.code === 'EACCES' ||
    coded.code === 'EPERM' ||
    (typeof coded.message === 'string' &&
      /\b(EACCES|EPERM|permission|operation not permitted|access denied|not authorized)\b/i.test(
        coded.message
      ))
  )
}

export async function trashWithFinder(path: string, run: FinderCommand = exec): Promise<void> {
  await run(
    '/usr/bin/osascript',
    [
      '-e',
      'on run argv',
      '-e',
      'set targetFile to (POSIX file (item 1 of argv)) as alias',
      '-e',
      'tell application "Finder" to move targetFile to trash',
      '-e',
      'end run',
      path
    ],
    { timeout: 120000, maxBuffer: 1024 * 1024 }
  )
}
