import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions, releaseVersion } from '../scripts/versioning.mjs'
import { changelogChanges, evaluatePreCheck } from '../scripts/pre-check.mjs'
import { releaseNotes } from '../scripts/release-notes.mjs'

test('version ordering and branch release versions', () => {
  assert.equal(compareVersions('0.2.0-beta.2', '0.2.0-beta.1'), 1)
  assert.equal(compareVersions('0.2.0', '0.2.0-beta.2'), 1)
  assert.equal(compareVersions('0.2.0-beta.1', '0.1.0'), 1)
  assert.equal(releaseVersion('main', '0.2.0-beta.2'), '0.2.0')
  assert.equal(releaseVersion('beta', '0.2.0-beta.2'), '0.2.0-beta.2')
  assert.throws(() => releaseVersion('beta', '0.2.0'), /requires/)
  assert.throws(() => releaseVersion('main', '0.2'), /Invalid version/)
})

const request = {
  baseBranch: 'main',
  headBranch: 'beta',
  baseVersion: '0.1.0',
  headVersion: '0.2.0-beta.2',
  baseChangelog: '# Changelog\n',
  headChangelog: '# Changelog\n## 0.2.0-beta.2\n',
  headRepository: 'bloomkd46/Macstodian',
  repository: 'bloomkd46/Macstodian'
}

test('stable PR accepts the repository beta branch with a newer stable version', () => {
  assert.deepEqual(
    evaluatePreCheck(request).map(([status]) => status),
    ['pass', 'pass', 'pass']
  )
})

test('stable PR rejects another branch, unchanged version, or unchanged changelog', () => {
  const results = evaluatePreCheck({
    ...request,
    headBranch: 'feature',
    headVersion: '0.1.0-beta.2',
    headChangelog: request.baseChangelog
  })
  assert.deepEqual(
    results.map(([status]) => status),
    ['fail', 'fail', 'fail']
  )
})

test('beta PR requires a newer beta version and a changelog change', () => {
  const results = evaluatePreCheck({
    ...request,
    baseBranch: 'beta',
    headBranch: 'feature',
    baseVersion: '0.2.0-beta.1'
  })
  assert.deepEqual(
    results.map(([status]) => status),
    ['pass', 'pass', 'pass']
  )
  const invalid = evaluatePreCheck({
    ...request,
    baseBranch: 'beta',
    headBranch: 'feature',
    baseVersion: '0.2.0-beta.1',
    headVersion: '0.2.0'
  })
  assert.equal(invalid[1][0], 'fail')
})

test('pre-check extracts new changelog notes for the pull request', () => {
  assert.equal(changelogChanges('## Old\n', '## New\n## Old\n'), '## New')
  assert.equal(changelogChanges('## Old\n', '## Old\n## New\n'), '## New')
  assert.equal(
    changelogChanges('# Changelog\n\n## Old\n', '# Changelog\n\n## New\n\n## Old\n'),
    '## New'
  )
  assert.equal(changelogChanges('## Old\n', '## Old\n'), '')
})

test('release notes contain only the changelog entries added by the push', () => {
  const diff =
    'diff --git a/CHANGELOG.md b/CHANGELOG.md\n' +
    '--- a/CHANGELOG.md\n+++ b/CHANGELOG.md\n' +
    '@@ -2,0 +3,4 @@\n+## 1.0.1-beta.3\n+\n+- New change.\n+\n' +
    '@@ -9,0 +14,2 @@\n+## Older fix\n+- Another change.\n'
  assert.equal(
    releaseNotes(diff, '# Changelog\n'),
    '## 1.0.1-beta.3\n\n- New change.\n\n## Older fix\n- Another change.\n'
  )
  assert.throws(() => releaseNotes('', '# Changelog\n'), /No changelog additions/)
  assert.equal(releaseNotes('', '# Changelog\n\n## First\n', true), '# Changelog\n\n## First\n')
})

test('release notes script compares the previous commit with the current changelog', () => {
  const directory = mkdtempSync(join(tmpdir(), 'macstodian-release-notes-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: directory })
    writeFileSync(join(directory, 'CHANGELOG.md'), '# Changelog\n\n## 1.0.0\n\n- First.\n')
    execFileSync('git', ['add', 'CHANGELOG.md'], { cwd: directory })
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'baseline'
      ],
      { cwd: directory }
    )
    const before = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: directory,
      encoding: 'utf8'
    }).trim()
    writeFileSync(
      join(directory, 'CHANGELOG.md'),
      '# Changelog\n\n## 1.0.1-beta.1\n\n- New.\n\n## 1.0.0\n\n- First.\n'
    )
    execFileSync('git', ['add', 'CHANGELOG.md'], { cwd: directory })
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'new release'
      ],
      { cwd: directory }
    )
    const output = join(directory, 'release-notes.md')
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL('../scripts/release-notes.mjs', import.meta.url))],
      {
        cwd: directory,
        env: { ...process.env, BEFORE_COMMIT: before, RELEASE_NOTES_FILE: output }
      }
    )
    assert.equal(readFileSync(output, 'utf8'), '## 1.0.1-beta.1\n\n- New.\n')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
