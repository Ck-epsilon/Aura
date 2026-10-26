/**
 * repo-search.mjs — repository-wide, adapter-driven grep with a deterministic budgeted receipt.
 *
 * Regex queries run in-process (no worker). ReDoS is bounded by: pattern length ≤ 500 chars,
 * maxFileBytes per file, and the hard match limit.
 *
 * WHERE TO CHANGE:
 *   searchRepo — walk order, skip rules, match/rank/render policy, request defaults
 *   globToRegExp — glob surface (`**`, `*`, `?`); path matching is POSIX
 *
 * USED BY:
 *   (wiring layer: repo search tool; no call sites yet)
 */

import { isIgnoredDir } from './repo-map.mjs'

// ── limits ──

const DEFAULT_BUDGET = 7600
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000
const MAX_PATTERN_CHARS = 500
const MAX_CONTEXT = 20
const MAX_DEPTH = 32
const MAX_MATCH_LINE = 300
const MAX_CONTEXT_LINE = 160
const BINARY_SNIFF_CHARS = 4096

// ── glob ──

/**
 * `**` crosses directories, `*` and `?` stay inside one path segment.
 * A pattern without `/` is matched against the basename; with `/` against the relative path.
 */
export function globToRegExp(pattern) {
  const text = String(pattern ?? '').replaceAll('\\', '/')
  let source = '^'
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '*') {
      if (text[i + 1] === '*') {
        i += 2
        if (text[i] === '/') {
          source += '(?:.*/)?'
          i += 1
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
        i += 1
      }
      continue
    }
    if (c === '?') {
      source += '[^/]'
      i += 1
      continue
    }
    source += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    i += 1
  }
  return new RegExp(`${source}$`)
}

function globMatcher(glob) {
  if (typeof glob !== 'string' || glob.length === 0) return null
  const re = globToRegExp(glob)
  const pathPattern = glob.includes('/')
  return (relPath) => re.test(pathPattern ? relPath : relPath.slice(relPath.lastIndexOf('/') + 1))
}

// ── helpers ──

const posix = (p) => String(p).replaceAll('\\', '/')
const byteOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)} ⋯` : text)

function searchError(code, message) {
  return { ok: false, code, message }
}

/** Ordered breadth-first walk; only metadata is read here. Ignored/hidden directories are not entered. */
async function collectFiles(adapter, root) {
  const queue = [{ target: root, rel: '' }]
  const files = []
  const joinRel = typeof adapter.joinRel === 'function' ? adapter.joinRel : (dirRel, name) => (dirRel === '' ? name : `${dirRel}/${name}`)
  for (let head = 0; head < queue.length; head += 1) {
    const dir = queue[head]
    let children
    try {
      children = await adapter.listChildren(dir.target)
    } catch (err) {
      // A subdirectory may vanish between listing and descent; the root may not.
      if (dir.rel === '') throw err
      continue
    }
    if (!Array.isArray(children)) continue
    for (const child of children) {
      if (child === null || typeof child !== 'object' || typeof child.name !== 'string') continue
      const rel = posix(joinRel(dir.rel, child.name))
      if (child.type === 'directory') {
        if (isIgnoredDir(child.name)) continue
        if (rel.split('/').length > MAX_DEPTH) continue
        queue.push({ target: child.target, rel })
        continue
      }
      if (child.type !== 'file') continue
      files.push({ rel, target: child.target, size: Number.isFinite(child.size) ? child.size : null })
    }
  }
  files.sort((a, b) => byteOrder(a.rel, b.rel))
  return files
}

function matchLines(text, request, regex) {
  const lines = text.split(/\r?\n/)
  const hits = []
  const needle = request.caseSensitive ? request.query : request.query.toLowerCase()
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const hit = regex === null ? (request.caseSensitive ? line.includes(needle) : line.toLowerCase().includes(needle)) : regex.test(line)
    if (hit) hits.push(i + 1)
  }
  return { lines, hits }
}

function contextRows(lines, hitLine, context) {
  const before = []
  const after = []
  for (let n = Math.max(1, hitLine - context); n < hitLine; n += 1) before.push({ line: n, text: clip((lines[n - 1] ?? '').trim(), MAX_CONTEXT_LINE) })
  for (let n = hitLine + 1; n <= Math.min(lines.length, hitLine + context); n += 1) after.push({ line: n, text: clip((lines[n - 1] ?? '').trim(), MAX_CONTEXT_LINE) })
  return { before, after }
}

// ── search ──

export async function searchRepo(adapter, root, request = {}) {
  if (adapter === null || typeof adapter !== 'object' || typeof adapter.listChildren !== 'function' || typeof adapter.readText !== 'function') {
    return searchError('SEARCH_BAD_ADAPTER', 'adapter needs listChildren(dir) and readText(target)')
  }
  const query = request.query
  if (typeof query !== 'string' || query.length === 0) {
    return searchError('SEARCH_EMPTY_QUERY', 'query must be a non-empty string')
  }
  if (query.length > MAX_PATTERN_CHARS) {
    return searchError('SEARCH_BAD_REGEX', `pattern is ${query.length} chars; the limit is ${MAX_PATTERN_CHARS}`)
  }

  const caseSensitive = request.caseSensitive !== false
  const useRegex = request.regex === true
  let regex = null
  if (useRegex) {
    try {
      regex = new RegExp(query, caseSensitive ? '' : 'i')
    } catch (err) {
      return searchError('SEARCH_BAD_REGEX', err.message)
    }
  }

  const limit = Math.max(1, Math.min(Number.isInteger(request.limit) && request.limit > 0 ? request.limit : DEFAULT_LIMIT, MAX_LIMIT))
  const context = Math.max(0, Math.min(Number.isInteger(request.context) && request.context > 0 ? request.context : 0, MAX_CONTEXT))
  const maxFileBytes = Number.isInteger(request.maxFileBytes) && request.maxFileBytes > 0 ? request.maxFileBytes : 2_000_000
  const budget = Number.isInteger(request.budget) && request.budget > 0 ? request.budget : DEFAULT_BUDGET
  const matchesGlob = globMatcher(request.glob)

  let files
  try {
    files = await collectFiles(adapter, root)
  } catch (err) {
    return searchError('SEARCH_ROOT_UNREADABLE', err?.message ?? 'the root directory could not be listed')
  }
  const skipped = { binary: 0, tooLarge: 0, unreadable: 0 }
  const matches = []
  let filesScanned = 0
  let filesMatched = 0
  let bytes = 0
  let stoppedAtLimit = false

  for (const file of files) {
    if (matchesGlob !== null && !matchesGlob(file.rel)) continue
    if (file.size !== null && file.size > maxFileBytes) {
      skipped.tooLarge += 1
      continue
    }
    let text
    try {
      text = await adapter.readText(file.target)
    } catch {
      skipped.unreadable += 1
      continue
    }
    if (typeof text !== 'string') {
      skipped.unreadable += 1
      continue
    }
    if (text.length > maxFileBytes) {
      skipped.tooLarge += 1
      continue
    }
    if (text.slice(0, BINARY_SNIFF_CHARS).includes('\u0000')) {
      skipped.binary += 1
      continue
    }

    filesScanned += 1
    bytes += file.size ?? text.length
    const { lines, hits } = matchLines(text, { query, caseSensitive }, regex)
    let contributed = false
    for (const line of hits) {
      if (matches.length >= limit) {
        stoppedAtLimit = true
        break
      }
      const { before, after } = contextRows(lines, line, context)
      matches.push({
        file: file.rel,
        line,
        text: clip((lines[line - 1] ?? '').trim(), MAX_MATCH_LINE),
        before,
        after,
      })
      contributed = true
    }
    if (contributed) filesMatched += 1
    if (stoppedAtLimit) break
  }

  matches.sort((a, b) => byteOrder(a.file, b.file) || a.line - b.line)

  const head = `grep ${JSON.stringify(query)}${request.glob ? ` in ${request.glob}` : ''} — ${matches.length}${stoppedAtLimit ? '+' : ''} match(es), ${filesMatched} file(s), ${filesScanned} scanned, ${bytes} bytes`
  const blocks = matches.map((match) => {
    const rows = []
    for (const row of match.before) rows.push(`${match.file}-${row.line}- ${row.text}`)
    rows.push(`${match.file}:${match.line}: ${match.text}`)
    for (const row of match.after) rows.push(`${match.file}-${row.line}- ${row.text}`)
    return rows.join('\n')
  })

  const shownBlocks = []
  let used = Math.min(head.length, budget)
  for (const block of blocks) {
    if (used + 1 + block.length > budget) break
    shownBlocks.push(block)
    used += 1 + block.length
  }
  const text = used > budget ? head.slice(0, budget) : shownBlocks.length === 0 ? head : `${head}\n${shownBlocks.join('\n')}`

  const omittedMatches = matches.length - shownBlocks.length
  const capped = matches.length >= limit
  const omissions = []
  if (omittedMatches > 0) omissions.push(`${omittedMatches} matching line(s) omitted from the text at budget ${budget}`)
  if (stoppedAtLimit) omissions.push(`search stopped at the ${limit}-match limit; later files were not scanned`)
  else if (capped) omissions.push(`the ${limit}-match limit was reached; later matches, if any, were not scanned`)

  const result = {
    ok: true,
    mode: 'grep',
    query,
    matches,
    filesScanned,
    filesMatched,
    truncated: stoppedAtLimit || capped || omittedMatches > 0,
    bytes,
    text,
  }
  if (omissions.length > 0) result.omitted = omissions.join('; ')
  if (skipped.binary + skipped.tooLarge + skipped.unreadable > 0) result.skipped = skipped
  return result
}
