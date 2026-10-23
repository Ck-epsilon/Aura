/**
 * lang-gap.mjs —— 量清楚：真实世界里的代码文件，有多少种是当前不支持的？
 *
 * 不猜。扫这台机器上的实际文件，按扩展名统计，标出哪些已支持、哪些没有。
 * 再按两个维度排序，决定加什么：
 *   · 文件数量      —— 这台机器上的真实密度
 *   · 是否是可"符号化"的语言 —— 配置/数据格式（json/yaml/xml）没有符号可寻址，
 *                              它们需要的不是语言配置，而是另一套处理方式
 */
import fs from 'node:fs'
import path from 'node:path'
import { langOf, LANGS } from './struct-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const SUPPORTED = new Set(Object.keys(LANGS))

/** 纯配置/数据格式：没有"函数/类"这类符号，因此不属于语言配置能解决的范畴。 */
const DATA_OR_CONFIG = new Set([
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'xml', 'plist', 'csv', 'tsv', 'lock', 'properties', 'editorconfig',
])
/** 标记/样式/模板：有结构但结构不是"声明"，且通常整文件读写即可。 */
const MARKUP = new Set(['html', 'htm', 'css', 'scss', 'sass', 'less', 'md', 'mdx', 'rst', 'txt', 'svg', 'vue', 'svelte'])

const ROOTS = ['E:\\workspaces', 'C:\\Users\\cxk\\.agents']
const counts = new Map()
let scanned = 0

function walk(dir, depth) {
  if (depth > 7) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'build') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      walk(p, depth + 1)
      continue
    }
    const ext = path.extname(e.name).slice(1).toLowerCase()
    if (ext.length === 0 || ext.length > 6) continue
    scanned += 1
    counts.set(ext, (counts.get(ext) ?? 0) + 1)
  }
}

for (const r of ROOTS) if (fs.existsSync(r)) walk(r, 0)

say(`扫描 ${scanned} 个文件，${counts.size} 种扩展名`)
say('')

const byCount = [...counts.entries()].sort((a, b) => b[1] - a[1])

/**
 * 真正的编程语言候选：**有声明、可符号寻址**的源码扩展名。
 *
 * 第一版把按扩展名统计出来的东西全列了，于是 `.png` `.exe` `.pdf` `.pyc` `.jar`
 * 全混进"缺的编程语言"里——那是**统计口径错**，不是语言缺口。
 * 二进制、归档、证书、编译产物不可能是符号寻址的对象，它们连"语言"都不是。
 * 这里显式列出候选名单，让统计只回答一个明确的问题。
 */
const CODE_EXT = new Set([
  // 脚本
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  // 模板/宏
  'm4', 'am', 'ac', 'cmake', 'mk',
  // 数据/接口定义
  'sql', 'proto', 'graphql', 'gql', 'thrift',
  // 编译型/系统
  'm', 'mm', 'f90', 'f95', 'rs', 'zig', 'nim', 'v',
  // Cython 家族
  'pyx', 'pxd', 'pxi',
  // 函数式/其他
  'ex', 'exs', 'erl', 'hrl', 'hs', 'lhs', 'ml', 'mli', 'fs', 'fsx', 'clj', 'cljs', 'cljc',
  'jl', 'r', 'pl', 'pm', 'tcl', 'groovy', 'gradle', 'vb', 'pas', 'd', 'ada', 'adb', 'ads',
  'coffee', 'elm', 'purs', 'roc', 'gleam', 'odin', 'hx', 'as', 'sol', 'move', 'cairo',
  // 模板里真正含代码的
  'ejs', 'hbs', 'mustache', 'jinja', 'j2', 'erb', 'twig', 'liquid',
  // 移动/前端新语言
  'dart', 'kt', 'kts', 'swift', 'vue', 'svelte', 'astro', 'jsx', 'tsx',
  // Windows 系统
  'rc', 'def', 'inc', 'idl',
  // R/统计
  'rmd', 'qmd',
])

const code = []
const dataFormat = []
const markup = []
const others = []
for (const [ext, n] of byCount) {
  if (SUPPORTED.has(ext)) continue
  if (CODE_EXT.has(ext)) code.push([ext, n])
  else if (DATA_OR_CONFIG.has(ext)) dataFormat.push([ext, n])
  else if (MARKUP.has(ext)) markup.push([ext, n])
  else others.push([ext, n])
}

const width = (s) => [...String(s)].reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\u3000-\u9fff\uf900-\ufaff\uff00-\uff60]/.test(ch) ? 2 : 1), 0)
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)))

say('=== 已支持（仅供参考）===')
say(`  ${[...SUPPORTED].sort().join(' ')}`)
say('')
say('=== 缺：真正的编程语言（有符号可寻址，加配置即可）===')
let codeTotal = 0
for (const [ext, n] of code) {
  codeTotal += n
  if (n >= 3) say(`  ${pad(ext, 10)} ${String(n).padStart(6)} 个文件`)
}
say(`  —— 合计 ${codeTotal} 个文件`)
say('')
say('=== 缺：配置/数据格式（**没有符号可寻址**，需要另一套方式，不是加语言配置）===')
let dataTotal = 0
for (const [ext, n] of dataFormat) {
  dataTotal += n
  if (n >= 3) say(`  ${pad(ext, 10)} ${String(n).padStart(6)} 个文件`)
}
say(`  —— 合计 ${dataTotal} 个文件`)
say('')
say('=== 缺：标记/模板/样式（有结构但不是"声明"，通常整文件读写）===')
let markupTotal = 0
for (const [ext, n] of markup) {
  markupTotal += n
  if (n >= 3) say(`  ${pad(ext, 10)} ${String(n).padStart(6)} 个文件`)
}
say(`  —— 合计 ${markupTotal} 个文件`)
say('')
say('=== 判读 ===')
say(`  编程语言缺口 ${codeTotal} 个文件 —— 这类**加语言配置就能解决**，是通用性的主战场`)
say(`  配置/数据 ${dataTotal} 个 —— 这类加配置也没用（没有符号），需要的是"整文件按需读写"，`)
say(`                     而 aura_basetools_read 的 lines/full 模式已经覆盖；aura_basetools_edit 的 lines 层也已覆盖`)
say(`  标记/样式 ${markupTotal} 个 —— 同上，靠 lines/full 模式`)
say(`  其它（二进制/归档/证书/编译产物等）${others.reduce((n, [, c]) => n + c, 0)} 个 —— 不是符号寻址的对象`)
say('')
say('=== 密度最高的编程语言缺口（>=5 个文件）===')
for (const [ext, n] of code) {
  if (n >= 5) say(`  ${pad(ext, 10)} ${String(n).padStart(6)}`)
}
