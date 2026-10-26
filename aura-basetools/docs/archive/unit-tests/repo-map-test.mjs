/**
 * repo-map-test —— **仓库级粗粒度地图**（T26）。
 *
 * ## 这个能力为什么存在
 *
 * 日志里模型反复在做同一件事：`read → map → 挑一个名字 → 改`（T26 的原始观察）。这个模式在**文件层**
 * 做得很好，但**再往上一层是空的**——没有“这个仓库里有什么”的 `map`。于是探索陌生仓库时，
 * 每次都要先花一个 `glob`/`ls` 才知道有哪些文件（**重复支付的固定成本**）。
 *
 * ## 三条硬约束（都不是偏好，是实测或 T26 原文的约束）
 *
 * 1. **必须是“换一种粗粒度”，不能是“文件的 map 的 map”**：2884 个文件 × 每文件一行 = 2884 行，
 *    直接爆预算。所以粒度是**目录 → 模块 → 依赖方向**。
 * 2. **必须由 auto 驱动，不得是新的必填参数**：实测模型的 `mode` 主动选择率只有 4%（T17），
 *    它宁愿让工具选。所以判据只有“这个路径是目录”一条。
 * 3. **必须先选候选再读内容**：给每个源文件读 8 KiB 文件头，2884 个文件的仓库要 **14 秒**
 *    （实测）。只遍历目录要 107 ms。内容读取因此只发生在少数被选中的文件上——
 *    这不是优化，是“能不能用”的分界。
 *
 * ## 本套件钉住什么
 *
 * 逐条对应上面的约束与 T26 的验收：预算不超、目录骨架完整（能定位到指定模块）、
 * 依赖方向跨语言正确、忽略规则生效、预算不够时**从后往前丢并自报**、以及**可重现**。
 * 最后一条尤其重要：地图是“给模型看的摘要”，不可重现的摘要会让两次探索互相矛盾。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { collectRepoMap, repoMap, specifiersIn, specifierOf, rankCandidates, MAP_BUDGET, MAP_SPEC } from './repo-map.mjs'

const say = (m) => process.stdout.write(`${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

const adapter = {
  async listChildren(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    return entries.map((e) => {
      const abs = path.join(dir, e.name)
      let size
      if (e.isFile()) {
        try {
          size = fs.statSync(abs).size
        } catch {
          size = 0
        }
      }
      return {
        name: e.name,
        type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other',
        ...(size === undefined ? {} : { size }),
        target: abs,
      }
    })
  },
  async readHead(abs, bytes) {
    let fd
    try {
      fd = fs.openSync(abs, 'r')
      const buf = Buffer.allocUnsafe(bytes)
      return buf.subarray(0, fs.readSync(fd, buf, 0, bytes, 0)).toString('utf8')
    } catch {
      return ''
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  },
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-'))
const w = (rel, text) => {
  const abs = path.join(tmp, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

// ── 夹具：一个含三种语言、若干“不该进地图”的东西的小仓库 ────────────────
w('src/index.mjs', "import { add } from './util/math.mjs'\nimport { fmt } from './util/fmt.mjs'\nexport function main() { return fmt(add(1, 2)) }\n")
w('src/util/math.mjs', 'export function add(a, b) { return a + b }\n')
w('src/util/fmt.mjs', 'export function fmt(x) { return String(x) }\n')
w('src/legacy.mjs', 'export const legacy = true\n')
w('tests/a.test.mjs', "import { main } from '../src/index.mjs'\nimport { fmt } from '../src/util/fmt.mjs'\nmain()\n")
w('scripts/gen.py', 'from src.util import fmt\nfrom pkg.inner import thing\nfmt(1)\n')
w('pkg/inner/__init__.py', 'def thing():\n    return 1\n')
// 下面四个都**不该**进地图，每一个盖一类规则：
//   node_modules/dep/deep.mjs —— 忽略目录（含更深一层）
//   .venv/site.mjs            —— 忽略目录的**直接子文件**（第一版漏掉的那一类）
//   docs/README.md            —— .md 不是模块（它还含一行 import，防止“按内容猜”）
//   .env / .hidden/secret.mjs —— 点开头的文件与目录
w('node_modules/dep/deep.mjs', 'export const dep = 1\n')
w('.venv/site.mjs', 'export const site = 1\n')
w('docs/README.md', '# docs\nimport { x } from "./not-a-module"\n')
w('.env.mjs', 'export const env = 1\n')
w('.hidden/secret.mjs', 'export const secret = 1\n')

say('=== A. 遍历与忽略规则 ===')
{
  const env = await collectRepoMap(adapter, tmp, { rootPath: tmp })
  // 7 个真模块：src/index、src/util/{math,fmt}、src/legacy、tests/a.test、scripts/gen.py、pkg/inner/__init__
  const wanted = ['index.mjs', 'math.mjs', 'fmt.mjs', 'legacy.mjs', 'a.test.mjs', 'gen.py', '__init__.py']
  const missing = wanted.filter((name) => !env.text.includes(name))
  check(missing.length === 0, `模块清单里能看到全部 7 个应有模块（缺 ${JSON.stringify(missing)}）`)
  // **直接钉住踩过的那个 bug**：忽略目录的**直接子文件**必须被跳过。
  // 第一版只挡“下钻”那一半，`node_modules/x.mjs` 这种直接子文件照样被收进地图（实测）。
  check(!env.text.includes('deep.mjs'), '忽略目录（node_modules）里的一切都不进地图')
  check(!env.text.includes('site.mjs'), '忽略目录的**直接子文件**也被跳过（不只挡下钻）')
  check(!env.text.includes('secret'), '点目录（.hidden/）不被遍历')
  check(!env.text.includes('.env.mjs'), '点文件不算模块')
  check(!env.text.includes('README.md'), '.md 不算模块（地图回答的是“由哪些模块组成”）')
  check(env.modules === 7, `模块计数 = 7（实测 ${env.modules}）`)
}

say('')
say('=== B. 依赖方向：跨语言都要连得上（三种写法各考一次）===')
{
  const env = await collectRepoMap(adapter, tmp, { rootPath: tmp })
  /** 只在“最被依赖”那一节里找：模块清单里也有同样的路径，直接全文搜会匹到那一行（那行没有边数）。 */
  const deps = env.text.slice(env.text.indexOf('most depended-on modules'))
  const line = (needle) => deps.split('\n').find((l) => l.includes(needle)) ?? ''
  // fmt.mjs：index.mjs（JS 相对）、a.test.mjs（JS 上一级）、gen.py（Python 点号）三条边
  check(/imported by 3/.test(line('src/util/fmt.mjs')), `fmt.mjs 被 3 处引用（JS 相对 ×2 + Python 点号 ×1）`, line('src/util/fmt.mjs').trim())
  // math.mjs：index.mjs 与 tests/a.test.mjs——两条边
  check(/imported by 2/.test(line('src/util/math.mjs')), `math.mjs 被 2 处引用`, line('src/util/math.mjs').trim())
  check(env.text.includes('entry points'), '有入口点一节')
  check(/src[\\/]index\.mjs/.test(env.text), '入口点里点名了 src/index.mjs')
}

say('')
say('=== C. T26 验收：输出不超预算，且能从中定位到指定模块 ===')
{
  const env = await collectRepoMap(adapter, tmp, { rootPath: tmp })
  check(env.text.length <= MAP_BUDGET, `输出在预算内（${env.text.length} ≤ ${MAP_BUDGET}）`)
  check(env.mode === 'repo', `mode = repo（实测 ${env.mode}）`)
  // “能定位到指定模块”：随便挑三个都必须在文本里出现
  for (const rel of ['src/util/fmt.mjs', 'scripts/gen.py', 'pkg/inner/__init__.py']) {
    check(env.text.includes(rel), `地图里能定位 ${rel}`)
  }
  // 大仓库：造 400 个模块，断言预算仍守得住
  const big = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-big-'))
  for (let i = 0; i < 400; i += 1) {
    fs.mkdirSync(path.join(big, `m${i % 20}`), { recursive: true })
    fs.writeFileSync(path.join(big, `m${i % 20}`, `f${i}.mjs`), `import { x } from './f${(i + 1) % 400}.mjs'\nexport const x${i} = ${i}\n`)
  }
  const bigEnv = await collectRepoMap(adapter, big, { rootPath: big })
  check(bigEnv.text.length <= MAP_BUDGET, `400 个模块的仓库仍在预算内（${bigEnv.text.length} ≤ ${MAP_BUDGET}）`)
  check(bigEnv.modules === 400, `模块计数 = 400（实测 ${bigEnv.modules}）`)
  check(
    bigEnv.omitted !== undefined && /not listed|dropped/.test(bigEnv.omitted),
    '截断被如实上报（omitted）',
    String(bigEnv.omitted ?? '(无)').slice(0, 120),
  )
  fs.rmSync(big, { recursive: true, force: true })
}

say('')
say('=== D. 预算收紧时：从后往前丢，且头部与目录骨架不丢 ===')
{
  const files = [
    { relPath: 'src/a.mjs', bytes: 10, head: "import x from './b.mjs'\n" },
    { relPath: 'src/b.mjs', bytes: 10, head: 'export const b = 1\n' },
    { relPath: 'src/index.mjs', bytes: 10, head: "import x from './a.mjs'\nexport function main() {}\n" },
  ]
  const dirs = [{ relPath: 'src', files: 3, bytes: 30 }]
  const tight = repoMap(files, dirs, { root: 'fixture', budget: 260 })
  check(tight.text.length <= 260, `收紧到 260 字符后仍在预算内（${tight.text.length}）`)
  check(tight.text.includes('directories'), '头部与目录骨架不丢')
  check(tight.text.includes('src/a.mjs'), '目录骨架仍能定位到模块')
  check(/dropped to fit/.test(String(tight.omitted ?? '')), '被丢掉的段落如实上报', String(tight.omitted ?? '(无)').slice(0, 140))
}

say('')
say('=== E. 可重现：同样的输入必须给逐字相同的文本 ===')
{
  const a = await collectRepoMap(adapter, tmp, { rootPath: tmp })
  const b = await collectRepoMap(adapter, tmp, { rootPath: tmp })
  check(a.text === b.text, '同一目录两次采集结果逐字相同')
  const r1 = repoMap([{ relPath: 'z/b.mjs', bytes: 1 }, { relPath: 'a/c.mjs', bytes: 1 }], [], { root: 'x' })
  const r2 = repoMap([{ relPath: 'a/c.mjs', bytes: 1 }, { relPath: 'z/b.mjs', bytes: 1 }], [], { root: 'x' })
  check(r1.text === r2.text, '输入顺序不同、结果相同（排序是全序的）')
}

say('')
say('=== F. 说明符解析：各语言写法（含两个踩过的坑）===')
{
  check(specifierOf("import { x } from './a.mjs'") === './a.mjs', "JS 相对导入")
  check(specifierOf('from src.util import fmt') === 'src.util', 'Python from-import')
  check(specifierOf('use crate::a::b;') === 'crate::a::b', 'Rust use')
  check(specifierOf('require("left-pad")') === 'left-pad', 'CJS require')
  check(specifierOf('// import { z } from "./no.mjs"') === null, '行首 // 的注释不算导入')
  check(specifierOf('# import os') === null, 'Python 的 # 注释不算导入')
  // 坑一：把 ''' 当注释开头会吃掉整个 .test.mjs 的 import（实测：tests/a.test.mjs 整份消失）
  check(specifierOf("import { main } from '../src/index.mjs'") === '../src/index.mjs', "行首 import 不会被文档串规则误伤")
  // 坑二：截断可能把一条 import 切成半句——半句必须被丢掉，不能解析出错的说明符
  const cut = specifiersIn("import { a } from './ok.mjs'\nimport { b } from './bro")
  check(JSON.stringify(cut) === JSON.stringify(['./ok.mjs']), `截断处不产生假说明符（${JSON.stringify(cut)}）`)
}

say('')
say('=== G. 候选排序：入口优先，且只读被选中的文件 ===')
{
  const entries = [
    { relPath: 'src/deep/nested/thing.mjs', bytes: 10 },
    { relPath: 'src/index.mjs', bytes: 10 },
    { relPath: 'fixtures/huge.mjs', bytes: 999 },
  ]
  const ranked = rankCandidates(entries)
  check(ranked[0].relPath === 'src/index.mjs', `入口排第一（实测 ${ranked[0].relPath}）`)
  check(ranked[ranked.length - 1].relPath === 'fixtures/huge.mjs', 'fixtures/ 排最后（提示词权重生效）')
  check(entries[0].relPath === 'src/deep/nested/thing.mjs', 'rankCandidates 不改原数组')

  // 只读被选中的：造一个超过 maxSampled 的仓库，数一数真的读了几次
  const many = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-many-'))
  const total = MAP_SPEC.maxSampled + 40
  for (let i = 0; i < total; i += 1) {
    fs.writeFileSync(path.join(many, `f${String(i).padStart(4, '0')}.mjs`), `export const v${i} = ${i}\n`)
  }
  let reads = 0
  await collectRepoMap(
    { ...adapter, readHead: async (abs, bytes) => { reads += 1; return adapter.readHead(abs, bytes) } },
    many,
    { rootPath: many },
  )
  check(reads === MAP_SPEC.maxSampled, `只给 ${MAP_SPEC.maxSampled} 个候选读头（${total} 个文件里读了 ${reads} 个）`)
  fs.rmSync(many, { recursive: true, force: true })
}

say('')
say('=== G2 扁平目录：不印空标题、不印 `./` ===')
// 真实观実（本机读一个 47 文件的扁平目录）：回执开头是 `directories (0):` 一个空标题，
// 接着模块清单第一行是 `./`。两处都是噪声，而扁平目录是最常见的形状之一（一个 src/ 里一堆文件）。
{
  const flat = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-flat-'))
  for (const name of ['alpha.mjs', 'beta.mjs', 'gamma.mjs']) {
    fs.writeFileSync(path.join(flat, name), `import { x } from './alpha.mjs'\nexport const ${name.replace('.mjs', '')} = 1\n`)
  }
  const env = await collectRepoMap(adapter, flat, { rootPath: flat })
  check(!env.text.includes('directories (0)'), '没有子目录时不印空标题 `directories (0):`')
  check(/all 3 modules are directly in this directory/.test(env.text), '改为一句说明（说清“都在这一层”）', env.text.split('\n')[2] ?? '')
  check(!/^\s*\.\/$/m.test(env.text), '模块清单里不出现单独的 `./` 行')
  check(env.text.includes('  alpha.mjs') && env.text.includes('  beta.mjs'), '扁平目录下的文件名直接列出（不多一层缩进）')
  // 单数一致性：第一版只把名词加了 `s`，1 个模块时印出 `all 1 module **are** …`。
  // 这一行最容易在“单文件目录”上出现（实测一个 1 模块目录时就碰到了），所以单开一格。
  const single = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-single-'))
  fs.writeFileSync(path.join(single, 'only.mjs'), 'export const only = 1\n')
  const one = await collectRepoMap(adapter, single, { rootPath: single })
  check(/all 1 module is directly in this directory/.test(one.text), '单个模块时用单数（`1 module is`，不是 `1 module are`）', one.text.split('\n')[2] ?? '')
  check(!/\b1 module are\b/.test(one.text), '不出现 `1 module are` 这种不一致')
  fs.rmSync(single, { recursive: true, force: true })
  fs.rmSync(flat, { recursive: true, force: true })
}

say('')
say('=== H. 空目录与不存在的路径：不崩，且说实话 ===')
{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-empty-'))
  const env = await collectRepoMap(adapter, empty, { rootPath: empty })
  check(env.modules === 0, '空目录：模块数 0')
  check(/no source files found/.test(env.text), '空目录：明说没找到源文件', env.text.split('\n')[1] ?? '')
  const gone = await collectRepoMap(adapter, path.join(empty, 'does-not-exist'), { rootPath: 'gone' })
  check(gone.modules === 0, '不存在的路径：不抛异常，返回 0 模块')
  fs.rmSync(empty, { recursive: true, force: true })
}

fs.rmSync(tmp, { recursive: true, force: true })

say('')
const passed = results.filter((r) => r.ok).length
say(`--- ${passed}/${results.length} 通过 ---`)
for (const r of results.filter((x) => !x.ok)) say(`  FAIL: ${r.label}  ${r.detail}`)
process.exit(passed === results.length ? 0 : 1)
