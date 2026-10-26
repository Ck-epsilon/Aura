/**
 * repair-address-shell-test.mjs —— 能力面对齐的第三条：**修复地址在 DSH 工具面上看不看得见**。
 *
 * 【为什么单开一件】`src/locator-lab/repair-address-test.mjs` 钉的是**引擎**（错误对象 + 正文文本里都有地址），
 * 独立面（CLI / MCP）在 `standalone-test.mjs` 的 MT-M 段钉过了。但**模型真正看到的那段文本是壳渲染出来的**
 * （`aura-edit` 的 `receiptBody` → `renderFailure`），而框架只把 `result.content` 装进 tool 消息 ——
 * 引擎里那条地址**到不了眼前**这件事，本仓已经先例过一次（句柄化落地时就是靠"必须进模型看得见的那段 text"才发现的）。
 * 所以这一面必须拿**渲染后**的文本判，不能拿引擎的错误对象判。
 *
 * 【判据】
 *   R5 引文写错 ⇒ 回执是**返回**（不是抛错），`outcome=not_found`；
 *   R1 渲染出来的正文里能抄到 `retry: {"handle":…}`；
 *   R2 那一发**一个字节都没写**（给得出地址不等于可以顺手写）；
 *   R4 正文那行与回执的**结构化字段 `retry.handle` 同源同名**（不是渲染层另编一个）；
 *   R3 把地址抄回去再发一次 ⇒ **真的落盘**，只换回执印的那个区间，且披露点名用了句柄。
 *
 * 【变异反证】`--mutation=no-address`：把引擎那条地址行从正文里拿掉，R1/R3/R4 必须红。
 *   变异跑在**仓库之外的私有副本**上（不是就地改源文件）—— 第一版就地改过，闸里并发跑的别的套件
 *   会在那个窗口里读到被改过的引擎、按名变红。**量具不得在共享产物上有可变窗口**（本仓已有先例）。
 *   另一条同样栽过的坑：变异必须落在 `import` **之前**（ESM 求值一次就缓存，先 import 再改文件 = 空变异）。
 *
 * 运行：node src/aura-edit/repair-address-shell-test.mjs
 *      node src/aura-edit/repair-address-shell-test.mjs --mutation=no-address
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { contextServices } from '../locator-lab/mock-ctx.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const sha = (b) => createHash('sha256').update(b).digest('hex')

const MUTATION = (process.argv.find((a) => a.startsWith('--mutation=')) ?? '').split('=')[1] ?? null
if (MUTATION !== null && MUTATION !== 'no-address') {
  process.stderr.write(`未知的 --mutation=${MUTATION}（只认 no-address）\n`)
  process.exit(2)
}

/* ---------------------------------------------------------------- 变异窗口（必须在 import 之前） */

const SHIPPED = ['index.js', 'repair-address-shell-test.mjs']
const shippedBefore = SHIPPED.map((f) => `${f}=${sha(fs.readFileSync(path.join(HERE, f))).slice(0, 8)}`).join(' ')

let plugin
if (MUTATION === 'no-address') {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-repair-mutant-'))
  const copy = path.join(box, 'src')
  fs.cpSync(path.join(HERE, '..'), copy, { recursive: true })
  // 裸导入（`@deepseek-ai/dsh-tools`）要能被解析：副本在仓库外，Node 逐层上溯找不到它们
  // （实测：ERR_MODULE_NOT_FOUND）。与 hook 进程内等价实验同一手 —— 挂一个只指回仓库
  // `node_modules` 的目录联接；收尾先摘联接本身（rmdir 只删重解析点，不递归进目标）。
  const REPO = path.resolve(HERE, '..', '..', '..')
  const link = path.join(box, 'node_modules')
  fs.symlinkSync(path.join(REPO, 'node_modules'), link, 'junction')
  process.on('exit', () => { try { fs.rmdirSync(link) } catch { /* 已摘掉 */ } })
  const target = path.join(copy, 'locator-lab', 'write-path.mjs')
  const MUT_ANCHOR = "const RETRY_LABEL = 'retry: '"
  /**
   * 变异要**真的把地址拿掉**：标签换成空串 ⇒ 那一行变成 `{"handle":…}`，不再是可抄的 `retry:` 地址。
   * （把标签改成 `retry (MUTANT): ` 是错的：判据的正则只认紧贴的 `retry:` ⇒ 根本不吃它 ⇒ 空变异。
   *   与 K17 同类教训：**变异没被咬住时，先怀疑变异，再怀疑判据。**）
   */
  const src = fs.readFileSync(target, 'utf8')
  if (!src.includes(MUT_ANCHOR)) {
    process.stderr.write('变异锚点没找到——判据的牙齿失效，停手\n')
    process.exit(2)
  }
  fs.writeFileSync(target, src.replace(MUT_ANCHOR, "const RETRY_LABEL = ''"))
  console.log(`变异臂：副本=${copy}（在仓库之外）；出货树 ${shippedBefore} 全程未写`)
  plugin = await import(pathToFileURL(path.join(copy, 'aura-edit', 'index.js')).href)
} else {
  plugin = await import('./index.js')
}

const shippedAfter = SHIPPED.map((f) => `${f}=${sha(fs.readFileSync(path.join(HERE, f))).slice(0, 8)}`).join(' ')
if (shippedAfter !== shippedBefore) {
  process.stderr.write(`出货树在本次运行里变了——停手：${shippedBefore} → ${shippedAfter}\n`)
  process.exit(2)
}

/* ---------------------------------------------------------------- 夹具 */

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) { pass += 1; console.log(`✓ ${label}`) } else { fail += 1; console.log(`✗ ${label}${detail === '' ? '' : `   ${detail}`}`) }
}
const say = (m) => console.log(`\n=== ${m} ===`)

const TMP = path.join(os.tmpdir(), `aura-repair-shell-${Date.now()}`)
fs.mkdirSync(TMP, { recursive: true })

const NF_LINES = Array.from({ length: 40 }, (_, i) => `const item${String(i + 1).padStart(2, '0')} = make(${i + 1}, 'tag-${i + 1}')`)
const REGION = { start: 15, end: 20 }
const QUOTE = NF_LINES.slice(REGION.start - 1, REGION.end).join('\n').replace('const item20', 'const item20TYPO')
const NEW_BLOCK = Array.from({ length: REGION.end - REGION.start + 1 }, (_, i) => `const repaired${i + 1} = ${i + 1}`)
// 空白类写 `[ \t]*` 而不是反斜杠-s 那条：打包守卫会把转义序列误当盘符路径（它那条正则不看上下文）。
const RETRY_RE = /retry:[ \t]*(\{[^\n]*?\})/g

/** 与另外两件壳套件同形：真磁盘后端 + 与真实 Cordis 同形的 mock ctx。 */
const makeFs = () => {
  let version = 1
  const stats = { writes: 0 }
  return {
    stats,
    resolve: async (p, opts) => {
      const abs = path.isAbsolute(p) ? p : path.resolve(opts?.cwd ?? TMP, p)
      return { displayPath: abs, targetKey: abs }
    },
    stat: async (t) => {
      if (!fs.existsSync(t.targetKey)) return undefined
      const st = fs.statSync(t.targetKey)
      if (st.isDirectory()) return { type: 'directory', size: 0 }
      return { type: 'file', version: `v${version}`, size: st.size }
    },
    readText: async (t) => fs.readFileSync(t.targetKey, 'utf8'),
    readByteRange: async (t, r) => fs.readFileSync(t.targetKey).subarray(r.offset, r.offset + r.length),
    writeText: async (t, content) => {
      stats.writes += 1
      fs.writeFileSync(t.targetKey, content)
      version += 1
      return { version: `v${version}`, operation: 'update', after: content }
    },
    editText: async () => { throw new Error('editText must not be used by the write path') },
  }
}

let registered = null
const holder = { fs: makeFs() }
plugin.apply({
  get fs () { return holder.fs },
  ...contextServices(),
  tools: { register: (t) => (registered = t), get: () => undefined },
  systemPrompt: { section: () => () => {} },
  emit: () => {},
  waterfall: async () => { throw Object.assign(new Error('edit requires reading first'), { code: 'FS_NOT_OBSERVED' }) },
})
const tool = plugin.lastLegacyTools.edit
const exec = { agent: { session: { header: { cwd: TMP } } }, signal: undefined }

/** 像框架那样跑一次：返回 ⇒ 取 render 出来的**那段文本**（模型唯一看得见的东西）。 */
const run = async (args, fsService = makeFs()) => {
  holder.fs = fsService
  let value
  try {
    value = await tool.execute(args, exec)
  } catch (error) {
    return { isError: true, text: String(error?.message ?? error), value: undefined, code: error?.code }
  }
  let text = ''
  try {
    text = tool.output.render(args, value).map((b) => b.text).join('\n')
  } catch (error) {
    text = `render threw: ${String(error?.message ?? error)}`
  }
  return { isError: false, value, text, code: value?.code }
}

const retryLines = (text) => [...String(text).matchAll(RETRY_RE)]
  .map((m) => { try { return JSON.parse(m[1]) } catch { return null } })
  .filter((o) => o !== null && typeof o.handle === 'string')

/* ---------------------------------------------------------------- R1–R5 */

say('R1–R5 修复地址在 DSH 工具面上：从渲染后的正文抄回来，再改一次')
const file = path.join(TMP, 'a.js')
fs.writeFileSync(file, `${NF_LINES.join('\n')}\n`, 'utf8')
const beforeDisk = fs.readFileSync(file)

const io = makeFs()
const failed = await run({ file_path: file, hunks: [{ old: QUOTE, replace: '// nope' }] }, io)

check(
  failed.isError === false && failed.value?.outcome === 'not_found',
  'R5 失败是**返回**的（不是抛错），outcome=not_found —— 回执本身到得了眼前',
  `isError=${failed.isError} outcome=${failed.value?.outcome} code=${failed.code}`,
)
const got = retryLines(failed.text)
check(
  got.length === 1,
  'R1 渲染后的正文里能抄到一行 `retry: {"handle":…}`（引擎里有不算，要眼前有）',
  `抄到 ${got.length} 行；正文前 300 字：${JSON.stringify(String(failed.text).slice(0, 300))}`,
)
check(
  fs.readFileSync(file).equals(beforeDisk) && io.stats.writes === 0,
  'R2 给得出地址的这一发：写调用 0 次、磁盘逐字节不变',
  `writes=${io.stats.writes}`,
)
// 结构化那半在**壳自己的失败回执**的顶层 `retry.handle` 上（本波补的声明面字段；以前这里什么都没有）。
const structured = failed.value?.retry?.handle ?? null
check(
  structured !== null && got[0] !== undefined && structured === got[0].handle,
  'R4 正文里那行地址与回执的结构化字段**同源同名**（不是渲染层另编一个）',
  `结构化=${structured} 正文=${got[0]?.handle}`,
)

const handle = got[0]?.handle ?? ''
const io2 = makeFs()
const retried = await run({ file_path: file, hunks: [{ handle, lines: [REGION.start, REGION.end], replace: NEW_BLOCK.join('\n') }] }, io2)
const expected = [...NF_LINES.slice(0, REGION.start - 1), ...NEW_BLOCK, ...NF_LINES.slice(REGION.end)].join('\n') + '\n'
const afterDisk = fs.readFileSync(file, 'utf8')
check(
  retried.isError === false && retried.value?.outcome === 'applied' && afterDisk === expected,
  'R3 把那一行地址抄回去再发一次 ⇒ 真的落盘，且只换了回执印的那个区间',
  `outcome=${retried.value?.outcome} ${afterDisk === expected ? '' : '磁盘与预期不同'}`,
)
const tier = String(retried.value?.applied?.[0]?.tier ?? '')
check(
  tier.startsWith('handle') && tier.includes('lines'),
  'R3 落点披露点名用了句柄，且把被让开的一方（`lines`）说出来',
  `tier=${JSON.stringify(tier)}`,
)

console.log(`\n--- 修复地址（DSH 工具面）：${pass} 通过 / ${fail} 失败 ---`)
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
