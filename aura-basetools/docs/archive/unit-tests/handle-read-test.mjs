/**
 * handle-read-test —— 读侧发句柄（HD1）的判据。
 *
 * 这一套钉的是**句柄本身的性质**，不是"字段在不在"：
 *   · 确定性：同一份未变区间重读 ⇒ 同一个句柄（否则它当不了内容凭据，也做不了对账）
 *   · 敏感性：改一个字节 ⇒ 句柄必须变（否则"区间已变"这条判据整个是假的）
 *   · 可还原：句柄能被 `parseHandle` 还原出正确坐标与指纹
 *   · 落点：句柄出现在 `windowEnvelope` 那一层，**不进正文 `text`**
 *   · 上限：`search` 命中数超上限时只报数（`handlesOmitted`），且调用方无法用 `limit` 顶穿
 *   · 形状：句柄长度 21 字符（行号 4 位以内时）
 *
 * 判据与退出码挂钩：任何一条为假 ⇒ exit 1。本项目禁止"印出缺口却 exit 0"。
 *
 * 靶子用**临时文件**而不是仓内夹具：本套件要真的改一个字节再读一次，
 * 在仓内文件上做这件事会把并行单元的工作区弄脏。临时目录落 `os.tmpdir()`，退出前删掉。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HANDLE_CHARS,
  HANDLE_MAX_PER_RECEIPT,
  HANDLE_RE,
  handleCharsFor,
  identityTag,
  mintHandle,
  parseHandle,
  regionFingerprint,
} from './handle-core.mjs'
import { contentToken, latestObservation, readWith } from './read-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

/** 两份**内容不同**的区间：只要指纹是常量，它们就会铸出同一个柄——敏感性判据据此变红。 */
const A = ['function alpha(x) {', '  return x + 1', '}', ''].join('\n')
const B = ['function alpha(x) {', '  return x + 2', '}', ''].join('\n')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hd1-handle-'))
const FILE = path.join(TMP, 'fixture.mjs')
const FILE2 = path.join(TMP, 'other.mjs')
const write = (p, text) => fs.writeFileSync(p, text, 'utf8')
write(FILE, A)
write(FILE2, A)

/** 便于读的短柄：句柄是 21 字符，直接印会淹掉判据行。 */
const brief = (h) => (typeof h === 'string' ? `${h.slice(0, 13)}…${h.slice(-6)}` : String(h))

say(`靶子 ${path.basename(FILE)}：${A.split('\n').length} 行（临时目录，退出前删除）`)

try {
  say('')
  say('=== 1. 确定性：同一份未变区间重读 ⇒ 同一个句柄 ===')
  const l1 = readWith(A, { filePath: FILE, mode: 'lines', lines: [1, 3] })
  const l2 = readWith(A, { filePath: FILE, mode: 'lines', lines: [1, 3] })
  check(typeof l1.handle === 'string', `lines 发了一条句柄：${brief(l1.handle)}`)
  check(l1.handle === l2.handle, '同一区间两次读 → 句柄逐字相同', `${l1.handle} === ${l2.handle}`)
  const l3 = readWith(A, { filePath: FILE, mode: 'lines', lines: [1, 2] })
  check(l3.handle !== l1.handle, '区间不同 → 句柄不同（1-2 vs 1-3）', `${brief(l3.handle)} ≠ ${brief(l1.handle)}`)
  /**
   * 确定性必须一路铺到**模型看得见的那一层**：同一区间两次读，`text` 里的柄要逐字相同。
   *
   * 结构化字段相同但 text 不同（或反过来）都是真故障——模型手里那个地址得能与
   * 宿主手里的字段对上。这里整段 `text` 直接对拍，比只比句柄更严。
   */
  const textHandleOf = (env) => env.text.match(/<h[0-9a-f]{4}[0-9a-f]{8}:\d+-\d+>/g) ?? []
  const t1 = textHandleOf(l1)
  const t2 = textHandleOf(l2)
  check(t1.length === 1 && t1[0] === `<${l1.handle}>`, 'text 里的柄与结构化 handle 一致', `${t1[0]} vs <${l1.handle}>`)
  check(l1.text === l2.text && t1.join() === t2.join(), '同一区间两次读：**text 逐字节相同**（含柄）', brief(t1[0]))
  const sA = readWith(A, { filePath: FILE, mode: 'search', search: 'return' })
  const sB = readWith(A, { filePath: FILE, mode: 'search', search: 'return' })
  check(sA.text === sB.text, '同一命中的 search 两次读：text 逐字节相同（每条柄都在原行上）')

  say('')
  say('=== 2. 敏感性：改一个字节 ⇒ 句柄必须变 ===')
  const beforeHandle = l1.handle
  write(FILE, B)
  const l4 = readWith(B, { filePath: FILE, mode: 'lines', lines: [1, 3] })
  check(
    l4.handle !== beforeHandle,
    '第 2 行 1 → 2（一个字节）⇒ 句柄变',
    `${brief(beforeHandle)} → ${brief(l4.handle)}`,
  )
  check(
    parseHandle(l4.handle).fingerprint !== parseHandle(beforeHandle).fingerprint,
    '变的必须是**摘要段**（身份标签与坐标可以不变）',
    `${parseHandle(beforeHandle).fingerprint} → ${parseHandle(l4.handle).fingerprint}`,
  )
  write(FILE, A)
  const l5 = readWith(A, { filePath: FILE, mode: 'lines', lines: [1, 3] })
  check(l5.handle === beforeHandle, '按字节还原 ⇒ 句柄也还原（摘要确实是内容的函数）', brief(l5.handle))

  say('')
  say('=== 3. 可还原：parseHandle 给出正确坐标与指纹 ===')
  const p = parseHandle(l1.handle)
  check(p.ok === true, '句柄可解析', JSON.stringify(p))
  check(p.startLine === 1 && p.endLine === 3, '坐标还原正确（1-3）', `${p.startLine}-${p.endLine}`)
  check(
    p.fingerprint === regionFingerprint(A.split('\n').slice(0, 3).join('\n')),
    '摘要还原正确（= 同口径现算的那个指纹）',
    `${p.fingerprint}`,
  )
  check(p.idTag === identityTag(l1.handle.slice(1, 5)) || /^[0-9a-f]{4}$/.test(p.idTag), `身份标签是 4 位十六进制：${p.idTag}`)
  check(parseHandle('not-a-handle').ok === false, '不认识的串如实返回 {ok:false}（不抛错）')
  check(parseHandle('h2eb5cbfd4525:1-3').endLine === 3 && parseHandle('h2eb5cbfd4525:1-3').startLine === 1, '既知形状往返一致')

  say('')
  say('=== 4. 两个落点：结构化字段 + **模型可见的 text** ===')
  const keys = Object.keys(l1)
  check(keys.includes('handle'), `lines 回执顶层有 handle（与 shown/relocatable 同级）：${keys.join(',')}`)
  check(
    keys.includes('shown') && keys.includes('text') && keys.indexOf('handle') > keys.indexOf('shown'),
    'handle 落在 shown 之后（窗口层字段序）',
  )
  /**
   * **模型可见性**（本套件最重要的一条）。
   *
   * 壳层只把 `value.text` 交给模型（`aura-read/index.js`：`render: (_args, value) => [{type:'text', text: value.text}]`），
   * 框架再把 `result.content` 装进 tool 消息——结构化字段一个都到不了模型。
   * 所以"有 handle 字段"根本不等于"模型看得见句柄"。下面这条从 **text** 里把句柄
   * **抓出来**（用同一个 `HANDLE_RE`），再 `parseHandle` 还原坐标，与结构化字段逐字对齐。
   */
  const textHandles = [...l1.text.matchAll(new RegExp(HANDLE_RE.source.slice(1, -1), 'g'))].map((m) => m[0])
  check(textHandles.length === 1, `从 text 里抓出恰好一条句柄：${JSON.stringify(textHandles)}`)
  check(textHandles[0] === l1.handle, 'text 里的句柄与结构化 handle **逐字相同**', `${textHandles[0]} vs ${l1.handle}`)
  const tp = parseHandle(textHandles[0])
  check(
    tp.ok === true && tp.startLine === 1 && tp.endLine === 3,
    'text 里那条句柄能还原出正确坐标（1-3）',
    JSON.stringify(tp),
  )
  check(l1.text.split('\n')[0].endsWith(textHandles[0] + '>'), '句柄落在**头行**行尾（契约 §4：附在该区间的头行上）')
  check(
    l1.text.split('\n').slice(1).every((row) => !row.includes('<h')),
    '只有头行带句柄，其余行纯净',
  )
  // 行首前缀不许动：既有解析器（^\d+: ）靠它取行号
  const nums = [...l1.text.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]))
  check(nums.join(',') === '1,2,3', `行首 N: 前缀未被动过（行号仍取得全）：${nums.join(',')}`)
  const m = readWith(A, { filePath: FILE, mode: 'map' })
  const d = readWith(A, { filePath: FILE, mode: 'digest' })
  const w = readWith(A, { filePath: FILE, mode: 'around', around: 'alpha' })
  const f = readWith(A, { filePath: FILE, mode: 'full' })
  check(!('handle' in m), 'map 不发句柄')
  check(!('handle' in d), 'digest 不发句柄')
  check(!('handle' in w), 'around 不发句柄（契约 §4 的表里没有它）')
  check(!('handle' in f), 'full 不发句柄（本单裁决：全文读不是编辑地址；见 read-core 里 handleContext 长注释）')

  say('')
  say('=== 5. search：每条命中一个句柄 + 上限 ===')
  const wide = Array.from({ length: 60 }, (_, i) => `line ${i + 1} return token`).join('\n')
  write(FILE, wide)
  const many = readWith(wide, { filePath: FILE, mode: 'search', search: 'return' })
  check(many.ok === true && many.matches === 60, `命中 60 处：${many.matches}`)
  check(Array.isArray(many.handles) && many.handles.length === HANDLE_MAX_PER_RECEIPT, `只发上限那么多条：${many.handles.length}/${HANDLE_MAX_PER_RECEIPT}`)
  check(
    many.handles.every(
      (h) =>
        typeof h.line === 'number' &&
        typeof h.handle === 'string' &&
        HANDLE_RE.test(h.handle) &&
        h.handle.length === handleCharsFor(h.line, h.line),
    ),
    '每条是 {line, handle}、形状合规且长度合规（用同一个 HANDLE_RE 判，不另写一份）',
    JSON.stringify(many.handles[0]),
  )
  check(many.handles[0].line === 1 && many.handles[1].line === 2, '句柄按命中行序给出（1,2,…）')
  check(
    many.handles.every((h) => many.text.includes(`${h.line}:`)),
    '每个带柄的命中行都**真的渲染出来了**（柄不会指到没给的文本）',
  )
  // 模型可见：**每个命中行的行尾**都要有它自己那条句柄
  const hitRows = many.text.split('\n')
  const rowsWithHandle = hitRows.filter((row) => /<h[0-9a-f]{4}[0-9a-f]{8}:\d+-\d+>$/.test(row))
  check(
    rowsWithHandle.length === many.handles.length,
    `每条命中行行尾都带自己的句柄：${rowsWithHandle.length}/${many.handles.length}`,
  )
  const rowHandlePairs = many.handles.every((h) => hitRows.some((row) => row.startsWith(`${h.line}: `) && row.endsWith(`<${h.handle}>`)))
  check(rowHandlePairs, '第 N 行行尾那条柄就是 line=N 那条（不会串行）')
  for (const h of many.handles) {
    const row = hitRows.find((r) => r.startsWith(`${h.line}: `))
    if (row !== undefined) {
      const inText = row.slice(row.lastIndexOf('<') + 1, row.lastIndexOf('>'))
      if (inText !== h.handle) check(false, `line ${h.line} 的 text 柄与结构化柄不一致`, `${inText} vs ${h.handle}`)
    }
  }
  // 超限时：柄只发前 N 条 ⇒ text 里也只该有前 N 行的柄（不能让 text 里多出没记录的柄）
  check(
    rowsWithHandle.length <= HANDLE_MAX_PER_RECEIPT,
    `text 里的句柄数也受上限约束：${rowsWithHandle.length} ≤ ${HANDLE_MAX_PER_RECEIPT}`,
  )
  check(many.handlesOmitted !== undefined, `超出上限只报数：${JSON.stringify(many.handlesOmitted)}`)
  check(
    many.handlesOmitted.total === 60 && many.handlesOmitted.emitted === HANDLE_MAX_PER_RECEIPT,
    '报的数是对的（total 60 / emitted 20）',
  )
  const greedy = readWith(wide, { filePath: FILE, mode: 'search', search: 'return', limit: 100000 })
  check(
    greedy.handles.length === HANDLE_MAX_PER_RECEIPT,
    `调用方用 limit 顶不穿上限（limit=100000 仍只发 ${greedy.handles.length} 条）`,
  )
  check(
    JSON.stringify(greedy.handles) === JSON.stringify(many.handles),
    '顶不穿的后果是回执逐字一致（不是"发得更多"）',
  )
  const few = readWith(A, { filePath: FILE2, mode: 'search', search: 'return' })
  write(FILE, A)
  const few2 = readWith(A, { filePath: FILE2, mode: 'search', search: 'return' })
  check(few2.handles.length === 1 && few2.handlesOmitted === undefined, '命中数在上限内时不报 handlesOmitted')

  say('')
  say('=== 6. 形状：句柄长度 ===')
  const shape = [
    { h: l1.handle, from: 1, to: 3 },
    { h: many.handles[0].handle, from: 1, to: 1 },
    { h: l3.handle, from: 1, to: 2 },
  ]
  check(
    shape.every((s) => s.h.length === handleCharsFor(s.from, s.to)),
    '长度 = 15 + 行号位数×2（与行号自然写法一致，不补零）',
    shape.map((s) => `${s.h.length}/${handleCharsFor(s.from, s.to)}`).join(' '),
  )
  check(
    shape.every((s) => s.h === `h${s.h.slice(1, 5)}${s.h.slice(5, 13)}:${s.from}-${s.to}`),
    '切成 1+4+8+1+行号+-+行号 各段都不空',
  )
  check(HANDLE_RE.test(l1.handle), `HANDLE_RE 认得它：${HANDLE_RE.source}`)
  check(
    HANDLE_RE.exec(l1.handle).slice(3).map(Number).join(',') === `${shape[0].from},${shape[0].to}`,
    '正则捕到的行号与请求一致（1,3）',
  )
  check(mintHandle({ ledgerKey: 'k', regionText: A, byteOrderMark: false, startLine: 1, endLine: 4 }).startsWith('h'), 'mintHandle 直用也合规')
  check(regionFingerprint(A) === regionFingerprint(A), 'regionFingerprint 是纯函数（同样入参同样出参）')
  check(regionFingerprint(A) !== regionFingerprint(B), 'regionFingerprint 对一字节之差不相等（这条就是 mutation 要打的靶）')
  check(
    regionFingerprint(A).length === 8 && /^[0-9a-f]{8}$/.test(regionFingerprint(A)),
    `摘要恒为 8 位十六进制（补零到定长）：${regionFingerprint(A)}`,
  )
  // 契约 §3 说的"21 字符"是行号占 3~4 位那一档（例 h9f3ac1b2e4d5:120-160）。
  // 这里拿真实规模的靶子把那一档钉住：行号进了三位数，长度就该是 21。
  const big = Array.from({ length: 300 }, (_, i) => `line ${i + 1} token`).join('\n')
  write(FILE, big)
  const bigRead = readWith(big, { filePath: FILE, mode: 'lines', lines: [120, 160] })
  write(FILE, A)
  check(
    bigRead.handle.length === HANDLE_CHARS && handleCharsFor(120, 160) === HANDLE_CHARS,
    `行号 120-160 ⇒ 句柄恰为契约说的 ${HANDLE_CHARS} 字符：${bigRead.handle}`,
  )

  say('')
  say('=== 6b. 单源：区间摘要与 contentToken 是同一个哈希 ===')
  /**
   * 这一条钉的是**两份真实输出的关系**，不是"实现长得像"：
   *   · 摘要 = `fnv1a32(...)` 前 8 位（补零）
   *   · 令牌 = `fnv1a32(...)` + `:` + 含 BOM 的字符数
   * 两者共用 `handle-core.mjs` 里那一份 FNV-1a。若谁把哈希又抄回 read-core（或改了常数），
   * 这里会红；若谁在搬家时顺手改了令牌的形状或 BOM 口径，后两条会红。
   */
  const sameHash = (text, bom) => regionFingerprint(text, bom) === contentToken(text, bom).split(':')[0].slice(0, 8)
  const samples = [
    { name: '空串', text: '', bom: false },
    { name: 'ASCII 多行', text: 'a\nbb\nccc\n', bom: false },
    { name: '带 BOM 的多行', text: 'a\nbb\nccc\n', bom: true },
    { name: '非 ASCII', text: '中文行\nemoji 🎯\n', bom: false },
    { name: '超长行', text: 'x'.repeat(5000), bom: false },
  ]
  const mismatched = samples.filter((s) => !sameHash(s.text, s.bom))
  check(
    mismatched.length === 0,
    `区间摘要是 contentToken 指纹段的前 8 位（${samples.length} 份样本含带 BOM 的）`,
    mismatched.map((s) => `${s.name}: ${contentToken(s.text, s.bom)}`).join(' / '),
  )
  check(
    samples.every((s) => /^[0-9a-f]{1,8}:\d+$/.test(contentToken(s.text, s.bom))),
    'contentToken 仍是"指纹段:长度"的形状（搬家时没顺手改它）',
    samples.map((s) => contentToken(s.text, s.bom)).join(' '),
  )
  // 长度段量的是**含 BOM 的**内容：带 BOM 时长度比不带多 1（否则 changed 会说"没变"）
  check(
    Number(contentToken('a\nbb\nccc\n', true).split(':')[1]) === Number(contentToken('a\nbb\nccc\n', false).split(':')[1]) + 1,
    '令牌的长度段含 U+FEFF（BOM 口径没丢）',
    `${contentToken('a\nbb\nccc\n', false)} vs ${contentToken('a\nbb\nccc\n', true)}`,
  )
  check(
    regionFingerprint('a\nbb\nccc\n', true) !== regionFingerprint('a\nbb\nccc\n', false),
    '同一段字节带/不带 BOM 得到不同摘要（与令牌同口径）',
  )
  /**
   * 上面四条都是**行为**判据，而单源是一条**结构**性质：一份**逐字相同**的实现副本
   * 在行为上与本体不可分辨（我实测过：把 FNV 循环再拄回 `contentToken` 里，四条全绿）。
   * 所以这里必须静态看源文件——否则"全仓只剩一份 FNV"只是一句无人看守的话。
   *
   * 扫的名单是**引擎的 8 个模块**（`make-bundle.mjs` 的 `ENGINE` 清单），不是整个目录：
   * `*-test.mjs` / `probes` 不进包、不受打包守卫约束，它们自己写一份哈希是合法的
   * （实测 `incremental-read-test.mjs` 就自带一个 `Math.imul` 混合函数）。
   * 红线说的是"**引擎里**不许有第二份"。
   */
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const ENGINES = [
    'read-core.mjs',
    'locator-api.mjs',
    'struct-core.mjs',
    'anchor-core.mjs',
    'write-path.mjs',
    'args.mjs',
    'repo-map.mjs',
    'handle-core.mjs',
  ]
  /**
   * 判据必须是**真的在算 FNV**：`Math.imul` 加上 FNV 质数，两个都要。
   *
   * 两版误报都是在这里掉的，两版都实测过：
   *   · 只看 `Math.imul` ⇒ `incremental-read-test.mjs` 中招（它有自己的混合函数，不是 FNV）；
   *   · `text.includes('Math.imul')` ⇒ **本文件自己**中招（因为检测代码里写着这四个字）。
   * 质数 + 调用形状两条一起卡，两个误报都不再出现，而真拄一份 FNV 副本仍会红。
   */
  const computesFnv = (text) => text.includes('16777619') && /Math\.imul\s*\(/.test(text)
  const hashSources = ENGINES.filter((f) =>
    computesFnv(fs.readFileSync(path.join(moduleDir, f), 'utf8')),
  )
  check(
    hashSources.length === 1 && hashSources[0] === 'handle-core.mjs',
    `引擎的 ${ENGINES.length} 个模块里只有 handle-core.mjs 在算 FNV-1a（单源是结构性质，行为判据看不见它）`,
    `命中：${hashSources.join(', ') || '（无）'}`,
  )
  const rcText = fs.readFileSync(path.join(moduleDir, 'read-core.mjs'), 'utf8')
  check(/fnv1a32\(source,\s*byteOrderMark\)/.test(rcText), 'contentToken 确实**调用**fnv1a32，而不是自己再算一遍')
  check(!/Math\.imul\s*\(/.test(rcText), 'read-core 里已无哈希运算（搬家搬干净了）')
  const hcText = fs.readFileSync(path.join(moduleDir, 'handle-core.mjs'), 'utf8')
  check(
    hcText.includes('export function fnv1a32'),
    '哈希本体确实住在 handle-core.mjs（不是"两个都没有"）',
  )

  say('')
  say('=== 7. 身份标签：换路径 ⇒ 换标签（同一段字节） ===')
  const onFile2 = readWith(A, { filePath: FILE2, mode: 'lines', lines: [1, 3] })
  check(
    parseHandle(onFile2.handle).fingerprint === parseHandle(l1.handle).fingerprint,
    '同一段字节在两个路径上摘要相同',
  )
  const tagA = parseHandle(l1.handle).idTag
  const tagB = parseHandle(onFile2.handle).idTag
  say(`  （两个路径的标签：${tagA} vs ${tagB}）`)
  check(
    /^[0-9a-f]{4}$/.test(tagA) && tagA.length === 4,
    `标签恒为 4 位（补零到定长，形状才是定长的）：${tagA}/${tagB}`,
  )
  check(identityTag('a') === identityTag('a') && identityTag('a') !== identityTag('b'), 'identityTag 确定且可区分')

  say('')
  say('=== 8. 账本里那条观测还在（编辑侧重找的前提） ===')
  const obs = latestObservation(FILE)
  check(obs !== null && typeof obs === 'object', '按路径能取到最近一次观测（句柄的自描述不依赖它，编辑侧重找依赖）')
  check(obs === null || 'source' in obs || 'token' in obs || 'version' in obs, `观测记录里有内容或版本：${obs === null ? '-' : Object.keys(obs).join(',')}`)
} finally {
  fs.rmSync(TMP, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
say('')
say(`通过 ${results.length - failed.length} / ${results.length}`)
if (failed.length > 0) {
  say(`失败 ${failed.length} 条：`)
  for (const f of failed) say(`  ✗ ${f.label}`)
  process.exit(1)
}
process.exit(0)
