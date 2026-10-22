/**
 * lang-test.mjs —— 语言覆盖的针对性验证。
 *
 * 三组：
 *   A. 新增语言各自的符号识别（含最容易出错的地方）
 *   B. **注释陷阱**：shell 的 `$#` / `${#}`、PowerShell 的 `<# #>`、Perl 的 `#`
 *   C. 用**本机真实文件**跑一遍，确认不崩、提取到东西
 */
import fs from 'node:fs'
import path from 'node:path'
import { indexStructure, langOf, listSymbols, LANGS } from './struct-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}
const names = (src, ext) => listSymbols(indexStructure(src, langOf(ext))).map((s) => `${s.kind}:${s.name}`)

say('=== A. 新增语言的符号识别 ===')

const sh = ['#!/bin/bash', 'foo() {', '  echo hi', '}', 'function bar {', '  ls', '}'].join('\n')
check(names(sh, 'x.sh').includes('function:foo'), `shell 的 name() { } 被识别：${JSON.stringify(names(sh, 'x.sh'))}`)
check(names(sh, 'x.sh').includes('function:bar'), 'shell 的 function name 被识别')

const ps1 = ['function Get-Thing {', '  param($x)', '}', 'class Foo {', '  [string]$Name', '}'].join('\n')
check(names(ps1, 'x.ps1').includes('function:Get-Thing'), `PowerShell 函数：${JSON.stringify(names(ps1, 'x.ps1'))}`)
check(names(ps1, 'x.ps1').includes('class:Foo'), 'PowerShell 类被识别')

const pyx = ['cdef class Foo:', '    pass', '', 'def py_fn(x):', '    pass', '', 'cdef c_fn(int a):', '    pass'].join('\n')
const pyxNames = names(pyx, 'x.pyx')
check(pyxNames.includes('class:Foo'), `Cython cdef class：${JSON.stringify(pyxNames)}`)
check(pyxNames.includes('function:py_fn') && pyxNames.includes('function:c_fn'), 'Cython def 与 cdef 都被识别')

const proto = ['message Foo {', '  string a = 1;', '}', 'enum E {', '  A = 0;', '}', 'service S {', '  rpc Get(Foo) returns (Foo);', '}'].join('\n')
const protoNames = names(proto, 'x.proto')
check(protoNames.includes('message:Foo'), `proto message：${JSON.stringify(protoNames)}`)
check(protoNames.includes('enum:E') && protoNames.includes('service:S') && protoNames.includes('rpc:Get'), 'proto enum/service/rpc 都被识别')

const pl = ['package Foo;', 'sub bar {', '  my $x = 1;', '}'].join('\n')
const plNames = names(pl, 'x.pl')
check(plNames.includes('package:Foo') && plNames.includes('function:bar'), `Perl package 与 sub：${JSON.stringify(plNames)}`)

const bat = ['@echo off', ':main', 'call :helper', 'goto :eof'].join('\n')
check(names(bat, 'x.bat').length > 0, `bat 提取到 ${names(bat, 'x.bat').length} 个符号：${JSON.stringify(names(bat, 'x.bat'))}`)

say('')
say('=== B. 注释陷阱（最容易静默出错的地方）===')
// shell：`$#` 与 `${#var}` 里的 # 不是注释。搞错了会**整行被吞**，表现为后面的声明凭空消失。
const trap = 'echo $#\nreal_fn() {\n  echo ${#var}\n}\n'
const trapNames = names(trap, 'x.sh')
check(trapNames.includes('function:real_fn'), `$# 与 \${#var} 之后的函数仍被找到：${JSON.stringify(trapNames)}`)
// 反证：若 # 被当注释，`echo $#` 那行会被吃掉，但 real_fn 仍在——所以还要验一个**紧跟 $# 的声明**
const trap2 = 'x=$#; after() { :; }\n'
check(names(trap2, 'x.sh').includes('function:after'), `同一行内 $# 之后的声明仍被找到：${JSON.stringify(names(trap2, 'x.sh'))}`)

// PowerShell：块注释 <# #> 必须被整体吃掉，里面的 function 不能成为符号
const psTrap = '<#\nfunction NotReal { }\n#>\nfunction Real { }\n'
const psTrapNames = names(psTrap, 'x.ps1')
check(!psTrapNames.includes('function:NotReal'), `块注释里的 function 未被识别：${JSON.stringify(psTrapNames)}`)
check(psTrapNames.includes('function:Real'), '块注释外的 function 被识别')

// Perl：POD 之外，`#` 是注释
const plTrap = '# sub NotReal { }\nsub Real { }\n'
check(!names(plTrap, 'x.pl').includes('function:NotReal'), 'Perl 注释里的 sub 未被识别')

// Cython：Python 风格的三引号字符串里的 def 不能被识别
const pyxTrap = '"""\ndef NotReal():\n    pass\n"""\ndef Real():\n    pass\n'
const pyxTrapNames = names(pyxTrap, 'x.pyx')
check(!pyxTrapNames.includes('function:NotReal'), `三引号里的 def 未被识别：${JSON.stringify(pyxTrapNames)}`)

// proto：注释里的 message
const protoTrap = '// message NotReal {}\nmessage Real {\n}\n'
check(!names(protoTrap, 'x.proto').includes('message:NotReal'), 'proto 注释里的 message 未被识别')

say('')
say('=== C. 真实文件：不崩、有提取 ===')
const ROOTS = ['E:\\workspaces', 'C:\\Users\\cxk\\.agents']
const NEW_EXTS = ['sh', 'ps1', 'pyx', 'pxd', 'pxi', 'proto', 'pl', 'pm', 'bat', 'cmd', 'bash']
const found = new Map()
function walk(dir, depth) {
  if (depth > 6) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      walk(p, depth + 1)
      continue
    }
    const ext = path.extname(e.name).slice(1).toLowerCase()
    if (!NEW_EXTS.includes(ext)) continue
    const bucket = found.get(ext) ?? []
    if (bucket.length >= 8) continue
    bucket.push(p)
    found.set(ext, bucket)
  }
}
for (const r of ROOTS) if (fs.existsSync(r)) walk(r, 0)

let files = 0
let broken = 0
let symbols = 0
for (const [ext, list] of [...found.entries()].sort()) {
  let localSym = 0
  let localBroken = 0
  for (const f of list) {
    files += 1
    let src
    try {
      src = fs.readFileSync(f, 'utf8')
    } catch {
      localBroken += 1
      continue
    }
    try {
      localSym += listSymbols(indexStructure(src, langOf(f))).length
    } catch (e) {
      localBroken += 1
      say(`    ! ${path.basename(f)}: ${e.message}`)
    }
  }
  broken += localBroken
  symbols += localSym
  say(`  ${ext.padEnd(8)} ${String(list.length).padStart(3)} 个文件  ${String(localSym).padStart(5)} 个符号  ${localBroken === 0 ? 'ok' : `${localBroken} 失败`}`)
}
check(files > 0, `找到 ${files} 个真实文件用于验证`)
check(broken === 0, '全部真实文件建索引无异常', `失败 ${broken}`)
check(symbols > 0, `合计提取 ${symbols} 个符号`)

say('')
say('=== D. 覆盖概览 ===')
const exts = Object.keys(LANGS).sort()
check(exts.length >= 40, `共 ${exts.length} 种扩展名`)
say(`  ${exts.join(' ')}`)

const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) process.exitCode = 1
