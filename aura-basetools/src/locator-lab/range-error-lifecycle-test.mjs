/**
 * range-error-lifecycle —— 错误闭环靶场（进闸；0.22）。
 *
 * 它不重复写 13 类故障的搭建代码：那些在 `probes/error-lifecycle.mjs` 里（探针只测量、恒 exit 0）。
 * 这里做的是**断言**：探针量出来的矩阵必须满足下面的契约，否则红。
 *
 * 判据（每一条都对应“正道”里的一个时间）：
 *   ① 13 类故障全部**预检**（写入前被拒 / 读被拒），没有一条静默落盘；
 *   ② 13 类全部**定位**（回执点名区域/候选/原因，不是一句泛泛的失败）；
 *   ③ 对照组 4 条合法编辑**误拒 = 0**（预检不能变成噪声）；
 *   ④ 一次修复：除两条**按设计**不可一次修复的（二进制目标不可改；目标内容已变必须重读），
 *      其余 11 条都能在一条后续调用里改对。
 *
 * 跑法：node src/locator-lab/range-error-lifecycle-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const root = path.resolve(here, '..', '..')
const probe = path.join(root, 'probes', 'error-lifecycle.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-errlife-range-'))
const jsonPath = path.join(tmp, 'matrix.json')

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}

if (!fs.existsSync(probe)) {
  console.log(`✗ 故障探针不存在：${probe}`)
  process.exit(1)
}
const res = spawnSync(process.execPath, [probe, `--json=${jsonPath}`], { cwd: root, encoding: 'utf8', timeout: 900000 })
if (res.status !== 0 || !fs.existsSync(jsonPath)) {
  console.log('✗ 故障探针本身没有跑完（exit ' + res.status + '）')
  console.log(String(res.stdout ?? '').slice(-1200))
  console.log(String(res.stderr ?? '').slice(-1200))
  process.exit(1)
}
const matrix = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
const faults = matrix.results.filter((row) => !String(row.id).startsWith('control'))
const controls = Array.isArray(matrix.controls) ? matrix.controls : []

check(faults.length >= 13, `故障矩阵至少 13 类（实得 ${faults.length}）`)
const notPreempted = faults.filter((row) => row.preempt !== true)
check(notPreempted.length === 0, '① 每一类故障都在写入前被拦住', notPreempted.map((row) => row.id).join(','))
const notLocalized = faults.filter((row) => row.localized !== true)
check(notLocalized.length === 0, '② 每一类的回执都点名到区域/候选/原因', notLocalized.map((row) => row.id).join(','))
const rejected = controls.filter((row) => row.ok !== true)
check(rejected.length === 0, `③ 对照组 ${controls.length} 条合法编辑误拒 0`, rejected.map((row) => row.id).join(','))

/** 按设计不可一次修复的两条：二进制目标（本就不该改）、目标内容已变（必须重读后重判）。 */
const BY_DESIGN_UNFIXABLE = new Set(['binary-target', 'handle-stale'])
const unfixable = faults.filter((row) => row.fixable !== true).map((row) => row.id)
const unexpected = unfixable.filter((id) => !BY_DESIGN_UNFIXABLE.has(id))
check(unexpected.length === 0, '④ 一次修复：除两条按设计例外，其余都能一条调用改对', unexpected.join(','))
check(
  unfixable.length === BY_DESIGN_UNFIXABLE.size,
  `④ 按设计例外恰好 ${BY_DESIGN_UNFIXABLE.size} 条（实得 ${unfixable.length}：${unfixable.join(',') || '无'}）`,
)

console.log('')
console.log(`--- ${pass} 通过 / ${fail} 失败 ---`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
