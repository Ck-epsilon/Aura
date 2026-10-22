/**
 * read-continuation-test —— 取景尺度与续读语义（fs-contract-v2 / C16）。
 *
 * ## 命题（施工单终态，判据不可改）
 *
 * 读回执在三个已知缺陷上被修正：
 *
 *   ① 被预算截断的回执只说“截掉了多少”，不给**可直接执行的续读参数**。
 *      后果（R5 实测，14,728 次重复读）：51.7% 的重复读要的是此前一行都没给过的新区间，
 *      其中 13.1% 是在顺着文件往下扫。
 *   ② 连续顺扫场景：请求是「从这里往下 N 行」而预算放得下更多时，应当一次给够，
 *      而不是每次都卡在调用方自己那个 N 上。
 *   ③ `digest` 的信封体量与正文反转：正文受内容预算管、`exported` 数组不受它约束，
 *      于是“省流模式”反而比正文还大（10^5 行档实测 text=0 / 信封 1889299 字节）。
 *
 * ## 四段怎么验（每一段都留下原始读数）
 *
 *   段A 截断回执含下一次调用的**确切参数**——断言能把它原样拿去再调一次，
 *       且拿回来的正是**紧邻的下一段**（起点 == 上一次交付终点 + 1）。
 *   段B 连续区间一次请求拿全——请求与交付的原始读数直接打印，断言交付 ≥ 请求，
 *       且顺扫链每一步都紧邻、直到文件末尾。
 *   段C 信封体量与正文一致——10^5 行档上 digest/map 都不出现
 *       「text=0 而信封 > 100KB」的反转，且信封不超宿主剪枝阈值。
 *   段D 负向不变量——孤立的定向读**不许**被顺扫带跑；顺扫**不许**多给不存在的内容；
 *       各 mode 的既有语义逐条对照。
 *
 * ## 为什么段D 是这套件里最要紧的一段
 *
 * 段A/B 是“多给”，而“多给”在错的时候就是**换语义**：`lines=[a,b]` 的语义是“给我 a..b”，
 * 一旦无差别地扩成“给我 a..文件末尾”，`range-args-test` 钉住的那条契约当场就破了。
 * 所以这里的实现把“多给”的判据放在**会话状态**上（上一次窗口读被预算截断留下的前沿），
 * 段D 逐条验的就是“这个判据没有溢出到不该管的地方”。
 *
 * ## 跑法
 *
 *   node src/locator-lab/read-continuation-test.mjs   → exit 0
 *
 * 段C 用 10^5 行合成源（终态判据点名的档位），首次建索引需要一两分钟；
 * 全程无网络、无外部依赖，临时文件落在 os.tmpdir()。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readWith, DEFAULT_PRUNE_BUDGET } from './read-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    pass += 1
    say(`  ✓ ${label}`)
  } else {
    fail += 1
    say(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}
const section = (m) => say(`\n=== ${m} ===`)

const tmp = path.join(os.tmpdir(), `aura-read-continuation-${Date.now()}`)
fs.mkdirSync(tmp, { recursive: true })

/* ── 夹具 ────────────────────────────────────────────────────────────────── */

/**
 * 顺扫夹具：无语言配置的 `.txt` ⇒ 不建符号索引（段A/B/D 量的是**窗口**语义，
 * 与语言无关，而 4000 行的索引纯属白付）。
 * 每行内容互不相同且带行号，才能断言“读到的确实是那一行”而不是“读了点什么”。
 */
const SCAN_LINES = 4000
const scanLine = (n) => `line ${String(n).padStart(4, '0')} :: ${'x'.repeat(40)}`
const scanSource = Array.from({ length: SCAN_LINES }, (_, i) => scanLine(i + 1)).join('\n')
const scanRows = scanSource.split('\n')

/** 结构夹具：一张会被预算截断的地图/摘要/命中清单。 */
const structSource = Array.from(
  { length: 400 },
  (_, i) => `export function fn${String(i).padStart(3, '0')}(alpha, beta) { return alpha + beta + ${i} }`,
).join('\n')

/**
 * 10^5 行合成源（段C）。
 *
 * 形状是挑过的：**25000 个导出常量 + 每段 3 个空行** ⇒ 恰好 100000 行。
 * 为什么不是“每行一个函数”：那种形状的 token 数是 100k 行 × ~15 = 150 万，
 * `structureBytes` 估到 140 MB，越过 `INDEX_CACHE_MAX_BYTES`（32 MiB）就**永不记忆化**，
 * 于是 map 与 digest 各建一次索引——那是分钟级的白付，而段C 要验的性质
 * （`exported` 数组随符号数线性膨胀）在 25000 个符号上已经完全成立。
 */
const HUGE_SYMBOLS = 25000
const hugeSource = (() => {
  const parts = []
  for (let i = 0; i < HUGE_SYMBOLS; i += 1) parts.push(`export const k${i} = ${i}`, '', '', '')
  return parts.join('\n')
})()

/* ── 小工具 ──────────────────────────────────────────────────────────────── */

const rowNums = (text) => String(text ?? '').split('\n').filter((l) => /^\d+: /.test(l)).map((l) => Number(l.slice(0, l.indexOf(':'))))
const shownRange = (env) => {
  const m = /^(\d+)-(\d+)$/.exec(String(env.shown ?? ''))
  return m === null ? null : [Number(m[1]), Number(m[2])]
}
const bytesOf = (env) => JSON.stringify(env).length

/* ══════════════════════════════════════════════════════════════════════════
 * 段A 截断回执含下一次调用的确切参数
 * ══════════════════════════════════════════════════════════════════════════ */
section('段A 被预算截断的回执给出**可执行的**续读参数')
{
  const file = 'segA-scan.txt'
  const first = readWith(scanSource, { filePath: file, mode: 'lines', lines: [1, SCAN_LINES] })
  const firstRange = shownRange(first)
  say(`  原始读数｜请求 lines=[1,${SCAN_LINES}] ⇒ 交付 shown=${first.shown} · text=${first.text.length} 字符 · envelope=${bytesOf(first)} 字节`)
  say(`            omitted: ${first.omitted}`)
  say(`            next:    ${first.next}`)
  say(`            resume:  ${JSON.stringify(first.resume)}`)

  check('A1 截断回执带 resume（不是一个只有自然语言的建议）', first.resume !== undefined && first.resume !== null)
  check(
    'A2 resume 的形状与工具入参同名同形（mode + lines）',
    first.resume?.mode === 'lines' && Array.isArray(first.resume?.lines) && first.resume.lines.length === 2,
    JSON.stringify(first.resume),
  )
  check(
    'A3 resume 的起点就是**交付终点的下一行**（紧邻，无洞无重）',
    firstRange !== null && first.resume?.lines?.[0] === firstRange[1] + 1,
    `shown=${first.shown} resume=${JSON.stringify(first.resume?.lines)}`,
  )
  check(
    'A4 resume 的终点给到**文件末尾**（把剩余一次取完，而不是回到请求里那个 N）',
    first.resume?.lines?.[1] === SCAN_LINES,
    JSON.stringify(first.resume?.lines),
  )
  check('A5 next 那句话里含与 resume 完全一致的可执行参数', String(first.next).includes(`lines=[${first.resume?.lines?.[0]},${first.resume?.lines?.[1]}]`), String(first.next))

  // 段A 的核心：把 resume **原样**拿去再调一次。
  const second = readWith(scanSource, { filePath: file, mode: first.resume.mode, lines: first.resume.lines })
  const secondRange = shownRange(second)
  say(`  原始读数｜拿 resume 原样再调：{mode:${first.resume.mode}, lines:[${first.resume.lines}]} ⇒ shown=${second.shown} · text=${second.text.length} 字符`)
  check('A6 拿 resume 再调一次拿到非空正文', second.ok !== false && second.text.length > 0, `text=${second.text.length}`)
  check(
    'A7 拿回来的正是**紧邻的下一段**：新起点 == 上一次交付终点 + 1',
    secondRange !== null && secondRange[0] === firstRange[1] + 1,
    `第一次 delivered=${first.shown} · 第二次 delivered=${second.shown}`,
  )
  check('A8 两次交付零重叠', secondRange !== null && secondRange[0] > firstRange[1])

  // 顺着 resume 一路走：每一步都必须紧邻、单调、落在文件内。
  let cursor = second
  let steps = 1
  let contiguous = true
  const seen = [firstRange, secondRange]
  while (cursor.resume !== undefined && steps < 40) {
    const before = shownRange(cursor)
    cursor = readWith(scanSource, { filePath: file, mode: cursor.resume.mode, lines: cursor.resume.lines })
    const after = shownRange(cursor)
    if (after === null || before === null || after[0] !== before[1] + 1) contiguous = false
    seen.push(after)
    steps += 1
  }
  const last = seen[seen.length - 1]
  say(`  原始读数｜顺着 resume 走了 ${steps + 1} 步 ⇒ 覆盖 ${seen[0][0]}-${last[1]}（文件 ${SCAN_LINES} 行）`)
  check(`A9 顺 resume 链 ${steps + 1} 步全程紧邻（起点恒等于上一步终点 +1）`, contiguous, JSON.stringify(seen))
  check('A10 链走到文件末尾就停（最后一交付终点 == 总行数，且不再给 resume）', last[1] === SCAN_LINES && cursor.resume === undefined, `last=${last} resume=${JSON.stringify(cursor.resume)}`)
  check('A11 链上每一步都在文件行号范围内', seen.every(([a, b]) => a >= 1 && b <= SCAN_LINES && a <= b), JSON.stringify(seen))
}

{
  // map / digest / search 的截断同样要给可执行参数，而不只是“截掉了多少”。
  const mapEnv = readWith(structSource, { filePath: 'segA-big.mjs', mode: 'map' })
  say(`  原始读数｜map ⇒ envelope=${bytesOf(mapEnv)} 字节 · text=${mapEnv.text.length} · resume=${JSON.stringify(mapEnv.resume)}`)
  say(`            omitted: ${mapEnv.omitted}`)
  check('A12 map 截断 ⇒ resume 可执行（mode=lines + 确定区间）', mapEnv.resume?.mode === 'lines' && mapEnv.resume.lines.length === 2, JSON.stringify(mapEnv.resume))
  const mapFollow = readWith(structSource, { filePath: 'segA-big.mjs', mode: mapEnv.resume.mode, lines: mapEnv.resume.lines })
  check('A13 拿 map 的 resume 再调一次拿到非空正文', mapFollow.ok !== false && mapFollow.text.length > 0, `text=${mapFollow.text.length}`)

  const digEnv = readWith(structSource, { filePath: 'segA-big.mjs', mode: 'digest' })
  say(`  原始读数｜digest ⇒ envelope=${bytesOf(digEnv)} 字节 · text=${digEnv.text.length} · resume=${JSON.stringify(digEnv.resume)}`)
  say(`            omitted: ${digEnv.omitted}`)
  check('A14 digest 截断 ⇒ resume 可执行', digEnv.resume?.mode === 'lines' && digEnv.resume.lines.length === 2, JSON.stringify(digEnv.resume))
  const digFollow = readWith(structSource, { filePath: 'segA-big.mjs', mode: digEnv.resume.mode, lines: digEnv.resume.lines })
  check('A15 拿 digest 的 resume 再调一次拿到非空正文', digFollow.ok !== false && digFollow.text.length > 0, `text=${digFollow.text.length}`)

  // search：命中行多于预算能装下的 ⇒ 剩下那批命中落在一个**算得出来的**行区间里。
  const manyHits = Array.from({ length: 200 }, (_, i) => `hit token ${i} ${'y'.repeat(30)}`).join('\n')
  const searchEnv = readWith(manyHits, { filePath: 'segA-hits.txt', mode: 'search', search: 'hit token' })
  say(`  原始读数｜search ⇒ matches=${searchEnv.matches} · 渲染=${rowNums(searchEnv.text).length} 行 · resume=${JSON.stringify(searchEnv.resume)}`)
  check('A16 search 命中被截 ⇒ resume 是可执行的行区间', searchEnv.resume?.mode === 'lines' && searchEnv.resume.lines.length === 2, JSON.stringify(searchEnv.resume))
  check(
    'A17 search 的 next 不再是 `<a>,<b>` 这种要调用方自己填的模板',
    String(searchEnv.next).includes(`lines=[${searchEnv.resume.lines[0]},${searchEnv.resume.lines[1]}]`) && !String(searchEnv.next).includes('<a>'),
    String(searchEnv.next),
  )
}

{
  // 单行超预算：行区间救不了（lines 给整行还是会被截在同一个地方），
  // 所以续读参数必须是一个**真的子串**——取自被扣下的那一段。
  const longLine = `const blob = ${Array.from({ length: 3000 }, (_, i) => `tok${i}`).join(' ')}`
  const env = readWith(longLine, { filePath: 'segA-long.txt', mode: 'lines', lines: [1, 1] })
  say(`  原始读数｜单行 ${longLine.length} 字符 ⇒ truncated=${JSON.stringify(env.truncated)} · resume=${JSON.stringify(env.resume)}`)
  check('A18 单行被截时给的是 search 型 resume（行区间在这里是空头支票）', env.resume?.mode === 'search' && typeof env.resume.search === 'string' && env.resume.search.length > 0, JSON.stringify(env.resume))
  const withheld = longLine.slice(env.truncated.shown)
  check('A19 resume 的子串取自**被扣下的那一段**（否则续读等于没续）', withheld.includes(env.resume.search), `search=${JSON.stringify(env.resume.search)}`)
  const follow = readWith(longLine, { filePath: 'segA-long.txt', mode: 'search', search: env.resume.search })
  check('A20 拿这个子串再调一次确实命中那一行', follow.ok !== false && rowNums(follow.text).includes(1), JSON.stringify(follow).slice(0, 120))
}

{
  // 工具层：resume 必须真的送到调用方手里（引擎给了、schema 认了、中间漏传 = 本工具出过四次的事故）。
  // 壳层是 CJS 插件（`aura-read/package.json` 的 type=commonjs），用动态 import 取它的
  // default（= module.exports）——`createRequire` 的相对路径在这里解析不到。
  const mod = await import(new URL('../aura-read/index.js', import.meta.url).href)
  const plugin = mod.default ?? mod
  const schema = plugin.PASSTHROUGH_FIELDS
  let registered = null
  const ctx = {
    fs: { resolve: async (p) => ({ displayPath: p, targetKey: p }), stat: async () => ({ version: 'v1' }), readText: async () => scanSource },
    get: () => undefined,
    tools: { register: (t) => (registered = t), get: () => registered },
    systemPrompt: { section: () => () => {} },
    emit: () => {},
    waterfall: async () => undefined,
  }
  plugin.apply(ctx)
  const out = await registered.execute({ file_path: 'segA-tool.txt', mode: 'lines', start_line: 1, end_line: SCAN_LINES }, { agent: { session: { header: { cwd: tmp } } }, signal: undefined })
  say(`  原始读数｜工具层回执 ⇒ outcome=${out.outcome} · resume=${JSON.stringify(out.resume)} · text=${out.text.length} 字符`)
  check('A21 工具层回执带 resume（引擎 → schema → 壳层这条接缝没断）', out.resume?.mode === 'lines' && Array.isArray(out.resume?.lines), JSON.stringify(out.resume))
  check('A22 resume 在 PASSTHROUGH_FIELDS 名单里', schema.includes('resume'), schema.join(','))
  const declared = Object.keys(registered.output.schema.properties ?? {})
  check('A23 resume 在 output.schema 里声明（additionalProperties:false ⇒ 漏声明会拒掉整条成功路径）', declared.includes('resume'), declared.join(','))
}

/* ══════════════════════════════════════════════════════════════════════════
 * 段B 连续区间一次请求拿全
 * ══════════════════════════════════════════════════════════════════════════ */
section('段B 连续顺扫：预算放得下更多时一次给够')
{
  const file = 'segB-scan.txt'
  // 顺扫的前提：本文件在本会话里已经被预算截断过一次（判据见 read-core 的 SCAN 账本）。
  const opening = readWith(scanSource, { filePath: file, mode: 'lines', lines: [1, SCAN_LINES] })
  const openingRange = shownRange(opening)
  say(`  原始读数｜顺扫开端：请求 lines=[1,${SCAN_LINES}] ⇒ 交付 shown=${opening.shown}（${opening.text.length} 字符）`)

  // “从这里往下 N 行”：调用方只开口要 31 行，而预算装得下近 130 行。
  const N = 31
  const reqStart = openingRange[1] + 1
  const requested = [reqStart, reqStart + N - 1]
  const delivered = readWith(scanSource, { filePath: file, mode: 'lines', lines: requested })
  const deliveredRange = shownRange(delivered)
  const reqRows = rowNums(delivered.text)
  say(`  原始读数｜请求 lines=[${requested}]（${N} 行） ⇒ 交付 shown=${delivered.shown}（${deliveredRange[1] - deliveredRange[0] + 1} 行，${delivered.text.length} 字符）`)
  say(`            omitted: ${delivered.omitted}`)
  say(`            resume:  ${JSON.stringify(delivered.resume)}`)

  check('B1 交付严格多于请求（预算放得下更多 ⇒ 一次给够）', deliveredRange !== null && deliveredRange[1] - deliveredRange[0] + 1 > N, `请求 ${N} 行，交付 ${deliveredRange?.[1] - deliveredRange?.[0] + 1} 行`)
  check('B2 交付从请求起点开始（不是从别处开始）', deliveredRange?.[0] === requested[0], `shown=${delivered.shown}`)
  check(
    'B3 请求区间**逐行完整包含**在交付里（多给不许吃掉要的）',
    requested.every((n) => reqRows.includes(n)),
    `请求 [${requested}] · 交付行号 ${reqRows[0]}..${reqRows[reqRows.length - 1]}`,
  )
  check('B4 多给的部分在回执里明写（不是静默扩张）', String(delivered.omitted).includes(`requested ${requested[0]}-${requested[1]}`) && String(delivered.omitted).includes(`continued to ${delivered.shown}`), String(delivered.omitted))

  // 再顺一次：起点 == 上一次交付终点 + 1 ⇒ 同一次顺扫继续。
  const next1 = readWith(scanSource, { filePath: file, mode: 'lines', lines: [deliveredRange[1] + 1, deliveredRange[1] + 20] })
  const next1Range = shownRange(next1)
  say(`  原始读数｜顺扫第二段：请求 lines=[${deliveredRange[1] + 1},${deliveredRange[1] + 20}]（20 行） ⇒ 交付 shown=${next1.shown}（${next1Range[1] - next1Range[0] + 1} 行）`)
  check('B5 顺扫链没断：第二段紧邻第一段', next1Range?.[0] === deliveredRange[1] + 1, `${delivered.shown} → ${next1.shown}`)
  check('B6 第二段同样一次给够', next1Range[1] - next1Range[0] + 1 > 20, `${next1Range[1] - next1Range[0] + 1} 行`)

  // 一路顺到底：步数应当与「预算能装多少」相称，而不是与调用方那个 N 相称。
  let cursor = next1
  let trips = 2
  while (cursor.resume !== undefined && trips < 200) {
    cursor = readWith(scanSource, { filePath: file, mode: 'lines', lines: [shownRange(cursor)[1] + 1, shownRange(cursor)[1] + N] })
    trips += 1
  }
  say(`  原始读数｜按「每次只开口要 ${N} 行」一路顺到末尾：共 ${trips} 次调用，覆盖 1-${shownRange(cursor)[1]}（文件 ${SCAN_LINES} 行）`)
  check('B7 顺扫链一路走到文件末尾', shownRange(cursor)[1] === SCAN_LINES, `last=${cursor.shown}`)
  check(
    `B8 每次调用交付的都远超请求的 ${N} 行（否则往返次数会退化回 ${Math.ceil(SCAN_LINES / N)} 次）`,
    trips < Math.ceil(SCAN_LINES / N) / 2,
    `实际 ${trips} 次 vs 卡在 N 上需要 ${Math.ceil(SCAN_LINES / N)} 次`,
  )
}

/* ══════════════════════════════════════════════════════════════════════════
 * 段C 信封体量与正文一致（10^5 行档）
 * ══════════════════════════════════════════════════════════════════════════ */
section('段C 信封体量与正文一致：10^5 行档不出现「text=0 而信封 > 100KB」的反转')
{
  say(`  夹具：${HUGE_SYMBOLS} 个导出常量 / ${hugeSource.split('\n').length} 行 / ${hugeSource.length} 字符`)
  const LIMIT = 100 * 1024
  for (const mode of ['digest', 'map']) {
    const t = Date.now()
    const env = readWith(hugeSource, { filePath: 'segC-huge.mjs', mode })
    const bytes = bytesOf(env)
    const text = env.text.length
    say(`  原始读数｜mode=${mode} ⇒ text=${text} 字符 · envelope=${bytes} 字节 · 用时 ${Date.now() - t}ms`)
    say(`            omitted: ${String(env.omitted).slice(0, 220)}`)
    say(`            resume:  ${JSON.stringify(env.resume)}`)
    check(`C.${mode} 不出现「text=0 而信封 > 100KB」的反转`, !(text === 0 && bytes > LIMIT), `text=${text} envelope=${bytes}`)
    check(`C.${mode} 正文非空（省流模式要给得出东西）`, text > 0, `text=${text}`)
    check(`C.${mode} 信封不超宿主剪枝阈值（${DEFAULT_PRUNE_BUDGET}）`, bytes <= DEFAULT_PRUNE_BUDGET, `envelope=${bytes}`)
    check(`C.${mode} 信封与正文同阶（信封 ≤ 正文 × 4）`, bytes <= text * 4, `text=${text} envelope=${bytes}`)
    check(`C.${mode} 被省掉的东西在回执里明写`, /beyond the content budget/.test(String(env.omitted)), String(env.omitted).slice(0, 160))
    check(`C.${mode} 截断时带可执行续读参数`, env.resume?.mode === 'lines' && env.resume.lines.length === 2, JSON.stringify(env.resume))
  }
}

{
  // ③ 的原始说法是「map 信封已越 8192 的宿主剪枝阈值」。
  // 注意“信封”到底是哪一份：剪枝器量的是**工具输出**（text block），
  // 而引擎量的是它自己的信封——两者差着一次重排（`omitted` / `next` 会在正文里再出现一次）。
  // 所以这里量大的是前者，而且故意把路径拉长（路径也是要付钱的字节）。
  const mod = await import(new URL('../aura-read/index.js', import.meta.url).href)
  const plugin = mod.default ?? mod
  const deep = path.join(tmp, 'a-quite-long-directory-name-so-the-path-itself-costs-bytes', 'second-segment', 'third')
  fs.mkdirSync(deep, { recursive: true })
  const deepFile = path.join(deep, 'segC-deep.mjs')
  fs.writeFileSync(deepFile, hugeSource, 'utf8')
  let registered = null
  const ctx = {
    fs: {
      resolve: async (p) => ({ displayPath: p, targetKey: p }),
      stat: async (t) => (fs.existsSync(t.targetKey) ? { version: 'v1' } : undefined),
      readText: async (t) => fs.readFileSync(t.targetKey, 'utf8'),
    },
    get: () => undefined,
    tools: { register: (t) => (registered = t), get: () => registered },
    systemPrompt: { section: () => () => {} },
    emit: () => {},
    waterfall: async () => undefined,
  }
  plugin.apply(ctx)
  for (const mode of ['map', 'digest', 'full']) {
    const out = await registered.execute({ file_path: deepFile, mode }, { agent: { session: { header: { cwd: tmp } } }, signal: undefined })
    const bytes = JSON.stringify(out).length
    say(`  原始读数｜工具层（路径 ${deepFile.length} 字符）mode=${mode} ⇒ toolOutput=${bytes} 字节 · text=${out.text.length} 字符`)
    check(`C.tool.${mode} 工具输出不越宿主剪枝阈值（${DEFAULT_PRUNE_BUDGET}）`, bytes <= DEFAULT_PRUNE_BUDGET, `${bytes} 字节`)
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 段D 负向不变量
 * ══════════════════════════════════════════════════════════════════════════ */
section('段D 负向不变量：孤立的定向读不许被顺扫带跑，各 mode 语义未变')
{
  // D1 孤立请求：**没有**“上一次被预算截断”这个前提，就不许多给。
  const isolated = readWith(scanSource, { filePath: 'segD-fresh.txt', mode: 'lines', lines: [100, 110] })
  const isoRows = rowNums(isolated.text)
  say(`  原始读数｜孤立请求（新路径）lines=[100,110] ⇒ shown=${isolated.shown} · text=${isolated.text.length} 字符 · resume=${JSON.stringify(isolated.resume)}`)
  check('D1 孤立请求逐行照给，不多一行', isolated.shown === '100-110' && isoRows.length === 11, `shown=${isolated.shown} rows=${isoRows.length}`)
  check('D2 孤立请求不带 resume（没有“还剩一段”这回事）', isolated.resume === undefined, JSON.stringify(isolated.resume))

  // D3 被截断过、但请求**没落在前沿附近** ⇒ 仍然逐行照给。
  const offScan = readWith(scanSource, { filePath: 'segB-scan.txt', mode: 'lines', lines: [900, 910] })
  say(`  原始读数｜同一文件、但请求落在前沿之外 lines=[900,910] ⇒ shown=${offScan.shown} · resume=${JSON.stringify(offScan.resume)}`)
  check('D3 请求没伸进未交付区 ⇒ 不扩展', offScan.shown === '900-910', `shown=${offScan.shown} omitted=${offScan.omitted}`)

  // D4 顺扫不许多给不存在的内容：交付的每一行都必须与源文件逐字节相同，且不越过末尾。
  const file = 'segD-content.txt'
  const open = readWith(scanSource, { filePath: file, mode: 'lines', lines: [1, SCAN_LINES] })
  let cursor = readWith(scanSource, { filePath: file, mode: 'lines', lines: [shownRange(open)[1] + 1, shownRange(open)[1] + 10] })
  let verified = 0
  let mismatched = 0
  let overrun = 0
  for (let step = 0; step < 12 && cursor !== null; step += 1) {
    for (const raw of cursor.text.split('\n')) {
      const m = /^(\d+): (.*)$/.exec(raw)
      if (m === null) continue
      const n = Number(m[1])
      // 行尾的区间句柄标记（`  <h…>`）不是文件里的字节，比对正文前先剥掉。
      // 剥法是**行尾锚定**的，因此这条断言比以前**更严**，不是放宽：它现在同时要求
      // （1）剥掉标记后行文逐字节等于源文，（2）行尾至多只有一条合法句柄。
      // 若哪天句柄把正文吃了一口，剥完后就不再等于源文 —— 会比以前更容易红。
      const body = m[2].replace(/  <h[0-9a-f]{4}[0-9a-f]{8}:\d+-\d+>$/, '')
      if (n > SCAN_LINES) overrun += 1
      else if (body !== scanRows[n - 1]) mismatched += 1
      verified += 1
    }
    if (cursor.resume === undefined) break
    cursor = readWith(scanSource, { filePath: file, mode: 'lines', lines: [shownRange(cursor)[1] + 1, shownRange(cursor)[1] + 10] })
  }
  say(`  原始读数｜顺扫内容核对：逐行比对 ${verified} 行 ⇒ 与源文不同 ${mismatched} 行 · 越界 ${overrun} 行`)
  check('D4 顺扫交付的每一行都与源文件逐字节相同（不多给不存在的内容）', mismatched === 0, `${mismatched}/${verified}`)
  check('D5 顺扫永不越过文件末尾', overrun === 0, `${overrun} 行越界`)

  // D6 内容换了 ⇒ 顺扫前沿作废（行号前沿属于**那一版**内容）。
  const changed = scanSource.replace(scanLine(2000), 'line 2000 :: CHANGED')
  const afterChange = readWith(changed, { filePath: file, mode: 'lines', lines: [500, 510] })
  say(`  原始读数｜同一路径、内容换了一版，请求 lines=[500,510] ⇒ shown=${afterChange.shown} · resume=${JSON.stringify(afterChange.resume)}`)
  check('D6 版本变了 ⇒ 顺扫账本作废，不许按旧前沿扩展', afterChange.shown === '500-510', `shown=${afterChange.shown}`)

  // D7 各 mode 的既有语义（在一份与任何顺扫无关的源上逐条对照）。
  const fresh = 'segD-modes.mjs'
  const small = [
    'export function alpha(a) {',
    '  return a + 1',
    '}',
    '',
    'export function beta(b) {',
    '  return b * 2',
    '}',
  ].join('\n')
  const linesEnv = readWith(small, { filePath: fresh, mode: 'lines', lines: [2, 3] })
  // 区间头行带句柄（契约 §4）：行数/行序/行文未变，只在头行行尾多一段标记。
  check('D7 lines 仍只给请求的那几行', linesEnv.text === '2:   return a + 1  <h177de77028af:2-3>\n3: }', JSON.stringify(linesEnv.text))
  const fullEnv = readWith(small, { filePath: fresh, mode: 'full' })
  check('D8 full 仍给整份正文（小文件装得下）', rowNums(fullEnv.text).length === 7, `${rowNums(fullEnv.text).length} 行`)
  const aroundEnv = readWith(small, { filePath: fresh, mode: 'around', around: 'beta', context: 1 })
  check('D9 around 仍是 目标 ± context', rowNums(aroundEnv.text).length === 3, `${rowNums(aroundEnv.text).length} 行`)
  const searchEnv = readWith(small, { filePath: fresh, mode: 'search', search: 'return b' })
  check('D10 search 仍给命中行', rowNums(searchEnv.text).length === 1 && searchEnv.text.includes('return b * 2'), JSON.stringify(searchEnv.text))
  const mapEnv = readWith(small, { filePath: fresh, mode: 'map' })
  check('D11 map 仍是一张目录（首行是规模统计）', /^\d+ lines · \d+ symbols/.test(mapEnv.text.split('\n')[0]), mapEnv.text.split('\n')[0])
  check('D12 map 不截断时不给 resume', mapEnv.resume === undefined, JSON.stringify(mapEnv.resume))
  const digEnv = readWith(small, { filePath: fresh, mode: 'digest' })
  check('D13 digest 仍是一份摘要（首行是规模统计 + 导出面）', /^\d+ lines · \d+ symbols/.test(digEnv.text.split('\n')[0]) && digEnv.text.includes('exported:'), digEnv.text.split('\n')[0])
  check('D14 digest 不截断时不给 resume', digEnv.resume === undefined, JSON.stringify(digEnv.resume))
  // `changed` 的「no change」只在它**真的更省**时才说话（小文件上全文比那句说明还短，
  // 那时返回全文是既有契约，不是回归）——所以这条用一份大到装得下的源来对照。
  const mid = Array.from({ length: 120 }, (_, i) => `export const value_${i} = ${i}`).join('\n')
  const changedEnv1 = readWith(mid, { filePath: 'segD-mid.mjs', mode: 'full' })
  const changedEnv2 = readWith(mid, { filePath: 'segD-mid.mjs', mode: 'full', since: changedEnv1.version })
  say(`  原始读数｜changed（120 行文件）⇒ text=${JSON.stringify(String(changedEnv2.text).slice(0, 70))}`)
  check('D15 changed 的 no-change 语义没动', /no change/.test(changedEnv2.text), String(changedEnv2.text).slice(0, 60))

  // D16 顺扫只在**窗口**模式上生效：结构模式反复读仍是同一张地图 / 同一份摘要。
  const mapAgain = readWith(structSource, { filePath: 'segD-struct.mjs', mode: 'map' })
  const mapAgain2 = readWith(structSource, { filePath: 'segD-struct.mjs', mode: 'map' })
  check('D16 结构模式重复读逐字节一致（顺扫不参与）', bytesOf(mapAgain) === bytesOf(mapAgain2) && mapAgain.text === mapAgain2.text)
}

fs.rmSync(tmp, { recursive: true, force: true })

say('')
say(`--- ${pass}/${pass + fail} 通过 ---`)
if (fail > 0) process.exitCode = 1
