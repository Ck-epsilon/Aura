/**
 * layers-test —— 四层寻址的正确性验证。
 *
 * 核心断言不是"能命中"，而是**层层分明**：
 *   · 精确层（target / lines）必须要么命中要么报错，绝不"大概命中"
 *   · 模糊层（lineCue / anchor）在不确定时必须报歧义并给出候选，绝不猜
 *   · 内容校验（assert）对四层都生效——那才是防止"指到错的行"的闸
 */
import fs from 'node:fs'
import { locate, outline } from './locator-api.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

const SRC = [
  'import { helper } from "./helper.js";',
  '',
  '// 模块级说明',
  'export function alpha(input) {',
  '  const first = helper(input);',
  '  if (first) {',
  '    const inner = first.value;',
  '    return inner + 1;',
  '  }',
  '  return 0;',
  '}',
  '',
  'export function beta(other) {',
  '  const second = helper(other);',
  '  return second;',
  '}',
  '',
].join('\n')
const FILE = 'x.js'

say('=== 第 1 层：符号名 ===')
const s1 = locate(SRC, { target: 'alpha', filePath: FILE })
check(s1.ok && s1.tier === 'symbol', `tier=${s1.tier}`, `区间 ${s1.startLine}-${s1.endLine}`)
check(s1.startLine === 4 && s1.endLine === 11, '跨度覆盖整个 alpha（4-11）')
const s1b = locate(SRC, { target: 'no-such-symbol', filePath: FILE })
check(!s1b.ok && s1b.code === 'STRUCT_NOT_FOUND', `不存在的符号被拒：${s1b.code}`)

say('')
say('=== 第 2 层：行号区间（模型从 read 输出里抄的就是行号）===')
const s2 = locate(SRC, { lines: { start: 7, end: 8 }, filePath: FILE })
check(s2.ok && s2.tier === 'lines', `tier=${s2.tier}`, `区间 ${s2.startLine}-${s2.endLine}`)
check(s2.actual.includes('const inner'), '取到的正是第 7-8 行')
check(locate(SRC, { lines: { start: 7 }, filePath: FILE }).endLine === 7, '只给 start 时 end 默认为同一行')
const s2bad = locate(SRC, { lines: { start: 99 }, filePath: FILE })
check(!s2bad.ok && s2bad.code === 'LOCATOR_OUT_OF_RANGE', `越界被拒：${s2bad.code}`)
const s2rev = locate(SRC, { lines: { start: 8, end: 7 }, filePath: FILE })
check(!s2rev.ok, `end < start 被拒：${s2rev.code}`)

say('')
say('=== 第 3 层：单词线索（必须全文件唯一，否则报歧义）===')
const s3 = locate(SRC, { lineCue: 'const inner', filePath: FILE })
check(s3.ok && s3.tier === 'lineCue', `tier=${s3.tier}`, `落在第 ${s3.startLine} 行`)
check(s3.startLine === 7, '命中第 7 行')
const s3amb = locate(SRC, { lineCue: 'helper', filePath: FILE })
check(!s3amb.ok && s3amb.code === 'LOCATOR_CUE_AMBIGUOUS', `不唯一时报歧义：${s3amb.code}`)
// 样本里 `helper` 出现在第 1、5、14 行，共 3 处——断言必须跟着样本走，不能拍一个数
check(s3amb.candidates?.length === 3, `给出 ${s3amb.candidates?.length} 个候选行（样本中 helper 出现 3 次）`)
check(s3amb.candidates?.every((c) => c.text.includes('helper')), '每个候选都带实际内容供模型判定')
const s3near = locate(SRC, { lineCue: 'helper', near: 14, filePath: FILE })
check(s3near.ok && s3near.startLine === 14, `near 收敛到第 ${s3near.startLine} 行`)
const s3none = locate(SRC, { lineCue: '绝不存在的词ZZZ', filePath: FILE })
check(!s3none.ok && s3none.code === 'LOCATOR_CUE_NOT_FOUND', `找不到时报：${s3none.code}`)

say('')
say('=== 第 4 层：文本锚点（容错性最好，但要复现内容）===')
const s4 = locate(SRC, { anchor: '  const second = helper(other);', filePath: FILE })
check(s4.ok && s4.tier === 'exact', `tier=${s4.tier}`)
const s4drift = locate(SRC, { anchor: '    const second = helper(other);', filePath: FILE })
check(s4drift.ok && s4drift.tier === 'norm-space', `缩进漂移仍命中：${s4drift.tier}`)

say('')
say('=== 内容校验（assert）——四层通用，防"指到错的行" ===')
const good = locate(SRC, { lines: { start: 7, end: 7 }, assert: 'const inner = first.value;', filePath: FILE })
check(good.ok, '断言正确时通过')
const bad = locate(SRC, { lines: { start: 8, end: 8 }, assert: 'const inner = first.value;', filePath: FILE })
check(!bad.ok && bad.code === 'LOCATOR_ASSERT_MISMATCH', `断言不符时拒绝：${bad.code}`)
check(typeof bad.actual === 'string' && bad.actual.includes('return inner'), '拒绝时回报实际内容供模型判断')
/**
 * 光有 `actual` 字段**到不了模型**。
 *
 * DSH 框架对抛出的错误只取 `error.message`（`dsh-tools/lib/index.js:2495-2503`），
 * 其余附加字段（`candidates` / `minimal_next` / `actual`）**一概不读**。
 * 所以"让模型看见实际内容"唯一有效的通道是 message 本身。
 *
 * 实测依据（11k 条真实调用）：`expect` 不符 388 条，而**回执里贴出实际内容的 0 条**，
 * 导致 161 组参数完全相同的重复失败（最高一组 17 次），其中 202 次属于这一类。
 * 这三条断言就是把"回执必须自含可修正的信息"钉在测试里。
 */
check(bad.message.includes('return inner'), '拒绝的 message 里含实际内容（否则模型只能盲重试）', bad.message)
check(!bad.message.includes('\n'), 'message 是单行（换行已转成 ⏎，不会把回执结构撑破）')
{
  // 多行区域的换行必须被标出："你以为的三行其实是一行"是常见误判
  const multi = locate(SRC, { lines: { start: 7, end: 9 }, assert: 'nope', filePath: FILE })
  check(!multi.ok && multi.message.includes('⏎'), '多行区域用 ⏎ 标出换行位置', multi.message)
  // 超长原文必须截断并**明说**截了多少（错误回执也占输出预算）
  const longSrc = 'const X = "' + 'y'.repeat(600) + '"\n'
  const long = locate(longSrc, { lines: { start: 1, end: 1 }, assert: 'const X = 1', filePath: 'x.mjs' })
  check(!long.ok && /more chars withheld/.test(long.message), '超长原文截断并写明截掉多少', String(long.message).slice(-60))
  check(!long.ok && long.message.length < 700, '截断后的 message 仍在预算内', String(long.message.length))
}
const badSym = locate(SRC, { target: 'alpha', assert: '完全不同的内容', filePath: FILE })
check(!badSym.ok && badSym.code === 'LOCATOR_ASSERT_MISMATCH', 'assert 对符号层同样生效')
const ws = locate(SRC, { lines: { start: 7, end: 7 }, assert: '  const   inner = first.value;  ', filePath: FILE })
check(ws.ok, '断言按空白归一化比较（不因空格差异误杀）')

say('')
say('=== 优先级：给了多层时谁赢 ===')
const pri = locate(SRC, { target: 'alpha', lines: { start: 7, end: 7 }, lineCue: 'const inner', anchor: 'return 0;', filePath: FILE })
check(pri.tier === 'symbol', `target 优先：${pri.tier}`)
const pri2 = locate(SRC, { lines: { start: 7, end: 7 }, lineCue: 'const inner', anchor: 'return 0;', filePath: FILE })
check(pri2.tier === 'lines', `其次 lines：${pri2.tier}`)
const pri3 = locate(SRC, { lineCue: 'const inner', anchor: 'return 0;', filePath: FILE })
check(pri3.tier === 'lineCue', `再次 lineCue：${pri3.tier}`)

say('')
say('=== 无请求时明确报错，而不是瞎猜 ===')
const none = locate(SRC, { filePath: FILE })
check(!none.ok && none.code === 'LOCATOR_NO_REQUEST', `${none.code}: ${none.message}`)

say('')
say('=== 第 2 层能覆盖到符号层够不到的地方（if 块内部）===')
// `if` 不是符号，因此符号层无法寻址第 7 行；行号层可以
const innerSym = outline(SRC, FILE).find((s) => s.name === 'inner')
check(innerSym !== undefined, `第 7 行有符号 inner（${innerSym?.startLine}-${innerSym?.endLine}）`)
const ifLine = locate(SRC, { lines: { start: 6, end: 9 }, filePath: FILE })
check(ifLine.ok, `if 块整体（6-9）可由行号层寻址`)
const bySym = locate(SRC, { target: 'alpha', filePath: FILE })
check(bySym.startLine === 4 && bySym.endLine === 11, 'if 块只能由外层符号 alpha 粗粒度覆盖')

const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) process.exitCode = 1
