/**
 * ab-real.mjs —— 在**真实源码**上做 patch 与 edit 的 A/B。
 *
 * 这不是合成 benchmark，是取证：把真实的 DSH 源文件复制到临时目录，在真实代码上取真实锚点，
 * 注入真实模型会犯的偏差，然后分别走两条路，统计
 *   ① 一次成功需要几轮工具调用（轮数才是 `edit` 真正的瓶颈）
 *   ② 有多少次"报错"（可见失败）
 *   ③ 有多少次"命中错了位置/内容"（不可见失败 —— 最危险的）
 *
 * 复刻 `edit` 的判定规则来自 dsh-fs-local/lib/index.js 的 applyLiteralEdit：
 *   oldString 归一化 \r\n → \n，indexOf 计数；0 次 → FS_EDIT_NOT_FOUND，
 *   多次且未开 replaceAll → FS_AMBIGUOUS_EDIT。逐字节，无空白容错。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply as applyPatchPlugin } from './index.js'
import { contextServices } from '../locator-lab/mock-ctx.mjs'

/**
 * 同步写 fd 2 的进度日志。console.* 在管道下会缓冲，卡住时一个字都看不到，
 * 而这里最需要的恰恰是"卡在哪一步"。writeSync 不缓冲，且不经过任何流状态。
 */
const progress = (msg) => fs.writeSync(1, `[progress] ${msg}\n`)

/** 黑匣子：把即将送入引擎的输入落盘，进程被挂死时也能拿到最后一条现场。 */
const BLACKBOX_PATH = path.join(import.meta.dirname, 'blackbox.json')
const writeBlackbox = (entry) => fs.writeFileSync(BLACKBOX_PATH, JSON.stringify(entry, null, 2), 'utf8')

const NM = 'E:\\software\\npmlocal\\node_global\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai'

const CORPUS = [
  'dsh-fs-local/lib/index.js',
  'dsh-tool-fs/lib/index.js',
  'dsh-tool-str-replace-editor/lib/index.js',
  'dsh-fs-observation-policy/lib/index.js',
  'dsh-tool-pwsh/lib/index.js',
  'dsh-tool-todo/lib/index.js',
  'dsh-fs/lib/index.js',
  'dsh-agent-presets/lib/index.js',
  'dsh-tool-subagent/lib/index.js',
  'dsh-skill-filesystem/lib/index.js',
].map((rel) => path.join(NM, rel))

const TMP = path.join(os.tmpdir(), `patch-ab-${Date.now()}`)
fs.mkdirSync(TMP, { recursive: true })

// 确定性伪随机，保证可复现
let seed = 987654321
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const pick = (arr) => arr[Math.floor(rnd() * arr.length)]

// ── 真实偏差注入：每一条都是模型在长会话里真的会犯的 ──────────────────────
const DRIFTS = {
  '缩进多 2 格': (a) => a.split('\n').map((l) => (l.trim() ? '  ' + l : l)).join('\n'),
  '缩进少 2 格': (a) => a.split('\n').map((l) => (l.startsWith('  ') ? l.slice(2) : l)).join('\n'),
  '空格换 tab': (a) => a.split('\n').map((l) => l.replace(/^ +/, (m) => '\t'.repeat(Math.ceil(m.length / 2)))).join('\n'),
  '行尾多空格': (a) => a.split('\n').map((l) => l + '  ').join('\n'),
  '改一个标识符': (a) => {
    const m = a.match(/[A-Za-z_$][A-Za-z0-9_$]{5,}/)
    return m ? a.replace(m[0], m[0].slice(0, -1) + 'X') : a
  },
  '去掉一行注释': (a) => a.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n'),
  '标点后加空格': (a) => a.replace(/,(\S)/g, ', $1').replace(/;(\S)/g, '; $1'),
}

// ── edit 的判定规则（逐字节，来自 fs-local 实现）──────────────────────────
function literalEdit(content, oldString, replaceAll = false) {
  const oldNorm = oldString.replace(/\r\n/g, '\n')
  // 空串会让下面的 indexOf 游标原地不动 —— dsh 侧由 schema 校验拦下，这里必须显式拒绝
  if (oldNorm.length === 0) return { ok: false, code: 'FS_EDIT_EMPTY' }
  let count = 0
  let i = 0
  while ((i = content.indexOf(oldNorm, i)) !== -1) {
    count += 1
    i += oldNorm.length
  }
  if (count === 0) return { ok: false, code: 'FS_EDIT_NOT_FOUND' }
  if (!replaceAll && count > 1) return { ok: false, code: 'FS_AMBIGUOUS_EDIT' }
  return { ok: true, matched: oldNorm, count }
}

// ── 装一次 patch 工具，指到一个可控的临时工作区 ───────────────────────────
const files = new Map() // 工作副本路径 -> 内容
let registered = null
const ctx = {
  fs: {
    resolve: async (p) => ({ displayPath: p, targetKey: p }),
    stat: async (t) => (files.has(t.targetKey) ? { version: 'v', type: 'file', size: files.get(t.targetKey).length } : undefined),
    readText: async (t) => files.get(t.targetKey),
    editText: async (t, req) => {
      const cur = files.get(t.targetKey)
      const n = cur.split(req.oldString).length - 1
      if (n === 0) throw Object.assign(new Error('old_string was not found'), { code: 'FS_EDIT_NOT_FOUND' })
      if (n > 1) throw Object.assign(new Error(`old_string matched ${n} times`), { code: 'FS_AMBIGUOUS_EDIT' })
      files.set(t.targetKey, cur.split(req.oldString).join(req.newString))
      return { version: 'v', operation: 'update', before: cur, after: files.get(t.targetKey) }
    },
  },
  // 与真实 Cordis 上下文同形（inject / get 都必须在场）——理由见 mock-ctx.mjs 的注释。
  ...contextServices(),  tools: { register: (t) => (registered = t) },
  // 插件把 systemPrompt 声明进了 inject，缺了会在 apply 期抛错——这是好事：
  // 它把"工具注册了却没有指导"这种半成品状态挡在装载期，而不是留到运行期
  // 表现为"模型永远不用这个工具"。
  systemPrompt: { section: () => () => {} },
  emit: () => {},
  waterfall: async () => {
    throw Object.assign(new Error('not observed'), { code: 'FS_NOT_OBSERVED' })
  },
}
applyPatchPlugin(ctx)

const exec = { agent: { session: { header: { cwd: TMP } } }, signal: undefined }

/** 在文件里挑一个"唯一且值得改"的 3–5 行块作为锚点 */
function makeAnchor(content) {
  const lines = content.split('\n')
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const n = 3 + Math.floor(rnd() * 3)
    const start = Math.floor(rnd() * (lines.length - n - 1))
    const block = lines.slice(start, start + n)
    if (block.some((l) => l.trim().length === 0)) continue
    if (block.some((l) => l.length > 160)) continue
    if (!/[A-Za-z]/.test(block.join(''))) continue
    const anchor = block.join('\n')
    if (content.split(anchor).length !== 2) continue
    return { anchor, start }
  }
  return null
}

/**
 * 跑一整轮，返回逐用例结果。
 * @param withExpect - 是否给每个 hunk 带上 `expect` 闸门。两组用同一个随机种子，因此锚点逐字相同，
 *   差别只有闸门 —— 这样才知道 80% 里有多少是锚点自己的功劳、多少来自人工加的护栏。
 */
async function runPass(withExpect) {
  seed = 987654321 // 重置种子：两轮必须命中同一批锚点
  const out = []
  for (const src of CORPUS) {
    if (!fs.existsSync(src)) continue
    const original = fs.readFileSync(src, 'utf8')
    const pkg = path.basename(path.dirname(path.dirname(src)))

    for (const [driftName, drift] of Object.entries(DRIFTS)) {
      const sample = makeAnchor(original)
      if (!sample) continue
      const drifted = drift(sample.anchor)
      // 空锚点不是真实输入（schema 会拦），而且它会让两边都退化成无意义用例 —— 直接跳过
      if (drifted === sample.anchor || drifted.trim().length === 0) continue

      // ── 路线 A：edit（逐字节）。失败后模型必须重新读取精确原文再重试 = 2 轮额外往返
      const oldLines = original.split('\n')
      const exactBlock = oldLines.slice(sample.start, sample.start + sample.anchor.split('\n').length).join('\n')
      const literal = literalEdit(original, drifted)
      let editCalls
      let editOutcome
      if (literal.ok) {
        // 命中了 —— 但要判断命中的是不是"正确那段"。子串搜索可能匹配到丢了缩进的片段。
        const at = original.indexOf(literal.matched)
        const matchedRegion = original.slice(at, at + sample.anchor.length)
        const aligned = matchedRegion.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).join('\n')
        const expected = exactBlock.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).join('\n')
        editCalls = 1
        editOutcome = aligned === expected ? '成功' : '命中错位'
      } else {
        editCalls = 3 // 失败 + 重新 read + 精确重试
        editOutcome = literal.code
      }

      // ── 路线 B：patch（锚点降级）。同一个漂移锚点，一次调用
      const work = path.join(TMP, `${pkg}-${Object.keys(DRIFTS).indexOf(driftName)}.js`)
      files.set(work, original)
      const replacement = exactBlock.replace(/[A-Za-z_$][A-Za-z0-9_$]{3,}/, (w) => w + 'Changed')
      let patchCalls
      let patchOutcome
      let tier = ''
      writeBlackbox({ pkg, drift: driftName, anchorLines: drifted.split('\n').length, anchor: drifted, at: sample.start + 1 })
      try {
        const result = await registered.execute(
          {
            file_path: work,
            hunks: [withExpect ? { anchor: drifted, replace: replacement, expect: sample.anchor } : { anchor: drifted, replace: replacement }],
          },
          exec,
        )
        tier = result.applied[0].tier
        patchCalls = 1
        patchOutcome = files.get(work) !== original ? '成功' : '未落盘'
      } catch (e) {
        patchCalls = 2
        patchOutcome = e.code ?? 'ERROR'
      }

      out.push({ pkg, drift: driftName, edit: editOutcome, editCalls, patch: patchOutcome, patchCalls, tier })
    }
  }
  return out
}

const rows = await runPass(true)
const rowsNoGuard = await runPass(false)

// ── 报表 ───────────────────────────────────────────────────────────────────
/** 中英混排时按显示宽度对齐：CJK 与全角标点占 2 列。 */
const width = (s) => [...String(s)].reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0)
const w = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)))

/** 从一行结果算汇总指标。 */
function summarize(list, label) {
  const total = list.length
  const editOk = list.filter((r) => r.edit === '成功').length
  const editMis = list.filter((r) => r.edit === '命中错位').length
  const patchOk = list.filter((r) => r.patch === '成功').length
  const editCalls = list.reduce((s, r) => s + r.editCalls, 0)
  const patchCalls = list.reduce((s, r) => s + r.patchCalls, 0)
  const tiers = list.reduce((m, r) => ((m[r.tier || '未命中'] = (m[r.tier || '未命中'] || 0) + 1), m), {})
  return { label, total, editOk, editMis, patchOk, editCalls, patchCalls, tiers }
}

console.log(`语料: ${CORPUS.filter(fs.existsSync).length} 个真实源文件   用例: ${rows.length}（两轮锚点逐字相同）`)
console.log('')
console.log(w('包', 28) + w('偏差', 16) + w('edit', 18) + w('轮', 4) + w('patch', 18) + w('轮', 4) + '命中层级')
console.log('-'.repeat(102))
for (const r of rows) {
  console.log(w(r.pkg, 28) + w(r.drift, 16) + w(r.edit, 18) + w(r.editCalls, 4) + w(r.patch, 18) + w(r.patchCalls, 4) + r.tier)
}

const pct = (a, b) => `${((a / b) * 100).toFixed(0)}%`
console.log('')
console.log('=== 汇总 ===')
for (const s of [summarize(rows, '带 expect 闸门'), summarize(rowsNoGuard, '不带闸门')]) {
  console.log(`\n[${s.label}]`)
  console.log(`  edit   一次成功 ${s.editOk}/${s.total} (${pct(s.editOk, s.total)})   命中错位 ${s.editMis}`)
  console.log(`  patch  一次成功 ${s.patchOk}/${s.total} (${pct(s.patchOk, s.total)})   失败 ${s.total - s.patchOk}`)
  console.log(`  工具调用：edit ${s.editCalls}  vs  patch ${s.patchCalls}   （省 ${pct(s.editCalls - s.patchCalls, s.editCalls)}）`)
  console.log(`  命中层级：${JSON.stringify(s.tiers)}`)
}
console.log('')
console.log('口径说明：edit 的轮数按最保守计 —— 失败后需重新 read 再用精确原文重试，共 3 轮；')
console.log('         patch 失败记 2 轮（本次 + 重新定位后重试）。"命中错位"= 子串搜索命中了位置但内容对不上，')
console.log('         属于不可见失败：它不会报错，只会改错地方。')

// 逐类
console.log('')
console.log('=== 逐类命中率 ===')
const byDrift = new Map()
for (const r of rows) {
  if (!byDrift.has(r.drift)) byDrift.set(r.drift, { e: 0, p: 0, n: 0, mis: 0 })
  const b = byDrift.get(r.drift)
  b.n += 1
  if (r.edit === '成功') b.e += 1
  if (r.edit === '命中错位') b.mis += 1
  if (r.patch === '成功') b.p += 1
}
console.log(w('偏差', 18) + w('edit 成功', 12) + w('其中错位', 10) + 'patch 成功')
for (const [k, v] of byDrift) {
  console.log(w(k, 18) + w(`${((v.e / v.n) * 100).toFixed(0)}%`, 12) + w(v.mis, 10) + `${((v.p / v.n) * 100).toFixed(0)}%`)
}

fs.rmSync(TMP, { recursive: true, force: true })