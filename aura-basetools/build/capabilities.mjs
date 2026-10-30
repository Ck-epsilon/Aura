/**
 * capabilities —— 0.9.5：能力清单（机器可读，从源码单一来源派生）。
 *
 * 为什么需要：README 与 schema 各说一部分能力（地址档、读模式、语言数、限制），
 * 消费方（agent / 插件市场 / 评测）只能从散文里猜。这里把**可枚举的事实**从源码直接导出：
 *   · 工具表（读模式 / op / 地址档 / 寻址安全 / 三面写闸）与命令表：直接取运行期那一份
 *     （`ops.mjs:capabilitiesEnvelope`，CLI `basetools capabilities` 对外报的就是它），构建期不再抄第二遍；
 *   · `langs` 来自 `struct-core` 的 `LANGS`（不手抄语言数）；
 *   · 地址档来自 `args.mjs` 的 `FLAT_ADDRESS_KEYS` + 内容地址/句柄从属键；
 *   · 读模式来自 `read-core` 的 `MODES`；
 *   · 限制来自 `args` / `read-core` / `handle-core` 的导出常量；
 *   · 文档类型来自 `doc-structure` 的 `DOC_KINDS` 取值，编码词表来自 `encoding` 的 `SUPPORTED_ENCODINGS`。
 * 两个方向都会被 `capabilities-test` 夹住：源码变了而清单没重建 ⇒ 红；清单派生好了但**落盘那份**
 * 是旧的（`dist/capabilities.json` 只在构建里刷新）⇒ 同样红（D1），而且点名到 `tools.1.operations.6` 这一级。
 *
 * 构建期**只**补这三样（运行期拿不到或不该由运行期说）：编码词表、`map` 认的文档类型、
 * dist 清单里的打包事实（核心包是否 DSH-free）。
 *
 * 跑法：
 *   node build/capabilities.mjs            # 打印摘要
 *   node build/capabilities.mjs --json     # 机器读
 *   node build/capabilities.mjs --write    # 写 dist/capabilities.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTENT_BUDGET } from '../src/locator-lab/read-core.mjs'
import { DOC_KINDS } from '../src/locator-lab/doc-structure.mjs'
import { SUPPORTED_ENCODINGS } from '../src/aura-standalone/lib/encoding.mjs'
// 工具表/命令表/语言表只有一份：运行时那份（`ops.mjs:capabilitiesEnvelope`）就是 CLI `capabilities`
// 与 MCP 面出去的读数，这里在它上面加只有构建期才知道的字段（版本、打包、编码表）。
// 以前是手抄两份，而抄来的那两份会漂：`views` 在两边都写着 `entity`/`grep`/`image`，
// 读起来像 `mode` 取值、实际三个都不在 enum 里（照它发就是 `READ_BAD_MODE`）——删掉之后
// 这种词表只在引擎的导出里存在，构建期与运行期不可能各说一套。
import { capabilitiesEnvelope } from '../src/aura-standalone/lib/ops.mjs'

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
  const envelope = capabilitiesEnvelope()
  return {
    tool: 'aura-basetools',
    version,
    generatedAt: new Date().toISOString(),
    // 工具表 / 命令表 / 语言表 / 限额都取自运行期那一份（CLI `basetools capabilities` 与
    // MCP 面出去的就是它）——以前两件事各抄一遍，抄漏的那格就是 `views`：
    // 构建清单和运行时都写着 `entity`/`grep`/`image`，读起来像 `mode` 的取值，
    // 而三个都不在 enum 里（照它发 ⇒ `READ_BAD_MODE`）。现在这类词表只有一份，
    // 而且由引擎导出（`MODES` / `FLAT_ADDRESS_KEYS` / `LANGS`），构建期无从再编一套。
    ...envelope,
    // 只有构建期才知道的三件：编码词表、`map` 认的文档类型、dist 清单里的打包事实。
    textEncodings: [...SUPPORTED_ENCODINGS],
    // 文档类型从引擎那张分发表派生（`DOC_KINDS` 的值集）——手抄的四个名字正是 `views` 的形态：
    // 表里多一个/改一个，`mode=map` 就退化成 `no structure index for …`，而清单仍宣称支持它。
    docKinds: [...new Set(Object.values(DOC_KINDS))],
    limits: {
      ...envelope.limits,
      // `full` = up to budget（反馈 D5）：能被 `budget` 顶大，但没有"一次给全"的保证。
      defaultContentBudget: CONTENT_BUDGET,
      maxContentBudget: null,
    },
    packaging: {
      ...envelope.packaging,
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
