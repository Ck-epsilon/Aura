/**
 * adapters.mjs —— 证明 lab 层是真正框架无关的：同一套定位引擎，三种不同形状的 agent 框架适配。
 *
 * 这不是"三种实现的对比"，而是"一个引擎 + 三个薄适配器"的演示。每个适配器只做两件事，
 * 且都是**框架自己的事**：
 *   1. 用框架自己的 fs 能力把文件读成字符串（带它自己的沙箱/权限/观察策略）
 *   2. 用框架自己的写回能力落盘（带它自己的原子性/审批/审计）
 *
 * 定位、匹配、消歧、符号解析全部来自 `locator-api.mjs` 与 `anchor-core.mjs`，一行都不用改。
 * 这三个适配器加起来不到 120 行——它们之所以能这么薄，是因为难的部分已经在引擎里了。
 */

import fs from 'node:fs'
import { locate, outline, references, spanQuality, SUPPORTED_EXTENSIONS, directoryHint } from './locator-api.mjs'
// `langOf` 用于"未配置扩展名"的判据：负向样本必须**构造得出来**，
// 不能拿"某个扩展名恰好还没被支持"充数（旧断言用 `.hs`，语言表登记 Haskell 后就恒为红了）。
import { langOf } from './struct-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)

// ── 适配器 1：无框架（裸函数）──────────────────────────────────────────────
// 任何自己写循环调 LLM 的人都能直接这样用。没有 ctx、没有插件系统、没有 schema。
export function applyEditPlain({ path, target, anchor, near, replace }) {
  const source = fs.readFileSync(path, 'utf8')
  const found = locate(source, { target, anchor, near, filePath: path })
  if (!found.ok) return { ok: false, error: found }
  const lines = source.split('\n')
  const next = [...lines.slice(0, found.startLine - 1), ...replace.split('\n'), ...lines.slice(found.endLine)].join('\n')
  fs.writeFileSync(path, next, 'utf8')
  return { ok: true, region: [found.startLine, found.endLine], tier: found.tier, before: found.actual }
}

// ── 适配器 2：OpenAI 风格 function-calling ─────────────────────────────────
// 工具就是 "name + JSON Schema + 一个执行函数"。引擎不知道 OpenAI 的存在。
export const OPENAI_TOOL_SCHEMA = {
  type: 'function',
  function: {
    name: 'edit_file',
    description:
      'Edit a file by symbol name (preferred) or by an anchor of remembered text. Locating by symbol skips all text matching.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path' },
        target: { type: 'string', description: 'Symbol name, e.g. `toTodoList` or `function:apply`' },
        anchor: { type: 'string', description: 'Remembered text; may carry whitespace drift' },
        near: { type: 'integer', description: 'Line-number hint for an ambiguous anchor' },
        replace: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'replace'],
    },
  },
}

export function runOpenAIToolCall(call) {
  const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments
  const result = applyEditPlain(args)
  // 失败时把符号目录包进 tool 返回值——模型下一轮就能改用 target
  return { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result.ok ? result : { error: result.error }) }
}

// ── 适配器 3：MCP 风格（JSON-RPC over stdio 的 handler 形状）───────────────
// MCP 工具返回 content 数组。同样只做转接。
export const MCP_TOOLS = [
  {
    name: 'edit_by_symbol',
    description: 'Edit a region located by symbol name. Skips text matching entirely.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        target: { type: 'string' },
        replace: { type: 'string' },
      },
      required: ['path', 'target', 'replace'],
    },
  },
  {
    name: 'outline_file',
    description: 'List the symbols in a source file (name, kind, line range).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
]

export function handleMcpTool(name, args) {
  if (name === 'outline_file') {
    const symbols = outline(fs.readFileSync(args.path, 'utf8'), args.path)
    if (symbols === null) return { content: [{ type: 'text', text: `unsupported extension; supported: ${SUPPORTED_EXTENSIONS.join(', ')}` }], isError: true }
    return { content: [{ type: 'text', text: symbols.map((s) => `${s.kind} ${s.name} (${s.startLine}-${s.endLine})`).join('\n') }] }
  }
  if (name === 'edit_by_symbol') {
    const r = applyEditPlain({ path: args.path, target: args.target, replace: args.replace })
    return r.ok
      ? { content: [{ type: 'text', text: `edited lines ${r.region[0]}-${r.region[1]} via ${r.tier}` }] }
      : { content: [{ type: 'text', text: JSON.stringify(r.error) }], isError: true }
  }
  return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true }
}

// ── 自测：三个适配器共享同一个引擎，行为必须一致 ───────────────────────────

const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

const SRC = [
  'function alpha() {',
  '  const a = 1;',
  '  return a;',
  '}',
  '',
  'function beta() {',
  '  const b = 2;',
  '  return b;',
  '}',
  '',
].join('\n')

const tmp = `${process.env.TEMP ?? '/tmp'}\\locator-adapters-${Date.now()}`
fs.mkdirSync(tmp, { recursive: true })
const p = `${tmp}\\sample.js`

say('=== 1. 裸函数适配器 ===')
fs.writeFileSync(p, SRC, 'utf8')
const r1 = applyEditPlain({ path: p, target: 'beta', replace: 'function beta() {\n  const b = 42;\n  return b;\n}' })
check(r1.ok === true, `符号定位命中 tier=${r1.tier}`, `区间 ${r1.region?.join('-')}`)
check(fs.readFileSync(p, 'utf8').includes('const b = 42;'), '落盘正确')

say('')
say('=== 2. OpenAI function-calling 适配器 ===')
fs.writeFileSync(p, SRC, 'utf8')
const r2 = runOpenAIToolCall({ id: 'call_1', arguments: JSON.stringify({ path: p, target: 'alpha', replace: 'function alpha() {\n  return 7;\n}' }) })
const body2 = JSON.parse(r2.content)
check(body2.ok === true, `tool 返回值 ok，tier=${body2.tier}`)
check(r2.role === 'tool' && r2.tool_call_id === 'call_1', '返回了正确的 tool_call_id')
check(fs.readFileSync(p, 'utf8').includes('return 7;'), '落盘正确')

say('')
say('=== 3. MCP 适配器 ===')
fs.writeFileSync(p, SRC, 'utf8')
const r3a = handleMcpTool('outline_file', { path: p })
check(!r3a.isError && r3a.content[0].text.includes('beta'), 'outline 列出符号')
const r3b = handleMcpTool('edit_by_symbol', { path: p, target: 'beta', replace: 'function beta() {\n  return 99;\n}' })
check(!r3b.isError, `edit_by_symbol 成功：${r3b.content[0].text}`)
check(fs.readFileSync(p, 'utf8').includes('return 99;'), '落盘正确')

say('')
say('=== 4. 失败时的符号目录在三个适配器里都可用 ===')
fs.writeFileSync(p, SRC, 'utf8')
const fail = applyEditPlain({ path: p, anchor: '完全不存在的内容ZZZ\n也不存在YYY', replace: 'x' })
check(fail.ok === false, '锚点失败被正确报告')
check(fail.error.hint?.symbols?.some((s) => s.name === 'beta'), '失败回执带符号目录（含 beta）')
check(typeof fail.error.hint?.instruction === 'string', '目录带可执行指令')
/**
 * 目录的**收录条数**：默认必须是"装得下的全给"，而不是一个拍死的条数。
 *
 * 历史：这里曾经写死 24 条（注释自称"能放下的 24 个"，但没有任何东西在量），
 * 后来又改成 754 字符（旧 24 条的字节量）。两次都是同一个错——
 * **用输出预算去替代"有多少是有用的"这个判断**。
 *
 * 硬约束只有一个：`dsh-compaction-tool-result-pruner` 对超过 8192 字符的工具结果
 * 保留 前 4096 + marker + 后 1024（实测确认该剪枝**不区分 isError**）。
 * 实测本仓库最大的目录是 `build/upgrade-test.mjs`：159 符号 / 5490 字节，离上限还有 2702。
 * 所以默认给足，并且必须**报出被截了多少**（truncated）。
 */
check(fail.error.hint?.shown === fail.error.hint?.total, `默认给全部符号（${fail.error.hint?.shown}/${fail.error.hint?.total}）`)
check(fail.error.hint?.truncated === 0, '未被截时 truncated 为 0')
{
  // 夹具必须**足够多**符号才会真的触到预算：只有 2 个符号时"装得下就不该截"，
  // 用这种夹具去断言"一定会截"是断言写错了（循环还保证至少收一条）。
  const many = Array.from({ length: 40 }, (_, i) => `export function fn${i}(a) {\n  return a\n}`).join('\n')
  const manyFile = `${tmp}\\many.mjs`
  fs.writeFileSync(manyFile, many, 'utf8')
  const lang = langOf(manyFile)
  const tight = directoryHint(many, lang, 200)
  check(tight.total === 40, `夹具确实有 40 个符号（实得 ${tight.total}）`)
  check(tight.shown < tight.total && tight.truncated > 0, `预算收紧时确实会截且如实报数（${tight.shown}/${tight.total}，截 ${tight.truncated}）`)
  check(tight.truncated === tight.total - tight.shown, 'truncated 与 shown/total 自洽')
  const row = (s) => `  ${s.kind} ${s.name} (lines ${s.startLine}-${s.endLine})${s.exported ? ' ★' : ''}`
  check(tight.symbols.map(row).join('\n').length <= 200, '收紧时渲染不超该预算')
  // 反向：预算给足就必须全给——否则"默认全给"这条会因为别的原因假绿
  const roomy = directoryHint(many, lang, 100000)
  check(roomy.shown === roomy.total && roomy.truncated === 0, `预算给足时全给（${roomy.shown}/${roomy.total}）`)
}

say('')
say('=== 5. 语言无关：同一适配器处理 Python / Go ===')
const py = `${tmp}\\s.py`
fs.writeFileSync(py, 'def hello():\n    return 1\n', 'utf8')
const r5 = applyEditPlain({ path: py, target: 'hello', replace: 'def hello():\n    return 2' })
check(r5.ok === true, `Python 符号定位 tier=${r5.tier}`)
check(fs.readFileSync(py, 'utf8').includes('return 2'), 'Python 落盘正确')

say('')
say('=== 6. 引擎的额外面向（outline / references / 跨度质量）===')
fs.writeFileSync(p, SRC, 'utf8')
check(Array.isArray(outline(SRC, 'x.js')), `outline 返回 ${outline(SRC, 'x.js').length} 个符号`)
check(Array.isArray(references(SRC, 'x.js', 'a')), `references('a') 命中 ${references(SRC, 'x.js', 'a').length} 处`)
check(spanQuality(SRC, 'x.js', 1, 4) === 1, '完整函数体的跨度质量 = 1')
check(spanQuality(SRC, 'x.js', 1, 2) < 1, '截断区间质量 < 1')

say('')
say('=== 7. 语言覆盖的边界：支持的必须对，不支持的必须明说 ===')
// Ruby 现在是支持的（配置表里有），所以断言从"应被拒绝"改成"必须正确工作"。
// 原来的断言是"Ruby 未配置 → outline 返回 null"——加语言之后它必然失败，
// 这正是测试在盯着真实行为，而不是被顺手改掉。
const rbSrc = 'class Foo\n  def bar\n    1\n  end\nend\n'
const rbSymbols = outline(rbSrc, 'x.rb')
check(Array.isArray(rbSymbols) && rbSymbols.length > 0, `Ruby 现在被支持：${JSON.stringify(rbSymbols?.map((s) => s.kind + ':' + s.name))}`)
check(rbSymbols?.some((s) => s.name === 'Foo'), 'Ruby 类被识别')
check(rbSymbols?.some((s) => s.name === 'bar'), 'Ruby 方法被识别')

// 真正未配置的语言仍必须被明确拒绝，而不是猜。
//
// 这里原本用 `.hs` 当"未配置"的样本，而语言表后来把 Haskell 登记了（0.5.x 扩到 65 种），
// 于是这两条断言**恒为红**——而且它不在 `release-check` 的套件清单里，所以没人发现。
// 教训：拿"某个具体扩展名恰好还没被支持"当负向样本，会随语言表漂移；
// 判据应当对**任何**扩展名都成立。
check(outline(SRC, 'x.hs') !== null, 'Haskell 现在已登记（旧断言写于未登记时，已随语言表更新）')
const UNKNOWN_EXT = 'x.zzz-unconfigured'
check(langOf(UNKNOWN_EXT) === null, `真正未配置的扩展名识别为未配置：${UNKNOWN_EXT}`)
check(outline(SRC, UNKNOWN_EXT) === null, '未配置扩展名 → outline 返回 null（而不是瞎猜）')
const unkFile = `${tmp}\\x.zzz-unconfigured`
fs.writeFileSync(unkFile, 'whatever\n', 'utf8')
const unk = handleMcpTool('outline_file', { path: unkFile })
check(unk.isError === true, `未配置语言被明确拒绝：${unk.content[0].text.slice(0, 46)}`)
// 反向对照：无论语言表怎么长，**至少有一个**扩展名必须未被配置——
// 否则上面那条"未配置被拒"会因为构造不出未配置而变成空洞断言。
check(langOf(UNKNOWN_EXT) === null, '未配置语言是构造得出来的（负向断言不会空洞）')

fs.rmSync(tmp, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) process.exitCode = 1
