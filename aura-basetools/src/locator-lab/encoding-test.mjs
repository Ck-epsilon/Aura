/**
 * encoding-test —— 非 UTF-8 支持的判据（2026-10-25 反馈第一条）。
 *
 * ## 这层承诺什么
 *
 *   · **读**：UTF-8 / UTF-16LE/BE（BOM）/ GB18030（GBK）/ Shift_JIS / EUC-KR / Big5 /
 *     Windows-1252 自动探测；合法 UTF-8 一律按 UTF-8 处理（与支持多编码之前逐字节一致）。
 *   · **写**：用**读时那次探测**回编码；未改动的行逐字节保留；编码不可逆或猜不准时拒绝写。
 *   · **拒绝**：目标编码表示不了的字符 ⇒ `ENCODING_UNREPRESENTABLE`，零写入。
 *
 * 为什么“不可逆就拒绝”：同一个字符在某个编码里可能有多个字节表示，若 decode→encode
 * 不能逐字节还原原文件，那么“改一行”可能把没改的行也换一种写法——逐字节保真的承诺就破了。
 *
 * 运行：node src/locator-lab/encoding-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { probeEncoding, decodeBytes, encodeText } from '../aura-standalone/lib/encoding.mjs'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const root = path.resolve(here, '..', '..')
const bin = path.join(root, 'src', 'aura-standalone', 'bin', 'aura.mjs')

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}
const say = (line = '') => console.log(line)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-encoding-'))
const env = { ...process.env, AURA_CACHE_DIR: path.join(tmp, 'cache') }
const run = (args, extraEnv = {}) =>
  spawnSync(process.execPath, [bin, 'basetools', ...args], { cwd: tmp, encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: 60000 })
const parse = (res) => {
  try {
    return JSON.parse(String(res.stdout ?? '').trim())
  } catch {
    return null
  }
}
const file = (name) => path.join(tmp, name)

// ── A. 探测──────────────────────────────────────────────────────────────────
say('=== A. 探测：BOM / 合法 UTF-8 / 候选打分 ===')
{
  const utf8 = Buffer.from('中文测试\n', 'utf8')
  const p = probeEncoding(utf8)
  check(p.encoding === 'utf-8' && p.confidence === 'high', 'A1 合法 UTF-8 ⇒ utf-8（不被误判成 GBK）', JSON.stringify(p))

  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8])
  check(probeEncoding(bom).encoding === 'utf-8' && probeEncoding(bom).bom.length === 3, 'A2 UTF-8 BOM 被识别并保留')

  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('alpha\r\n', 'utf16le')])
  const p16 = probeEncoding(u16)
  check(p16.encoding === 'utf-16le' && p16.bom.length === 2 && p16.roundTrip === true, 'A3 UTF-16LE + BOM ⇒ utf-16le、可逆', JSON.stringify(p16))

  const gbk = encodeText('这是一个测试文件\r\n第二行内容\r\n', { encoding: 'gb18030', bom: [] })
  const pg = probeEncoding(gbk)
  check(pg.encoding === 'gb18030' && pg.confidence === 'high', 'A4 GBK 中文 ⇒ gb18030（高置信）', JSON.stringify(pg))
  check(decodeBytes(gbk, pg) === '这是一个测试文件\r\n第二行内容\r\n', 'A5 GBK 解码文本正确')

  const sjis = encodeText('これはテストです。\n二行目です。\n', { encoding: 'shift_jis', bom: [] })
  const ps = probeEncoding(sjis)
  check(ps.encoding === 'shift_jis' && ps.confidence === 'high', 'A6 Shift_JIS 日文 ⇒ shift_jis（高置信）', JSON.stringify(ps))

  const kr = encodeText('이것은 테스트입니다.\n', { encoding: 'euc-kr', bom: [] })
  const pk = probeEncoding(kr)
  check(pk.encoding === 'euc-kr' && pk.confidence === 'high', 'A7 EUC-KR 韩文 ⇒ euc-kr（高置信）', JSON.stringify(pk))

  const binary = Buffer.from([0x00, 0x01, 0xff, 0x00])
  check(probeEncoding(binary).encoding === null, 'A8 二进制（无 BOM、含 NUL）⇒ 拒绝')
}

// ── B. 端到端：GBK 读 + 改，未改动的行逐字节保留 ─────────────────────────────
say('')
say('=== B. GBK：读 → 改第 2 行 → 字节仍是 GBK、第 1 行未变 ===')
{
  const target = file('gbk.txt')
  const original = encodeText('这是一个测试文件\r\n第二行内容\r\n', { encoding: 'gb18030', bom: [] })
  fs.writeFileSync(target, original)
  const read = parse(run(['read', '--file', target, '--mode', 'full', '--pretty']))
  check(read?.ok === true && read.encoding === 'gb18030', 'B1 回执带 encoding=gb18030', JSON.stringify({ ok: read?.ok, encoding: read?.encoding }))
  check(typeof read?.text === 'string' && read.text.includes('这是一个测试文件'), 'B2 解出的正文是中文（不是乱码）', String(read?.text).slice(0, 40))

  const edit = parse(run(['edit', '--file', target, '--lines', '2', '--replace', '第二行已改', '--pretty']))
  check(edit?.ok === true, 'B3 改第 2 行成功', JSON.stringify({ ok: edit?.ok, code: edit?.code, error: String(edit?.error ?? '').slice(0, 80) }))

  const after = fs.readFileSync(target)
  const probe = probeEncoding(after)
  check(probe.encoding === 'gb18030' && decodeBytes(after, probe) === '这是一个测试文件\r\n第二行已改\r\n', 'B4 文件仍是 GBK 且内容正确', JSON.stringify(decodeBytes(after, probe)))
  const firstLineBytes = original.subarray(0, original.indexOf(0x0d))
  check(after.subarray(0, after.indexOf(0x0d)).equals(firstLineBytes), 'B5 未改动的第 1 行逐字节保留')
}

// ── C. UTF-16LE：BOM 只有一个，正文正确 ──────────────────────────────────────
say('')
say('=== C. UTF-16LE：读 → 改 → BOM 不重复 ===')
{
  const target = file('u16.txt')
  fs.writeFileSync(target, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('alpha\r\nbeta\r\n', 'utf16le')]))
  const read = parse(run(['read', '--file', target, '--mode', 'full', '--pretty']))
  check(read?.ok === true && read.encoding === 'utf-16le', 'C1 回执带 encoding=utf-16le', JSON.stringify({ ok: read?.ok, encoding: read?.encoding }))
  const edit = parse(run(['edit', '--file', target, '--lines', '2', '--replace', 'BETA2', '--pretty']))
  check(edit?.ok === true, 'C2 改 UTF-16LE 文件成功', JSON.stringify({ ok: edit?.ok, code: edit?.code }))
  const after = fs.readFileSync(target)
  const boms = after.length >= 2 && after[0] === 0xff && after[1] === 0xfe ? 1 : 0
  const decoded = new TextDecoder('utf-16le').decode(after)
  check(boms === 1 && decoded === 'alpha\r\nBETA2\r\n', 'C3 BOM 恰好一个、正文正确', JSON.stringify({ boms, decoded }))
}

// ── D. Shift_JIS：读 + 改 ────────────────────────────────────────────────────
say('')
say('=== D. Shift_JIS：读 + 改 ===')
{
  const target = file('sjis.txt')
  fs.writeFileSync(target, encodeText('これはテストです。\n二行目です。\n', { encoding: 'shift_jis', bom: [] }))
  const read = parse(run(['read', '--file', target, '--mode', 'full', '--pretty']))
  check(read?.ok === true && read.encoding === 'shift_jis', 'D1 回执带 encoding=shift_jis', JSON.stringify({ ok: read?.ok, encoding: read?.encoding }))
  const edit = parse(run(['edit', '--file', target, '--lines', '2', '--replace', '二行目を変更', '--pretty']))
  check(edit?.ok === true, 'D2 改 Shift_JIS 文件成功', JSON.stringify({ ok: edit?.ok, code: edit?.code }))
  const after = fs.readFileSync(target)
  check(decodeBytes(after, probeEncoding(after)) === 'これはテストです。\n二行目を変更\n', 'D3 内容正确且仍是 Shift_JIS')
}

// ── E. 补充平面：GB18030 4 字节可写；BMP 缺口仍拒绝 ─────────────────────────
say('')
say('=== E. GB18030 4 字节：emoji 可写，BMP 扩展区仍拒绝 ===')
{
  const target = file('gbk-emoji.txt')
  const original = encodeText('第一行\r\n第二行\r\n', { encoding: 'gb18030', bom: [] })
  fs.writeFileSync(target, original)
  // 🙂 U+1F642 在补充平面：GB18030 用 4 字节线性形式，必须能写回。
  const emoji = parse(run(['edit', '--file', target, '--lines', '2', '--replace', '第二行 🙂', '--pretty']))
  check(emoji?.ok === true, 'E1 补充平面字符（🙂）可写入 GBK 文件', JSON.stringify({ ok: emoji?.ok, code: emoji?.code, error: String(emoji?.error ?? '').slice(0, 80) }))
  const afterEmoji = fs.readFileSync(target)
  check(decodeBytes(afterEmoji, probeEncoding(afterEmoji)) === '第一行\r\n第二行 🙂\r\n', 'E2 4 字节往返后内容正确')
  check(probeEncoding(afterEmoji).encoding === 'gb18030', 'E3 文件仍是 GB18030')

  const refuse = file('gbk-bmp.txt')
  fs.writeFileSync(refuse, original)
  // 㐀 U+3400（CJK 扩展 A）在 GB18030 里用 4 字节**非线性**区：本工具不内置该表，必须拒绝。
  const bmp = parse(run(['edit', '--file', refuse, '--lines', '1', '--replace', '㐀', '--pretty']))
  check(bmp?.ok === false && bmp?.code === 'ENCODING_UNREPRESENTABLE', 'E4 BMP 扩展区（㐀）仍给 ENCODING_UNREPRESENTABLE', JSON.stringify({ ok: bmp?.ok, code: bmp?.code }))
  check(fs.readFileSync(refuse).equals(original), 'E5 拒绝时文件一个字节都没动')
}

// ── F. UTF-8 回归：多编码支持不改变 UTF-8 行为 ───────────────────────────────
say('')
say('=== F. UTF-8 回归 ===')
{
  const target = file('plain.txt')
  fs.writeFileSync(target, 'alpha\nbravo\n')
  const read = parse(run(['read', '--file', target, '--mode', 'full', '--pretty']))
  check(read?.ok === true && read.encoding === undefined, 'F1 UTF-8 回执不带 encoding（与支持多编码之前逐字节相同）', JSON.stringify({ encoding: read?.encoding }))
  const edit = parse(run(['edit', '--file', target, '--lines', '2', '--replace', 'BRAVO', '--pretty']))
  check(edit?.ok === true && fs.readFileSync(target, 'utf8') === 'alpha\nBRAVO\n', 'F2 UTF-8 编辑行为不变')
}

// ── G. 显式覆盖（猜不准时的逃生口）──────────────────────────────────────────
say('')
say('=== G. 显式编码覆盖（AURA_ENCODING）===')
{
  const target = file('hint.txt')
  fs.writeFileSync(target, encodeText('中文内容\r\n', { encoding: 'gb18030', bom: [] }))
  const read = parse(run(['read', '--file', target, '--mode', 'full', '--pretty'], { AURA_ENCODING: 'gb18030' }))
  check(read?.ok === true && read.encoding === 'gb18030' && read.encoding_source === 'explicit', 'G1 显式编码被采纳并标 explicit', JSON.stringify({ encoding: read?.encoding, source: read?.encoding_source }))
}

// ── H. 文件级编码记忆：设一次就够 ──────────────────────────────────────────
say('')
say('=== H. 显式指定过的编码被记住（指纹对得上才用）===')
{
  const target = file('memo.txt')
  const original = encodeText('中文测试\r\n第二行\r\n', { encoding: 'gb18030', bom: [] })
  fs.writeFileSync(target, original)
  const cold = parse(run(['edit', '--file', target, '--lines', '2', '--replace', '第二行甲', '--pretty']))
  check(cold?.ok === false && cold?.code === 'ENCODING_AMBIGUOUS', 'H1 未指定编码且置信度不足 ⇒ 拒绝写', JSON.stringify({ ok: cold?.ok, code: cold?.code }))
  const hint = parse(run(['edit', '--file', target, '--lines', '2', '--replace', '第二行甲', '--pretty'], { AURA_ENCODING: 'gb18030' }))
  check(hint?.ok === true, 'H2 显式指定后写成功', JSON.stringify({ ok: hint?.ok, code: hint?.code }))
  const warm = parse(run(['edit', '--file', target, '--lines', '2', '--replace', '第二行乙', '--pretty']))
  check(warm?.ok === true, 'H3 不再设环境变量也能写（记忆生效）', JSON.stringify({ ok: warm?.ok, code: warm?.code }))
  fs.appendFileSync(target, Buffer.from([0x0d, 0x0a]))
  const stale = parse(run(['edit', '--file', target, '--lines', '2', '--replace', '第二行丙', '--pretty']))
  check(stale?.ok === false && stale?.code === 'ENCODING_AMBIGUOUS', 'H4 文件被外部改过 ⇒ 记忆失效，重新要求显式指定', JSON.stringify({ ok: stale?.ok, code: stale?.code }))
}

// ── I. 逐调用 --encoding ───────────────────────────────────────────────────
say('')
say('=== I. 逐调用 --encoding（不动环境变量）===')
{
  const target = file('percall.txt')
  fs.writeFileSync(target, encodeText('中文测试\r\n第二行\r\n', { encoding: 'gb18030', bom: [] }))
  const cold = parse(run(['edit', '--file', target, '--lines', '2', '--replace', '第二行丁', '--pretty']))
  check(cold?.ok === false && cold?.code === 'ENCODING_AMBIGUOUS', 'I1 不带 --encoding 仍拒绝')
  const withFlag = parse(run(['edit', '--file', target, '--lines', '2', '--replace', '第二行丁', '--encoding', 'gb18030', '--pretty']))
  check(withFlag?.ok === true, 'I2 --encoding 对本次调用生效', JSON.stringify({ ok: withFlag?.ok, code: withFlag?.code }))
  const after = fs.readFileSync(target)
  check(decodeBytes(after, probeEncoding(after)).includes('第二行丁'), 'I3 写回内容正确且仍是 GBK')
}

say('')
say(`--- ${pass} 通过 / ${fail} 失败 ---`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
