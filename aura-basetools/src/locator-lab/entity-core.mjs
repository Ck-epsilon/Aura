/**
 * entity-core.mjs — entity-first addresses: resolve a selector, view one entity, rename its tokens.
 *
 * WHERE TO CHANGE:
 *   resolveEntity — selector shapes, struct-core error mapping, the entity record itself
 *   entityView — what a read receipt shows (definition, references, budget, evidence)
 *   entityRenameHunks — span/file rename rules and line hunk shape
 *   entityToStructureHunk — the replace-body handoff to the apply layer
 *
 * USED BY:
 *   (wiring layer: read/apply; no call sites yet)
 */

import { LANGS, indexStructure, langOf, resolveTarget } from './struct-core.mjs'
import { fnv1a32 } from './handle-core.mjs'

// ── limits ──

const DEFAULT_BUDGET = 7600
const MAX_REFERENCES = 40
const MAX_REFERENCE_LINE = 240
const MAX_SIGNATURE_CHARS = 400
const SELECTOR_KINDS = new Set(['symbol', 'function', 'class', 'method', 'variable'])

// ── language ──

/**
 * `lang` may be a struct-core language key (`'js'`, `'.ts'`), a language object, or omitted.
 * Omitted/unknown falls back to the extension of `filePath`.
 */
function languageConfig(lang, filePath) {
  if (lang !== null && typeof lang === 'object' && Array.isArray(lang.rules)) return lang
  if (typeof lang === 'string' && lang.length > 0) {
    const key = lang.startsWith('.') ? lang.slice(1) : lang
    return LANGS[key] ?? langOf(`file.${key}`) ?? langOf(filePath ?? '')
  }
  return langOf(filePath ?? '')
}

// ── errors ──

function entityError(code, message, candidates = []) {
  return { ok: false, code, message, candidates }
}

/** struct-core throws; the entity layer returns. Matching still happens in struct-core. */
function mapResolveError(err, index, file, methodOnly) {
  const candidates = Array.isArray(err?.candidates) ? err.candidates : []
  if (err?.code === 'STRUCT_AMBIGUOUS') {
    const filtered = methodOnly ? candidates.filter((c) => c.enclosing !== null && c.enclosing !== undefined) : candidates
    if (methodOnly && filtered.length === 1) {
      const c = filtered[0]
      const symbol = index.symbols.find(
        (s) =>
          s.name === c.name &&
          s.kind === c.kind &&
          (s.enclosing ?? null) === c.enclosing &&
          s.startLine === c.startLine &&
          s.endLine === c.endLine,
      )
      if (symbol !== undefined) return { ok: true, entity: makeEntity(symbol, index, file) }
    }
    return entityError(
      'ENTITY_AMBIGUOUS',
      err.message,
      filtered.map((c) => ({ ...c, file })),
    )
  }
  return entityError('ENTITY_NOT_FOUND', err?.message ?? 'selector did not resolve', [])
}

// ── selectors ──

const slash = (p) => String(p).replaceAll('\\', '/')

/**
 * Normalize both selector forms into one struct-core target.
 * `symbol:` is the entity layer's "any kind" spelling; struct-core has no such kind, so it is stripped.
 * `method:` has no struct-core kind either: it resolves as `function:` and must sit inside an enclosing symbol.
 */
function parseSelector(selector) {
  if (typeof selector === 'string') {
    const raw = selector.trim()
    if (raw.length === 0) return { ok: false, error: entityError('ENTITY_NOT_FOUND', 'empty selector', []) }
    if (raw.startsWith('symbol:')) return { ok: true, target: raw.slice('symbol:'.length), file: null, methodOnly: false }
    if (raw.startsWith('method:')) return { ok: true, target: `function:${raw.slice('method:'.length)}`, file: null, methodOnly: true }
    return { ok: true, target: raw, file: null, methodOnly: false }
  }
  if (selector === null || typeof selector !== 'object') {
    return { ok: false, error: entityError('ENTITY_NOT_FOUND', 'selector must be a string or {kind,name,file}', []) }
  }
  const name = typeof selector.name === 'string' ? selector.name.trim() : ''
  const kind = selector.kind ?? 'symbol'
  if (name.length === 0) return { ok: false, error: entityError('ENTITY_NOT_FOUND', 'selector.name is required', []) }
  if (!SELECTOR_KINDS.has(kind)) {
    return {
      ok: false,
      error: entityError('ENTITY_NOT_FOUND', `unsupported selector kind ${JSON.stringify(kind)}`, []),
    }
  }
  const file = typeof selector.file === 'string' ? selector.file : null
  if (kind === 'symbol') return { ok: true, target: name, file, methodOnly: false }
  if (kind === 'method') return { ok: true, target: `function:${name}`, file, methodOnly: true }
  return { ok: true, target: `${kind}:${name}`, file, methodOnly: false }
}

// ── entity record ──

const sourceLines = (source) => source.split(/\r?\n/)

function signatureOf(symbol, index, lines) {
  // `bodyOpen` is the body opener for brace languages; indent/terminator languages have no
  // separate header token stored, so their signature is the declaration line only.
  const bodyTok = symbol.bodyOpen
  let endLine = symbol.startLine
  if (Number.isInteger(bodyTok) && bodyTok >= 0 && index.tokens[bodyTok] !== undefined) {
    endLine = index.lineAt(index.tokens[bodyTok].start)
  }
  endLine = Math.max(symbol.startLine, Math.min(endLine, symbol.endLine))
  const text = lines
    .slice(symbol.startLine - 1, endLine)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')
  return text.length > MAX_SIGNATURE_CHARS ? `${text.slice(0, MAX_SIGNATURE_CHARS)} ⋯` : text
}

/** `Outer/Inner` when nested: that is the spelling struct-core resolves without a near hint. */
function qualifiedName(symbol) {
  return symbol.enclosing === null || symbol.enclosing === undefined ? symbol.name : `${symbol.enclosing}/${symbol.name}`
}

function spanText(symbol, lines) {
  return lines.slice(symbol.startLine - 1, symbol.endLine).join('\n')
}

function makeEntity(symbol, index, file) {
  const lines = sourceLines(index.src)
  const qualified = qualifiedName(symbol)
  return {
    id: `${file ?? '<unknown>'}#${symbol.startLine}-${symbol.endLine}:${symbol.kind}:${symbol.name}`,
    file: file ?? null,
    kind: symbol.kind,
    name: symbol.name,
    enclosing: symbol.enclosing ?? null,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    signature: signatureOf(symbol, index, lines),
    structureTarget: `symbol:${qualified}`,
    evidence: {
      contentHash: fnv1a32(index.src),
      spanHash: fnv1a32(spanText(symbol, lines)),
    },
  }
}

// ── resolve ──

/**
 * Resolve one selector against one file's structure index.
 * `index.file` (optional) makes `selector.file` checkable; the wiring layer may attach it.
 */
export function resolveEntity(index, selector) {
  const parsed = parseSelector(selector)
  if (parsed.ok === false) return parsed.error
  if (parsed.file !== null && index.file !== undefined && index.file !== null && slash(parsed.file) !== slash(index.file)) {
    return entityError(
      'ENTITY_NOT_FOUND',
      `selector targets ${parsed.file}, but this index is ${index.file}`,
      [],
    )
  }
  const file = parsed.file ?? index.file ?? null

  let hit
  try {
    hit = resolveTarget(index, parsed.target)
  } catch (err) {
    return mapResolveError(err, index, file, parsed.methodOnly)
  }
  if (parsed.methodOnly && (hit.enclosing === null || hit.enclosing === undefined)) {
    return entityError('ENTITY_NOT_FOUND', `"${hit.name}" is not inside an enclosing symbol, so it is not a method`, [])
  }
  return { ok: true, entity: makeEntity(hit, index, file) }
}

// ── references ──

/**
 * Same-file lexical references from the token stream (tokens already exclude comments and strings).
 * One entry per line; the declaration token itself is not a reference.
 */
function referencesFor(index, symbol) {
  const lines = sourceLines(index.src)
  const declaration = index.tokens[symbol.startTok]
  const seen = new Set()
  let total = 0
  const kept = []
  for (const token of index.tokens) {
    if (token.type !== 'ident' || token.value !== symbol.name) continue
    if (declaration !== undefined && token.start === declaration.start && token.end === declaration.end) continue
    if (seen.has(token.line)) continue
    seen.add(token.line)
    total += 1
    if (kept.length >= MAX_REFERENCES) continue
    const raw = (lines[token.line - 1] ?? '').trim()
    kept.push({
      line: token.line,
      text: raw.length > MAX_REFERENCE_LINE ? `${raw.slice(0, MAX_REFERENCE_LINE)} ⋯` : raw,
      resolution: 'lexical',
    })
  }
  return { kept, total }
}

// ── view ──

export function entityView({
  filePath,
  source,
  lang,
  selector,
  budget = DEFAULT_BUDGET,
  version,
} = {}) {
  if (typeof source !== 'string') {
    return { ok: false, code: 'ENTITY_BAD_SOURCE', message: 'entityView needs the source text', candidates: [] }
  }
  const config = languageConfig(lang, filePath)
  if (config === null || config === undefined) {
    return { ok: false, code: 'ENTITY_NO_LANGUAGE', message: `no language for ${filePath ?? 'the source'}`, candidates: [] }
  }

  const index = { ...indexStructure(source, config), file: filePath ?? null }
  const resolved = resolveEntity(index, selector)
  if (resolved.ok !== true) return resolved
  const entity = resolved.entity

  const symbol = index.symbols.find(
    (s) =>
      s.name === entity.name &&
      s.kind === entity.kind &&
      (s.enclosing ?? null) === entity.enclosing &&
      s.startLine === entity.startLine &&
      s.endLine === entity.endLine,
  )
  const lines = sourceLines(source)
  const body = symbol === undefined ? '' : spanText(symbol, lines)
  const { kept, total } = symbol === undefined ? { kept: [], total: 0 } : referencesFor(index, symbol)

  const limit = Number.isInteger(budget) && budget > 0 ? budget : DEFAULT_BUDGET
  const fileLabel = filePath ?? '<unknown>'
  const head = `entity ${entity.kind} ${entity.name} · ${fileLabel}:${entity.startLine}-${entity.endLine}`
  const omissions = []

  let text = head
  let shownBody = body
  const bodyRoom = limit - text.length - 1
  if (shownBody.length > bodyRoom) {
    // Reserve the marker's own width, then recompute after the omitted-count digits change.
    let omitted = shownBody.length
    let suffix = ` ⋯ [body clipped, ${omitted} chars omitted]`
    let keptChars = Math.max(0, bodyRoom - suffix.length)
    omitted = Math.max(0, shownBody.length - keptChars)
    suffix = ` ⋯ [body clipped, ${omitted} chars omitted]`
    if (keptChars + suffix.length > bodyRoom) {
      keptChars = Math.max(0, bodyRoom - suffix.length)
      omitted = Math.max(0, shownBody.length - keptChars)
      suffix = ` ⋯ [body clipped, ${omitted} chars omitted]`
    }
    shownBody = `${shownBody.slice(0, keptChars)}${suffix}`
    omissions.push(`body clipped to the ${limit}-char budget (${omitted} chars omitted)`)
  }
  text += `\n${shownBody}`

  let shown = 0
  if (total > 0) {
    const section = `\n\nreferences ${kept.length}/${total}`
    for (const reference of kept) {
      const row = `\n  ${reference.line}: ${reference.text}`
      if (text.length + section.length + row.length > limit) break
      if (shown === 0) text += section
      text += row
      shown += 1
    }
  }
  if (text.length > limit) text = text.slice(0, limit)

  const references = kept.slice(0, shown)
  if (kept.length < total) omissions.push(`${total - kept.length} reference line(s) beyond the ${MAX_REFERENCES}-reference cap`)
  if (shown < kept.length) omissions.push(`${kept.length - shown} reference line(s) omitted from the text at budget ${limit}`)

  return {
    ok: true,
    entity,
    // body is the exact entity span (signature included); signature is its compact header.
    definition: { signature: entity.signature, body, startLine: entity.startLine, endLine: entity.endLine },
    references,
    evidence: { version: version ?? null, contentHash: entity.evidence.contentHash, spanHash: entity.evidence.spanHash },
    text,
    ...(shown < total ? { referencesOmitted: { total, shown, cap: MAX_REFERENCES } } : {}),
    ...(omissions.length > 0 ? { omitted: omissions.join('; ') } : {}),
  }
}

// ── rename ──

/** 1-based line start offsets; `\r` stays out of the hunk text but inside source offsets. */
function lineIndex(source) {
  const starts = [0]
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') starts.push(i + 1)
  const textOf = (line) => {
    const start = starts[line - 1]
    if (start === undefined) return ''
    let end = line < starts.length ? starts[line] - 1 : source.length
    if (end > start && source[end - 1] === '\r') end -= 1
    return source.slice(start, end)
  }
  return { starts, textOf }
}

/**
 * Token-aware rename. Only `ident` tokens whose value is exactly `name` are rewritten.
 * scope `span` = resolved symbol's startLine..endLine; scope `file` = the whole file.
 */
export function entityRenameHunks({ source, lang, name, newName, scope = 'span' } = {}) {
  if (typeof source !== 'string') {
    return { ok: false, code: 'ENTITY_BAD_REQUEST', message: 'source must be a string' }
  }
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, code: 'ENTITY_BAD_REQUEST', message: 'name must be a non-empty string' }
  }
  if (typeof newName !== 'string' || newName.length === 0) {
    return { ok: false, code: 'ENTITY_BAD_REQUEST', message: 'newName must be a non-empty string' }
  }
  if (scope !== 'span' && scope !== 'file') {
    return { ok: false, code: 'ENTITY_BAD_REQUEST', message: 'scope must be "span" or "file"' }
  }
  const config = languageConfig(lang, null)
  if (config === null || config === undefined) {
    return { ok: false, code: 'ENTITY_NO_LANGUAGE', message: 'no language for this source' }
  }

  const index = indexStructure(source, config)
  let definition
  try {
    definition = resolveTarget(index, name)
  } catch (err) {
    const mapped = mapResolveError(err, index, index.file ?? null, false)
    return mapped.ok === true ? mapped : { ok: false, code: mapped.code, message: mapped.message, candidates: mapped.candidates }
  }

  const { starts, textOf } = lineIndex(source)
  const lastLine = starts.length
  const first = scope === 'file' ? 1 : definition.startLine
  const last = scope === 'file' ? lastLine : definition.endLine
  if (newName === name) return { ok: true, scope, hunks: [] }

  const columnsByLine = new Map()
  for (const token of index.tokens) {
    if (token.type !== 'ident' || token.value !== name) continue
    if (token.line < first || token.line > last) continue
    if (starts[token.line - 1] === undefined) continue
    const column = token.start - starts[token.line - 1]
    if (!Number.isFinite(column) || column < 0) continue
    if (!columnsByLine.has(token.line)) columnsByLine.set(token.line, [])
    columnsByLine.get(token.line).push(column)
  }

  const hunks = []
  for (const line of [...columnsByLine.keys()].sort((a, b) => a - b)) {
    const oldLine = textOf(line)
    let replaced = oldLine
    const columns = [...new Set(columnsByLine.get(line))].sort((a, b) => b - a)
    for (const column of columns) {
      replaced = replaced.slice(0, column) + newName + replaced.slice(column + name.length)
    }
    if (replaced !== oldLine) hunks.push({ lines: [line, line], expect: oldLine, replace: replaced })
  }
  return { ok: true, scope, hunks }
}

// ── apply handoff ──

/**
 * Replace-body address for the apply layer. The structure label mirrors entity.structureTarget
 * (`symbol:<name>`, or `symbol:<Outer>/<Inner>` when nested), so callers never rebuild it.
 */
export function entityToStructureHunk(selectorEntity, replacement) {
  const structure =
    typeof selectorEntity?.structureTarget === 'string'
      ? selectorEntity.structureTarget
      : `symbol:${selectorEntity?.enclosing ? `${selectorEntity.enclosing}/` : ''}${selectorEntity?.name ?? ''}`
  if (structure === 'symbol:') {
    throw Object.assign(new Error('entityToStructureHunk needs an entity with a name'), { code: 'ENTITY_BAD_SELECTOR' })
  }
  return { structure, replace: replacement }
}
