/**
 * write-gate-cost-test —— C18：写侧闸门的**基准**（判什么）与**成本**（要重算什么）。
 *
 * 命题（施工单终态）：`regionGate` 不该为了回答"被寻址区域在这次观测之后有没有被改过"
 * 而把**整份观测内容**逐 hunk 重新 `planHunks` 一遍。大文件档一次两行改动的端到端耗时里，
 * 闸门那一格要从 45% 降到个位数百分比，而**陈旧检测一格都不能漏**。
 *
 * 四段判据（互不替代，缺一段就能被"退化成不判"或"退化成全局版本守"骗过）：
 *   A 成本：1001 / 10001 / 90001 行，一次两行改动的写侧端到端（读 → BOM+stat → planHunks →
 *     regionGate → 落盘 → 回读校验 → 记账）逐段计时；判据 = 最大档的**闸门 p50 占端到端 p50 < 10%**。
 *     配一条防伪：被计入的那些轮次，闸门的 `basis` 必须都是 `observation`——否则量到的是
 *     "账本为空"的捷径（0.002ms），占比自然会很低，而那不是这段要证明的事。
 *   B 陈旧零漏判：三种陈旧（第三方改被寻址行 / 上方插行 / 整份替换）都必须被
 *     `PATCH_STALE_REGION` 拒绝，且**磁盘逐字节不变**（拒绝不是"回滚"，是压根没写）。
 *   C 反向：变化在别处（改第 1 行 / 只在尾部追加）必须照常成功——区域级闸门不许退化成全局版本守。
 *   D 负向不变量：(地址形态 × 变更) 矩阵逐格把 `regionGate` 的判决与**改前那套判据**
 *     （`staleConflicts`，即 regionGate 的判据核心）对照，并另配一张独立的"该拒/该放"期望表。
 *     矩阵里必须**同时**存在被拒与放行的格子——否则"一律放行"也能过。
 *
 * 量具立场：本文件不改引擎、不写仓库（语料在系统临时目录）；计时用 `performance.now()`，
 * 编排顺序照 `applyEditToProvider`（照抄 `perf-recheck.mjs` 的 P4 那条链，好与 45% 那个基线读数对齐）。
 *
 * 用法：node src/locator-lab/write-gate-cost-test.mjs [--reps=7] [--rows=1001,10001,90001]
 * 退出码：全部判据通过 0，任一失败 1。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { BYTE_ORDER_MARK, contentToken, rememberRead, setObservationStore } from './read-core.mjs'
import {
  applyEditToProvider,
  carryingByteOrderMarks,
  fileByteOrderMarkCount,
  planHunks,
  providerView,
  regionGate,
  staleConflicts,
  verifyWriteBack,
} from './write-path.mjs'

const say = (m = '') => fs.writeSync(1, `${m}\n`)
const now = () => performance.now()
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

const argv = process.argv.slice(2)
const argOf = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`))
  return hit === undefined ? d : hit.slice(n.length + 3)
}
const REPS = Math.max(3, Math.round(Number(argOf('reps', '7')) || 7))
const SIZES = String(argOf('rows', '1001,10001,90001')).split(',').map(Number).filter((n) => Number.isFinite(n) && n > 100)

const tmp = path.join(os.tmpdir(), 'c18-gate-cost')
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true })
const p50 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const r2 = (v) => (Math.round(v * 100) / 100).toFixed(2)

/* ── 提供方 mock：与 `mock-ctx.mjs` / `stale-gate-test` 同形（逐字节写 + 版本 CAS）────────────
 *
 * 版本号刻意做成"每次写入都前进"的整数：第三方写入对真提供方会改 ino/size/mtimeNs/ctimeNs，
 * 因此**一定**换版本——这正是"写侧 CAS 帮不上忙"的前提（CAS 在单次调用内部取 stat）。
 */
const versions = new Map()
const versionOf = (p) => `v${versions.get(p) ?? 0}`
const bump = (p) => versions.set(p, (versions.get(p) ?? 0) + 1)
/**
 * 两种调用形状都要认：`applyEditToProvider` 传的是**路径字符串**（它在编排层），
 * 而 `fileByteOrderMarkCount` / `verifyWriteBack` 传的是 **target 对象**（它们只做单个操作）。
 * 真提供方（DSH 壳的 `dsh-fs-local`）两种都接，mock 必须同形，否则量到的是 mock 的脾气。
 */
const keyOf = (t) => (typeof t === 'string' ? t : t.targetKey)
const provider = {
  resolve: async (p) => ({ displayPath: p, targetKey: p }),
  stat: async (t) => (fs.existsSync(keyOf(t)) ? { version: versionOf(keyOf(t)), type: 'file', size: fs.statSync(keyOf(t)).size } : undefined),
  readText: async (t) => {
    if (!fs.existsSync(keyOf(t))) throw Object.assign(new Error('not found'), { code: 'FS_NOT_FOUND' })
    return dec.decode(fs.readFileSync(keyOf(t)))
  },
  readByteRange: async (t, range) => fs.readFileSync(keyOf(t)).subarray(range.offset, range.offset + range.length),
  writeText: async (t, content, expected) => {
    const p = keyOf(t)
    const existed = fs.existsSync(p)
    if (expected?.kind === 'replaceIfVersion') {
      if (!existed) throw Object.assign(new Error('file no longer exists'), { code: 'FS_STALE_VERSION' })
      if (versionOf(p) !== expected.version) throw Object.assign(new Error('file changed since it was read'), { code: 'FS_STALE_VERSION' })
    } else if (expected?.kind === 'createIfAbsent' && existed) {
      throw Object.assign(new Error('cannot overwrite existing file'), { code: 'FS_NOT_OBSERVED' })
    }
    fs.writeFileSync(p, Buffer.from(enc.encode(content)))
    bump(p)
    return { version: versionOf(p), operation: existed ? 'update' : 'create', after: content }
  },
  editText: async () => {
    throw new Error('editText must not be used by the write path')
  },
}
const target = (file) => ({ displayPath: file, targetKey: file })
const putFile = (file, text) => {
  fs.writeFileSync(file, Buffer.from(enc.encode(text)))
  bump(file)
}
/** 第三方写入：内容变了、版本也前进。 */
const thirdParty = putFile

/** 读一次并记账 —— 与 `readWith` 的 render 同一步（`rememberRead(path, contentToken(view, bom), view, bom)`）。 */
async function observe(file) {
  const bom = (await fileByteOrderMarkCount(provider, target(file), undefined)) > 0
  const text = await provider.readText(target(file))
  rememberRead(file, contentToken(text, bom), text, bom)
  return { text, bom }
}
/** 走真写路径（`applyEditToProvider`）：返回判决而不是抛出。 */
async function attempt(file, hunks) {
  try {
    return { ok: true, out: await applyEditToProvider(provider, { displayPath: file, hunks }) }
  } catch (error) {
    return { ok: false, error }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
say('=== A. 成本：一次两行改动的写侧端到端（读 → BOM+stat → planHunks → regionGate → 落盘 → 回读校验 → 记账）===')
say('    （计时口径与 probes/perf-recheck.mjs 的 P4 同一条链；改前读数：90001 行档 闸门 46.98ms / 端到端 105.01ms = 45%）')
say('')

/** 与真实语料同形：每行唯一，便于 `old` 唯一定位；总字符数 ~5.3M（90001 行档）。 */
const corpus = (rows) =>
  Array.from({ length: rows }, (_, i) => `  const row${String(i + 1).padStart(6, '0')} = ${i + 1} // corpus line ${i + 1} of ${rows}`).join('\n') + '\n'

const costRows = []
for (const rows of SIZES) {
  const dir = path.join(tmp, `cost-${rows}`)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'corpus.mjs')
  putFile(file, corpus(rows))
  fs.readFileSync(file) // 预热文件系统缓存：真调用里"刚被读过"是常态
  setObservationStore(null) // 每个档位都从空账本起步，与基线探针同一条件

  const first = Math.max(2, Math.floor(rows * 0.4))
  const second = Math.min(rows - 1, Math.floor(rows * 0.6))
  const stage = { read: [], bom: [], plan: [], gate: [], disk: [], verify: [], ledger: [], e2e: [], basis: [] }

  for (let round = 0; round <= REPS; round += 1) {
    const t0 = now()
    const a1 = now()
    const content = await provider.readText(target(file))
    stage.read.push(now() - a1)

    const a2 = now()
    const boms = await fileByteOrderMarkCount(provider, target(file), undefined)
    const info = await provider.stat(target(file))
    stage.bom.push(now() - a2)

    const body = content.split(/\r?\n/)
    const hunks = [
      { old: body[first - 1], replace: `  const a${round} = ${round} // hunk one` },
      { lines: [second, second], replace: `  const b${round} = ${round} // hunk two` },
    ]

    const a3 = now()
    const planned = planHunks(content, hunks, file)
    stage.plan.push(now() - a3)

    const a4 = now()
    const gate = regionGate(hunks, content, planned, file, { byteOrderMark: boms > 0 })
    stage.gate.push(now() - a4)
    if (gate.clean !== true) throw new Error(`gate refused: ${gate.message}`)

    const next = carryingByteOrderMarks(planned.content, boms)
    const a5 = now()
    await provider.writeText(target(file), next, { kind: 'replaceIfVersion', version: info.version })
    stage.disk.push(now() - a5)

    const a6 = now()
    await verifyWriteBack(provider, target(file), next, file)
    stage.verify.push(now() - a6)

    const a7 = now()
    const view = providerView(next)
    const bomAfter = next.startsWith(BYTE_ORDER_MARK)
    rememberRead(file, contentToken(view, bomAfter), view, bomAfter)
    stage.ledger.push(now() - a7)

    stage.e2e.push(now() - t0)
    // 第 0 轮是热身：账本还空着，闸门走 `basis: none` 的捷径（不比对），不计入。
    if (round > 0) stage.basis.push(gate.basis)
  }

  const take = (k) => p50(stage[k].slice(1))
  const row = {
    rows,
    read: take('read'),
    bom: take('bom'),
    plan: take('plan'),
    gate: take('gate'),
    disk: take('disk'),
    verify: take('verify'),
    ledger: take('ledger'),
    e2e: take('e2e'),
    bases: stage.basis,
    rawGate: stage.gate.slice(1).map(r2),
    rawE2e: stage.e2e.slice(1).map(r2),
  }
  row.share = (row.gate / row.e2e) * 100
  costRows.push(row)
  say(
    `  ${String(rows).padStart(6)} 行  ` +
      `读 ${r2(row.read).padStart(6)}  BOM+stat ${r2(row.bom).padStart(5)}  planHunks ${r2(row.plan).padStart(6)}  ` +
      `闸门 ${r2(row.gate).padStart(6)}  落盘 ${r2(row.disk).padStart(5)}  回读 ${r2(row.verify).padStart(6)}  ` +
      `记账 ${r2(row.ledger).padStart(5)}  端到端 ${r2(row.e2e).padStart(6)}  闸门占比 ${row.share.toFixed(2)}%`,
  )
  // 计时环不是空转的旁证：两行都真的被改写，行数一行不多一行不少。
  const after = fs.readFileSync(file).toString('utf8').split(/\r?\n/)
  row.landed =
    after[first - 1].includes(`a${REPS} =`) && after[second - 1].includes(`b${REPS} =`) && after.length === rows + 1
}
say('')
for (const row of costRows) {
  say(`  原始读数 ${row.rows} 行（n=${row.rawE2e.length}，已扣热身轮）：闸门 p50=${r2(row.gate)}ms 端到端 p50=${r2(row.e2e)}ms`)
  say(`    gate 逐轮 ms = [${row.rawGate.join(', ')}]`)
  say(`    e2e  逐轮 ms = [${row.rawE2e.join(', ')}]`)
}
const biggest = costRows[costRows.length - 1]
say('')
check(
  biggest.bases.length > 0 && biggest.bases.every((b) => b === 'observation'),
  `A 被计时的每一轮闸门都真的持有基准（basis=observation）——占比不是"账本为空"的捷径量出来的`,
  `basis=${JSON.stringify([...new Set(biggest.bases)])} n=${biggest.bases.length}`,
)
check(
  biggest.share < 10,
  `A ${biggest.rows} 行档：闸门耗时占端到端 < 10%`,
  `${r2(biggest.gate)}ms / ${r2(biggest.e2e)}ms = ${biggest.share.toFixed(2)}%（改前 46.98/105.01 = 45%）`,
)
check(
  costRows.every((row) => row.landed),
  'A 计时环不是空转的：每个档位的两行都真的被改写，且行数一行不多一行不少',
  costRows.map((row) => `${row.rows}:${row.landed ? 'ok' : 'MISS'}`).join(' '),
)
check(
  biggest.gate < biggest.plan,
  `A ${biggest.rows} 行档：闸门比一次 planHunks 还便宜（不再"逐 hunk 重规划整份观测"）`,
  `闸门 ${r2(biggest.gate)}ms vs planHunks ${r2(biggest.plan)}ms`,
)

// ══════════════════════════════════════════════════════════════════════════════
say('')
say('=== B. 陈旧零漏判：三种陈旧各自被拒 + 磁盘逐字节不变 ===')

const B_ROWS = 400
const B_TARGET = 200
const bCorpus = (marker = 'v1') =>
  Array.from({ length: B_ROWS }, (_, i) =>
    i + 1 === B_TARGET ? `line ${i + 1} the addressed one [${marker}]` : `line ${i + 1} filler [${marker}]`,
  ).join('\n') + '\n'

/** 一轮陈旧场景：读 → 第三方改 → 无 expect 的 lines= 编辑 ⇒ 必须被拒，且磁盘一字不落。 */
async function staleCase(name, mutate) {
  const file = path.join(tmp, `stale-${name}.md`)
  putFile(file, bCorpus())
  await observe(file)
  thirdParty(file, mutate(bCorpus()))
  const before = fs.readFileSync(file)
  const r = await attempt(file, [{ lines: [B_TARGET, B_TARGET], replace: 'line 200 OVERWRITTEN BY US' }])
  const after = fs.readFileSync(file)
  check(!r.ok && r.error.code === 'PATCH_STALE_REGION', `B ${name}：被结构化拒绝（PATCH_STALE_REGION）`, `${r.error?.code ?? 'ok — 静默放行'}`)
  check(before.equals(after), `B ${name}：磁盘逐字节不变（${before.length} 字节）`, `${after.length} 字节`)
  say(`    · 拒绝原话：${String(r.error?.message ?? '').slice(0, 150)}`)
}
await staleCase('change-addressed-line', (rows) => rows.replace(`line ${B_TARGET} the addressed one [v1]`, `line ${B_TARGET} CHANGED BY B`))
await staleCase('insert-above', (rows) => `inserted by B\ninserted by B\n${rows}`)
await staleCase('whole-file-replaced', () => Array.from({ length: B_ROWS }, (_, i) => `regenerated by B — row ${i + 1}`).join('\n') + '\n')

// ══════════════════════════════════════════════════════════════════════════════
say('')
say('=== C. 反向：变化在别处 / 只追加尾部 ⇒ 仍必须成功（不许退化成全局版本守）===')

async function elsewhereCase(name, mutate, expectLine) {
  const file = path.join(tmp, `elsewhere-${name}.md`)
  putFile(file, bCorpus())
  await observe(file)
  thirdParty(file, mutate(bCorpus()))
  const r = await attempt(file, [{ lines: [B_TARGET, B_TARGET], replace: 'line 200 EDITED BY US' }])
  check(r.ok === true, `C ${name}：编辑照常成功`, r.ok ? '' : `${r.error?.code} ${String(r.error?.message).slice(0, 120)}`)
  const after = fs.readFileSync(file).toString('utf8')
  check(after.includes('line 200 EDITED BY US'), `C ${name}：我们的改动确实落盘`, '')
  check(after.includes(expectLine), `C ${name}：第三方的改动被保留（没有被回滚或覆盖）`, JSON.stringify(expectLine))
}
await elsewhereCase('change-line-1', (rows) => rows.replace('line 1 filler [v1]', 'line 1 TOUCHED BY B'), 'line 1 TOUCHED BY B')
await elsewhereCase('append-tail', (rows) => `${rows}appended by B\n`, 'appended by B')
await elsewhereCase('change-below', (rows) => rows.replace(`line ${B_ROWS} filler [v1]`, `line ${B_ROWS} TOUCHED BY B`), `line ${B_ROWS} TOUCHED BY B`)

// ══════════════════════════════════════════════════════════════════════════════
say('')
say('=== E. 回执诚实性：basis 三态不许因为"快"而说错 ===')
/**
 * 快路上不再算 `contentToken`（令牌后半是长度，长度对得上 ⇒ 与账本里那条逐字符同一份），
 * 这条推导最容易错在 **BOM 约定**上：错一个字节，"核对过"就会被报成"没核对过"（反向的谎一样坏）。
 * 所以把三种基准场景各自钉一条：带 BOM 的已知版本 / 从未观测 / 观测过但内容已被换掉。
 */
{
  const file = path.join(tmp, 'basis-bom.mjs')
  putFile(file, `${BYTE_ORDER_MARK}  const a = 1\n  const b = 2\n  const c = 3\n`)
  await observe(file)
  const r = await attempt(file, [{ lines: [2, 2], replace: '  const b = 22' }])
  check(r.ok === true, 'E1 带 BOM 的文件：读后无 expect 编辑成功', r.ok ? '' : `${r.error?.code}`)
  check(
    r.ok && r.out.unverified_region === undefined,
    'E1 带 BOM + 逐字符同一份 ⇒ basis 判成 observation（不冒充"没核对过"）',
    `unverified_region=${JSON.stringify(r.out?.unverified_region)}`,
  )
  check(fs.readFileSync(file).toString('utf8').includes('  const b = 22'), 'E1 改动确实落盘', '')
}
{
  const file = path.join(tmp, 'basis-unobserved.mjs')
  putFile(file, '  const a = 1\n  const b = 2\n  const c = 3\n')
  const r = await attempt(file, [{ lines: [2, 2], replace: '  const b = 22' }])
  check(r.ok === true, 'E2 从未观测过 ⇒ 不拦', r.ok ? '' : `${r.error?.code}`)
  check(r.ok && r.out.unverified_region === true, 'E2 从未观测过 ⇒ 回执带 unverified_region（不冒充新鲜）', `${JSON.stringify(r.out?.unverified_region)}`)
}
{
  const file = path.join(tmp, 'basis-unknown-revision.mjs')
  putFile(file, '  const a = 1\n  const b = 2\n  const c = 3\n')
  await observe(file)
  thirdParty(file, '  const a = 1\n  const b = 2\n  const c = 3\n  const appended = 4\n')
  const r = await attempt(file, [{ lines: [2, 2], replace: '  const b = 22' }])
  check(r.ok === true, 'E3 观测后第三方只在尾部追加 ⇒ 区域未变，仍放行', r.ok ? '' : `${r.error?.code}`)
  check(
    r.ok && r.out.unverified_region === true,
    'E3 但这份内容不是账本里那一版 ⇒ 回执带 unverified_region（"没核对过"与"核对过"是两句话）',
    `${JSON.stringify(r.out?.unverified_region)}`,
  )
}

// ══════════════════════════════════════════════════════════════════════════════
say('')
say('=== D. 负向不变量：闸门不得因为"快"而漏掉任何一种陈旧 ===')
say('    （矩阵逐格：regionGate 的判决 vs 改前那套判据 staleConflicts；另配一张"该拒/该放"期望表）')

const D_ROWS = 60
const D_TARGET = 30
const dLine = (i) => `  const d${String(i).padStart(3, '0')} = ${i} // matrix row ${i}`
const dCorpus = () => Array.from({ length: D_ROWS }, (_, i) => dLine(i + 1)).join('\n') + '\n'

const hunkFor = (hunk) => ({ ...hunk, replace: '  const dXXX = 0 // rewritten by the test' })
/** 地址形态：`lines=` / `old=` / `anchor=` 三层（第三层是内容寻址，位移该被它吸收）。 */
const TAIL_ONLY = '尾部追加（并寻址新追加的那一行）'
const FORMS = [
  { label: 'lines=', hunk: (rows) => ({ lines: [D_TARGET, D_TARGET] }) },
  { label: 'old=', hunk: (rows) => ({ old: rows[D_TARGET - 1] }) },
  { label: 'anchor=', hunk: (rows) => ({ anchor: rows[D_TARGET - 1] }) },
  // 只对"尾部追加"有意义：寻址一行**观测那一版里还不存在**的行 ⇒ 闸门必须报 absent-in-observation。
  { label: 'lines= (只在当前这一版存在的行)', onlyMutation: TAIL_ONLY, fromCurrent: true, expect: 'refuse', hunk: (rows) => ({ lines: [rows.length - 1, rows.length - 1] }) },
]
/**
 * 变更表。`expect` 三态：
 *   'refuse' —— 必须被拒（判据表，独立于实现）；
 *   'accept' —— 必须放行；
 *   'reference' —— 方向不表态（这类变更的"该不该拒"不是本单能定的），只要求与改前那套判据**一致**。
 */
const MUTATIONS = [
  { label: '未变（逐字节相同）', mutate: (rows) => rows, expect: 'accept' },
  // 实质改写被寻址行：不是"尾部多一个字符"（那样 `old` 仍是它的子串，片段层会命中它自己），
  // 而是把行中间那段换掉——引文不再出现在文件里任何地方。
  { label: '实质改写被寻址行', mutate: (rows) => rows.replace(dLine(D_TARGET), dLine(D_TARGET).replace('= 30', '= 99999')), expect: 'refuse' },
  { label: '上方插两行', mutate: (rows) => `  // inserted by B\n  // inserted by B\n${rows}`, expect: 'reference' },
  { label: '删掉被寻址行', mutate: (rows) => rows.split('\n').filter((_, i) => i !== D_TARGET - 1).join('\n'), expect: 'refuse' },
  { label: '改远处一行（第 2 行）', mutate: (rows) => rows.replace(dLine(2), `${dLine(2)}X`), expect: 'accept' },
  { label: '尾部追加三行', mutate: (rows) => `${rows}tail one\ntail two\ntail three\n`, expect: 'accept' },
  { label: '整份重写（同形状，内容全换）', mutate: () => Array.from({ length: D_ROWS }, (_, i) => `  // regenerated by B row ${i + 1}`).join('\n') + '\n', expect: 'refuse' },
  { label: '被寻址文本挪到尾部（原处删除）', mutate: (rows) => `${rows.split('\n').filter((_, i) => i !== D_TARGET - 1).join('\n')}\n${dLine(D_TARGET)}\n`, expect: 'reference' },
  { label: '截断到被寻址行之前', mutate: (rows) => rows.split('\n').slice(0, D_TARGET - 1).join('\n') + '\n', expect: 'refuse' },
  { label: '整份换成 CRLF（行内容不变）', mutate: (rows) => rows.replace(/\n/g, '\r\n'), expect: 'reference' },
  { label: TAIL_ONLY, mutate: (rows) => `${rows}tail one\ntail two\ntail three\n`, expect: 'accept' },
]

let cells = 0
let refused = 0
let accepted = 0
let referenceAgree = 0
const diverged = []
const misExpected = []
for (const mutation of MUTATIONS) {
  for (const form of FORMS) {
    // 「只在当前这一版存在的行」这条地址形态只对"尾部追加"有意义，其余变更跳过。
    if (form.onlyMutation !== undefined && form.onlyMutation !== mutation.label) continue
    const file = path.join(tmp, `matrix-${cells}.mjs`)
    const observed = dCorpus()
    putFile(file, observed)
    setObservationStore(null)
    rememberRead(file, contentToken(observed, false), observed, false)
    const current = mutation.mutate(observed)
    thirdParty(file, current)

    /**
     * 地址一律取自**观测那一版**：调用方手里只有他读到的那份视图——`lines=` 是抄下来的绝对坐标，
     * `old=` / `anchor=` 是抄下来的原文。拿改后的内容生成地址，等于把"位移"这件事从题面里删掉。
     * 只有那个刻意寻址"新版才有的一行"的形态用当前内容。
     */
    const addrRows = form.fromCurrent === true ? current.split(/\r?\n/) : observed.split(/\r?\n/)
    const hunks = [hunkFor(form.hunk(addrRows))]
    let planned = null
    let plannedError = null
    try {
      planned = planHunks(current, hunks, file)
    } catch (error) {
      plannedError = error
    }
    let verdict
    let referenceClean
    if (planned === null) {
      verdict = 'plan-refused'
      referenceClean = null // 规划阶段就被拒（定位器/结构层），闸门根本没被问到
    } else {
      const gate = regionGate(hunks, current, planned, file, { byteOrderMark: false })
      verdict = gate.clean ? 'clean' : 'refused'
      referenceClean =
        staleConflicts(observed, current, hunks, planned.matches, file, { contentPath: file }).length === 0
    }
    const isRefused = verdict !== 'clean'
    cells += 1
    if (isRefused) refused += 1
    else accepted += 1
    if (referenceClean === null ? verdict === 'plan-refused' : referenceClean === (verdict === 'clean')) referenceAgree += 1
    else diverged.push(`${form.label} × ${mutation.label}`)

    // 期望的优先序：形态自己的（"只在当前这一版存在的行"那一条）> 变更的。
    const declared = form.expect ?? mutation.expect
    const expected = declared === 'accept' ? false : declared === 'refuse' ? true : null
    if (expected !== null && expected !== isRefused) misExpected.push(`${form.label} × ${mutation.label}：期望${expected ? '拒' : '放'}，实得 ${verdict}`)
    const tag =
      verdict === 'clean' ? '放行' : verdict === 'refused' ? '闸门拒' : `规划期拒（${plannedError?.code ?? '?'}）`
    say(`    ${mutation.label.padEnd(30)} ${form.label.padEnd(28)} ⇒ ${tag}${referenceClean === null ? '' : `（参考判据 ${referenceClean ? '放行' : '拒'}）`}`)
  }
}
say('')
check(cells >= 30, `D 矩阵覆盖 ${cells} 格（地址形态 × 变更）`, '')
check(diverged.length === 0, 'D 每一格：regionGate 与改前那套判据（staleConflicts）判决一致', diverged.slice(0, 4).join(' | '))
check(misExpected.length === 0, 'D 每一格：判决与"该拒/该放"期望表一致', misExpected.slice(0, 4).join(' | '))
check(refused >= 10 && accepted >= 5, 'D 矩阵里同时存在被拒与放行的格子（不是"一律放行"或"一律拒绝"）', `拒 ${refused} / 放 ${accepted}`)

// ══════════════════════════════════════════════════════════════════════════════
say('')
const passed = results.filter((r) => r.ok).length
say(`--- ${passed}/${results.length} 通过 ---`)
for (const r of results.filter((x) => !x.ok)) say(`  FAIL: ${r.label}  ${r.detail}`)
process.exit(passed === results.length ? 0 : 1)
