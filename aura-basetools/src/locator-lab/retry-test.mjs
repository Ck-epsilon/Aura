/**
 * retry-test —— `--retry`（漂移重定位）的契约。
 *
 * 判据：
 *   ① 目标内容**没变、只是位置变了** ⇒ 一次调用改对，回执带 `rebased`（from/to）；
 *   ② 目标内容**变了** ⇒ 仍然拒绝（`--retry` 不是“随便改”，它按旧观测里的原文整行唯一匹配）；
 *   ③ 旧原文在现文里**多处命中** ⇒ 拒绝（无法确定落点）；
 *   ④ `dry_run` 也预演出同一个 `rebased`，且不写盘。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const root = path.resolve(here, '..', '..')
const bin = path.join(root, 'src', 'aura-standalone', 'bin', 'aura.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-retry-'))
const env = { ...process.env, AURA_CACHE_DIR: path.join(tmp, 'cache') }

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}
const say = (line = '') => console.log(line)
const run = (args) => {
  const res = spawnSync(process.execPath, [bin, 'basetools', ...args], { cwd: tmp, encoding: 'utf8', env, timeout: 60000 })
  try {
    return JSON.parse(String(res.stdout ?? '').trim())
  } catch {
    return null
  }
}
const file = (name, content) => {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, content)
  return p
}
const disk = (p) => fs.readFileSync(p, 'utf8')
const code = (r) => r?.code ?? r?.result?.code ?? null

const BODY = 'alpha\nbravo\ncharlie\ndelta\n'

// ── 1. 行号漂移：不重定位时拒绝 ──────────────────────────────────────────
say('=== 1. 行号漂移 ===')
{
  const p = file('r1.txt', BODY)
  run(['read', '--file', p, '--mode', 'full'])
  fs.writeFileSync(p, 'PREFIX\n' + BODY)
  const refused = run(['edit', '--file', p, '--lines', '2', '--replace', 'BRAVO'])
  check(refused?.ok === false && code(refused) === 'PATCH_STALE_REGION', 'R1 漂移后不带 --retry ⇒ PATCH_STALE_REGION', JSON.stringify({ ok: refused?.ok, code: code(refused) }))
  check(disk(p) === 'PREFIX\n' + BODY, 'R2 拒绝时磁盘未动')

  const retried = run(['edit', '--file', p, '--lines', '2', '--replace', 'BRAVO', '--retry'])
  check(retried?.ok === true, 'R3 --retry 一次改对', JSON.stringify({ ok: retried?.ok, code: code(retried) }))
  check(JSON.stringify(retried?.result?.rebased) === JSON.stringify([{ from: [2, 2], to: [3, 3] }]), 'R4 回执带 rebased from/to', JSON.stringify(retried?.result?.rebased))
  check(disk(p).split('\n')[2] === 'BRAVO', 'R5 落点正确（现文第 3 行）')
  check(disk(p).split('\n')[0] === 'PREFIX', 'R6 无关行未被碰')
}

// ── 2. 句柄漂移 ─────────────────────────────────────────────────────────
say('')
say('=== 2. 句柄漂移 ===')
{
  const p = file('r2.txt', BODY)
  const r = run(['read', '--file', p, '--mode', 'lines', '--lines', '2,2'])
  const handle = r?.handle
  check(typeof handle === 'string', 'R7 读一次拿到句柄', JSON.stringify(handle))
  fs.writeFileSync(p, 'LEAD\n' + BODY)
  // 句柄自带“那一段的原文”：内容没变、只是位移时，它**不需要** retry 就能找到新位置。
  const direct = run(['edit', '--file', p, '--handle', handle, '--replace', 'BRAVO'])
  check(direct?.ok === true, 'R8 句柄本身已按内容重定位（无需 retry）', JSON.stringify({ ok: direct?.ok, code: code(direct) }))
  check(disk(p).split('\n')[2] === 'BRAVO', 'R9 句柄落点正确')

  const p2 = file('r2b.txt', BODY)
  const r2 = run(['read', '--file', p2, '--mode', 'lines', '--lines', '2,2'])
  fs.writeFileSync(p2, 'LEAD\n' + BODY)
  const retried = run(['edit', '--file', p2, '--handle', r2?.handle, '--replace', 'BRAVO', '--retry'])
  check(retried?.ok === true, 'R10 句柄 + --retry 同样成功', JSON.stringify({ ok: retried?.ok, code: code(retried) }))
  check(disk(p2).split('\n')[2] === 'BRAVO', 'R11 句柄落点正确（retry 径）')
}

// ── 3. 目标内容变了：仍然拒绝（retry 不是“随便改”） ────────────────────
say('')
say('=== 3. 目标内容变了 ===')
{
  const p = file('r3.txt', BODY)
  run(['read', '--file', p, '--mode', 'full'])
  fs.writeFileSync(p, 'alpha\nBRAVO-X\ncharlie\ndelta\n')
  const refused = run(['edit', '--file', p, '--lines', '2', '--replace', 'BRAVO', '--retry'])
  check(refused?.ok === false && code(refused) === 'PATCH_STALE_REGION', 'R12 旧原文在现文里找不到 ⇒ 拒绝', JSON.stringify({ ok: refused?.ok, code: code(refused) }))
  check(disk(p).includes('BRAVO-X'), 'R13 磁盘未动')
}

// ── 4. 旧原文多处命中：拒绝 ────────────────────────────────────────────
say('')
say('=== 4. 旧原文多处命中 ===')
{
  const p = file('r4.txt', 'alpha\nbravo\nbravo\ndelta\n')
  run(['read', '--file', p, '--mode', 'full'])
  fs.writeFileSync(p, 'LEAD\nalpha\nbravo\nbravo\ndelta\n')
  const refused = run(['edit', '--file', p, '--lines', '2', '--replace', 'BRAVO', '--retry'])
  check(refused?.ok === false, 'R14 现文里两处都能对上 ⇒ 拒绝（不猜）', JSON.stringify({ ok: refused?.ok, code: code(refused) }))
  check(disk(p).split('\n')[3] === 'bravo', 'R15 磁盘未动')
}

// ── 5. dry_run 也预演出 rebased，且不写盘 ──────────────────────────────
say('')
say('=== 5. dry_run ===')
{
  const p = file('r5.txt', BODY)
  run(['read', '--file', p, '--mode', 'full'])
  fs.writeFileSync(p, 'X\n' + BODY)
  const preview = run(['edit', '--file', p, '--lines', '2', '--replace', 'BRAVO', '--dry-run', '--retry'])
  check(preview?.ok === true && preview?.result?.dryRun === true, 'R16 dry_run + retry 成功')
  check(JSON.stringify(preview?.result?.rebased) === JSON.stringify([{ from: [2, 2], to: [3, 3] }]), 'R17 dry_run 回执带同一个 rebased')
  check(disk(p) === 'X\n' + BODY, 'R18 dry_run 不写盘')
}

// ── 6. 预检仍然优先：retry 不能绕过结构闸 ──────────────────────────────
say('')
say('=== 6. 预检优先 ===')
{
  const p = file('r6.md', '# A\n\ntext\n')
  run(['read', '--file', p, '--mode', 'full'])
  fs.writeFileSync(p, 'intro\n# A\n\ntext\n')
  const refused = run(['edit', '--file', p, '--lines', '3', '--replace', 'text\n```\ncode', '--retry'])
  check(refused?.ok === false && code(refused) === 'PATCH_STRUCTURE_BROKEN', 'R19 retry 也过不了结构预检', JSON.stringify({ ok: refused?.ok, code: code(refused) }))
}

say('')
say(`--- ${pass} 通过 / ${fail} 失败 ---`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
