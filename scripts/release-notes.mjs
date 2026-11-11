import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export function releaseNotes(diff, current, firstPush = false) {
  if (firstPush) {
    if (!current.trim()) throw new Error('CHANGELOG.md is empty.')
    return `${current.trim()}\n`
  }
  const groups = []
  let group = []
  let inHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      if (group.length) groups.push(group.join('\n').trim())
      group = []
      inHunk = true
    } else if (inHunk && line.startsWith('+')) {
      group.push(line.slice(1))
    }
  }
  if (group.length) groups.push(group.join('\n').trim())
  const changes = groups.filter(Boolean).join('\n\n')
  if (!changes) throw new Error('No changelog additions were found for this release.')
  return `${changes}\n`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const before = process.env.BEFORE_COMMIT
  const output = process.env.RELEASE_NOTES_FILE
  if (!before || !output) throw new Error('BEFORE_COMMIT and RELEASE_NOTES_FILE are required.')

  const firstPush = /^0+$/.test(before)
  let diff = ''
  if (!firstPush) {
    execFileSync('git', ['cat-file', '-e', `${before}^{commit}`])
    diff = execFileSync(
      'git',
      ['diff', '--no-ext-diff', '--unified=0', before, 'HEAD', '--', 'CHANGELOG.md'],
      {
        encoding: 'utf8'
      }
    )
  }

  const notes = releaseNotes(diff, readFileSync('CHANGELOG.md', 'utf8'), firstPush)
  writeFileSync(output, notes)
  console.log(`Release notes from CHANGELOG.md:\n${notes}`)
}
