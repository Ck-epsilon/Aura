/**
 * coverage-test —— 覆盖集（opt-in）的契约。
 *
 * 判据：
 *   ① 只有显式 `--coverage` 才出现（既有回执逐字节不变）；
 *   ② `lines` 读给 covered=请求区间、notCovered=两侧补集；
 *   ③ `full` 读 notCovered 为空；
 *   ④ `map`/`digest` 给结构不给正文 ⇒ covered 为空、notCovered=全文；
 *   ⑤ 区间用字符串（与 `shown` 同一套写法）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const root = path.resolve(here, '..', '..')
const bin = path.join(root, 'src', 'aura-standalone', 'bin', 'aura.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-coverage-'))
const env = { ...process.env, AURA_CACHE_DIR: path.join(tmp, 'cache') }

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}
const run = (args) => {
  const res = spawnSync(process.execPath, [bin, 'basetools', ...args], { cwd: tmp, encoding: 'utf8', env, timeout: 60000 })
  try {
    return JSON.parse(String(res.stdout ?? '').trim())
  } catch {
    return null
  }
}
// 不带结尾换行：总行数在 `lines` 与 `full` 两种模式下是同一个数（结尾空行是否计一行
// 是既有实现里的模式差异，不是本判据要测的东西）。
const body = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')
const target = path.join(tmp, 'cover.txt')
fs.writeFileSync(target, body)

const partial = run(['read', '--file', target, '--lines', '10,20', '--coverage'])
check(partial?.coverage?.totalLines === 40, 'C1 lines 读：totalLines=40')
check(JSON.stringify(partial?.coverage?.covered) === JSON.stringify(['10-20']), 'C2 lines 读：covered=[10-20]', JSON.stringify(partial?.coverage))
check(JSON.stringify(partial?.coverage?.notCovered) === JSON.stringify(['1-9', '21-40']), 'C3 lines 读：notCovered 为两侧补集', JSON.stringify(partial?.coverage?.notCovered))

const full = run(['read', '--file', target, '--mode', 'full', '--coverage'])
check(JSON.stringify(full?.coverage?.covered) === JSON.stringify(['1-40']) && JSON.stringify(full?.coverage?.notCovered) === JSON.stringify([]), 'C4 full 读：covered 全文、notCovered 空', JSON.stringify(full?.coverage))

const map = run(['read', '--file', target, '--mode', 'map', '--coverage'])
check(JSON.stringify(map?.coverage?.covered) === JSON.stringify([]) && JSON.stringify(map?.coverage?.notCovered) === JSON.stringify(['1-40']), 'C5 map 读：正文覆盖为空', JSON.stringify(map?.coverage))

const plain = run(['read', '--file', target, '--lines', '10,20'])
check(plain?.coverage === undefined, 'C6 不带 --coverage：回执里没有 coverage（形状不变）')

const single = run(['read', '--file', target, '--lines', '7', '--coverage'])
check(JSON.stringify(single?.coverage?.covered) === JSON.stringify(['7']) && JSON.stringify(single?.coverage?.notCovered) === JSON.stringify(['1-6', '8-40']), 'C7 单行区间用单个数字表示', JSON.stringify(single?.coverage))

console.log('')
console.log(`--- ${pass} 通过 / ${fail} 失败 ---`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
