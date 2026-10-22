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
  check(byId.get(1)?.result?.serverInfo?.name === 'aura-tools', 'serverInfo.name = aura-tools')
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
  check(tools.length === 2 && tools.some((t) => t.name === 'aura_read') && tools.some((t) => t.name === 'aura_edit'), `tools/list 两个工具（${tools.map((t) => t.name).join(',')}）`)
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

console.log(`\n--- 独立面：${pass} 通过 / ${fail} 失败 ---`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
