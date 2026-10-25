/**
 * doc-structure.mjs —— 文档 / 配置的结构目录（`map` 用）。
 *
 * ## 为什么需要它
 *
 * `map` 现在只认代码扩展名；`.md` / `.json` / `.yaml` / `.toml` 一律回一句
 * “unsupported extension — no symbol index”。而实测最近 62 个会话里 **1,836 次 read**
 * 有 330 次 `.md`（18%）、55 次 `.json`、13 次 `.yml`——约 22% 的目标是文档/配置，
 * 它们拿到的地图是一句拒绝。
 *
 * ## 为什么不是“再写一个解析器”
 *
 * 这层的目标不是完整语法，而是**目录**：给出行号、层级与名字，让人能挑一段用
 * `mode=lines` 取回。所以：
 *   · Markdown：ATX 标题（跳过围栏代码块里的 `#`）；setext 标题不认（降级为正文）。
 *   · JSON：字符串/注释感知的轻量扫描，给对象键与数组元素；解析不完整时**降级**而不是抛。
 *   · YAML：缩进 + `key:` 行；锚点/多行块不展开（目录仍然可用）。
 *   · TOML：`[table]` 与 `key =` 行。
 *
 * 每条 entry 都有 `startLine` / `endLine`：目录本身要可执行（下一步是 `mode=lines`）。
 */

/** 扩展名 → 文档种类。故意不含 `.txt`：纯文本没有结构，给了目录也是假的。 */
export const DOC_KINDS = {
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
}

/** `filePath` 的扩展名决定用哪套结构索引；不是文档类型返回 null。 */
export function docKindOf(filePath) {
  if (typeof filePath !== 'string') return null
  const dot = filePath.lastIndexOf('.')
  if (dot < 0) return null
  const ext = filePath.slice(dot + 1).toLowerCase()
  return DOC_KINDS[ext] ?? null
}

/**
 * 索引一篇文档。
 *
 * @returns {{entries: Array<{name:string, kind:string, depth:number, startLine:number, endLine:number}>, unit:string, note?:string}}
 */
export function indexDocument(source, docKind) {
  const lines = String(source).split(/\r?\n/)
  if (docKind === 'markdown') return indexMarkdown(lines)
  if (docKind === 'json') return indexJson(String(source), lines)
  if (docKind === 'yaml') return indexYaml(lines)
  if (docKind === 'toml') return indexToml(lines)
  return { entries: [], unit: 'entries', note: `no structure index for ${docKind}` }
}

/* ── Markdown ─────────────────────────────────────────────────────────────── */

function indexMarkdown(lines) {
  const entries = []
  let fence = null
  /** YAML front matter：只在第 1 行 `---` 起算，到下一个 `---` / `...` 结束。 */
  let frontMatter = false
  /**
   * 上一行是否是一个“可以升级为 setext 标题的段落行”。
   *
   * 为什么不能只看“下一行是不是 `===`/`---`”：`---` 同时是**分隔线**、也是 YAML
   * front matter 的边界。CommonMark 的消歧规则是：setext 下划线只能接在**段落**后面
   * （列表项、引用、缩进代码、标题、分隔线都不行），而分隔线前面又必须是空行。
   * 所以这里维护一个“上一行是段落行”的状态，而不是做简单的向前看。
   */
  let paragraph = -1
  /** 当前段落的起始行：setext 标题取的是**整段**，不是最后一行（CommonMark）。 */
  let paragraphStart = -1
  const isParagraph = (line) => {
    if (line.trim() === '') return false
    if (/^\s{4,}/.test(line)) return false // 缩进代码块
    if (/^\s*>/.test(line)) return false // 引用
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) return false // 列表项
    if (/^\s*(```+|~~~+)/.test(line)) return false
    if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) return false // ATX 标题
    if (/^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) return false // 分隔线
    if (/^\s*<[^>]+>/.test(line)) return false // HTML 块（粗略）
    return true
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (i === 0 && /^---\s*$/.test(line)) {
      frontMatter = true
      continue
    }
    if (frontMatter) {
      if (/^(?:---|\.\.\.)\s*$/.test(line)) frontMatter = false
      continue
    }
    const fenceHit = /^\s*(```+|~~~+)/.exec(line)
    if (fenceHit !== null) {
      const mark = fenceHit[1][0]
      if (fence === null) fence = mark
      else if (fence === mark) fence = null
      paragraph = -1
      continue
    }
    if (fence !== null) continue
    // setext：上一行是段落 ⇒ 本行是它的下划线（`=` 一级，`-` 二级）
    const setext = /^ {0,3}(=+|-+)\s*$/.exec(line)
    if (setext !== null && paragraph === i - 1) {
      // 多行段落 → 标题文本是整段（行间用空格接起来），区间从段首算起。
      const name = lines.slice(paragraphStart, paragraph + 1).map((row) => row.trim()).filter(Boolean).join(' ')
      entries.push({
        kind: 'heading',
        name: name || '(untitled)',
        depth: setext[1][0] === '=' ? 1 : 2,
        startLine: paragraphStart + 1,
        endLine: i + 1,
      })
      paragraph = -1
      paragraphStart = -1
      continue
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading !== null) {
      entries.push({
        kind: 'heading',
        name: heading[2].length === 0 ? '(untitled)' : heading[2],
        depth: heading[1].length,
        startLine: i + 1,
        endLine: i + 1,
      })
      paragraph = -1
      paragraphStart = -1
      continue
    }
    if (isParagraph(line)) {
      // 连续段落行：保持 paragraphStart，直到段落被中断。
      // 注意 `paragraph === -1` 与“上一行正好是 -1”会撞车（第 1 行时 i-1 也是 -1），
      // 所以用 paragraphStart 的哨兵值把“段落还没开始”区分开。
      if (paragraphStart === -1 || paragraph !== i - 1) paragraphStart = i
      paragraph = i
    } else {
      paragraph = -1
      paragraphStart = -1
    }
  }
  // 每节的范围 = 到下一个标题（任意层级）之前；最后一节到文件尾。
  for (let k = 0; k < entries.length; k += 1) entries[k].endLine = (entries[k + 1]?.startLine ?? lines.length + 1) - 1
  return { entries, unit: 'sections' }
}

/* ── JSON / JSONC ─────────────────────────────────────────────────────────── */

/**
 * 轻量扫描：不建 AST，只记录“键/元素在哪几行”。
 *
 * 关键取舍：**不抛**。配置里出现尾逗号、注释、甚至半份文件时，已经扫到的目录仍然有用，
 * 比一句“解析失败”有用得多；扫不动的部分在 `note` 里说。
 */
function indexJson(source, lines) {
  const entries = []
  /** 每层容器记自己的目录项（由父层创建）；闭合时把它的 endLine 收到闭合行。 */
  const stack = [] // { type:'object'|'array', path:string, entry:entry|null, index:number }
  let i = 0
  let line = 1
  let note = null
  let expectKey = false
  let pendingKey = null
  let pendingKeyLine = 0

  /**
   * 键里有 `.` / 空格 / `[` 时不能拼成 `a.b`（`exports."."` 会读成 `exports..`——实测就撞上了）：
   * 改用 `parent["key"]`，与 JS/JSONPath 的习惯一致。
   */
  const seg = (key) => (/^[A-Za-z0-9_$-]+$/.test(key) ? key : `[${JSON.stringify(key)}]`)
  const pathOf = (parent, key) => (parent === '' ? seg(key) : `${parent}${seg(key).startsWith('[') ? seg(key) : `.${seg(key)}`}`)
  const add = (entry) => {
    entries.push(entry)
    return entry
  }
  const skipTrivia = () => {
    while (i < source.length) {
      const c = source[i]
      if (c === '\n') {
        line += 1
        i += 1
      } else if (c === ' ' || c === '\t' || c === '\r') {
        i += 1
      } else if (c === '/' && source[i + 1] === '/') {
        while (i < source.length && source[i] !== '\n') i += 1
      } else if (c === '/' && source[i + 1] === '*') {
        i += 2
        while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
          if (source[i] === '\n') line += 1
          i += 1
        }
        i += 2
      } else break
    }
  }
  const readString = (quote = '"') => {
    // 调用方已在引号上
    const startLine = line
    i += 1
    let value = ''
    while (i < source.length) {
      const c = source[i]
      if (c === '\\') {
        value += source[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === quote) {
        i += 1
        return { value, line: startLine }
      }
      if (c === '\n') line += 1
      value += c
      i += 1
    }
    note = note ?? 'unterminated string — the directory stops where the text does'
    return { value, line: startLine }
  }

  while (i < source.length) {
    skipTrivia()
    if (i >= source.length) break
    const c = source[i]
    const top = stack[stack.length - 1]
    if (c === '{' || c === '[') {
      const isObject = c === '{'
      const name = top === undefined
        ? ''
        : top.type === 'array'
          ? `${top.path}[${top.index}]`
          : pathOf(top.path, pendingKey ?? '?')
      const ownEntry = top === undefined
        ? null
        : add({ kind: isObject ? 'object' : 'array', name, depth: stack.length + 1, startLine: line, endLine: line })
      stack.push({ type: isObject ? 'object' : 'array', path: name, entry: ownEntry, index: 0 })
      expectKey = isObject
      pendingKey = null
      i += 1
      continue
    }
    if (c === '}' || c === ']') {
      const closed = stack.pop()
      if (closed !== undefined && closed.entry !== null && closed.entry !== undefined) closed.entry.endLine = line
      expectKey = stack.length > 0 && stack[stack.length - 1].type === 'object'
      i += 1
      continue
    }
    if (c === ',') {
      expectKey = top !== undefined && top.type === 'object'
      pendingKey = null
      if (top !== undefined && top.type === 'array') top.index += 1
      i += 1
      continue
    }
    if (c === ':') {
      i += 1
      continue
    }
    /**
     * JSON5：无引号键（`{name: 1}`）。必须在“标量跳过”之前认，否则整个 `name: 1`
     * 会被当成标量吞到下一个逗号，目录里就少了这个键。
     */
    if (expectKey && /[A-Za-z_$]/.test(c)) {
      let key = ''
      while (i < source.length && /[A-Za-z0-9_$]/.test(source[i])) {
        key += source[i]
        i += 1
      }
      pendingKey = key
      pendingKeyLine = line
      expectKey = false
      continue
    }
    if (c === '"' || c === "'") {
      const str = readString(c)
      if (expectKey) {
        pendingKey = str.value
        pendingKeyLine = str.line
        expectKey = false
      } else if (top !== undefined && top.type === 'object' && pendingKey !== null) {
        // 对象键的值是字符串：目录行就是键所在的那一行（与标量值同一条规则）。
        add({ kind: 'key', name: pathOf(top.path, pendingKey), depth: stack.length, startLine: pendingKeyLine, endLine: str.line })
        pendingKey = null
      } else if (top !== undefined && top.type === 'array') {
        // 数组里的字符串元素：只有对象/数组元素才值得进目录；标量元素跳过。
        top.index += 1
      }
      continue
    }
    // 标量：跳过到下一个分隔符
    while (i < source.length && !',}]'.includes(source[i])) {
      if (source[i] === '\n') line += 1
      i += 1
    }
    if (top !== undefined && top.type === 'object' && pendingKey !== null) {
      // 对象键的值是标量：目录行就是键所在行
      add({ kind: 'key', name: pathOf(top.path, pendingKey), depth: stack.length, startLine: pendingKeyLine, endLine: line })
      pendingKey = null
    } else if (top !== undefined && top.type === 'array') {
      top.index += 1
    }
  }
  if (stack.length > 0) note = note ?? 'the document ends inside an open container — the directory is partial'
  return { entries, unit: 'keys', ...(note === null ? {} : { note }) }
}

/* ── YAML ─────────────────────────────────────────────────────────────────── */

function indexYaml(lines) {
  const entries = []
  const stack = [] // { indent, name }
  let blockScalarIndent = null
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    if (raw.trim() === '' || /^\s*#/.test(raw)) continue
    const indent = raw.length - raw.trimStart().length
    if (blockScalarIndent !== null && indent > blockScalarIndent) continue
    blockScalarIndent = null
    if (/^---(\s|$)/.test(raw) || /^\.\.\.(\s|$)/.test(raw)) {
      stack.length = 0
      continue
    }
    const body = raw.trimStart()
    const match = /^(-\s+)?([^#\s][^:]*?):(\s|$)/.exec(body)
    if (match === null) continue
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
    const key = match[2]
    const path = stack.length === 0 ? key : `${stack[stack.length - 1].name}.${key}`
    const entry = { kind: 'key', name: path, depth: stack.length + 1, startLine: i + 1, endLine: i + 1 }
    entries.push(entry)
    // 值是否是多行块标量：`key: |` / `key: >`
    if (/\s[|>][-+]?\s*$/.test(body)) blockScalarIndent = indent
    stack.push({ indent, name: path })
  }
  // 一节的范围 = 到**下一个同级或更高级**的键之前（中间的深一级键属于它）。
  for (let k = 0; k < entries.length; k += 1) {
    let j = k + 1
    while (j < entries.length && entries[j].depth > entries[k].depth) j += 1
    entries[k].endLine = j < entries.length ? Math.max(entries[k].startLine, entries[j].startLine - 1) : lines.length
  }
  return { entries, unit: 'keys' }
}

/* ── TOML ─────────────────────────────────────────────────────────────────── */

function indexToml(lines) {
  const entries = []
  let table = ''
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (line === '' || line.startsWith('#')) continue
    const tableHit = /^\[\[?([^\]]+)\]\]?$/.exec(line)
    if (tableHit !== null) {
      table = tableHit[1].trim()
      entries.push({ kind: 'table', name: table, depth: table.split('.').length, startLine: i + 1, endLine: i + 1 })
      continue
    }
    const keyHit = /^([A-Za-z0-9_.-]+)\s*=/.exec(line)
    if (keyHit !== null) {
      const name = table === '' ? keyHit[1] : `${table}.${keyHit[1]}`
      entries.push({ kind: 'key', name, depth: name.split('.').length, startLine: i + 1, endLine: i + 1 })
    }
  }
  /**
   * TOML 的范围规则与 YAML 不同：表（`[a.b]`）是扁平段，深度按点名数算，
   * 但 `[db.pool]` 与 `[server]` 是**同级**——它们之间没有父子关系。
   * 所以：表到下一张表之前；键只占自己那一行（多行值不进目录，mode=lines 拿）。
   */
  for (let k = 0; k < entries.length; k += 1) {
    if (entries[k].kind !== 'table') continue
    let j = k + 1
    while (j < entries.length && entries[j].kind !== 'table') j += 1
    entries[k].endLine = j < entries.length ? Math.max(entries[k].startLine, entries[j].startLine - 1) : lines.length
  }
  return { entries, unit: 'keys' }
}

