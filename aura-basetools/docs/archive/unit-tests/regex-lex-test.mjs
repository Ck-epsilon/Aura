/**
 * regex-lex-test.mjs —— 正则字面量必须被当成**第三种词法类别**吃掉。
 *
 * ## 为什么这个测试必须有
 *
 * 配置表里原本只有注释与字符串两类。正则字面量无处安放，于是 `/` 被当普通标点：
 *   · 正则里的引号开了一个字符串 token，把后面的代码整段吞掉；
 *   · 正则里的转义括号（`\(`）留下不配对的 open，而每个 `declarationSpan` 与
 *     `$param*` 跳过都依赖 `matchBrackets`——它一失衡，其后的跨度全部错乱。
 *
 * 后果是**静默**的：不报错，只是符号凭空消失。最有力的标本是这个引擎自己——
 * `read-core.mjs` 的 10 个顶层 `function` 一度只索引出 2 个，`renderDigest`（真实 69-164）
 * 报成 `69-69`，`locate target=readWith` 直接 `STRUCT_NOT_FOUND`。
 *
 * 也就是说：**本工具连自己的引擎都定位不了，而全部测试是绿的。**
 * 所以这里不只测"小样例能过"，还要把"自己的源码能完整索引"当成断言——
 * 那是唯一能长期防止这类回归的判据，因为它是自指的：引擎若再度失明，先看不见的就是自己。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { indexStructure, langOf, listSymbols } from './struct-core.mjs'
import { locate } from './locator-api.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    pass += 1
    say(`  ✓ ${label}`)
  } else {
    fail += 1
    say(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const here = path.dirname(fileURLToPath(import.meta.url))
const names = (src, file = 'x.js') => listSymbols(indexStructure(src, langOf(file))).map((s) => s.name)

// ── 1. 三种曾经致命的正则形态，后面都必须还能看见声明 ────────────────────────
say('=== 1. 正则里的引号／转义括号／字符类 ===')
const AFTER = 'function after(a, b) {\n  return a\n}\n'
for (const [label, prefix] of [
  ['引号（吞掉后续代码）', "const R = /['\"]/\n"],
  ['双引号', 'const R = /["\']/\n'],
  ['转义括号（留下不配对 open）', 'const R = /\\(/\n'],
  ['转义方括号', 'const R = /\\[/\n'],
  ['字符类含斜杠', 'const R = /[/]/ \n'],
  ['字符类含引号', 'const R = /[\'"]/g\n'],
  ['末尾带标志', 'const R = /abc/gi\n'],
  ['关键字后的正则', 'function f() { return /[\'"]/.test(x) }\n'],
]) {
  const got = names(prefix + AFTER)
  check(`${label}：后续声明仍可见`, got.includes('after'), JSON.stringify(got))
}

// ── 2. 除号绝不能被误判成正则（否则会吃掉真实的代码）────────────────────────
// 断言只检查"后续声明还在"，不检查变量名——第一版在这里断言了 `a`，
// 而 `const r = total / count` 根本不产生 `a`，是断言写错了而不是代码错了。
say('')
say('=== 2. 除号不得被误判为正则 ===')
for (const [label, src] of [
  ['简单除号', 'const a = b / c\nfunction after() { return 1 }\n'],
  ['连续除号', 'const a = b / c / d\nfunction after() { return 1 }\n'],
  ['括号后除号', 'const a = (b) / c\nfunction after() { return 1 }\n'],
  ['标识符后除号', 'const r = total / count\nfunction after() { return 1 }\n'],
  ['return 后除号', 'function f() { return a / b }\nfunction after() { return 1 }\n'],
]) {
  const got = names(src)
  check(`${label}：后续声明仍可见`, got.includes('after'), JSON.stringify(got))
}

// ── 3. 只有真正有正则字面量的语言才配这一项 ─────────────────────────────────
// 这条边界必须测：`C_LIKE_BASE` 被 10 个语言共用，第一版把 regexLiterals 放进 base，
// 于是 Go/Rust/Java/… 全都拿到了正则规则——而它们的 `return a / b` 是**除法**。
// 那等于用一个新缺陷换掉一个旧缺陷，而且是静默的。
say('')
say('=== 3. 语言边界：正则字面量只给 JS/TS ===')
const JS_FAMILY = ['a.js', 'a.ts', 'a.mjs', 'a.cjs', 'a.jsx', 'a.tsx', 'a.cts', 'a.mts']
for (const file of JS_FAMILY) {
  const got = names("const R = /['\"]/\n" + AFTER, file)
  check(`${file} 有正则规则，后续声明可见`, got.includes('after'), JSON.stringify(got))
}
// 无正则字面量的语言：`return a / b` 里的 `/` 必须是除号，不能吃掉后面的声明
const NO_REGEX_LANGS = [
  ['go', 'func f() int { return a / b }\n' + 'func after() int { return 1 }\n', 'after'],
  ['rs', 'fn f() -> i32 { return a / b }\n' + 'fn after() -> i32 { return 1 }\n', 'after'],
  // Java/C# 的对照符号是类名 `After`（大写）——断言要跟着夹具的命名，
  // 而不是反过来。这里出错两次，都是断言写错而不是代码错。
  ['java', 'class C { int fn() { return a / b; } }\n' + 'class After { }\n', 'After'],
  ['cs', 'class C { int Fn() { return a / b; } }\n' + 'class After { }\n', 'After'],
  ['kt', 'fun f(): Int { return a / b }\n' + 'fun after(): Int { return 1 }\n', 'after'],
  ['swift', 'func f() -> Int { return a / b }\n' + 'func after() -> Int { return 1 }\n', 'after'],
  ['c', 'int f() { return a / b; }\n' + 'int after() { return 1; }\n', 'after'],
  ['scala', 'def f(): Int = a / b\n' + 'def after(): Int = 1\n', 'after'],
  ['dart', 'int f() { return a / b; }\n' + 'int after() { return 1; }\n', 'after'],
]
for (const [ext, src, expected] of NO_REGEX_LANGS) {
  const lang = langOf(`x.${ext}`)
  check(`${ext} 未配 regexLiterals`, lang !== null && lang.regexLiterals === undefined)
  const got = names(src, `x.${ext}`)
  check(`${ext} 的除法后声明 ${expected} 仍可见`, got.includes(expected), JSON.stringify(got))
}

// ── 4. 自指断言：连自己都索引不全，就说明引擎又失明了 ────────────────────────
say('')
say('=== 4. 自指：本引擎必须能完整索引自己的源码 ===')
const ENGINE_FILES = ['read-core.mjs', 'struct-core.mjs', 'anchor-core.mjs', 'locator-api.mjs']
for (const f of ENGINE_FILES) {
  const src = fs.readFileSync(path.join(here, f), 'utf8')
  // 真实声明：以 `function name` 或 `export function name` 开头的顶层函数
  const declared = [...src.matchAll(/^(?:export\s+)?function\s+(\w+)/gm)].map((m) => m[1])
  const indexed = new Set(names(src, f))
  const missing = declared.filter((n) => !indexed.has(n))
  check(
    `${f}：${declared.length} 个顶层 function 全部索引到`,
    missing.length === 0,
    missing.length === 0 ? '' : `缺失 ${missing.length}：${missing.join(', ')}`,
  )
}

// 跨度不能塌成一行——`renderDigest 69-69` 就是当初的形态
say('')
say('=== 5. 符号跨度不得塌陷（真实多行函数不能报成单行）===')
for (const f of ENGINE_FILES) {
  const src = fs.readFileSync(path.join(here, f), 'utf8')
  const syms = listSymbols(indexStructure(src, langOf(f)))
  // 源码里真实长度 > 3 行的函数，索引出来的跨度也必须 > 1 行
  const lines = src.split('\n')
  const declared = [...src.matchAll(/^(?:export\s+)?function\s+(\w+)/gm)].map((m) => m[1])
  const collapsed = []
  for (const name of declared) {
    const s = syms.find((x) => x.name === name && x.kind === 'function')
    if (s === undefined) continue
    const realEnd = (() => {
      // 从声明行起配平花括号，得到真实结束行
      let depth = 0
      let seen = false
      for (let n = s.startLine; n <= lines.length; n += 1) {
        for (const ch of lines[n - 1]) {
          if (ch === '{') { depth += 1; seen = true }
          else if (ch === '}') depth -= 1
        }
        if (seen && depth === 0) return n
      }
      return s.startLine
    })()
    const realSpan = realEnd - s.startLine + 1
    if (realSpan > 3 && s.endLine - s.startLine + 1 <= 1) collapsed.push(`${name} ${s.startLine}-${s.endLine} (真实到 ${realEnd})`)
  }
  check(`${f}：无跨度塌陷`, collapsed.length === 0, collapsed.join('; '))
}

// ── 6. locate 能按名字命中这些函数（端到端，不只是索引层）───────────────────
say('')
say('=== 6. 端到端：locate 能按名字命中引擎自己的函数 ===')
{
  const src = fs.readFileSync(path.join(here, 'read-core.mjs'), 'utf8')
  for (const name of ['readWith', 'renderDigest', 'windowEnvelope', 'fitWithin']) {
    const l = locate(src, { target: name, filePath: 'read-core.mjs' })
    check(`target=${name} 可定位`, l.ok === true && l.tier === 'symbol' && l.endLine > l.startLine, l.ok ? `${l.startLine}-${l.endLine}` : l.code)
  }
}

say('')
say(`--- ${pass}/${pass + fail} 通过 ---`)
process.exitCode = fail === 0 ? 0 : 1
