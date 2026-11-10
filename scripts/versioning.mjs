const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/

export function parseVersion(value) {
  const match = versionPattern.exec(value ?? '')
  if (!match)
    throw new Error(`Invalid version ${JSON.stringify(value)}. Use X.Y.Z or X.Y.Z-beta.N.`)
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    beta: match[4] === undefined ? null : Number(match[4])
  }
}

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let i = 0; i < 3; i++) {
    if (a.numbers[i] !== b.numbers[i]) return Math.sign(a.numbers[i] - b.numbers[i])
  }
  if (a.beta === null && b.beta === null) return 0
  if (a.beta === null) return 1
  if (b.beta === null) return -1
  return Math.sign(a.beta - b.beta)
}

export function releaseVersion(branch, sourceVersion) {
  const parsed = parseVersion(sourceVersion)
  if (branch === 'beta') {
    if (parsed.beta === null) throw new Error('The beta branch requires an X.Y.Z-beta.N version.')
    return sourceVersion
  }
  if (branch !== 'main') throw new Error(`Unsupported release branch: ${branch}`)
  return parsed.numbers.join('.')
}
