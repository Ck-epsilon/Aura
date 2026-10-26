/**
 * multi-edit-test.mjs —— 写侧**多目标**（一次调用改多个文件）的判据（fs-contract-v2 / MT3）。
 *
 * 它盯的不是"多目标能不能改文件"，而是契约 §3 那四条纪律：
 *   ① **三阶段**：全部规划成功才写 ⇒ 任一目标规划失败时**零写入**（前后 sha256 相同）；
 *   ② **同文件单写者**（§1.6）：一个调用里两项指同一文件 ⇒ 合并成**一次**提交（`writeText` 计数=1），
 *      两项的改动都在，且逐项回执各自对上自己那些 hunk；
 *   ③ **顺序 = 输入顺序**（§1.4）：完成顺序（由假 provider 的可控延迟摆出来）不许泄漏进回执；
 *   ④ **N===1 直调**（§4）：provider 调用序列与"直接调单目标入口"逐条相同 —— 这条是单目标零回归的
 *      **结构性**保证（红线套件 `single-target-nonregression-test.mjs` 从外面钉字节，这里从里面钉调用）。
 *
 * 另外三条只在这里能钉住的：
 *   · 逐项回执与"分别单独调一次单目标"**逐字节相同**（同一套渲染，没有第二套拼装）；
 *   · 跨文件提交**真的并发**（判据是"最大同时在飞数 > 1"，不是墙钟阈值）；
 *   · 一次调用**多条 hunk** 的逐条回执（段I）：`applied[k]` 只描述**输入的第 k 条** hunk，
 *     数组顺序 = 输入顺序 —— 多目标逐项切分（`splitReceiptForMember`）读的就是这个顺序。
 *
 * 落盘一律走**真** provider（`aura-standalone/lib/fs-provider.mjs`，与红线套件同一个）；
 * 需要观测/注入时只在外面包一层计数壳或延迟壳，不改判据本身。
 *
 * 跑法：`node src/locator-lab/multi-edit-test.mjs`（末行 `--- N/N 通过 ---`）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { applyEditToProvider, applyEditsToProvider, MT_POOL, MT_MAX_TARGETS, planHunks } = await import('./write-path.mjs')

/**
 * 0.8.1：回执里的新句柄带**文件身份标签**（`h<id><fingerprint>:a-b`）。多目标与单目标用例
 * 各自用不同的 `identityKey` 隔离账本，于是身份标签不同——这不是渲染分叉。
 * 比对逐字节回执时只归一这 4 位身份标签，指纹与行号仍逐字比。
 */
const normalizeHandleIdentity = (text) => text.replace(/h[0-9a-f]{4}[0-9a-f]{8}:/g, 'h<id>:')
const { createNodeFsProvider } = await import('../aura-standalone/lib/fs-provider.mjs')

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
  return ok
}

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-multi-edit-'))
const dirOf = (name) => {
  const dir = path.join(tempHome, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8')

/** 一份够用的语料：两个可被符号寻址的常量 + 一个函数。 */
const sourceOf = (name) =>
  [
    `/** ${name} 夹具 */`,
    `export const VERSION = '${name}-0.0.1'`,
    `export const TAG = '${name}-tag'`,
    `export function ${name}Root(value) {`,
    `  return value % 7`,
    `}`,
    `// ${name} 尾巴`,
    '',
  ].join('\n')
const plant = (dir, name) => {
  fs.writeFileSync(path.join(dir, name), sourceOf(name))
  return path.join(dir, name)
}
const versionHunk = (name) => ({ target: 'VERSION', replace: `export const VERSION = '${name}-edited'` })
const tagHunk = (name) => ({ target: 'TAG', replace: `export const TAG = '${name}-edited-tag'` })

// ── 观测壳：计数 / 可控延迟 / 指定目标写失败 ────────────────────────────────
const COUNTED_METHODS = ['resolve', 'stat', 'readText', 'readByteRange', 'listDir', 'writeText']

function countingProvider(inner) {
  const calls = []
  const out = {}
  for (const method of COUNTED_METHODS) {
    const fn = inner[method]
    if (typeof fn !== 'function') continue
    out[method] = (...args) => {
      calls.push(`${method}:${args[0]}`)
      return fn.apply(inner, args)
    }
  }
  out.calls = calls
  out.countOf = (method) => calls.filter((line) => line.startsWith(`${method}:`)).length
  return out
}

/**
 * 可控延迟：`ticks` 是"让出事件循环几次"（0 次 = 同步进、下一轮出），不是毫秒 ——
 * 判据因此与墙钟无关。同时记**最大同时在飞数**（并发是结构性的，不是"看起来快"）。
 */
function slowProvider(inner, ticks = {}) {
  const out = {}
  for (const method of COUNTED_METHODS) {
    const fn = inner[method]
    if (typeof fn !== 'function') continue
    out[method] = (...args) => fn.apply(inner, args)
  }
  const state = { inflight: 0, maxInflight: 0, finishOrder: [] }
  out.writeText = async (target, content, expected, signal) => {
    state.inflight += 1
    state.maxInflight = Math.max(state.maxInflight, state.inflight)
    const wait = ticks[target] ?? 0
    for (let i = 0; i < wait; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
    state.inflight -= 1
    state.finishOrder.push(target)
    return inner.writeText(target, content, expected, signal)
  }
  out.state = state
  return out
}

/** 指定目标的 `writeText` 直接失败（模拟阶段二的 I/O 失败：CAS 撞车 / 权限）。 */
function failingWriteProvider(inner, targets, code = 'FS_WRITE_DENIED') {
  const out = {}
  for (const method of COUNTED_METHODS) {
    const fn = inner[method]
    if (typeof fn !== 'function') continue
    out[method] = (...args) => fn.apply(inner, args)
  }
  out.writeText = async (target, content, expected, signal) => {
    if (targets.includes(target)) throw Object.assign(new Error(`write refused for ${target}`), { code })
    return inner.writeText(target, content, expected, signal)
  }
  return out
}

const requestOf = (targets, extra = {}) => ({ targets, ...extra })

// ── A 三个文件各一处编辑：全部真落盘 + 逐项回执与单目标逐字节相同 ─────────
async function caseThreeFiles() {
  const names = ['a.mjs', 'b.mjs', 'c.mjs']
  const multiDir = dirOf('three-multi')
  for (const name of names) plant(multiDir, name)
  const multi = await applyEditsToProvider(countingProvider(createNodeFsProvider({ resolveRoot: multiDir })), {
    targets: names.map((name, index) => ({ file_path: name, hunks: [versionHunk(name)], identityKey: `multi-${name}-${index}` })),
  })
  check(multi.targets === 3, 'A1 三项都收下（targets=3）', `targets=${multi.targets}`)
  check(multi.applied === 3 && multi.unchanged === false, 'A2 三项都落地（applied=3）', multi.summary)
  check(
    multi.summary.startsWith('targets: 3 ｜ applied 3'),
    'A3 汇总行是"逐项计数"那一行',
    multi.summary,
  )
  const onDisk = names.map((name) => read(multiDir, name).includes(`${name}-edited`))
  check(onDisk.every(Boolean), 'A4 三个文件都真的落了盘', onDisk.join(','))
  check(
    multi.landed_paths.length === 3 && multi.edits.every((edit) => edit.landed === true),
    'A5 逐项 landed 与 landed_paths 一致',
    multi.landed_paths.join(','),
  )

  // 逐字节比对：每条逐项回执 vs 单独调一次单目标（同一份语料、各自一棵新树）。
  // 身份键只影响账本记账、不进回执；两路各给一个**全新**身份键，是为了让两边都处在
  // "账本里没有这次之前那份内容"的同一个状态上（否则陈旧基准的差异会污染这次比对）。
  const singles = []
  for (const [index, name] of names.entries()) {
    const singleDir = dirOf(`three-single-${index}`)
    plant(singleDir, name)
    singles.push(
      await applyEditToProvider(createNodeFsProvider({ resolveRoot: singleDir }), {
        displayPath: name,
        hunks: [versionHunk(name)],
        identityKey: `single-${name}-${index}`,
      }),
    )
  }
  const same = multi.edits.every((edit, index) => normalizeHandleIdentity(JSON.stringify(edit.receipt)) === normalizeHandleIdentity(JSON.stringify(singles[index])))
  check(same, 'A6 逐项回执与"单独调一次单目标"逐字节相同', same ? '3/3 相同' : '有分叉')
  check(
    multi.edits.every((edit, index) => edit.receipt?.write_verify?.level === 'bytes' && edit.index === index),
    'A7 逐项回执走的是同一条回读校验路径（level=bytes），且 index = 输入下标',
    JSON.stringify(multi.edits.map((edit) => edit.receipt?.write_verify)),
  )
}

// ── B 顺序 = 输入顺序（完成顺序被摆成另一种），且跨文件提交真的并发 ─────────
async function caseOrderAndConcurrency() {
  const names = ['first.mjs', 'second.mjs', 'third.mjs']
  const dir = dirOf('order')
  for (const name of names) plant(dir, name)
  // 完成顺序 third → second → first（输入顺序是 first → second → third）。
  const provider = slowProvider(createNodeFsProvider({ resolveRoot: dir }), {
    'first.mjs': 3,
    'second.mjs': 2,
    'third.mjs': 1,
  })
  const multi = await applyEditsToProvider(provider, {
    targets: names.map((name, index) => ({ file_path: name, hunks: [versionHunk(name)], identityKey: `order-${index}` })),
  })
  const inputOrder = multi.edits.map((edit) => edit.file_path).join(',')
  check(inputOrder === names.join(','), 'B1 逐项顺序 = 输入顺序（不是完成顺序）', inputOrder)
  check(
    provider.state.finishOrder.join(',') !== names.join(','),
    'B2 完成顺序确实与输入顺序不同（否则 B1 证明不了什么）',
    provider.state.finishOrder.join(','),
  )
  check(
    multi.edits[0].receipt?.applied?.[0]?.replaced.includes('first.mjs-edited') === true &&
      multi.edits[2].receipt?.applied?.[0]?.replaced.includes('third.mjs-edited') === true,
    'B3 每一项的改动装在它自己那一项里（没有串台）',
    multi.edits.map((edit) => edit.receipt?.applied?.[0]?.replaced?.match(/'([a-z]+)\.mjs-edited'/)?.[1] ?? '?').join(','),
  )
  check(
    provider.state.maxInflight > 1,
    'B4 跨文件提交真的并发（最大同时在飞数 > 1；判据不含墙钟）',
    `maxInflight=${provider.state.maxInflight}／文件数=${names.length}／池=${MT_POOL}`,
  )
  const allEdited = names.every((name) => read(dir, name).includes(`${name}-edited`))
  check(allEdited, 'B5 并发提交之后三个文件都对', String(allEdited))
}

// ── C 一条目标规划失败 ⇒ 零写入 + 回执明说"没有任何文件被改动" ─────────────
async function casePlanFailureIsAllOrNothing() {
  const names = ['keep-a.mjs', 'bad.mjs', 'keep-b.mjs']
  const dir = dirOf('abort')
  const files = names.map((name) => plant(dir, name))
  const before = files.map(sha256)
  const provider = countingProvider(createNodeFsProvider({ resolveRoot: dir }))
  const multi = await applyEditsToProvider(provider, {
    targets: [
      { file_path: 'keep-a.mjs', hunks: [versionHunk('keep-a.mjs')] },
      { file_path: 'bad.mjs', hunks: [{ old: 'this text is definitely not in bad.mjs anywhere', replace: 'x' }] },
      { file_path: 'keep-b.mjs', hunks: [versionHunk('keep-b.mjs')] },
    ],
  })
  const after = files.map(sha256)
  check(multi.applied === 0 && multi.unchanged === true, 'C1 规划失败 ⇒ 落地数 0（结果通道，不抛错）', multi.summary)
  check(
    multi.summary.includes('no files were changed'),
    'C2 汇总行明说"没有任何文件被改动"',
    multi.summary,
  )
  check(provider.countOf('writeText') === 0, 'C3 writeText 一次都没被调用', `writeText=${provider.countOf('writeText')}`)
  check(
    before.every((digest, index) => digest === after[index]),
    'C4 三个文件逐字节没动（前后 sha256 相同）',
    `${before[0].slice(0, 8)}→${after[0].slice(0, 8)} / ${before[1].slice(0, 8)}→${after[1].slice(0, 8)}`,
  )
  const bad = multi.edits[1]
  check(
    bad.outcome === 'failed' && bad.error?.code === 'PATCH_NOT_FOUND' && typeof bad.error.next === 'string' && bad.error.next.length > 10,
    'C5 失败那一项点名"哪一项、什么码、next 怎么走"',
    `${bad.file_path}／${bad.error?.code}／${bad.error?.next?.slice(0, 40)}`,
  )
  check(
    multi.edits[0].outcome === 'not_applied' && multi.edits[0].landed === false && multi.edits[2].outcome === 'not_applied',
    'C6 另外两项如实报成"没写"（不假装成功）',
    `${multi.edits[0].outcome}/${multi.edits[2].outcome}`,
  )
  check(multi.aborted === 'plan', 'C7 回执标明中止发生在阶段一（aborted=plan）', String(multi.aborted))
}

// ── D 同一文件出现两次 ⇒ 只提交一次，两次改动都在 ─────────────────────────
async function caseSameFileMergesToOneCommit() {
  const dir = dirOf('merge')
  plant(dir, 'same.mjs')
  const provider = countingProvider(createNodeFsProvider({ resolveRoot: dir }))
  const multi = await applyEditsToProvider(provider, {
    targets: [
      { file_path: 'same.mjs', hunks: [versionHunk('same.mjs')] },
      { file_path: 'same.mjs', hunks: [tagHunk('same.mjs')] },
    ],
  })
  const text = read(dir, 'same.mjs')
  check(provider.countOf('writeText') === 1, 'D1 同一文件两项 ⇒ 只提交一次（writeText=1）', `writeText=${provider.countOf('writeText')}`)
  check(
    text.includes('same.mjs-edited') && text.includes('same.mjs-edited-tag'),
    'D2 两次改动都在（合并的是 hunks，不是丢掉一项）',
    text.split('\n').slice(1, 3).join(' / '),
  )
  check(
    multi.edits.length === 2 && multi.edits.every((edit) => edit.landed === true),
    'D3 逐项仍是两项、都报 landed',
    `edits=${multi.edits.length}`,
  )
  check(
    multi.edits[0].receipt?.applied?.length === 1 &&
      multi.edits[1].receipt?.applied?.length === 1 &&
      multi.edits[0].receipt?.applied?.[0]?.replaced.includes('VERSION') === true &&
      multi.edits[1].receipt?.applied?.[0]?.replaced.includes('TAG') === true,
    'D4 逐项回执各自只装自己那些 hunk',
    `${multi.edits[0].receipt?.applied?.length}/${multi.edits[1].receipt?.applied?.length}`,
  )
  check(multi.summary.includes('files 1'), 'D5 汇总行点出文件数（1 个文件、2 项）', multi.summary)

  // D6/D7：合并的每一项**各带两条 hunk**（且低位的那个 hunk 会增行）—— 逐项切分必须按 **hunk 下标**
  // 切，不能拿拼接/位置的顺序去猜（`splitReceiptForMember` 读的就是 `applied` 的顺序）。
  const manyDir = dirOf('merge-many-hunks')
  plant(manyDir, 'many.mjs')
  const aspectA = [
    { lines: [2, 2], replace: "export const VERSION = 'many.mjs-A1'\nexport const VERSION_X = 'many.mjs-A2'" },
    { lines: [6, 6], replace: '// many.mjs A-tail' },
  ]
  const aspectB = [
    { lines: [3, 3], replace: "export const TAG = 'many.mjs-B1'" },
    { lines: [7, 7], replace: '// many.mjs B-tail' },
  ]
  const merged = await applyEditsToProvider(createNodeFsProvider({ resolveRoot: manyDir }), {
    targets: [
      { file_path: 'many.mjs', hunks: aspectA },
      { file_path: 'many.mjs', hunks: aspectB },
    ],
  })
  check(
    merged.edits.every((edit) => edit.receipt?.applied?.length === 2),
    'D6 合并的每一项各带两条 hunk ⇒ 逐项回执各自只装自己那两条（不串台、不吞）',
    merged.edits.map((edit) => edit.receipt?.applied?.length).join('/'),
  )
  check(
    merged.edits[0].receipt.applied.map((a) => a.line).join(',') === '2,6' &&
      merged.edits[1].receipt.applied.map((a) => a.line).join(',') === '3,7' &&
      merged.edits[0].receipt.applied[1].replaced === '// many.mjs A-tail' &&
      merged.edits[1].receipt.applied[0].replaced === "export const TAG = 'many.mjs-B1'",
    'D7 每一项内部顺序 = 输入顺序，且 `replaced` 是它自己写下去的那份（增行之后也不例外）',
    merged.edits
      .map((edit) => edit.receipt?.applied?.map((a) => `${a.line}:${JSON.stringify(a.replaced)}`).join(' '))
      .join(' ｜ '),
  )
  const mergedText = read(manyDir, 'many.mjs')
  check(
    mergedText.includes("export const VERSION = 'many.mjs-A1'") &&
      mergedText.includes("export const VERSION_X = 'many.mjs-A2'") &&
      mergedText.includes("export const TAG = 'many.mjs-B1'") &&
      mergedText.includes('// many.mjs A-tail') && mergedText.includes('// many.mjs B-tail'),
    'D8 合并之后四条改动都在盘上',
    mergedText.split('\n').slice(1, 4).join(' / '),
  )
}

// ── E N===1：直调单目标入口（provider 调用序列逐条相同） ───────────────────
async function caseSingleTargetIsDirect() {
  const multiDir = dirOf('n1-multi')
  plant(multiDir, 'one.mjs')
  const multiProvider = countingProvider(createNodeFsProvider({ resolveRoot: multiDir }))
  const multi = await applyEditsToProvider(multiProvider, {
    targets: [{ file_path: 'one.mjs', hunks: [versionHunk('one.mjs')], identityKey: 'n1-multi' }],
  })
  const directDir = dirOf('n1-direct')
  plant(directDir, 'one.mjs')
  const directProvider = countingProvider(createNodeFsProvider({ resolveRoot: directDir }))
  const direct = await applyEditToProvider(directProvider, {
    displayPath: 'one.mjs',
    hunks: [versionHunk('one.mjs')],
    identityKey: 'n1-direct',
  })
  check(multi.targets === 1 && multi.edits.length === 1, 'E1 N=1 也是同一个信封形状（一项）', `targets=${multi.targets}`)
  check(
    multiProvider.calls.join(' | ') === directProvider.calls.join(' | '),
    'E2 provider 调用序列与直调单目标**逐条相同**（N=1 不建池、不加调用）',
    `${multiProvider.calls.length} 次：${multiProvider.calls.join(' → ')}`,
  )
  check(
    normalizeHandleIdentity(JSON.stringify(multi.edits[0].receipt)) === normalizeHandleIdentity(JSON.stringify(direct)),
    'E3 N=1 的逐项回执与直调回执逐字节相同（零包装；句柄身份标签归一）',
    multi.summary,
  )
}

// ── F 参数面：互斥 / 非数组 / 超限 ⇒ 抛错且 message 可读 ───────────────────
async function caseShapeErrors() {
  const dir = dirOf('shape')
  plant(dir, 'shape.mjs')
  const provider = createNodeFsProvider({ resolveRoot: dir })
  const thrown = async (request) => {
    try {
      await applyEditsToProvider(provider, request)
      return null
    } catch (error) {
      return error
    }
  }
  const both = await thrown({ targets: [{ file_path: 'shape.mjs', hunks: [versionHunk('shape.mjs')] }], file_path: 'shape.mjs', hunks: [] })
  check(
    both !== null && both.code === 'ARGS_SHAPE_EXCLUSIVE' && both.message.includes('targets') && both.message.includes('not both'),
    'F1 targets 与 file_path/hunks 同给 ⇒ 抛错，message 说清"二选一"',
    both === null ? '没抛错' : both.message.slice(0, 120),
  )
  const tooMany = await thrown({ targets: Array.from({ length: MT_MAX_TARGETS + 1 }, () => ({ file_path: 'shape.mjs', hunks: [] })) })
  check(
    tooMany !== null && tooMany.code === 'ARGS_TARGETS_LIMIT' && tooMany.message.includes('33') && tooMany.message.includes('32'),
    `F2 超过 MT_MAX_TARGETS=${MT_MAX_TARGETS} ⇒ 抛错并报出实得数`,
    tooMany === null ? '没抛错' : tooMany.message.slice(0, 120),
  )
  const notArray = await thrown({ targets: 'shape.mjs' })
  check(
    notArray !== null && notArray.code === 'ARGS_TARGETS_SHAPE' && notArray.message.includes('targets') && notArray.message.includes('array'),
    'F3 targets 非数组 ⇒ 抛错且 message 可读',
    notArray === null ? '没抛错' : notArray.message.slice(0, 120),
  )
  const empty = await thrown({ targets: [] })
  check(empty !== null && empty.code === 'ARGS_TARGETS_SHAPE', 'F4 空数组 ⇒ 抛错（不静默成功）', empty === null ? '没抛错' : empty.code)
  const missing = await thrown({ displayPath: 'shape.mjs', hunks: [] })
  check(
    missing !== null && missing.code === 'ARGS_TARGETS_SHAPE' && missing.message.includes('targets'),
    'F5 走错入口（只有单目标形状）⇒ 抛错并指路',
    missing === null ? '没抛错' : missing.message.slice(0, 120),
  )
  const noPath = await thrown({ targets: [{ hunks: [{ target: 'VERSION', replace: 'x' }] }] })
  check(
    noPath !== null && noPath.code === 'ARGS_TARGETS_SHAPE' && noPath.message.includes('file_path'),
    'F6 元素没有路径 ⇒ 抛错并说清缺哪个键',
    noPath === null ? '没抛错' : noPath.message.slice(0, 120),
  )
  const nested = await thrown({ targets: [{ file_path: 'shape.mjs', targets: [] }] })
  check(nested !== null && nested.code === 'ARGS_TARGETS_SHAPE', 'F7 元素里再套 targets ⇒ 抛错（不静默忽略）', nested === null ? '没抛错' : nested.code)
  check(fs.readFileSync(path.join(dir, 'shape.mjs'), 'utf8') === sourceOf('shape.mjs'), 'F8 参数面抛错这一路一个字节都没写')
}

// ── G 阶段二中途失败：回执说清"哪些已落地、哪些没有" ───────────────────────
async function casePartialWriteFailure() {
  const names = ['ok-a.mjs', 'denied.mjs', 'ok-b.mjs']
  const dir = dirOf('writefail')
  const files = names.map((name) => plant(dir, name))
  const provider = failingWriteProvider(createNodeFsProvider({ resolveRoot: dir }), ['denied.mjs'])
  const multi = await applyEditsToProvider(provider, {
    targets: names.map((name) => ({ file_path: name, hunks: [versionHunk(name)] })),
  })
  check(multi.partial === true && multi.unchanged === false, 'G1 中途失败 ⇒ partial=true（不许只说"失败了"）', multi.summary)
  check(
    multi.summary.includes('landed 2') && multi.summary.includes('not_landed 1'),
    'G2 汇总行给出已落地/未落地计数',
    multi.summary,
  )
  const denied = multi.edits[1]
  check(
    denied.outcome === 'failed' && denied.landed === false && denied.stage === 'write' && denied.error.code === 'FS_WRITE_DENIED',
    'G3 失败那一项标了阶段与码',
    `${denied.outcome}/${denied.stage}/${denied.error?.code}`,
  )
  check(
    multi.edits[0].landed === true && multi.edits[2].landed === true && typeof multi.edits[0].original === 'string',
    'G4 已落地那两项带上落地前原文（可核对）',
    `original_chars=${multi.edits[0].original_chars}`,
  )
  check(
    fs.readFileSync(files[1], 'utf8') === sourceOf('denied.mjs') &&
      read(dir, 'ok-a.mjs').includes('ok-a.mjs-edited') &&
      read(dir, 'ok-b.mjs').includes('ok-b.mjs-edited'),
    'G5 磁盘状态与回执一致：被拒的文件没动，另两个都改了',
  )
}

// ── H create 不能合并：同一文件两个目标带 create ⇒ 阶段一拒绝 ───────────────
async function caseCreateMergeRefused() {
  const dir = dirOf('create-merge')
  const target = path.join(dir, 'fresh.mjs')
  const provider = countingProvider(createNodeFsProvider({ resolveRoot: dir }))
  const multi = await applyEditsToProvider(provider, {
    targets: [
      { file_path: 'fresh.mjs', create: 'export const A = 1\n' },
      { file_path: 'fresh.mjs', hunks: [versionHunk('fresh.mjs')] },
    ],
  })
  check(
    multi.applied === 0 && multi.edits.every((edit) => edit.outcome === 'failed') && multi.edits[0].error.code === 'MT_CREATE_MERGE',
    'H1 同一文件两个目标里有 create ⇒ 阶段一拒绝（不挑一个执行）',
    multi.summary,
  )
  check(!fs.existsSync(target) && provider.countOf('writeText') === 0, 'H2 拒绝之后文件没被建出来', `exists=${fs.existsSync(target)}`)
}

// ── I 一次调用多条 hunk：逐条回执只描述自己那条 hunk，且顺序 = 输入顺序 ──────────────
/**
 * 这一节盯的是 `planHunks` 的**回执**（`applied[]`），不是落盘字节（字节由 A/C/G 与红线套件钉）。
 * 它要的是两条纪律，两条曾经都不成立（现场复现过）：
 *
 *   ① `applied[k]` 描述的是**调用方输入的第 k 条 hunk**（数组顺序 = 输入顺序）；
 *   ② 每条记录里的 `actual` / `replaced` 是**那一条 hunk** 的改前原文与它写下去的文本。
 *
 * 曾经的形状：`applied` 是 `[...matches].reverse()`（倒序拼接的实现顺序泄漏进了回执），而
 * `replaced` 是从拼完的结果里按**改动前**的 `m.start` 回读的 ⇒ 只要位置更低的那条 hunk
 * 增删过行，高位那条就读到**别的行**：第 2 行 1→2 行、第 6 行换 `Y6` ⇒ 回执给第 6 行报 `a5`。
 * 这一格之所以是“真缺陷”而不是观感问题：自纠错读的就是这份回执 —— 串了行的 `replaced` 恰好
 * 让“是不是改成了我要的样子”重新变成一次猜测（真实语料里的读数见 `probes/indent-loss-census.mjs`）。
 *
 * **坐标口径**（下面的断言依赖它）：`line` 是**改动前**的行号（1-based），即调用方给地址时用的
 * 那一套 —— 红线套件 `single-target-nonregression-test` 的黄金集逐字节钉着它；改后的行号取决于
 * 这次调用里**别的** hunk 增删了几行，而调用方手里只有改前那份文件。
 * **`replaced` 口径** = 该 hunk `replace` 的**行文本**（按 `\r\n|\n` 切行、用 `\n` 接回；
 * 行尾是被替换区域继承的、不是调用方写的那一份，不进回执）。
 */
const NINE = ['a1', 'a2', 'a3', 'a4', 'a5', 'A6', 'a7', 'a8', 'a9']
const NINE_TEXT = `${NINE.join('\n')}\n`
/** 手写期望（**不来自引擎**：段I 的 content 判据要与拼接结果对赌，而不是拿它自己当基准）。 */
const GROWN_TEXT = `${['a1', 'x2', 'X2b', 'a3', 'a4', 'a5', 'Y6', 'a7', 'a8', 'a9'].join('\n')}\n`
const SHRUNK_TEXT = `${['a1', 'S', 'a5', 'Y6', 'a7', 'a8', 'a9'].join('\n')}\n`

async function caseMultiHunkReceipts() {
  // I1–I4：第 1 条 hunk **增行**（1 行 → 2 行），第 2 条落在它后面
  const grow = planHunks(NINE_TEXT, [
    { lines: [2, 2], replace: 'x2\nX2b' },
    { lines: [6, 6], replace: 'Y6' },
  ], 'sample.mjs')
  check(
    grow.applied.length === 2 && grow.applied[0].line === 2 && grow.applied[1].line === 6,
    'I1 增行之后两条回执仍在**输入顺序**上，且 `line` 是改动前坐标（2, 6）',
    grow.applied.map((a) => a.line).join(','),
  )
  check(
    grow.applied[0].actual === 'a2' && grow.applied[0].replaced === 'x2\nX2b',
    'I2 第 1 条回执 = 它自己那条 hunk（a2 → 两行）',
    `${JSON.stringify(grow.applied[0]?.actual)} → ${JSON.stringify(grow.applied[0]?.replaced)}`,
  )
  check(
    grow.applied[1].actual === 'A6' && grow.applied[1].replaced === 'Y6',
    'I3 增行之后第 2 条回执仍是**它自己**写的 Y6（不是被顶下去的邻居行 a5）',
    `${JSON.stringify(grow.applied[1]?.actual)} → ${JSON.stringify(grow.applied[1]?.replaced)}`,
  )
  check(grow.content === GROWN_TEXT, 'I4 增行版的落盘文本与手写期望逐字节相同', JSON.stringify(grow.content))

  // I5–I6：第 1 条 hunk **删行**（3 行 → 1 行），第 2 条落在它后面
  const shrink = planHunks(NINE_TEXT, [
    { lines: [2, 4], replace: 'S' },
    { lines: [6, 6], replace: 'Y6' },
  ], 'sample.mjs')
  check(
    shrink.applied[0].line === 2 && shrink.applied[0].actual === 'a2\na3\na4' && shrink.applied[0].replaced === 'S' &&
      shrink.applied[1].line === 6 && shrink.applied[1].actual === 'A6' && shrink.applied[1].replaced === 'Y6',
    'I5 删行（3→1）之后，两条回执各自对上自己的实际原文与写下去的文本',
    JSON.stringify(shrink.applied),
  )
  check(shrink.content === SHRUNK_TEXT, 'I6 删行版的落盘文本与手写期望逐字节相同', JSON.stringify(shrink.content))

  // I7–I8：hunks **倒序**给（输入序 6 → 2，文档序 2 → 6）
  const reversed = planHunks(NINE_TEXT, [
    { lines: [6, 6], replace: 'Y6' },
    { lines: [2, 2], replace: 'x2\nX2b' },
  ], 'sample.mjs')
  check(
    reversed.applied.map((a) => a.line).join(',') === '6,2' &&
      reversed.applied[0].actual === 'A6' && reversed.applied[0].replaced === 'Y6' &&
      reversed.applied[1].actual === 'a2' && reversed.applied[1].replaced === 'x2\nX2b',
    'I7 hunks 倒序给 ⇒ applied 仍是**输入顺序**（6, 2），逐条对上自己的 replace',
    reversed.applied.map((a) => `${a.line}:${JSON.stringify(a.replaced)}`).join(' '),
  )
  check(
    reversed.content === grow.content && reversed.content === GROWN_TEXT,
    'I8 倒序输入与正序输入写出**同一份字节**（顺序只是调用方的写法，不是落盘语义）',
    JSON.stringify(reversed.content),
  )

  // I9：`replaced` 的口径 = replace 的**行文本**（CRLF 写进来也归一成 LF）
  const crlf = planHunks('a1\r\na2\r\na3\r\na4\r\n', [
    { lines: [2, 2], replace: 'x2\r\nX2b' },
    { lines: [4, 4], replace: 'Y4' },
  ], 'sample.mjs')
  check(
    crlf.applied[0].replaced === 'x2\nX2b' && crlf.applied[1].replaced === 'Y4',
    'I9 replaced = 该 hunk `replace` 的行文本（CRLF 归一成 LF）',
    JSON.stringify(crlf.applied.map((a) => a.replaced)),
  )
  check(
    crlf.content === 'a1\r\nx2\r\nX2b\r\na3\r\nY4\r\n',
    'I10 CRLF 文件上落盘字节与手写期望逐字节相同（行尾仍是被替换区域那一份）',
    JSON.stringify(crlf.content),
  )

  // I11–I12：同一条纪律在**真 provider** 那条路上也成立（编排层不许把顺序改回去）
  const dir = dirOf('multi-hunk')
  fs.writeFileSync(path.join(dir, 'pair.mjs'), NINE_TEXT)
  const receipt = await applyEditToProvider(createNodeFsProvider({ resolveRoot: dir }), {
    displayPath: 'pair.mjs',
    hunks: [{ lines: [2, 2], replace: 'x2\nX2b' }, { lines: [6, 6], replace: 'Y6' }],
  })
  check(
    receipt.applied.map((a) => a.line).join(',') === '2,6' &&
      receipt.applied[0].replaced === 'x2\nX2b' && receipt.applied[1].replaced === 'Y6',
    'I11 真 provider 那条路上，回执同样逐条对上、顺序 = 输入顺序',
    JSON.stringify(receipt.applied?.map((a) => [a.line, a.replaced])),
  )
  check(read(dir, 'pair.mjs') === GROWN_TEXT, 'I12 磁盘字节 = 手写期望', JSON.stringify(read(dir, 'pair.mjs')))
}

await caseThreeFiles()
await caseOrderAndConcurrency()
await casePlanFailureIsAllOrNothing()
await caseSameFileMergesToOneCommit()
await caseSingleTargetIsDirect()
await caseShapeErrors()
await casePartialWriteFailure()
await caseCreateMergeRefused()
await caseMultiHunkReceipts()

const passed = results.filter((result) => result.ok).length
const failed = results.length - passed
say('')
if (failed > 0) say(`✗ 失败 ${failed} 条：${results.filter((result) => !result.ok).map((result) => result.label).join('；')}`)
say(`--- ${passed}/${results.length} 通过 ---`)
fs.rmSync(tempHome, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
