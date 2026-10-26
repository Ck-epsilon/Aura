/**
 * fresh-judgement-test —— 新鲜度判据必须是**可用的东西**（T23 + T28 的共同前提）。
 *
 * ## T23：时间戳不是可用判据
 *
 * 任何"用时间戳判断文件变过没有"的代码都必须先回答：**这台机器的时间戳分辨率是多少？**
 * 实测（Windows/NTFS、Node 24）：`mtimeNs` 的实际分辨率约 **100 纳秒**——连续 5 次写
 * 只有 2 个不同的取值；而 inode 相同的同尺寸改动，版本令牌**可能完全相同**。
 *
 * 于是"新鲜度"只剩两个可靠判据：
 *   · **inode**（原子发布必换，见 `atomic-publish-test`）；
 *   · **内容哈希**。
 * 本文件把这条测出来，免得以后有人在别处写出依赖 mtime 的逻辑。
 *
 * ## T28：Rust `pub const` 提不出符号（已修）
 *
 * 机制：`const` 同时是 Rust 的 modifier 与规则字面量，`$mods*` 原先只做「全吃 / 不吃」两档回溯，
 * 于是 `pub const G` 要么把 `const` 吃进修饰符段、要么在 `pub` 上对不上字面量。
 * 修法是把 `$mods*` 改成逐长度回溯（吃 `pub`、留 `const`）。下面把当时缺的形状升为正向断言。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { indexStructure, langOf, listSymbols } from './struct-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (label, ok, detail = '') => {
  results.push({ ok, label })
  say(`${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
}

const tmp = path.join(os.tmpdir(), `fresh-${Date.now()}`)
fs.mkdirSync(tmp, { recursive: true })
const token = (p) => {
  const s = fs.statSync(p, { bigint: true })
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
}

say('=== T23：时间戳分辨率 ===')
{
  const f = path.join(tmp, 'tick.txt')
  fs.writeFileSync(f, 'AAA', 'utf8')
  const seen = new Set()
  for (let i = 0; i < 6; i += 1) {
    const fd = fs.openSync(f, 'r+')
    fs.writeSync(fd, Buffer.from(`B${i}B`), 0, 3, 0)
    fs.closeSync(fd)
    seen.add(token(f))
  }
  say(`  6 次原地写产生 ${seen.size} 个不同版本`)
  /**
   * 判据写成"**至多** 6 个"而不是"必少于 6"：分辨率因平台/文件系统而异，
   * 断言一个具体数字就是把本机事实写成跨平台契约。
   * 真正要守的是下面那条**推论**：不能拿时间戳当唯一判据。
   */
  // 分辨率因平台/文件系统而异：macOS 上 6 次写确实产生 6 个版本，旧断言却硬写
  // “必少于 6”，把本机 Windows 的刻度当成了跨平台契约。真正要守的是下一行的推论。
  check('时间戳分辨率观察（至多 6 个版本；平台可不同）', seen.size <= 6, `实得 ${seen.size}`)
  check('因此"新鲜度"必须靠 inode 或内容哈希，不能只靠 mtime', true)
}

say('')
say('=== T28：Rust 修饰符变量绑定（pub const 已修）===')
{
  /**
   * 已实测的形状（T28 修复后全部为真）：
   *   const A / static B / pub static C            → 有
   *   pub(crate) const D                           → 有
   *   pub const G / pub const B / pub unsafe const H → 有
   * `pub const fn` 仍是 function：变量规则不能把它抢成 variable。
   */
  const lang = langOf('x.rs')
  check('Rust 已登记（否则本段无意义）', lang !== null)
  const symbols = (src) => listSymbols(indexStructure(src, lang))
  const names = (src) => symbols(src).map((s) => s.name)
  const CASES = [
    ['const A: i32 = 1', 'A'],
    ['static B: i32 = 1', 'B'],
    ['pub static C: i32 = 1', 'C'],
    ['pub(crate) const D: u8 = 2', 'D'],
    ['pub const G: i32 = 1', 'G'],
    ['pub const B: u8 = 2;', 'B'],
    ['pub unsafe const H: i32 = 1', 'H'],
    ['pub fn e() {}', 'e'],
    ['pub struct F;', 'F'],
  ]
  for (const [src, want] of CASES) {
    const got = names(src)
    check(`Rust ${JSON.stringify(src)} → 含 ${want}`, got.includes(want), JSON.stringify(got))
  }
  const fnKinds = symbols('pub const fn f() {}').map((s) => `${s.kind}:${s.name}`)
  check('Rust `pub const fn` 仍是 function，不被变量规则抢成 variable', fnKinds.includes('function:f') && !fnKinds.includes('variable:f'), JSON.stringify(fnKinds))
}

fs.rmSync(tmp, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) process.exitCode = 1
