/**
 * standalone-test.mjs —— 独立面（CLI + MCP）的验收：不依赖 DSH，也不碰你的 home。
 *
 * 覆盖：
 *   A 读：四种取景 + 令牌
 *   B 改：按符号改 + 落盘回读证据
 *   C 字节保真：BOM / 双 BOM / CRLF / 混合行尾两向 / 无尾换行 / 中文 / 尾 BOM —— 改第 4 行后其余字节不动
 *   D 陈旧闸门：读完之后那块区域被外部改过 ⇒ 必须拒绝且磁盘保留外部改动
 *   E 建文件：--create
 *   F MCP：initialize / tools/list / tools/call 读写往返
 * 运行：node aura-standalone/test/standalone-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createNodeFsProvider } from '../lib/fs-provider.mjs'
import { createDiskStore } from '../lib/observation-store.mjs'
import { withWorkspaceLock } from '../lib/workspace-lock.mjs'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const bin = path.join(here, '..', 'bin', 'aura.mjs')
const mcpBin = path.join(here, '..', 'bin', 'aura-mcp.mjs')

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}
const say = (m) => console.log(`\n=== ${m} ===`)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-standalone-'))
const cache = path.join(tmp, 'cache') // 观测缓存也放测试目录，绝不写 ~/.aura
const env = { ...process.env, AURA_CACHE_DIR: cache }
const run = (args, cwd = tmp) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env })
const json = (res) => {
  try {
    return JSON.parse(res.stdout.trim().split('\n').pop())
  } catch {
    // 把 stderr 一起带出来：否则失败只剩一句"不是 JSON"，诊断不了（这个 harness 自己踩过）
    return { ok: false, error: `stdout 不是 JSON：${JSON.stringify(res.stdout)} ${String(res.stderr ?? '').trim().split('\n').slice(0, 3).join(' / ')}` }
  }
}
const utf8 = (s) => Buffer.from(s, 'utf8')
const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const write = (name, buf) => {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, buf)
  return { path: p, orig: Buffer.from(buf) }
}

/**
 * 本套件自己也可能住在两种布局里（`src/aura-standalone/test/` 或包内摊平的 `test/`，
 * `make-bundle.mjs` 会把这份验收一起发出去）。所以这里不写死"引擎在 `../../locator-lab`"：
 * 判据与 `lib/ops.mjs` 的同一条——**哪里真的有引擎本体 `read-core.mjs`**，只有两个固定候选。
 */
const ENGINE_MARKER = 'read-core.mjs'
const engineCandidates = ['../locator-lab/', '../../locator-lab/'].map((rel) => path.resolve(here, rel))
const engineDir = engineCandidates.find((dir) => fs.existsSync(path.join(dir, ENGINE_MARKER)))

/**
 * 按**打包器的摊平规则**把独立面摆成包内布局，摆在临时目录里（不碰 dist/，那是派生物）。
 *
 * 规则只有一条（`build/make-bundle.mjs` 的 `STANDALONE` 表）：`aura-standalone/{bin,lib,test}`
 * 里的每个文件各自上移一层变成 `{bin,lib,test}`，引擎 `locator-lab/` 同时上移一层 ⇒ 从 `lib/` 看
 * 引擎与它同层（`../locator-lab/`）。这里照抄这一条，并把 `bin/`、`lib/`、`locator-lab/` 三个目录
 * **整份**带过去：测试要证明的是"摆成这样以后解析得到"，只抄一份写死的文件清单就测不出漏文件。
 *
 * 摊平后的包根本身**不放 package.json**（解析的判据是 `locator-lab/` 在哪，不是有没有清单），
 * 于是这份临时布局顺带证明：两边都不靠包清单。
 */
const flatten = path.join(tmp, 'flat', 'aura-basetools')
const flattenLayout = () => {
  const copyDir = (from, to) => {
    fs.mkdirSync(to, { recursive: true })
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name)
      const dst = path.join(to, entry.name)
      if (entry.isDirectory()) copyDir(src, dst)
      // 摊平规则只搬 .mjs（靶场 `range-*.mjs` 归项目级，包里不发）
      else if (entry.name.endsWith('.mjs') && !entry.name.startsWith('range-')) fs.copyFileSync(src, dst)
    }
  }
  copyDir(engineDir, path.join(flatten, 'locator-lab'))
  // 摊平时 `bin/`、`lib/`、`test/` 与引擎的相对位置不变：整体上移一层
  const up = (p) => path.relative(path.join(here, '..', '..'), p).split(path.sep).slice(1).join(path.sep)
  for (const dir of ['bin', 'lib']) copyDir(path.join(here, '..', dir), path.join(flatten, up(path.join(here, '..', dir))))
  return flatten
}

/**
 * 在给定布局里**真跑一次读与一次编辑**（不是只 import 一下）。
 * 返回 `{ readOk, readExit, editOk, editExit, text }` —— 读要看见符号，改要真落到磁盘。
 */
const layoutRoundTrip = (binPath, label) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `aura-${label}-`))
  const file = path.join(work, 'probe.js')
  fs.writeFileSync(file, 'function alpha() {\n  const a = 1\n  return a\n}\n')
  const env2 = { ...process.env, AURA_CACHE_DIR: path.join(work, 'cache') }
  const spawn = (args) => spawnSync(process.execPath, [binPath, ...args], { cwd: work, encoding: 'utf8', env: env2 })
  const read = spawn(['read', '--file', file, '--mode', 'map'])
  const edited = spawn(['edit', '--file', file, '--hunks', JSON.stringify([{ lines: [2, 2], replace: '  const a = 42' }])])
  const text = fs.readFileSync(file, 'utf8')
  fs.rmSync(work, { recursive: true, force: true })
  const parse = (res) => {
    try {
      return JSON.parse(String(res.stdout).trim().split('\n').pop())
    } catch {
      return { ok: false, error: String(res.stderr ?? '').trim().split('\n')[0] }
    }
  }
  return { read: { ...parse(read), exit: read.status }, edit: { ...parse(edited), exit: edited.status }, text }
}

const split = (s) => {
  const lines = []
  const ends = []
  const re = /\r\n|\n/g
  let st = 0
  let m
  while ((m = re.exec(s)) !== null) {
    lines.push(s.slice(st, m.index))
    ends.push(m[0])
    st = m.index + m[0].length
  }
  lines.push(s.slice(st))
  ends.push('')
  return { lines, ends }
}
const countBom = (b) => {
  let n = 0
  while (b.length >= (n + 1) * 3 && BOM.every((x, i) => b[n * 3 + i] === x)) n += 1
  return n
}

// ── A 读 ──────────────────────────────────────────────────────────────────
say('A 读：取景与令牌')
{
  const f = write('a.js', utf8('function alpha() {\n  const a = 1\n  return a\n}\n\nfunction beta() {\n  const b = 2\n}\n'))
  const map = json(run(['read', '--file', f.path, '--mode', 'map']))
// 信封里 `symbols` 是**个数**，渲染好的目录在 `text` —— 断言照实际形状写（我第一版写成数组，当场红）
  check(map.ok === true && typeof map.text === 'string' && map.symbols >= 2, 'map 返回符号目录（text + 计数）', JSON.stringify(map).slice(0, 120))
  check(String(map.text).includes('beta'), 'map 里有 beta')
  const around = json(run(['read', '--file', f.path, '--mode', 'around', '--around', 'beta']))
  check(around.ok === true && String(around.text ?? '').includes('beta'), 'around 窗口里有 beta')
  const full = json(run(['read', '--file', f.path, '--mode', 'full']))
  check(typeof full.version === 'string' && full.version.length > 0, `full 给出令牌 ${full.version}`)
  const changed = json(run(['read', '--file', f.path, '--mode', 'changed', '--since', String(full.version)]))
  check(changed.ok === true && String(changed.note ?? '').includes('no change'), '立即 changed = 无变化', JSON.stringify(changed).slice(0, 120))
}

// ── B 改 ─────────────────────────────────────────────────────────────────
say('B 改：按符号 + 回读证据')
{
  const f = write('b.js', utf8('function alpha() {\n  const a = 1\n  return a\n}\n'))
  const res = run(['edit', '--file', f.path, '--hunks', JSON.stringify([{ target: 'alpha', replace: 'function alpha() {\n  return 42\n}' }])])
  const env2 = json(res)
  check(env2.ok === true, '按符号改成功', JSON.stringify(env2).slice(0, 160))
  check(String(fs.readFileSync(f.path, 'utf8')).includes('return 42'), '磁盘上真的改了')
  check(env2.result?.write_verify?.level === 'bytes', `回读证据 level=${env2.result?.write_verify?.level}`)
  const dry = json(run(['edit', '--file', f.path, '--hunks', JSON.stringify([{ target: 'alpha', replace: 'x' }]), '--dry-run']))
  check(dry.ok === true && dry.result?.dryRun === true, 'dry_run 不落盘')
  check(String(fs.readFileSync(f.path, 'utf8')).includes('return 42'), 'dry_run 之后磁盘没变')
}

// ── C 字节保真 ────────────────────────────────────────────────────────────
say('C 字节保真：改第 4 行，其余字节不动')
{
  const shapes = {
    'bom_lf.md': Buffer.concat([BOM, utf8('alpha\nbeta\ngamma\ndelta\n')]),
    'bom_crlf.md': Buffer.concat([BOM, utf8('alpha\r\nbeta\r\ngamma\r\ndelta\r\n')]),
    'double_bom.md': Buffer.concat([BOM, BOM, utf8('alpha\nbeta\ngamma\ndelta\n')]),
    'crlf.md': utf8('alpha\r\nbeta\r\ngamma\r\ndelta\r\n'),
    'mixed_lf_major.md': utf8('alpha\nbeta\r\ngamma\ndelta\n'),
    'mixed_crlf_major.md': utf8('alpha\r\nbeta\ngamma\r\ndelta\r\n'),
    'no_trailing.md': utf8('alpha\nbeta\ngamma\ndelta'),
    'cjk.md': utf8('第一行\n第二行\n第三行\n第四行\n'),
    'blank_lines.md': utf8('alpha\n\nbeta\ndelta\n'),
    'trailing_bom.md': Buffer.concat([utf8('alpha\nbeta\ngamma\ndelta\n'), BOM]),
  }
  for (const [name, buf] of Object.entries(shapes)) {
    const f = write(name, buf)
    const res = run(['edit', '--file', f.path, '--hunks', JSON.stringify([{ lines: [4, 4], replace: 'EDITED' }])])
    const env2 = json(res)
    if (env2.ok !== true) {
      check(false, `${name} 编辑成功`, JSON.stringify(env2).slice(0, 140))
      continue
    }
    const before = split(f.orig.toString('utf8'))
    const after = split(fs.readFileSync(f.path, 'utf8'))
    const problems = []
    if (countBom(f.orig) !== countBom(fs.readFileSync(f.path))) problems.push('前导 BOM 个数变了')
    if (before.lines.length !== after.lines.length) problems.push(`行数 ${before.lines.length}→${after.lines.length}`)
    for (let i = 0; i < Math.min(before.lines.length, after.lines.length); i += 1) {
      if (i === 3) {
        if (after.lines[i] !== 'EDITED') problems.push(`第 4 行不是 EDITED：${JSON.stringify(after.lines[i])}`)
      } else if (before.lines[i] !== after.lines[i]) problems.push(`第 ${i + 1} 行被改动`)
      if (before.ends[i] !== after.ends[i]) problems.push(`第 ${i + 1} 行行尾变了`)
    }
    check(problems.length === 0, `${name}：除目标行外逐字节不变`, problems.join(' | '))
  }
}

// ── D 陈旧闸门 ────────────────────────────────────────────────────────────
say('D 陈旧闸门：读之后区域被外部改过 ⇒ 拒绝')
{
  const f = write('d.md', utf8('one\ntwo\nthree\nfour\n'))
  json(run(['read', '--file', f.path, '--mode', 'full'])) // 建"上次观测"（落盘缓存）
  fs.writeFileSync(f.path, 'one\nTWO-BY-SOMEONE-ELSE\nthree\nfour\n') // 外部改第 2 行
  const res = run(['edit', '--file', f.path, '--hunks', JSON.stringify([{ lines: [2, 2], replace: 'mine' }])])
  const env2 = json(res)
  check(env2.ok === false && env2.code === 'PATCH_STALE_REGION', `被拒绝（code=${env2.code}）`, JSON.stringify(env2).slice(0, 160))
  check(fs.readFileSync(f.path, 'utf8').includes('TWO-BY-SOMEONE-ELSE'), '磁盘保留外部改动')
  // 带 expect 的老路不受影响：改第 4 行（未被动过）
  const ok = json(run(['edit', '--file', f.path, '--hunks', JSON.stringify([{ lines: [4, 4], expect: 'four', replace: 'FOUR' }])]))
  check(ok.ok === true, '未被动过的区域照常可编辑', JSON.stringify(ok).slice(0, 140))
}

// ── E 建文件 ──────────────────────────────────────────────────────────────
// 旧的写法是 `--hunks '[]' --create …`——那是 workaround，不是契约（T6 第 4 条：
// 把 workaround 固化成契约，等于把“创建被自己的校验挡住”这个缺陷锁进测试里）。
say('E 建文件：create 可单独用（与 DSH 壳同一条规则）')
{
  const p = path.join(tmp, 'made.md')
  const res = run(['edit', '--file', p, '--create', 'hello\n'])
  const env2 = json(res)
  check(env2.ok === true && env2.result?.operation === 'create', `不给 --hunks 也能建文件 operation=${env2.result?.operation}`, JSON.stringify(env2).slice(0, 140))
  check(fs.readFileSync(p, 'utf8') === 'hello\n', '内容是逐字节写下的')
  // 兼容：显式给 `--hunks '[]'` 仍然可用（旧脚本不该因此变红）
  const p2 = path.join(tmp, 'made2.md')
  check(json(run(['edit', '--file', p2, '--hunks', '[]', '--create', 'hi\n'])).ok === true, "显式 `--hunks '[]' --create` 仍可用（向后兼容）")
  const again = json(run(['edit', '--file', p, '--create', 'other\n']))
  check(again.ok === false, '已存在时不覆盖（create 只用于不存在）', JSON.stringify(again).slice(0, 140))
}

// ── E1 `--create` 的取值：以 `--` 开头、含换行，都不能被吞 ────────────────
// 实测（T6 第 3 条）：`flag()` 把“下一个参数以 `--` 开头”一律当“这个旗标没带值”，
// 于是 `--create "---\ntitle: x"`（front matter）的值被静默丢掉，报错还是
// `PATCH_NOT_FOUND … to create it, pass create`——传了 create 却被叫去传 create。
say('E1 --create 的取值：front matter / 含换行 / 后面还跟旗标')
{
  const fm = '---\ntitle: x\n---\n\nbody\n'
  const p = path.join(tmp, 'frontmatter.md')
  const res = json(run(['edit', '--file', p, '--create', fm]))
  check(res.ok === true && res.result?.operation === 'create', '值以 `---` 开头也能建文件', JSON.stringify(res).slice(0, 140))
  check(fs.readFileSync(p, 'utf8') === fm, '完整内容逐字节落下（换行与 `--` 都没丢）', JSON.stringify(fs.readFileSync(p, 'utf8')))
  // 值后面还跟着另一个旗标：最容易被误判成“没带值”的形状。
  // 注意**不能**用 `json()` 断这一条：`json()` 取的是 stdout 最后一行，而 `--pretty` 是多行输出
  // （我第一版就是这么写错的——产品是对的，断言在量错东西）。这里直接看退出码与磁盘。
  const p2 = path.join(tmp, 'frontmatter2.md')
  const withFlag = run(['edit', '--file', p2, '--create', fm, '--pretty'])
  check(withFlag.status === 0, `值后面再跟一个旗标仍然正确（exit=${withFlag.status}）`, String(withFlag.stderr).slice(0, 90))
  check(fs.readFileSync(p2, 'utf8') === fm, '第二种形状下内容也完整')
  // `@文件` 形式：长内容绕开命令行引号（推荐写法，帮助文本里也写了）
  const bodyFile = path.join(tmp, 'body.txt')
  fs.writeFileSync(bodyFile, fm)
  const p3 = path.join(tmp, 'fromfile.md')
  check(json(run(['edit', '--file', p3, '--create', `@${bodyFile}`])).ok === true, '`--create @文件` 可用')
  check(fs.readFileSync(p3, 'utf8') === fm, '`@文件` 形式下内容也完整')
}

// ── E3 `--hunks-file` 的前导 BOM ─────────────────────────────────────────
// PowerShell 5.1 的 `Set-Content -Encoding UTF8` 默认写 BOM ⇒ `Unexpected token '\uFEFF'`。
// 那是**工具能自己处理**的事（剥掉就好），没有理由转嫁给看不见那个字符的用户。
say('E3 --hunks-file：前导 BOM 不让它失败')
{
  const f = write('bomhunks.md', utf8('alpha\nbravo\n'))
  json(run(['read', '--file', f.path, '--mode', 'full']))
  const hunksPath = path.join(tmp, 'hunks-bom.json')
  fs.writeFileSync(hunksPath, Buffer.concat([BOM, utf8('[{"lines":[2,2],"replace":"BRAVO"}]')]))
  const res = json(run(['edit', '--file', f.path, '--hunks-file', hunksPath]))
  check(res.ok === true, '带 BOM 的 hunks 文件照样能编辑', JSON.stringify(res).slice(0, 140))
  check(fs.readFileSync(f.path, 'utf8') === 'alpha\nBRAVO\n', '落盘正确', JSON.stringify(fs.readFileSync(f.path, 'utf8')))
  // 真坏 JSON 时要报**实际来源**（旧版一律报 `--hunks`，把排查引到错方向）
  const badPath = path.join(tmp, 'hunks-bad.json')
  fs.writeFileSync(badPath, '{ not json')
  const bad = json(run(['edit', '--file', f.path, '--hunks-file', badPath]))
  check(bad.ok === false && String(bad.error).includes('--hunks-file'), '坏 JSON 报的是实际来源（--hunks-file）', String(bad.error).slice(0, 110))
}

// ── E2 平铺旗标：一个 hunk 不必先包成 JSON 数组 ─────────────────────────
// 与 DSH 壳那边的容错同一个形状（那边实测 27 次失败是 `{file_path,start_line,end_line,replace}`）。
// 容错规则只住一份（`locator-lab/args.mjs` 的 `flatHunk`），这里验的是**入口真的接上了**。
say('E2 平铺旗标：edit --lines / --replace')
{
  const f = write('flat.md', utf8('alpha\nbravo\ncharlie\n'))
  // 先 read 建立观测（区域新鲜度闸门依赖它）；本套件没有 readFull 助手，read 也要走 run。
  const seen = json(run(['read', '--file', f.path, '--mode', 'full']))
  check(seen.ok === true, 'E2 先 read 建立观测', JSON.stringify(seen).slice(0, 120))
  const flat = json(run(['edit', '--file', f.path, '--lines', '3', '--replace', 'CHARLIE', '--expect', 'charlie']))
  check(flat.ok === true, '平铺旗标可以改一行', JSON.stringify(flat).slice(0, 160))
  check(fs.readFileSync(f.path, 'utf8') === 'alpha\nbravo\nCHARLIE\n', '落盘正确', JSON.stringify(fs.readFileSync(f.path, 'utf8')))
  // 半成品（只有 --replace、没有地址）必须继续报“需要 hunks”，不得被当成一个缺地址的 hunk
  const half = json(run(['edit', '--file', f.path, '--replace', 'X']))
  check(half.ok === false && half.code === 'USAGE', '只有 --replace ⇒ USAGE（不给假地址）', `${half.code}: ${String(half.error).slice(0, 70)}`)
  // 两种形状同时给：`--hunks` 优先（显式数组是更强的意图表达）
  json(run(['read', '--file', f.path, '--mode', 'full']))
  const both = json(run(['edit', '--file', f.path, '--lines', '1', '--replace', 'ZZ', '--hunks', '[{"lines":[2,2],"replace":"BRAVO"}]']))
  check(both.ok === true && both.result?.applied?.[0]?.line === 2, '--hunks 与旗标同时给 ⇒ 以 --hunks 为准', JSON.stringify(both).slice(0, 140))
  check(fs.readFileSync(f.path, 'utf8') === 'alpha\nBRAVO\nCHARLIE\n', '两种形状同给时只有 --hunks 那一条生效', JSON.stringify(fs.readFileSync(f.path, 'utf8')))
}

// ── F MCP ────────────────────────────────────────────────────────────────
say('F MCP：initialize / tools/list / tools/call')
{
  const f = write('mcp.md', utf8('alpha\nbeta\ngamma\ndelta\n'))
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'aura_read', arguments: { file_path: f.path, mode: 'map' } } },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'aura_edit', arguments: { file_path: f.path, hunks: [{ lines: [4, 4], replace: 'EDITED' }] } },
    },
  ]
  const res = spawnSync(process.execPath, [mcpBin], { input: `${frames.map((x) => JSON.stringify(x)).join('\n')}\n`, encoding: 'utf8', env })
  const replies = res.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const byId = new Map(replies.map((r) => [r.id, r]))
  check(byId.get(1)?.result?.protocolVersion === '2025-06-18', 'initialize 回显协议版本', JSON.stringify(byId.get(1)).slice(0, 120))
  check(byId.get(1)?.result?.serverInfo?.name === 'aura-basetools', 'serverInfo.name = aura-basetools')
  // 版本号曾经写死在 bin 里（包到 0.4.0，服务对外还报 0.2.1）—— 这里钉住它跟包清单一致
  const manifest = (() => {
    try {
      return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    } catch {
      return null
    }
  })()
  if (manifest !== null) check(byId.get(1)?.result?.serverInfo?.version === manifest.version, `serverInfo.version 跟包一致（${manifest.version}）`, String(byId.get(1)?.result?.serverInfo?.version))
  const tools = byId.get(2)?.result?.tools ?? []
  check(tools.length === 4 && tools.some((t) => t.name === 'aura_read') && tools.some((t) => t.name === 'aura_edit') && tools.some((t) => t.name === 'aura_undo') && tools.some((t) => t.name === 'aura_transactions'), `tools/list 四个工具（${tools.map((t) => t.name).join(',')}`)
  const readEnv = JSON.parse(byId.get(3)?.result?.content?.[0]?.text ?? '{}')
  check(readEnv.ok === true && Array.isArray(readEnv.symbols ?? []), 'aura_read 经 MCP 可用', JSON.stringify(readEnv).slice(0, 120))
  const editEnv = JSON.parse(byId.get(4)?.result?.content?.[0]?.text ?? '{}')
  check(editEnv.ok === true, 'aura_edit 经 MCP 可用', JSON.stringify(editEnv).slice(0, 140))
  check(fs.readFileSync(f.path, 'utf8').includes('EDITED'), 'MCP 路径真的落盘了')
  check(replies.every((r) => r.jsonrpc === '2.0'), '每条回包都是 JSON-RPC 2.0')
}

// ── G MCP：坏参数必须回包 ──────────────────────────────────────────────
// 不回包 = 客户端永久挂起（不是"稳"）。实测过一次：参数名写成 file，服务只写 stderr，
// 客户端一直等到自己的超时。这里把六种坏输入全钉住，并要求服务之后仍然活着。
say('G MCP：坏参数 / 未知工具 / 服务存活')
{
  const f = write('mcp-bad.md', utf8('alpha\nbeta\n'))
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'aura_read', arguments: { file: f.path, mode: 'map' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'aura_read', arguments: { file_path: f.path, mode: 'outline' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'aura_read', arguments: { file_path: path.join(tmp, 'nope.md'), mode: 'map' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'aura_edit', arguments: { file_path: f.path, hunks: 'nope' } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'aura_nope', arguments: {} } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'aura_read', arguments: { file_path: f.path, mode: 'map' } } },
  ]
  const res = spawnSync(process.execPath, [mcpBin], { input: `${frames.map((x) => JSON.stringify(x)).join('\n')}\n`, encoding: 'utf8', env })
  const replies = res.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const byId = new Map(replies.map((r) => [r.id, r]))
  const envOf = (id) => JSON.parse(byId.get(id)?.result?.content?.[0]?.text ?? '{}')
  check(replies.length === 7, `7 条请求全部有回包（收到 ${replies.length}）`)
  check(envOf(2).code === 'BAD_ARGS', `参数名写错 → BAD_ARGS（${envOf(2).code}）`)
  check(envOf(3).code === 'READ_BAD_MODE', `mode 写错 → READ_BAD_MODE（${envOf(3).code}）`)
  check(envOf(4).code === 'FS_NOT_FOUND', `文件不存在 → FS_NOT_FOUND（${envOf(4).code}）`)
  check(envOf(5).code === 'BAD_ARGS', `hunks 不是数组 → BAD_ARGS（${envOf(5).code}）`)
  check(envOf(6).code === 'UNKNOWN_TOOL', `未知工具 → UNKNOWN_TOOL（${envOf(6).code}）`)
  check(envOf(7).ok === true, '连着 5 次坏参数之后，正常调用仍然可用（服务没死）')
  check(res.stderr.trim() === '', '没靠 stderr 兑底（不用抛出当回包）', res.stderr.trim().slice(0, 80))
}

// ── H MCP：宽容的参数形状 ──────────────────────────────────────────────
// 模型把行区间写坏是常态（`"lines": 412, 500` 甚至不是合法 JSON，那种情况宿主就拒了）。
// 只要参数对象到了，能容的都该容；MCP 客户端把 arguments 当**字符串**传也要能用。
say('H MCP：参数形状宽容度')
{
  const f = write('mcp-shapes.md', utf8('l1\nl2\nl3\nl4\n'))
  const call = (id, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'aura_read', arguments: args } })
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    call(2, { file_path: f.path, start_line: 1, end_line: 2 }),
    call(3, { file_path: f.path, lines: '2,3' }),
    call(4, { file_path: f.path, lines: 2 }),
    call(5, { file_path: f.path, lines: { start: 1, end: 2 } }),
    // arguments 整体是 JSON 字符串（实测有客户端这么传）
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'aura_read', arguments: JSON.stringify({ file_path: f.path, start_line: 1 }) } },
    // arguments 是解不开的字符串：必须回结构化错误，不能挂死
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'aura_read', arguments: '不是 JSON' } },
  ]
  const res = spawnSync(process.execPath, [mcpBin], { input: `${frames.map((x) => JSON.stringify(x)).join('\n')}\n`, encoding: 'utf8', env })
  const replies = res.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const byId = new Map(replies.map((r) => [r.id, r]))
  const envOf = (id) => JSON.parse(byId.get(id)?.result?.content?.[0]?.text ?? '{}')
  check(replies.length === 7, `7 条全部有回包（收到 ${replies.length}）`)
  check(envOf(2).ok === true && envOf(2).mode === 'lines', `start_line/end_line 可用（mode=${envOf(2).mode}）`)
  check(envOf(3).ok === true && envOf(3).mode === 'lines', `lines="2,3" 可用（mode=${envOf(3).mode}）`)
  check(envOf(4).ok === true && envOf(4).mode === 'lines', `lines=2 单行可用（mode=${envOf(4).mode}）`)
  check(envOf(5).ok === true && envOf(5).mode === 'lines', `lines={{start,end}} 可用（mode=${envOf(5).mode}）`)
  check(envOf(6).ok === true && envOf(6).mode === 'lines', 'arguments 是 JSON 字符串时也能用（自动解析）')
  check(envOf(7).code === 'BAD_ARGS', `arguments 解不开 → BAD_ARGS（${envOf(7).code}）`)
}

// ── I MCP：hunk 的行区间也能用几种写法 ─────────────────────────────────
say('I MCP：hunk 行区间的宽容度')
{
  const f = write('mcp-hunks.md', utf8('l1\nl2\nl3\nl4\n'))
  const edit = (id, hunk) => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'aura_edit', arguments: { file_path: f.path, hunks: [hunk] } },
  })
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    edit(2, { start_line: 1, end_line: 1, replace: 'A' }),
    edit(3, { lines: '2,2', replace: 'B' }),
    edit(4, { lines: [3, 3], replace: 'C' }),
    edit(5, { lines: 4, replace: 'D' }),
  ]
  const res = spawnSync(process.execPath, [mcpBin], { input: `${frames.map((x) => JSON.stringify(x)).join('\n')}\n`, encoding: 'utf8', env })
  const replies = res.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const byId = new Map(replies.map((r) => [r.id, r]))
  const envOf = (id) => JSON.parse(byId.get(id)?.result?.content?.[0]?.text ?? '{}')
  check(envOf(2).ok === true, `start_line/end_line 定位可用（${JSON.stringify(envOf(2)).slice(0, 60)}）`)
  check(envOf(3).ok === true, `lines="2,2" 定位可用（${JSON.stringify(envOf(3)).slice(0, 60)}）`)
  check(envOf(4).ok === true, `lines=[3,3] 定位可用（${JSON.stringify(envOf(4)).slice(0, 60)}）`)
  check(envOf(5).ok === true, `lines=4 单行定位可用（${JSON.stringify(envOf(5)).slice(0, 60)}）`)
  check(fs.readFileSync(f.path, 'utf8') === 'A\nB\nC\nD\n', `四种写法都真的落盘了（${JSON.stringify(fs.readFileSync(f.path, 'utf8'))}）`)
}

// ── J 两种布局：src 一份引擎、摊平（包内）一份引擎 ────────────────────────
/**
 * 为什么这一节是**行为验收**而不是形状断言：本套件从前的 23 条全红，就是从"引擎找不到"来的——
 * 入口写死 `'../locator-lab/…'`，只在摊平布局下成立，src 布局下 CLI 一启动就 ERR_MODULE_NOT_FOUND。
 * 所以这里两个布局都要**真跑读与真跑改**（只看 import 成功会漏掉"能加载但用不了"），
 * 并且额外钉住两种失败：换了布局就静默不报、以及摊平时把引擎内容换掉。
 */
say('J 两种布局：src 面与摊平（包内）面都解析得到引擎，且都真能读写')
{
  const srcBin = fs.realpathSync(path.join(here, '..', 'bin', 'aura.mjs'))
  const src = layoutRoundTrip(srcBin, 'srclayout')
  check(src.read.exit === 0 && src.read.ok === true, `src 布局 CLI 能启动并读出目录（exit=${src.read.exit}）`, JSON.stringify(src.read).slice(0, 160))
  check(src.read.symbols >= 1, `src 布局读回执带符号（symbols=${src.read.symbols}）`, JSON.stringify(src.read).slice(0, 160))
  check(src.edit.exit === 0 && src.edit.ok === true, `src 布局 CLI 能改（exit=${src.edit.exit}）`, JSON.stringify(src.edit).slice(0, 160))
  check(src.text.includes('const a = 42'), 'src 布局的编辑真的落盘', JSON.stringify(src.text))

  const pkgRoot = flattenLayout()
  const flatBin = path.join(pkgRoot, 'bin', 'aura.mjs')
  check(fs.existsSync(path.join(pkgRoot, 'locator-lab', 'read-core.mjs')), '摊平布局摆出了 locator-lab/read-core.mjs')
  check(fs.existsSync(path.join(pkgRoot, 'package.json')) === false, '摊平布局里没有 package.json（解析不靠包清单）')
  const flat = layoutRoundTrip(flatBin, 'flatlayout')
  check(flat.read.exit === 0 && flat.read.ok === true, `摊平布局 CLI 能启动并读出目录（exit=${flat.read.exit}）`, JSON.stringify(flat.read).slice(0, 160))
  check(flat.edit.exit === 0 && flat.edit.ok === true, `摊平布局 CLI 能改（exit=${flat.edit.exit}）`, JSON.stringify(flat.edit).slice(0, 160))
  check(flat.text.includes('const a = 42'), '摊平布局的编辑真的落盘', JSON.stringify(flat.text))
  // 摊平是**搬位置**，不是改内容：两边引擎逐字节一样时，两边的判据才是同一个引擎给的
  const engineSame = ['read-core.mjs', 'args.mjs', 'write-path.mjs'].every((n) =>
    fs.readFileSync(path.join(engineDir, n)).equals(fs.readFileSync(path.join(pkgRoot, 'locator-lab', n))),
  )
  check(engineSame, '摊平布局的引擎与 src 布局逐字节一致（摊平只搬位置）')
  // 打包器真产出的那份（跑过 `node build/make-bundle.mjs` 时）也必须是同一个答案
  const bundled = path.join(here, '..', '..', '..', 'dist', 'aura-basetools', 'bin', 'aura.mjs')
  if (fs.existsSync(bundled)) {
    const dist = layoutRoundTrip(bundled, 'distlayout')
    check(dist.read.exit === 0 && dist.read.ok === true && dist.edit.exit === 0 && dist.edit.ok === true, '打包器真产出的 dist/aura-basetools/ 也解析得到（读写各一次）', JSON.stringify({ read: dist.read.exit, edit: dist.edit.exit }))
  }

  // 两种布局都不中时：不静默兜底。把引擎**移开**（不是删），跑一次，再移回来。
  const moved = path.join(tmp, 'engine-moved-away')
  fs.renameSync(path.join(pkgRoot, 'locator-lab'), moved)
  const orphan = spawnSync(process.execPath, [flatBin, '--version'], { encoding: 'utf8', env })
  check(orphan.status !== 0, `两个候选都不中 ⇒ 非零退出，不静默兜底（exit=${orphan.status}）`)
  check(/找不到引擎/.test(String(orphan.stderr)), '报错说明判据与试过的两个候选', String(orphan.stderr).split('\n').slice(0, 3).join(' / ').slice(0, 120))
  fs.renameSync(moved, path.join(pkgRoot, 'locator-lab'))
  check(fs.existsSync(path.join(pkgRoot, 'locator-lab', 'read-core.mjs')), '引擎已移回原位（不污染后续断言）')
}

// ══════════════════════════════════════════════════════════════════════════
// MT 段：独立面（CLI + MCP）的 `targets`（fs-contract-v2 多目标 / 施工单 C1）
//   段名一律带 `MT-` 前缀：本文件既有的 A–J 是别的验收面，重名会让日志认不出是哪一段。
// ══════════════════════════════════════════════════════════════════════════

/** MT 段共用的场景内容（固定 ⇒ 回执确定；`beta` 在全文件里唯一 ⇒ line_cue 可用）。 */
const MT_SOURCE = 'function alpha() {\n  const a = 1\n  return a\n}\n\nfunction beta() {\n  const b = 2\n  return b\n}\n'

/** 一个干净的场景目录：**自带**缓存目录（观测是跨进程的，共用一份缓存会互相顶掉）。 */
const mtScene = (label) => {
  const dir = fs.mkdtempSync(path.join(tmp, `mt-${label}-`))
  const sceneEnv = { ...process.env, AURA_CACHE_DIR: path.join(dir, 'cache') }
  return {
    dir,
    write: (name, text) => fs.writeFileSync(path.join(dir, name), Buffer.from(text, 'utf8')),
    run: (args) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', env: sceneEnv }),
    mcp: (frames) =>
      spawnSync(process.execPath, [mcpBin], {
        cwd: dir,
        input: `${frames.map((f) => JSON.stringify(f)).join('\n')}\n`,
        encoding: 'utf8',
        env: sceneEnv,
      }),
  }
}

/** 首个差异（逐字节判据的诊断：只说“不一样”等于没说）。 */
const byteDiff = (got, want) => {
  const a = Buffer.from(String(got), 'utf8')
  const b = Buffer.from(String(want), 'utf8')
  if (a.equals(b)) return null
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1
  return `第 ${i} 字节起不同：得到 ${JSON.stringify(a.subarray(i, i + 32).toString('utf8'))}，期望 ${JSON.stringify(b.subarray(i, i + 32).toString('utf8'))}`
}

/**
 * 黄金集的**归一**：只抹掉“这台机器把场景放在哪个目录”，其余（字段顺序、空白、每一个字符）逐字节比对。
 *   · 场景目录 ⇒ `<DIR>`（路径在 JSON 里是转义过的，所以先换转义形态）；
 *   · 句柄 `h<4 hex><8 hex>:a-b` 的**前 4 位**是账本键（绝对路径）的哈希 ⇒ `h<ID>`；
 *     后 8 位（内容 + 区间）照旧参与比对。
 */
const normalizeGolden = (text, dir) => {
  // macOS 的 /var/... 常是 /private/var/... 的符号链接；CLI 写出的是 realpath，
  // 场景目录却是 mkdtemp 的原始写法——两种都必须收敛成 <DIR>。
  const variants = new Set([dir])
  try { variants.add(fs.realpathSync(dir)) } catch { /* 目录已消失时只保留原写法 */ }
  let out = String(text)
  for (const variant of variants) {
    const escaped = JSON.stringify(variant).slice(1, -1)
    const posix = variant.split(path.sep).join('/')
    out = out.split(escaped).join('<DIR>').split(posix).join('<DIR>')
  }
  return out
    .replace(/(<DIR>)[\\/]+/g, '$1/')
    .replace(/h[0-9a-f]{4}(?=[0-9a-f]{8}:)/g, 'h<ID>')
}

/**
 * ── MT-J 的用例定义：12 个单目标 CLI 调用（读 7 模式各一 + 写 5 种） ──────────────
 *
 * `prepare` 是“这次调用之前必须发生的那件事”：写之前要先读一次（区域新鲜度闸门的基准），
 * `changed` 之前要先拿到令牌。**采集与比对共用这一份定义** ⇒ 黄金集不可能与用例漂开。
 */
const CLI_GOLDEN_CALLS = [
  { name: 'read-map', file: 'scene.js', args: () => ['read', '--file', 'scene.js', '--mode', 'map'] },
  { name: 'read-digest', file: 'scene.js', args: () => ['read', '--file', 'scene.js', '--mode', 'digest'] },
  { name: 'read-full', file: 'scene.js', args: () => ['read', '--file', 'scene.js', '--mode', 'full'] },
  { name: 'read-around', file: 'scene.js', args: () => ['read', '--file', 'scene.js', '--mode', 'around', '--around', 'beta'] },
  { name: 'read-lines', file: 'scene.js', args: () => ['read', '--file', 'scene.js', '--mode', 'lines', '--lines', '1,3'] },
  { name: 'read-search', file: 'scene.js', args: () => ['read', '--file', 'scene.js', '--mode', 'search', '--search', 'return'] },
  {
    name: 'read-changed',
    file: 'scene.js',
    // 令牌是内容指纹（`<hash>:<字节数>`）：现场读一次取回来，不在黄金集里钉一个手抄的令牌。
    prepare: (spawn) => JSON.parse(spawn(['read', '--file', 'scene.js', '--mode', 'full']).stdout).version,
    args: (token) => ['read', '--file', 'scene.js', '--mode', 'changed', '--since', String(token)],
  },
  {
    name: 'edit-target',
    file: 'w.js',
    prepare: (spawn) => void spawn(['read', '--file', 'w.js', '--mode', 'full']),
    args: () => ['edit', '--file', 'w.js', '--hunks', JSON.stringify([{ target: 'alpha', replace: 'function alpha() {\n  return 42\n}' }])],
  },
  {
    name: 'edit-lines',
    file: 'w.js',
    prepare: (spawn) => void spawn(['read', '--file', 'w.js', '--mode', 'full']),
    args: () => ['edit', '--file', 'w.js', '--hunks', JSON.stringify([{ lines: [2, 2], replace: '  const a = 42' }])],
  },
  {
    name: 'edit-line-cue',
    file: 'w.js',
    prepare: (spawn) => void spawn(['read', '--file', 'w.js', '--mode', 'full']),
    args: () => ['edit', '--file', 'w.js', '--hunks', JSON.stringify([{ line_cue: 'beta', replace: 'function beta() { /* cue */' }])],
  },
  {
    name: 'edit-anchor',
    file: 'w.js',
    prepare: (spawn) => void spawn(['read', '--file', 'w.js', '--mode', 'full']),
    args: () => ['edit', '--file', 'w.js', '--hunks', JSON.stringify([{ anchor: '  const b = 2', replace: '  const b = 22' }])],
  },
  // `create` 没有“读一次”这回事：文件本来就还不存在。
  { name: 'edit-create', file: null, args: () => ['edit', '--file', 'made.md', '--create', 'hello\n'] },
]

/** 跑一次黄金集用例（干净的目录 + 干净的缓存 ⇒ 同一份输入恒定给同一份回执）。 */
const runGoldenCall = (call) => {
  const dir = fs.mkdtempSync(path.join(tmp, `cli-golden-${call.name}-`))
  const cliEnv = { ...process.env, AURA_CACHE_DIR: path.join(dir, 'cache') }
  const spawn = (args) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', env: cliEnv })
  if (call.file !== null) fs.writeFileSync(path.join(dir, call.file), Buffer.from(MT_SOURCE, 'utf8'))
  const ctx = call.prepare === undefined ? undefined : call.prepare(spawn)
  const res = spawn(call.args(ctx))
  return { exit: res.status, stdout: normalizeGolden(res.stdout, dir) }
}

/**
 * 单目标 CLI 回执的**黄金集**（本单红线：`--file` 那条路一个字节都不许变）。
 *
 * 它是**脚本生成**的，不许手写 —— 采集走上面那份用例定义（因此采集与比对不可能漂）：
 *
 *     node aura-basetools/src/aura-standalone/test/standalone-test.mjs --capture-cli-goldens
 *
 * 采完把打印出来的那份 JSON 整段贴回来（本套件在**包内 test 目录**的那个布局里也会跑，
 * 所以黄金集内联在本文件里，而不是另建一个只有源树才有的文件）。
 */
const CLI_GOLDEN = {
  "read-map": {
    "exit": 0,
    "stdout": "{\"ok\":true,\"mode\":\"map\",\"totalLines\":10,\"contentBudget\":7492,\"version\":\"531e7692:92\",\"symbols\":4,\"shown\":4,\"byKind\":{\"function\":2,\"variable\":2},\"text\":\"10 lines · 4 symbols (function:2 variable:2)\\nexported (0):\\ninternal:\\n  function  alpha                      1-4\\n  function  beta                       6-9\",\"omitted\":\"2 nested locals omitted (inside a function — reach them with mode=lines, not target=)\",\"next\":\"mode=around around=<name> · mode=lines lines=[a,b] · mode=digest for signatures\"}\n"
  },
  "read-digest": {
    "exit": 0,
    "stdout": "{\"ok\":true,\"mode\":\"digest\",\"totalLines\":10,\"contentBudget\":7492,\"version\":\"531e7692:92\",\"symbols\":4,\"exported\":[],\"text\":\"10 lines · 4 symbols · 0 control-flow\\nexported: (none)\\nimports: (none)\\nexternal calls: (none)\\n--- signatures ---\\n1-4 (  4 lines) function alpha()\\n6-9 (  4 lines) function beta()\",\"next\":\"mode=around around=<name> to see one function\"}\n"
  },
  "read-full": {
    "exit": 0,
    "stdout": "{\"ok\":true,\"mode\":\"full\",\"totalLines\":10,\"contentBudget\":7492,\"version\":\"531e7692:92\",\"center\":1,\"label\":\"full file\",\"relocatable\":[{\"line\":1,\"target\":\"alpha\",\"lines\":[1,4]}],\"shown\":\"1-10\",\"text\":\"1: function alpha() {\\n2:   const a = 1\\n3:   return a\\n4: }\\n5: \\n6: function beta() {\\n7:   const b = 2\\n8:   return b\\n9: }\\n10: \"}\n"
  },
  "read-around": {
    "exit": 0,
    "stdout": "{\"ok\":true,\"mode\":\"around\",\"totalLines\":10,\"contentBudget\":7492,\"version\":\"531e7692:92\",\"center\":6,\"label\":\"around symbol function:beta (6-9)\",\"relocatable\":[{\"line\":1,\"target\":\"alpha\",\"lines\":[1,4]}],\"shown\":\"1-10\",\"text\":\"1: function alpha() {\\n2:   const a = 1\\n3:   return a\\n4: }\\n5: \\n6: function beta() {\\n7:   const b = 2\\n8:   return b\\n9: }\\n10: \"}\n"
  },
  "read-lines": {
    "exit": 0,
    "stdout": "{\"ok\":true,\"mode\":\"lines\",\"totalLines\":10,\"contentBudget\":7492,\"version\":\"531e7692:92\",\"center\":1,\"label\":\"requested range\",\"relocatable\":[{\"line\":1,\"target\":\"alpha\",\"lines\":[1,4]}],\"shown\":\"1-3\",\"handle\":\"h<ID>a8d61e88:1-3\",\"text\":\"1: function alpha() {  <h<ID>a8d61e88:1-3>\\n2:   const a = 1\\n3:   return a\"}\n"
  },
  "read-search": {
    "exit": 0,
    "stdout": "{\"ok\":true,\"mode\":\"search\",\"totalLines\":10,\"contentBudget\":7492,\"version\":\"531e7692:92\",\"matches\":2,\"handles\":[{\"line\":3,\"handle\":\"h<ID>82986ddc:3-3\"},{\"line\":8,\"handle\":\"h<ID>85987295:8-8\"}],\"relocatable\":[{\"line\":3,\"target\":\"alpha\",\"lines\":[1,4]},{\"line\":8,\"target\":\"beta\",\"lines\":[6,9]}],\"text\":\"3: return a  <h<ID>82986ddc:3-3>\\n8: return b  <h<ID>85987295:8-8>\"}\n"
  },
  "read-changed": {
    "exit": 0,
    "stdout": "{\"ok\":true,\"mode\":\"changed\",\"totalLines\":10,\"contentBudget\":7492,\"version\":\"531e7692:92\",\"note\":\"no change since that version\",\"text\":\"no change since that version\"}\n"
  },
  "edit-target": {
    "exit": 0,
    "stdout": "{\"ok\":true,\"result\":{\"path\":\"<DIR>\\\\w.js\",\"applied\":[{\"line\":1,\"tier\":\"symbol\",\"byNear\":false,\"actual\":\"function alpha() {\\n  const a = 1\\n  return a\\n}\",\"replaced\":\"function alpha() {\\n  return 42\\n}\"}],\"dryRun\":false,\"write_verify\":{\"level\":\"bytes\",\"bytes\":79}}}\n"
  },
  "edit-lines": {
    "exit": 0,
    "stdout": "{\"ok\":true,\"result\":{\"path\":\"<DIR>\\\\w.js\",\"applied\":[{\"line\":2,\"tier\":\"lines\",\"byNear\":false,\"actual\":\"  const a = 1\",\"replaced\":\"  const a = 42\"}],\"dryRun\":false,\"write_verify\":{\"level\":\"bytes\",\"bytes\":93}}}\n"
  },
  "edit-line-cue": {
    "exit": 0,
    "stdout": "{\"ok\":true,\"result\":{\"path\":\"<DIR>\\\\w.js\",\"applied\":[{\"line\":6,\"tier\":\"lineCue\",\"byNear\":false,\"actual\":\"function beta() {\",\"replaced\":\"function beta() { /* cue */\"}],\"dryRun\":false,\"write_verify\":{\"level\":\"bytes\",\"bytes\":102}}}\n"
  },
  "edit-anchor": {
    "exit": 0,
    "stdout": "{\"ok\":true,\"result\":{\"path\":\"<DIR>\\\\w.js\",\"applied\":[{\"line\":7,\"tier\":\"exact\",\"byNear\":false,\"actual\":\"  const b = 2\",\"replaced\":\"  const b = 22\"}],\"dryRun\":false,\"write_verify\":{\"level\":\"bytes\",\"bytes\":93}}}\n"
  },
  "edit-create": {
    "exit": 0,
    "stdout": "{\"ok\":true,\"result\":{\"path\":\"<DIR>\\\\made.md\",\"operation\":\"create\",\"applied\":[{\"line\":1,\"tier\":\"create\",\"actual\":\"\",\"replaced\":\"hello\\n\"}],\"dryRun\":false,\"write_verify\":{\"level\":\"bytes\",\"bytes\":6}}}\n"
  }
}

if (process.argv.includes('--capture-cli-goldens')) {
  const captured = {}
  for (const call of CLI_GOLDEN_CALLS) {
    const got = runGoldenCall(call)
    captured[call.name] = { exit: got.exit, stdout: got.stdout }
    say(`· 采到 ${call.name}（exit=${got.exit}，${Buffer.byteLength(got.stdout, 'utf8')} 字节）`)
  }
  say('')
  process.stdout.write(`${JSON.stringify(captured, null, 2)}\n`)
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(0)
}

// ── MT-J 单目标零回归（本单红线） ───────────────────────────────────────
say('MT-J 单目标零回归：12 个 CLI 调用的 stdout 与黄金集逐字节相同')
{
  check(CLI_GOLDEN_CALLS.length === 12, `黄金集覆盖 12 个调用（读 7 + 写 5，实得 ${CLI_GOLDEN_CALLS.length}）`)
  check(CLI_GOLDEN !== null && Object.keys(CLI_GOLDEN).length === 12, '黄金集已采集（--capture-cli-goldens）')
  for (const call of CLI_GOLDEN_CALLS) {
    const golden = CLI_GOLDEN === null ? undefined : CLI_GOLDEN[call.name]
    const got = runGoldenCall(call)
    if (golden === undefined) {
      check(false, `MT-J ${call.name}：黄金集里没有这一条`)
      continue
    }
    // 黄金集里 <DIR> 后的分隔符可能是采集平台的写法；CLI 的 path 在两平台不同，
    // 只归一这个位置，不碰正文里的转义。
    const goldenStdout = golden.stdout.replace(/(<DIR>)[\\/]+/g, '$1/')
    const diff = byteDiff(got.stdout, goldenStdout)
    check(got.exit === golden.exit && diff === null, `MT-J ${call.name}：stdout 逐字节相同（exit=${golden.exit}）`, diff ?? `exit ${got.exit} ≠ ${golden.exit}`)
  }
}

// ── MT-G 多目标读（CLI） ────────────────────────────────────────────────
say('MT-G 多目标读：CLI --targets（逐项/顺序/不连坐/汇总行/退出码）')
{
  const scene = mtScene('g')
  scene.write('a.js', MT_SOURCE)
  scene.write('b.md', 'one\ntwo\nthree\n')
  const res = scene.run([
    'read',
    '--targets',
    JSON.stringify([
      { file_path: 'a.js', mode: 'digest' },
      { file_path: 'b.md', mode: 'lines', lines: [1, 2] },
    ]),
  ])
  const batch = json(res)
  check(res.status === 0 && batch.ok === true, `① 两目标都成 ⇒ ok + exit 0（exit=${res.status}）`, JSON.stringify(batch).slice(0, 160))
  check(batch.targets === 2 && Array.isArray(batch.entries) && batch.entries.length === 2, `① entries 长度 2（targets=${batch.targets}）`)
  check(
    String(batch.entries?.[0]?.file_path ?? '').endsWith('a.js') && String(batch.entries?.[1]?.file_path ?? '').endsWith('b.md'),
    '① 顺序 = 输入序',
    JSON.stringify(batch.entries?.map((e) => e.file_path)),
  )
  // ① 每项与“单独一次单目标读”的同一字段值相同：拿整个信封逐字节比
  const soloA = json(scene.run(['read', '--file', 'a.js', '--mode', 'digest']))
  const soloB = json(scene.run(['read', '--file', 'b.md', '--mode', 'lines', '--lines', '1,2']))
  const entryA = JSON.stringify(batch.entries?.[0]?.envelope)
  const entryB = JSON.stringify(batch.entries?.[1]?.envelope)
  check(entryA === JSON.stringify(soloA), '① A 项信封与单独读逐字节相同', byteDiff(entryA, JSON.stringify(soloA)) ?? '')
  check(entryB === JSON.stringify(soloB), '① B 项信封与单独读逐字节相同', byteDiff(entryB, JSON.stringify(soloB)) ?? '')
  // ② 一项目标不存在：整批 ok=false，另一项照常可读（不连坐）
  const partial = json(
    scene.run([
      'read',
      '--targets',
      JSON.stringify([
        { file_path: 'a.js', mode: 'digest' },
        { file_path: 'nope.md', mode: 'full' },
      ]),
    ]),
  )
  check(partial.ok === false, '② 一项目标不存在 ⇒ 整批 ok=false', JSON.stringify(partial).slice(0, 140))
  check(partial.entries?.[0]?.ok === true && String(partial.entries?.[0]?.envelope?.text ?? '').length > 0, '② 另一项照常可读（不连坐）')
  check(partial.entries?.[1]?.ok === false && partial.entries?.[1]?.code === 'FS_NOT_FOUND', `② 缺的那项报 FS_NOT_FOUND（${partial.entries?.[1]?.code}）`)
  check(partial.summary === 'targets: 2 ｜ ok 1 ｜ not_found 1', `③ 汇总行 ${JSON.stringify(partial.summary)}`)
  check(partial.counts?.ok === 1 && partial.counts?.failed === 1, `③ counts ok=1 failed=1（${JSON.stringify(partial.counts)}）`)
  const missingOnly = scene.run(['read', '--targets', JSON.stringify([{ file_path: 'nope.md', mode: 'full' }])])
  check(missingOnly.status === 2 && json(missingOnly).ok === false, `④ 逐项失败 ⇒ 走结果通道、退出码 2（实测 ${missingOnly.status}）`)
}

// ── MT-H 多目标写（CLI） ────────────────────────────────────────────────
say('MT-H 多目标写：CLI --targets（真落盘/零写入/同文件合并/dry-run）')
{
  // ① 两个文件各一 hunk
  const scene = mtScene('h')
  scene.write('c.md', 'one\ntwo\n')
  scene.write('d.md', 'alpha\nbravo\n')
  scene.run(['read', '--file', 'c.md', '--mode', 'full'])
  scene.run(['read', '--file', 'd.md', '--mode', 'full'])
  const beforeC = fs.readFileSync(path.join(scene.dir, 'c.md'))
  const beforeD = fs.readFileSync(path.join(scene.dir, 'd.md'))
  const res = scene.run([
    'edit',
    '--targets',
    JSON.stringify([
      { file_path: 'c.md', hunks: [{ lines: [1, 1], replace: 'ONE' }] },
      { file_path: 'd.md', hunks: [{ lines: [2, 2], replace: 'BRAVO' }] },
    ]),
  ])
  const batch = json(res)
  check(res.status === 0 && batch.ok === true, `① 两个文件各一 hunk ⇒ ok + exit 0（exit=${res.status}）`, JSON.stringify(batch).slice(0, 200))
  check(batch.edits?.length === 2 && batch.edits.every((e) => e.landed === true), `① 逐项 landed（${batch.edits?.map((e) => `${e.outcome}/${e.landed}`).join(', ')}）`)
  check(fs.readFileSync(path.join(scene.dir, 'c.md'), 'utf8') === 'ONE\ntwo\n', '① c.md 真落盘', JSON.stringify(fs.readFileSync(path.join(scene.dir, 'c.md'), 'utf8')))
  check(fs.readFileSync(path.join(scene.dir, 'd.md'), 'utf8') === 'alpha\nBRAVO\n', '① d.md 真落盘', JSON.stringify(fs.readFileSync(path.join(scene.dir, 'd.md'), 'utf8')))
  check(!fs.readFileSync(path.join(scene.dir, 'c.md')).equals(beforeC) && !fs.readFileSync(path.join(scene.dir, 'd.md')).equals(beforeD), '① 两个文件的字节都变了（都写过）')
  // ① 逐项回执与单目标同形：字段集合相同（同一个渲染，不是另写一套）
  const soloScene = mtScene('h-solo')
  soloScene.write('solo.md', 'one\ntwo\n')
  soloScene.run(['read', '--file', 'solo.md', '--mode', 'full'])
  const solo = json(soloScene.run(['edit', '--file', 'solo.md', '--hunks', JSON.stringify([{ lines: [1, 1], replace: 'ONE' }])]))
  const keysOf = (o) => Object.keys(o ?? {}).sort().join(',')
  check(keysOf(batch.edits?.[0]?.receipt) === keysOf(solo.result), '① 逐项回执与单目标同形（字段集合相同）', `${keysOf(batch.edits?.[0]?.receipt)} vs ${keysOf(solo.result)}`)

  // ② 一项规划失败 ⇒ 零写入
  const zero = mtScene('h-zero')
  zero.write('c.md', 'one\ntwo\n')
  zero.write('d.md', 'alpha\nbravo\n')
  zero.run(['read', '--file', 'c.md', '--mode', 'full'])
  zero.run(['read', '--file', 'd.md', '--mode', 'full'])
  const keepC = fs.readFileSync(path.join(zero.dir, 'c.md'))
  const keepD = fs.readFileSync(path.join(zero.dir, 'd.md'))
  const failed = zero.run([
    'edit',
    '--targets',
    JSON.stringify([
      { file_path: 'c.md', hunks: [{ lines: [1, 1], replace: 'ONE' }] },
      { file_path: 'd.md', hunks: [{ lines: [99, 99], replace: 'NOPE' }] },
    ]),
  ])
  const failedEnv = json(failed)
  check(failedEnv.ok === false && failed.status === 2, `② 一项规划失败 ⇒ ok=false + exit 2（exit=${failed.status}）`, JSON.stringify(failedEnv).slice(0, 160))
  check(
    fs.readFileSync(path.join(zero.dir, 'c.md')).equals(keepC) && fs.readFileSync(path.join(zero.dir, 'd.md')).equals(keepD),
    '② 零写入：两处磁盘逐字节不变',
  )
  check(
    failedEnv.edits?.[1]?.outcome === 'failed' && typeof failedEnv.edits?.[1]?.error?.code === 'string',
    `② 回执说清哪一项什么码（index=${failedEnv.edits?.[1]?.index}，code=${failedEnv.edits?.[1]?.error?.code}）`,
  )
  check(/no files were changed/.test(String(failedEnv.summary)), `② 汇总行说清零写入（${failedEnv.summary}）`)
  check(failedEnv.aborted === 'plan', `② aborted=plan（${failedEnv.aborted}）`)

  // ③ 同文件两个目标 ⇒ 合并成一次提交
  const merged = mtScene('h-merge')
  merged.write('m.md', 'one\ntwo\nthree\n')
  merged.run(['read', '--file', 'm.md', '--mode', 'full'])
  const mergeEnv = json(
    merged.run([
      'edit',
      '--targets',
      JSON.stringify([
        { file_path: 'm.md', hunks: [{ lines: [1, 1], replace: 'ONE' }] },
        { file_path: 'm.md', hunks: [{ lines: [3, 3], replace: 'THREE' }] },
      ]),
    ]),
  )
  check(mergeEnv.ok === true && mergeEnv.edits?.length === 2 && mergeEnv.edits.every((e) => e.landed === true), `③ 同文件两个目标都落地（${mergeEnv.edits?.map((e) => e.outcome).join(',')}）`, JSON.stringify(mergeEnv).slice(0, 160))
  check(fs.readFileSync(path.join(merged.dir, 'm.md'), 'utf8') === 'ONE\ntwo\nTHREE\n', '③ 两处改动都在磁盘上（同一次提交里）', JSON.stringify(fs.readFileSync(path.join(merged.dir, 'm.md'), 'utf8')))
  check(/files 1/.test(String(mergeEnv.summary)), `③ 汇总行说清合并成 1 次提交（${mergeEnv.summary}）`)

  // ④ dry-run 不落盘
  const dry = mtScene('h-dry')
  dry.write('c.md', 'one\ntwo\n')
  dry.run(['read', '--file', 'c.md', '--mode', 'full'])
  const keep = fs.readFileSync(path.join(dry.dir, 'c.md'))
  const dryEnv = json(
    dry.run(['edit', '--dry-run', '--targets', JSON.stringify([{ file_path: 'c.md', hunks: [{ lines: [1, 1], replace: 'ONE' }] }])]),
  )
  check(dryEnv.ok === true && dryEnv.edits?.[0]?.outcome === 'dry_run', `④ dryRun 的回执是 dry_run（${dryEnv.edits?.[0]?.outcome}）`, JSON.stringify(dryEnv).slice(0, 160))
  check(fs.readFileSync(path.join(dry.dir, 'c.md')).equals(keep), '④ dryRun 不落盘（逐字节不变）')

  // ⑤ 结构性读数：provider 的 `writeText` 调用次数（子进程里看不见，只能在进程内对同一个适配入口记账）
  const ops = await import(pathToFileURL(path.join(here, '..', 'lib', 'ops.mjs')).href)
  const { createNodeFsProvider } = await import(pathToFileURL(path.join(here, '..', 'lib', 'fs-provider.mjs')).href)
  /**
   * 与两个真实调用面（CLI / MCP）同一条存储：`openProvider()` 会给引擎换上**落盘**观测
   * （跨进程 + 把相对/绝对两种写法折叠到同一个键）。这里在进程内直调适配入口，所以自己装一次 ——
   * 不装的话观测落在引擎默认那张进程内 Map 上，而它不折叠写法，同一个文件会被当成两个键。
   */
  process.env.AURA_CACHE_DIR = path.join(tmp, 'cache-inproc')
  ops.installDiskObservations()
  /**
   * 绑定缺席时**不许把套件打死**：死在这里会把后面 MT-I / MT-K 的证据一起吞掉，
   * 而“是哪条判据红了”正是这一单要的读数。缺席按空实现降落 ⇒ 下面五条各自报 ✗。
   */
  check(
    typeof ops.readManyWith === 'function' && typeof ops.editManyEnvelope === 'function',
    '⑤ ops.mjs 已从引擎转发 readManyWith / editManyEnvelope（独立面唯一入口）',
    `readManyWith=${typeof ops.readManyWith} editManyEnvelope=${typeof ops.editManyEnvelope}`,
  )
  const readMany = typeof ops.readManyWith === 'function' ? ops.readManyWith : async () => ({ ok: false, entries: [] })
  const editMany = typeof ops.editManyEnvelope === 'function' ? ops.editManyEnvelope : async () => ({ ok: false, edits: [] })
  const counting = (inner) => {
    const calls = []
    const out = { calls }
    for (const method of ['resolve', 'stat', 'readText', 'readByteRange', 'listDir', 'writeText']) {
      if (typeof inner[method] !== 'function') continue
      out[method] = (...methodArgs) => {
        calls.push(`${method}:${String(methodArgs[0])}`)
        return inner[method](...methodArgs)
      }
    }
    return out
  }
  /**
   * 数“写了几次那个文件”：按**文件名**认（引擎递给 provider 的可能是相对写法，
   * 也可能是解析后的绝对路径 —— 那是引擎的内部形状，不是本判据要钉的东西）。
   */
  const writesOf = (calls, base) =>
    calls.filter((c) => c.startsWith('writeText:') && path.basename(c.slice('writeText:'.length)) === base).length
  /**
   * 读一遍建观测（与 CLI 那条路同一个引擎入口），再把账本清零 —— 只数后面那次写的。
   *
   * 路径一律给**绝对**的：写侧的账本键取的是调用方递进去的那个 `displayPath`（引擎不替它解析），
   * 而进程内 `resolveRoot` 与进程 cwd 是两个目录 —— 给相对写法会让“读记下的键”与“写查的键”分家。
   * 真实面没这个问题：子进程的 cwd 就是场景目录，两边自然同键。
   */
  const observed = async (provider, dir, names) => {
    await readMany(
      provider,
      names.map((name) => ({ file_path: path.join(dir, name), mode: 'full' })),
    )
    provider.calls.length = 0
  }

  const pair = mtScene('h-count-pair')
  pair.write('c.md', 'one\ntwo\n')
  pair.write('d.md', 'alpha\nbravo\n')
  const pairProvider = counting(createNodeFsProvider({ resolveRoot: pair.dir }))
  await observed(pairProvider, pair.dir, ['c.md', 'd.md'])
  const pairEnv = await editMany(pairProvider, {
    targets: [
      { file_path: path.join(pair.dir, 'c.md'), hunks: [{ lines: [1, 1], replace: 'ONE' }] },
      { file_path: path.join(pair.dir, 'd.md'), hunks: [{ lines: [1, 1], replace: 'ALPHA' }] },
    ],
  })
  check(
    pairEnv.ok === true && writesOf(pairProvider.calls, 'c.md') === 1 && writesOf(pairProvider.calls, 'd.md') === 1,
    `⑤ writeText 每文件一次（c.md=${writesOf(pairProvider.calls, 'c.md')}，d.md=${writesOf(pairProvider.calls, 'd.md')}）`,
    pairProvider.calls.filter((c) => c.startsWith('writeText:')).join(' | '),
  )

  const zeroCount = mtScene('h-count-zero')
  zeroCount.write('c.md', 'one\ntwo\n')
  zeroCount.write('d.md', 'alpha\nbravo\n')
  const zeroProvider = counting(createNodeFsProvider({ resolveRoot: zeroCount.dir }))
  await observed(zeroProvider, zeroCount.dir, ['c.md', 'd.md'])
  const zeroEnv = await editMany(zeroProvider, {
    targets: [
      { file_path: path.join(zeroCount.dir, 'c.md'), hunks: [{ lines: [1, 1], replace: 'ONE' }] },
      { file_path: path.join(zeroCount.dir, 'd.md'), hunks: [{ lines: [99, 99], replace: 'NOPE' }] },
    ],
  })
  check(
    zeroEnv.ok === false && zeroEnv.edits?.[1]?.outcome === 'failed' && zeroProvider.calls.every((c) => !c.startsWith('writeText:')),
    `⑤ 阶段一失败 ⇒ writeText 一次都没调（${zeroProvider.calls.filter((c) => c.startsWith('writeText:')).length} 次）`,
    JSON.stringify(zeroEnv.edits?.[1]?.error ?? {}).slice(0, 120),
  )

  const one = mtScene('h-count-merge')
  one.write('m.md', 'one\ntwo\nthree\n')
  const oneProvider = counting(createNodeFsProvider({ resolveRoot: one.dir }))
  await observed(oneProvider, one.dir, ['m.md'])
  const oneEnv = await editMany(oneProvider, {
    targets: [
      { file_path: path.join(one.dir, 'm.md'), hunks: [{ lines: [1, 1], replace: 'ONE' }] },
      { file_path: path.join(one.dir, 'm.md'), hunks: [{ lines: [3, 3], replace: 'THREE' }] },
    ],
  })
  check(
    oneEnv.ok === true && writesOf(oneProvider.calls, 'm.md') === 1,
    `⑤ 同文件两个目标 ⇒ writeText 只一次（${writesOf(oneProvider.calls, 'm.md')} 次）`,
    oneProvider.calls.filter((c) => c.startsWith('writeText:')).join(' | '),
  )
  check(fs.readFileSync(path.join(one.dir, 'm.md'), 'utf8') === 'ONE\ntwo\nTHREE\n', '⑤ 合并提交把两处改动都落下了')

  const dryCount = mtScene('h-count-dry')
  dryCount.write('c.md', 'one\ntwo\n')
  const dryProvider = counting(createNodeFsProvider({ resolveRoot: dryCount.dir }))
  await observed(dryProvider, dryCount.dir, ['c.md'])
  const dryEnv2 = await editMany(dryProvider, {
    dryRun: true,
    targets: [{ file_path: path.join(dryCount.dir, 'c.md'), hunks: [{ lines: [1, 1], replace: 'ONE' }] }],
  })
  check(
    dryEnv2.ok === true && dryEnv2.edits?.[0]?.outcome === 'dry_run' && dryProvider.calls.every((c) => !c.startsWith('writeText:')),
    `⑤ dryRun ⇒ writeText 一次都没调（${dryProvider.calls.filter((c) => c.startsWith('writeText:')).length} 次）`,
    JSON.stringify(dryEnv2.edits?.[0]?.error ?? {}).slice(0, 120),
  )
}

// ── MT-I 形状与边界（CLI 参数面：exit 1） ──────────────────────────────────
say('MT-I 形状与边界：参数面拒绝（exit 1），判据只有在引擎里的那一份')
{
  const scene = mtScene('i')
  scene.write('a.js', MT_SOURCE)
  const one = JSON.stringify([{ file_path: 'a.js', mode: 'digest' }])
  // ① 两种形状同时给 ⇒ 参数面拒绝（读侧与写侧各一次）
  const readBoth = scene.run(['read', '--file', 'a.js', '--targets', one])
  const readBothEnv = json(readBoth)
  check(readBoth.status === 1, `① read：--file 与 --targets 同时给 ⇒ exit 1（实测 ${readBoth.status}）`, String(readBothEnv.error).slice(0, 120))
  check(readBothEnv.ok === false && readBothEnv.shape === 'ARGS_SHAPE_EXCLUSIVE', `① 读侧点名互斥判据（shape=${readBothEnv.shape}）`, JSON.stringify(readBothEnv).slice(0, 160))
  const editBoth = scene.run(['edit', '--file', 'a.js', '--targets', JSON.stringify([{ file_path: 'a.js', hunks: [{ lines: [1, 1], replace: 'X' }] }])])
  const editBothEnv = json(editBoth)
  check(editBoth.status === 1 && editBothEnv.shape === 'ARGS_SHAPE_EXCLUSIVE', `① edit：同样被拒（exit=${editBoth.status}，shape=${editBothEnv.shape}）`, String(editBothEnv.error).slice(0, 120))
  check(fs.readFileSync(path.join(scene.dir, 'a.js'), 'utf8') === MT_SOURCE, '① 被拒的写没有碰磁盘（逐字节不变）')

  // ② 超 32 项
  const tooMany = Array.from({ length: 33 }, () => ({ file_path: 'a.js', mode: 'digest' }))
  const over = scene.run(['read', '--targets', JSON.stringify(tooMany)])
  const overEnv = json(over)
  check(over.status === 1, `② 33 项 ⇒ exit 1（实测 ${over.status}）`)
  check(overEnv.shape === 'ARGS_TARGETS_LIMIT' && overEnv.got === 33, `② 报出实得数（got=${overEnv.got}，shape=${overEnv.shape}）`, String(overEnv.error).slice(0, 120))

  // ③ 空数组不是“成功读了 0 个”
  const empty = scene.run(['read', '--targets', '[]'])
  const emptyEnv = json(empty)
  check(empty.status === 1 && emptyEnv.shape === 'ARGS_TARGETS_SHAPE', `③ 空数组 ⇒ 拒绝（exit=${empty.status}，shape=${emptyEnv.shape}）`, String(emptyEnv.error).slice(0, 120))

  // ④ 不是 JSON：说清来源与接受的形状
  const notJson = json(scene.run(['read', '--targets', '[{file_path: a.js}]']))
  check(notJson.code === 'USAGE' && String(notJson.error).includes('--targets') && String(notJson.error).includes('JSON'), '④ 字面 JSON 坏了 ⇒ 说清来源与形状', String(notJson.error).slice(0, 140))
  const missingSpec = json(scene.run(['read', '--targets', '@nope.json']))
  check(missingSpec.code === 'USAGE' && String(missingSpec.error).includes('@nope.json'), '④ @文件 读不到 ⇒ 报的是实际来源', String(missingSpec.error).slice(0, 140))
  const bare = json(scene.run(['read', '--targets']))
  check(bare.code === 'USAGE', `④ \`--targets\` 没带值 ⇒ USAGE（收到 ${JSON.stringify(String(bare.error).slice(0, 60))}）`)
  // 与 `--hunks-file` 同一条理由：PowerShell 5.1 默认写 BOM，剥掉即可
  fs.writeFileSync(path.join(scene.dir, 'spec.json'), Buffer.concat([BOM, Buffer.from(one, 'utf8')]))
  const bomSpec = scene.run(['read', '--targets', '@spec.json'])
  check(bomSpec.status === 0 && json(bomSpec).ok === true, `④ \`@文件\` 带 BOM 照样能用（exit=${bomSpec.status}）`, String(bomSpec.stderr).slice(0, 100))

  // ⑤ 顶层不认识的键不许静默忽略（`dryrun` 拼错而照写盘是最坏的一种）
  const unknown = json(
    scene.run(['edit', '--targets', JSON.stringify({ targets: [{ file_path: 'a.js', hunks: [{ lines: [1, 1], replace: 'X' }] }], dryrun: true })]),
  )
  check(unknown.code === 'USAGE' && unknown.shape === 'ARGS_UNKNOWN_KEY', `⑤ 未知顶层键 ⇒ 拒绝（shape=${unknown.shape}）`, String(unknown.error).slice(0, 140))
  check(fs.readFileSync(path.join(scene.dir, 'a.js'), 'utf8') === MT_SOURCE, '⑤ 被拒的写没有碰磁盘（逐字节不变）')
}

// ── MT-K MCP 多目标 ────────────────────────────────────────────────────
say('MT-K MCP：targets 的声明、逐项回执、汇总行与既有形状')
{
  const scene = mtScene('k')
  scene.write('a.js', MT_SOURCE)
  scene.write('b.md', 'one\ntwo\n')
  scene.write('c.md', 'alpha\nbravo\n')
  const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
  const res = scene.mcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    call(3, 'aura_read', { targets: [{ file_path: 'a.js', mode: 'digest' }, { file_path: 'b.md', mode: 'lines', lines: [1, 2] }] }),
    call(4, 'aura_read', { targets: [{ file_path: 'a.js', mode: 'digest' }, { file_path: 'nope.md', mode: 'full' }] }),
    call(5, 'aura_edit', { targets: [{ file_path: 'c.md', hunks: [{ lines: [1, 1], replace: 'ALPHA' }] }] }),
    call(6, 'aura_edit', { file_path: 'c.md', targets: [{ file_path: 'c.md', hunks: [{ lines: [2, 2], replace: 'B' }] }] }),
    call(7, 'aura_read', { file: 'a.js', mode: 'digest' }),
  ])
  const replies = res.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const byId = new Map(replies.map((r) => [r.id, r]))
  const envOf = (id) => JSON.parse(byId.get(id)?.result?.content?.[0]?.text ?? '{}')
  const tools = byId.get(2)?.result?.tools ?? []
  const schemaOf = (name) => tools.find((t) => t.name === name)?.inputSchema ?? {}
  check(
    schemaOf('aura_read').properties?.targets?.type === 'array' && schemaOf('aura_edit').properties?.targets?.type === 'array',
    'K 两个工具的 inputSchema 都声明了 targets 数组',
    JSON.stringify({ read: schemaOf('aura_read').properties?.targets, edit: schemaOf('aura_edit').properties?.targets }).slice(0, 160),
  )
  const batch = envOf(3)
  check(batch.ok === true && batch.entries?.length === 2, 'K file_path 缺席 + targets 在场 ⇒ 不再 BAD_ARGS，逐项照给', JSON.stringify(batch).slice(0, 180))
  check(batch.summary === 'targets: 2 ｜ ok 2', `K 汇总行 ${JSON.stringify(batch.summary)}`)
  check(byId.get(3)?.result?.isError === false, `K 整批都成 ⇒ isError=false（${byId.get(3)?.result?.isError}）`)
  const partial = envOf(4)
  check(partial.ok === false && partial.entries?.[0]?.ok === true && partial.entries?.[1]?.code === 'FS_NOT_FOUND', 'K 一项缺 ⇒ 不连坐，整批 ok=false', JSON.stringify(partial).slice(0, 180))
  check(partial.summary === 'targets: 2 ｜ ok 1 ｜ not_found 1', `K 缺一项时的汇总行 ${JSON.stringify(partial.summary)}`)
  check(byId.get(4)?.result?.isError === true, `K 有失败 ⇒ isError=true（${byId.get(4)?.result?.isError}）`)
  const editBatch = envOf(5)
  check(editBatch.ok === true && editBatch.edits?.[0]?.landed === true, 'K aura_edit 带 targets 走引擎批入口', JSON.stringify(editBatch).slice(0, 180))
  check(fs.readFileSync(path.join(scene.dir, 'c.md'), 'utf8') === 'ALPHA\nbravo\n', 'K MCP 批编辑真落盘', JSON.stringify(fs.readFileSync(path.join(scene.dir, 'c.md'), 'utf8')))
  check(envOf(6).code === 'ARGS_SHAPE_EXCLUSIVE', `K file_path 与 targets 同时给 ⇒ 互斥判据（${envOf(6).code}）`, String(envOf(6).error).slice(0, 140))
  check(envOf(7).code === 'BAD_ARGS', `K 两种形状都没给 ⇒ 仍是 BAD_ARGS（既有行为不变，${envOf(7).code}）`, String(envOf(7).error).slice(0, 140))
  check(res.stderr.trim() === '', 'K 没靠 stderr 兑底（不用抛出当回包）', res.stderr.trim().slice(0, 80))
}

// ── MT-L 句柄寻址：MCP 声明面 · MCP 调用 · CLI 平铺旗标 · 引擎直调 ────────────
say('MT-L 句柄寻址：同一份柄、同一次改动 —— 三面同 tier 同落盘')
{
  /**
   * 判据（能力面对齐：引擎早就支持，缺的是两个面的**声明与旗标**）：
   *   ① MCP 的**声明面**收得下 `handle` / `line` / `position` —— 参数表里没有的键，在那一面就等于不存在
   *      （CLI 读出来的回执里明明带着柄，而工具声明里看不见它）；
   *   ② MCP 真用 `{handle, line, replace}` 改一次：`ok`、`tier` 点名句柄、磁盘逐字节只有那一行变；
   *   ③ CLI 的平铺旗标 `--handle h… --line 2 --replace X` 同样能改（改前这条路是 exit 1）；
   *   ④ `--line` / `--position` 是**从属键**：没有 `--handle` 就不构成一次编辑（既有行为保持不变）；
   *   ⑤ 三面（CLI / MCP / 引擎 `applyEditToProvider` 直调）给出同一个 `tier` 与同样的落盘字节。
   *
   * 柄一律从**读侧**拿，且两处必须一致：回执结构化字段 `handle` 与正文首行行尾的 `<h…>`。
   * 四个场景各自干净；⑤ 的三面共用**同一个文件与同一个缓存目录**（柄是账本里的凭据，
   * 账本不同本来就该对不上 —— 那是设计，不是本段要证的事）。
   */
  const HANDLE_RE = /h[0-9a-f]{12}:\d+-\d+/
  const LINE2 = '  const a = 42'
  const EXPECTED = MT_SOURCE.replace('  const a = 1', LINE2)
  const MCP_HELLO = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  ]
  const mcpCall = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
  /** 一次 MCP 进程的回包：`env(id)` 取工具回执，`tools` 取 `tools/list` 的声明面。 */
  const mcpReplies = (res) => {
    const byId = new Map(
      String(res.stdout)
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .map((r) => [r.id, r]),
    )
    return { env: (id) => JSON.parse(byId.get(id)?.result?.content?.[0]?.text ?? '{}'), tools: byId.get(2)?.result?.tools ?? [] }
  }
  const bytesOf = (p) => fs.readFileSync(p)
  const tierOf = (env) => String(env?.result?.applied?.[0]?.tier ?? env?.applied?.[0]?.tier ?? '')
  const readHandle = (scene) => json(scene.run(['read', '--file', 'a.js', '--mode', 'lines', '--lines', '1,4'])).handle
  /** 逐字节只有第 n 行变：行数、每行的行尾字节、其余每一行都要一模一样（返回 null = 通过）。 */
  const onlyLineChanged = (before, after, lineNo) => {
    const a = split(String(before))
    const b = split(String(after))
    if (a.lines.length !== b.lines.length) return `行数变了：${a.lines.length} → ${b.lines.length}`
    if (a.ends.some((end, i) => end !== b.ends[i])) return '行尾字节变了'
    const changed = a.lines.map((line, i) => (line === b.lines[i] ? null : i + 1)).filter((n) => n !== null)
    return changed.length === 1 && changed[0] === lineNo ? null : `变的行是 ${changed.join(',') || '（无）'}，期望只有第 ${lineNo} 行`
  }

  // ① 声明面：三个键必须出现在 `hunks.items.properties` 里
  const declScene = mtScene('l-decl')
  declScene.write('a.js', MT_SOURCE)
  const decl = mcpReplies(
    declScene.mcp([...MCP_HELLO, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, mcpCall(3, 'aura_read', { file_path: 'a.js', mode: 'lines', lines: [1, 4] })]),
  )
  const editTool = decl.tools.find((t) => t.name === 'aura_edit')
  const hunkProps = Object.keys(editTool?.inputSchema?.properties?.hunks?.items?.properties ?? {})
  const missing = ['handle', 'line', 'position'].filter((key) => !hunkProps.includes(key))
  check(
    missing.length === 0,
    'L① MCP 声明面：aura_edit 的 hunks.items.properties 收得下 handle / line / position',
    `缺 ${missing.join(',') || '（无）'}；实得 ${hunkProps.join(',')}`,
  )
  const hunkRequired = editTool?.inputSchema?.properties?.hunks?.items?.required ?? []
  check(JSON.stringify(hunkRequired) === '["replace"]', 'L① required 仍是 ["replace"]（三个从属键一个都不进去）', JSON.stringify(hunkRequired))

  // ② MCP 真改一次：柄从上面那次 `aura_read` 拿；正文行尾的 <h…> 与结构化 handle 必须同值
  const mcpRead = decl.env(3)
  const mcpHandle = mcpRead.handle
  const marker = (String(mcpRead.text).match(HANDLE_RE) ?? [null])[0]
  check(
    typeof mcpHandle === 'string' && HANDLE_RE.test(mcpHandle) && marker === mcpHandle,
    'L② 读侧发的柄：结构化 handle 与正文行尾 <h…> 同值',
    `${JSON.stringify(mcpHandle)} vs ${JSON.stringify(marker)}`,
  )
  const mcpBefore = bytesOf(path.join(declScene.dir, 'a.js'))
  const mcpEdit = mcpReplies(
    declScene.mcp([...MCP_HELLO, mcpCall(4, 'aura_edit', { file_path: 'a.js', hunks: [{ handle: mcpHandle, line: 2, replace: LINE2 }] })]),
  ).env(4)
  const mcpAfter = bytesOf(path.join(declScene.dir, 'a.js'))
  check(
    mcpEdit.ok === true && tierOf(mcpEdit) === 'handle line 2',
    'L② MCP {handle, line: 2, replace} ⇒ ok、tier 点名句柄',
    `${tierOf(mcpEdit)}；${JSON.stringify(mcpEdit).slice(0, 160)}`,
  )
  check(onlyLineChanged(mcpBefore, mcpAfter, 2) === null, 'L② 磁盘逐字节只有第 2 行变', String(onlyLineChanged(mcpBefore, mcpAfter, 2)))
  check(mcpAfter.equals(utf8(EXPECTED)), 'L② 落盘就是预期那一份（逐字节）', byteDiff(mcpAfter.toString('utf8'), EXPECTED) ?? '')

  // ③ CLI 的平铺旗标：改前这条路报「需要 hunks/一组地址旗标」并 exit 1
  const cliScene = mtScene('l-cli')
  cliScene.write('a.js', MT_SOURCE)
  const cliHandle = readHandle(cliScene)
  const cliRun = cliScene.run(['edit', '--file', 'a.js', '--handle', String(cliHandle), '--line', '2', '--replace', LINE2])
  const cliEdit = json(cliRun)
  check(
    cliRun.status === 0 && cliEdit.ok === true,
    `L③ CLI \`--handle h… --line 2 --replace\` ⇒ exit 0 且 ok（实测 exit=${cliRun.status}）`,
    JSON.stringify(cliEdit).slice(0, 180),
  )
  check(tierOf(cliEdit) === 'handle line 2', `L③ 回执 tier 点名句柄（${tierOf(cliEdit)}）`, JSON.stringify(cliEdit).slice(0, 160))
  check(bytesOf(path.join(cliScene.dir, 'a.js')).equals(utf8(EXPECTED)), 'L③ CLI 真落盘（逐字节）', byteDiff(bytesOf(path.join(cliScene.dir, 'a.js')).toString('utf8'), EXPECTED) ?? '')

  // ④ 从属键：`--line` 单独给**不构成一次编辑**（判据在引擎的 HANDLE_SHAPE_KEYS，CLI 不另判一份）
  const subScene = mtScene('l-sub')
  subScene.write('a.js', MT_SOURCE)
  const subBefore = bytesOf(path.join(subScene.dir, 'a.js'))
  const subRun = subScene.run(['edit', '--file', 'a.js', '--line', '2', '--replace', 'X'])
  const subEnv = json(subRun)
  check(
    subRun.status === 1 && subEnv.code === 'USAGE',
    `L④ \`--line 2 --replace X\`（无 --handle）⇒ 仍 exit 1（实测 ${subRun.status}，code=${subEnv.code}）`,
    String(subEnv.error).slice(0, 140),
  )
  check(subBefore.equals(bytesOf(path.join(subScene.dir, 'a.js'))), 'L④ 被拒的写没有碰磁盘（逐字节不变）')

  // `--position after`：在区间**边界**插入，区间本身一个字节不动
  const posScene = mtScene('l-pos')
  posScene.write('a.js', MT_SOURCE)
  const posRun = posScene.run(['edit', '--file', 'a.js', '--handle', String(readHandle(posScene)), '--position', 'after', '--replace', 'POST'])
  const posEnv = json(posRun)
  const posLines = split(bytesOf(path.join(posScene.dir, 'a.js')).toString('utf8'))
  const origLines = split(MT_SOURCE)
  check(
    posRun.status === 0 && posEnv.ok === true && tierOf(posEnv) === 'handle after',
    `L④ \`--position after\` ⇒ ok、tier=${tierOf(posEnv)}（exit=${posRun.status}）`,
    JSON.stringify(posEnv).slice(0, 180),
  )
  check(
    posLines.lines[4] === 'POST' &&
      posLines.lines.length === origLines.lines.length + 1 &&
      posLines.lines.slice(0, 4).join('\u0000') === origLines.lines.slice(0, 4).join('\u0000') &&
      posLines.lines.slice(5).join('\u0000') === origLines.lines.slice(4).join('\u0000'),
    'L④ 插入落在区间末行之后，区间 1-4 一个字节不动',
    JSON.stringify(posLines.lines.slice(0, 6)),
  )

  // ⑤ 三面一致：同一个文件、同一份柄、同一次改动
  const triScene = mtScene('l-three')
  const triFile = path.join(triScene.dir, 'a.js')
  const reset = () => fs.writeFileSync(triFile, Buffer.from(MT_SOURCE, 'utf8'))
  reset()
  const triCliHandle = readHandle(triScene)
  const triCli = json(triScene.run(['edit', '--file', 'a.js', '--handle', String(triCliHandle), '--line', '2', '--replace', LINE2]))
  const triCliDisk = bytesOf(triFile)

  // 回到同一份字节：柄是「账本键 + 区间文本 + 行区间」的函数 ⇒ 重读一次的柄必须逐字符相同
  reset()
  const triMcpRead = mcpReplies(
    triScene.mcp([...MCP_HELLO, mcpCall(3, 'aura_read', { file_path: 'a.js', mode: 'lines', lines: [1, 4] })]),
  ).env(3)
  const triMcp = mcpReplies(
    triScene.mcp([...MCP_HELLO, mcpCall(4, 'aura_edit', { file_path: 'a.js', hunks: [{ handle: triMcpRead.handle, line: 2, replace: LINE2 }] })]),
  ).env(4)
  const triMcpDisk = bytesOf(triFile)

  reset()
  const ops = await import(pathToFileURL(path.join(here, '..', 'lib', 'ops.mjs')).href)
  const { createNodeFsProvider } = await import(pathToFileURL(path.join(here, '..', 'lib', 'fs-provider.mjs')).href)
  // 进程内直调也要落盘观测（MT-H 已装过一次，安装是幂等的；这里重设一遍环境变量，绝不落到 home）
  process.env.AURA_CACHE_DIR = path.join(tmp, 'cache-inproc')
  ops.installDiskObservations()
  const triProvider = createNodeFsProvider({ resolveRoot: triScene.dir })
  const triEngRead = await ops.readEnvelope(triProvider, { file: triFile, mode: 'lines', lines: [1, 4] })
  const triEng = await ops.applyEditToProvider(triProvider, { displayPath: triFile, hunks: [{ handle: triEngRead.handle, line: 2, replace: LINE2 }] })
  const triEngDisk = bytesOf(triFile)

  /**
   * 柄 = h + 4 位身份标签（账本键） + 8 位内容摘要 + 行区间。
   * 三个面各自一份账本，身份标签**本来就该不同**（M④ 已钉住）；这里比的是内容段。
   * 旧断言拿整串比，在 macOS 的 /var → /private/var 真身上才暴露：它要求三个账本合成一份。
   */
  const handleBody = (handle) => String(handle).slice(5)
  check(
    handleBody(triCliHandle) === handleBody(triMcpRead.handle) && handleBody(triMcpRead.handle) === handleBody(triEngRead.handle),
    `L⑤ 三面柄的内容段相同（CLI=${triCliHandle}／MCP=${triMcpRead.handle}／引擎=${triEngRead.handle}）`,
  )
  check(
    tierOf(triCli) === 'handle line 2' && tierOf(triMcp) === tierOf(triCli) && tierOf(triEng) === tierOf(triCli),
    `L⑤ 三面 tier 相同（CLI=${tierOf(triCli)}／MCP=${tierOf(triMcp)}／引擎=${tierOf(triEng)}）`,
  )
  check(
    triCliDisk.equals(triMcpDisk) && triMcpDisk.equals(triEngDisk) && triEngDisk.equals(utf8(EXPECTED)),
    'L⑤ 三面落盘逐字节相同（且就是预期那一份）',
    byteDiff(triCliDisk.toString('utf8'), EXPECTED) ?? byteDiff(triEngDisk.toString('utf8'), EXPECTED) ?? '',
  )
}

say('MT-M 修复地址："改错了能自纠"那一半在独立面上看不看得见')
{
  /**
   * 判据（能力面对齐：引擎早就给地址，缺的是独立面把不把它递到眼前）：
   *   ① **看得见**：引文写错 ⇒ CLI 与 MCP 的回执正文里都能解析出 `retry: {"handle":…}`；
   *   ② **抄得动**：把这个地址 + 自己的 `replace` 再发一次，**真的落盘**，落点正是回执印的那个区间；
   *   ③ **三面同源**：CLI / MCP / 引擎给出的候选行号与句柄**逐字相同**（地址只有一个来源）；
   *   ④ **多候选逐个带地址**：三处同文 ⇒ 每个候选各一行 `retry:`，且每一行都真的能用；
   *   ⑤ **不夸大**：地址只在**有**最近区间时给；拿地址重试成功也不把原来的码改成成功码。
   *
   * 为什么取址**从正文里解**而不读结构化字段：模型只看得见正文（引擎的错误对象只取 `message`），
   * 所以判据必须钉在正文上。
   *
   * 为什么重试要**开新进程**：CLI 的真实用法就是两条命令两次进程；句柄是"那段字节的函"，
   * 只要文件没动在两个进程里就是同一个柄 —— 这条不成立，本段必须红。
   */
  const NF_SRC = `${Array.from({ length: 40 }, (_, i) => `const item${String(i + 1).padStart(2, '0')} = make(${i + 1}, 'tag-${i + 1}')`).join('\n')}\n`
  const NF_LINES = NF_SRC.split('\n')
  const NF_REGION = { start: 15, end: 20 } // 最近区间：文件第 15–20 行（1-based）
  const NF_QUOTE = NF_LINES.slice(NF_REGION.start - 1, NF_REGION.end).join('\n').replace('const item20', 'const item20TYPO')
  const NF_NEW = Array.from({ length: NF_REGION.end - NF_REGION.start + 1 }, (_, i) => `const repaired${i + 1} = ${i + 1}`)
  // 空白类写 `[ \t]*` 而不是反斜杠-s 那条：打包守卫的"盘符路径"正则带负向前瞻、不看上下文，
  //   会把**转义序列**（反斜杠紧跟 s）误当成盘符路径 ⇒ 那份守卫会在打包时直接停手（实测踩到）。
  const RETRY_RE = /retry:[ \t]*(\{[^\n]*?\})/g
  const nearHandles = (text) => [...String(text).matchAll(RETRY_RE)]
    .map((m) => { try { return JSON.parse(m[1]) } catch { return null } })
    .filter((o) => o !== null && typeof o.handle === 'string')

  const notFoundRun = (scene) => scene.run(['edit', '--file', 'a.js', '--hunks', JSON.stringify([{ old: NF_QUOTE, replace: '// nope' }])])
  const retryRun = (scene, handle) => scene.run(['edit', '--file', 'a.js', '--handle', handle, '--lines', `${NF_REGION.start},${NF_REGION.end}`, '--replace', NF_NEW.join('\n')])

  // ── ① CLI：一次注定找不到的编辑 ──
  const cliScene = mtScene('m-cli')
  cliScene.write('a.js', NF_SRC)
  const cliBefore = fs.readFileSync(path.join(cliScene.dir, 'a.js'))
  const cliFail = notFoundRun(cliScene)
  const cliEnv = json(cliFail)
  // 正文在哪个键上由各面自己定：CLI 把消息放在 `error`，MCP / 引擎放在 `message`。
  // 判据只问「这段文本在不在回执里」，不问键名 —— 模型两面都看得见这一整段。
  const textOf = (env) => String(env?.message ?? env?.error ?? '')
  const cliRetry = nearHandles(textOf(cliEnv))
  check(
    cliEnv.code === 'PATCH_NOT_FOUND' && cliRetry.length === 1,
    'M① CLI：引文写错 ⇒ `PATCH_NOT_FOUND`，且回执正文里能抄到一个 `retry: {"handle":…}`',
    `code=${cliEnv.code} 抄到 ${cliRetry.length} 个：${JSON.stringify(cliRetry)}\n${textOf(cliEnv).slice(0, 300)}`,
  )
  check(
    fs.readFileSync(path.join(cliScene.dir, 'a.js')).equals(cliBefore),
    'M① CLI：失败那一发一个字节都没写',
  )

  // ── ② CLI 抄回地址重试（**新进程**）──
  const cliHandle = cliRetry[0]?.handle ?? ''
  const cliRetryRes = retryRun(cliScene, cliHandle)
  const cliRetryEnv = json(cliRetryRes)
  const cliExpected = [...NF_LINES.slice(0, NF_REGION.start - 1), ...NF_NEW, ...NF_LINES.slice(NF_REGION.end)].join('\n')
  const cliDisk = fs.readFileSync(path.join(cliScene.dir, 'a.js')).toString('utf8')
  check(
    cliRetryRes.status === 0 && cliRetryEnv.ok === true && cliDisk === cliExpected,
    'M② CLI：把那一行地址抄回去再发一次 ⇒ 真的落盘，且只换了回执印的那个区间',
    `exit=${cliRetryRes.status} ok=${cliRetryEnv.ok} ${byteDiff(cliDisk, cliExpected) ?? ''}`,
  )

  // ── ③ MCP：同一份夹具、同一条路 ──
  const MCP_HELLO_M = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  ]
  const mcpCallM = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
  const envOfM = (res, id) => {
    const line = String(res.stdout).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.id === id)
    return JSON.parse(line?.result?.content?.[0]?.text ?? '{}')
  }
  const mcpScene = mtScene('m-mcp')
  mcpScene.write('a.js', NF_SRC)
  const mcpFailRes = mcpScene.mcp([...MCP_HELLO_M, mcpCallM(3, 'aura_edit', { file_path: 'a.js', hunks: [{ old: NF_QUOTE, replace: '// nope' }] })])
  const mcpFail = envOfM(mcpFailRes, 3)
  const mcpRetry = nearHandles(textOf(mcpFail))
  check(
    mcpFail.code === 'PATCH_NOT_FOUND' && mcpRetry.length === 1,
    'M③ MCP：同一个失败在 MCP 面上同样能抄到地址（工具回执正文）',
    `code=${mcpFail.code} 抄到 ${mcpRetry.length} 个：${JSON.stringify(mcpRetry)}`,
  )
  const mcpRetryRes = mcpScene.mcp([
    ...MCP_HELLO_M,
    mcpCallM(3, 'aura_edit', { file_path: 'a.js', hunks: [{ handle: mcpRetry[0]?.handle, lines: [NF_REGION.start, NF_REGION.end], replace: NF_NEW.join('\n') }] }),
  ])
  const mcpRetryEnv = envOfM(mcpRetryRes, 3)
  const mcpDisk = fs.readFileSync(path.join(mcpScene.dir, 'a.js')).toString('utf8')
  check(
    mcpRetryEnv.ok === true && mcpDisk === cliExpected,
    'M③ MCP：把地址抄回去 ⇒ 真的落盘，字节与 CLI 那条路完全相同',
    `ok=${mcpRetryEnv.ok} ${byteDiff(mcpDisk, cliExpected) ?? ''}`,
  )

  // ── ④ 三面同源：候选行号与句柄逐字相同（与 MT-L⑤ 同一套进程内直调：ops + 真 fs provider + 落盘观测）──
  const engSceneM = mtScene('m-engine')
  engSceneM.write('a.js', NF_SRC)
  const engFileM = path.join(engSceneM.dir, 'a.js')
  const opsM = await import(pathToFileURL(path.join(here, '..', 'lib', 'ops.mjs')).href)
  const { createNodeFsProvider: createNodeFsProviderM } = await import(pathToFileURL(path.join(here, '..', 'lib', 'fs-provider.mjs')).href)
  process.env.AURA_CACHE_DIR = path.join(tmp, 'cache-m-engine')
  opsM.installDiskObservations()
  const engProv = createNodeFsProviderM({ resolveRoot: engSceneM.dir })
  let engErrM = null
  try {
    await opsM.applyEditToProvider(engProv, { displayPath: engFileM, hunks: [{ old: NF_QUOTE, replace: '// nope' }] })
  } catch (caught) { engErrM = caught }
  const engRetry = nearHandles(String(engErrM?.message ?? ''))
  /**
   * 柄的三段：`h` + 4 位**身份标签**（账本键）+ 8 位**区间摘要**（那段字节的函）+ 起-止行号。
   * 「三面同源」必须拿**内容那两段**（摘要 + 行号）比，不能拿身份标签比：
   * 三个面各自一份账本（缓存目录不同），身份标签本来就该不同 —— 拿它比等于要求三个账本合成一份，
   * 那是把设计当成缺陷。而**摘要相同**才是“三面说的是同一段字节”这个断言。
   */
  const contentOf = (h) => String(h).replace(/^h[0-9a-f]{4}/, '')
  const idTagOf = (h) => (String(h).match(/^h([0-9a-f]{4})/) ?? [null, ''])[1]
  check(
    engRetry.length === 1 && contentOf(engRetry[0].handle) === contentOf(cliHandle) && contentOf(cliHandle) === contentOf(mcpRetry[0]?.handle),
    'M④ 三面同源：CLI / MCP / 引擎交出的柄指向**同一段字节与同一区间**（摘要+行号逐字相同）',
    `引擎=${engRetry[0]?.handle}／CLI=${cliHandle}／MCP=${mcpRetry[0]?.handle}`,
  )
  check(
    idTagOf(cliHandle) !== idTagOf(mcpRetry[0]?.handle) && idTagOf(cliHandle) !== idTagOf(engRetry[0]?.handle),
    'M④ 身份标签各自不同（三个面各有自己的账本——这是设计，不是缺陷）',
    `CLI=${idTagOf(cliHandle)}／MCP=${idTagOf(mcpRetry[0]?.handle)}／引擎=${idTagOf(engRetry[0]?.handle)}`,
  )
  check(
    String(engErrM?.message ?? '').includes(NF_REGION.start + '-' + NF_REGION.end),
    'M④ 三面同源：引擎回执印的最近区间（' + NF_REGION.start + '-' + NF_REGION.end + '）也在正文里',
    String(engErrM?.message ?? '').slice(0, 200),
  )

  // ── ⑤ 多候选：三处同文 ⇒ 每个候选各带一行地址，且**每一行都能用** ──
  const AMB_SRC = ['const head = 0', ...Array.from({ length: 10 }, (_, i) => `const pad${String(i + 1).padStart(2, '0')} = ${i + 1}`), 'const dup = value * 2', ...Array.from({ length: 7 }, (_, i) => `const pad${String(i + 11).padStart(2, '0')} = ${i + 11}`), 'const dup = value * 2', ...Array.from({ length: 2 }, (_, i) => `const pad${String(i + 18).padStart(2, '0')} = ${i + 18}`), 'const dup = value * 2', 'const tail = 0'].join('\n') + '\n'
  const ambScene = mtScene('m-amb')
  ambScene.write('a.js', AMB_SRC)
  const ambFail = json(ambScene.run(['edit', '--file', 'a.js', '--hunks', JSON.stringify([{ old: 'const dup = value * 2', replace: 'const dup = 0' }])]))
  const ambRetry = nearHandles(textOf(ambFail))
  // 候选在哪个键上：引擎的错误对象把细节挂在 `error` 下（DSH 壳再把它抬成外套字段）。
  // CLI 收到的是 `{ok,error,code}`（`error` 是**消息字符串**）⇒ 细节只能从 `result`/外套里找；
  // 所以候选数改从**消息正文**数（每个候选项占一行 `retry:`），与地址行数同源同量。
  const ambCands = ambFail.error?.candidates ?? ambFail.result?.error?.candidates ?? []
  const ambCandCount = ambCands.length > 0 ? ambCands.length : ambRetry.length
  const ambLineNumbers = [...String(textOf(ambFail)).matchAll(/candidates: ([^.;)]+)/g)].map((m) => m[1])
  check(
    ambRetry.length === ambCandCount && ambRetry.length >= 3 && ambLineNumbers.length === 1,
    'M⑤ 多候选：`PATCH_AMBIGUOUS` 的每个候选各带一行 `retry:`（从挑一个变成抄一个）',
    `地址 ${ambRetry.length} 行 / 正文点名的候选行=${ambLineNumbers.join('|')} / 结构化候选 ${ambCands.length} 个`,
  )
  // 逐行都真能用：拿第三个候选的地址改一次（刻意不取第一个 "" 就近挑会蒙对）
  const ambPick = ambRetry[2]
  const ambBeforeDisk = fs.readFileSync(path.join(ambScene.dir, 'a.js')).toString('utf8')
  const ambUse = json(ambScene.run(['edit', '--file', 'a.js', '--handle', ambPick.handle, '--replace', 'const dup = 99']))
  const ambAfterDisk = fs.readFileSync(path.join(ambScene.dir, 'a.js')).toString('utf8')
  check(
    ambUse.ok === true && ambAfterDisk !== ambBeforeDisk && ambAfterDisk.split('const dup = 99').length === 2,
    'M⑤ 第三个候选的地址真能用（只换那一行，另外两处同文行不动）',
    `ok=${ambUse.ok} tier=${ambUse.applied?.[0]?.tier}`,
  )
}

say('N provider：mode / symlink / hardlink / range / 上限 / cache')
{
  const provider = createNodeFsProvider({ resolveRoot: tmp, maxTextBytes: 1024 })

  // N1 mode 保留（POSIX）；Windows 的 mode 不承载执行位，明确跳过而不是假装通过。
  const modeFile = path.join(tmp, 'provider-mode.js')
  fs.writeFileSync(modeFile, '#!/usr/bin/env node\nconsole.log(0)\n')
  try { fs.chmodSync(modeFile, 0o755) } catch { /* Windows / 受限 FS */ }
  const modeStat = provider.stat(modeFile)
  await provider.writeText(modeFile, '#!/usr/bin/env node\nconsole.log(1)\n', { kind: 'replaceIfVersion', version: modeStat.version })
  if (path.sep === '\\') {
    console.log('⊘ N1 mode：Windows 不承载 POSIX 执行位，跳过')
  } else {
    check((fs.statSync(modeFile).mode & 0o777) === 0o755, 'N1 原子写保留 0755', (fs.statSync(modeFile).mode & 0o777).toString(8))
  }

  // N2 符号链接写穿：链接保留，目标内容更新。
  const target = path.join(tmp, 'provider-target.txt')
  const link = path.join(tmp, 'provider-link.txt')
  fs.writeFileSync(target, 'ORIGINAL\n')
  let symlinkOk = false
  try { fs.symlinkSync(target, link, 'file'); symlinkOk = true } catch { /* 权限不允许 */ }
  if (!symlinkOk) {
    console.log('⊘ N2 symlink：本机不允许创建文件符号链接，跳过')
  } else {
    const linkStat = provider.stat(link)
    await provider.writeText(link, 'VIA LINK\n', { kind: 'replaceIfVersion', version: linkStat.version })
    check(fs.lstatSync(link).isSymbolicLink(), 'N2 写后 link 仍是符号链接')
    check(fs.readFileSync(target, 'utf8') === 'VIA LINK\n', 'N2 目标文件收到新内容')
  }

  // N3 硬链接拒绝：rename 会打断另一个名字，必须显式拒绝而不是静默分叉。
  const hardA = path.join(tmp, 'provider-hard-a.txt')
  const hardB = path.join(tmp, 'provider-hard-b.txt')
  fs.writeFileSync(hardA, 'HARD\n')
  let hardOk = false
  try { fs.linkSync(hardA, hardB); hardOk = true } catch { /* 受限 FS */ }
  if (!hardOk) {
    console.log('⊘ N3 hardlink：本机不允许创建硬链接，跳过')
  } else {
    const hardStat = provider.stat(hardA)
    let hardCode = null
    try { await provider.writeText(hardA, 'CHANGED\n', { kind: 'replaceIfVersion', version: hardStat.version }) } catch (error) { hardCode = error?.code }
    check(hardCode === 'FS_HARDLINK_UNSUPPORTED', 'N3 硬链接写被拒绝', String(hardCode))
    check(fs.readFileSync(hardA, 'utf8') === 'HARD\n', 'N3 拒绝后两个名字内容都未变')
  }

  // N4 range 只取请求区间，不走整份读。
  const rangeFile = path.join(tmp, 'provider-range.txt')
  fs.writeFileSync(rangeFile, 'A'.repeat(5000) + 'B'.repeat(10) + 'C'.repeat(5000))
  const range = await provider.readByteRange(rangeFile, { offset: 5000, length: 10 })
  check(Buffer.from(range).toString() === 'B'.repeat(10), 'N4 readByteRange 返回请求区间')

  // N5 文本上限可配置；range 不受文本上限阻断。
  const capped = path.join(tmp, 'provider-capped.txt')
  fs.writeFileSync(capped, 'x'.repeat(2048))
  let capCode = null
  try { await provider.readText(capped) } catch (error) { capCode = error?.code }
  check(capCode === 'FS_TOO_LARGE', 'N5 超过 maxTextBytes 的 readText 被拒绝', String(capCode))
  const one = await provider.readByteRange(capped, { offset: 0, length: 1 })
  check(one.length === 1, 'N5 range 读取不受文本上限阻断')

  // N7 版本指纹含 ctime：改中间内容再恢复 mtime，仍必须换版本。
  const ctimeFile = path.join(tmp, 'provider-ctime.txt')
  const ctimeText = 'a'.repeat(50000) + 'X'.repeat(1000) + 'a'.repeat(50000)
  fs.writeFileSync(ctimeFile, ctimeText)
  const ctimeBefore = provider.stat(ctimeFile)
  const ctimeStat = fs.statSync(ctimeFile)
  fs.writeFileSync(ctimeFile, ctimeText.replace('X'.repeat(1000), 'Y'.repeat(1000)))
  fs.utimesSync(ctimeFile, ctimeStat.atime, ctimeStat.mtime)
  const ctimeAfter = provider.stat(ctimeFile)
  check(ctimeBefore.version !== ctimeAfter.version, 'N7 ctime 使「改中间 + 恢复 mtime」换版本', `${ctimeBefore.version} -> ${ctimeAfter.version}`)

  // N6 观测缓存权限（POSIX）：源码片段不能落成 0644。
  const obs = path.join(tmp, 'provider-observations.json')
  const store = createDiskStore(obs)
  store.remember('source.js', 'v1', 'const secret = 1\n', false)
  check(fs.existsSync(obs), 'N6 观测缓存落盘')
  if (path.sep === '\\') {
    console.log('⊘ N6 cache mode：Windows 不承载 POSIX mode，跳过')
  } else {
    check((fs.statSync(obs).mode & 0o777) === 0o600, 'N6 观测缓存为 0600', (fs.statSync(obs).mode & 0o777).toString(8))
  }
}

say('O 写事务：journal / undo / 多目标回滚')
{
  const txFile = path.join(tmp, 'tx-single.txt')
  const txOriginal = 'one\ntwo\n'
  fs.writeFileSync(txFile, txOriginal)
  const txEdit = json(run(['edit', '--file', txFile, '--lines', '1', '--replace', 'ONE', '--transaction']))
  check(txEdit.ok === true && typeof txEdit.result?.transaction?.id === 'string', 'O1 单目标编辑返回 transaction id', JSON.stringify(txEdit.result?.transaction ?? txEdit.code))
  check(fs.readFileSync(txFile, 'utf8') === 'ONE\ntwo\n', 'O1 编辑已落盘')
  const txId = txEdit.result?.transaction?.id
  const txUndo = json(run(['undo', '--id', String(txId)]))
  check(txUndo.ok === true && txUndo.status === 'undone', 'O2 undo 成功', JSON.stringify(txUndo))
  check(fs.readFileSync(txFile, 'utf8') === txOriginal, 'O2 undo 恢复原始字节')

  const a = path.join(tmp, 'tx-a.txt')
  const b = path.join(tmp, 'tx-b.txt')
  fs.writeFileSync(a, 'alpha\n')
  fs.writeFileSync(b, 'beta\n')
  const targets = [
    { file_path: a, hunks: [{ lines: [1, 1], replace: 'ALPHA' }] },
    { file_path: b, hunks: [{ lines: [1, 1], replace: 'BETA' }] },
  ]
  const multi = json(run(['edit', '--targets', JSON.stringify(targets), '--transaction']))
  check(multi.ok === true && typeof multi.transaction?.id === 'string', 'O3 多目标编辑返回 transaction id', JSON.stringify(multi.transaction ?? multi.code))
  check(fs.readFileSync(a, 'utf8') === 'ALPHA\n' && fs.readFileSync(b, 'utf8') === 'BETA\n', 'O3 两个文件都已落盘')
  const multiUndo = json(run(['undo', '--id', String(multi.transaction?.id)]))
  check(multiUndo.ok === true && multiUndo.restored === 2, 'O4 多目标 undo 恢复两个文件', JSON.stringify(multiUndo))
  check(fs.readFileSync(a, 'utf8') === 'alpha\n' && fs.readFileSync(b, 'utf8') === 'beta\n', 'O4 两个文件都回到原始字节')

  const list = json(run(['transactions']))
  check(list.ok === true && Array.isArray(list.transactions) && list.transactions.length > 0, 'O5 transactions 列出当前工作区事务')

  // 事务后又被改过 ⇒ 默认拒绝 undo，force 才覆盖
  const guardFile = path.join(tmp, 'tx-guard.txt')
  fs.writeFileSync(guardFile, 'v0\n')
  const guardEdit = json(run(['edit', '--file', guardFile, '--lines', '1', '--replace', 'v1', '--transaction']))
  const guardId = guardEdit.result?.transaction?.id
  fs.writeFileSync(guardFile, 'external\n')
  const blocked = json(run(['undo', '--id', String(guardId)]))
  check(blocked.ok === false && blocked.code === 'TRANSACTION_STALE', 'O6 事务后文件被外部改过 ⇒ undo 默认拒绝', JSON.stringify({ code: blocked.code, error: blocked.error }))
  const forced = json(run(['undo', '--id', String(guardId), '--force']))
  check(forced.ok === true && fs.readFileSync(guardFile, 'utf8') === 'v0\n', 'O6 force 后仍可恢复')

  // O7 多目标：一个成功、一个写失败 ⇒ 成功那个也必须回滚
  const okFile = path.join(tmp, 'tx-rollback-ok.txt')
  const hardBase = path.join(tmp, 'tx-rollback-hard-base.txt')
  const hardFile = path.join(tmp, 'tx-rollback-hard.txt')
  fs.writeFileSync(okFile, 'alpha\n')
  fs.writeFileSync(hardBase, 'beta\n')
  let hardlinkOk = false
  try { fs.linkSync(hardBase, hardFile); hardlinkOk = true } catch { /* 受限 FS */ }
  if (!hardlinkOk) {
    console.log('⊘ O7 hardlink：本机不允许创建硬链接，跳过')
  } else {
    const rollbackTargets = [
      { file_path: okFile, hunks: [{ lines: [1, 1], replace: 'ALPHA' }] },
      { file_path: hardFile, hunks: [{ lines: [1, 1], replace: 'BETA' }] },
    ]
    const rollback = json(run(['edit', '--targets', JSON.stringify(rollbackTargets), '--transaction']))
    check(rollback.ok === false && rollback.transaction?.status === 'rolled_back', 'O7 多目标部分失败 ⇒ transaction rolled_back', JSON.stringify({ ok: rollback.ok, tx: rollback.transaction, rollback: rollback.rollback }))
    check(rollback.rollback?.restored === 1 && fs.readFileSync(okFile, 'utf8') === 'alpha\n', 'O7 已落地的那个文件被恢复')
    check(fs.readFileSync(hardBase, 'utf8') === 'beta\n' && fs.readFileSync(hardFile, 'utf8') === 'beta\n', 'O7 硬链接目标未被改动')
  }

  // O8 锁：同一工作区已有写事务时，第二个编辑必须超时拒绝
  const lockFile = path.join(tmp, 'tx-lock.txt')
  fs.writeFileSync(lockFile, 'lock\n')
  const previousCache = process.env.AURA_CACHE_DIR
  process.env.AURA_CACHE_DIR = cache
  try {
    await withWorkspaceLock(tmp, async () => {
      const res = spawnSync(process.execPath, [bin, 'edit', '--file', lockFile, '--lines', '1', '--replace', 'LOCK'], {
        cwd: tmp,
        encoding: 'utf8',
        env: { ...env, AURA_LOCK_TIMEOUT_MS: '200' },
      })
      const locked = json(res)
      check(locked.ok === false && locked.code === 'WORKSPACE_LOCKED', 'O8 工作区锁冲突返回 WORKSPACE_LOCKED', JSON.stringify({ code: locked.code, error: locked.error }))
      check(fs.readFileSync(lockFile, 'utf8') === 'lock\n', 'O8 锁冲突时磁盘未变')
    })
  } finally {
    if (previousCache === undefined) delete process.env.AURA_CACHE_DIR
    else process.env.AURA_CACHE_DIR = previousCache
  }
}

console.log(`\n--- 独立面：${pass} 通过 / ${fail} 失败 ---`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)

