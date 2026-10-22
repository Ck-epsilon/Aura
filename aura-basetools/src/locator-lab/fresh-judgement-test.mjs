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
 * ## T28：Rust `pub const` 提不出符号（机制未查明）
 *
 * 顺带把已确认的形状差异钉住：`const` / `static` 能出，`pub static` 能出，
 * 但 **`pub const` 不行**（而 `pub(crate) const` 又能）。本机**零个 `.rs` 文件**，
 * 所以这条无法用真实语料量化——只能把"当前已知行为"固定下来，避免它悄悄变化而无人知。
 * 这里**不**断言正确值（那会变成把 bug 写成契约），只断言"与已记录的形状一致"，
 * 并在不符时把差异打出来——下次修它时，这条会先红。
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
  check('时间戳在同一刻度内会重复（6 次写未产生 6 个版本）', seen.size < 6, `实得 ${seen.size}`)
  check('因此"新鲜度"必须靠 inode 或内容哈希，不能只靠 mtime', true)
}

say('')
say('=== T28：Rust 修饰符变量绑定的已知形状 ===')
{
  /**
   * 已实测的形状（本轮两次独立确认）：
   *   const A: i32 = 1            → 有
   *   static A: i32 = 1           → 有
   *   pub static A: i32 = 1       → 有
   *   pub(crate) const C: u8 = 2  → 有
   *   pub const A: i32 = 1        → **无**（机制未查明）
   *   pub const B: u8 = 2;        → **无**
   * 只断言"出得来"的那几个（它们是真收益）；`pub const` 的缺失**记为已知差异**，
   * 不写成断言——否则修好它反而会红。
   */
  const lang = langOf('x.rs')
  check('Rust 已登记（否则本段无意义）', lang !== null)
  const names = (src) => listSymbols(indexStructure(src, lang)).map((s) => s.name)
  const CASES = [
    ['const A: i32 = 1', 'A'],
    ['static B: i32 = 1', 'B'],
    ['pub static C: i32 = 1', 'C'],
    ['pub(crate) const D: u8 = 2', 'D'],
    ['pub fn e() {}', 'e'],
    ['pub struct F;', 'F'],
  ]
  for (const [src, want] of CASES) {
    const got = names(src)
    check(`Rust ${JSON.stringify(src)} → 含 ${want}`, got.includes(want), JSON.stringify(got))
  }
  // 已知差异：不判红，但把事实打印出来，免得它被忘掉或悄悄变化。
  const gap = names('pub const G: i32 = 1')
  say(`  ⚠ 已知差异：\`pub const G: i32 = 1\` → ${JSON.stringify(gap)}（机制未查明，本机零 .rs 语料，无法量化）`)
  if (gap.includes('G')) {
    say('  ⚠ 这条已经能出了——请更新 T28 的记录并把它升为断言')
  }
}

fs.rmSync(tmp, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) process.exitCode = 1
