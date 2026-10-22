/**
 * old-fragment-fallback-test —— 行内片段 `old` 的兜底层（fs-contract-v2 / C12，替换范围由 C13 定稿）。
 *
 * ## 命题（施工单终态，判据不可改）
 *
 * 旧契约下能成功、新契约下 `PATCH_NOT_FOUND` 的那批调用要能恢复成功：`old` 给的若是**某一行的
 * 一部分**（原文 `beta gamma`，`old` 只写 `gamma`），整行对齐那一层接不住它，于是被一律判成
 * “原文不在文件里”。这一层把判据换回调用方真正表达的东西：**这段文字在文件里唯一出现**，
 * 命中后**只替换命中的那一段**（C13）——行内其余字节逐字不动，回执里写明起止列。
 *
 * 为什么不是“扩到整行”（C12 早期的口径，已被 C13 反转）：实测静默失效——
 * `{old:"x = 1", replace:"x = 2"}` 打在 `const x = 1` 上，整行版把 `const ` 一起吞掉，
 * 磁盘变成 `x = 2`：调用方拿到“改成了”，结果却不是它要的。
 *
 * ## 三条不许破（本套件逐条钉住）
 *
 *   1. **唯一性**（段B）：片段出现多处 ⇒ 拒绝 + 候选清单 + 磁盘逐字节不变，**不许挑一个**；
 *      也不许“坐标/近邻”当歧义裁决者（那是内置 `edit` 多处匹配静默取第一个的行为）。
 *   2. **磁盘逐字保真**（段C）：混合行尾 / BOM 文件上改完，除**命中跨度**外逐字节不变——
 *      行尾继承、BOM 保留两件事都在字节层比对，不看文本层。
 *   3. **C10 的 expect 单源**（段D）：写路径里不许长出第二份 expect 判据；本套件既跑
 *      `expect-single-source-test.mjs`（它自己带全仓单源扫描），也在**新路径**上实测
 *      闸门仍按 `expectVerdict` 的“包含且唯一”判、且受寻址区间就是那个命中跨度。
 *
 * ## 与 C2 已定口径的关系
 *
 * 坐标仍只是提示：片段层只在**整行对齐一处都没有**时接手，从不参与“该改哪一处”的裁决；
 * 坐标与落点不符仍照 C2 如实披露（两者可以同时出现在 `tier` 里，各说各的事实）。
 *
 * ## 段E 是负向不变量（最容易在“多救几条”的冲动里被破坏的一条）
 *
 * 片段在文件里**没有**出现 ⇒ 仍然 `PATCH_NOT_FOUND`，不许靠相似度层接住（那会把改动落到另一段
 * 文本上，正是本工具存在的理由所要防的事）。实测依据：`failure-replay` 语料里 23 条该恢复的调用中，
 * 19 条的引文确实在原文里（片段层救回），另 4 条的引文与原文**实质不同**（引用的是改后文本 /
 * 语料副本里那句根本不在）——这 4 条必须继续如实拒绝。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { applyEditToProvider } from './write-path.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')

const say = (m) => process.stdout.write(`${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

const TMP = path.join(os.tmpdir(), `old-fragment-${Date.now()}`)
fs.mkdirSync(TMP, { recursive: true })

const BYTE_ORDER_MARK = '\uFEFF'
const encode = (text) => new TextEncoder().encode(text)
const decode = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
const readBytes = (file) => fs.readFileSync(file)
const readTextFile = (file) => decode(readBytes(file))
const writeBytes = (file, bytes) => fs.writeFileSync(file, Buffer.from(bytes))
const writeFile = (file, text) => writeBytes(file, encode(text))
const fsError = (message, code) => Object.assign(new Error(message), { code })
/** 失败的简短说法；`error` 缺席（本该失败却成功了）也要能打印，不能自己抛错。 */
const brief = (error) =>
  error === null || error === undefined
    ? 'no error (这次没有拒绝)'
    : `${error.code ?? '?'} ${String(error.message ?? error).slice(0, 150)}`
const bytesEqual = (file, text) => Buffer.compare(readBytes(file), Buffer.from(encode(text))) === 0

/**
 * 与真提供方同形的文件提供方：`readByteRange` 给原始字节（BOM 只能从字节看出来），
 * `readText` 解码时剥掉恰好一个前导 BOM，`writeText` 逐字节写 + 版本 CAS。
 * 形状照抄 `content-address-test` / `write-verify-test` 的 mock——mock 与真件不同形就等于没测。
 */
function makeProvider() {
  let version = 1
  let bound = null
  const provider = {
    stat: async (target) =>
      fs.existsSync(target) ? { version: `v${version}`, type: 'file', size: fs.statSync(target).size } : undefined,
    readText: async (target) => {
      if (!fs.existsSync(target)) throw fsError(`cannot read "${target}": not found`, 'FS_NOT_FOUND')
      return decode(readBytes(target))
    },
    readByteRange: async (target, range) => {
      if (!fs.existsSync(target)) throw fsError(`cannot read "${target}": not found`, 'FS_NOT_FOUND')
      return readBytes(target).subarray(range.offset, range.offset + range.length)
    },
    writeText: async (target, content, expected) => {
      if (expected?.kind === 'replaceIfVersion' && `v${version}` !== expected.version) {
        throw fsError('file changed since it was read', 'FS_STALE_VERSION')
      }
      writeFile(target, content)
      version += 1
      return { version: `v${version}`, operation: 'update', after: content }
    },
  }
  provider.bind = (file) => {
    bound = file
    return provider
  }
  return provider
}

/** 新建一个用例：文件 + 提供方 + 一个能跑写路径的句柄。 */
let caseSeq = 0
const fresh = (name, text) => {
  caseSeq += 1
  const file = path.join(TMP, `${caseSeq}-${name}`)
  writeFile(file, text)
  return { file, provider: makeProvider().bind(file) }
}
/** 同上，但落**原始字节**（BOM / 混合行尾这类只能在字节层构造的夹具）。 */
const freshBytes = (name, bytes) => {
  caseSeq += 1
  const file = path.join(TMP, `${caseSeq}-${name}`)
  writeBytes(file, bytes)
  return { file, provider: makeProvider().bind(file) }
}

/** 跑一次真写路径：成功返回回执，失败返回错误（**绝不吞**）。 */
const attempt = async (subject, hunks) => {
  try {
    return { ok: true, out: await applyEditToProvider(subject.provider, { displayPath: subject.file, hunks }) }
  } catch (error) {
    return { ok: false, error }
  }
}

// ════════════════════════════════════════════════════════════════════════════
say('=== A. 行内片段 old ⇒ 只换命中跨度，行内其余字节逐字不动 ===')
{
  const SRC = 'alpha\nbeta gamma\ndelta\n'
  const c = fresh('a-inline.js', SRC)
  const r = await attempt(c, [{ old: 'gamma', replace: 'GAMMA' }])
  check(r.ok, 'A1 片段 `gamma`（原文是 `beta gamma`）⇒ 改中', r.ok ? '' : brief(r.error))
  check(r.ok && r.out.applied[0].line === 2, 'A1 落点 = 含该片段的那一行（line 2）', r.ok ? `line ${r.out.applied[0]?.line}` : brief(r.error))
  const tier = r.ok ? String(r.out.applied[0].tier) : ''
  check(
    tier.startsWith('old~fragment') && tier.includes('inside line 2') && /columns 6-10/.test(tier),
    'A1 回执（applied[].tier）说清“被替换的是第 2 行的第 6-10 列这一小段”',
    tier,
  )
  check(
    r.ok && r.out.applied[0].actual === 'gamma' && r.out.applied[0].replaced === 'GAMMA',
    'A1 回执给出被替换的**那一小段**原文与替换后的文本（范围可核对）',
    r.ok ? `${JSON.stringify(r.out.applied[0]?.actual)} → ${JSON.stringify(r.out.applied[0]?.replaced)}` : '',
  )
  check(bytesEqual(c.file, 'alpha\nbeta GAMMA\ndelta\n'), 'A1 磁盘：只换命中跨度，行内的 `beta ` 逐字不动', JSON.stringify(readTextFile(c.file)))
}
{
  // 片段的另一种形状：行首（去掉缩进/尾注释后的前缀），旧契约里 `expect` 最常见的写法。
  const c = fresh('a-prefix.js', 'function f() {\n  const width = 12;  // px\n  return width\n}\n')
  const r = await attempt(c, [{ old: 'width = 12', replace: 'width = 16' }])
  check(
    r.ok && r.out.applied[0].line === 2 && r.out.applied[0].actual === 'width = 12',
    'A2 行内片段（少写了缩进与行尾注释）⇒ 只换 `width = 12` 那一段',
    r.ok ? `line ${r.out.applied[0]?.line} ${JSON.stringify(r.out.applied[0]?.actual)}` : brief(r.error),
  )
  check(
    bytesEqual(c.file, 'function f() {\n  const width = 16;  // px\n  return width\n}\n'),
    'A2 磁盘：缩进与行尾注释一字不动，不会被 `replace` 里的多余缩进顶成两段',
    JSON.stringify(readTextFile(c.file)),
  )
}
{
  // 跨行片段：`old` 从第 1 行中间起、到第 2 行中间止（引用一段代码时最常见的形状）。
  const c = fresh('a-span.js', 'let x = 1\nlet y = 2\nlet z = 3\n')
  const r = await attempt(c, [{ old: '= 1\nlet y =', replace: 'let x = 7\nlet y = 8' }])
  check(
    r.ok && r.out.applied[0].line === 1 && r.out.applied[0].actual === '= 1\nlet y =',
    'A3 跨行片段 ⇒ 替换范围 = 从第 1 行中间到第 2 行中间的那一段（actual 就是它）',
    r.ok ? `line ${r.out.applied[0]?.line} ${JSON.stringify(r.out.applied[0]?.actual)}` : brief(r.error),
  )
  check(
    r.ok && /columns 7-16/.test(String(r.out.applied[0].tier)),
    'A3 回执把这跨行跨度的起止写在第 1 行内（`line.slice(endCol)` 能直接切到后半行）',
    r.ok ? String(r.out.applied[0].tier) : '',
  )
  check(bytesEqual(c.file, 'let x let x = 7\nlet y = 8\nlet z = 3\n'), 'A3 磁盘：第 3 行一字未动', JSON.stringify(readTextFile(c.file)))
}
{
  /**
   * 空白折叠层：片段与原文的空白不同（行内多空格）。夹具刻意写成**行内片段**（后面还跟着 `// tail`）：
   * 否则整行对齐层的 norm-space 级就把它接住了，这一段量的就不是片段层了（写这条时先踩过一次）。
   */
  const c = fresh('a-space.js', 'head\n  beta   gamma  // tail\nzeta\n')
  const r = await attempt(c, [{ old: 'beta gamma', replace: 'BETA' }])
  check(
    r.ok && r.out.applied[0].line === 2 && String(r.out.applied[0].tier).startsWith('old~fragment~norm-space'),
    'A4 片段与原文空白不同 ⇒ 降到片段层的空白折叠级（tier = old~fragment~norm-space）',
    r.ok ? `line ${r.out.applied[0]?.line} tier=${r.out.applied[0]?.tier}` : brief(r.error),
  )
  check(
    bytesEqual(c.file, 'head\n  BETA  // tail\nzeta\n'),
    'A4 磁盘：只换跨度（列号按**原文**量，`beta   gamma` 里被折掉的空格一起换掉），尾注释不动',
    JSON.stringify(readTextFile(c.file)),
  )
}
{
  // 同一行里出现两次：两处跨度落在**不同的列**上，替换的是不同的字节 ⇒ 那是“两处让你挑”。
  const c = fresh('a-twice-one-line.js', 'head\ndup dup\ntail\n')
  const before = readBytes(c.file)
  const r = await attempt(c, [{ old: 'dup', replace: 'ONCE' }])
  check(
    !r.ok && r.error.code === 'PATCH_AMBIGUOUS' && (r.error.candidates ?? []).length === 2,
    'A5 片段在同一行出现两次 ⇒ 拒绝（两处跨度不同，不许挑一个）',
    brief(r.error),
  )
  check(
    !r.ok && r.error.candidates.every((x) => x.line === 2) && r.error.candidates[0].startCol !== r.error.candidates[1].startCol,
    'A5 两个候选都在第 2 行、但起止列不同（靠列号才分得清是哪一处）',
    JSON.stringify((r.ok ? [] : (r.error.candidates ?? [])).map((x) => [x.line, x.startCol, x.endCol])),
  )
  check(Buffer.compare(before, readBytes(c.file)) === 0, 'A5 磁盘逐字节不变', `before=${before.length}B after=${readBytes(c.file).length}B`)
}

// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== B. 片段在文件里出现多次 ⇒ 拒绝 + 候选清单 + 磁盘逐字节不变 ===')
const B_SRC = 'alpha gamma\nbeta\ngamma delta\n'
{
  const c = fresh('b-ambiguous.js', B_SRC)
  const before = readBytes(c.file)
  const r = await attempt(c, [{ old: 'gamma', replace: 'GAMMA' }])
  check(!r.ok && r.error.code === 'PATCH_AMBIGUOUS', 'B1 片段两处 ⇒ 拒绝（PATCH_AMBIGUOUS，不挑一个）', brief(r.error))
  const candidates = r.ok ? [] : (r.error.candidates ?? [])
  check(
    candidates.length === 2 && candidates[0].line === 1 && candidates[1].line === 3 &&
      candidates.every((x) => x.text === 'gamma') && candidates[0].startCol === 7 && candidates[1].startCol === 1,
    'B1 候选清单 = 两处**命中跨度**（行号 + 起止列 + 那一段原文）',
    JSON.stringify(candidates.map((x) => [x.line, x.startCol, x.endCol, x.text])),
  )
  const message = r.ok ? '' : String(r.error.message)
  check(
    /line 1 columns 7-11/.test(message) && /line 3 columns 1-5/.test(message) && message.includes('gamma') && message.includes('context'),
    'B1 候选写进 message（连列号一起给，框架只读 error.message，字段读不到）',
    message.slice(0, 200),
  )
  check(Buffer.compare(before, readBytes(c.file)) === 0, 'B1 磁盘逐字节不变', `before=${before.length}B after=${readBytes(c.file).length}B`)
}
{
  const c = fresh('b-context.js', B_SRC)
  const r = await attempt(c, [{ old: 'gamma', context: 'gamma delta', replace: 'GAMMA' }])
  check(
    r.ok && r.out.applied[0].line === 3 && String(r.out.applied[0].tier).startsWith('old~fragment+context'),
    'B2 片段两处但 context 收敛到一处 ⇒ 改中（tier = old~fragment+context）',
    r.ok ? `line ${r.out.applied[0]?.line} tier=${r.out.applied[0]?.tier}` : brief(r.error),
  )
  check(bytesEqual(c.file, 'alpha gamma\nbeta\nGAMMA delta\n'), 'B2 磁盘：另一处与命中行内的其余字节都一字未动', JSON.stringify(readTextFile(c.file)))
}
{
  const c = fresh('b-context-fails.js', B_SRC)
  const before = readBytes(c.file)
  const r = await attempt(c, [{ old: 'gamma', context: 'this text is nowhere in this file', replace: 'GAMMA' }])
  check(!r.ok && r.error.code === 'PATCH_AMBIGUOUS', 'B3 片段两处且 context 收敛不了 ⇒ 仍拒绝', brief(r.error))
  check(
    !r.ok && (r.error.candidates ?? []).length === 2,
    'B3 候选清单仍给两条（收敛失败不等于可以随便挑）',
    JSON.stringify((r.ok ? [] : (r.error.candidates ?? [])).map((x) => x.line)),
  )
  check(Buffer.compare(before, readBytes(c.file)) === 0, 'B3 磁盘逐字节不变', `before=${before.length}B after=${readBytes(c.file).length}B`)
}
{
  // 坐标不是裁决者：两处候选 + 坐标指向其中一处 ⇒ 仍然拒绝（与 C2 段G 同一口径，这里在片段层再钉一次）。
  const c = fresh('b-coordinate-not-judge.js', B_SRC)
  const before = readBytes(c.file)
  const r = await attempt(c, [{ old: 'gamma', lines: [3, 3], replace: 'GAMMA' }])
  check(
    !r.ok && r.error.code === 'PATCH_AMBIGUOUS',
    'B4 片段两处 + 坐标指向其中一处 ⇒ 坐标不当歧义裁决者，仍拒绝',
    brief(r.error),
  )
  check(Buffer.compare(before, readBytes(c.file)) === 0, 'B4 磁盘逐字节不变', `before=${before.length}B after=${readBytes(c.file).length}B`)
}

// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== C. 混合行尾 / BOM：除目标行外逐字节不变 ===')
{
  const c = freshBytes('c-mixed-eol.md', encode('alpha\r\nbeta gamma\ndelta\r\n'))
  const r = await attempt(c, [{ old: 'gamma', replace: 'GAMMA' }])
  check(r.ok, 'C1 混合行尾（CRLF 多数派 + 一行 LF）上片段命中', r.ok ? `line ${r.out.applied[0]?.line}` : brief(r.error))
  check(
    bytesEqual(c.file, 'alpha\r\nbeta GAMMA\ndelta\r\n'),
    'C1 逐字节：只换命中跨度，非目标行与命中行的其余字节（含各自的行尾）原样',
    JSON.stringify(readTextFile(c.file)),
  )
}
{
  const c = freshBytes('c-bom.md', Buffer.concat([Buffer.from(encode(BYTE_ORDER_MARK)), Buffer.from(encode('alpha\nbeta gamma\n'))]))
  const r = await attempt(c, [{ old: 'gamma', replace: 'GAMMA' }])
  check(r.ok, 'C2 BOM 文件上片段命中（readText 剥掉的那个 BOM 必须原样写回）', r.ok ? `line ${r.out.applied[0]?.line}` : brief(r.error))
  const want = Buffer.concat([Buffer.from(encode(BYTE_ORDER_MARK)), Buffer.from(encode('alpha\nbeta GAMMA\n'))])
  check(
    Buffer.compare(readBytes(c.file), want) === 0,
    'C2 逐字节：BOM 还在，除命中跨度外逐字节与原文一致',
    `before=${readBytes(c.file).length}B after=${readBytes(c.file).length}B`,
  )
}
{
  // BOM + 混合行尾 + 片段在首行：三件事叠在一起，边界最容易互相掩盖。
  const src = Buffer.concat([Buffer.from(encode(BYTE_ORDER_MARK)), Buffer.from(encode('gamma alpha\r\nbeta\n'))])
  const c = freshBytes('c-bom-mixed.md', src)
  const r = await attempt(c, [{ old: 'alpha', replace: 'ALPHA' }])
  const want = Buffer.concat([Buffer.from(encode(BYTE_ORDER_MARK)), Buffer.from(encode('gamma ALPHA\r\nbeta\n'))])
  check(
    r.ok && Buffer.compare(readBytes(c.file), want) === 0,
    'C3 BOM + 混合行尾 + 首行片段 ⇒ 逐字节等于期望（BOM 保留、第 1 行的 CRLF 保留、第 2 行未动）',
    r.ok ? JSON.stringify(readTextFile(c.file)) : brief(r.error),
  )
}

// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== D. 不退化：C10 的 expect 单源 + content-address 判据 ===')
{
  const runSuite = (name) => {
    const res = spawnSync(process.execPath, [path.join(HERE, name)], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    return { exit: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
  }

  const single = runSuite('expect-single-source-test.mjs')
  const singleTail = single.out.split(/\r?\n/).filter((l) => l.includes('通过')).pop() ?? ''
  check(
    single.exit === 0 && /44\/44 通过/.test(singleTail),
    'D1 expect-single-source-test.mjs 仍 exit 0 / 44/44（它自己带“全仓只有一份 expect 判据”的扫描 + C17 分档）',
    `exit=${single.exit} ${singleTail.trim()}`,
  )

  /**
   * content-address-test 的读数有两种合法形态，本段两者都认，但**只认这两种**：
   *   · 形态一（C12 落地后、段E2 还没重定向）：68 条断言里 65 绿，红的**恰好**是段E2 那三条
   *     ——它们钉的是“old 只落在行中间必须拒绝”，也就是 C12 施工单点名要反转的旧口径；
   *   · 形态二（有人把段E2 按新口径重写之后）：68 绿 / 0 红。
   * 其它任何组合都红——尤其“E2 绿了但别的地方红了”，那是真退化，不许混进来。
   */
  const addr = runSuite('content-address-test.mjs')
  const addrLines = addr.out.split(/\r?\n/)
  const addrOk = addrLines.filter((l) => l.startsWith('✓')).length
  const addrFail = addrLines.filter((l) => l.trimStart().startsWith('FAIL:'))
  const e2Only = addrFail.every((l) => l.includes('E2'))
  const legal =
    (addr.exit === 0 && addrFail.length === 0 && addrOk === 68) ||
    (addr.exit === 1 && addrFail.length === 3 && e2Only && addrOk === 65)
  check(
    legal,
    'D2 content-address-test 的 68 条断言：除“段E2 旧口径那三条”外一条都不许红（逐条点名核对）',
    `exit=${addr.exit} ✓${addrOk} / FAIL ${addrFail.length} 条${addrFail.length > 0 ? `：${addrFail.map((l) => l.trim().slice(0, 60)).join(' ｜ ')}` : ''}`,
  )
  check(
    addrFail.every((l) => l.includes('E2')) && addrOk + addrFail.length === 68,
    'D2 content-address 断言总数仍是 68（不许靠删断言/跳过变绿）',
    `✓${addrOk} + FAIL${addrFail.length} = ${addrOk + addrFail.length}`,
  )
  // 段E2 那条输入在新契约（C13）下的**新**读数：命中跨度被单独换掉，行内其余字节不动。
  const e2 = fresh('d-e2-flip.js', 'const x = 1\n')
  const e2r = await attempt(e2, [{ old: 'x = 1', replace: 'x = 2' }])
  check(
    e2r.ok && bytesEqual(e2.file, 'const x = 2\n'),
    'D3 段E2 的输入在新契约下改中（只换 `x = 1` 那一段，`const ` 逐字保留）',
    e2r.ok ? `line ${e2r.out.applied[0]?.line} actual=${JSON.stringify(e2r.out.applied[0]?.actual)}` : brief(e2r.error),
  )

  /**
   * 新路径上 expect 闸门仍走 {@link expectVerdict} 那一份判据（C10）：
   * 片段命中时**受寻址区间就是命中跨度**（C13：它就是被替换的那一段），
   * 所以短引文要求与这一段整段相等、长引文要求“被这一段包含且全文唯一”。
   */
  const g1 = fresh('d-expect-outside.js', 'alpha\nbeta gamma\ndelta\n')
  const before1 = readBytes(g1.file)
  const g1r = await attempt(g1, [{ old: 'gamma', expect: 'nowhere-in-this-file-at-all', replace: 'X' }])
  check(
    !g1r.ok && g1r.error.code === 'PATCH_NOT_FOUND' && /nowhere in this file/.test(String(g1r.error.message)),
    'D4 片段地址下 expect 仍按同一份判据判（全文没有 ⇒ nowhere）',
    brief(g1r.error),
  )
  check(Buffer.compare(before1, readBytes(g1.file)) === 0, 'D4 被 expect 拦下时磁盘逐字节不变', `${readBytes(g1.file).length}B`)
  const g2 = fresh('d-expect-region.js', 'alpha\nbeta gamma\ndelta\n')
  const g2r = await attempt(g2, [{ old: 'gamma', expect: 'beta', replace: 'X' }])
  check(
    !g2r.ok && g2r.error.code === 'PATCH_EXPECT_MISMATCH',
    'D5 受寻址区间 = **命中跨度**（`expect: beta` 与 `gamma` 对不上 ⇒ 短引文整段相等判不过）',
    brief(g2r.error),
  )
  const g3 = fresh('d-expect-region-ok.js', 'alpha\nbeta gamma\ndelta\n')
  const g3r = await attempt(g3, [{ old: 'gamma', expect: 'gamma', replace: 'GAMMA' }])
  check(
    g3r.ok && bytesEqual(g3.file, 'alpha\nbeta GAMMA\ndelta\n'),
    'D5 短 expect 与命中跨度整段相等 ⇒ 通过，且只换那一段（同一件事的另一面）',
    g3r.ok ? `line ${g3r.out.applied[0]?.line}` : brief(g3r.error),
  )

  /**
   * ── C17 分档在**本套件的靶场**（行内片段旧路径）上的两条：
   *
   * `old` 是**内容寻址**（不给坐标），写路径在那一支调 `expectVerdict` 时**不传**第 6 参 ——
   * 所以引文不唯一仍然是歧义：判据里的“包含且唯一”那一半在本套件里一条不让。
   * 而同一份文件、同一段引文，只要把地址换成**精确坐标**（`lines`），区间就是调用方给的地址
   * ⇒ C17 免掉唯一性，改中。两条是同址同引文的对照，也是本套件的**变异反证**：
   * 把第 6 参那一档收回去，下面第三条当场红。
   */
  const DUP_SRC = 'let sum = 0;\nline two\nlet sum = 0;\n'
  const h1 = fresh('d-dup-by-old.js', DUP_SRC)
  const h1before = readBytes(h1.file)
  const h1r = await attempt(h1, [{ old: 'line two', expect: 'let sum = 0;', replace: 'let sum = 1;' }])
  check(
    !h1r.ok && h1r.error.code === 'PATCH_AMBIGUOUS' && (h1r.error.candidates ?? []).map((n) => n.line).join(',') === '1,3',
    'D6 线索档（old 无坐标）+ 引文全文 2 处 ⇒ 仍拒 PATCH_AMBIGUOUS 并给两处候选（一条不让）',
    brief(h1r.error),
  )
  check(Buffer.compare(h1before, readBytes(h1.file)) === 0, 'D6 线索档被拒时磁盘逐字节不变', `${readBytes(h1.file).length}B`)

  const h2 = fresh('d-dup-by-lines.js', DUP_SRC)
  const h2r = await attempt(h2, [{ lines: [3, 3], expect: 'let sum = 0;', replace: 'let sum = 1;' }])
  check(
    h2r.ok && bytesEqual(h2.file, 'let sum = 0;\nline two\nlet sum = 1;\n'),
    'D6 坐标档（lines）+ 同一段引文 ⇒ 通过，且只改坐标指的那一处（C17 分档）',
    h2r.ok ? `line ${h2r.out.applied[0]?.line}` : brief(h2r.error),
  )
  check(
    !h1r.ok && h2r.ok === true,
    'D6 分档开关可机械核对：同引文同文件，线索档 ⇒ 拒；坐标档 ⇒ 中（收回忆放宽则本条与 D1 必红）',
    `线索档=${h1r.error?.code ?? 'applied'} / 坐标档=${h2r.ok ? 'applied' : h2r.error?.code}`,
  )
}

// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== E. 负向不变量：片段在文件里没有出现 ⇒ 仍 NOT_FOUND，不许误伤 ===')
{
  const SRC = 'alpha\nbravo\ncharlie\n'
  const c = fresh('e-absent.js', SRC)
  const before = readBytes(c.file)
  const r = await attempt(c, [{ old: 'delta', lines: [2, 2], replace: 'DELTA' }])
  check(!r.ok && r.error.code === 'PATCH_NOT_FOUND', 'E1 片段不存在 ⇒ 拒绝（PATCH_NOT_FOUND）', brief(r.error))
  check(
    !r.ok && /not as whole lines/.test(String(r.error.message)) && /Coordinates are only a hint/.test(String(r.error.message)),
    'E1 拒绝理由说清“两层都找过了：整行不是、行内片段也不是；坐标只是提示”',
    String(r.ok ? '' : r.error.message).slice(0, 200),
  )
  check(Buffer.compare(before, readBytes(c.file)) === 0, 'E1 磁盘逐字节不变', `before=${before.length}B after=${readBytes(c.file).length}B`)
}
{
  // 与原文只差一个字符：**没有**相似度层接住它——接住了就会改到另一段文本上。
  const SRC = 'const total = 0;\nconst other = 1;\n'
  const c = fresh('e-one-char-off.js', SRC)
  const before = readBytes(c.file)
  const r = await attempt(c, [{ old: 'const totl = 0;', replace: 'const total = 9;' }])
  check(
    !r.ok && r.error.code === 'PATCH_NOT_FOUND',
    'E2 片段与原文只差一个字符 ⇒ 仍 NOT_FOUND（片段层不跟相似度，见段E 的头部说明）',
    brief(r.error),
  )
  check(Buffer.compare(before, readBytes(c.file)) === 0, 'E2 磁盘逐字节不变（没有“顺手改到最近的那一行”）', `${readBytes(c.file).length}B`)
}
{
  // 片段跨行、但那两行在文件里不相邻 ⇒ 不许“跳行拼”出一段假命中。
  const c = fresh('e-nonadjacent.js', 'a\nb\nc\n')
  const before = readBytes(c.file)
  const r = await attempt(c, [{ old: 'a\nc', replace: 'AC' }])
  check(
    !r.ok && r.error.code === 'PATCH_NOT_FOUND',
    'E3 片段跨行但两行不相邻 ⇒ NOT_FOUND（不许跳行拼接）',
    brief(r.error),
  )
  check(Buffer.compare(before, readBytes(c.file)) === 0, 'E3 磁盘逐字节不变', `${readBytes(c.file).length}B`)
}
{
  /**
   * 反过来的一条：**整行对齐已经命中时，片段层不许再插一脚**。
   *
   * 夹具里 `gamma` 既是第 1 行的**整行**，也是第 2 行里的一个**片段**：若实现成“两层一起收候选”，
   * 这里会冒出两个候选（第 1 行、第 2 行）并判成歧义——而调用方那句话本来清清楚楚指的是第 1 行。
   * 所以落点必须是第 1 行，且 `tier` 必须是干净的 `old`（不带片段层的说明）。
   */
  const c = fresh('e-aligned-wins.js', 'gamma\nalpha gamma two\n')
  const r = await attempt(c, [{ old: 'gamma', replace: 'GAMMA' }])
  check(
    r.ok && r.out.applied[0].line === 1 && String(r.out.applied[0].tier) === 'old',
    'E4 整行对齐命中时片段层不参与（落点 = 第 1 行，tier = old，不带片段说明）',
    r.ok ? `line ${r.out.applied[0]?.line} tier=${r.out.applied[0]?.tier}` : brief(r.error),
  )
  check(bytesEqual(c.file, 'GAMMA\nalpha gamma two\n'), 'E4 磁盘：第 2 行里那个同名的片段一字未动', JSON.stringify(readTextFile(c.file)))
}

// ════════════════════════════════════════════════════════════════════════════
say('')
const passed = results.filter((r) => r.ok).length
say(`--- 结果：${passed}/${results.length} 通过 ---`)
for (const f of results.filter((r) => !r.ok)) say(`  FAIL: ${f.label}  ${f.detail}`)
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(passed === results.length ? 0 : 1)
