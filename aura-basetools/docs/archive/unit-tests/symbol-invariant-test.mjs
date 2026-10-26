/**
 * symbol-invariant-test.mjs —— **属性测试**：`target=` 的命中在随机编辑序列下**不退化**（T18）。
 *
 * ## 为什么单开一个套件，而不是再加几条固定夹具
 *
 * 既有 20 多套都是**行为断言**（"这个输入产出这个输出"）：它们能回答"没坏"，
 * 答不了"在什么变换下会坏"。而 `target=` 真正值钱的性质是一条**不变式**：
 *
 * > 符号身份不受文本扰动影响。同一份内容，只要那个符号还在，`target=<名字>`
 * > 就应该**仍然命中**，且命中的跨度**仍然包住那个符号的声明**。
 *
 * 固定夹具测不到这条：它只在**我想到的那个扰动**下成立。所以这里用**属性测试**——
 * 随机挑真实语料、随机施加编辑、随机挑符号，断言性质本身。
 * 期望值不是人写的，而是**从扰动前后两份索引各自独立算出来的**（与 T24 的差分测试同一原理）。
 *
 * ## 三条性质（每条都对应一个曾经踩过的坑）
 *
 * 1. **存续性**：扰动前能按名寻址的符号，扰动后**要么仍然命中，要么它真的不在新内容里了**。
 *    反例形态是"名字还在、却寻不到"——那说明索引与内容脱节。
 * 2. **跨度可信**：命中的 `startLine..endLine` 必须落在文件内、且 `startLine <= endLine`；
 *    并且**取出的文本必须真的含有那个名字**。跨度错位是静默的：`target=` 命中后
 *    替换的就是那几行，错了就是改错地方。
 * 3. **幂等**：同一份内容连续解析两次、寻址两次，结果必须逐字相同。
 *    索引带缓存，而"缓存与内容不一致"这类缺陷在固定夹具里几乎不可能被发现。
 *
 * ## 扰动必须是**语法合法**的
 *
 * 随机插入乱码会让文件语法失效，那时"寻不到"是**正确行为**，断言会变成假阳性。
 * 所以扰动只做三件不破坏结构的事：改缩进量、在末尾追加注释行、把空行换成注释行。
 * 这三件恰好是模型编辑最低频、最容易与索引错位的形态。
 */
import fs from 'node:fs'
import path from 'node:path'
import { indexStructure, langOf, listSymbols } from './struct-core.mjs'
import { locate } from './locator-api.mjs'

const say = (m) => process.stdout.write(`${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

/** 确定性伪随机：属性测试必须是**可重放**的，否则红了一次也复现不了。 */
function makeRandom(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}
const rand = makeRandom(0x5eed1234)
const pick = (arr) => arr[Math.floor(rand() * arr.length)]
const randInt = (n) => Math.floor(rand() * n)

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const root = path.join(here, '..', '..')
const CORPUS = [
  'src/locator-lab/struct-core.mjs',
  'src/locator-lab/read-core.mjs',
  'src/locator-lab/locator-api.mjs',
  'src/locator-lab/write-path.mjs',
  'src/aura-edit/index.js',
  'src/aura-read/index.js',
  'build/make-bundle.mjs',
].filter((rel) => fs.existsSync(path.join(root, rel)))

say(`=== 属性测试：target= 在随机编辑序列下的不变式（语料 ${CORPUS.length} 个文件）===`)
say('')

/**
 * 三种**不破坏语法**的扰动。返回值必须能说明"改了几行"——性质 2 要用它换算行号。
 * @returns {{text: string, delta: number}}
 */
function perturb(text) {
  const lines = text.split('\n')
  const kind = randInt(3)
  if (kind === 0) {
    // 改缩进量：在某行的行首加/去两个空格（只对本来就缩进过的行做，免得把顶层声明顶歪）
    const candidates = lines.map((l, i) => (/^[ \t]+\S/.test(l) ? i : -1)).filter((i) => i >= 0)
    if (candidates.length === 0) return { text, delta: 0 }
    const at = pick(candidates)
    lines[at] = lines[at].startsWith('    ') ? lines[at].slice(2) : `  ${lines[at]}`
    return { text: lines.join('\n'), delta: 0 }
  }
  if (kind === 1) {
    // 末尾追加一行注释：只在能判断注释记号时做（按扩展名给记号）
    const comment = /\.(mjs|js)$/.test('x.mjs') ? '// appended by property test' : '# appended by property test'
    return { text: `${text.replace(/\n?$/, '\n')}${comment}\n`, delta: 1 }
  }
  // 把一处空行换成注释行：行数不变，但内容变了
  const blanks = lines.map((l, i) => (l.trim() === '' && i > 0 && i < lines.length - 1 ? i : -1)).filter((i) => i >= 0)
  if (blanks.length === 0) return { text, delta: 0 }
  const at = pick(blanks)
  lines[at] = '// filled by property test'
  return { text: lines.join('\n'), delta: 0 }
}

let sampled = 0
let hitsBefore = 0
let hitsAfter = 0
let verdicts = 0
let verdictsMatch = true
let ambiguousChecked = 0
let ambiguousReceiptsOk = true
let ambiguousSample = ''
const mismatches = []
const failures = []

for (const rel of CORPUS) {
  const abs = path.join(root, rel)
  const original = fs.readFileSync(abs, 'utf8')
  const lang = langOf(abs)
  const symbols = listSymbols(indexStructure(original, lang)).filter((s) => s.spanComplete !== false)
  if (symbols.length === 0) continue

  for (let round = 0; round < 12; round += 1) {
    const symbol = pick(symbols)
    const { text: after, delta } = perturb(original)
    if (after === original) continue
    sampled += 1

    const before = locate(original, { target: symbol.name, filePath: abs })
    const now = locate(after, { target: symbol.name, filePath: abs })
    if (before.ok) hitsBefore += 1
    if (now.ok) hitsAfter += 1
    verdicts += 1
    if (before.ok !== now.ok) {
      verdictsMatch = false
      mismatches.push(`${rel} :: ${symbol.name} 扰动前${before.ok ? '命中' : '失败'}、扰动后${now.ok ? '命中' : '失败'}`)
    }
    // 歧义回执的形状：只在真遇到歧义时检查（否则这条断言会在“全都命中”的语料上恒真）
    if (!now.ok && now.code === 'STRUCT_AMBIGUOUS') {
      ambiguousChecked += 1
      const text = String(now.message ?? '')
      if (/line undefined/.test(text) || !/#\d+/.test(text) || !/near=/.test(text)) {
        ambiguousReceiptsOk = false
        ambiguousSample = text.slice(0, 160)
      }
    }

    // ── 性质 1：存续性（名字还在 ⇒ 必须仍然寻得到）──
    const nameStillThere = new RegExp(`\\b${symbol.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(after)
    if (before.ok && !now.ok && nameStillThere) {
      failures.push(`${rel} :: ${symbol.name} 名字仍在却寻不到（${now.code}）`)
      continue
    }
    if (!now.ok) continue

    // ── 性质 2：跨度可信 ──
    const linesAfter = after.split('\n')
    if (now.startLine < 1 || now.endLine < now.startLine || now.endLine > linesAfter.length) {
      failures.push(`${rel} :: ${symbol.name} 跨度越界 ${now.startLine}..${now.endLine}（共 ${linesAfter.length} 行）`)
      continue
    }
    if (!now.actual.includes(symbol.name)) {
      failures.push(`${rel} :: ${symbol.name} 命中跨度里没有这个名字：${JSON.stringify(now.actual.slice(0, 80))}`)
      continue
    }
    // 扰动只动了行首缩进/注释，因此"命中行号"最多只该按 delta 平移
    if (delta === 0 && before.ok && now.startLine !== before.startLine) {
      // 行数没变却换了行号 ⇒ 索引与内容脱节
      failures.push(`${rel} :: ${symbol.name} 行数未变而行号从 ${before.startLine} 变成 ${now.startLine}`)
      continue
    }

    // ── 性质 3：幂等（同一份内容两次解析/寻址必须逐字相同）──
    const again = locate(after, { target: symbol.name, filePath: abs })
    if (!again.ok || again.startLine !== now.startLine || again.endLine !== now.endLine || again.actual !== now.actual) {
      failures.push(`${rel} :: ${symbol.name} 同一内容两次寻址结果不同`)
    }
  }
}

check(sampled >= 40, `采样量足够（${sampled} 次随机编辑 × 随机符号）`, `语料 ${CORPUS.length} 个文件`)
check(failures.length === 0, '三条性质（存续/跨度可信/幂等）无一违反', failures.slice(0, 3).join(' | '))

/**
 * 不变式必须**逐例同判**，不能只看总数。
 *
 * 只看“命中数不下降”是不够的：一次扰动完全可能把一个符号从“命中”变成“不命中”、
 * 同时把另一个从“不命中”变成“命中”，总数持平而性质已经破了。
 * 但“逐例同判”也不是真命题——**歧义**是合法结果（重名时拒绝猜），
 * 而扰动改的是缩进/注释，理论上不该改变歧义与否。所以断言的是**判决集合完全相同**：
 * 同一份语料里，扰动前后“哪些符号能寻到”必须是同一个集合。
 */
check(
  verdictsMatch,
  `扰动前后判决集合完全一致（命中 ${hitsBefore} / 不命中 ${sampled - hitsBefore}）—— 这才是 T18 要的不变式`,
  verdictsMatch ? '' : `${mismatches.slice(0, 3).join(' | ')}`,
)
// 失败回执必须给出**可用的下一步**：歧义是 25% 符号的常见结果，回执里没有地址就等于没给信息。
check(
  ambiguousReceiptsOk,
  '歧义回执带出行号与可直接用的地址（含 `#N` 与 `near=` 用法）',
  ambiguousReceiptsOk ? '' : ambiguousSample,
)

say('')
if (failures.length > 0) {
  say(`违反明细（前 10 条，共 ${failures.length} 条）：`)
  for (const f of failures.slice(0, 10)) say(`  · ${f}`)
  say('')
}
const passed = results.filter((r) => r.ok).length
say(`--- ${passed}/${results.length} 通过 ---`)
process.exit(passed === results.length ? 0 : 1)
