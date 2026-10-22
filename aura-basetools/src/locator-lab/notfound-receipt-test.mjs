/**
 * notfound-receipt-test —— fs-contract-v2 波5 / C15：判定「找不到」时，回执要带回**原文那一带的
 * 真实文本**与**可执行的下一步**，而不是一句 `not in`。
 *
 * ## 命题（施工单终态，判据不可改）
 *
 * 为什么：把 353 条真实历史失败重放一遍，新契约下仍失败的 147 条（C33 读数 174；入口换成编排层
 * `applyEditToProvider` 之后 27 条归 `already_applied`，见 `probes/already-applied-census.mjs`）里
 * **两次尝试的候选数都是 0**，message 只有一句 `the old text you gave is not in …`；调用方既不知道
 * 差在哪，也不知道往哪儿改，
 * 每条只能靠一次重读自救。同一批数据里另有一类：引文只有**部分相邻行**逐字对上
 * （实测 F0059 是 22/32 行、F0447 是 16/20 行），那是可定位的一层，工具却没给出可收敛的路径。
 *
 * 改动前的原始读数（本机实跑，`node <本仓外的临时探针>`，60 行夹具、引文 20 行其中 16 行逐字对上）：
 *
 *   code=PATCH_NOT_FOUND  candidates=undefined  next=undefined
 *   message(214 chars)=the old text you gave is not in demo.mjs — not as whole lines, and not inside
 *                      any line either. Coordinates are only a hint, so there is nothing to address
 *                      — re-read the file and pass the text exactly as it is there
 *
 *   ——「16/20 行逐字对上」与「真的不存在」这两件**不同的事**，改动前拿到的是**逐字相同**的 214 字符。
 *   实测退出码 1（本文件当时不存在，`MODULE_NOT_FOUND`）。
 *
 * 改动后：同上夹具 ⇒ `code` 仍是 `PATCH_NOT_FOUND`、`candidates` 仍是 `undefined`，
 * 但 message 里带上最近区间（`lines 21-40 of 61`）、逐行原文（`=` / `!` 标出哪几行对得上）、
 * 首次差异的两侧引文，以及一个可以直接拿去用的地址（`next`）。
 *
 * ## 段（判据）
 *
 *   A 找不到的回执含**原文那一带的真实文本**——二选一里本套件钉死的是
 *     「message 里含真实行文本」这一支（比"candidates 非空"强：DSH 只读 `error.message`，
 *     挂在字段上的东西模型看不见），并同时要求 `candidates` 仍为 `undefined`（见段E）。
 *   B 部分命中（20 行引文里 16 行逐字对上 / 6 行里 5 行）⇒ 能收敛到候选区间：
 *     不只看回执说了什么，而是**真的拿回执给的地址再发一次**，看它落在哪。
 *   C 真的不存在 ⇒ 仍拒绝 + 磁盘 sha256 不变。
 *   D 最坏情况下回执体量 ≤ 宿主阈值（实测字节数打印出来）。
 *   E 负向不变量：回执带原文**不得**让「找不到」被误判成成功，也不得被记成 `needs_choice`。
 *
 * 跑法：`node src/locator-lab/notfound-receipt-test.mjs`，全绿 exit 0。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { applyEditToProvider, planHunks } from './write-path.mjs'
import { DEFAULT_PRUNE_BUDGET } from './read-core.mjs'
// 段F的钉子要拿两层各一枚读数：API 回执（`locate`）与引擎自己抛的那一份（`locateWith`）。
import { locate } from './locator-api.mjs'
import { indexFile, locateWith } from './anchor-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (label, ok, detail = '') => {
  results.push({ ok, label })
  say(`${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../..')
const TMP = path.join(os.tmpdir(), `notfound-receipt-${Date.now()}`)
fs.mkdirSync(TMP, { recursive: true })

// ════════════════════════════════════════════════════════════════════════════
// 夹具：60 行、每行都不同（行号与内容一一对应，回执里的行号因此可以逐字核对）；
// 另有两条**逐字相同**的行（第 5 / 55 行），用来钉"唯一性闸门不放松"那一侧。
// ════════════════════════════════════════════════════════════════════════════
const pad = (n) => String(n).padStart(3, '0')
const DUP = 'const repeated = { shared: true }'
const FILE_LINES = []
for (let i = 1; i <= 60; i += 1) FILE_LINES.push(`const row${pad(i)} = { id: ${i}, name: 'item-${i}', ok: true }`)
FILE_LINES[4] = DUP
FILE_LINES[54] = DUP
const SRC = `${FILE_LINES.join('\n')}\n`
const at = (n) => FILE_LINES[n - 1] // 1-based
/** 一份**任何一行都不在夹具里**的引文（前缀刻意与夹具的每一行都不同）。 */
const goneRows = (count, tag = 'gone') =>
  Array.from({ length: count }, (_, k) => `const ${tag}${k + 1} = { id: 9${k + 1}, name: '${tag}-${k + 1}', ok: false }`)

/** 跑一次写路径，返回回执或错误（失败的那条也要能打印）。 */
const attempt = (content, hunks, filePath = 'fixture.mjs') => {
  try {
    return { ok: true, out: planHunks(content, hunks, filePath) }
  } catch (error) {
    return { ok: false, error }
  }
}
const codeOf = (r) => (r.ok ? 'OK' : String(r.error?.code))
const msgOf = (r) => (r.ok ? '' : String(r.error?.message ?? ''))

/**
 * 回执里"那一带"的逐行原文必须是**文件里逐字的那一行**。
 * 判据不靠解析格式，靠**内容**：把夹具里每一行拿去 message 里找——
 * 找到几行，就说明回执真的交出了几行原文。
 */
const realLinesIn = (message, lines = FILE_LINES) =>
  lines.map((text, i) => ({ line: i + 1, text })).filter((row) => message.includes(row.text))

/** 从回执里取出"那一带"的行号区间（可执行地址就是从这句话里读出来的）。 */
const bandOf = (message) => {
  const m = /Closest region: lines (\d+)-(\d+) of (\d+)/.exec(message)
  return m === null ? null : { start: Number(m[1]), end: Number(m[2]), file: Number(m[3]) }
}

say('=== 段A：找不到的回执要含**原文那一带的真实文本** ===')
{
  // A：一份 20 行引文，其中 16 行**逐字**就在文件里（第 1-16 行 = 文件第 21-36 行）。
  const old = [...FILE_LINES.slice(20, 36), ...goneRows(4)].join('\n')
  const r = attempt(SRC, [{ old, replace: 'REPLACED' }])
  const message = msgOf(r)

  check('A1 仍拒绝，且码仍是 PATCH_NOT_FOUND（拒绝这件事一个字节没变）', codeOf(r) === 'PATCH_NOT_FOUND', codeOf(r))
  check('A2 判定：回执的 **message 里含真实行文本**（不是只挂在字段上）', realLinesIn(message).length > 0, `命中 ${realLinesIn(message).length} 行`)
  check(
    'A3 真实文本**不止一行**——"哪几行对得上"要看得见',
    realLinesIn(message).length >= 3,
    realLinesIn(message).map((x) => x.line).join(','),
  )
  check(
    'A4 回执报出**那一带的真实行号区间**，且区间落在文件范围内',
    (() => {
      const band = bandOf(message)
      // 文件以 `\n` 结尾 ⇒ splitLinesWithEndings 会多出一条空行，65 行夹具在这里是 61 行。
      return band !== null && band.start >= 1 && band.end <= FILE_LINES.length && band.file === FILE_LINES.length + 1
    })(),
    JSON.stringify(bandOf(message)),
  )
  check(
    'A5 区间起点就是对齐出来的那一带（第 21 行），不是"随便给一行"',
    bandOf(message)?.start === 21,
    JSON.stringify(bandOf(message)),
  )
  check('A6 哪几行对得上：回执写明 16/20 与最长连续段', /16 of your 20 line\(s\)/.test(message) && /longest unbroken run: your lines 1-16 = file lines 21-36/.test(message), message.slice(0, 0) === '' ? '' : '')
  check('A7 从哪一行开始对不上：首次差异两侧的引文都在回执里', /first difference: your line 17 is /.test(message) && message.includes(at(37)), at(37))
  check(
    'A8 回执里的行号与原文**逐字对得上**（回执说 line N 是 X ⇒ 文件第 N 行就是 X）',
    realLinesIn(message).every((row) => at(row.line) === row.text),
  )
  check('A9 结构字段 candidates 仍为 undefined（回执带原文 ≠ 把找不到卖成"有候选"）', r.error?.candidates === undefined, JSON.stringify(r.error?.candidates))
  check(
    'A10 结构化字段 nearest 是**对象不是数组**，且与 message 里的行号一致',
    r.error?.nearest !== undefined && !Array.isArray(r.error.nearest) && r.error.nearest.line === 21,
    JSON.stringify(r.error?.nearest),
  )

  // A11：真的不存在、又没有坐标 ⇒ 仍然要给出"那一带"的真原文，并**明说它不是匹配**。
  const absent = attempt(SRC, [{ old: 'zzz-nowhere-zzz-not-in-this-file', replace: 'X' }])
  const absentMsg = msgOf(absent)
  check('A11 真不存在时也带回真实行文本（贴文件头）', realLinesIn(absentMsg).length > 0, `命中 ${realLinesIn(absentMsg).length} 行`)
  check(
    'A12 且明说"这不是匹配"（不许把一段无关原文当成落点）',
    /it is not a match/.test(absentMsg) && /not one line of your old text is anywhere in this file/.test(absentMsg),
  )

  // A13：给了坐标却没对上 ⇒ 贴**它指的那一带**的真原文（它以为那儿有东西，那儿实际是什么）。
  const hinted = attempt(SRC, [{ old: 'zzz-nowhere-zzz-not-in-this-file', lines: [30, 33], replace: 'X' }])
  const hintedMsg = msgOf(hinted)
  const hintedBand = bandOf(hintedMsg)
  check('A13 有坐标提示 ⇒ 那一带就是坐标指的范围（30-33）', hintedBand?.start === 30 && hintedBand?.end === 33, JSON.stringify(hintedBand))
  check(
    'A14 那一带贴的是**文件第 30-33 行的真原文**（逐字）',
    [30, 31, 32, 33].every((n) => hintedMsg.includes(at(n))),
  )
  check('A15 有坐标时也明说"没有一行对上、这不是匹配"', /this is where your coordinates point — it is not a match/.test(hintedMsg))
}

say('')
say('=== 段B：部分命中 ⇒ 能收敛到候选区间（真的再发一次，不只看回执怎么说） ===')
{
  const quote = [...FILE_LINES.slice(20, 36), ...goneRows(4)] // 20 行 / 16 行逐字对上
  const r = attempt(SRC, [{ old: quote.join('\n'), replace: 'REPLACED' }])
  const message = msgOf(r)
  const next = String(r.error?.next ?? '')

  check('B1 回执给出可执行的下一步（next 字段，DSH 壳会把它放进结果的 next）', next.length > 0, next)
  const fromNext = /pass lines (\d+)-(\d+)/.exec(next)
  check('B2 next 里给的是**行区间地址**，不是一句"请重读"', fromNext !== null, next)
  check('B3 该地址正是 16 行逐字命中那一段（文件第 21-36 行）', fromNext?.[1] === '21' && fromNext?.[2] === '36', `${fromNext?.[1]}-${fromNext?.[2]}`)

  // ── 收敛实测①：从 **message 文本**里读出地址（只读 error.message 的消费方也够用）
  const fromMessage = /file lines (\d+)-(\d+)/.exec(message)
  check(
    'B4 message 文本里也带着同一个地址（框架只读 message 时同样够用）',
    fromMessage?.[1] === '21' && fromMessage?.[2] === '36',
    `${fromMessage?.[1]}-${fromMessage?.[2]}`,
  )

  const regionText = FILE_LINES.slice(20, 36).join('\n')
  const again = attempt(SRC, [{ old: regionText, replace: 'REPLACED' }])
  check('B5 拿回执给的区间原文再发一次 ⇒ 命中（这就是"可收敛"）', again.ok === true, codeOf(again))
  /** 期望的新内容：第 21-36 行换成一行 `REPLACED`，其余行**逐字**不动。 */
  const wantAfterRegion = [...FILE_LINES.slice(0, 20), 'REPLACED', ...FILE_LINES.slice(36)]
  const gotAfterRegion = again.ok ? again.out.content.replace(/\n$/, '').split('\n') : []
  check(
    'B6 落点就是那一带：只换掉第 21-36 行，其余行逐字未动',
    again.ok && gotAfterRegion.length === wantAfterRegion.length && gotAfterRegion.join('\n') === wantAfterRegion.join('\n'),
    again.ok ? `新行数=${gotAfterRegion.length}（期望 ${wantAfterRegion.length}）` : codeOf(again),
  )

  // ── 收敛实测②：5/6 行那一档（引文短、只差最后一行）
  const short = [...FILE_LINES.slice(9, 14), ...goneRows(1, 'stale')] // 6 行 / 5 行逐字对上
  const rs = attempt(SRC, [{ old: short.join('\n'), replace: 'REPLACED' }])
  const bandS = bandOf(msgOf(rs))
  check('B7 6 行引文里 5 行逐字对上 ⇒ 一样给出候选区间（10-15）', codeOf(rs) === 'PATCH_NOT_FOUND' && bandS?.start === 10 && bandS?.end === 15, `${codeOf(rs)} ${JSON.stringify(bandS)}`)
  const nextS = /pass lines (\d+)-(\d+)/.exec(String(rs.error?.next ?? ''))
  check('B8 该档的下一步地址是 10-14（5 行逐字命中那一段）', nextS?.[1] === '10' && nextS?.[2] === '14', `${nextS?.[1]}-${nextS?.[2]}`)
  const againS = attempt(SRC, [{ old: FILE_LINES.slice(9, 14).join('\n'), replace: 'REPLACED' }])
  const gotS = againS.ok ? againS.out.content.replace(/\n$/, '').split('\n') : []
  check(
    'B9 跟着它走 ⇒ 命中，且只换第 10-14 行',
    againS.ok && gotS[9] === 'REPLACED' && gotS[10] === at(15) && gotS.length === FILE_LINES.length - 4,
    `${codeOf(againS)} line10=${gotS[9]} line15=${gotS[10]}`,
  )

  // ── 收敛实测③：引文中间那一行对不上（两侧都在）——回执要说清"从哪一行开始对不上"
  const holed = [at(8), 'const rowXXX = { nope: true }', at(10)].join('\n')
  const rh = attempt(SRC, [{ old: holed, replace: 'REPLACED' }])
  const mh = msgOf(rh)
  check('B10 中间一行对不上 ⇒ 仍拒绝，但两侧那一带都贴出来', codeOf(rh) === 'PATCH_NOT_FOUND' && mh.includes(at(8)) && mh.includes(at(9)) && mh.includes(at(10)))
  check('B11 并点名首次差异的行号与两侧原文', /first difference: your line 2 is /.test(mh) && /file line 9 is /.test(mh), mh.slice(-260))
  /** 连续段那句有两种形态（len>1 说区间，len==1 说孤立那一行），两种都要能读出行号。 */
  const holeRun =
    /longest unbroken run: your lines (\d+)-(\d+) = file lines (\d+)-(\d+)/.exec(mh) ??
    /only your line (\d+) = file line (\d+) stands alone/.exec(mh)
  const holeFromNext = /pass lines (\d+)-(\d+)/.exec(String(rh.error?.next ?? ''))
  const holeFrom = Number(holeFromNext?.[1])
  const holeTo = Number(holeFromNext?.[2])
  check('B12 回执点名了连续命中的那一行（不是只说"有差异"）', holeRun !== null, holeRun?.[0] ?? 'null')
  check(
    'B13 下一步给的是**连续命中**的那一段，且**绕开**对不上的第 9 行',
    holeFromNext !== null && holeFrom >= 8 && holeTo <= 10 && holeFrom <= holeTo && !(holeFrom <= 9 && holeTo >= 9),
    holeFromNext?.[0] ?? 'null',
  )
  const againH = attempt(SRC, [{ old: FILE_LINES.slice(holeFrom - 1, holeTo).join('\n'), replace: 'REPLACED' }])
  check(
    'B14 真的跟着这个地址走 ⇒ 命中，且落点就是回执说的那一行',
    againH.ok === true && againH.out.applied[0]?.line === holeFrom,
    `${codeOf(againH)} line=${againH.out?.applied?.[0]?.line}（回执说 ${holeFrom}）`,
  )
}

say('')
say('=== 段C：真的不存在 ⇒ 仍拒绝 + 磁盘 sha256 不变 ===')
{
  const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const file = path.join(TMP, 'c-really-absent.mjs')
  fs.writeFileSync(file, SRC)
  const before = sha(file)
  let version = 1
  const provider = {
    stat: async (target) => (fs.existsSync(target) ? { version: `v${version}`, type: 'file', size: fs.statSync(target).size } : undefined),
    readText: async (target) => fs.readFileSync(target, 'utf8'),
    readByteRange: async (target, range) => fs.readFileSync(target).subarray(range.offset, range.offset + range.length),
    writeText: async (target, content, expected) => {
      if (expected?.kind === 'replaceIfVersion' && `v${version}` !== expected.version) {
        throw Object.assign(new Error('file changed since it was read'), { code: 'FS_STALE_VERSION' })
      }
      fs.writeFileSync(target, content)
      version += 1
      return { version: `v${version}`, operation: 'update', after: content }
    },
  }
  let thrown = null
  let returned = null
  try {
    returned = await applyEditToProvider(provider, {
      displayPath: file,
      hunks: [{ old: 'zzz-nowhere-zzz-not-in-this-file', replace: 'X' }],
    })
  } catch (error) {
    thrown = error
  }
  const after = sha(file)
  check('C1 走真写路径（applyEditToProvider）⇒ 抛错而不是返回回执', thrown !== null && returned === null, thrown === null ? '返回了回执（假成功）' : String(thrown.code))
  check('C2 码是 PATCH_NOT_FOUND（三态里的 not_found 那一支）', thrown?.code === 'PATCH_NOT_FOUND', String(thrown?.code))
  check('C3 磁盘 sha256 不变', before === after, `${before.slice(0, 12)} → ${after.slice(0, 12)}`)
  check('C4 逐字节相同（sha256 之外再看一次长度）', fs.readFileSync(file, 'utf8') === SRC, `${fs.readFileSync(file).length}B`)

  // C5：贴了原文之后仍然一行都不写——回执变长不是"顺手试探性改一下"的借口
  const beforeBytes = fs.readFileSync(file)
  attempt(SRC, [{ old: [...FILE_LINES.slice(20, 36), ...goneRows(4)].join('\n'), replace: 'REPLACED' }])
  check('C5 部分命中的那一类也一行都不写（planHunks 是纯函数）', beforeBytes.equals(fs.readFileSync(file)))
  fs.rmSync(file, { force: true })
}

say('')
say('=== 段D：最坏情况下回执体量 ≤ 宿主结果阈值 ===')
{
  /**
   * 阈值来自**宿主**，不是本工具拍的：`dsh-compaction-tool-result-pruner` 的
   * `config.thresholdChars`（超过就把中间换成一行 `[... tool result middle pruned ...]`，
   * 只留 headChars / tailChars）。本机部署实测 8192（`~/.dsh/profiles/node_modules/
   * @deepseek-ai/dsh-base/cordis.patch.yml:396-399`，三个 preset 与 `DEFAULTS` 同值）。
   * 这里**现读现用**，读不到才落回引擎缺省（CLI / MCP / 单测）。
   */
  const deployed = [
    path.join(os.homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml'),
    path.join(os.homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml'),
  ]
  let threshold = DEFAULT_PRUNE_BUDGET
  let from = 'read-core.mjs 的 DEFAULT_PRUNE_BUDGET（未部署剪枝器时的缺省）'
  for (const f of deployed) {
    try {
      const m = /thresholdChars:\s*(\d+)/.exec(fs.readFileSync(f, 'utf8'))
      if (m !== null) {
        threshold = Number(m[1])
        from = f
        break
      }
    } catch {
      /* 读不到就试下一个；一个都读不到时用引擎缺省 */
    }
  }
  say(`  宿主阈值 = ${threshold} 字符（来源：${from}）`)
  say(`  引擎缺省 DEFAULT_PRUNE_BUDGET = ${DEFAULT_PRUNE_BUDGET}（同一份契约的兜底值）`)
  check('D0 阈值确实查到了（不是拿本工具自己的数当阈值）', Number.isInteger(threshold) && threshold > 0, `${threshold}`)

  const long = (n, ch = 'x') => ch.repeat(n)
  const wide = Array.from({ length: 300 }, (_, i) => `const wide${pad(i + 1)} = '${long(4000)}'`) // 每行 ~4000 字符
  const wideSrc = `${wide.join('\n')}\n`

  const CASES = [
    ['D1 那一带每行都超长（12 行 × 4000 字符）+ 引文 20 行只对上 12 行', wideSrc, [{ old: [...wide.slice(40, 52), ...goneRows(8, 'wide')].join('\n'), replace: 'X' }], 'diag.mjs'],
    ['D2 单行 200 万字符（一整份文件只有一行）', `${long(2000000)}\n`, [{ old: 'zzz-nowhere', replace: 'X' }], 'mono.mjs'],
    ['D3 病态长的路径（label 两万字符）', SRC, [{ old: 'zzz-nowhere-zzz', replace: 'X' }], `${long(20000, 'p')}.mjs`],
    ['D4 引文比文件长（30 行引文打在 5 行文件上）', `${FILE_LINES.slice(0, 5).join('\n')}\n`, [{ old: goneRows(30, 'over').join('\n'), replace: 'X' }], 'small.mjs'],
    ['D5 引文大部分是空行（只剩一行真文字、也不在文件里）', SRC, [{ old: '\n\n\nzzz-nowhere-zzz\n\n\n', replace: 'X' }], 'blank.mjs'],
    ['D6 空文件', '', [{ old: 'zzz-nowhere', replace: 'X' }], 'empty.mjs'],
    ['D7 引文 400 行、与文件毫无关系', SRC, [{ old: goneRows(400, 'huge').join('\n'), replace: 'X' }], 'far.mjs'],
  ]
  const measured = []
  for (const [label, content, hunks, label2] of CASES) {
    const r = attempt(content, hunks, label2)
    const message = msgOf(r)
    const chars = [...message].length
    const bytes = Buffer.byteLength(message, 'utf8')
    measured.push({ label, code: codeOf(r), chars, bytes })
    say(`  ${label}\n    code=${codeOf(r)}  message=${chars} 字符 / ${bytes} 字节`)
    check(`${label.slice(0, 2)} 仍拒绝（体量收紧不许把拒绝变成放过）`, r.ok === false, codeOf(r))
    check(`${label.slice(0, 2)} 回执 ≤ 宿主阈值 ${threshold}（实测 ${chars} 字符 / ${bytes} 字节）`, chars <= threshold, `超出 ${chars - threshold}`)
  }
  /**
   * D8：重复行极多的文件（生成出来的数据表就是这种）——对齐打分的候选起点会成百上千倍地涨。
   * 这一档钉两件事：回执仍然**成形且不越阀**，且**仍然给出真实原文与可执行地址**。
   * （这一档的耗时不由本工具决定：病态输入上真正费时的是它之前那一层整行对齐，实测
   * `windowStarts` 在 2 万行全同 / 2 千行引文上要 12 秒，而同一夹具上 C15 改动前后
   * 实测 12209ms vs 12722ms —— 本单没有把那次拒绝变慢。）
   */
  const repFile = Array(3000).fill('  sum += item.price;')
  const repSrc = `${repFile.join('\n')}\n`
  const repOld = [...Array(150).fill('  sum += item.price;'), ...Array(50).fill('  sum += item.other;')].join('\n')
  const t0 = performance.now()
  const rep = attempt(repSrc, [{ old: repOld, replace: 'X' }], 'repeated.mjs')
  const repMs = performance.now() - t0
  const repMsg = msgOf(rep)
  const repChars = [...repMsg].length
  say(`  D8 3000 行同文 + 200 行引文（150 行逐字对上）: code=${codeOf(rep)}  ${repChars} 字符 / ${Buffer.byteLength(repMsg)} 字节  用时 ${repMs.toFixed(0)}ms`)
  check('D8 病态重复输入下仍拒绝', codeOf(rep) === 'PATCH_NOT_FOUND', codeOf(rep))
  check(`D8 回执仍不越阀（实测 ${repChars} 字符）`, repChars <= threshold, `超出 ${repChars - threshold}`)
  check('D8 回执仍含真实行文本（重复行也照贴）', repMsg.includes('  sum += item.price;'))
  check('D8 仍给出可执行的下一步（重复行下取的是确定的那一个起点）', /pass lines \d+-\d+/.test(String(rep.error?.next ?? '')))
  measured.push({ label: 'D8 重复行极多', chars: repChars, bytes: Buffer.byteLength(repMsg) })

  const worst = measured.reduce((a, b) => (b.chars > a.chars ? b : a))
  say(`  最坏一条：${worst.label} ⇒ ${worst.chars} 字符 / ${worst.bytes} 字节（阈值 ${threshold}）`)
  check('D9 最坏一条也不越阈值（把上界钉成一个数）', worst.chars <= threshold, `${worst.chars} ≤ ${threshold}`)
  check('D10 无论多长的引文，回执都不越引擎缺省阈值', measured.every((m) => m.chars <= DEFAULT_PRUNE_BUDGET), `max=${worst.chars}`)

  // D10/D11：截断必须**明写**（取多少行、怎么截自己定，但剪了多少不许不说）
  const cut = attempt(SRC, [{ old: [...FILE_LINES.slice(20, 36), ...goneRows(4)].join('\n'), replace: 'X' }])
  const cutMsg = msgOf(cut)
  const shown = /\((\d+) of (\d+) line\(s\) in this region shown/.exec(cutMsg)
  const hidden = /(\d+) more line\(s\) \/ (\d+) char\(s\) cut to stay inside this receipt's budget/.exec(cutMsg)
  check('D11 展示行数写明"几行中的几行"', shown !== null && Number(shown[1]) === 12 && Number(shown[2]) === 20, shown?.[0] ?? 'null')
  check('D12 剪掉的行数与字符数都明写', hidden !== null && Number(hidden[1]) === 8 && Number(hidden[2]) > 0, hidden?.[0] ?? 'null')
  const hugeLine = attempt(`${long(2000000)}\n`, [{ old: 'zzz-nowhere', replace: 'X' }])
  check(
    'D13 单行超长时逐行剪裁也明写剪了多少字符',
    /more chars\)/.test(msgOf(hugeLine)),
    /\((\d+) more chars\)/.exec(msgOf(hugeLine))?.[0] ?? 'null',
  )
}

say('')
say('=== 段E：负向不变量 —— 回执带原文不得让「找不到」被误判成成功 ===')
{
  const r = attempt(SRC, [{ old: [...FILE_LINES.slice(20, 36), ...goneRows(4)].join('\n'), replace: 'REPLACED' }])
  const message = msgOf(r)
  check('E1 抛错 ⇒ 没有返回内容（不存在"半个成功"）', r.ok === false && r.out === undefined)
  check('E2 码不在 needs_choice 那一支（PATCH_NOT_FOUND 不是 PATCH_AMBIGUOUS）', codeOf(r) === 'PATCH_NOT_FOUND', codeOf(r))
  check('E3 candidates 仍为 undefined（回执不许被当成候选清单卖出去）', r.error?.candidates === undefined)
  check('E4 nearest 不是数组（形状上就不可能被读成"多个候选"）', r.error?.nearest !== undefined && !Array.isArray(r.error.nearest))
  /**
   * E5：测量面口径。`failure-replay.mjs` 与 `probes/residual-census.mjs` 的三态归类是
   * `cands > 0 || /AMBIGUOUS|CANDIDATE/i.test(code) || /candidates|appears on|occurrence|not unique|ambiguous/i.test(message)`。
   * 回执里一旦出现这些词，残余的 147 条"找不到"（C33 读数 174；入口换成编排层后 27 条归
   * `already_applied`、不在这一格里）会被**记成 needs_choice**——那是换个名字把找不到说成"有得选"。
   */
  const TRIGGERS = /candidates|appears on|occurrence|not unique|ambiguous/i
  check('E5 message 不含三态归类用的触发词 ⇒ 测量面仍把这条记成 fail（不是 needs_choice）', !TRIGGERS.test(message), TRIGGERS.exec(message)?.[0] ?? '（无）')
  check(
    'E6 同一条判定：整段回执里 candidates/ambiguous 一个都不出现（含新增的原文那一段）',
    !TRIGGERS.test(message) && !/CANDIDATE|AMBIGUOUS/.test(String(r.error?.code ?? '')),
  )

  /**
   * E7/E8：唯一性闸门不放松。`old` 在文件里出现多处时，仍然是 `PATCH_AMBIGUOUS` + 候选清单，
   * 不许被"最近区间"这套新回执吞成 not_found（那会把"挑一个"变成"没有"）。
   */
  const amb = attempt(SRC, [{ old: DUP, replace: 'X' }])
  check('E7 old 多处出现 ⇒ 仍是 PATCH_AMBIGUOUS（不是 not_found）', codeOf(amb) === 'PATCH_AMBIGUOUS', codeOf(amb))
  check(
    'E8 且候选清单照旧给出（两处都在：第 5 / 55 行）',
    Array.isArray(amb.error?.candidates) && amb.error.candidates.length === 2 && amb.error.candidates.map((c) => c.line).join(',') === '5,55',
    JSON.stringify(amb.error?.candidates?.map((c) => c.line)),
  )

  /**
   * E9–E13：正/负向矩阵。回执是**附加信息**，不许改变任何一次判定：
   * 改动前会拒的仍然拒（改后拒，且码相同），改动前会成的仍然成（落点也相同）。
   */
  const REJECT = [
    ['E9 三段里中间一段对不上', [{ old: [at(8), 'const rowXXX = { nope: true }', at(10)].join('\n'), replace: 'X' }]],
    ['E10 单行只差一个字符', [{ old: at(9).replace('ok: true', 'ok: false'), replace: 'X' }]],
    ['E11 整块都不在文件里', [{ old: goneRows(3, 'absent').join('\n'), replace: 'X' }]],
    ['E12 引文与原文只差空白以外的实质内容（20 行里 16 行对上）', [{ old: [...FILE_LINES.slice(20, 36), ...goneRows(4)].join('\n'), replace: 'X' }]],
  ]
  for (const [label, hunks] of REJECT) {
    const rr = attempt(SRC, hunks)
    check(`${label} ⇒ 仍然拒绝（PATCH_NOT_FOUND）`, codeOf(rr) === 'PATCH_NOT_FOUND', codeOf(rr))
  }
  const ACCEPT = [
    ['E13 整行逐字命中', [{ old: at(3), replace: 'X' }], 3],
    ['E14 old + context', [{ old: at(3), context: at(4), replace: 'X' }], 3],
    ['E15 行内片段命中（只换命中跨度）', [{ old: "name: 'item-7'", replace: "name: 'ITEM-7'" }], 7],
    ['E16 只差空白（norm-space 层）', [{ old: `   ${at(12)}   `, replace: 'X' }], 12],
  ]
  for (const [label, hunks, line] of ACCEPT) {
    const ra = attempt(SRC, hunks)
    check(`${label} ⇒ 仍然命中，且落点仍是第 ${line} 行`, ra.ok === true && ra.out.applied[0]?.line === line, `${codeOf(ra)} line=${ra.out?.applied?.[0]?.line}`)
  }
  const fragmented = attempt(SRC, [{ old: "name: 'item-7'", replace: "name: 'ITEM-7'" }])
  check(
    'E17 片段层的落点没被新回执挪动（行内其余字节逐字不动）',
    fragmented.ok && fragmented.out.content.split('\n')[6] === at(7).replace("name: 'item-7'", "name: 'ITEM-7'"),
    fragmented.ok ? fragmented.out.content.split('\n')[6] : codeOf(fragmented),
  )

  /**
   * E18：壳层判决表。回执变长之后，`PATCH_NOT_FOUND` 仍必须落在 `not_found` 那一格——
   * 否则"找不到"会被壳层改判成别的东西（静态核对，同 `expect-single-source-test` 段B 的手法）。
   */
  const shell = fs.readFileSync(path.join(REPO_ROOT, 'src', 'aura-edit', 'index.js'), 'utf8')
  check("E18 壳层判决表仍把 PATCH_NOT_FOUND 收进 'not_found'", /\['PATCH_NOT_FOUND',\s*'not_found'\]/.test(shell))
  check(
    'E19 壳层"候选 ≥2 ⇒ needs_choice"那条闸门仍在，而本回执给的不是候选数组',
    /candidates\.length > 1 \? 'needs_choice'/.test(shell) && r.error?.candidates === undefined,
  )

  /**
   * E20：`expectVerdict` 仍是 `expect` 的唯一判据——本轮的改动**没有**在这里长第二份判定。
   * 判据形态可机械检：写路径里不出现"整段相等"的第二份谓词，也不出现判据那条阈值常量被重新定义。
   */
  const writePathSrc = fs.readFileSync(path.join(HERE, 'write-path.mjs'), 'utf8')
  /**
   * 只看**运行路径**：注释里提到旧谓词不算“又写了一份”（本文件的注释确实会引它作对照）。
   * 剥掉整行注释再扫，与 `expect-single-source-test` 段D 的“运行路径扫描”同一口径。
   */
  const codeOnly = writePathSrc
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('//')
    })
    .join('\n')
  check(
    'E20 运行路径上没有第二份 expect 判据（没有自造的整段相等谓词 / 没有重定义阈值常量）',
    !/normSpace\(actual\)\s*!==\s*normSpace\(/.test(codeOnly) && !/const\s+ASSERT_RELAX_MIN_CHARS\s*=/.test(codeOnly),
  )
  check(
    'E20b expectVerdict 在写路径里只有**一个调用点**（判据一份，结论两处引用）',
    (codeOnly.match(/expectVerdict\(/g) ?? []).length === 1,
    `调用点 ${(codeOnly.match(/expectVerdict\(/g) ?? []).length} 处`,
  )
  const imported = /import\s*\{([^}]*)\}\s*from\s*'\.\/locator-api\.mjs'/.exec(writePathSrc)
  check(
    'E21 expectVerdict 仍从 locator-api 单一来源引入（没有被本文件另写一份）',
    imported !== null && imported[1].includes('expectVerdict'),
    imported?.[1]?.replace(/\s+/g, ' ').trim() ?? 'null',
  )
  /**
   * E22 一处**期望值**随 MT6 改动（只是形状，判据不放松）：
   *
   * MT6 给失败回执加"可修复地址"时，`oldNotFoundError` / `oldAmbiguityError` / `notFoundDetail`
   * / `locateByOld` 各多收一个 `ctx`（这一次编辑的账本键与 BOM——铸句柄要的正是这两个事实），
   * 于是调用点的字面从 `(label, lines, oldRows, hunk)` 变成 `(label, lines, oldRows, hunk, ctx)`。
   * 这条判据要钉的是"**唯一**调用点 + 在 `throw` 位置、不在 `return` 位置"，与第几个实参无关，
   * 所以正则只把实参表改成 `\([^)]*\)`；**同时新增**"恰好一处调用点"这个计数断言——
   * 原先的写法连"出现了两次"都看不出来，现在它看得出来（这一处是收紧，不是放松）。
   */
  check(
    'E22 oldNotFoundError 的唯一调用点在 throw 位置（回执不可能变成一次成功）',
    /throw oldNotFoundError\([^)]*\)/.test(writePathSrc) &&
      !/return oldNotFoundError/.test(writePathSrc) &&
      // 数的是**调用**（`throw …(`），不是那个函数定义行（定义行也含 `oldNotFoundError(`）
      (writePathSrc.match(/throw oldNotFoundError\(/g) ?? []).length === 1,
    `throw 调用点 ${(writePathSrc.match(/throw oldNotFoundError\(/g) ?? []).length} 处`,
  )
}

/**
 * 段F（F0059 的防复发钉子）：**锚点/相似度/对齐**这三条路径的歧义回执必须印出真实行号。
 *
 * 这三条路径抛的都是 `candidates: <number[]>`（`anchor-core` 的 `tied.map((t) => t.start + 1)`），
 * 而回执的归一化当时只认对象——数字被原样放过，`renderCandidates` 做 `` `line ${c.line}` ``
 * 时印成 `line undefined, line undefined, line undefined`：**行号算出来了，模型手里却是空的**
 * （真实语料 F0059：32 行引文对齐到 3 个窗口）。
 *
 * 判据刻意**不硬编码行号**：期望值取自引擎自己抛的那一份（`engineCands`），
 * 再要求回执的 `candidates[*].line` 与 `message` 里被点名的行号**都与它逐项相同**。
 * 于是把归一化那一支短路回原样（数字原样返回）时，三条都会当场变红。
 */
{
  const REPEAT = ['function alpha(x) {', '  const first = x + 1', '  const second = first * 2', '  return second - 3', '}']
  const ALIGN_SRC = [REPEAT, [''], REPEAT, [''], REPEAT, ['']].flat().join('\n')
  // 锚点比真实区域**少一整行**：逐字层与 norm-space 层都够不到，落到 T5 行级对齐（F0059 那条路）。
  const AMB_ANCHOR = REPEAT.filter((_, i) => i !== 2).join('\n')

  let engineCands = null
  try {
    locateWith(indexFile(ALIGN_SRC), AMB_ANCHOR, null)
  } catch (engineError) {
    engineCands = engineError.candidates
  }
  const receipt = locate(ALIGN_SRC, { anchor: AMB_ANCHOR })
  const shown = (receipt.candidates ?? []).map((c) =>
    c !== null && typeof c === 'object' && typeof c.line === 'number' ? c.line : null,
  )
  const mentioned = [...String(receipt.message).matchAll(/line (\d+)/g)].map((m) => Number(m[1]))
  check(
    'E23 锚点对齐歧义：API 回执的候选每项都带数字 line，且与引擎抛出的候选集逐项相同',
    receipt.ok === false &&
      receipt.code === 'PATCH_AMBIGUOUS' &&
      Array.isArray(engineCands) &&
      engineCands.length >= 2 &&
      shown.length === engineCands.length &&
      JSON.stringify(shown) === JSON.stringify(engineCands),
    `receipt=${JSON.stringify(receipt.candidates)} engine=${JSON.stringify(engineCands)}`,
  )
  check(
    'E24 同一条歧义的 message 印出真实行号（不出现 undefined），且行号取自上面那个候选集本身',
    shown.length >= 2 &&
      !/undefined/.test(String(receipt.message)) &&
      JSON.stringify(mentioned) === JSON.stringify(shown),
    JSON.stringify(receipt.message),
  )
  // 模型真正看得见的那一层：aura_edit 读的是 `error.message`（`intentVerdict`），不是候选字段。
  let alignThrown = null
  try {
    planHunks(ALIGN_SRC, [{ anchor: AMB_ANCHOR, replace: 'X' }])
  } catch (hunkError) {
    alignThrown = hunkError
  }
  check(
    'E25 编排层抛出的 message 同样印出行号（一个 undefined 都没有），两层的行号同一份',
    alignThrown !== null &&
      alignThrown.code === 'PATCH_AMBIGUOUS' &&
      !/undefined/.test(String(alignThrown.message)) &&
      mentioned.length >= 2 &&
      mentioned.every((n) => String(alignThrown.message).includes(`line ${n}`)),
    JSON.stringify(alignThrown?.message),
  )
}

fs.rmSync(TMP, { recursive: true, force: true })
const failed = results.filter((x) => !x.ok)
say('')
say(`--- 结果：${results.length - failed.length}/${results.length} 通过 ---`)
for (const f of failed) say(`  FAIL: ${f.label}`)
if (failed.length > 0) process.exitCode = 1
