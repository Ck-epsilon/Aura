/**
 * coordinate-drift-test —— 行号地址的**漂移判据**（T21 的落地形态）。
 *
 * ## 这条判据为什么存在
 *
 * 区域级新鲜度闸门（`stale-gate-test`）原来的判据是：把同一个 hunk 再对**上次观测**跑一遍定位，
 * 比对两次解析出的区域文本。它挡得住“被寻址那一行被改过”，但挡不住一种更隐蔽的情形：
 * **行号整体位移之后，同一个行号上恰好还是那段文本**——那时文本相符、地址却已指着别处。
 *
 * ## 四次证伪（每一版都是实测红的，别重做）
 *
 * | 版 | 判据 | 被哪一例证伪 |
 * |----|------|--------------|
 * | 一 | 这段文本在文件里**只出现一次**，且还在这个行号上 | ⑥ 重复行（`}`、空行、许可证头是常态）⇒ 没位移的正常编辑也被拒 |
 * | 二 | 文件**总行数**变了就拒 | ② 第三方在下方删两行 ⇒ 总行数变了，被寻址那一行逐字节没动 |
 * | 三 | **从文件头到本区域末尾**必须逐字相同 | 段C 基准：第三方改的是第 1 行，被寻址的第 3 行一字未动（`stale-gate-test` 明写“不许退化成全局版本守”） |
 * | 四 | 总行数必须**相同** | 段C 第二例：只在尾部追加 ⇒ 同上 |
 *
 * 四版错在同一处：都想用**整份**的性质回答**区域**的问题。成形的判据只做两件事，
 * 且都拿“模型自己给的那一行”当锚，而不是拿整份文件当锚：
 *   1. 观测那一版里这段文本必须出现在**模型说的那一行**（`thenAt.first === match.line`）；
 *   2. 只有当区域在两侧都**不唯一**时，才退一步看行数（挡“前面删两行、后面添两行”这种自偿位移）。
 * 外加一条正确性短路：观测到的就是现在这份内容（逐字节，行尾不参与）⇒ 不可能有漂。
 *
 * ## 本测试的立场
 *
 * 判据只会因为**证据**拒绝，不因为“我有疑虑”拒绝。所以每一例都同时钉住两件事：
 * 判决（放行/拒绝）**以及**放行时磁盘会变成什么——判据错了不要紧，错到把改动写到别处才要紧。
 */
import { planHunks, staleConflicts } from './write-path.mjs'

const say = (m) => process.stdout.write(`${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

const BASE = 'one\ntwo\nthree\nfour\nfive\n'
const JS = 'probe.js'

/** 跑一次判据：返回判决与“放行时写出来的内容”。 */
function judge(observed, current, hunk) {
  const planned = planHunks(current, [hunk], JS)
  const conflicts = staleConflicts(observed, current, [hunk], planned.matches, JS, { contentPath: JS })
  return { clean: conflicts.length === 0, reason: conflicts[0]?.reason ?? null, nowAt: conflicts[0]?.nowAt ?? null, written: planned.content }
}

const E = (label, observed, current, hunk, expect) => ({ label, observed, current, hunk, expect })

// ── 必须拒绝：地址已漂 / 内容已变 ────────────────────────────────────────────
say('=== 必须拒绝：模型给的绝对坐标已不作数 ===')
const mustRefuse = [
  E('① 上方删两行 ⇒ 第 3 行已不是它以为的那一行', BASE, 'three\nfour\nfive\n', { lines: [3, 3], replace: 'MINE' }, 'moved'),
  E('③ 上方插两行 ⇒ 第 3 行已不是它以为的那一行', BASE, 'x\ny\none\ntwo\nthree\nfour\nfive\n', { lines: [3, 3], replace: 'MINE' }, 'moved'),
  E('④ 被寻址那一行本身被改过', BASE, 'one\ntwo\nTHREE\nfour\nfive\n', { lines: [3, 3], replace: 'MINE' }, 'changed'),
  E('⑤ 上方删两行 + 地址越界 ⇒ 定到别处', BASE, 'three\nfour\nfive\n', { lines: [4, 4], replace: 'MINE' }, 'moved'),
  E('⑦ 重复行 + 上方位移', 'three\naaa\nthree\nbbb\n', 'zzz\nthree\naaa\nthree\nbbb\n', { lines: [3, 3], replace: 'MINE' }, 'changed'),
]
for (const c of mustRefuse) {
  const r = judge(c.observed, c.current, c.hunk)
  check(!r.clean && r.reason === c.expect, `${c.label} ⇒ 拒（reason=${c.expect}）`, `实际 ${r.clean ? '放行' : r.reason}`)
}

// ── 必须放行：四版判据各自误杀过的那些 ──────────────────────────────────────
say('')
say('=== 必须放行：拿整份文件当锚会误杀的四种情形 ===')
const mustAllow = [
  E('② 下方删两行，被寻址那一行一字未动', BASE, 'one\ntwo\nthree\n', { lines: [3, 3], replace: 'MINE' }, 'one\ntwo\nMINE\n'),
  E('C 无关区域（第 1 行）被第三方改过', 'line one\r\nline two\r\nline three\r\n', 'line one CHANGED BY B\r\nline two\r\nline three\r\n', { lines: [3, 3], replace: 'MINE' }, 'line one CHANGED BY B\nline two\nMINE\n'),
  E('C 只在尾部追加', 'line one\r\nline two\r\nline three\r\n', 'line one\r\nline two\r\nline three\r\nappended by B\r\n', { lines: [3, 3], replace: 'MINE' }, 'line one\nline two\nMINE\nappended by B\n'),
  E('⑥ 重复行、文件一字未改 ⇒ 编第二次出现的那一行', 'three\naaa\nthree\nbbb\n', 'three\naaa\nthree\nbbb\n', { lines: [3, 3], replace: 'MINE' }, 'three\naaa\nMINE\nbbb\n'),
  // 期望值里的尾随 `\n` 是夹具的伪影（`split(/\r?\n/)` 对以换行结尾的文本会多出一个空元素，
  // `join('\n')` 又把它拼回去），不是产品行为——所以按归一化后的逐行相等来断言，不逐字比。
  E('⑧ 内容寻址（target=）：插入两行后仍编同一个函数', 'head\n\nfunction beta() {\n  return 2\n}\n', '// ins 1\n// ins 2\nhead\n\nfunction beta() {\n  return 2\n}\n', { target: 'beta', replace: 'function beta() {\n  return 42\n}\n' }, '// ins 1\n// ins 2\nhead\n\nfunction beta() {\n  return 42\n}\n\n'),
]
for (const c of mustAllow) {
  const r = judge(c.observed, c.current, c.hunk)
  check(r.clean, `${c.label} ⇒ 放行`, r.clean ? '' : `reason=${r.reason}`)
  if (r.clean) {
    const normalized = r.written.split(/\r?\n/).join('\n')
    check(normalized === c.expect, `${c.label} ⇒ 改的是**对的地方**`, normalized === c.expect ? '' : `实际 ${JSON.stringify(normalized)}`)
  }
}

// ── ⑨ 证据不足时不许冒充：当前内容不是我们观测过的那一版 ─────────────────────
// 这一格是“余下的暴露”的书面化：模型手上的行号来自哪一版，账本里没有记录，
// 所以当区域文本**重复**且行数**变了**时，判据只能拒绝（唯一性不足以锚定，行数差又说明插删过）。
say('')
say('=== ⑨ 重复区域 + 行数变化 ⇒ 证据不足，拒绝（而不是猜）===')
{
  const r = judge('three\naaa\nthree\nbbb\n', 'zzz\nthree\naaa\nthree\nbbb\n', { lines: [3, 3], replace: 'MINE' })
  check(!r.clean, '⑨ 重复区域 + 行数变化 ⇒ 拒（不给假行号）', r.clean ? '放行了' : `reason=${r.reason} nowAt=${r.nowAt ?? 'null'}`)
}

// ── ⑩ 判据与寻址层级一致：同时给 target= 与 lines= 时，是 target= 说了算 ─────
say('')
say('=== ⑩ 同时给 target= 与 lines=：定位器用 target=，闸门也必须按它判 ===')
{
  const observed = 'function beta() {\n  return 2\n}\n'
  const current = '// ins\nfunction beta() {\n  return 2\n}\n'
  const byTarget = judge(observed, current, { target: 'beta', lines: [1, 1], replace: 'function beta() {\n  return 42\n}\n' })
  check(byTarget.clean, '⑩ target= 在场 ⇒ 不做行号漂移核对（符号身份不受行号影响）', byTarget.clean ? '' : `reason=${byTarget.reason}`)
  const byLines = judge(observed, current, { lines: [1, 1], replace: 'X' })
  check(!byLines.clean, '⑩ 只给 lines= ⇒ 照常核对行号', byLines.clean ? '放行了' : `reason=${byLines.reason}`)
}

// ── ⑪ dry_run 必须预演出**真正的判决**（真机跑出来的缺陷）──────────────────
//
// 实测形状（本机 `drift.md`）：`dry_run: true` 的回执说 "every hunk matched"，
// 而**同样的 hunks** 真落盘时闸门报 "the text you addressed moved: line 3 no longer holds it
// (it is now line 1)"。原因是 `if (dryRun) return` 排在闸门**之前**——
// 而 `dry_run` 的全部价值就是“先看会发生什么”：一个说“没事”的预演比没有预演更坏，
// 它会把“会被拒的编辑”报成“可以放心提交”。
//
// 这里在两个面上各钉一次：CLI/MCP 走的 `applyEditToProvider`，与 DSH 壳的 execute。
say('')
say('=== ⑪ dry_run 与真实判决必须一致 ===')
{
  const observed = 'one\ntwo\nthree\nfour\nfive\n'
  const current = 'three\nfour\nfive\n'
  const hunk = { lines: [3, 3], replace: 'MINE' }

  // ① 判据层：同一组输入，干跑与真判必须是同一个结论（漂移）
  const dry = judge(observed, current, hunk)
  check(!dry.clean, '⑪ 漂移场合：判据层判定为拒（干跑不能例外）', dry.clean ? '放行了' : `reason=${dry.reason} nowAt=${dry.nowAt}`)

  // ② 生产者层：真的跑一次 applyEditToProvider，dryRun 与真写走同一条闸门
  const { applyEditToProvider } = await import('./write-path.mjs')
  const files = new Map([[JS, current]])
  const provider = {
    stat: async (p) => (files.has(p) ? { type: 'file', version: 'v1', size: files.get(p).length } : undefined),
    readText: async (p) => files.get(p),
    readByteRange: async (p, range) => new TextEncoder().encode(files.get(p)).subarray(range.offset, range.offset + range.length),
    writeText: async (p, text) => {
      files.set(p, text)
      return { version: 'v2' }
    },
  }
  // 先建立观测（与真实流程一致：编辑前先读过）
  const { rememberRead, contentToken } = await import('./read-core.mjs')
  rememberRead(JS, contentToken(observed, false), observed, false)

  let dryVerdict = 'ok'
  let dryMessage = ''
  try {
    await applyEditToProvider(provider, { displayPath: JS, hunks: [hunk], dryRun: true })
  } catch (error) {
    dryVerdict = typeof error?.code === 'string' ? error.code : 'no-code'
    // 取 `message` 而不是整个 error：属性直接挂在错误对象上，插值会把一整块 JSON 打进输出。
    dryMessage = String(error?.message ?? error).slice(0, 120)
  }
  check(dryVerdict === 'PATCH_STALE_REGION', `⑪ dryRun 在漂移时也拒（实测 ${dryVerdict}）`, dryMessage)
  check(files.get(JS) === current, '⑪ 被拒时 dryRun 当然也没写盘')

  // ③ 对照：闸门过的场合，预演仍然直接通过（不能修成“预演一律失败”）。
  //
  // 注意先**重新观测**：上面的观测是 5 行那一版，拿它对当前 3 行内容做比对，闸门照拒
  // （这是它的本分——“你说的那一行已经不是我给你的那一版了”）。我第一版漏了这一步，
  // 于是对照格红得毫无道理。重新观测 = 把基线换成“模型现在看到的就是这份内容”。
  rememberRead(JS, contentToken(current, false), current, false)
  const cleanDry = await applyEditToProvider(provider, { displayPath: JS, hunks: [{ lines: [3, 3], replace: 'FIVE' }], dryRun: true })
  check(cleanDry.dryRun === true && files.get(JS) === current, '⑪ 闸门过的场合预演仍照常通过且不落盘')
}

say('')
const passed = results.filter((r) => r.ok).length
say(`--- ${passed}/${results.length} 通过 ---`)
for (const r of results.filter((x) => !x.ok)) say(`  FAIL: ${r.label}  ${r.detail}`)
process.exit(passed === results.length ? 0 : 1)
