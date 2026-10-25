/**
 * capabilities —— 0.9.5：能力清单（机器可读，从源码单一来源派生）。
 *
 * 为什么需要：README 与 schema 各说一部分能力（地址档、读模式、语言数、限制），
 * 消费方（agent / 插件市场 / 评测）只能从散文里猜。这里把**可枚举的事实**从源码直接导出：
 *   · `langs` 来自 `struct-core` 的 `LANGS`（不手抄语言数）；
 *   · 地址档来自 `args.mjs` 的 `FLAT_ADDRESS_KEYS` + 内容地址/句柄从属键；
 *   · 读模式来自 `read-core` 的 `MODES`；
 *   · 限制来自 `args` / `read-core` / `handle-core` 的导出常量。
 * 任何一处源码变了而清单没重建，`capabilities-test` 会红。
 *
 * 跑法：
 *   node build/capabilities.mjs            # 打印摘要
 *   node build/capabilities.mjs --json     # 机器读
 *   node build/capabilities.mjs --write    # 写 dist/capabilities.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LANGS } from '../src/locator-lab/struct-core.mjs'
import { FLAT_ADDRESS_KEYS, MT_MAX_TARGETS, MT_POOL } from '../src/locator-lab/args.mjs'
import {
  CONTENT_BUDGET,
  DEFAULT_ENVELOPE_ALLOWANCE,
  DEFAULT_PRUNE_BUDGET,
  MODES,
} from '../src/locator-lab/read-core.mjs'
import { HANDLE_MAX_PER_RECEIPT } from '../src/locator-lab/handle-core.mjs'
import { SUPPORTED_ENCODINGS } from '../src/aura-standalone/lib/encoding.mjs'

const root = path.resolve(import.meta.dirname, '..')
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

/**
 * 清单本体。**只放可枚举的事实**，不放散文承诺：
 *   · `addressKinds` 是编辑入口认的地址名（与 `FLAT_ADDRESS_KEYS` 同源 + 内容/句柄从属键）；
 *   · `readModes` 含 `auto`（它不是 `MODES` 里的显式模式，但对调用方可见）。
 */
export function buildCapabilities() {
  const version = readJson(path.join(root, 'src', 'aura-read', 'package.json')).version
  const corePkg = path.join(root, 'dist', 'npm', 'aura-basetools', 'package.json')
  const core = fs.existsSync(corePkg) ? readJson(corePkg) : null
  const dshDeps = core === null
    ? null
    : Object.keys({ ...core.dependencies, ...core.peerDependencies, ...core.optionalDependencies }).filter((name) => name.startsWith('@deepseek-ai/'))
  return {
    tool: 'aura-basetools',
    version,
    generatedAt: new Date().toISOString(),
    tools: [
      { name: 'aura_basetools_read', modes: ['auto', ...MODES] },
      {
        name: 'aura_basetools_edit',
        addressKinds: [...new Set([...FLAT_ADDRESS_KEYS, 'old', 'context', 'position'])],
        options: ['replace_all', 'require_observation', 'verify'],
        /**
         * 寻址安全等级（反馈 D7）：机器可读地说明“哪种地址自带校验”。
         * 旧清单只有按**入口**分的 writeSafety，读起来像“写都被 gate”，
         * 而 line 寻址在未观察过的文件上确实不设闸（回执标 unverified_region）。
         *
         *   · contentVerified：地址本身就是内容/版本（错了字就匹配不上/句柄过期）；
         *   · structural：按符号名定位，文件漂移后仍能命中同名符号；
         *   · coordinate：按坐标/线索定位，未观察过的文件上无基准可校 —— 默认不设闸，
         *     需 `require_observation` 强制。
         */
        addressSafety: {
          contentVerified: ['old', 'handle'],
          structural: ['target'],
          coordinate: ['lines', 'start_line', 'end_line', 'line_cue', 'anchor'],
          coordinateNeedsObservation: false,
        },
        /**
         * 写安全能力按**入口**分：CLI/MCP 的 envelope 才有工作区锁；
         * DSH 壳只经过引擎的陈旧闸门与回读校验，不能跟着宣称同一组能力。
         * 0.14.0 移除了公开 undo/transactions；事务日志仅内部失败回滚。
         */
        writeSafety: {
          cli: ['workspace-lock', 'stale-region-gate', 'byte-verify'],
          mcp: ['workspace-lock', 'stale-region-gate', 'byte-verify'],
          dsh: ['stale-region-gate', 'byte-verify'],
        },
      },
      {
        name: 'aura_basetools_tx',
        actions: ['begin', 'commit', 'rollback', 'status'],
        options: ['verify'],
      },
      {
        name: 'aura_basetools_write',
        operations: ['create', 'overwrite'],
        options: ['eol', 'verify'],
        writeSafety: {
          cli: ['workspace-lock', 'stale-region-gate', 'observation-gate', 'byte-verify'],
          mcp: ['workspace-lock', 'stale-region-gate', 'observation-gate', 'byte-verify'],
          // DSH 壳没有工作区锁；它经过引擎的区域闸、严格新鲜度与回读校验。
          dsh: ['stale-region-gate', 'observation-gate', 'byte-verify'],
        },
      },
    ],
    commands: ['basetools read', 'basetools edit', 'basetools write', 'basetools tx', 'basetools mcp', 'basetools doctor', 'basetools capabilities', '--version', '--help'],
    langs: Object.keys(LANGS).sort(),
    langsCount: Object.keys(LANGS).length,
    // 可读可写的编码（实测过的探测 + 回编码）。非 UTF-8 不再拒绝；不可逆/猜不准时**写**拒绝。
    textEncodings: [...SUPPORTED_ENCODINGS],
    // `map` 能给出结构目录的文档/配置类型（代码语言看 `langs`）。
    docKinds: ['markdown', 'json', 'yaml', 'toml'],
    limits: {
      multiTargetsMax: MT_MAX_TARGETS,
      multiTargetPool: MT_POOL,
      defaultPruneBudget: DEFAULT_PRUNE_BUDGET,
      envelopeAllowance: DEFAULT_ENVELOPE_ALLOWANCE,
      contentBudget: CONTENT_BUDGET,
      // `full` = up to budget（反馈 D5）：能被 `budget` 顶大，但没有“一次给全”的保证。
      defaultContentBudget: CONTENT_BUDGET,
      maxContentBudget: null,
      handlesPerReceipt: HANDLE_MAX_PER_RECEIPT,
    },
    packaging: {
      corePackage: 'aura-basetools',
      adapterPackage: 'aura-basetools-dsh',
      coreDshFree: dshDeps === null ? null : dshDeps.length === 0,
      ...(dshDeps === null ? {} : { coreDshImports: dshDeps }),
    },
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const manifest = buildCapabilities()
  if (process.argv.includes('--write')) {
    const out = path.join(root, 'dist', 'capabilities.json')
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)
    process.stdout.write(`✓ 已写入 ${path.relative(root, out)}（${manifest.langsCount} 种扩展名，${manifest.tools.length} 个工具）\n`)
    process.exit(0)
  }
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
    process.exit(0)
  }
  process.stdout.write(`aura-basetools ${manifest.version}\n`)
  for (const tool of manifest.tools) process.stdout.write(`  ${tool.name}: ${(tool.modes ?? tool.addressKinds).join(', ')}\n`)
  process.stdout.write(`  languages: ${manifest.langsCount}\n`)
  process.stdout.write(`  limits: ${JSON.stringify(manifest.limits)}\n`)
}
