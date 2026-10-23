/**
 * capabilities-test —— 0.9.5：能力清单必须与源码同源。
 *
 * 判据：清单里的语言数/地址档/读模式/限制与环境包声明，逐项等于源码导出值；
 * 任何一项手抄漂了都会在这里红。只 import 生成器，不读散文。
 */
import fs from 'node:fs'
import path from 'node:path'
import { buildCapabilities } from './capabilities.mjs'
import { LANGS } from '../src/locator-lab/struct-core.mjs'
import { FLAT_ADDRESS_KEYS, MT_MAX_TARGETS, MT_POOL } from '../src/locator-lab/args.mjs'
import { CONTENT_BUDGET, DEFAULT_ENVELOPE_ALLOWANCE, DEFAULT_PRUNE_BUDGET, MODES } from '../src/locator-lab/read-core.mjs'
import { HANDLE_MAX_PER_RECEIPT } from '../src/locator-lab/handle-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    pass += 1
    say(`  ✓ ${label}${detail === '' ? '' : `  ${detail}`}`)
  } else {
    fail += 1
    say(`  ✗ ${label}${detail === '' ? '' : `  ${detail}`}`)
  }
}

const cap = buildCapabilities()
const read = cap.tools.find((tool) => tool.name === 'aura_basetools_read')
const edit = cap.tools.find((tool) => tool.name === 'aura_basetools_edit')
const write = cap.tools.find((tool) => tool.name === 'aura_basetools_write')

say('=== A. 工具 / 读模式 / 地址档 ===')
check('A1 三个工具都在', read !== undefined && edit !== undefined && write !== undefined, cap.tools.map((tool) => tool.name).join(','))
check('A2 读模式 = auto + MODES', JSON.stringify(read?.modes) === JSON.stringify(['auto', ...MODES]), JSON.stringify(read?.modes))
for (const kind of ['intent', 'target', 'lines', 'line_cue', 'anchor', 'old', 'context', 'handle', 'position']) {
  check(`A3 地址档含 ${kind}`, edit?.addressKinds.includes(kind), JSON.stringify(edit?.addressKinds))
}
check('A4 地址档与 FLAT_ADDRESS_KEYS 同源', FLAT_ADDRESS_KEYS.every((key) => edit?.addressKinds.includes(key)), FLAT_ADDRESS_KEYS.join(','))
check('A4b 编辑选项含 replace_all', edit?.options?.includes('replace_all'), JSON.stringify(edit?.options))
check('A4c 编辑选项含 require_observation；write 覆写默认带观察闸', edit?.options?.includes('require_observation') && write?.writeSafety?.cli?.includes('observation-gate') && write?.writeSafety?.mcp?.includes('observation-gate'), JSON.stringify({ options: edit?.options, write: write?.writeSafety }))
check('A4d write 选项含 eol', write?.options?.includes('eol'), JSON.stringify(write?.options))
check('A4e aura_basetools_write 在 DSH 面也宣称观察闸/区域闸/回读（不宣称事务/undo/锁）', write?.writeSafety?.dsh?.includes('observation-gate') && write.writeSafety.dsh.includes('stale-region-gate') && write.writeSafety.dsh.includes('byte-verify') && !write.writeSafety.dsh.includes('transaction') && !write.writeSafety.dsh.includes('undo') && !write.writeSafety.dsh.includes('workspace-lock'), JSON.stringify(write?.writeSafety))
check('A5 命令含 doctor', cap.commands.includes('basetools doctor'), cap.commands.join(','))
check('A5b 命令含 capabilities（运行时命令与构建清单同源）', cap.commands.includes('basetools capabilities'), cap.commands.join(','))
check('A5d 命令含 write（整份写入与内置 Write 对齐）', cap.commands.includes('basetools write'), cap.commands.join(','))
check('A5c writeSafety 按入口分：dsh 不宣称 transaction/undo/lock', Array.isArray(edit?.writeSafety?.dsh) && edit.writeSafety.dsh.includes('stale-region-gate') && !edit.writeSafety.dsh.includes('transaction') && !edit.writeSafety.dsh.includes('undo') && !edit.writeSafety.dsh.includes('workspace-lock') && edit.writeSafety.cli.includes('transaction'), JSON.stringify(edit?.writeSafety))

say('')
say('=== B. 语言表与限制 ===')
check('B1 languages 等于 LANGS 的键', JSON.stringify(cap.langs) === JSON.stringify(Object.keys(LANGS).sort()), `${cap.langs.length}`)
check('B2 langsCount 等于实际长度', cap.langsCount === Object.keys(LANGS).length, `${cap.langsCount}`)
check('B3 覆盖常用语言', ['js', 'ts', 'py', 'go', 'rs', 'java', 'c', 'cpp'].every((ext) => cap.langs.includes(ext)), cap.langs.filter((x) => ['js', 'ts', 'py', 'go', 'rs', 'java', 'c', 'cpp'].includes(x)).join(','))
check('B4 限制与源码常量一致', cap.limits.multiTargetsMax === MT_MAX_TARGETS && cap.limits.multiTargetPool === MT_POOL && cap.limits.defaultPruneBudget === DEFAULT_PRUNE_BUDGET && cap.limits.envelopeAllowance === DEFAULT_ENVELOPE_ALLOWANCE && cap.limits.contentBudget === CONTENT_BUDGET && cap.limits.handlesPerReceipt === HANDLE_MAX_PER_RECEIPT, JSON.stringify(cap.limits))

say('')
say('=== C. 包声明（dist 构建后） ===')
{
  const distCore = path.join(import.meta.dirname, '..', 'dist', 'npm', 'aura-basetools', 'package.json')
  if (fs.existsSync(distCore)) {
    check('C1 核心包 DSH-free', cap.packaging.coreDshFree === true, JSON.stringify(cap.packaging))
  } else {
    check('C1 核心包尚未构建（本次跳过 DSH-free 断言）', cap.packaging.coreDshFree === null, String(cap.packaging.coreDshFree))
  }
  check('C2 两个包名正确', cap.packaging.corePackage === 'aura-basetools' && cap.packaging.adapterPackage === 'aura-basetools-dsh', JSON.stringify(cap.packaging))
}

say('')
say(`--- 能力清单：${pass}/${pass + fail} 通过 ---`)
process.exitCode = fail === 0 ? 0 : 1
