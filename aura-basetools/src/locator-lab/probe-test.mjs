/**
 * probe-test —— `mode=probe` 的判据（0.21）。
 *
 * ## 它为什么存在
 *
 * 调用方常见的意图是“先看一眼这文件值不值得读”，而不是“把内容给我”。
 * 旧做法要么整份读（付正文的钱），要么猜（读一半再停）。`probe` 把这件事变成一次调用：
 * 行数、字节数、行尾、编码、语言/文档类型、结构规模——**一个正文字节都不发**。
 *
 * ## 判据钉什么
 *
 *   · 元信息是**真的**：字节数来自文件本身（非 UTF-8 也算对）、编码来自探测；
 *   · 不发正文：`text` 只是一行摘要，不能包含文件内容；
 *   · **不冒充交付**：probe 之后再来一次 `full` 仍必须给正文（不能把它当成“你有全文了”）；
 *   · 模式名合法：`MODES` 含 `probe`，`auto` 不会自己选它；乱写的模式仍是 `READ_BAD_MODE`。
 *
 * 运行：node src/locator-lab/probe-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { MODES, createMemoryStore, readWith, setObservationStore, suggestMode } from './read-core.mjs'
import { encodeText } from '../aura-standalone/lib/encoding.mjs'

setObservationStore(createMemoryStore())

const results = []
const say = (line = '') => console.log(line)
const check = (ok, label, detail = '') => {
  results.push({ ok: Boolean(ok), label })
  say(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const root = path.resolve(here, '..', '..')
const bin = path.join(root, 'src', 'aura-standalone', 'bin', 'aura.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-probe-'))
const env = { ...process.env, AURA_CACHE_DIR: path.join(tmp, 'cache') }
const run = (args) => spawnSync(process.execPath, [bin, 'basetools', ...args], { cwd: tmp, encoding: 'utf8', env, timeout: 60000 })
const json = (res) => {
  try {
    return JSON.parse(String(res.stdout ?? '').trim())
  } catch {
    return null
  }
}

// ── A. 引擎面：字段是“可复算的事实”，不是猜的 ────────────────────────────────
say('=== A. 引擎面：行数 / 字节 / 行尾 / 类型 / 结构 ===')
{
  const md = '# A\r\n\r\ntext\r\n'
  const p = readWith(md, { filePath: '/tmp/a.md', mode: 'probe' })
  check(p.ok === true && p.mode === 'probe', 'A1 probe 成功且 mode=probe')
  check(p.totalLines === 4, `A2 行数 4（实际 ${p.totalLines}）`)
  check(p.bytes === Buffer.byteLength(md), `A3 字节数 ${p.bytes}`)
  check(p.lineEndings === 'crlf', `A4 行尾 crlf（实际 ${p.lineEndings}）`)
  check(p.docKind === 'markdown', `A5 文档类型 markdown（实际 ${p.docKind}）`)
  check(p.structure === '1 section', `A6 结构规模 "1 section"（实际 ${p.structure}）`)
  check(!p.text.includes('text\r\n') && p.text.length < 120, 'A7 正文没被复制（text 只有一行摘要）', p.text)

  const js = 'export const a = 1\nfunction f() {\n  return 2\n}\n'
  const j = readWith(js, { filePath: '/tmp/b.mjs', mode: 'probe' })
  check(j.language === 'mjs' && /symbols$/.test(String(j.structure)), `A8 代码文件给 language 与符号数（${j.language} / ${j.structure}）`)

  const mixed = 'a\r\nb\nc\r\n'
  const m = readWith(mixed, { filePath: '/tmp/c.txt', mode: 'probe' })
  check(m.lineEndings === 'mixed', `A9 混合行尾报 mixed（实际 ${m.lineEndings}）`)
}

// ── B. 不冒充交付：probe 之后 full 仍给正文 ─────────────────────────────────
say('')
say('=== B. probe 不写“已交付”账本 ===')
{
  const src = 'alpha\nbravo\ncharlie\n'
  const p = readWith(src, { filePath: '/tmp/delivery.txt', mode: 'probe' })
  check(p.ok === true, 'B1 probe 成功')
  const full = readWith(src, { filePath: '/tmp/delivery.txt', mode: 'full' })
  check(full.ok === true && String(full.text ?? '').includes('bravo'), 'B2 probe 之后的 full 仍给正文（没有谎报 no-change）', String(full.text ?? '').slice(0, 80))
}

// ── C. 命令行面：非 UTF-8 的字节数与编码 ─────────────────────────────────────
say('')
say('=== C. CLI：非 UTF-8 文件的字节数来自文件本身 ===')
{
  const target = path.join(tmp, 'gbk.txt')
  const bytes = encodeText('中文测试\r\n第二行\r\n', { encoding: 'gb18030', bom: [] })
  fs.writeFileSync(target, bytes)
  const p = json(run(['read', '--file', target, '--mode', 'probe', '--pretty']))
  check(p?.ok === true && p.mode === 'probe', 'C1 CLI probe 成功', JSON.stringify(p?.code))
  check(p?.bytes === bytes.length, `C2 字节数 = 文件真实大小 ${bytes.length}（实际 ${p?.bytes}）`)
  check(p?.encoding === 'gb18030', `C3 编码 = gb18030（实际 ${p?.encoding}）`)
  check(String(p?.text ?? '').length < 120, 'C4 回执仍然只有一行摘要')
}

// ── C2. 多目标：targets 里的 probe 同样只给元信息 ────────────────────────────
say('')
say('=== C2. targets 批量的 probe ===')
{
  const { readManyWith } = await import('./read-core.mjs')
  const { openProvider } = await import('../aura-standalone/lib/ops.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-probe-mt-'))
  fs.writeFileSync(path.join(dir, 'p1.md'), '# A\n\ntext\n')
  fs.writeFileSync(path.join(dir, 'p2.mjs'), 'export const a = 1\n')
  const provider = openProvider(dir)
  const batch = await readManyWith(provider, [
    { file_path: path.join(dir, 'p1.md'), mode: 'probe' },
    { file_path: path.join(dir, 'p2.mjs'), mode: 'probe' },
  ])
  const envs = (batch.entries ?? []).map((entry) => entry.envelope ?? entry)
  check(batch.ok !== false && envs.length === 2, `C2-1 两条逐项回执（实际 ${envs.length}）`)
  check(envs.every((env) => env?.ok === true && env.mode === 'probe'), 'C2-2 每项都是 probe', JSON.stringify(envs.map((env) => env?.mode)))
  check(envs[0]?.docKind === 'markdown' && envs[1]?.language === 'mjs', 'C2-3 文档与代码各自给类型', JSON.stringify({ a: envs[0]?.docKind, b: envs[1]?.language }))
}

// ── D. 模式面：probe 在 MODES 里，auto 不选它 ───────────────────────────────
say('')
say('=== D. 模式面 ===')
{
  check(MODES.includes('probe'), 'D1 MODES 含 probe')
  const big = Array.from({ length: 300 }, (_, i) => `export const v${i} = ${i}`).join('\n')
  const auto = suggestMode(big, '/tmp/big.mjs', 8192)
  check(auto.mode !== 'probe', `D2 auto 不会自己选 probe（选了 ${auto.mode}）`)
  const bad = readWith('x\n', { filePath: '/tmp/x.txt', mode: 'probeX' })
  check(bad.ok === false && bad.code === 'READ_BAD_MODE', 'D3 未知模式仍是 READ_BAD_MODE', String(bad.code))
}

say('')
const failed = results.filter((r) => !r.ok)
say(`断言总数 ${results.length}，失败 ${failed.length}`)
for (const f of failed) say(`  FAIL ${f.label}`)
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
