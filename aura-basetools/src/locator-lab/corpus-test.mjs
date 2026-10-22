/**
 * corpus-test —— 用**真实源码**验证多语言符号提取。
 *
 * 为什么必须有这一步：构造的样本只能证明规则写得出来，证明不了它在真实代码上不撒野。
 * 本机有真实的 C 头文件上万、C/C++ 源码数千、以及 Kotlin/C#/Perl 等，正好当语料。
 *
 * 判定不靠"看起来对不对"，靠三条可量化的：
 *   1. **不崩**：任何文件都能建索引，不抛异常
 *   2. **不撒野**：假阳性率受控——符号名首字符必须像标识符，且不能是关键字
 *   3. **有信号**：函数/类/类型这类声明要有，不能全是局部变量噪声
 */
import fs from 'node:fs'
import path from 'node:path'
import { indexStructure, langOf, listSymbols, LANGS } from './struct-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label })
  if (!ok) failing += 1
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}
/** C42：退出码接线的状态抽屉。这个套件**自有判据**（`check()` 5 条 + 末尾那条聚合判据）
 *  却一直没有退出码接线 —— 于是「被 SUITES 登记 + 有 ✓/✗ 打印 + 失败仍 exit 0」三条同时成立：
 *  把 `struct-core` 换成空桩，它照印 3 条 ✗、闸照记 ✅。**登记在册的红线是哑的**。
 *  这里把「有没有失败」从 `results` 里**算出来**，末尾据此硬接退出码 —— 判据一条没动。 */
let failing = 0

const ROOTS = ['E:\\workspaces', 'E:\\software\\npmlocal\\node_global\\node_modules']

/** 按扩展名收集真实文件，每类最多取 N 个，避免样本偏斜。 */
function collect(perExt = 12) {
  const byExt = new Map()
  for (const root of ROOTS) {
    if (!fs.existsSync(root)) continue
    const walk = (dir, depth) => {
      if (depth > 6) return
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.name === 'node_modules' && depth > 2) continue
        const p = path.join(dir, e.name)
        if (e.isDirectory()) {
          walk(p, depth + 1)
          continue
        }
        const ext = path.extname(e.name).slice(1).toLowerCase()
        if (langOf(p) === null) continue
        const bucket = byExt.get(ext) ?? []
        if (bucket.length >= perExt) continue
        let size = 0
        try {
          size = fs.statSync(p).size
        } catch {
          continue
        }
        if (size < 200 || size > 400000) continue
        bucket.push(p)
        byExt.set(ext, bucket)
      }
    }
    walk(root, 0)
  }
  return byExt
}

const byExt = collect()
say(`收集到 ${[...byExt.values()].reduce((n, b) => n + b.length, 0)} 个真实文件，覆盖 ${byExt.size} 种扩展名`)
say('')

say('=== 逐语言在真实文件上的表现 ===')
say(
  ['扩展名', '文件数', '坏了', '符号数', '函数/类占比', '可疑名', '平均耗时'].map((s) => s.padEnd(12)).join(''),
)
say('-'.repeat(84))

/**
 * 可疑符号名：**首字符不是合法标识符起始字符**。
 *
 * 这里刻意不检查长度。第一版把 `sym.name.length < 2` 也算可疑，结果把压缩过的 JS 里
 * 合法的单字符变量（`s` `h` `t` `$`）全报了进来，448 个"可疑"里绝大多数是这个。
 * **检查器本身有偏，比被测对象出错更隐蔽**——它会把噪声伪装成发现。
 */
const SUSPECT = /^[^A-Za-z_$\u0080-\uffff]/
const STRUCTURAL = new Set(['function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'impl', 'protocol', 'record', 'object', 'module', 'namespace', 'mixin', 'extension', 'union', 'typedef'])

/**
 * 压缩/打包产物：平均行长很大且符号密度极高。
 * 这类文件会稀释质量指标（它们的变量名本来就是 `s` `h` `t`），因此单独统计、不混入信号比。
 */
function isMinified(src, symbolCount) {
  const lines = src.split('\n').length
  return symbolCount / Math.max(1, lines) > 1.2
}

let totalFiles = 0
let totalBroken = 0
let totalSymbols = 0
let totalStructural = 0
let totalSuspect = 0
let minifiedFiles = 0
let cleanSymbols = 0
let cleanStructural = 0

for (const [ext, files] of [...byExt.entries()].sort()) {
  let broken = 0
  let symbols = 0
  let structural = 0
  let suspect = 0
  let ms = 0
  for (const f of files) {
    totalFiles += 1
    let src
    try {
      src = fs.readFileSync(f, 'utf8')
    } catch {
      broken += 1
      continue
    }
    const t = Date.now()
    try {
      const idx = indexStructure(src, langOf(f))
      ms += Date.now() - t
      symbols += idx.symbols.length
      const min = isMinified(src, idx.symbols.length)
      if (min) minifiedFiles += 1
      else cleanSymbols += idx.symbols.length
      for (const s of idx.symbols) {
        if (STRUCTURAL.has(s.kind)) {
          structural += 1
          if (!min) cleanStructural += 1
        }
        if (SUSPECT.test(s.name)) suspect += 1
      }
    } catch (e) {
      broken += 1
      say(`    ! ${path.basename(f)}: ${e.message}`)
    }
  }
  totalBroken += broken
  totalSymbols += symbols
  totalStructural += structural
  totalSuspect += suspect
  say(
    [
      ext.padEnd(12),
      String(files.length).padEnd(12),
      String(broken).padEnd(12),
      String(symbols).padEnd(12),
      `${symbols === 0 ? 0 : Math.round((structural / symbols) * 100)}%`.padEnd(12),
      String(suspect).padEnd(12),
      `${files.length === 0 ? 0 : Math.round(ms / files.length)}ms`.padEnd(12),
    ].join(''),
  )
}

say('')
say('=== 总量判定 ===')
check(totalBroken === 0, `无一文件建索引失败`, `${totalFiles} 个文件，坏 ${totalBroken}`)
check(totalSymbols > 0, `总共提取 ${totalSymbols} 个符号`)
check(totalSuspect === 0, `符号名首字符全部合法（可疑 ${totalSuspect}）`)
check(
  cleanSymbols === 0 ? false : cleanStructural / cleanSymbols >= 0.5,
  `非压缩文件里结构类符号占比 ${((cleanStructural / cleanSymbols) * 100).toFixed(1)}%（阈值 50%）`,
  `干净符号 ${cleanSymbols}，压缩文件 ${minifiedFiles} 个已单列`,
)
say(`（另有 ${minifiedFiles} 个压缩/打包产物单列，未混入信号比）`)

say('')
say(`结构类符号占比：${((totalStructural / totalSymbols) * 100).toFixed(1)}%`)

say('')
say('=== 覆盖的语言清单（配置表）===')
const exts = Object.keys(LANGS).sort()
say(`  共 ${exts.length} 种扩展名：${exts.join(' ')}`)
check(exts.length >= 25, `扩展名数量 ${exts.length}`)

// C42：判据维持不变，只把「自有判据的结果」接到**能判红**的通道上（§⑩ 的机检也钉这一条）。
say('')
say(`--- ${results.length - failing}/${results.length} 通过 ---`)
check(failing === 0, `全部自有判据通过（失败 ${failing}）`)
process.exitCode = failing === 0 ? 0 : 1
