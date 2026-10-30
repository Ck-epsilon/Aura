/**
 * ci-contract-test.mjs —— CI / 发布闸的**静态契约**。
 *
 * 这里不重复跑套件；它只回答“闸门自己有没有被接上”：
 *   · Linux + Node 22 真的跑完整 `release-check.mjs`；
 *   · Node 18 / 20 有 CLI + MCP 冒烟；
 *   · 跳过套件要逐条登记（`SKIP_OK`），未登记的跳过会让闸红；
 *   · 每个套件带**判据条数基线**，少了/多了/没有汇总行都红；
 *   · P0/P1 的新套件真的登记在 SUITES 里、带基线、且**不许自跳**。
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
check(/aura-mcp\.mjs/.test(workflow) && /aura_basetools_read/.test(workflow) && /aura_basetools_apply/.test(workflow), 'A5 smoke 含 MCP 握手与读写')
check(/aura\.mjs basetools (read|edit|write)/.test(workflow), 'A5b smoke 用 `aura basetools <verb>` 命名空间')
check(/@deepseek-ai\/dsh-tools@0\.2\.1-rc\.2/.test(workflow), 'A6 full-gate 安装宿主 peer（公开包，锁定版本）')

say('B 闸门自身')
check(/SKIP_OK/.test(gate), 'B1 有 SKIP_OK（只有逐条写明理由的套件才允许自跳）')
check(/0\\\/0\|已跳过\|skipped/.test(gate), 'B2 跳过套件的识别谓词在闸里', '')
check(/status\s*=\s*why\s*===\s*undefined\s*\?\s*'fail'\s*:\s*'skipped'/.test(gate), 'B3 未登记的跳过 ⇒ fail，登记过才记 skipped')
check(/'⏭'/.test(gate), 'B4 跳过在输出里显示为 ⏭（不计 ✅）')
check(/parsed\.pass\s*!==\s*baseline/.test(gate) && /没有可解析的汇总行/.test(gate), 'B5 每个套件按**判据条数基线**判：少了/多了/没有汇总行都红')
check(/parsed\.fail\s*!==\s*0/.test(gate), 'B6 汇总行自报失败也红（防止套件吞掉失败只 exit 0）')
check(/SCRUBBED_ENV_KEYS/.test(gate) && /env:\s*CHILD_ENV/.test(gate), 'B7 子进程环境由闸决定（剔除 AURA_*/NODE_OPTIONS），不继承开发机 shell')
check(/res\.status\s*!==\s*0\s*\|\|\s*absent\.length\s*>\s*0/.test(gate), 'B8 靶场同时看退出码与三个靶场名（不再只读 ✅ 文本）')

say('C 新回归套件登记')
for (const name of ['argument-surface', 'single-line-target', 'observation-concurrency']) {
  const escaped = name.replace(/[-]/g, '\\-')
  check(new RegExp(`\\['${escaped}',\\s*'[^']+',\\s*\\d+\\]`).test(gate), `C ${name} 在 SUITES 里且带条数基线`)
  check(!new RegExp(`\\['${escaped}',`).test(gate.slice(gate.indexOf('const SKIP_OK'), gate.indexOf('const SCRUBBED_ENV_KEYS'))), `C ${name} 不在 SKIP_OK 里（不许自跳）`)
}

say(`\n--- CI 契约：${pass}/${pass + fail} 通过 ---`)
process.exitCode = fail === 0 ? 0 : 1
