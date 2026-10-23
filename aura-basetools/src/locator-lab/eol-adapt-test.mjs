/**
 * eol-adapt-test —— 0.10.0：`replace` 的换行风格对齐内置编辑工具。
 *
 * 内置 `Edit` 会把新行的 LF 适配成文件已有 CRLF；aura 原先严格按 `replace` 原样写，
 * 模型写 `\n` 就会在 CRLF 文件里制造混合行尾。本套件钉住：
 *   · `auto`（默认）：用被替换区域末行的行尾；没有就看首行/文件里第一个非空行尾；
 *   · `preserve`：按 `replace` 原样（旧的逐字节口径）；
 *   · `lf` / `crlf`：强制统一；
 *   · 只改被寻址区域；BOM 与未触及行的字节不动。
 */
import fs from 'node:fs'
import { FLAT_ADDRESS_KEYS, flatHunk } from './args.mjs'
import { planHunks } from './write-path.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    pass += 1
    say(`  ✓ ${label}${detail === '' ? '' : `  ${detail}`}`)
  } else {
    fail += 1
    say(`  ✗ ${label}${detail === '' ? '' : `  ${detail}`}`)
  }
}
const plan = (content, hunks) => planHunks(content, hunks, 'eol-fixture.txt')
const thrownBy = (fn) => {
  try { fn(); return null } catch (error) { return error }
}

say('=== A. auto：CRLF 文件写 CRLF，BOM 与区外字节不动 ===')
{
  const src = '\uFEFFalpha\r\nbravo\r\ncharlie\r\n'
  const p = plan(src, [{ lines: [2, 2], replace: 'BRAVO\nEXTRA' }])
  check('A1 新行被适配成 CRLF', p.content === '\uFEFFalpha\r\nBRAVO\r\nEXTRA\r\ncharlie\r\n', JSON.stringify(p.content))
  check('A2 eolAdapted=true', p.applied[0].eolAdapted === true, JSON.stringify(p.applied[0]))
  // `replaced` 的口径是“行文本”（不含行尾，与既有契约一致）；实际字节看 content。
  check('A3 replaced 回执按行文本口径给出（行尾不进 replaced）', p.applied[0].replaced === 'BRAVO\nEXTRA', JSON.stringify(p.applied[0].replaced))
  check('A4 只有第 2 行区段变化（BOM 与首尾行逐字不动）', p.content.startsWith('\uFEFFalpha\r\n') && p.content.endsWith('charlie\r\n'), JSON.stringify(p.content))
}

say('')
say('=== B. preserve / lf / crlf：显式模式不被 auto 改写 ===')
{
  const src = 'alpha\r\nbravo\r\ncharlie\r\n'
  const keep = plan(src, [{ lines: [2, 2], replace: 'BRAVO\nEXTRA', eol: 'preserve' }])
  check('B1 preserve：保留 replace 的 LF（混合行尾）', keep.content === 'alpha\r\nBRAVO\nEXTRA\r\ncharlie\r\n' && keep.applied[0].eolAdapted === undefined, JSON.stringify(keep.content))
  const lf = plan(src, [{ lines: [2, 2], replace: 'BRAVO\r\nEXTRA', eol: 'lf' }])
  check('B2 lf：只把替换文本强制成 LF（未触及行保持 CRLF）', lf.content === 'alpha\r\nBRAVO\nEXTRA\r\ncharlie\r\n' && lf.applied[0].eolAdapted === true, JSON.stringify(lf.content))
  const crlf = plan('alpha\nbravo\ncharlie\n', [{ lines: [2, 2], replace: 'BRAVO\nEXTRA', eol: 'crlf' }])
  check('B3 crlf：只把替换文本强制成 CRLF（未触及行保持 LF）', crlf.content === 'alpha\nBRAVO\r\nEXTRA\ncharlie\n' && crlf.applied[0].eolAdapted === true, JSON.stringify(crlf.content))
}

say('')
say('=== C. 混合行尾：目标取被替换区域末行的行尾 ===')
{
  const src = 'alpha\r\nbravo\ncharlie\r\n'
  const p = plan(src, [{ lines: [2, 2], replace: 'B\nC' }])
  check('C1 第 2 行是 LF ⇒ 新行也用 LF', p.content === 'alpha\r\nB\nC\ncharlie\r\n' && p.applied[0].eolAdapted !== true, JSON.stringify(p.content))
  const q = plan(src, [{ lines: [3, 3], replace: 'C1\nC2' }])
  check('C2 第 3 行是 CRLF ⇒ 新行也用 CRLF', q.content === 'alpha\r\nbravo\nC1\r\nC2\r\n' && q.applied[0].eolAdapted === true, JSON.stringify(q.content))
}

say('')
say('=== D. 文件末尾无尾换行：插入行用已有行尾，但不凭空加尾换行 ===')
{
  const src = 'a\nb\nc'
  const p = plan(src, [{ lines: [3, 3], replace: 'c\nD' }])
  check('D1 新行有分隔符，文件仍无尾换行', p.content === 'a\nb\nc\nD' && !p.content.endsWith('\n'), JSON.stringify(p.content))
  check('D2 替换文本已是目标行尾 ⇒ 不需要改写', p.applied[0].eolAdapted !== true, JSON.stringify(p.applied[0]))
}

say('')
say('=== E. 非法 eol 模式：规划期拒绝，不写盘 ===')
{
  const err = thrownBy(() => plan('x\n', [{ lines: [1, 1], replace: 'y', eol: 'bogus' }]))
  check('E1 抛 PATCH_BAD_EOL', err?.code === 'PATCH_BAD_EOL', err === null ? '没有抛错' : err.code)
  check('E2 message 点名可选值', /auto, preserve, lf, or crlf/.test(String(err?.message ?? '')), String(err?.message ?? ''))
}

say('')
say('=== F. 入口接线：扁平 hunk 与参数名单收下 eol ===')
{
  const flat = flatHunk({ lines: [1, 1], replace: 'x', eol: 'preserve' })
  check('F1 flatHunk 保留 eol', flat?.eol === 'preserve', JSON.stringify(flat))
  check('F2 eol 不是地址键（单独给 eol 不构成 hunk）', !FLAT_ADDRESS_KEYS.includes('eol') && flatHunk({ eol: 'preserve', replace: 'x' }) === null, FLAT_ADDRESS_KEYS.join(','))
}

say('')
say(`--- EOL 适配：${pass}/${pass + fail} 通过 ---`)
process.exitCode = fail === 0 ? 0 : 1
