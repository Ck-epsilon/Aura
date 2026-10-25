/**
 * doc-map-test —— 文档 / 配置的结构目录（`mode=map`）。
 *
 * ## 为什么有这份判据
 *
 * 实测最近 62 个会话 / 1,836 次 read：`.md` 330 次（18%）、`.json` 55、`.yml` 13——
 * 约 22% 的读取目标是文档/配置，而旧 `map` 对它们统一回一句 “unsupported extension”。
 *
 * ## 判据钉什么
 *
 *   · 目录必须**可执行**：每条 entry 都有行号区间，下一步能用 `mode=lines` 取回；
 *   · 层级要对（`db.host` 属于 `db`），区间要对（`db` 到下一个同级键之前）；
 *   · 坏输入**降级而不是抛**：半份 JSON 仍然给出已扫到的目录 + note；
 *   · 纯文本（.txt）保持原样的“没有结构”拒绝——给了目录也是假的。
 *
 * 运行：node src/locator-lab/doc-map-test.mjs
 */
import { createMemoryStore, readWith, setObservationStore } from './read-core.mjs'
import { docKindOf, indexDocument } from './doc-structure.mjs'

setObservationStore(createMemoryStore())

const results = []
const say = (line = '') => console.log(line)
const check = (ok, label, detail = '') => {
  results.push({ ok: Boolean(ok), label })
  say(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}
const mapOf = (filePath, source, extra = {}) => readWith(source, { filePath, mode: 'map', ...extra })

// ── A. Markdown ─────────────────────────────────────────────────────────────
say('=== A. Markdown：标题树与节区间 ===')
{
  const md = ['# Title', '', 'intro', '', '## Install', '', 'run it', '', '```', '# not a heading', '```', '', '### Windows', '', 'steps', '', '## Usage', '', 'body', ''].join('\n')
  const map = mapOf('/tmp/doc.md', md)
  check(map.ok === true && map.mode === 'map', 'A1 map 成功')
  check(docKindOf('/tmp/doc.md') === 'markdown', 'A2 .md 被认成 markdown')
  check(typeof map.text === 'string' && map.text.includes('4 sections'), 'A3 标题计数 = 4（围栏里的 # 不算）', String(map.text).split('\n')[0])
  check(map.text.includes('Title  1-4'), 'A4 一级标题区间 1-4')
  check(map.text.includes('  Install  5-12'), 'A5 二级标题缩进 + 区间 5-12', String(map.text).split('\n')[2])
  check(map.text.includes('    Windows  13-16'), 'A6 三级标题缩进两层')
  check(!map.text.includes('not a heading'), 'A7 围栏代码块里的 # 不进目录')
  check(map.symbols === 4 && map.shown === 4, `A8 symbols/shown = 4（${map.symbols}/${map.shown}）`)
  const filtered = mapOf('/tmp/doc.md', md, { kind: 'heading' })
  check(filtered.ok === true && filtered.symbols === 4, 'A9 kind=heading 过滤后仍是 4 节')
}

// ── A2. setext 标题与区块状态 ───────────────────────────────────────────────
say('')
say('=== A2. setext 标题（=== / ---）与 front matter / 分隔线的消歧 ===')
{
  const setext = ['Title', '=====', '', 'Section', '---', '', 'body', ''].join('\n')
  const map = mapOf('/tmp/setext.md', setext)
  check(map.ok === true && map.text.includes('Title  1-3'), 'A2-1 `=` 下划线 ⇒ 一级标题（节 1-3）', String(map.text).split('\n')[1])
  check(map.text.includes('  Section  4-8'), 'A2-2 `---` 下划线 ⇒ 二级标题（节到文件尾 4-8）', String(map.text).split('\n')[2])

  const front = ['---', 'title: x', '---', '# A', '', 'text'].join('\n')
  const fm = mapOf('/tmp/front.md', front)
  check(fm.ok === true && fm.text.includes('A  4-6') && !fm.text.includes('title: x'), 'A2-3 YAML front matter 不被当成标题', String(fm.text).split('\n')[1])

  const breaks = ['para', '', '---', 'more', ''].join('\n')
  const br = mapOf('/tmp/breaks.md', breaks)
  check(br.ok === true && /no sections found/.test(String(br.text)), 'A2-4 空行后的 `---` 是分隔线，不是标题', String(br.text))

  const fenced = ['```', 'Title', '=====', '```', '# Real'].join('\n')
  const fen = mapOf('/tmp/fenced.md', fenced)
  check(fen.ok === true && fen.symbols === 1 && fen.text.includes('Real'), 'A2-5 围栏里的 setext 不算标题', String(fen.text).split('\n')[1])

  const multi = ['Foo', 'bar', '===', '', 'body', ''].join('\n')
  const ml = mapOf('/tmp/multi.md', multi)
  check(ml.ok === true && ml.text.includes('Foo bar  1-6'), 'A2-6 多行段落的 setext：整段成为标题（Foo bar，节到文件尾 1-6）', String(ml.text).split('\n')[1])
}

// ── B. JSON / JSONC ─────────────────────────────────────────────────────────
say('')
say('=== B. JSON：键路径、缩进、区间；坏输入降级 ===')
{
  const json = '{\n  "name": "demo",\n  "db": {\n    "host": "localhost",\n    "port": 5432\n  },\n  "tags": ["a", "b"]\n}\n'
  const map = mapOf('/tmp/conf.json', json)
  check(map.ok === true && docKindOf('/tmp/conf.json') === 'json', 'B1 .json 被认成 json 且 map 成功')
  check(map.text.includes('name  2-2'), 'B2 字符串键 name 2-2')
  check(map.text.includes('  db  3-6'), 'B3 对象键 db 3-6（到闭合括号）')
  check(map.text.includes('  db.host  4-4'), 'B4 嵌套键 db.host 4-4')
  check(map.text.includes('  tags  7-7'), 'B5 数组键 tags 7-7')

  const min = mapOf('/tmp/min.json', '{"a":{"b":1},"c":[1,2,3]}')
  check(min.ok === true && min.text.includes('a.b'), 'B6 单行 JSON 也能给出路径（a.b）', String(min.text).split('\n').slice(0, 3).join(' | '))

  const jsonc = mapOf('/tmp/c.jsonc', '{\n  // comment\n  "a": 1, /* block */\n  "b": [ {"x": 1} ]\n}\n')
  check(jsonc.ok === true && jsonc.text.includes('a  3-3') && jsonc.text.includes('b[0].x'), 'B7 JSONC 注释被跳过，数组元素 b[0].x 进目录', String(jsonc.text).split('\n').slice(0, 5).join(' | '))

  const broken = mapOf('/tmp/broken.json', '{\n  "a": 1,\n  "b": {\n    "c": 2\n')
  check(broken.ok === true && broken.text.includes('b.c') && typeof broken.note === 'string', 'B8 半份 JSON：给已扫到的目录 + note（不抛）', String(broken.note))

  const json5 = mapOf('/tmp/c.json5', "{ name: 'demo', nested: { x: 1 }, list: [1, 2], }\n")
  check(
    json5.ok === true && json5.text.includes('name') && json5.text.includes('nested.x') && json5.text.includes('list'),
    'B11 JSON5：无引号键 / 单引号字符串 / 尾逗号也能出目录',
    String(json5.text).split('\n').slice(0, 4).join(' | '),
  )

  const dotted = mapOf('/tmp/dotted.json', '{"exports": {".": "./a", "./b": "./b"}}')
  check(
    dotted.ok === true && dotted.text.includes('exports["."]') && dotted.text.includes('exports["./b"]'),
    'B10 键里有 . 时用 ["..."] 记号（不拼成 exports..）',
    String(dotted.text).split('\n').slice(0, 4).join(' | '),
  )

  const onlyObjects = mapOf('/tmp/conf.json', json, { kind: 'object' })
  check(
    onlyObjects.ok === true && onlyObjects.shown === 1 && onlyObjects.text.includes('db') && !onlyObjects.text.includes('db.host'),
    'B9 kind=object 只列 db（shown=1；symbols 仍是总数）',
    JSON.stringify({ shown: onlyObjects.shown, symbols: onlyObjects.symbols }),
  )
}

// ── C. YAML ─────────────────────────────────────────────────────────────────
say('')
say('=== C. YAML：缩进建树与节区间 ===')
{
  const yaml = 'name: demo\ndb:\n  host: localhost\n  port: 5432\nlist:\n  - a\n  - b\n'
  const map = mapOf('/tmp/conf.yaml', yaml)
  check(map.ok === true && docKindOf('/tmp/conf.yaml') === 'yaml', 'C1 .yaml → yaml')
  check(map.text.includes('name  1-1'), 'C2 name 1-1')
  check(map.text.includes('db  2-4'), 'C3 db 2-4（包含两个子键）', String(map.text).split('\n')[2])
  check(map.text.includes('  db.host  3-3') && map.text.includes('  db.port  4-4'), 'C4 子键路径 db.host / db.port')
  check(map.text.includes('list  5-8'), 'C5 list 到文件尾 5-8')
}

// ── D. TOML ─────────────────────────────────────────────────────────────────
say('')
say('=== D. TOML：表与键 ===')
{
  const toml = '[server]\nhost = "localhost"\nport = 8080\n\n[db.pool]\nsize = 10\n'
  const map = mapOf('/tmp/conf.toml', toml)
  check(map.ok === true && docKindOf('/tmp/conf.toml') === 'toml', 'D1 .toml → toml')
  check(map.text.includes('server  1-4'), 'D2 [server] 表到下一张表之前 1-4', String(map.text).split('\n')[1])
  check(map.text.includes('  server.host  2-2'), 'D3 键带表前缀 server.host')
  check(map.text.includes('  db.pool  5-7'), 'D4 点号表名 db.pool 5-7')
  check(map.text.includes('    db.pool.size  6-6'), 'D5 db.pool.size 6-6')
}

// ── E. 降级与边界 ──────────────────────────────────────────────────────────
say('')
say('=== E. 降级：纯文本仍是“没有结构”；.md 不再说 unsupported ===')
{
  const txt = mapOf('/tmp/plain.txt', 'hello\nworld\n')
  check(txt.ok === true && txt.text.includes('unsupported extension'), 'E1 .txt 仍回“没有符号索引”（不假装有结构）')
  const md = mapOf('/tmp/empty.md', '# A\n')
  check(md.ok === true && !String(md.text).includes('unsupported'), 'E2 .md 不再回 unsupported')
  const noHeadings = mapOf('/tmp/plain.md', 'just text\nno headings\n')
  check(noHeadings.ok === true && /no sections found/.test(String(noHeadings.text)), 'E3 没有标题的 .md：明说没找到节，而不是空目录', String(noHeadings.text))
}

// ── E2. digest 对文档 = 同一张结构目录 ──────────────────────────────────────
say('')
say('=== E2. digest：文档返回结构目录，而不是“没有结构” ===')
{
  const md = '# A\n\n## B\ntext\n'
  const dg = readWith(md, { filePath: '/tmp/doc.md', mode: 'digest' })
  check(dg.ok === true && dg.mode === 'digest', 'E2-1 文档 digest 成功且 mode=digest')
  check(typeof dg.text === 'string' && dg.text.includes('B') && typeof dg.note === 'string' && dg.note.includes('structure directory'), 'E2-2 返回结构目录 + 说明', String(dg.note ?? '').slice(0, 60))
  check(!String(dg.text).includes('unsupported'), 'E2-3 不再回“unsupported/no structure”')
  const plain = readWith('alpha\nbravo\n', { filePath: '/tmp/x.rst', mode: 'digest' })
  check(plain.ok === true && /no structure available/.test(String(plain.text)), 'E2-4 真正无结构的扩展名仍如实说“没有结构”', String(plain.text).slice(0, 60))
}

// ── F. 索引层直测（与渲染解耦）───────────────────────────────────────────────
say('')
say('=== F. indexDocument 直测：entry 形状 ===')
{
  const index = indexDocument('# A\n\n## B\ntext\n', 'markdown')
  check(index.entries.length === 2 && index.entries[1].depth === 2 && index.entries[0].endLine === 2, 'F1 entry 带 depth 与区间', JSON.stringify(index.entries))
  const jsonIndex = indexDocument('{"k": 1}', 'json')
  check(jsonIndex.entries.length === 1 && jsonIndex.entries[0].name === 'k' && jsonIndex.entries[0].kind === 'key', 'F2 JSON entry 形状', JSON.stringify(jsonIndex.entries))
}

say('')
const failed = results.filter((r) => !r.ok)
say(`断言总数 ${results.length}，失败 ${failed.length}`)
for (const f of failed) say(`  FAIL ${f.label}`)
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
process.exit(failed.length === 0 ? 0 : 1)
