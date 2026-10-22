/**
 * struct-test —— 结构索引的正确性验证。
 *
 * 索引错了，后面所有对比都是垃圾。所以先用**已知答案**的真实文件验：
 * 文件里到底有哪些函数/类/方法，索引报出来的符号名与跨度对不对。
 */
import fs from 'node:fs'
import path from 'node:path'
import { indexStructure, resolveTarget, regionConfidence, listSymbols, findReferences, langOf } from './struct-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

const NM = 'E:\\software\\npmlocal\\node_global\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai'
const FILE = path.join(NM, 'dsh-tool-todo', 'lib', 'index.js')
const src = fs.readFileSync(FILE, 'utf8')
const lang = langOf(FILE)
say(`靶子: ${path.basename(path.dirname(path.dirname(FILE)))} (${lang === null ? '未知语言' : 'js'})  ${src.split('\n').length} 行`)
check(lang !== null, '扩展名识别出语言')

const t0 = Date.now()
const index = indexStructure(src, lang)
const buildMs = Date.now() - t0
say('')
say(`=== 符号表（${index.symbols.length} 个，建索引 ${buildMs}ms）===`)
for (const s of listSymbols(index)) {
  say(`  ${s.kind.padEnd(9)} ${s.name.padEnd(24)} 行 ${s.startLine}-${s.endLine}`)
}
check(index.symbols.length > 0, `索引出 ${index.symbols.length} 个符号`)

// 这个文件里已知存在的符号（从源码里读出来的事实）
const EXPECTED = ['describe', 'toTodoList', 'apply']
for (const name of EXPECTED) {
  const hit = index.symbols.find((s) => s.name === name)
  check(hit !== undefined, `已知符号 "${name}" 被索引到`, hit ? `${hit.kind} 行 ${hit.startLine}-${hit.endLine}` : '缺失')
}

// 注释里的词与字符串里的词都不能被当成符号
say('')
say('=== 抗污染：注释/字符串里的词不得成为符号 ===')
const poisoned = [
  '// function notReal() {}',
  '/* class AlsoNotReal {} */',
  'const s = "function quoted() {}";',
  'const t = `class templated {}`;',
  'function realOne() { return 1; }',
].join('\n')
const pIdx = indexStructure(poisoned, langOf('x.js'))
const names = pIdx.symbols.map((s) => s.name)
check(!names.includes('notReal'), '行注释里的 function 未被识别', `实际符号: ${JSON.stringify(names)}`)
check(!names.includes('AlsoNotReal'), '块注释里的 class 未被识别')
check(!names.includes('quoted'), '双引号字符串里的 function 未被识别')
check(!names.includes('templated'), '模板串里的 class 未被识别')
check(names.includes('realOne'), '真实的 function 仍被识别')

say('')
say('=== 解析目标 ===')
check(resolveTarget(index, 'toTodoList').startLine > 0, `resolveTarget("toTodoList") -> 行 ${resolveTarget(index, 'toTodoList').startLine}`)
check(resolveTarget(index, 'function:apply').name === 'apply', 'resolveTarget("function:apply") 命中')
try {
  resolveTarget(index, '不存在的符号ZZZ')
  check(false, '不存在的符号应当报错')
} catch (e) {
  check(e.code === 'STRUCT_NOT_FOUND', `不存在的符号被拒: ${e.code}`)
}

say('')
say('=== 归属消歧：同名嵌套 ===')
try {
  resolveTarget(index, 'todos')
  check(false, '裸 "todos" 应当因两处同名而报歧义')
} catch (e) {
  check(e.code === 'STRUCT_AMBIGUOUS', `裸 "todos" 报歧义: ${e.code}`)
  const encl = e.candidates.map((c) => c.enclosing ?? '(顶层)')
  check(encl.includes('apply'), `候选带归属信息: ${JSON.stringify(encl)}`)
}
const scoped = resolveTarget(index, 'apply/todos')
check(scoped.name === 'todos' && scoped.enclosing === 'apply', `"apply/todos" 收敛到行 ${scoped.startLine}（归属 apply）`)
check(resolveTarget(index, 'function:apply').name === 'apply', 'kind 限定仍工作')

say('')
say('=== 结构置信度：完整函数体 vs 随便一段 ===')
const fn = index.symbols.find((s) => s.name === 'toTodoList')
const full = regionConfidence(index, fn.startLine, fn.endLine)
const partial = regionConfidence(index, fn.startLine + 1, fn.endLine - 1)
const junk = regionConfidence(index, 1, 2)
check(full === 1, `完整声明区间 = ${full.toFixed(2)}（期望 1）`)
check(partial < 1, `少一行的区间 = ${partial.toFixed(2)}（期望 <1）`)
check(junk < 1, `无关区间 = ${junk.toFixed(2)}（期望 <1）`)

say('')
say('=== 引用查找（重命名场景）===')
const refs = findReferences(index, 'todos')
say(`  "todos" 在符号体内出现 ${refs.length} 次，涉及: ${[...new Set(refs.map((r) => r.within))].join(', ')}`)
check(refs.length > 0, '找到引用')

say('')
say('=== 多语言：Python / Go / Rust 的配置是否真的работает ===')
const py = 'class Foo:\n    def bar(self):\n        return 1\n\ndef top():\n    pass\n'
const pyNames = indexStructure(py, langOf('x.py')).symbols.map((s) => `${s.kind}:${s.name}`)
check(pyNames.includes('class:Foo'), `Python 类被识别 ${JSON.stringify(pyNames)}`)
check(pyNames.includes('function:bar'), 'Python 方法被识别')
check(pyNames.includes('function:top'), 'Python 顶层函数被识别')

const go = 'package main\n\nfunc Hello(name string) string {\n\treturn name\n}\n\ntype Point struct {\n\tX int\n}\n'
const goNames = indexStructure(go, langOf('x.go')).symbols.map((s) => `${s.kind}:${s.name}`)
check(goNames.includes('function:Hello'), `Go 函数被识别 ${JSON.stringify(goNames)}`)
check(goNames.includes('type:Point'), 'Go 类型被识别')

const rs = 'struct Point { x: i32 }\n\nimpl Point {\n    fn new(x: i32) -> Self { Point { x } }\n}\n'
const rsNames = indexStructure(rs, langOf('x.rs')).symbols.map((s) => `${s.kind}:${s.name}`)
check(rsNames.includes('struct:Point'), `Rust struct 被识别 ${JSON.stringify(rsNames)}`)
check(rsNames.includes('function:new'), 'Rust fn 被识别')

say('')
say('=== 性能：大文件建索引 ===')
for (const rel of ['dsh-fs-local', 'dsh-tool-fs', 'dsh-agent-preset']) {
  const f = path.join(NM, rel, 'lib', 'index.js')
  const s = fs.readFileSync(f, 'utf8')
  const t = Date.now()
  const idx = indexStructure(s, langOf(f))
  say(`  ${rel.padEnd(20)} ${String(s.split('\n').length).padStart(5)} 行  ${String(idx.symbols.length).padStart(4)} 符号  ${Date.now() - t}ms`)
}

const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) process.exitCode = 1
