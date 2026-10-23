/**
 * terminator-scan-test —— 终结符型语言（SQL / Erlang / Vim / HCL）的块体终结：**意图 pin + 黄金摘要 + 退化形状比值**。
 *
 * ## 这一件守的是什么
 *
 * `terminatorBlockEnd` 的三条停止条件里，「终结符」与「换行」在**整份文件只有一行、且语料里没有终结符**时
 * 永不成立 ⇒ 每个声明都要一路扫到 token 流末尾 ⇒ 全文件 O(n²)。w28 把它线性化（两张后缀最小值表 +
 * 一张链尾表，见 `struct-core.mjs` 里该函数上方那一段）。这一件由三部分组成：
 *
 *   ① **意图 pin**：手写的少量样本，逐字段写死**我们想要的跨度**——`;` 在下一行时也要盖到它、
 *      括号组整层跨过、整份文件一行时的落点、找不到任何收尾时 fail-closed。这是**意图不是行为快照**：
 *      将来引擎真改好了，要人来改这里的期望值，那正是对的（所以期望值逐条写在源码里，不由引擎生成）。
 *   ② **黄金摘要**：大批量**确定性**夹具（终结符型夹具 × 7 种变异 + 退化形状 + 固定种子模糊）的
 *      整表逐符号摘要 sha256 + 符号数 + 用例数。它抓的是「没人想改却被改坏」的漂移，不承担意图。
 *   ③ **退化形状的规模判据**：整份文件一行、无终结符那一档 1k / 4k / 8k，**只看比值**——
 *      `t(8k)/t(4k) ≤ 3`（主判据；线性约 1.7~2.0，二次约 5）、`t(4k)/t(1k) ≤ 12`（兜底；线性约 8，二次约 16）。
 *      原始毫秒照印给人看，但**不做判据**（读数时机上可能有并行负载，绝对值不可靠）。
 *
 * ## 依据（w28 实测中位数：orig/new 背靠背交替、每档各 3 次、每档每次一个全新模块实例）
 *
 *     规模 N     改前 ms     改后 ms
 *     1000         76.9        14.6
 *     4000       1145.8        51.6
 *     8000       5709.9        87.2
 *
 *   每翻一倍：改前 ×3.60 / ×4.13 / ×4.98（二次），改后 ×1.78 / ×1.99 / ×1.69（线性）；8k 档提速 ×65.5。
 *   两条判据线（3 与 12）就是照这两组比值定的：改前那组必红，改后那组留出余量。
 *
 * ## 判定力（本件的红线自己能被证伪）
 *
 *   把跳表的终结符判据短路（`isTerminatorToken(t, terminators) || …` → `false || …`）⇒ 本件当场红
 *   （w30 实测 exit 1：夹具段差异 110 处，首条 `#0 alpha.endTok: 10 → 9`、`#1 v.spanComplete: true → false`）；
 *   按字节还原（sha256 前后一致）⇒ 立刻绿。
 *
 * ## 覆盖事实（为什么这条路径在闸内只有本件守着）
 *
 *   仓库真实语料里**一件 `.sql` / `.erl` / `.vim` 都没有**（w28 等价性对照扫过 2000 件真实文件 /
 *   52759 个符号，其中终结符型语言 **0 件**；那条路径的覆盖全部来自 128 件夹具 / 1311 个符号）。
 *   所以本套件的语料**全部就地生成**：不读 %TEMP%、不依赖机器状态、不碰外网、不起子进程。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { indexStructure, langOf } from './struct-core.mjs'

const say = (m) => process.stdout.write(`${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..', '..')
const SELF = path.join(here, 'terminator-scan-test.mjs')
const GATE = path.join(ROOT, 'build', 'release-check.mjs')
const CORE_URL = pathToFileURL(path.join(here, 'struct-core.mjs')).href

// ── ① 意图 pin：手写样本，逐字段写死我们**想要**的跨度 ────────────────────────
/**
 * 字段顺序（`projectionOf` 用的就是这一串，逐条写在 `want` 里）：
 *
 *     name | kind | startLine | endLine | startTok | endTok | bodyOpen | spanComplete
 *
 * `endTok` 是**符号跨度最后一个 token 的下标**（闭区间），`endLine` 是那个 token 结束处的行号。
 */
const PIN_FIELDS = ['name', 'kind', 'startLine', 'endLine', 'startTok', 'endTok', 'bodyOpen', 'spanComplete']
const projectionOf = (index) => index.symbols.map((s) => PIN_FIELDS.map((f) => (s[f] === undefined ? 'undefined' : String(s[f]))).join('|'))

const PINS = [
  {
    label: 'SQL：终结符在**下一行**时，跨度必须盖到 `;`（不是停在签名行）',
    ext: '.sql',
    src: 'CREATE TABLE alpha (\n  beta INTEGER\n);\n',
    // `;` 在第 3 行 ⇒ endLine 要是 3（盖到 `;`），endTok 要是 `;` 自己（7）。
    want: ['alpha|table|1|3|2|7|null|true'],
  },
  {
    label: 'SQL：同一份里两条声明各自收在自己的 `;` 上（行号也要对）',
    ext: '.sql',
    src: 'CREATE TABLE alpha (\n  beta INTEGER,\n  gamma TEXT\n);\nCREATE VIEW v AS SELECT 1;\n',
    want: ['alpha|table|1|4|2|10|null|true', 'v|view|5|5|13|17|null|true'],
  },
  {
    label: 'SQL：括号组**整层跨过**（参数表里的 token 不算停止位，也不进跨度）',
    ext: '.sql',
    src: 'CREATE TABLE alpha (beta INTEGER);\nCREATE TABLE gamma;\n',
    want: ['alpha|table|1|1|2|7|null|true', 'gamma|table|2|2|10|11|null|true'],
  },
  {
    label: 'Erlang：`.` 是终结符，三条属性各自盖到自己的 `.`（行号也要对）',
    ext: '.erl',
    src: '-module(alpha).\n-record(r, {a}).\n-define(ALPHA, 1).\n',
    want: ['alpha|module|1|1|3|5|null|true', 'r|record|2|2|9|15|null|true', 'ALPHA|variable|3|3|19|23|null|true'],
  },
  {
    label: 'Vim：`endfunction` 是终结符，且**按小写比**（`EndFunction` 一样要认）',
    ext: '.vim',
    src: 'function! Alpha()\n  let x = 1\nendfunction\nfunction! Beta()\n  echo "b"\nEndFunction\n',
    want: ['Alpha|function|1|3|2|9|null|true', 'Beta|function|4|6|12|16|null|true'],
  },
  {
    label: 'HCL：块体就是那个括号组 ⇒ 跨度必须**包含组尾** `}`',
    ext: '.tf',
    src: 'variable "x" {\n  default = 1\n}\n',
    // 规则末端停在块名上，块体由**跳层**落在组尾：endTok 必须是 `}`（6），不是块名（1）。
    want: ['x|variable|1|3|1|6|null|true'],
  },
  {
    label: 'HCL：两个块各收在自己的组尾上（第二个块的 `}` 不许被算进第一个）',
    ext: '.tf',
    src: 'variable "x" {\n  default = 1\n}\n\nvariable "y" {\n  default = 2\n}\n',
    // 两个块之间空一行 ⇒ `y` 从第 5 行起；`x` 收在自己的 `}`（第 3 行），不被 `y` 的 `}` 拉长。
    want: ['x|variable|1|3|1|6|null|true', 'y|variable|5|7|8|13|null|true'],
  },
  {
    label: '退化形状（整份文件一行、无终结符、带括号）：跨度落在**跨过的最后一个组尾**上',
    ext: '.sql',
    src: 'CREATE TABLE alpha ( beta INTEGER ) CREATE TABLE gamma ( delta INTEGER )',
    want: ['alpha|table|1|1|2|13|null|true', 'gamma|table|1|1|9|13|null|true'],
    note: '这是继承契约：一行里没有任何停止条件时，原语义就是「一路跨到最后一个组尾」（不是 `-1`、也不是缩成签名行）。规模判据（③）保护的正是这一支。',
  },
  {
    label: '退化形状（一行、无终结符、**没有**括号组）：fail-closed，且不退回「只有签名行」',
    ext: '.sql',
    src: 'CREATE TABLE alpha CREATE TABLE gamma',
    want: ['alpha|table|1|1|2|2|null|false', 'gamma|table|1|1|5|5|null|false'],
    note: '`spanComplete=false` + `spanNote` 点明「没有终结符收尾」；跨度停在名字 token 上，而不是悄悄变成「只有签名行还报完整」。',
  },
]

say('[段① 意图 pin] 手写样本 × 逐字段期望（name|kind|startLine|endLine|startTok|endTok|bodyOpen|spanComplete）')
for (const pin of PINS) {
  const got = projectionOf(indexStructure(pin.src, langOf(pin.ext)))
  const same = got.length === pin.want.length && got.every((row, i) => row === pin.want[i])
  const diff =
    same ? '' : `\n      期望 ${JSON.stringify(pin.want)}\n      实得 ${JSON.stringify(got)}` + (pin.note === undefined ? '' : `\n      注：${pin.note}`)
  check(same, `① ${pin.label}`, diff)
}
// 「继承契约」那两条把理由也印出来（不参与判定，但要看得见）
for (const pin of PINS.filter((p) => p.note !== undefined)) say(`    · ${pin.label}\n      ${pin.note}`)

// ── ② 黄金摘要：大批量确定性夹具的整表摘要 ──────────────────────────────────
/**
 * 语料 = 终结符型夹具 × 7 种确定性变异 + 退化形状小规模 + 固定种子（xorshift32）模糊，
 * 全部**就地生成**：同样的种子 ⇒ 同样的字节 ⇒ 同样的摘要，与机器状态无关。
 *
 * 摘要口径（`canonicalOf`）：每个用例一行表头（扩展名 / 长度 / 符号数），再逐符号一行
 * `name|kind|startLine|endLine|startTok|endTok|bodyOpen|spanComplete|enclosing|spanNote`。
 * 这是**漂移报警器**：任何一处跨度/归属/说明文字的无声改变都会换掉这个 sha256。
 */
const FIXTURES = [
  ['.sql', 'CREATE TABLE alpha (\n  beta INTEGER,\n  gamma TEXT\n);\nCREATE VIEW v AS SELECT 1;\n'],
  ['.sql', 'CREATE TABLE alpha ( beta INTEGER );\nCREATE TABLE gamma;\n'],
  ['.sql', 'CREATE TABLE alpha (\n  beta INTEGER\n)\n;\nCREATE TABLE gamma;'],
  ['.sql', '-- 注释里有 ;\nCREATE TABLE alpha; -- 行尾 ;\n/* 块注释 ; */\nCREATE TABLE gamma;'],
  ['.sql', 'CREATE TABLE alpha (beta INTEGER); CREATE TABLE gamma;\n'],
  ['.sql', 'CREATE TABLE alpha (beta ARRAY[INTEGER]);\nCREATE TABLE gamma;\n'],
  ['.sql', 'CREATE TEMP TABLE alpha (b INT);\nCREATE OR REPLACE VIEW v;\nCREATE UNIQUE INDEX i ON t(b);\n'],
  ['.sql', 'CREATE TABLE alpha;\n\n\nCREATE TABLE gamma;\n'],
  ['.sql', 'CREATE TABLE alpha (beta INTEGER)\nCREATE TABLE gamma\n'],
  ['.sql', "'CREATE TABLE' -- 字符串里的关键字\nCREATE TABLE alpha;\n"],
  ['.erl', '-module(alpha).\n-export([f/0]).\nf() -> ok.\ng() ->\n  case x of\n    y -> z\n  end.\n'],
  ['.erl', '-module(alpha). -record(r, {a, b}). -define(ALPHA, 1).\nf() -> {ok, [1,2,3]}.\n'],
  ['.erl', '-module(alpha).\n-record(r, {a}).\nf(X) ->\n  g(X).\n'],
  ['.erl', '-module(alpha). -record(r, {a}). -define(A, 1).\n'],
  ['.vim', 'function! Alpha()\n  let x = 1\nendfunction\nfunction! Beta()\n  echo "b"\nEndFunction\n'],
  ['.vim', 'function! Alpha()\n  return [1,\n        \\ 2]\nendfunction\n'],
  ['.vim', 'au FileType x call s:Alpha()\nfunction! Alpha()\nendfunction\n'],
  ['.tf', 'variable "x" {\n  default = 1\n}\n'],
  ['.tf', 'variable "x" {\n  default = 1\n}\n\nvariable "y" {\n  default = 2\n}\n'],
]
const stripTerm = (ext, s) =>
  ext === '.sql' || ext === '.tf' ? s.replace(/;/g, '') : ext === '.erl' ? s.replace(/\./g, '') : s.replace(/endfunction|enddef/gi, '')
const MUTATORS = [
  ['原样', (ext, s) => s],
  ['单行化', (ext, s) => s.replace(/\r?\n/g, ' ')],
  ['去终结符', (ext, s) => stripTerm(ext, s)],
  ['单行化+去终结符', (ext, s) => stripTerm(ext, s.replace(/\r?\n/g, ' '))],
  ['CRLF', (ext, s) => s.replace(/\r?\n/g, '\r\n')],
  ['重复两份', (ext, s) => s + s],
  ['单行化+重复三份', (ext, s) => `${s.replace(/\r?\n/g, ' ')} `.repeat(3)],
]
const CORPUS = []
for (const [ext, base] of FIXTURES) for (const [, fn] of MUTATORS) CORPUS.push([ext, fn(ext, base)])
for (const n of [10, 100, 400]) {
  const decl = (i) => (i % 2 === 0 ? `CREATE TABLE alpha_${i} ( beta_${i} INTEGER )` : `CREATE TABLE gamma_${i}`)
  CORPUS.push(['.sql', Array.from({ length: n }, (_, i) => decl(i)).join(' ')])
  CORPUS.push(['.sql', Array.from({ length: n }, (_, i) => decl(i)).join('\n')])
}
for (const ext of ['.sql', '.erl', '.vim']) {
  const alphabets = {
    '.sql': ['CREATE', 'TABLE', 'VIEW', 'alpha', 'beta', '(', ')', '[', ']', ',', ';', 'INTEGER', '-- c', "'s'"],
    '.erl': ['-', 'module', 'record', '(', ')', '.', 'f', '->', 'ok', '[', ']', '{', '}', ',', 'case', 'end'],
    '.vim': ['function', '!', 'Alpha', '(', ')', 'endfunction', 'let', 'x', '=', '1', '"c"', 'EndFunction'],
  }[ext]
  let seed = 0x9e3779b9
  const rnd = () => {
    seed ^= seed << 13
    seed >>>= 0
    seed ^= seed >>> 17
    seed ^= seed << 5
    seed >>>= 0
    return seed / 4294967296
  }
  for (let c = 0; c < 100; c += 1) {
    const n = 4 + Math.floor(rnd() * 26)
    let out = ''
    for (let i = 0; i < n; i += 1) {
      out += alphabets[Math.floor(rnd() * alphabets.length)]
      out += rnd() < 0.25 ? '\n' : ' '
    }
    CORPUS.push([ext, out])
  }
}
// 空 / 只有空白也进摘要（退化到 0 符号的那一端）
CORPUS.push(['.sql', ''], ['.sql', '   \n\t\n'], ['.erl', '\n\n\n'], ['.vim', ''])

const canonicalOf = (ext, src) => {
  let index
  try {
    index = indexStructure(src, langOf(ext))
  } catch (e) {
    return [`#${ext} ${src.length} ERROR ${e.message}`]
  }
  const rows = [`#${ext} ${src.length} ${index.symbols.length}`]
  for (const s of index.symbols) {
    rows.push(
      `${s.name}|${s.kind}|${s.startLine}|${s.endLine}|${s.startTok}|${s.endTok}|${s.bodyOpen}|${s.spanComplete}|${s.enclosing}|${s.spanNote}`,
    )
  }
  return rows
}
const canonical = []
let symbolTotal = 0
let errorTotal = 0
let erlFunctions = 0
const perExt = new Map()
for (const [ext, src] of CORPUS) {
  const rows = canonicalOf(ext, src)
  canonical.push(...rows)
  if (rows[0].includes(' ERROR ')) errorTotal += 1
  const n = Number(rows[0].split(' ').pop())
  const count = Number.isFinite(n) ? n : 0
  symbolTotal += count
  perExt.set(ext, (perExt.get(ext) ?? 0) + count)
  if (ext === '.erl') for (const row of rows.slice(1)) if (row.split('|')[1] === 'function') erlFunctions += 1
}
const digest = crypto.createHash('sha256').update(canonical.join('\n'), 'utf8').digest('hex')
/** 黄金摘要（`sha256(canonical.join('\n'))`）与同批三个计数。改口径就要连它们一起改，这是有意的。 */
const GOLDEN_DIGEST = '2529b62ebf122702f7b920864224a51424607165c09082d0a474f6bb0ee58d27'
const GOLDEN_SYMBOLS = 1410
const GOLDEN_CASES = 443

say('')
say('[段② 黄金摘要] 终结符型夹具 × 7 种变异 + 退化形状 + 固定种子模糊（全部就地生成）')
for (const [ext, n] of [...perExt.entries()].sort()) say(`  ${ext.padEnd(6)} ${String(n).padStart(5)} 个符号`)
say(`  用例 ${CORPUS.length} 件 / 符号 ${symbolTotal} 个 / 索引抛错 ${errorTotal} 件`)
say(`  sha256 ${digest}`)
say(`  Erlang function 符号：${erlFunctions} 个（T2：函数子句提取已修复，黄金摘要钉住）`)
check(erlFunctions >= 1, '② Erlang 函数子句真的被提取（T2 回归钉）', `function 符号 ${erlFunctions} 个`)
check(
  GOLDEN_DIGEST !== 'UNPINNED' && digest === GOLDEN_DIGEST && symbolTotal === GOLDEN_SYMBOLS && CORPUS.length === GOLDEN_CASES,
  '② 整表摘要 + 符号数 + 用例数与黄金值逐位相同（漂移报警器）',
  `digest=${digest} symbols=${symbolTotal} cases=${CORPUS.length}`,
)
// 自证覆盖：四种终结符型语言都必须真的出符号，否则上面那条摘要可能只是「一片空白也算对」
for (const ext of ['.sql', '.erl', '.vim', '.tf']) {
  check((perExt.get(ext) ?? 0) > 0, `② 覆盖自证：${ext} 的语料真的建出了符号`, `${perExt.get(ext) ?? 0} 个`)
}
check(errorTotal === 0, '② 覆盖自证：这批语料没有一件让索引抛错（抛错会被写进摘要，但不该有）', `${errorTotal} 件`)

// ── ③ 退化形状的规模判据：只看比值 ─────────────────────────────────────────
const SIZES = [1000, 4000, 8000]
/** 主判据：8k/4k。线性约 1.7~2.0，二次约 5（w28 改前实测 ×4.98）。 */
const RATIO_8K_4K_MAX = 3
/** 兜底：4k/1k。这里 1k→4k 是四倍规模，线性约 4、二次约 16（w28 改前实测 ×3.60，因为还有别的项）；留宽只做兜底。 */
const RATIO_4K_1K_MAX = 12
const REPS = 3
/** 整份文件**一行**、**没有终结符**的 SQL 语料：条件 1、3 永不成立的那一支。 */
const degenerate = (n) => Array.from({ length: n }, (_, i) => `CREATE TABLE alpha_${i} ( beta_${i} INTEGER )`).join(' ')

let freshSeq = 0
/** 全新模块实例：模块级索引缓存必空（`?suite=N`，与 `index-cache-test` / `index-scaling-test` 同一手法）。 */
const freshCore = () => import(`${CORE_URL}?suite=${(freshSeq += 1)}`)
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6
const median = (a) => {
  const b = [...a].sort((x, y) => x - y)
  const h = b.length >> 1
  return b.length % 2 === 1 ? b[h] : (b[h - 1] + b[h]) / 2
}

say('')
say('[段③ 退化形状规模] 整份文件一行、无终结符；每档 3 次取中位数，每档每次一个全新模块实例')
const times = []
for (const n of SIZES) {
  const src = degenerate(n)
  const runs = []
  let symbols = -1
  for (let r = 0; r < REPS; r += 1) {
    const core = await freshCore()
    const lang = core.langOf('x.sql')
    const t0 = process.hrtime.bigint()
    const idx = core.indexStructure(src, lang)
    runs.push(ms(t0))
    symbols = idx.symbols.length
  }
  times.push({ n, median: median(runs), runs, symbols, lines: src.split('\n').length })
  say(`  ${String(n).padStart(5)} 档  ${median(runs).toFixed(1).padStart(8)} ms（各次 ${runs.map((x) => x.toFixed(1)).join('/')}）  ${symbols} 符号`)
}
check(
  times.every((t) => t.symbols === t.n),
  '③ 三档都真的建出了 N 个符号，而且语料真的只有一行（量的是符号处理，不是空气）',
  times.map((t) => `${t.n}→${t.symbols}符号/${t.lines}行`).join(' '),
)
const t1 = times.find((t) => t.n === 1000)
const t4 = times.find((t) => t.n === 4000)
const t8 = times.find((t) => t.n === 8000)
const r84 = t8.median / t4.median
const r41 = t4.median / t1.median
say(`  8k/4k = ×${r84.toFixed(2)}（线性约 1.7~2.0、二次约 5；w28 改前实测 ×4.98、改后 ×1.69）`)
say(`  4k/1k = ×${r41.toFixed(2)}（1k→4k 是四倍规模：线性约 4、二次约 16；w28 改前实测 ×3.60）`)
say('  （原始毫秒只作参考：读数时机上可能有并行负载，判据只用比值）')
check(r84 <= RATIO_8K_4K_MAX, `③ 主判据：t(8k)/t(4k) ≤ ${RATIO_8K_4K_MAX}（二次项不许悄悄回来）`, `实测 ×${r84.toFixed(2)}（${t8.median.toFixed(1)} / ${t4.median.toFixed(1)} ms）`)
check(r41 <= RATIO_4K_1K_MAX, `③ 兜底：t(4k)/t(1k) ≤ ${RATIO_4K_1K_MAX}`, `实测 ×${r41.toFixed(2)}（${t4.median.toFixed(1)} / ${t1.median.toFixed(1)} ms）`)

// ── ④ 登记进闸 + 退出码接线 ─────────────────────────────────────────────────
say('')
say('[段④ 进闸登记与退出码接线]')
const gateSrc = fs.readFileSync(GATE, 'utf8')
check(
  /\[\s*'[^']*'\s*,\s*'src\/locator-lab\/terminator-scan-test\.mjs'\s*\]/.test(gateSrc),
  '④ 本套件登记在 `build/release-check.mjs` 的 `SUITES` 里（按登记行形态匹配，不靠文件名）',
  `${path.relative(ROOT, GATE)} 里有 ['…', 'src/locator-lab/terminator-scan-test.mjs']`,
)
const selfSrc = fs.readFileSync(SELF, 'utf8')
check(/process\.exitCode\s*=/.test(selfSrc), '④ 本套件自带退出码接线（判据红 ⇒ 进程非零退出，闸才拦得住）', '源码里有 process.exitCode =')
check(/通过/.test(selfSrc) && /\$\{/.test(selfSrc), '④ 本套件自带通过/失败汇总行（闸按这一行取摘要）', '源码里有带计数的「通过」汇总行')

// ── 汇总 ────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
say('')
if (failed.length > 0) {
  for (const f of failed) say(`  FAIL: ${f.label}  ${f.detail}`)
}
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
process.exitCode = failed.length === 0 ? 0 : 1
