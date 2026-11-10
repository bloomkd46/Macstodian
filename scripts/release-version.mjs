import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { compareVersions, releaseVersion } from './versioning.mjs'

const branch = process.env.GITHUB_REF_NAME
const path = 'package.json'
const source = JSON.parse(readFileSync(path, 'utf8'))
const version = releaseVersion(branch, source.version)

if (process.argv.includes('--write')) {
  if (process.env.RELEASE_VERSION !== version)
    throw new Error(`Expected release version ${process.env.RELEASE_VERSION}, got ${version}`)
  source.version = version
  writeFileSync(path, `${JSON.stringify(source, null, 2)}\n`)
} else {
  const before = process.env.BEFORE_COMMIT
  if (before && !/^0+$/.test(before)) {
    const oldPackage = JSON.parse(
      execFileSync('git', ['show', `${before}:${path}`], { encoding: 'utf8' })
    )
    const previous =
      branch === 'main' ? releaseVersion(branch, oldPackage.version) : oldPackage.version
    if (compareVersions(version, previous) < 0)
      throw new Error(`Release version decreased: ${previous} → ${version}`)
  }
  console.log(`Release version: ${version}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`)
}
