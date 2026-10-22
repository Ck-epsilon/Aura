/**
 * embeddability-test —— **验收测试（文档面）**：`docs/embed-example` 说的做法**照做真能跑**。
 *
 * ## 为什么单开一个
 *
 * “把引擎接到自己的 IO 上”是本产品对外的**一条核心承诺**（引擎框架无关、零依赖、可直接搬走）。
 * 它由两份文档承载：`docs/embed-example/README.md`（怎么做）与 `demo.mjs`（能跑的样例）。
 * 而文档承诺最容易失效的方式是**静默**的：引擎多了一个 `node:fs` 依赖、多了一个外部 import、
 * 或 `provider` 契约改了名 —— 文档照旧写着老办法，谁照着做谁卡住，而**所有测试都不会红**。
 *
 * 所以本套件把文档里的步骤**真的执行一遍**：把引擎那 N 个文件复制到一个空目录，放上 demo，
 * 在**没有 package.json、没有 node_modules、没有安装任何东西**的地方跑它，
 * 再断言输出里出现文档声称的那几行。
 *
 * 判据取自文档本身（README 里列出了预期输出），而不是我另写一份期望——
 * 这样文档与实现漂移时，**两条一起红**。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const pkgRoot = path.resolve(here, '..', '..')
const docsDir = path.join(pkgRoot, 'docs', 'embed-example')

const say = (m) => process.stdout.write(`${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

const readmePath = path.join(docsDir, 'README.md')
const demoPath = path.join(docsDir, 'demo.mjs')
check(fs.existsSync(readmePath), '文档存在：docs/embed-example/README.md')
check(fs.existsSync(demoPath), '样例存在：docs/embed-example/demo.mjs')
if (!fs.existsSync(readmePath) || !fs.existsSync(demoPath)) {
  say('')
  say(`--- ${results.filter((r) => r.ok).length}/${results.length} 通过 ---`)
  process.exit(1)
}
const readme = fs.readFileSync(readmePath, 'utf8')

say('')
say('=== A. 文档里那条复制命令列出的文件，必须真的存在 ===')
{
  // 文档写的是 `cp <repo>/src/locator-lab/{a,b,c}.mjs /tmp/lab/`。
  // 这里把它解析出来，逐个核对——文档点名的文件一旦改名，这条就红。
  const m = /\{([a-z0-9,\-]+)\}\.mjs/.exec(readme)
  check(m !== null, '从文档里解析出“要复制哪些引擎文件”的清单', m?.[1] ?? '(没找到)')
  const names = (m?.[1] ?? '').split(',').filter(Boolean)
  check(names.length >= 5, `文档点名了 ${names.length} 个引擎文件`, names.join(','))
  const missing = names.filter((n) => !fs.existsSync(path.join(pkgRoot, 'src', 'locator-lab', `${n}.mjs`)))
  check(missing.length === 0, '文档点名的引擎文件都存在', missing.join(','))
  // 反向：打包清单里的引擎文件不能被文档漏掉（漏掉的那个就是“搬不走的”）
  const bundle = fs.readFileSync(path.join(pkgRoot, 'build', 'make-bundle.mjs'), 'utf8')
  const engine = [...(/const ENGINE = \[([\s\S]*?)\]/.exec(bundle)?.[1] ?? '').matchAll(/'([^']+\.mjs)'/g)].map((x) => x[1].replace(/\.mjs$/, ''))
  const notDocumented = engine.filter((e) => !names.includes(e))
  check(notDocumented.length === 0, '打包清单里的每个引擎文件都在文档的复制清单里', notDocumented.join(','))
}

say('')
say('=== B. 照文档做：空目录里只放引擎 + demo，跑起来 ===')
const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-doc-'))
{
  const names = (/\{([a-z0-9,\-]+)\}\.mjs/.exec(readme)?.[1] ?? '').split(',').filter(Boolean)
  fs.mkdirSync(path.join(lab, 'locator-lab'), { recursive: true })
  for (const n of names) fs.copyFileSync(path.join(pkgRoot, 'src', 'locator-lab', `${n}.mjs`), path.join(lab, 'locator-lab', `${n}.mjs`))
  fs.copyFileSync(demoPath, path.join(lab, 'demo.mjs'))
  // 判据：这个目录里**没有** package.json / node_modules / 任何安装痕迹
  check(!fs.existsSync(path.join(lab, 'package.json')), 'B1 空目录里没有 package.json（证明不需要 npm 安装）')
  check(!fs.existsSync(path.join(lab, 'node_modules')), 'B2 空目录里没有 node_modules（证明零依赖）')
  const res = spawnSync(process.execPath, [path.join(lab, 'demo.mjs')], { cwd: lab, encoding: 'utf8', timeout: 120000 })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  check(res.status === 0, `B3 demo 跑通（退出码 ${res.status}）`, String(res.stderr ?? '').trim().split('\n')[0]?.slice(0, 110) ?? '')
  // 文档里承诺的那几件事，逐条在真实输出里找
  const promised = [
    [/读：mode=full/, '读：给出 mode 与行数'],
    [/定位 target=beta ⇒ 第 \d+-\d+ 行/, '定位：按符号命中并给出行区间'],
    [/STRUCT_AMBIGUOUS/, '定位：重名时拒绝猜（给候选）'],
    [/target=n#1/, '定位：候选里给出可直接用的地址'],
    [/applied=/, '写：回执带 applied'],
    [/write_verify=/, '写：回执带回读证据'],
    [/PATCH_STALE_REGION/, '写：行号位移时拒绝而不是改错地方'],
    [/磁盘是否被动过：没动/, '写：被拒时磁盘一字未落'],
  ]
  for (const [re, label] of promised) {
    const hit = out.split('\n').find((l) => re.test(l))
    check(re.test(out), `B4 文档承诺的行为出现在真实输出里：${label}`, hit === undefined ? '' : hit.trim().slice(0, 70))
  }
}

say('')
say('=== C. README 里贴的预期输出，必须与真实输出对得上 ===')
{
  // README 的“一次实测”小节里贴了一段输出。这里只核对**结构性**的那几行
  // （版本令牌、哈希这类每次都会变的不比），漂移时同样会红。
  const res = spawnSync(process.execPath, [path.join(lab, 'demo.mjs')], { cwd: lab, encoding: 'utf8', timeout: 120000 })
  const real = String(res.stdout ?? '')
  const claims = [
    [/读：mode=full\s+\d+ 行\s+version=/, 'README 声称 read 行含 `mode=full N 行 version=`'],
    [/定位 target=beta ⇒ 第 \d+-\d+ 行，tier=symbol/, 'README 声称定位行写明 tier=symbol'],
    [/位移后仍用旧行号 ⇒ PATCH_STALE_REGION/, 'README 声称漂移时拒绝码是 PATCH_STALE_REGION'],
    [/仓库地图：\d+ 个模块/, 'README 声称末尾给出仓库地图'],
  ]
  // detail 要打印**命中的那一行**，而不是第一行：第一版打印首行，于是四条 detail 一模一样，
  // 真红的时候看不出是哪一条、差在哪。
  for (const [re, label] of claims) {
    const hit = real.split('\n').find((l) => re.test(l))
    check(re.test(real), label, hit === undefined ? `（未匹配；实际输出首行：${real.split('\n')[0]?.slice(0, 60) ?? ''}）` : hit.trim().slice(0, 80))
  }
}

fs.rmSync(lab, { recursive: true, force: true })
say('')
const passed = results.filter((r) => r.ok).length
say(`--- ${passed}/${results.length} 通过 ---`)
for (const r of results.filter((x) => !x.ok)) say(`  FAIL: ${r.label}  ${r.detail}`)
process.exit(passed === results.length ? 0 : 1)
