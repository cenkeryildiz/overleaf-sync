// SPDX-License-Identifier: AGPL-3.0-only
// CE+ ae07e781; modified 2026-11-15 to keep owned preamble state out of outputs.
import Path from 'node:path'
import fs from 'node:fs'
import { callbackifyMultiResult } from '@overleaf/promise-utils'

async function walkFolder(compileDir, d, files, allEntries, internalCache) {
  const dirents = await fs.promises.readdir(Path.join(compileDir, d), {
    withFileTypes: true,
  })
  for (const dirent of dirents) {
    if (internalCache && !d && dirent.name === '.overleaf-preamble') continue;
    const p = Path.join(d, dirent.name)
    if (dirent.isDirectory()) {
      await walkFolder(compileDir, p, files, allEntries, internalCache)
      allEntries.push(p + '/')
    } else if (dirent.isFile()) {
      files.push(p)
      allEntries.push(p)
    } else {
      allEntries.push(p)
    }
  }
}

async function findOutputFiles(resources, directory) {
  const files = []
  const allEntries = []
  let internalCache = false
  if (!resources.some(r => r.path === '.overleaf-preamble' || r.path.startsWith('.overleaf-preamble/'))) {
    try {
      const owner = Path.join(directory, '.overleaf-preamble', 'owner')
      const stat = await fs.promises.lstat(owner)
      internalCache = stat.isFile() && stat.size === 27 && await fs.promises.readFile(owner, 'utf8') === 'overleaf-native-preamble-v1'
    } catch { /* Missing or unreadable state stays ordinary native output. */ }
  }
  await walkFolder(directory, '', files, allEntries, internalCache)

  const incomingResources = new Set(resources.map(resource => resource.path))

  const outputFiles = []
  for (const path of files) {
    if (incomingResources.has(path)) continue
    if (path === '.project-sync-state') continue
    outputFiles.push({
      path,
      type: Path.extname(path).replace(/^\./, '') || undefined,
    })
  }
  return {
    outputFiles,
    allEntries,
  }
}

export default {
  findOutputFiles: callbackifyMultiResult(findOutputFiles, [
    'outputFiles',
    'allEntries',
  ]),
  promises: {
    findOutputFiles,
  },
}
