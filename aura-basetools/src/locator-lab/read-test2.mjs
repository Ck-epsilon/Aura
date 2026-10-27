/**
 * read-test2.mjs —— 补上第一版缺失的那一半：**验闭环与语义**，而不是格式合规。
 *
 * 第一版测的是"输出格式对不对"（预算没超、行号连续、字段齐全）。那些必要，但不充分——
 * 它没有回答唯一要紧的问题：**read 出来的东西，够不够把它想改的地方改对？**
 *
 * 本文件分三组：
 *   A. 闭环：read 的产物直接喂给 patch，落盘结果必须正确
 *   B. 语义：digest 说的是不是真的（导出面、依赖、签名）
 *   C. 边界：第一版完全没碰的输入——空文件、无换行、单行超长、CRLF、二进制、极深嵌套
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readWith, suggestMode, MODES, CONTENT_BUDGET, PRUNE_BUDGET } from './read-core.mjs'
import { dshModulesRoot } from './dsh-test-paths.mjs'
import { apply as applyPatchPlugin } from '../aura-edit/index.js'
import { contextServices } from './mock-ctx.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

const NM = dshModulesRoot()
if (NM === null) {
  say('--- 0/0 通过（已跳过：未找到 DSH 语料）---')
  process.exit(0)
}
const BIG = path.join(NM, 'dsh-tool-fs', 'lib', 'index.js')

// ── A. 闭环：read 的产物直接喂给 patch ────────────────────────────────────

const tmp = path.join(os.tmpdir(), `read-loop-${Date.now()}`)
fs.mkdirSync(tmp, { recursive: true })
const target = path.join(tmp, 'sample.js')
const SRC = [
  'export function total(items) {',
  '  let sum = 0;',
  '  for (const it of items) {',
  '    sum += it.price;',
  '  }',
  '  return sum;',
  '}',
  '',
  'export function label(count) {',
  '  return `n=${count}`;',
  '}',
  '',
].join('\n')
fs.writeFileSync(target, SRC, 'utf8')

let registered = null
const ctx = {
  fs: {
    resolve: async (p) => ({ displayPath: p, targetKey: p }),
    stat: async (t) => (fs.existsSync(t.targetKey) ? { version: 'v1', type: 'file' } : undefined),
    readText: async (t) => fs.readFileSync(t.targetKey, 'utf8'),
    editText: async (t, req) => {
      const cur = fs.readFileSync(t.targetKey, 'utf8')
      const n = cur.split(req.oldString).length - 1
      if (n !== 1) throw Object.assign(new Error('no unique match'), { code: 'FS_EDIT_NOT_FOUND' })
      const next = cur.split(req.oldString).join(req.newString)
      fs.writeFileSync(t.targetKey, next, 'utf8')
      return { version: 'v2', operation: 'update', before: cur, after: next }
    },
  },
  // 与真实 Cordis 上下文同形（inject / get 都必须在场）——理由见 mock-ctx.mjs 的注释。
  ...contextServices(),
  tools: { register: (t) => (registered = t) },
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

say('=== A. 闭环：read → patch → 落盘正确 ===')
say('')
say('A1. map → 用符号名改整个函数')
const m = readWith(SRC, { filePath: target, mode: 'map' })
// 符号表包含**局部变量**（`let sum`），因此是 3 个而不是 2 个。
// 这不是错误——是已记录的边界：词法级解析会把函数体内的高价值局部量也索引进来。
// 断言必须跟着真实行为走，而不是跟着我的期待。
check(m.ok && m.symbols === 3, `地图报出 ${m.symbols} 个符号（含局部变量 let sum）`)
check(m.text.includes('total') && m.text.includes('label'), '地图里两个函数都在')
// 1.0.2：整段替换要落在**交付过**的正文上；map 只给结构，先读一次正文。
// 用 lines 而不是 full：full 会写下增量基线，后面那条"小文件 auto 选全文"的判据会拿到"无变化"回执。
readWith(SRC, { filePath: target, mode: 'lines', lines: [1, SRC.split('\n').length] })
const r1 = await registered.execute(
  { file_path: target, hunks: [{ target: 'label', replace: 'export function label(count) {\n  return `count=${count}`;\n}' }] },
  exec,
)
check(r1.applied[0].tier === 'symbol', `按地图给的符号名改成功：${r1.applied[0].tier}`)
check(fs.readFileSync(target, 'utf8').includes('count=${count}'), '落盘内容正确')

say('')
say('A2. around → 把窗口给的行号直接用于 patch')
fs.writeFileSync(target, SRC, 'utf8')
const a = readWith(SRC, { filePath: target, mode: 'around', around: 'sum += it.price' })
check(a.ok, `around 命中第 ${a.center} 行`)
// 关键闭环：read 报的行号，patch 必须认可
const r2 = await registered.execute(
  { file_path: target, hunks: [{ lines: [a.center], expect: '    sum += it.price;', replace: '    sum += it.price * 2;' }] },
  exec,
)
check(r2.applied[0].tier === 'lines', `read 给的行号被 patch 接受：tier=${r2.applied[0].tier}`)
check(fs.readFileSync(target, 'utf8').includes('it.price * 2'), '落盘内容正确')

say('')
say('A3. lines → 取一段连续区间并整段替换')
fs.writeFileSync(target, SRC, 'utf8')
const seg = readWith(SRC, { filePath: target, mode: 'lines', lines: [2, 5] })
const segLines = [...seg.text.matchAll(/^(\d+): /gm)].map((x) => Number(x[1]))
check(segLines.join(',') === '2,3,4,5', `区间连续：${segLines.join(',')}`)
const r3 = await registered.execute(
  {
    file_path: target,
    hunks: [
      {
        lines: [3, 5],
        expect: '  for (const it of items) {\n    sum += it.price;\n  }',
        replace: '  for (const it of items) {\n    sum += it.price * it.qty;\n  }',
      },
    ],
  },
  exec,
)
check(r3.applied[0].tier === 'lines', '多行区间整段替换成功')
check(fs.readFileSync(target, 'utf8').includes('it.price * it.qty'), '落盘内容正确')

// ── B. digest 的语义 ──────────────────────────────────────────────────────

say('')
say('=== B. digest：它说的是不是真的 ===')
const d = readWith(SRC, { filePath: target, mode: 'digest' })
check(d.ok && d.mode === 'digest', `mode=${d.mode}`)
check(d.exported?.length === 2, `识别出 ${d.exported?.length} 个导出（第一版此字段恒为 0）`)
check(d.text.includes('exported:'), '导出面出现在文本里')
check(d.exported?.some((e) => e.includes('total')) && d.exported?.some((e) => e.includes('label')), '两个导出都被点名')
// 小文件上 digest 有固定开销，会**比全文大**——实测盈亏平衡点在 2 个函数 / 274 字符左右
// （见 digest-threshold.mjs）。所以这里不能断言"摘要更小"，只能断言它不含函数体。
// auto 模式正是为此存在：它比较各模式体量，选最小的那个。
check(!d.text.includes('sum += it.price'), '摘要不含函数体（节省的来源正在于此）')
check(d.text.includes('total(items)') || d.text.includes('function total'), '摘要含签名')
// auto 的契约**不是"选渲染后最小的那个"**——那是我先前写错的判据。
// 真实使用暴露了它：模型在一个 14 行文件上拿到地图后反馈"这对大文件是正确的经济选择，
// 在这里是错的：模式选择在全文就是整个答案的文件上优化了字节数"。
// 于是目标函数补上了漏掉的一项——不只看"省多少"，还要看"这个选择是否回答了问题"。
// 小文件上全文完备，地图只给名字、反而不完备；省下的字节换不来任何东西。
const autoSmall = readWith(SRC, { filePath: target })
const sizes = suggestMode(SRC, target).sizes
const isSmallest = Object.entries(sizes).sort((a, b) => a[1] - b[1])[0][0]
check(autoSmall.mode === 'full', `小文件 auto 选全文（最小者是 ${isSmallest}，但全文才是完整答案）`)
check(autoSmall.text.includes('export function total'), '小文件 auto 给的内容里确实有源码，而不是只有符号名')
check(
  typeof autoSmall.auto === 'string' && autoSmall.auto.includes('complete answer'),
  `理由点明了"完整答案"这条判据：${autoSmall.auto}`,
)
// 大文件上 auto 必须选一个远小于全文的模式——这才是它存在的意义。
// 注意"远小于"不等于"两千字符以内"：地图现在会**用满预算**给出更多可寻址名字
// （从 24 个符号提到 55 个），所以判据是**相对全文的比例**，不是绝对大小。
const bigFull = fs.readFileSync(BIG, 'utf8')
const autoBig = readWith(bigFull, { filePath: BIG })
check(autoBig.mode !== 'full', `大文件 auto 不选全文：mode=${autoBig.mode}`)
check(autoBig.text.length <= CONTENT_BUDGET, `大文件 auto 未超预算（${autoBig.text.length}）`)
check(autoBig.text.length < bigFull.length / 10, `大文件 auto 输出 ${autoBig.text.length} 字符，仅为全文的 1/${Math.round(bigFull.length / autoBig.text.length)}`)

say('')
say('B2. digest 的外部调用：只收自由调用，不收字段名')
const depSrc = [
  'import { helper } from "./h.js";',
  'export function run(ctx) {',
  '  const v = ctx.value.get();',
  '  const w = compute(v);',
  '  obj.clear();',
  '  return helper(w);',
  '}',
  '',
].join('\n')
const dd = readWith(depSrc, { filePath: 'x.js', mode: 'digest' })
check(dd.text.includes('compute') && dd.text.includes('helper'), '自由调用被收进依赖')
check(!/\bclear\b/.test(dd.text.split('external calls:')[1]?.split('\n')[0] ?? ''), '字段名 clear（点号调用）未被当成依赖')
check(dd.text.includes('./h.js'), 'import 来源被列出')

say('')
say('B3. digest 大文件：压缩比与预算')
const bigSrc = fs.readFileSync(BIG, 'utf8')
const bd = readWith(bigSrc, { filePath: BIG, mode: 'digest' })
const bm = readWith(bigSrc, { filePath: BIG, mode: 'map' })
const T = (s) => Math.round(String(s).length / 3.3)
check(bd.ok && bm.ok, '大小文件两模式都可用')
check(T(bigSrc) / T(bd.text) > 8, `digest 压缩 ${(T(bigSrc) / T(bd.text)).toFixed(1)}x（>8x）`)
check(bd.text.length <= CONTENT_BUDGET, `digest 未超内容预算（${bd.text.length}）`)
say(`    全文 ${T(bigSrc)} token · map ${T(bm.text)} token · digest ${T(bd.text)} token`)

// ── C. changed：重读不再重发 ==============================================

say('')
say('=== C. changed：自上次读取以来变了什么 ===')
// 语义经过两次修正：
//   1. 早先要求 (token, previous) 双参数，且把 token 定义成"当前内容的指纹"——
//      调用方手上不可能有当前，于是每次都报"已被外部修改"，模式完全失效。
//   2. 改成传上次结果后，我把全文放进了 `full` 字段。查剪枝实现后确认那是错的：
//      剪枝只作用于 content 里的 text block，**不碰其它字段**，所以 `full` 会原样送到模型手里，
//      节省全部作废。现在全文改由工具有界缓存持有，模型只拿一个小版本令牌。
const c0 = readWith(SRC, { filePath: target, mode: 'changed' })
check(c0.ok && typeof c0.version === 'string', `首次读取返回版本令牌 ${c0.version}`)
check(c0.full === undefined, '返回体里**不含**全文（否则节省作废）')
check(JSON.stringify(c0).length < 400, `首次返回体仅 ${JSON.stringify(c0).length} 字符`)
check(typeof c0.next === 'string' && c0.next.includes('version'), '首次读取说明了下一次怎么用')

const v2 = SRC.replace('  let sum = 0;', '  let sum = 100;')
const c1 = readWith(v2, { filePath: target, mode: 'changed', since: c0.version })
check(c1.ok && c1.text.includes('sum = 100'), '变更后返回变更行')
const c2 = readWith(v2, { filePath: target, mode: 'changed', since: c1.version })
check(c2.note === 'no change since that version', `无变化时明确说明：${c2.note}`)
const c3 = readWith(v2.replace('return sum;', 'return sum * 2;'), { filePath: target, mode: 'changed', since: c1.version })
check(c3.ok && c3.text.includes('sum * 2'), '再次变更仍能正确给出增量')

// 缓存未命中必须诚实降级，不能假装能 diff
const miss = readWith(v2, { filePath: target, mode: 'changed', since: 'never-seen-version' })
check(typeof miss.note === 'string' && miss.note.includes('no longer cached'), `未命中缓存时明确降级：${miss.note}`)
// 意图是"不给伪差异"，不是"不许有 text 字段"：F3 之后无差异/未命中也会给 `text`，
// 但内容只能是**说明** —— 出现文件正文才叫伪差异。按意图断，不按实现断。
check(
  miss.text === undefined || (miss.text.includes('no longer cached') && !miss.text.includes('sum')),
  `未命中时不给出任何伪差异（text=${JSON.stringify(miss.text)}）`,
)

// 大文件上的实际节省 + 返回体必须小
const bigV1 = fs.readFileSync(BIG, 'utf8')
const bigV2 = bigV1.replace('const READ_LIMIT = 2e3;', 'const READ_LIMIT = 4e3;')
const bFirst = readWith(bigV1, { filePath: BIG, mode: 'changed' })
check(JSON.stringify(bFirst).length < 1000, `大文件首次返回体仅 ${JSON.stringify(bFirst).length} 字符（文件 ${bigV1.length}）`)
const bAfter = readWith(bigV2, { filePath: BIG, mode: 'changed', since: bFirst.version })
const ratio = bigV1.length / (bAfter.text?.length || 1)
check(ratio > 50, `大文件改一行：changed 输出 ${bAfter.text.length} 字符，省 ${ratio.toFixed(0)}x`)
check(bAfter.text.includes('READ_LIMIT = 4e3'), '增量里含变更行')
check(!bAfter.text.includes('function newAccumulator'), '增量里不含无关函数（这正是节省的来源）')

// ── D. 边界：第一版完全没碰的输入 ──────────────────────────────────────────

say('')
say('=== D. 边界输入 ===')
const edge = (label, fn, expectOk) => {
  let r
  try {
    r = fn()
  } catch (e) {
    check(false, `${label} 抛异常：${e.message}`)
    return null
  }
  if (expectOk) check(r.ok === true, `${label} 正常返回`, r.ok ? '' : `${r.code}: ${r.message}`)
  else check(r.ok === false && typeof r.code === 'string', `${label} 明确拒绝`, r.code)
  return r
}

edge('空文件 map', () => readWith('', { filePath: 'x.js', mode: 'map' }), true)
edge('空文件 digest', () => readWith('', { filePath: 'x.js', mode: 'digest' }), true)
// 空文件取第 1 行是**合法**的：`''.split('\n')` 得到 `['']`，即一个空行。
// 我一开始把这里断言成"应当拒绝"，那是错的——为它加特判才是补丁。
// 一条空的第 1 行是无害的真话，不是错误。
edge('空文件 lines[1,1]', () => readWith('', { filePath: 'x.js', mode: 'lines', lines: [1, 1] }), true)
edge('空文件 lines[2,2] 越界', () => readWith('', { filePath: 'x.js', mode: 'lines', lines: [2, 2] }), false)
edge('只有换行', () => readWith('\n\n\n', { filePath: 'x.js', mode: 'map' }), true)

// 无换行的超长单行：不能被当成"很多行"，也不能让窗口预算失效
const oneLine = `const blob = "${'x'.repeat(200000)}";`
const ol = edge('20 万字符单行 map', () => readWith(oneLine, { filePath: 'x.js', mode: 'map' }), true)
check(ol !== null && ol.totalLines === 1, `正确识别为 1 行（实数 ${ol?.totalLines}）`)
const olw = readWith(oneLine, { filePath: 'x.js', mode: 'lines', lines: [1, 1] })
check(olw.ok && olw.text.length <= CONTENT_BUDGET, `超长行被预算约束（${olw.text.length}）`)
check(olw.omitted !== undefined || olw.text.includes('截断'), '超长行明确标注被截断')

// CRLF：行号与内容都要对
const crlf = 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n'
const cr = edge('CRLF 文件', () => readWith(crlf, { filePath: 'x.js', mode: 'lines', lines: [2, 2] }), true)
check(cr !== null && cr.text.includes('const b = 2;'), 'CRLF 文件取行正确')
check(cr !== null && !cr.text.includes('\r'), 'CRLF 不在输出里残留裸 \\r')

// 二进制/乱码：结构层不应崩
const binary = '\u0000\u0001\u0002function fake() {}\u0000'
edge('含 NUL 的文件 map', () => readWith(binary, { filePath: 'x.js', mode: 'map' }), true)

// 中文标识符：语言配置里声明支持，这里验它真能用
const cjk = 'function 计算(输入) {\n  return 输入 * 2;\n}\n'
const cj = readWith(cjk, { filePath: 'x.js', mode: 'map' })
check(cj.ok && cj.symbols === 1, `中文标识符被索引（${cj.symbols} 个符号）`)
check(cj.text.includes('计算'), '中文符号名出现在地图里')

// 极深嵌套：不能让递归或预算失控
const deep = `${'if (a) {\n'.repeat(400)}x();\n${'}\n'.repeat(400)}`
const dp = edge('400 层嵌套 map', () => readWith(deep, { filePath: 'x.js', mode: 'map' }), true)
check(dp !== null && dp.text.length <= CONTENT_BUDGET, '深嵌套下预算仍守住')

// 所有模式的输出都不得超预算（对每个边界输入都成立）
say('')
say('=== E. 贯穿断言：任意输入 × 任意模式，输出都不得超预算 ===')
const inputs = [SRC, bigSrc, oneLine, crlf, cjk, deep, '']
let violations = 0
let cases = 0
for (const src of inputs) {
  for (const mode of MODES) {
    const req = { filePath: 'x.js', mode }
    if (mode === 'lines') req.lines = [1, Math.max(1, src.split('\n').length)]
    if (mode === 'around') req.around = 'const'
    if (mode === 'search') req.search = 'const'
    // changed 的 `since` 是一个版本令牌，工具用它在有界缓存里取上次的全文。
    if (mode === 'changed') req.since = readWith(src, { filePath: 'x.js', mode: 'changed' }).version
    const r = readWith(src, req)
    cases += 1
    const size = JSON.stringify(r).length
    if (size > PRUNE_BUDGET) {
      violations += 1
      say(`    ! ${mode} 在 ${src.length} 字符输入上输出 ${size} 字符，超预算`)
    }
  }
}
check(violations === 0, `${cases} 个组合（${inputs.length} 输入 × ${MODES.length} 模式）全部未超预算`, `违规 ${violations}`)

fs.rmSync(tmp, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) process.exitCode = 1
