/**
 * T5 对齐层的针对性验证。
 *
 * T4 定长窗口的固有盲区是"锚点相对真实区域多/少了一整行"。要真正触发它，锚点剩下的行在文件里
 * 必须**不连续**（中间夹着被删掉的那行），否则 T1/T2 会先命中。
 * 本文件造两个这样的场景，并断言：命中层级是 aligned、跨度正确、落盘正确。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply as applyPatchPlugin } from './index.js'
import { indexFile, locateWith } from '../locator-lab/anchor-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

// ── 场景 1：锚点少一行，真实区域靠上下文的非重复行定死 ─────────────────────
// 关键设计：锚点必须**足够长且上下文唯一**，否则"少一行"的情形本身就是歧义的——
// 文件里若存在与被匹配部分完全相同的相邻行，任何匹配器都无法区分，正确行为是拒绝而不是猜。
const FILE_1 = [
  'export function planTask(input) {',
  '  const seed = 1234;',
  '  const retries = 3;',
  '  // 这一行注释会被模型漏掉',
  '  const timeoutMs = 5000;',
  '  const label = "primary";',
  '  return { seed, retries, timeoutMs, label };',
  '}',
  '',
].join('\n')
// 锚点覆盖 seed/retries/timeoutMs/label 四行，中间漏了注释行 —— 文件里这四行并不连续
const ANCHOR_1 = [
  '  const seed = 1234;',
  '  const retries = 3;',
  '  const timeoutMs = 5000;',
  '  const label = "primary";',
].join('\n')

say('=== 场景 1：锚点少一行（真实区域 5 行，锚点 4 行，且不连续）===')
const idx1 = indexFile(FILE_1)
try {
  const loc = locateWith(idx1, ANCHOR_1)
  check(loc.tier === 'aligned', `命中层级 = ${loc.tier}`, `span=${loc.end - loc.start} line=${loc.line}`)
  check(loc.line === 2, `起点行 = ${loc.line}（期望 2）`)
  check(loc.end - loc.start === 5, `跨度 = ${loc.end - loc.start} 行（期望 5：含被漏掉的那行）`)
} catch (e) {
  check(false, `未命中：${e.code}`, `bestScore=${(e.bestScore ?? 0).toFixed(3)} bestAlignment=${(e.bestAlignment ?? 0).toFixed(3)}`)
}

// ── 场景 2：锚点少一行，且锚点里所有行都被改写过（同时考验两个维度）────────
const FILE_2 = [
  'export function run(task) {',
  '  const ctx = createContext(task);',
  '  const retries = 3;',
  '  ctx.log("starting");',
  '  const result = execute(ctx);',
  '  const label = "primary";',
  '  return result.value;',
  '}',
  '',
].join('\n')
// 锚点漏掉 ctx.log 那行，并把 createContext 记成了 buildContext
const ANCHOR_2 = [
  '  const ctx = buildContext(task);',
  '  const retries = 3;',
  '  const result = execute(ctx);',
  '  const label = "primary";',
].join('\n')

say('')
say('=== 场景 2：锚点少一行 + 改了一个标识符 ===')
const idx2 = indexFile(FILE_2)
try {
  const loc = locateWith(idx2, ANCHOR_2)
  check(loc.tier === 'aligned', `命中层级 = ${loc.tier}`, `span=${loc.end - loc.start} line=${loc.line}`)
  check(loc.line === 2, `起点行 = ${loc.line}（期望 2）`)
  check(loc.end - loc.start === 5, `跨度 = ${loc.end - loc.start} 行（期望 5）`)
} catch (e) {
  check(false, `未命中：${e.code}`, `bestScore=${(e.bestScore ?? 0).toFixed(3)} bestAlignment=${(e.bestAlignment ?? 0).toFixed(3)}`)
}

// ── 场景 3：端到端落盘，确认 aligned 命中的跨度被正确替换 ──────────────────
say('')
say('=== 场景 3：aligned 命中后真的落盘（跨度必须整段替换）===')
const tmp = path.join(os.tmpdir(), `patch-align-${Date.now()}`)
fs.mkdirSync(tmp, { recursive: true })
const target = path.join(tmp, 'sample.js')
fs.writeFileSync(target, FILE_1, 'utf8')

let registered = null
const ctx = {
  fs: {
    resolve: async (p) => ({ displayPath: p, targetKey: p }),
    stat: async () => ({ version: 'v1', type: 'file' }),
    readText: async () => fs.readFileSync(target, 'utf8'),
    editText: async (_t, req) => {
      const cur = fs.readFileSync(target, 'utf8')
      if (cur.split(req.oldString).length - 1 !== 1) throw Object.assign(new Error('no match'), { code: 'FS_EDIT_NOT_FOUND' })
      const next = cur.split(req.oldString).join(req.newString)
      fs.writeFileSync(target, next, 'utf8')
      return { version: 'v2', operation: 'update', before: cur, after: next }
    },
  },
  // 与真实 Cordis 上下文同形：`inject` 与 `get` 必须存在。
  // 这个 mock 曾经比框架宽松——而漏掉的能力恰好被生产代码用到了，
  // 于是"全绿"与"能跑"是两件事。
  inject: (deps, fn) => {
    if (deps.includes('sandboxPolicy') && ctx.sandboxPolicy !== undefined) {
      fn({ sandboxPolicy: ctx.sandboxPolicy })
    }
  },
  get: (n) => ctx[n],  tools: { register: (t) => (registered = t) },
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
const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }

const out = await registered.execute(
  {
    file_path: target,
    hunks: [{ anchor: ANCHOR_1, replace: '  const seed = 10;\n  const retries = 30;\n  // 补回注释\n  const timeoutMs = 50000;\n  const label = "primary";' }],
  },
  exec,
)
const after = fs.readFileSync(target, 'utf8')
check(out.applied[0].tier === 'aligned', `落盘走的层级 = ${out.applied[0].tier}`)
check(after.includes('const seed = 10;'), '新内容已落盘')
check(after.includes('const timeoutMs = 50000;'), '后续行新内容已落盘')
check(!after.includes('会被模型漏掉'), '被漏掉的那行注释已被整段替换掉（证明跨度正确）')
check(after.includes('return { seed, retries, timeoutMs, label };'), '区域之后的行完好无损（替换没有吃掉多余的上下文）')
check(after.split('\n').length === FILE_1.split('\n').length, `行数不变：${FILE_1.split('\n').length} -> ${after.split('\n').length}`)
say('  落盘后的文件：')
for (const l of after.split('\n')) say(`    ${l}`)

fs.rmSync(tmp, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) process.exitCode = 1
