/**
 * bundle-layout.mjs —— 包内运行时文件的**唯一清单**。
 *
 * 为什么单列：这份清单此前在 `make-bundle.mjs`（打包）与 `release-check.mjs`（src↔dist 一致性）
 * 各抄一份，结果后者漏了 5 个**已经发出去**的文件：`handle-core.mjs`、`transaction-store.mjs`、
 * `workspace-lock.mjs` 与 `dsh/` 下两个执行器。它们进得了包，但"改了源没重建"对它们是瞎的
 * （`repo-map.mjs` 也漏过一轮，当时补的是清单，不是**清单的来源**）。
 *
 * 现在两边都从这里派生：打包按这些表复制，一致性检查按 `runtimePairs()` 逐字节比对。
 * 往包里加文件 = 只改这一处。
 */
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

/** 两个 bin。名字与目标同一份：组合包与拆包后的核心包都从这里取。 */
export const BIN_ENTRIES = {
  aura: './bin/aura.mjs',
  'aura-mcp': './bin/aura-mcp.mjs',
}

/** 引擎：判据/结构 + 写路径（框架无关，不许 node:fs）。 */
export const ENGINE = [
  'read-core.mjs',
  'locator-api.mjs',
  'struct-core.mjs',
  'anchor-core.mjs',
  'write-path.mjs',
  'args.mjs',
  // 仓库级地图（T26）：`aura_basetools_read` 传目录时由它渲染。两个壳都 import 它，漏打包 = 包内直接崩。
  'repo-map.mjs',
  // 区间句柄（HD1）：`aura_basetools_read` 发、`aura_basetools_edit` 解析。两个壳都经引擎碰到它，漏打包 = 包内直接崩。
  'handle-core.mjs',
  // 写前预检 / 写后结构状态（0.22）：`write-path` 静态 import，漏打包 = 包内直接崩。
  'preflight.mjs',
  // 文档/配置目录（0.21）：`read-core` 静态 import 它；漏打包 = 包内直接崩。
  'doc-structure.mjs',
  // entity-first（1.0）：实体地址、仓库级搜索、图片头解析。read/apply 两条工具面共用。
  'entity-core.mjs',
  'repo-search.mjs',
  'image-info.mjs',
]

/** DSH 面：两个工具壳（宿主代码，走 ctx.fs）。 */
export const SHELLS = [
  ['aura-read', 'index.js'],
  ['aura-edit', 'index.js'],
]

/**
 * 钩子执行器（宿主面）：`ctx.shell` 的替代实现，摘掉每次工具调用的外层壳税。
 *
 * 【为什么要随包发货】profile 里那一行 `name:` 指到哪儿，宿主就从哪儿 import。
 * 指向仓库工作区（`dsh/argv-shell.mjs`）等于把整套东西绑在
 * 「这个仓库必须存在、必须在这个路径」上；指向安装副本才与两个工具壳同一条先例 ——
 * 包装在哪儿都成立（`<prefix>/node_modules/aura-basetools/aura-read/index.js` 就是这么指的）。
 */
export const HOOK_SHELL = ['dsh/argv-shell.mjs', 'dsh/hook-inproc.mjs']

/** 独立面：CLI + MCP + node:fs 提供方（宿主代码，允许直接用 node:fs）。 */
export const STANDALONE = [
  ['aura-standalone/bin', 'bin'],
  ['aura-standalone/lib', 'lib'],
  ['aura-standalone/test', 'test'],
]

/**
 * 独立面目录里哪些文件进包。
 *
 * 靶场（`range-*.mjs`）是**项目级**的：它们按项目布局（`dist/`、`src/`）找路径，塞进包里跑不起来。
 * 包里只留真能在包内跑的验收（`standalone-test.mjs`）——不发一份跑不动的东西。
 */
export const shipsStandaloneFile = (name) => name.endsWith('.mjs') && !name.startsWith('range-')

/**
 * 源文件 → 包内文件（只含**逐字节复制**的运行时文件）。
 *
 * 生成物（`package.json` / `README.md` / `cordis.patch.yml`）与改写过的 `LICENSE` 不在内：
 * 它们不是源的副本，字节比对会恒假。
 *
 * @returns {Array<[string, string]>} `[源相对路径, 包内相对路径]`
 */
export function runtimePairs() {
  const pairs = []
  for (const [dir, entry] of SHELLS) pairs.push([`src/${dir}/${entry}`, `${dir}/${entry}`])
  for (const file of ENGINE) pairs.push([`src/locator-lab/${file}`, `locator-lab/${file}`])
  for (const [fromDir, toDir] of STANDALONE) {
    const abs = path.join(root, 'src', fromDir)
    for (const name of fs.readdirSync(abs).sort()) {
      if (shipsStandaloneFile(name)) pairs.push([`src/${fromDir}/${name}`, `${toDir}/${name}`])
    }
  }
  for (const rel of HOOK_SHELL) pairs.push([rel, rel])
  return pairs
}

/**
 * 拆包时对 DSH 壳做的唯一改写：把相对引擎路径换成**包名子路径**。
 * `aura-basetools` 的 `exports` 开放 `./locator-lab/*` 与 `./lib/*`，所以装到哪儿都成立。
 *
 * 单列成函数是为了让 `make-split-packages.mjs`（改写）与 `split-package-test.mjs`（核对）
 * 用**同一条规则** —— 各写一份的话，改了一边另一边只会给出看不懂的红。
 */
export const rewriteShellImports = (text) =>
  text.replaceAll("from '../locator-lab/", "from 'aura-basetools/locator-lab/").replaceAll("from '../lib/", "from 'aura-basetools/lib/")
