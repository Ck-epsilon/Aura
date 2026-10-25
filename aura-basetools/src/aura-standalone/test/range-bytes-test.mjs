/**
 * range-bytes-test.mjs —— 字节形态与边界靶场（被测：**已构建**的独立面 `dist/aura-basetools/` 0.4.1）。
 *
 * 为什么单开一个而不是并进 standalone-test：那边把"改第 N 行、其余不变"当成一组字符串检查，
 * 判据落在 `String` 上；而 BOM 个数、行尾、单 `\r`、NUL、UTF-8 多字节这几类恰好都是
 * **解码后看不见**的改写。这里每一条判据都落到 Buffer 比对，并且专门打几处边界：
 *   0 字节文件、单行 100 KB、3000 行（观测缓存 256 KiB 阈值两侧，含精确边界 ±1 字节）、
 *   单 `\r`（老 Mac）、NUL 二进制、非 UTF-8 字节、区域级陈旧闸门。
 *
 * 被测对象是构建产物（CLI + MCP），不是这份源码树：源码树里改一个字都不该影响这里的判定。
 *   CLI：node <dist>/bin/aura.mjs read|edit …（退出码 0 成功 / 2 结构化拒绝 / 1 用法错误）
 *   MCP：node <dist>/bin/aura-mcp.mjs，stdin 一次性喂完 initialize → tools/list → tools/call
 *
 * 两个必须遵守的既有约定（照抄 standalone-test）：
 *   1. 观测缓存指到临时目录（`AURA_CACHE_DIR`），绝不写 `~/.aura`；
 *   2. 每个 fixture 先 `read` 拿令牌、再 `edit` —— 区域新鲜度闸门依赖这次观测。
 *
 * 运行：node src/aura-standalone/test/range-bytes-test.mjs   （末行必须是 `--- N/M 通过 ---`）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const bin = path.join(here, '..', '..', '..', 'dist', 'aura-basetools', 'bin', 'aura.mjs')
const mcpBin = path.join(here, '..', '..', '..', 'dist', 'aura-basetools', 'bin', 'aura-mcp.mjs')

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}
const say = (m) => console.log(`\n=== ${m} ===`)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-range-bytes-'))
const cache = path.join(tmp, 'cache') // 观测缓存也放测试目录，绝不写 ~/.aura
const env = { ...process.env, AURA_CACHE_DIR: cache }
const run = (args) => spawnSync(process.execPath, [bin, ...args], { cwd: tmp, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 })
const json = (res) => {
  const text = String(res.stdout ?? '')
  try {
    return JSON.parse(text.trim().split('\n').pop())
  } catch (error) {
    // 把 stderr / 长度 / 结尾一起带出来：否则失败只剩一句“不是 JSON”，诊断不了
    return {
      ok: false,
      error: `stdout 不是 JSON（${error?.message}；len=${text.length}；tail=${JSON.stringify(text.slice(-120))}）：${JSON.stringify(text)} ${String(res.stderr ?? '').trim().split('\n').slice(0, 3).join(' / ')}`,
    }
  }
}
/** 一次调用：回执 + 退出码 + stderr（退出码是判据的一半，不能丢）。 */
const call = (args) => {
  const res = run(args)
  const body = json(res)
  body.__exit = res.status
  body.__stderr = String(res.stderr ?? '')
  return body
}
const utf8 = (s) => Buffer.from(s, 'utf8')
const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const write = (name, buf) => {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, buf)
  return { path: p, orig: Buffer.from(buf) }
}
const editArgs = (file, hunks, extra = []) => ['basetools', 'edit', '--file', file, '--hunks', JSON.stringify(hunks), ...extra]
const editLine = (file, line, replace) => call(editArgs(file, [{ lines: [line, line], replace }]))
const readFull = (file) => call(['basetools', 'read', '--file', file, '--mode', 'full'])

// ── 字节级工具 ─────────────────────────────────────────────────────────────
/**
 * 按字节切行：行尾只认 `\r\n` 与 `\n`（与产品同一把尺子，见 write-path.mjs 顶部注释）。
 * 为什么不用字符串切：这套判据的全部意义就是"解码看不见的字节"。
 */
const splitBytes = (buf) => {
  const parts = []
  const ends = []
  let st = 0
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0a) {
      const crlf = i > st && buf[i - 1] === 0x0d
      parts.push(buf.subarray(st, crlf ? i - 1 : i))
      ends.push(buf.subarray(crlf ? i - 1 : i, i + 1))
      st = i + 1
    }
  }
  parts.push(buf.subarray(st))
  ends.push(Buffer.alloc(0))
  return { parts, ends }
}
/**
 * 我自己按预期拼出的字节：把第 `line` 行的**内容**换成 replacement，
 * 该行的**行尾继承原样**（这就是"只改被寻址的那一段"的完整含义）。
 */
const expectedAfterEdit = (orig, line, replacement) => {
  const { parts, ends } = splitBytes(orig)
  const out = []
  for (let i = 0; i < parts.length; i += 1) {
    if (i === line - 1) {
      out.push(utf8(replacement), Buffer.from(ends[i]))
      continue
    }
    out.push(Buffer.from(parts[i]), Buffer.from(ends[i]))
  }
  return Buffer.concat(out)
}
const firstDiff = (a, b) => {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i
  return a.length === b.length ? -1 : n
}
/** 内容或行尾任一不同的行号（1 起）；行数不同时把多出来的行也算上。 */
const lineDiff = (a, b) => {
  const A = splitBytes(a)
  const B = splitBytes(b)
  const out = []
  for (let i = 0; i < Math.max(A.parts.length, B.parts.length); i += 1) {
    const pa = A.parts[i]
    const pb = B.parts[i]
    if (pa === undefined || pb === undefined || !pa.equals(pb) || !A.ends[i].equals(B.ends[i] ?? Buffer.alloc(0))) out.push(i + 1)
  }
  return out
}
const endingDiff = (a, b) => {
  const A = splitBytes(a)
  const B = splitBytes(b)
  const out = []
  for (let i = 0; i < Math.max(A.ends.length, B.ends.length); i += 1) {
    const x = A.ends[i] ?? Buffer.alloc(0)
    const y = B.ends[i] ?? Buffer.alloc(0)
    if (!x.equals(y)) out.push(i + 1)
  }
  return out
}
/** 前导 BOM 个数（连续计数）。 */
const bomCount = (buf) => {
  let n = 0
  while (buf.length >= (n + 1) * 3 && BOM.every((x, i) => buf[n * 3 + i] === x)) n += 1
  return n
}
/** 行尾普查（与产品 lineEndingCensus 同口径，按字节）。 */
const censusOf = (buf) => {
  const c = { crlf: 0, lf: 0, cr: 0 }
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0d) {
      if (buf[i + 1] === 0x0a) {
        c.crlf += 1
        i += 1
      } else c.cr += 1
    } else if (buf[i] === 0x0a) c.lf += 1
  }
  return c
}
/** `read --mode full` 的渲染：与 read-core 同形（默认解码剥掉第一个 BOM，按 /\r?\n/ 切，每行加 `N: `）。 */
const renderExpect = (buf) =>
  new TextDecoder('utf-8')
    .decode(buf)
    .split(/\r?\n/)
    .map((l, i) => `${i + 1}: ${l}`)
    .join('\n')

/**
 * 写回保真（验收第 8 条）：每次成功编辑后，
 *   a) 磁盘字节逐字节 == 我按预期拼出的字节；
 *   b) CLI `read --mode full` 拿到的内容渲染，逐字节 == 预期的渲染。
 * `render:false` 只用在两种情况下：渲染被内容预算截断（单行 100 KB / 3000 行），
 * 或该夹具的判据本来就是磁盘字节（此时渲染那条给不出信息）。
 */
const writeBack = (label, file, expected, opts = {}) => {
  const disk = fs.readFileSync(file)
  check(disk.equals(expected), `${label}：磁盘逐字节 == 预期`, `首个差异 @${firstDiff(disk, expected)}，实际 ${disk.length} 字节 / 预期 ${expected.length} 字节`)
  if (opts.render === false) return
  const env2 = readFull(file)
  const got = utf8(String(env2.text ?? ''))
  const want = utf8(renderExpect(expected))
  check(env2.ok === true && got.equals(want), `${label}：read --mode full 渲染逐字节 == 预期`, `首个差异 @${firstDiff(got, want)} / ${JSON.stringify(String(env2.text ?? '').slice(0, 80))}`)
}

const mcpCall = (frames) => {
  const res = spawnSync(process.execPath, [mcpBin], {
    input: `${frames.map((x) => JSON.stringify(x)).join('\n')}\n`,
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  })
  const replies = String(res.stdout ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const byId = new Map(replies.map((r) => [r.id, r]))
  const envOf = (id) => {
    try {
      return JSON.parse(byId.get(id)?.result?.content?.[0]?.text ?? '{}')
    } catch {
      return { ok: false, code: 'MCP_REPLY_NOT_JSON' }
    }
  }
  return { res, replies, byId, envOf }
}

check(fs.existsSync(bin) && fs.existsSync(mcpBin), '被测的构建产物存在（dist/aura-basetools/bin）', `${bin}`)
if (!fs.existsSync(bin) || !fs.existsSync(mcpBin)) {
  console.log(`\n--- ${pass}/${pass + fail} 通过 ---`)
  process.exit(1)
}

// ── A BOM 形态 ────────────────────────────────────────────────────────────
// 0/1/2/3 个前导 BOM：改第 2 行后 BOM 的**字节数**不变，且只有第 2 行变。
// BOM 在解码后看不见（第一个被 TextDecoder 吃掉，其余留成 U+FEFF），所以这里只能靠字节判。
say('A BOM 形态：0 / 1 / 2 / 3 个前导 BOM')
{
  const base = 'alpha\nbeta\ngamma\n'
  for (let n = 0; n <= 3; n += 1) {
    const orig = Buffer.concat([...Array(n).fill(BOM), utf8(base)])
    const f = write(`bom${n}.md`, orig)
    const before = readFull(f.path)
    check(before.ok === true && typeof before.version === 'string', `bom${n}：先 read 拿到令牌（${before.version}）`)
    const res = editLine(f.path, 2, 'EDITED')
    check(res.ok === true && res.__exit === 0, `bom${n}：改第 2 行成功（exit=${res.__exit}）`, JSON.stringify(res).slice(0, 160))
    check(res.result?.write_verify?.level === 'bytes', `bom${n}：写回校验 level=bytes（${res.result?.write_verify?.level}）`)
    const disk = fs.readFileSync(f.path)
    check(bomCount(disk) === n, `bom${n}：前导 BOM 字节数不变（${n} → ${bomCount(disk)}）`)
    check(JSON.stringify(lineDiff(orig, disk)) === '[2]', `bom${n}：只有第 2 行变（实际变了第 ${JSON.stringify(lineDiff(orig, disk))} 行）`)
    check(JSON.stringify(endingDiff(orig, disk)) === '[]', `bom${n}：所有行尾逐字节不变（实际变了第 ${JSON.stringify(endingDiff(orig, disk))} 行）`)
    writeBack(`bom${n}`, f.path, expectedAfterEdit(orig, 2, 'EDITED'))
    // 先 read 后 edit 的顺序确实建立了基准：小文件不该带降级标注（这条是"约定 2"的守卫）
    check(res.result?.unverified_region === undefined, `bom${n}：先 read 后 edit ⇒ 回执不带 unverified_region（实测 ${res.result?.unverified_region}）`)
  }
}

// ── B 行尾形态 ────────────────────────────────────────────────────────────
// 全 LF / 全 CRLF / 两种混合 / 末行无换行（LF 与 CRLF 各一）/ 空行穿插：
// 改第 2 行后，**未改动行的行尾逐字节不变**，且行尾普查（crlf/lf/cr）完全一致——
// 后者正是"提供方按多数派归一"这类改写会露馅的地方（C12 踩过的坑）。
say('B 行尾形态：LF / CRLF / 混合两向 / 末行无换行 / 空行穿插')
{
  const shapes = {
    'eol_all_lf.md': utf8('alpha\nbeta\ngamma\n'),
    'eol_all_crlf.md': utf8('alpha\r\nbeta\r\ngamma\r\n'),
    'eol_mixed_crlf_head.md': utf8('alpha\r\nbeta\ngamma\n'),
    'eol_mixed_lf_head.md': utf8('alpha\nbeta\r\ngamma\r\n'),
    'eol_no_trailing_lf.md': utf8('alpha\nbeta\ngamma'),
    'eol_no_trailing_crlf.md': utf8('alpha\r\nbeta\r\ngamma'),
    'eol_blank_lines.md': utf8('alpha\n\nbeta\n\ngamma\n'),
  }
  for (const [name, orig] of Object.entries(shapes)) {
    const f = write(name, orig)
    const before = readFull(f.path)
    check(before.ok === true, `${name}：先 read 拿到令牌`)
    const res = editLine(f.path, 2, 'EDITED')
    check(res.ok === true && res.__exit === 0, `${name}：改第 2 行成功（exit=${res.__exit}）`, JSON.stringify(res).slice(0, 160))
    const disk = fs.readFileSync(f.path)
    const A = splitBytes(orig)
    const Bd = splitBytes(disk)
    // 未改动行：内容与行尾都要逐字节相等（第 2 行本身的内容被换、行尾必须继承）
    const untouched = []
    for (let i = 0; i < A.parts.length; i += 1) {
      if (i === 1) continue
      if (!A.parts[i].equals(Bd.parts[i] ?? Buffer.alloc(0)) || !A.ends[i].equals(Bd.ends[i] ?? Buffer.alloc(0))) untouched.push(i + 1)
    }
    check(untouched.length === 0, `${name}：未改动行的内容与行尾逐字节不变（问题行 ${JSON.stringify(untouched)}）`)
    check((Bd.ends[1] ?? Buffer.alloc(0)).equals(A.ends[1]), `${name}：被改行的行尾继承原样（${JSON.stringify(A.ends[1].toString('latin1'))}）`)
    check(JSON.stringify(endingDiff(orig, disk)) === '[]', `${name}：全文件行尾逐字节不变（实际变了第 ${JSON.stringify(endingDiff(orig, disk))} 行）`)
    const cb = censusOf(orig)
    const ca = censusOf(disk)
    check(ca.crlf === cb.crlf && ca.lf === cb.lf && ca.cr === cb.cr,
      `${name}：行尾普查一致 crlf/lf/cr = ${cb.crlf}/${cb.lf}/${cb.cr} → ${ca.crlf}/${ca.lf}/${ca.cr}`)
    check(JSON.stringify(lineDiff(orig, disk)) === '[2]', `${name}：只有第 2 行变（实际变了第 ${JSON.stringify(lineDiff(orig, disk))} 行）`)
    writeBack(name, f.path, expectedAfterEdit(orig, 2, 'EDITED'))
  }
}

// ── C 单 \r（老 Mac） ─────────────────────────────────────────────────────
// 产品把"行"定义在 `\n` 上（符号表那一层也一样），所以整份 `\r` 分隔的文件只算 1 行：
// 寻址第 2 行 ⇒ 结构化拒绝 + 磁盘不变。这不是"见到 \r 就拒"，而是"行号模型不一致 ⇒ 宁可拒绝"。
say('C 单 \\r（老 Mac 行尾）：结构化拒绝且磁盘不变')
{
  const loneBytes = utf8('alpha\rbeta\rgamma\r')
  const f = write('lone_cr.md', loneBytes)
  const before = readFull(f.path)
  check(before.ok === true && before.totalLines === 1, `单 \\r 文件按 \\n 数行 ⇒ 整份算 1 行（totalLines=${before.totalLines}）`)
  const res = editLine(f.path, 2, 'B')
  check(res.ok === false && res.__exit === 2, `寻址第 2 行 ⇒ 结构化拒绝（exit=${res.__exit}）`, JSON.stringify(res).slice(0, 160))
  check(typeof res.code === 'string' && res.code.length > 0, `回执带 code（${res.code}）`)
  check(res.code === 'LOCATOR_LONE_CR', `code = LOCATOR_LONE_CR（实际 ${res.code}）`)
  check(String(res.error ?? res.message ?? '').includes('lone CR'), '拒绝信息点名单 \\r 行尾这条原因')
  check(fs.readFileSync(f.path).equals(loneBytes), '被拒之后磁盘逐字节不变')
  check(res.__stderr.trim() === '', '拒绝走回执而不是 stderr 兜底', res.__stderr.trim().slice(0, 80))
  const again = editLine(f.path, 2, 'B')
  check(again.ok === false && again.code === 'LOCATOR_LONE_CR', '同一条件下重复一次仍拒绝（行为稳定）')
  // 产品给出的出口：显式整文件写（aura write），而不是再用 lines 地址。
  const whole = json(run(['basetools', 'write', '--file', f.path, '--content', 'alpha\rbeta\rgamma\r']))
  check(whole.ok === true, `aura write 整份定稿是可用出口（${JSON.stringify(whole).slice(0, 100)}）`)
  check(fs.readFileSync(f.path).equals(loneBytes), '整份写后字节仍不变')

  // 拒绝不是"见到 \r 就拒"的推断：只要文件含 lone CR，行号模型就不可信；
  // 这时 old 片段仍按逐字跨度工作。
  const mixedCr = utf8('alpha\r\nbeta\rgamma\n')
  const f2 = write('lone_cr_inline.md', mixedCr)
  readFull(f2.path)
  const rejectInline = editLine(f2.path, 2, 'EDITED')
  check(rejectInline.ok === false && rejectInline.code === 'LOCATOR_LONE_CR',
    '同一文件含 lone CR ⇒ lines 地址拒绝（行号模型不可信）')
  const oldInline = json(run(['basetools', 'edit', '--file', f2.path, '--old', 'beta\rgamma', '--replace', 'BETA\rGAMMA']))
  check(oldInline.ok === true && fs.readFileSync(f2.path).equals(utf8('alpha\r\nBETA\rGAMMA\n')),
    'old 片段仍可安全修改含 lone CR 的文件')
}

// ── D 二进制 ──────────────────────────────────────────────────────────────
// 含 `\x00` 的文件读与改都必须结构化拒绝（FS_NOT_TEXT），磁盘逐字节不变。
// 另外钉住"没有 NUL 但不是合法 UTF-8"这一档：它走解码器自己的码，仍是结构化拒绝 + 磁盘不变。
say('D 二进制：含 \\x00 与非法 UTF-8')
{
  const cases = {
    'binary_mid.dat': Buffer.concat([utf8('alpha\n'), Buffer.from([0x00]), utf8('beta\n')]),
    'binary_head.dat': Buffer.concat([Buffer.from([0x00]), utf8('alpha\nbeta\n')]),
    'binary_only.dat': Buffer.from([0x00]),
  }
  for (const [name, orig] of Object.entries(cases)) {
    const f = write(name, orig)
    const r = readFull(f.path)
    check(r.ok === false && r.__exit === 2, `${name}：读被结构化拒绝（exit=${r.__exit}）`, JSON.stringify(r).slice(0, 160))
    check(r.code === 'FS_NOT_TEXT', `${name}：读的 code = FS_NOT_TEXT（实际 ${r.code}）`)
    const e = editLine(f.path, 1, 'x')
    check(e.ok === false && e.__exit === 2, `${name}：改被结构化拒绝（exit=${e.__exit}）`, JSON.stringify(e).slice(0, 160))
    check(e.code === 'FS_NOT_TEXT', `${name}：改的 code = FS_NOT_TEXT（实际 ${e.code}）`)
    check(fs.readFileSync(f.path).equals(orig), `${name}：拒绝之后磁盘逐字节不变`)
  }
  /**
   * 无 NUL 的“非法 UTF-8”（0xFF 0xFE 在所有 CJK 编码里都非法、在 windows-1252 里合法）：
   * 0.21 起**不再拒绝**，而是按候选编码解码（这里是 windows-1252），写回沿用同一编码。
   * 逐字节保真仍然钉住：只有第 1 行变，中间那两个字节原样保留。
   */
  const bad = utf8('alpha\n')
  const badBytes = Buffer.concat([bad, Buffer.from([0xff, 0xfe]), utf8('beta\n')])
  const f = write('invalid_utf8.dat', badBytes)
  const r = readFull(f.path)
  check(r.ok === true && r.encoding === 'windows-1252', `非 UTF-8：按 windows-1252 解码（encoding=${r.encoding}）`)
  const e = editLine(f.path, 1, 'x')
  check(e.ok === true && e.__exit === 0, `非 UTF-8：改成功（exit=${e.__exit}，code=${e.code}）`, JSON.stringify(e).slice(0, 160))
  const disk = fs.readFileSync(f.path)
  check(disk.subarray(0, 2).equals(utf8('x\n')) && disk.subarray(2).equals(badBytes.subarray(6)), '非 UTF-8：只有第 1 行变，0xFF 0xFE 原样保留')
}

// ── E Unicode ─────────────────────────────────────────────────────────────
// emoji（四字节，代理对与 ZWJ 序列）、CJK、CJK 扩展 B、组合字符、零宽字符、制表符：
// 改第 2 行后，其余行**逐字节**不变（不是"字符串相等"）。
say('E Unicode：emoji / CJK / 组合字符 / 零宽 / 制表符')
{
  const line1 = '第一行 🙂 𠀀'
  const line2 = '要被替换的第二行 🙂'
  const line3 = 'ZWJ 👨‍👩‍👧‍👦 组合 e\u0301 零宽\u200b 制表\t符'
  const line4 = '扩展B 𠀀 与 𝄞 音乐符号'
  const orig = utf8(`${line1}\n${line2}\n${line3}\n${line4}\n`)
  const f = write('unicode.md', orig)
  const before = readFull(f.path)
  check(before.ok === true && before.totalLines === 5, `read 成功且行数按 \\n 数（totalLines=${before.totalLines}）`)
  const res = editLine(f.path, 2, 'REPLACED 🙂')
  check(res.ok === true && res.__exit === 0, `改第 2 行成功（exit=${res.__exit}）`, JSON.stringify(res).slice(0, 160))
  const disk = fs.readFileSync(f.path)
  const A = splitBytes(orig)
  const Bd = splitBytes(disk)
  check(JSON.stringify(lineDiff(orig, disk)) === '[2]', `只有第 2 行变（实际变了第 ${JSON.stringify(lineDiff(orig, disk))} 行）`)
  for (const i of [0, 2, 3]) {
    check(A.parts[i].equals(Bd.parts[i]) && A.ends[i].equals(Bd.ends[i]), `第 ${i + 1} 行逐字节不变（${A.parts[i].length} 字节）`)
  }
  check(disk.includes(utf8('🙂')), '四字节 emoji U+1F642 字节原样保留')
  check(disk.includes(utf8('👨‍👩‍👧‍👦')), 'ZWJ 家族序列字节原样保留')
  check(disk.includes(utf8('e\u0301')), '组合字符（e + U+0301，不是预组合 é）字节原样保留')
  check(disk.includes(utf8('\u200b')), '零宽空格 U+200B 字节原样保留')
  check(disk.includes(Buffer.from([0x09])), '制表符 0x09 原样保留')
  check(disk.includes(utf8('𠀀')) && disk.includes(utf8('𝄞')), '四字节 CJK 扩展 B 与音乐符号字节原样保留')
  writeBack('Unicode 形态', f.path, expectedAfterEdit(orig, 2, 'REPLACED 🙂'))
}

// ── F 极端尺寸 ────────────────────────────────────────────────────────────
// 0 字节；单行 100 KB；3000 行文件在"观测缓存 256 KiB"阈值两侧；阈值精确 ±1 字节。
// 0.10.5 起 `source.length > 262144` 仍记**令牌**、只是不存全文：读过之后编辑不降级；
// 若读后文件又被第三方改过，当前令牌不在账本里 ⇒ 回执带 `unverified_region`
// （G 段覆盖那条降级路径）。ASCII 无 BOM 时 source.length == 字节数。
say('F 极端尺寸：0 字节 / 单行 100 KB / 3000 行 / 256 KiB 阈值两侧')
{
  // 0 字节：读不能抛未捕获异常。实测空文件在工具里就是"1 个空行"，所以"读空文件"本身
  // 不产生 code（exit 0）；明确 code 出现在越界寻址上——两条都钉住。
  const zero = write('zero.md', Buffer.alloc(0))
  const zread = readFull(zero.path)
  check(zread.ok === true && zread.__exit === 0, `0 字节：read 正常回包、exit=${zread.__exit}`, JSON.stringify(zread).slice(0, 160))
  check(!/\n\s+at /.test(zread.__stderr), '0 字节：stderr 里没有未捕获异常的栈')
  check(zread.totalLines === 1, `0 字节：整份算 1 个空行（totalLines=${zread.totalLines}）⇒ 读本身无 code，符合实际语义`)
  const zoor = call(['basetools', 'read', '--file', zero.path, '--lines', '5,6'])
  check(zoor.ok === false && zoor.__exit === 2 && typeof zoor.code === 'string', `0 字节越界读给明确 code=${zoor.code}（exit=${zoor.__exit}）`)
  const zedit = editLine(zero.path, 2, 'x')
  check(zedit.ok === false && zedit.__exit === 2 && typeof zedit.code === 'string', `0 字节越界改给明确 code=${zedit.code}（exit=${zedit.__exit}）`)
  check(fs.statSync(zero.path).size === 0, '0 字节：两次拒绝之后磁盘仍是 0 字节')
  // 那份"1 个空行"的视图是可寻址的（lines=[1,1]），写回逐字节 == 替换文本
  const zero2 = write('zero2.md', Buffer.alloc(0))
  const z1 = editLine(zero2.path, 1, 'x')
  check(z1.ok === true && fs.readFileSync(zero2.path).equals(utf8('x')), `0 字节：lines=[1,1] 可寻址，写回逐字节 == x（${z1.code ?? 'ok'}）`)

  // 单行 100 KB：读要如实截断（不许把 100 KB 塞进回执），改第 2 行不受长行影响，
  // 长行本身 102400 字节逐字节不变。
  const longLine = 'a'.repeat(102400)
  const hugeSrc = utf8(`${longLine}\nsecond\n`)
  const huge = write('huge_line.md', hugeSrc)
  const hread = call(['basetools', 'read', '--file', huge.path, '--lines', '1,1'])
  check(hread.ok === true && hread.__exit === 0 && typeof hread.version === 'string', `100 KB 单行：read 成功且给令牌（exit=${hread.__exit}）`)
  check(hread.truncated !== undefined && Number(hread.truncated.omittedChars) > 0, `100 KB 单行：截断如实标注（omittedChars=${hread.truncated?.omittedChars}）`)
  // 顺带实测（未断言）：CLI 帮助里写着的 `--max-chars N` 在 0.4.1 上是**空转**——
  // read-core.mjs 的 readWith 从没读过 request.maxChars，ops.mjs:65 传了也没人接；
  // 实测 --max-chars 100 / 8000 / 400000 三档都得到 contentBudget=7680（预算只由 PRUNE_BUDGET 收敛定死）。
  // 不写断言：那是缺陷不是契约，钉住它反而会给修复添麻烦。
  check(utf8(String(hread.text ?? '')).length <= 7680 + 64, `100 KB 单行：渲染不超内容预算（实际 ${utf8(String(hread.text ?? '')).length} 字节）`)
  const hline2 = call(['basetools', 'read', '--file', huge.path, '--lines', '2,2'])
  check(hline2.ok === true && String(hline2.text ?? '').includes('second'), '100 KB 单行：第 2 行照样读得到')
  const hedit = editLine(huge.path, 2, 'SECOND')
  check(hedit.ok === true && hedit.__exit === 0, `100 KB 单行：改第 2 行成功（exit=${hedit.__exit}）`, JSON.stringify(hedit).slice(0, 160))
  const hdisk = fs.readFileSync(huge.path)
  check(hdisk.equals(expectedAfterEdit(hugeSrc, 2, 'SECOND')), `100 KB 单行：磁盘逐字节 == 预期（${hdisk.length} 字节）`)
  check(hdisk.subarray(0, 102400).equals(utf8(longLine)), '100 KB 单行：第 1 行 102400 字节逐字节不变')
  check(hdisk[102400] === 0x0a, '100 KB 单行：第 1 行行尾仍是 LF')

  // 3000 行：阈值两侧各一个（45 KB < 256 KiB；303 KB > 256 KiB）。
  // 0.10.5 起 >256 KiB 也记**令牌**（只是不存全文）⇒ 读过之后编辑不再降级标注。
  const mk3000 = (pad) => `${Array.from({ length: 3000 }, (_, i) => `line ${String(i + 1).padStart(4, '0')} ${'y'.repeat(pad)}`).join('\n')}\n`
  const smallSrc = utf8(mk3000(4))
  const bigSrc = utf8(mk3000(90))
  check(smallSrc.length === 45000 && bigSrc.length === 303000, `3000 行夹具尺寸：${smallSrc.length} 字节（<256 KiB）与 ${bigSrc.length} 字节（>256 KiB）`)
  for (const [label, src, file] of [
    ['3000 行 45 KB（<256 KiB）', smallSrc, 'lines3000_small.md'],
    ['3000 行 303 KB（>256 KiB）', bigSrc, 'lines3000_big.md'],
  ]) {
    const f = write(file, src)
    const before = readFull(f.path)
    check(before.ok === true && typeof before.version === 'string', `${label}：read 给令牌（${before.version}）`)
    check(before.omitted !== undefined, `${label}：read 如实标注被预算裁掉的部分（${String(before.omitted).slice(0, 50)}）`)
    const res = editLine(f.path, 2, 'EDITED')
    check(res.ok === true && res.__exit === 0, `${label}：改第 2 行成功（exit=${res.__exit}）`, JSON.stringify(res).slice(0, 160))
    check(res.result?.unverified_region === undefined,
      `${label}：读过这一版 ⇒ 不标 unverified_region（实测 ${res.result?.unverified_region}）`)
    const disk = fs.readFileSync(f.path)
    check(disk.equals(expectedAfterEdit(src, 2, 'EDITED')), `${label}：磁盘逐字节 == 预期（${disk.length} 字节）`)
    check(JSON.stringify(lineDiff(src, disk)) === '[2]', `${label}：只有第 2 行变，其余 2999 行内容与行尾逐字节不变`)
  }

  // 阈值精确到字节：两侧都记令牌；>256 KiB 只是**不存全文**（区域闸退回 basis:none，
  // 但“这一版读过没有”仍可回答）。外部改动的降级标注由 G 段单独覆盖。
  for (const n of [262144, 262145]) {
    // 第一行保持小，总字节数精确落在阈值上；否则 edit 回执会把 262 KB 的
    // actual 原样带出来——在 macOS 的 spawnSync 上会撑成无法解析的超长行。
    const src = utf8(`a\n${'b'.repeat(n - 3)}\n`)
    const expected = utf8(`EDITED\n${'b'.repeat(n - 3)}\n`)
    const f = write(`threshold_${n}.md`, src)
    const before = call(['basetools', 'read', '--file', f.path, '--mode', 'lines', '--lines', '1,1'])
    check(before.ok === true && typeof before.version === 'string', `阈值 ${n} 字节：read 给令牌`)
    const res = editLine(f.path, 1, 'EDITED')
    check(
      res.ok === true && res.__exit === 0,
      `阈值 ${n} 字节：改第 1 行成功（exit=${res.__exit}）`,
      JSON.stringify({ ok: res.ok, code: res.code, error: res.error, transaction: res.transaction, rollback: res.rollback, stderr: String(res.__stderr ?? '').slice(0, 160) }),
    )
    check(res.result?.unverified_region === undefined,
      `阈值 ${n} 字节：读过这一版 ⇒ 不标 unverified_region（实测 ${res.result?.unverified_region}）`)
    check(fs.readFileSync(f.path).equals(expected), `阈值 ${n} 字节：写回逐字节 == 预期（${expected.length} 字节）`)
  }
}

// ── G 并发与陈旧 ──────────────────────────────────────────────────────────
// 先 read（建立"上次观测"）→ 第三方改文件 → edit：
//   · 改的是**被寻址区域** ⇒ 必须 PATCH_STALE_REGION，且磁盘保持第三方内容；
//   · 改的是**无关区域** ⇒ 实测被允许（闸门是区域级，不是整文件级），两个独立文件上重复一致。
say('G 并发与陈旧：区域级新鲜度闸门')
{
  const orig = utf8('one\ntwo\nthree\nfour\nfive\n')
  const third = utf8('one\nTWO-BY-SOMEONE-ELSE\nthree\nfour\nfive\n')
  const f = write('stale_region.md', orig)
  const before = readFull(f.path)
  check(before.ok === true && typeof before.version === 'string', '先 read 建立"上次观测"')
  fs.writeFileSync(f.path, third) // 第三方改第 2 行
  const res = editLine(f.path, 2, 'mine')
  check(res.ok === false && res.__exit === 2, `被寻址区域被第三方改过 ⇒ 拒绝（exit=${res.__exit}）`, JSON.stringify(res).slice(0, 200))
  check(res.code === 'PATCH_STALE_REGION', `code = PATCH_STALE_REGION（实际 ${res.code}）`)
  check(fs.readFileSync(f.path).equals(third), '磁盘保持第三方内容（逐字节）')
  // 拒绝信息里必须有"先重读这块区域"这条可执行的话（否则模型会卡在同一个拒绝上反复重试）。
  check(String(res.error ?? '').includes('re-read'), '拒绝信息要求先重读被寻址区域', String(res.error ?? '').slice(0, 120))
  // 结构化的 minimal_next 实测**到不了** CLI/MCP 回执：write-path.mjs:38 的 PatchError 是把附加字段
  // Object.assign 到错误对象自身的，而 lib/ops.mjs:95 只转发 `error.detail`（全仓没有任何地方设过它）。
  // 这里不断言"必须缺失"（那是缺陷不是契约），只钉住：要么缺失、要么必须是 [2,2]。
  const hint = res.detail?.minimal_next ?? res.minimal_next ?? null
  check(hint === null || JSON.stringify(hint.lines) === '[2,2]',
    `结构化重读坐标：实测 ${hint === null ? '缺失（缺陷，见注释）' : JSON.stringify(hint.lines)}`)
  const again = editLine(f.path, 2, 'mine')
  check(again.ok === false && again.code === 'PATCH_STALE_REGION' && fs.readFileSync(f.path).equals(third), '同一条件下重复一次仍拒绝、磁盘仍不变（行为稳定）')

  // 无关区域被第三人改过：实测**允许**。区域级闸门只比被寻址区域（staleConflicts 逐 hunk 比
  // regionTextIn），因此第 5 行的第三方改动不拦第 2 行——两个独立文件上重跑，结果一致。
  const allowed = []
  for (const name of ['stale_unrelated_1.md', 'stale_unrelated_2.md']) {
    const fu = write(name, orig)
    readFull(fu.path)
    fs.writeFileSync(fu.path, third) // 第三方只动第 2 行
    const r = editLine(fu.path, 5, 'FIVE')
    allowed.push(r.ok === true && r.__exit === 0)
    check(r.ok === true && r.__exit === 0, `${name}：无关区域被改 ⇒ 编辑被允许（实测 ok=${r.ok}，code=${r.code ?? '—'}）`, JSON.stringify(r).slice(0, 160))
    check(fs.readFileSync(fu.path).equals(expectedAfterEdit(third, 5, 'FIVE')), `${name}：第三方那行逐字节保留，只有第 5 行是我的`)
  }
  check(allowed.length === 2 && allowed[0] === allowed[1], `无关区域的行为在两个独立文件上一致（${allowed.join(' / ')}）`)

  // >256 KiB 的文件**不存全文**（只记令牌）⇒ 第三方改动后当前令牌不在账本里，
  // 区域闸没有基准可用：编辑照做，回执用 unverified_region 如实标注。
  // 这是 observation-store.mjs 写明的既定语义，不是漏判；代价是：超大文件上
  // “被寻址区域被第三方改过”这条拦不住。
  const bigSrc = utf8(`${Array.from({ length: 3000 }, (_, i) => `line ${String(i + 1).padStart(4, '0')} ${'y'.repeat(90)}`).join('\n')}\n`)
  const bf = write('stale_big.md', bigSrc)
  const bread = readFull(bf.path)
  check(bread.ok === true, '>256 KiB：先 read（记令牌，但不存全文）')
  const bThird = expectedAfterEdit(bigSrc, 5, 'THIRD-PARTY')
  fs.writeFileSync(bf.path, bThird)
  const bres = editLine(bf.path, 5, 'MINE')
  check(bres.ok === true && bres.result?.unverified_region === true, `>256 KiB：闸门无基准 ⇒ 放行且回执标注 unverified_region（实测 ${bres.result?.unverified_region}）`)
  check(fs.readFileSync(bf.path).equals(expectedAfterEdit(bThird, 5, 'MINE')), '>256 KiB：第三方那行被我的改动覆盖（这正是降级的代价）')
}

// ── H 写回保真与令牌连续性 ────────────────────────────────────────────────
// BOM + CRLF + Unicode 合成一件，连做两次编辑：每次都比磁盘字节与 CLI 渲染；
// 写回之后观测被刷新，因此"编辑后立刻 changed"必须是"无变化"。
say('H 写回保真与令牌连续性（BOM + CRLF + Unicode 合成）')
{
  const orig = Buffer.concat([BOM, utf8('第一行 🙂\r\n第二行\r\n第三行\r\n')])
  const f = write('roundtrip.md', orig)
  const r1 = readFull(f.path)
  check(r1.ok === true && typeof r1.version === 'string', '合成形态：先 read 拿令牌')
  const e1 = editLine(f.path, 2, 'SECOND 🙂')
  check(e1.ok === true && e1.result?.unverified_region === undefined, '合成形态：第 1 次编辑带基准')
  const after1 = expectedAfterEdit(orig, 2, 'SECOND 🙂')
  writeBack('合成形态 第 1 次编辑', f.path, after1)
  const r2 = readFull(f.path)
  check(r2.ok === true, '合成形态：编辑后重新 read')
  const e2 = editLine(f.path, 3, 'THIRD')
  check(e2.ok === true && e2.result?.unverified_region === undefined, '合成形态：第 2 次编辑仍带基准（上一次写回刷新了观测）')
  const after2 = expectedAfterEdit(after1, 3, 'THIRD')
  writeBack('合成形态 第 2 次编辑', f.path, after2)
  check(bomCount(fs.readFileSync(f.path)) === 1, `两次编辑后前导 BOM 仍是 1 个（实际 ${bomCount(fs.readFileSync(f.path))}）`)
  check(JSON.stringify(endingDiff(orig, fs.readFileSync(f.path))) === '[]', '两次编辑后所有行尾仍逐字节不变')
  const tok = readFull(f.path)
  const changed = call(['basetools', 'read', '--file', f.path, '--mode', 'changed', '--since', String(tok.version)])
  check(changed.ok === true && String(changed.note ?? '').includes('no change'), `写回刷新了观测：编辑后立刻 changed = 无变化（${changed.note ?? changed.code}）`)
}

// ── I MCP ─────────────────────────────────────────────────────────────────
// 同一批字节边界走 JSON-RPC 路径：写回校验等级、BOM/CRLF 保真、单 \r 与二进制的拒绝码、
// 大文件的降级标注——两个入口必须同形。
say('I MCP：字节边界走 JSON-RPC 路径')
{
  const twoBomCrlf = Buffer.concat([BOM, BOM, utf8('alpha\r\nbeta\r\ngamma\r\n')])
  const f1 = write('mcp_bytes.md', twoBomCrlf)
  const loneBytes = utf8('alpha\rbeta\rgamma\r')
  const f2 = write('mcp_lone_cr.md', loneBytes)
  const binBytes = Buffer.concat([utf8('alpha\n'), Buffer.from([0x00]), utf8('beta\n')])
  const f3 = write('mcp_binary.dat', binBytes)
  const bigSrc = utf8(`${Array.from({ length: 3000 }, (_, i) => `line ${String(i + 1).padStart(4, '0')} ${'y'.repeat(90)}`).join('\n')}\n`)
  const f4 = write('mcp_big.md', bigSrc)

  const readCall = (id, file) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'aura_basetools_read', arguments: { file_path: file, mode: 'full' } } })
  const editCall = (id, file, hunks) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'aura_basetools_edit', arguments: { file_path: file, hunks } } })
  const m = mcpCall([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    readCall(2, f1.path),
    editCall(3, f1.path, [{ lines: [2, 2], replace: 'EDITED' }]),
    editCall(4, f2.path, [{ lines: [2, 2], replace: 'X' }]),
    readCall(5, f3.path),
    readCall(6, f4.path),
    editCall(7, f4.path, [{ lines: [2, 2], replace: 'EDITED' }]),
  ])
  check(m.replies.length === 7, `7 条请求全部有回包（收到 ${m.replies.length}）`)
  check(m.replies.every((r) => r.jsonrpc === '2.0'), '每条回包都是 JSON-RPC 2.0')
  check(m.envOf(2).ok === true && typeof m.envOf(2).version === 'string', 'MCP 读：给令牌')
  check(m.envOf(3).ok === true && m.envOf(3).result?.write_verify?.level === 'bytes', `MCP 改：写回校验 level=bytes（${m.envOf(3).result?.write_verify?.level}）`)
  check(fs.readFileSync(f1.path).equals(Buffer.concat([BOM, BOM, utf8('alpha\r\nEDITED\r\ngamma\r\n')])), 'MCP 改：2 个 BOM 与 CRLF 逐字节保真')
  check(bomCount(fs.readFileSync(f1.path)) === 2, `MCP 改：前导 BOM 个数仍是 2（实际 ${bomCount(fs.readFileSync(f1.path))}）`)
  check(m.envOf(4).ok === false && m.envOf(4).code === 'LOCATOR_LONE_CR' && fs.readFileSync(f2.path).equals(loneBytes),
    `MCP 改单 \\r：被拒且磁盘不变（code=${m.envOf(4).code}）`)
  check(m.envOf(5).ok === false && m.envOf(5).code === 'FS_NOT_TEXT' && fs.readFileSync(f3.path).equals(binBytes),
    `MCP 读二进制：被拒且磁盘不变（code=${m.envOf(5).code}）`)
  check(m.envOf(7).ok === true && m.envOf(7).result?.unverified_region === undefined, `MCP 大文件改：读过这一版 ⇒ 不标 unverified_region（${m.envOf(7).result?.unverified_region}）`)
  check(fs.readFileSync(f4.path).equals(expectedAfterEdit(bigSrc, 2, 'EDITED')), 'MCP 大文件改：磁盘逐字节 == 预期')
  check(m.res.status === 0 && String(m.res.stderr ?? '').trim() === '', 'MCP 服务退出码 0 且没靠 stderr 兜底', String(m.res.stderr ?? '').trim().slice(0, 80))
}

console.log(`\n--- ${pass}/${pass + fail} 通过 ---`)
try {
  fs.rmSync(tmp, { recursive: true, force: true })
} catch {
  // 临时目录删不掉不影响判定（下一次 mkdtemp 会另起一个）
}
process.exit(fail === 0 ? 0 : 1)
