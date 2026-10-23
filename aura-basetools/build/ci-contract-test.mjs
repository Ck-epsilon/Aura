/**
 * ci-contract-test.mjs —— CI / 发布闸的**静态契约**。
 *
 * 这里不重复跑套件；它只回答“闸门自己有没有被接上”：
 *   · Linux + Node 22 真的跑完整 `release-check.mjs`；
 *   · Node 18 / 20 有 CLI + MCP 冒烟；
 *   · 跳过套件在闸输出里记 `⏭`，关键套件跳过会让闸红；
 *   · P0/P1 的新套件真的登记在 SUITES 与 CRITICAL_SUITES 里。
 *
 * 运行：node build/ci-contract-test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const root = path.resolve(here, '..')
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
const gate = fs.readFileSync(path.join(root, 'build', 'release-check.mjs'), 'utf8')

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}
const say = (m) => console.log(`\n=== ${m} ===`)

say('A CI 工作流')
check(/full-gate:/.test(workflow) && /runs-on:\s*ubuntu-latest/.test(workflow), 'A1 有 Linux full-gate job')
check(/node-version:\s*22/.test(workflow), 'A2 full-gate 用 Node 22')
check(/node build\/release-check\.mjs/.test(workflow), 'A3 full-gate 真跑 release-check')
check(/smoke:/.test(workflow) && /node:\s*\[18,\s*20\]/.test(workflow), 'A4 smoke 覆盖 Node 18 / 20')
check(/aura-mcp\.mjs/.test(workflow) && /aura_basetools_read/.test(workflow) && /aura_basetools_write/.test(workflow), 'A5 smoke 含 MCP 握手与读写')
check(/aura\.mjs basetools (read|edit|write)/.test(workflow), 'A5b smoke 用 `aura basetools <verb>` 命名空间')
check(/@deepseek-ai\/dsh-tools@0\.2\.1-rc\.2/.test(workflow), 'A6 full-gate 安装宿主 peer（公开包，锁定版本）')

say('B 闸门自身')
check(/CRITICAL_SUITES/.test(gate), 'B1 有 CRITICAL_SUITES')
check(/0\\\/0\|已跳过\|skipped/.test(gate), 'B2 跳过套件的识别谓词在闸里', '')
check(/status\s*=\s*res\.status\s*!==\s*0\s*\?\s*'fail'\s*:\s*skipped\s*\?\s*\(isCritical\s*\?\s*'fail'\s*:\s*'skipped'\)\s*:\s*'ok'/.test(gate), 'B3 关键套件跳过 ⇒ fail，其余 ⇒ skipped')
check(/'⏭'/.test(gate), 'B4 跳过在输出里显示为 ⏭（不计 ✅）')

say('C 新回归套件登记')
for (const name of ['argument-surface', 'single-line-target', 'observation-concurrency']) {
  check(new RegExp(`\\['${name.replace(/[-]/g, '\\-')}',\\s*'`).test(gate), `C ${name} 在 SUITES 里`)
  check(new RegExp(`'${name.replace(/[-]/g, '\\-')}'`).test(gate.slice(gate.indexOf('const CRITICAL_SUITES'), gate.indexOf('const run ='))), `C ${name} 在 CRITICAL_SUITES 里`)
}

say(`\n--- CI 契约：${pass}/${pass + fail} 通过 ---`)
process.exitCode = fail === 0 ? 0 : 1
