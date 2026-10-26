/**
 * docs-surface-test.mjs — published README tool tables vs the live capability manifest.
 *
 * WHERE TO CHANGE:
 *   coreTools / dshTools — table/bullet parsers when a README format changes
 *   checks — the published-contract assertions (tool names, encoding/image boundaries)
 *
 * USED BY:
 *   build/release-check.mjs SUITES ('docs-surface')
 *
 * The npm package READMEs are the agent-facing contract too: 0.23.0 shipped "3 tools",
 * "UTF-8 only" and removed undo/transactions in them. This suite makes that drift red.
 */
import fs from 'node:fs'
import path from 'node:path'
import { buildCapabilities } from '../../build/capabilities.mjs'

const root = path.resolve(import.meta.dirname, '..', '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const cap = buildCapabilities()
const publicNames = cap.tools.map((tool) => tool.name).sort()
let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
}

// ── README tool tables: lines like `| `aura_basetools_x` | ...` or `- `aura_basetools_x``
const tableNames = (text) =>
  [...new Set([...text.matchAll(/^\|\s*`(aura_basetools_[a-z_]+)`\s*\|/gm)].map((m) => m[1]))].sort()
const bulletNames = (text) =>
  [...new Set([...text.matchAll(/^-\s*`(aura_basetools_[a-z_]+)`/gm)].map((m) => m[1]))].sort()

console.log('=== A. 公开工具表 ===')
{
  const core = read('docs/README.npm-core.md')
  const dsh = read('docs/README.npm-dsh.md')
  const coreNames = tableNames(core)
  const dshNames = bulletNames(dsh)
  check(JSON.stringify(coreNames) === JSON.stringify(publicNames), `core README 工具表 = 能力清单（${publicNames.join(', ')}）`, coreNames.join(','))
  check(JSON.stringify(dshNames) === JSON.stringify(publicNames), `DSH README 工具表 = 能力清单（${publicNames.join(', ')}）`, dshNames.join(','))
  for (const legacy of ['aura_basetools_edit', 'aura_basetools_write', 'aura_basetools_convert', 'aura_basetools_tx', 'aura_basetools_undo', 'aura_basetools_transactions']) {
    check(!coreNames.includes(legacy) && !dshNames.includes(legacy), `旧工具名不在公开表里：${legacy}`)
  }
  check(/op=convert/i.test(core) && /image/i.test(core) && /gb18030/i.test(core), 'core README 写清 convert/图片/旧编码')
  check(!/UTF-8 text only|Image reading is not provided|只支持 UTF-8 文本|不提供图片读取/.test(core), 'core README 不再声明 UTF-8-only / 无图片')
  check(dsh.includes('aura_basetools_apply'), 'DSH README 说明 apply 写入口')
}

console.log(`\n--- docs-surface：${pass} 通过 / ${fail} 失败 ---`)
process.exit(fail === 0 ? 0 : 1)
