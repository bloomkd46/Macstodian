import { appendFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { compareVersions, releaseVersion } from './versioning.mjs'

export function evaluatePreCheck({
  baseBranch,
  headBranch,
  baseVersion,
  headVersion,
  baseChangelog,
  headChangelog,
  headRepository,
  repository
}) {
  const results = []
  if (!['main', 'beta'].includes(baseBranch))
    throw new Error(`Unsupported base branch: ${baseBranch}`)

  if (baseBranch === 'main' && (headBranch !== 'beta' || headRepository !== repository))
    results.push(['fail', 'Only this repository’s beta branch may merge into main.'])
  else results.push(['pass', `Branch: ${headBranch} → ${baseBranch}`])

  try {
    const candidate = releaseVersion(baseBranch, headVersion)
    const previous = baseBranch === 'main' ? releaseVersion(baseBranch, baseVersion) : baseVersion
    if (compareVersions(candidate, previous) <= 0)
      results.push(['fail', `Release version must increase: ${previous} → ${candidate}`])
    else results.push(['pass', `Release version: ${previous} → ${candidate}`])
  } catch (error) {
    results.push(['fail', error.message])
  }

  if (!headChangelog?.trim() || !changelogChanges(baseChangelog, headChangelog))
    results.push(['fail', 'Update CHANGELOG.md for this pull request.'])
  else results.push(['pass', 'CHANGELOG.md was updated.'])

  return results
}

export function changelogChanges(previous, current) {
  if (!previous) return current.trim()
  const oldLines = previous.split('\n')
  const newLines = current.split('\n')
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start])
    start++
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--
    newEnd--
  }
  return newLines.slice(start, newEnd).join('\n').trim()
}

function gitShow(ref, path) {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8' })
  } catch (error) {
    if (path === 'CHANGELOG.md') return null
    throw error
  }
}

async function updatePullRequest({ repository, number, token, version, summary, changes, passed }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^\d+$/.test(number))
    throw new Error('Invalid pull request target.')
  const url = `https://api.github.com/repos/${repository}`
  const request = async (method, path, body) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    })
    if (!response.ok) throw new Error(`GitHub ${method} ${path} failed: ${response.status}`)
    return response.json()
  }
  if (passed) await request('PATCH', `/pulls/${number}`, { title: version, body: changes })
  const marker = '<!-- macstodian-pre-check -->'
  const comments = await request('GET', `/issues/${number}/comments?per_page=100`)
  const existing = comments.find(
    (comment) => comment.body?.startsWith(marker) && comment.user?.type === 'Bot'
  )
  await request(
    existing ? 'PATCH' : 'POST',
    existing ? `/issues/comments/${existing.id}` : `/issues/${number}/comments`,
    {
      body: `${marker}\n${summary}`
    }
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const baseBranch = process.env.GITHUB_BASE_REF
    const headBranch = process.env.GITHUB_HEAD_REF
    if (!baseBranch || !headBranch) throw new Error('Run this script from a pull request check.')
    const baseRef = `origin/${baseBranch}`
    const baseChangelog = gitShow(baseRef, 'CHANGELOG.md')
    const headChangelog = readFileSync('CHANGELOG.md', 'utf8')
    const headVersion = JSON.parse(readFileSync('package.json', 'utf8')).version
    const results = evaluatePreCheck({
      baseBranch,
      headBranch,
      baseVersion: JSON.parse(gitShow(baseRef, 'package.json')).version,
      headVersion,
      baseChangelog,
      headChangelog,
      headRepository: process.env.HEAD_REPOSITORY,
      repository: process.env.GITHUB_REPOSITORY
    })
    const summary = [
      '## Macstodian pre-check',
      '',
      ...results.map(([status, message]) => `- ${status === 'pass' ? '✅' : '❌'} ${message}`),
      ''
    ].join('\n')
    console.log(summary)
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
    const passed = results.every(([status]) => status === 'pass')
    if (!passed) process.exitCode = 1
    if (
      process.env.GITHUB_TOKEN &&
      process.env.PR_NUMBER &&
      process.env.HEAD_REPOSITORY === process.env.GITHUB_REPOSITORY
    ) {
      await updatePullRequest({
        repository: process.env.GITHUB_REPOSITORY,
        number: process.env.PR_NUMBER,
        token: process.env.GITHUB_TOKEN,
        version: headVersion,
        summary,
        changes: changelogChanges(baseChangelog, headChangelog),
        passed
      }).catch((error) => console.warn(`Could not update pull request: ${error.message}`))
    }
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
