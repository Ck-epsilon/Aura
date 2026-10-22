#!/usr/bin/env node
/**
 * aura-basetools 一键安装器 —— 一个文件、三个平台、零依赖（只要有 Node ≥18，不需要 npm）。
 *
 * 谁用、怎么用：
 *   · 人：双击 `一键安装.cmd`（Windows）/ `一键安装.command`（macOS），或 `node install.mjs`
 *   · agent：`node install.mjs --yes --json`  —— 幂等、无交互、结果机器可读
 *
 * 它做四件事，每一步都先打印再执行（`--dry-run` 则只打印）：
 *   ① 把包体复制到 `~/.aura/pkg/node_modules/aura-basetools`（包体可以是同目录的目录或 .tgz）
 *   ② 在 `~/.aura/pkg/bin` 生成 `aura` / `aura-mcp` 命令（sh 与 .cmd 两种壳）
 *   ③ 把 MCP 服务器注册进**检测到的** agent（Codex / Claude Code / Cursor / DSH-可选）
 *   ④ 拿装好的东西跑一次真自检：CLI 取景 + MCP 握手（不是"看着像成功了"）
 *
 * 安全边界：只写 `--home`（默认 `$HOME`）与 `--prefix` 之内；每个被改的配置文件先备份成
 * `<文件>.bak-aura-<时间戳>`；`--uninstall` 按 `<prefix>/install.json` 精确撤销它自己加的东西。
 *
 * 测试缝：`--home <dir>` 可把"用户主目录"指到别处（本机验收就是这么跑的，不碰真实配置）；
 * `AURA_UPGRADE_FAULT=<阶段>` 让升级在指定阶段之后立刻中止（只给 build/upgrade-test.mjs 用，默认无效果）。
 *
 *   node install.mjs [--from <目录|.tgz|.zip|https-url>] [--prefix <dir>] [--home <dir>]
 *                    [--agent codex,claude,cursor,dsh] [--dsh-profile <名字>]
 *                    [--dry-run] [--uninstall] [--json] [--yes] [--help]
 *   node install.mjs --check [--manifest <本地文件|URL>] [--channel stable|beta]
 *   node install.mjs --upgrade --from <来源> [--manifest <本地文件|URL>] [--channel …]
 *   node install.mjs --rollback | --version | --doctor
 *
 * 退出码：0 成功；2 结构化拒绝（校验/预检/换名/终检失败，回执里给原因）；1 用法错。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_NAME = 'aura-basetools'
const MIN_NODE_MAJOR = 18

/**
 * 退出码按 §4.3 的三类分：成功 0、结构化拒绝 2（回执里给原因）、用法错 1。
 * 意外崩溃也按 2 收——它不该和"参数写错了"共用一个码。
 */
class UsageError extends Error {}
class InstallError extends Error {}

/** --json 是否开着：错误处理与故障注入都在 main 之外，所以它得是个模块级状态。 */
let jsonMode = false

const USAGE = `aura-basetools 一键安装器 / 升级器

用法：
  node install.mjs [选项]

选项：
  --from <目录|.tgz|.zip|https-url>  包体来源；默认取本文件所在目录（目录或旁边的 aura-basetools-*.tgz）
  --prefix <目录>               安装位置；默认 <home>/.aura/pkg
  --home <目录>                 把"用户主目录"指到别处（默认 $HOME；测试与自定义布局用）
  --agent <名字,名字>           只注册这些 agent；默认自动检测 codex,claude,cursor
  --dsh-profile <名字>          额外把两个工具行写进 ~/.dsh/profiles/<名字>/cordis.patch.yml
                                （该 patch 已有别的内容时会拒绝并打印该加的几行，不猜）
  --dry-run                     只打印将要做的事，不写任何文件
  --uninstall                   撤销本安装器做过的事（注册项 + 安装目录 + previous/staging）
  --version                     打印已装版本、构建戳（树哈希）与三面各自的生效时机
  --doctor                      体检：安装完整性（含树哈希）、注册项、CLI/MCP 自检、三面版本
  --check [--manifest <文件|URL>] [--channel stable|beta]
                                只比较版本；有清单时才联网（清单可以是本地文件，内网/离线一样用）
  --upgrade --from <来源>       升级：staging 预检 → 同盘原子换名 → 终检，失败自动回滚
  --rollback                    从 previous/ 换回上一版（先预检；不换坏的那份）
  --manifest <本地文件|URL>     清单（channels.stable/beta：version/url/sha256/minNode）
  --channel <stable|beta>       选渠道；默认 stable
  --check-url <URL>             显式用这个 URL 当清单查更新（不写它就是全程不联网）
  --json                        结果以 JSON 输出（agent 用）
  --yes, -y                     明确表示非交互（默认就非交互；给脚本/agent 一个显式开关）
  --help, -h                    打印这段

退出码：0 成功；2 结构化拒绝（校验/预检/换名/终检失败，原因见回执）；1 用法错
测试缝（只给 build/upgrade-test.mjs）：AURA_UPGRADE_FAULT=<阶段> 在该阶段之后立即中止
  阶段：after-staging / after-precheck / after-backup / after-clear / after-swap / final-check / after-rollback-swap
  中止用 process.exit(7)，并先吐一份 --json 回执（探针靠它区分"中止"与"未知参数"）
`

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
/** 读不出来就给 null：调用方据此“宁可不改也不猜”，不做半吊子解析。 */
const readJsonOrNull = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)

function parseArgs(argv) {
  const opts = {
    from: null,
    prefix: null,
    home: os.homedir(),
    agents: null,
    dshProfile: null,
    manifest: null,
    channel: 'stable',
    dryRun: false,
    uninstall: false,
    version: false,
    doctor: false,
    check: false,
    upgrade: false,
    rollback: false,
    json: false,
    yes: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = () => {
      i += 1
      if (i >= argv.length) throw new UsageError(`${arg} 后面缺参数`)
      return argv[i]
    }
    if (arg === '--from') opts.from = value()
    else if (arg === '--prefix') opts.prefix = path.resolve(value())
    else if (arg === '--home') opts.home = path.resolve(value())
    else if (arg === '--agent' || arg === '--agents') opts.agents = value().split(',').map((s) => s.trim()).filter((s) => s !== '')
    else if (arg === '--dsh-profile') opts.dshProfile = value()
    else if (arg === '--manifest') opts.manifest = value()
    else if (arg === '--channel') opts.channel = value()
    // --check-url 是显式开关：写了它才联网查更新，不写就全程不联网（见 §八）
    else if (arg === '--check-url') {
      opts.manifest = value()
      opts.check = true
    } else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--uninstall') opts.uninstall = true
    else if (arg === '--version') opts.version = true
    else if (arg === '--doctor') opts.doctor = true
    else if (arg === '--check') opts.check = true
    else if (arg === '--upgrade') opts.upgrade = true
    else if (arg === '--rollback') opts.rollback = true
    else if (arg === '--json') opts.json = true
    else if (arg === '--yes' || arg === '-y') opts.yes = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new UsageError(`不认识的参数：${arg}`)
  }
  const actions = ['uninstall', 'version', 'doctor', 'check', 'upgrade', 'rollback'].filter((name) => opts[name])
  if (actions.length > 1) throw new UsageError(`一次只能做一件事，给了：${actions.map((n) => `--${n}`).join('、')}`)
  if (opts.upgrade && opts.from === null && opts.manifest === null) {
    throw new UsageError('--upgrade 要指定来源：--from <本地目录|.tgz|.zip|URL> 或 --manifest <清单>')
  }
  if (opts.manifest !== null && !opts.check && !opts.upgrade) {
    throw new UsageError('--manifest 只在 --check / --upgrade 里有意义')
  }
  if (opts.agents !== null && opts.dshProfile !== null && !opts.agents.includes('dsh')) opts.agents.push('dsh')
  if (opts.agents !== null && opts.dshProfile !== null) opts.agents = [...new Set(opts.agents)]
  return opts
}

// ── ① 包体：目录、.tgz、或 URL ────────────────────────────────────────────────

const isPackageDir = (dir) => {
  const manifest = path.join(dir, 'package.json')
  if (!fs.existsSync(manifest)) return false
  try {
    return readJson(manifest).name === PKG_NAME
  } catch {
    return false
  }
}

/**
 * `--from` 指向一个**目录**时，找出它里面真正的包体。
 *
 * 为什么必须做这一步（实测的缺陷）：旧版拿到 `--from` 就**原样返回**，于是
 * `--from <一个既含 aura-basetools/ 又含 aura-basetools-<版本>.tgz 的发布目录>` 会把这个**父目录**当包体拷进
 * `node_modules/aura-basetools/`——结果包里多一层 `aura-basetools/`、而顶层没有 `package.json`，
 * 随即被安装器自己的“像不像 aura-basetools”校验拒掉。
 * 而那个形状恰恰是**交付包解开后的默认长相**（交付 zip 里就是目录与 .tgz 并列），
 * 所以它不是边角情形，是主路径。
 *
 * 顺序是“先目录、后 .tgz”：目录是已经解开的包（少一次解压），.tgz 才需要走 tar 读取。
 * 两者都没有时把**看到的东西**列出来——只说“找不到”会让用户不知道该删哪个参数。
 *
 * @param dir - 用户给的目录
 * @returns 包体路径（目录或 .tgz）
 */
function payloadInside(dir) {
  if (isPackageDir(dir)) return dir
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return null
  }
  // ① 子目录里的包（交付包解开后的常见形状）
  for (const name of entries.sort()) {
    const child = path.join(dir, name)
    try {
      if (fs.statSync(child).isDirectory() && isPackageDir(child)) return child
    } catch {
      /* 读不到的条目跳过：它不可能是我们要找的包 */
    }
  }
  // ② 旁边的 .tgz（取版本号最大的那个）
  //
  // **必须按数字段比**，不能直接 `.sort()` 拿最后一个：字典序里 `0.9.0` 排在 `0.10.0` **后面**
  // （'9' > '1'），于是发布目录里同时躺着两个版本时，默认来源会挑中**旧的那个**。
  // 这个形状迟早会出现（0.9.0 → 0.10.0 就是下一次），所以在这里按数值段比一次。
  const tgz = entries
    .filter((name) => /^aura-basetools-.*\.tgz$/.test(name))
    .sort((a, b) => compareVersionsIn(a, b))
    .pop()
  if (tgz !== undefined) return path.join(dir, tgz)
  return null
}

/**
 * 比较两个文件名里嵌的版本号（`aura-basetools-1.2.3.tgz`）。缺版本段的一侧按 -1 处理（排前面）。
 * 只认识 `\d+(\.\d+)*`，够用且不会猜：比不出来时退回字典序，保证是全序。
 */
function compareVersionsIn(a, b) {
  const parts = (s) => (s.match(/\d+(?:\.\d+)*/)?.[0] ?? '').split('.').map(Number)
  const [x, y] = [parts(a), parts(b)]
  if (x.length === 0 || y.length === 0) return a < b ? -1 : a > b ? 1 : 0
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const [u, v] = [x[i] ?? 0, y[i] ?? 0]
    if (u !== v) return u - v
  }
  return a < b ? -1 : a > b ? 1 : 0
}

function locatePayload(opts) {
  if (opts.from !== null) {
    // 远程 URL 与文件路径原样透传（下载/解压在后一步）
    if (/^https?:\/\//.test(opts.from) || fs.existsSync(opts.from) === false) return opts.from
    let stat = null
    try {
      stat = fs.statSync(opts.from)
    } catch {
      return opts.from
    }
    if (!stat.isDirectory()) return opts.from
    const found = payloadInside(opts.from)
    if (found !== null) return found
    throw new InstallError(
      `${opts.from} 里找不到 ${PKG_NAME} 包体：既没有含 package.json（name=${PKG_NAME}）的子目录，也没有 ${PKG_NAME}-*.tgz。` +
        `里面的东西是：${(() => {
          try {
            return fs.readdirSync(opts.from).slice(0, 12).join(', ') || '(空目录)'
          } catch {
            return '(读不出来)'
          }
        })()}`,
    )
  }
  const here = payloadInside(HERE)
  if (here !== null) return here
  throw new InstallError(
    `找不到包体：${HERE} 既不是 ${PKG_NAME} 包目录，也没有含它的子目录或 ${PKG_NAME}-*.tgz —— 用 --from 指定`,
  )
}

/** 极简 tar 读取（只认 ustar 常规文件/目录，外加 pax 与 GNU 长名）—— 目的是不必依赖 npm 就能解 .tgz。 */
function extractTgz(tgzPath, destDir) {
  const raw = zlib.gunzipSync(fs.readFileSync(tgzPath))
  const chunk = (buf, offset, len) => {
    const nul = buf.indexOf(0, offset)
    const stop = nul === -1 || nul > offset + len ? offset + len : nul
    return buf.toString('utf8', offset, stop).trim()
  }
  const written = []
  let offset = 0
  let longName = null
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = chunk(header, 0, 100)
    const prefix = chunk(header, 345, 155)
    const size = Number.parseInt(chunk(header, 124, 12) || '0', 8)
    const type = String.fromCharCode(header[156])
    offset += 512
    const body = raw.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0+$/, '').trim()
      continue
    }
    if (type === 'x' || type === 'g') {
      const pax = /(?:^|\n)\d+ path=([^\n]+)/.exec(body.toString('utf8'))
      if (type === 'x' && pax !== null) longName = pax[1]
      continue
    }
    const full = longName ?? (prefix === '' ? name : `${prefix}/${name}`)
    longName = null
    const relative = full.replace(/^package\//, '')
    if (relative === '') continue
    const target = path.resolve(destDir, relative)
    if (target !== path.resolve(destDir) && !target.startsWith(path.resolve(destDir) + path.sep)) {
      throw new InstallError(`包里有越出安装目录的路径：${full}`)
    }
    if (type === '5') {
      fs.mkdirSync(target, { recursive: true })
      continue
    }
    if (type !== '0' && type !== '\0' && type !== '') continue
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, body)
    written.push(relative)
  }
  if (written.length === 0) throw new InstallError(`${tgzPath} 里没解出任何文件 —— 包体可能损坏`)
  return written
}

/**
 * 极简 ZIP 读取（中央目录 + 本地头，只认 stored/deflate）—— 交付包就是 zip，
 * 收件人拿到的第一手来源也是它，安装器自己就得会读，不必依赖系统解压器。
 * 只解"包根"（放着 package.json 的那层）下的条目：交付包里还躺着 .tgz 与双击壳，
 * 那些不是包的一部分，进安装目录只会把完整性清单弄脏。
 */
/**
 * 极简 ZIP 读取（中央目录 + 本地头，只认 stored/deflate）—— 交付包就是 zip，
 * 收件人拿到的第一手来源也是它，安装器自己就得会读，不必依赖系统解压器。
 * 为什么 CRC 表不 import build/zip.mjs：install.mjs 是随包发的单文件安装器
 * （包里没有 build/），它必须自带全部依赖。
 * 只解"包根"（放着 package.json 的那层）下的条目：交付包里还躺着 .tgz 与双击壳，
 * 那些不是包的一部分，进安装目录只会把完整性清单弄脏。
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

const crc32 = (buffer) => {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function extractZip(zipPath, destDir) {
  const raw = fs.readFileSync(zipPath)
  const entries = []
  // 截断的 zip 会让 readUInt32LE 抛 RangeError（用户看到的是"内部错误"而不是"包坏了"），
  // 所以解析这一段整体兜住：转成带实际信息的 InstallError，并且带上原始 message（不吞）。
  let item = -1
  try {
    // EOCD 前面可以挂最长 65535 字节注释，所以从尾部往回找签名，不能假定它就是最后 22 字节
    let eocd = -1
    for (let i = raw.length - 22; i >= 0 && i >= raw.length - 22 - 65535; i -= 1) {
      if (raw.readUInt32LE(i) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd === -1) throw new InstallError(`${zipPath} 里找不到 zip 结尾记录 —— 这不是 zip，或文件被截断（共 ${raw.length} 字节）`)
    const count = raw.readUInt16LE(eocd + 10)
    const centralOffset = raw.readUInt32LE(eocd + 16)
    if (count === 0xffff || centralOffset === 0xffffffff) throw new InstallError(`${zipPath} 是 ZIP64，本安装器只读普通 zip`)
    let cursor = centralOffset
    for (item = 0; item < count; item += 1) {
      if (raw.readUInt32LE(cursor) !== 0x02014b50) throw new InstallError(`${zipPath} 的中央目录第 ${item + 1} 项签名不对（文件损坏？）`)
      const nameLen = raw.readUInt16LE(cursor + 28)
      const extraLen = raw.readUInt16LE(cursor + 30)
      const commentLen = raw.readUInt16LE(cursor + 32)
      entries.push({
        name: raw.toString('utf8', cursor + 46, cursor + 46 + nameLen),
        method: raw.readUInt16LE(cursor + 10),
        crc: raw.readUInt32LE(cursor + 16),
        compressed: raw.readUInt32LE(cursor + 20),
        size: raw.readUInt32LE(cursor + 24),
        localOffset: raw.readUInt32LE(cursor + 42),
      })
      cursor += 46 + nameLen + extraLen + commentLen
    }
  } catch (error) {
    if (error instanceof InstallError) throw error
    throw new InstallError(`${zipPath} 的 zip 结构在第 ${item + 1} 项附近断掉（很可能文件被截断，共 ${raw.length} 字节）：${error.message}`)
  }
  const rootOf = (name) => {
    const found = /^(?:(.*)\/)?package\.json$/.exec(name)
    return found === null ? null : found[1] ?? ''
  }
  const roots = [...new Set(entries.map((entry) => rootOf(entry.name)).filter((root) => root !== null))].sort(
    (a, b) => a.split('/').length - b.split('/').length,
  )
  if (roots.length === 0) throw new InstallError(`${zipPath} 里没有 package.json —— 解出来的不是我们的包`)
  const root = roots[0]
  // 先把整包读完、解压、校验 CRC（全在内存里），确认无一失误再落盘：
  // 长度相同但被翻掉一个 bit 的包体会静默通过长度校验，CRC 是手上现成的最后一道防线；
  // 而"边验边写"会把坏文件写进安装目录 —— 那正是我们要避开的那种半成品状态。
  const planned = []
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue
    const relative = root === '' ? entry.name : entry.name.startsWith(`${root}/`) ? entry.name.slice(root.length + 1) : null
    if (relative === null || relative === '' || relative.startsWith('__MACOSX/')) continue
    const target = path.resolve(destDir, relative)
    if (target !== path.resolve(destDir) && !target.startsWith(path.resolve(destDir) + path.sep)) {
      throw new InstallError(`包里有越出安装目录的路径：${entry.name}`)
    }
    let data
    try {
      // 数据起点只能读**本地头**里的两个长度：中央目录的 extra 字段与本地头的不一定一样长
      if (raw.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new InstallError(`${zipPath} 的本地头签名不对：${entry.name}`)
      const start = entry.localOffset + 30 + raw.readUInt16LE(entry.localOffset + 26) + raw.readUInt16LE(entry.localOffset + 28)
      const body = raw.subarray(start, start + entry.compressed)
      data = entry.method === 0 ? body : entry.method === 8 ? zlib.inflateRawSync(body) : null
      if (data === null) throw new InstallError(`${zipPath} 里 ${entry.name} 用了不支持的压缩方式 ${entry.method}`)
    } catch (error) {
      if (error instanceof InstallError) throw error
      throw new InstallError(`${zipPath} 里 ${entry.name} 读不出来（很可能文件被截断）：${error.message}`)
    }
    if (data.length !== entry.size) {
      throw new InstallError(`${zipPath} 里 ${entry.name} 解出 ${data.length} 字节，中央目录记的是 ${entry.size} —— 包体损坏`)
    }
    const actualCrc = crc32(data)
    if (actualCrc !== entry.crc) {
      throw new InstallError(
        `${zipPath} 里 ${entry.name} 的 CRC 对不上：期望 ${entry.crc.toString(16).padStart(8, '0')}，实际 ${actualCrc.toString(16).padStart(8, '0')} —— 包体在传输/复制中坏了（未写盘）`,
      )
    }
    planned.push({ relative, data })
  }
  if (planned.length === 0) throw new InstallError(`${zipPath} 里没解出任何文件（包根 ${root === '' ? '(zip 根)' : root}）`)
  for (const entry of planned) {
    const target = path.resolve(destDir, entry.relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, entry.data)
  }
  return planned.map((entry) => entry.relative)
}

/** 把包体落到 <prefix>/node_modules/aura-basetools。目录、.tgz、.zip 都支持；都不需要 npm。 */
function materialize(payload, installDir, log) {
  fs.mkdirSync(path.dirname(installDir), { recursive: true })
  fs.rmSync(installDir, { recursive: true, force: true })
  if (fs.statSync(payload).isDirectory()) {
    fs.cpSync(payload, installDir, {
      recursive: true,
      filter: (src) => path.basename(src) !== 'node_modules',
    })
    log(`包体      : ${payload}（就地复制，不用 npm）`)
  } else if (payload.toLowerCase().endsWith('.zip')) {
    const entries = extractZip(payload, installDir)
    log(`包体      : ${payload}（自带解包，${entries.length} 个文件）`)
  } else if (payload.endsWith('.tgz') || payload.endsWith('.tar.gz')) {
    const entries = extractTgz(payload, installDir)
    log(`包体      : ${payload}（自带解包，${entries.length} 个文件）`)
  } else {
    throw new InstallError(`不认识的包体：${payload}（要目录、.tgz、.zip 或 https URL）`)
  }
  if (!isPackageDir(installDir)) throw new InstallError(`装出来的目录不像 ${PKG_NAME}：${installDir}`)
  return readJson(path.join(installDir, 'package.json')).version
}

async function download(url, dir) {
  const name = path.basename(new URL(url).pathname) || `${PKG_NAME}.tgz`
  const file = path.join(dir, name)
  const response = await fetch(url)
  if (!response.ok) throw new InstallError(`下载失败 ${response.status}：${url}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()))
  return file
}

// ── ② 命令壳 ─────────────────────────────────────────────────────────────────

const shimSh = (script) => `#!/bin/sh\n# 由 aura-basetools install.mjs 生成\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`
const shimCmd = (script) => `@echo off\r\nrem 由 aura-basetools install.mjs 生成\r\n${JSON.stringify(process.execPath)} ${JSON.stringify(script)} %*\r\n`

function writeBins(binDir, installDir, write) {
  const written = []
  for (const [name, entry] of [
    ['aura', 'bin/aura.mjs'],
    ['aura-mcp', 'bin/aura-mcp.mjs'],
  ]) {
    const script = path.join(installDir, entry)
    const sh = path.join(binDir, name)
    const cmd = path.join(binDir, `${name}.cmd`)
    write(sh, shimSh(script))
    write(cmd, shimCmd(script))
    if (process.platform !== 'win32') fs.chmodSync(sh, 0o755)
    written.push(sh, cmd)
  }
  return written
}

// ── ③ 注册进各家 agent ───────────────────────────────────────────────────────

const CODEX_TABLE = 'mcp_servers.aura'

function registerCodex(file, installDir, write, log) {
  const entry = `[${CODEX_TABLE}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(path.join(installDir, 'bin/aura-mcp.mjs'))}]\n`
  const before = fs.readFileSync(file, 'utf8')
  if (before.includes(`[${CODEX_TABLE}]`)) {
    // 同名表已存在：内容就是我们写的那份 → 归我们（卸载该删）；否则是别人写的，卸载时不许碰
    const mine =
      before.includes(JSON.stringify(path.join(installDir, 'bin/aura-mcp.mjs'))) &&
      before.includes(JSON.stringify(process.execPath))
    return { agent: 'codex', file, action: mine ? 'present' : 'foreign' }
  }
  const next = `${before.replace(/\s*$/, '')}\n\n# aura-basetools：读按意图取景 / 改按意图寻址（装上即可用，删掉这段就撤销）\n${entry}`
  write(file, next, before)
  log(`注册      : codex → ${file}（[${CODEX_TABLE}]）`)
  return { agent: 'codex', file, action: 'added' }
}

function unregisterCodex(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const table = lines.findIndex((line) => line.trim() === `[${CODEX_TABLE}]`)
  if (table === -1) return 'absent'
  // 删除起点往前挪到我们写的注释/空行；删除终点必须从**表头**往下扫，否则会把表本身留下
  let start = table
  while (start > 0 && lines[start - 1].trim().startsWith('# aura-basetools')) start -= 1
  while (start > 0 && lines[start - 1].trim() === '') start -= 1
  let end = table + 1
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1
  const kept = [...lines.slice(0, start), ...lines.slice(end)]
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
  fs.writeFileSync(file, `${kept.join('\n')}\n`)
  return 'removed'
}

const jsonEntry = (installDir) => ({ command: process.execPath, args: [path.join(installDir, 'bin/aura-mcp.mjs')] })

function registerJson(file, installDir, write, log, agent) {
  const before = fs.readFileSync(file, 'utf8')
  let config
  try {
    config = JSON.parse(before)
  } catch (error) {
    throw new InstallError(`${file} 不是合法 JSON（${error.message}）—— 不动它，请手工加 mcpServers.aura`)
  }
  const servers = config.mcpServers ?? {}
  if (servers.aura !== undefined) {
    const mine = JSON.stringify(servers.aura) === JSON.stringify(jsonEntry(installDir))
    return { agent, file, action: mine ? 'present' : 'foreign' }
  }
  config.mcpServers = { ...servers, aura: jsonEntry(installDir) }
  write(file, `${JSON.stringify(config, null, 2)}\n`, before)
  log(`注册      : ${agent} → ${file}（mcpServers.aura）`)
  return { agent, file, action: 'added' }
}

function unregisterJson(file) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (config.mcpServers === undefined || config.mcpServers.aura === undefined) return 'absent'
  delete config.mcpServers.aura
  if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
  return 'removed'
}

/**
 * DSH 的 patch：只在“空白 patch”上代写；已有别的内容就拒绝并打印该加的行（不猜 YAML）。
 *
 * ## 写**绝对路径**，不写相对路径（一次实测后的修正）
 *
 * 旧版写的是 `name: './aura-read/index.js'`。看起来像“相对安装目录”，其实不是：
 * Cordis 的加载器对 `name.startsWith('.')` 走 `new URL(name, this.ctx.baseUrl)`，
 * 而 `baseUrl` 是 **dsh 自己 bundle 文件所在的目录**（`dsh-app-boot` 用 `import.meta.url` 设的）。
 * 也就是说那条相对路径解析到的是 dsh 安装目录下一层，跟 profile 目录、安装目录**都没关系**——
 * 实测（临时 home + profile）：它指向 `<profile>/aura-read/index.js`，而那个文件不存在。
 *
 * 绝对路径没有这个歧义，而且与当前实装面上跑得通的那份 patch 同形。代价是“整个 prefix 被搬走”会失效，
 * 但那是显式动作，升级（`--upgrade`）保持目录不变。
 *
 * ## 写完验一次
 *
 * 两个 `index.js` 都必须在安装目录里真的存在。不验就写，就是把一份**必然加载失败**的配置
 * 交给宿主，而失败发生在重启之后——那时已经离安装很远了。验不过就报错，不写。
 *
 * @param home - 用户主目录（`--home`）
 * @param profile - DSH profile 名
 * @param prefix - 安装前缀（包在 `<prefix>/node_modules/aura-basetools`）
 * @param write - 带备份的写盘器
 * @param log - 进度输出
 */
/**
 * dsh 的 profile 目录。
 *
 * 注册（写进去）与体检（看里面还有没有别的东西）**共用这一处**——两边各算一次，
 * 迟早会出现"注册写这里、体检查那里，于是永远查不到"的形状。
 */
const dshProfilesRoot = (home) => path.join(home, '.dsh', 'profiles')

function registerDsh(home, profile, prefix, write, log) {
  const file = path.join(dshProfilesRoot(home), profile, 'cordis.patch.yml')
  if (!fs.existsSync(path.dirname(file))) throw new InstallError(`profile 不存在：${path.dirname(file)}`)
  const pkgDir = path.join(prefix, 'node_modules', PKG_NAME)
  const entries = [
    ['tool-aura-read', path.join(pkgDir, 'aura-read', 'index.js')],
    ['tool-aura-edit', path.join(pkgDir, 'aura-edit', 'index.js')],
  ]
  const missing = entries.filter(([, target]) => !fs.existsSync(target)).map(([, target]) => target)
  if (missing.length > 0) {
    throw new InstallError(
      `不能注册 DSH：安装目录里找不到这些文件：${missing.join('、')}。` +
        `先把包完整装上（node install.mjs --from <包体>），再带 --agents dsh 重跑；` +
        `这一条不写任何配置——写一份必然加载失败的补丁比不写更坏`,
    )
  }
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (before.includes('tool-aura-read')) return { agent: 'dsh', file, action: 'already' }
  /**
   * 用**YAML 单引号**，不用 `JSON.stringify`。
   *
   * 两者对 Windows 路径的观感差很多：`JSON.stringify('C:\\a\\b')` 产出 `"C:\\\\a\\\\b"`——
   * 在 YAML 双引号里那是合法转义（解析回单反斜杠），但它看起来像“路径被双写了”，
   * 每个读到这行的人都要重新推一遍“这到底是不是错的”。
   * 单引号标量里反斜杠就是字面值，写出来与内存里的路径**逐字相同**。
   * 实装面上那份跑得通的 patch 用的就是单引号，这里对齐它。
   */
  const rows = [
    '- insert:',
    ...entries.flatMap(([id, target], index) => [
      ...(index === 0 ? [] : ['']),
      `    - id: ${id}`,
      `      name: '${target}'`,
    ]),
  ].join('\n')
  if (before.trim() !== '' && before.trim() !== '[]') {
    return {
      agent: 'dsh',
      file,
      action: 'manual',
      hint: `${file} 已有别的补丁内容，请手工把下面几行并进 - insert: 那一段：\n${rows}`,
    }
  }
  write(file, `${rows}\n`, before)
  log(`注册      : dsh(${profile}) → ${file}（两个工具行，绝对路径）`)
  return { agent: 'dsh', file, action: 'added', targets: entries.map(([, target]) => target) }
}

// ── ③b 宿主 peer：插件能不能**真的被 import**，而不是“文件在” ────────────────

/**
 * 本包在 DSH 面需要的三个宿主包（与 `package.json` 的 `peerDependencies` **必须一致**）。
 *
 * `@deepseek-ai/dsh-shell` 与前两个同理，但症状更隐蔽：`dsh/argv-shell.mjs`（钩子执行器）
 * 在**顶层**就 `import { ShellExecutor }` 它 ⇒ 漏了它，执行器一加载就 `ERR_MODULE_NOT_FOUND`。
 * 实测（临时前缀装一遍）：**只把它写进 package.json 的 peerDependencies 不会建这个 junction**——
 * 本清单才是 `linkHostPeers` 的输入，所以两处必须同时加，否则装上后钩子全不触发、却没有堆栈指向 peer。
 *
 * 为什么必须有它们：DSH 的加载器对**绝对路径**的插件直接 `import(路径)`，
 * 于是插件的依赖从**插件自己的位置**向上找——`<prefix>/node_modules/aura-basetools/...` ⇒
 * `<prefix>/node_modules/`。那里没有 `@deepseek-ai/*` ⇒ 启动时 `ERR_MODULE_NOT_FOUND`。
 * 而失败发生在**重启之后**：`dsh` 只在启动时导入插件模块，不热更新。
 * 这就是“装完看着都对、重启就爆”的完整机制。
 */
const HOST_PEERS = ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-shell']

/**
 * 从**插件所在位置**做一次真的 ESM 导入。
 *
 * 这是本文件里唯一能回答“DSH 重启后能不能加载它”的判据。
 * `fs.existsSync` 答不了：文件存在而 peer 缺失时它照样说“在”。
 * 用子进程做，是因为宿主包的依赖图可能与本进程不同（也避免把插件模块缓存进本进程）。
 *
 * @param entry - 插件入口的绝对路径
 * @returns `{ ok, detail }`（失败时 detail 是模块系统给的那句话）
 */
function importSmoke(entry) {
  const script = [
    'const { pathToFileURL } = require("node:url");',
    'import(pathToFileURL(process.argv[1]).href)',
    '  .then((m) => { const n = Object.keys(m); process.stdout.write("OK " + n.length); })',
    '  .catch((e) => { process.stdout.write("FAIL " + String(e.code ?? e.message).split("\\n")[0]); });',
  ].join('\n')
  const res = spawnSync(process.execPath, ['-e', script, entry], { encoding: 'utf8', timeout: 30000 })
  const out = String(res.stdout ?? '').trim()
  if (out.startsWith('OK ')) return { ok: true, detail: `${out.slice(3)} 个导出` }
  return { ok: false, detail: out.replace(/^FAIL /, '') || `子进程退出码 ${res.status}` }
}

/**
 * 把宿主的 peer 包接进 `<prefix>/node_modules`（**只在缺的时候接**）。
 *
 * 用 junction/symlink 而不是复制：这两个包由 dsh 自己维护版本，复制就会漂。
 * 找不到就**不动手**并如实报告——比装上一个错的版本强。
 *
 * @param prefix - 安装前缀
 * @param peerRoots - 可能藏着这些包的目录（按优先级）
 * @returns `{ linked: string[], present: string[], missing: string[], searched: string[] }`
 */
function linkHostPeers(prefix, peerRoots) {
  const scopeDir = path.join(prefix, 'node_modules', '@deepseek-ai')
  const linked = []
  const present = []
  const missing = []
  for (const peer of HOST_PEERS) {
    const name = peer.slice('@deepseek-ai/'.length)
    const target = path.join(scopeDir, name)
    if (fs.existsSync(target)) {
      present.push(peer)
      continue
    }
    let found = null
    for (const root of peerRoots) {
      const candidate = path.join(root, name)
      if (fs.existsSync(path.join(candidate, 'package.json'))) {
        found = candidate
        break
      }
    }
    if (found === null) {
      missing.push(peer)
      continue
    }
    try {
      fs.mkdirSync(scopeDir, { recursive: true })
      fs.symlinkSync(found, target, 'junction')
      linked.push(peer)
    } catch {
      missing.push(peer)
    }
  }
  return { linked, present, missing, searched: peerRoots }
}

/**
 * 宿主的 peer 包可能藏在哪些目录（按“最可能是真的”排序，去重）。
 *
 * ## 为什么必须探测而不是拼路径（第一版就是拼的，实测找不到）
 *
 * 第一版写了三个“理论上的全局位置”：`dirname(node)/../lib/node_modules`（POSIX 布局）、
 * `dirname(node)/node_modules`、`~/AppData/Roaming/npm/node_modules`。
 * 本机实测：node 与 npm 全局根**不在同一棵树**（分了本地/全局两层）——三个猜法全落空，
 * 报“没找到”，于是“自动接 peer”从未生效。教训：全局布局不能拼，要探测（问 npm 自己）。
 *
 * （注释里不写这台机器的真实盘符路径：`make-bundle` 的守卫会拦下它——而那个守卫是对的，
 * 引擎/宿主代码里出现绝对路径就意味着包无法跨机使用。）
 *
 * 而且 peer 不在全局根顶层，而是在 **dsh 自己的嵌套 node_modules** 里：
 *   `<npm root -g>/@deepseek-ai/dsh/node_modules/@deepseek-ai/{schemastery,dsh-tools}`
 * 所以探测要分两步：找到“装着 @deepseek-ai 的目录”，再看它下面有没有 `dsh/node_modules/@deepseek-ai`。
 *
 * @returns 候选目录（可能为空——那就只能如实报“没找到”）
 */
function hostPeerRoots() {
  const roots = []
  const add = (p) => {
    if (typeof p === 'string' && p !== '' && fs.existsSync(p) && !roots.includes(p)) roots.push(p)
  }
  const globalRoots = []
  // ① 问 npm 自己（最权威；失败的机器上可能没 npm，所以包 try）
  try {
    const res = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], {
      encoding: 'utf8',
      timeout: 15000,
      shell: process.platform === 'win32',
    })
    const out = String(res.stdout ?? '').trim().split('\n').pop()
    if (typeof out === 'string' && out !== '') globalRoots.push(out.trim())
  } catch {
    /* 没 npm 也能继续：下面的候选够用 */
  }
  // ② 常见全局位置（npm prefix / pnpm / nvm 风格的几种）
  globalRoots.push(
    process.env.npm_config_prefix === undefined ? '' : path.join(process.env.npm_config_prefix, 'lib', 'node_modules'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules'),
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules'),
    path.join(path.dirname(process.execPath), 'node_modules'),
  )
  for (const g of globalRoots) {
    if (typeof g !== 'string' || g === '') continue
    // 优先 dsh 自带的嵌套那一份（版本与本机 dsh 必然一致）
    add(path.join(g, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    add(path.join(g, '@deepseek-ai'))
  }
  // ③ npx 缓存：`npx @deepseek-ai/dsh …` 那条路把包解在 ~/.npm/_npx/<hash>/node_modules
  const npxCache = path.join(os.homedir(), '.npm', '_npx')
  if (fs.existsSync(npxCache)) {
    let hashes = []
    try {
      hashes = fs.readdirSync(npxCache)
    } catch {
      hashes = []
    }
    for (const h of hashes) {
      add(path.join(npxCache, h, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
      add(path.join(npxCache, h, 'node_modules', '@deepseek-ai'))
    }
  }
  return roots
}

// ── ④ 自检：装完真跑一次 ─────────────────────────────────────────────────────

function selftest(installDir, log, cacheDir) {
  const cli = path.join(installDir, 'bin', 'aura.mjs')
  const mcp = path.join(installDir, 'bin', 'aura-mcp.mjs')
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `${PKG_NAME}-selftest-`))
  const sample = path.join(scratch, 'sample.mjs')
  fs.writeFileSync(sample, 'export function alpha() {\n  return 1;\n}\n\nexport function beta() {\n  return 2;\n}\n')
  // 自检也把观测缓存指进安装目录：装的过程中不该往真实的 ~/.aura 落东西
  const env = { ...process.env, AURA_CACHE_DIR: cacheDir }
  const result = { cli: 'fail', mcp: 'fail', serverInfo: { name: null, version: null } }
  const read = spawnSync(process.execPath, [cli, 'read', '--file', sample, '--mode', 'map', '--pretty'], {
    encoding: 'utf8',
    timeout: 30000,
    env,
  })
  if (read.status === 0 && read.stdout.includes('alpha') && read.stdout.includes('beta')) {
    result.cli = 'ok'
  } else {
    result.cli = `fail: exit=${read.status} ${(read.stderr || read.stdout).trim().split('\n')[0] ?? ''}`
  }
  const frames = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'install.mjs', version: '1' } } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    '',
  ].join('\n')
  const handshake = spawnSync(process.execPath, [mcp], { input: frames, encoding: 'utf8', timeout: 30000, env })
  const replies = handshake.stdout
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((msg) => msg !== null)
  const names = replies.filter((msg) => Array.isArray(msg.result?.tools)).flatMap((msg) => msg.result.tools.map((tool) => tool.name))
  // 握手回的 serverInfo.version 是"正在应答的那个进程"自报的版本 —— doctor 靠它回答"三面是不是同一个版本"
  const info = replies.find((msg) => msg.result?.serverInfo !== undefined)?.result.serverInfo ?? null
  result.serverInfo = { name: info?.name ?? null, version: info?.version ?? null }
  if (names.includes('aura_read') && names.includes('aura_edit')) result.mcp = `ok: ${names.join(', ')}`
  else result.mcp = `fail: exit=${handshake.status} 工具=${names.join(',') || '(无)'}`
  fs.rmSync(scratch, { recursive: true, force: true })
  log(`自检      : CLI ${result.cli}；MCP ${result.mcp}`)
  return result
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

function makeWriter(dryRun, planned) {
  return (file, content, before) => {
    if (dryRun) {
      planned.push(file)
      return
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (before !== undefined) {
      const backup = `${file}.bak-aura-${stamp()}`
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, before)
    }
    const tmp = `${file}.aura-tmp`
    fs.writeFileSync(tmp, content)
    fs.renameSync(tmp, file)
  }
}

async function main() {
  // 用法错也要能回 JSON：所以 --json 先扫一眼（参数解析失败时就来不及设了）
  jsonMode = process.argv.includes('--json')
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (Number.parseInt(process.versions.node, 10) < MIN_NODE_MAJOR) {
    throw new InstallError(`需要 Node ≥${MIN_NODE_MAJOR}，当前 ${process.versions.node}`)
  }
  if (!fs.existsSync(opts.home)) throw new InstallError(`--home 指向的目录不存在：${opts.home}（拼错了吗？）`)
  const paths = layout(opts)
  const { prefix, installDir, binDir } = paths
  const lines = []
  const log = (line) => lines.push(line)
  const planned = []
  const write = makeWriter(opts.dryRun, planned)

  if (opts.uninstall) return uninstall(opts, { ...paths, lines, log })
  if (opts.version) return reportVersion(opts, paths)
  if (opts.doctor) return doctor(opts, paths)
  if (opts.check) return checkUpdate(opts, paths)
  if (opts.rollback) return rollback(opts, paths)
  if (opts.upgrade) return upgrade(opts, paths)

  const payloadLabel = locatePayload(opts)
  let payload = payloadLabel
  if (/^https?:\/\//.test(payload)) payload = await download(payload, path.join(prefix, '.cache'))
  if (!fs.existsSync(payload)) throw new InstallError(`包体不存在：${payload}`)
  const version = opts.dryRun ? '(dry-run)' : materialize(payload, installDir, log)
  log(`安装到    : ${installDir}`)
  const bins = writeBins(binDir, installDir, opts.dryRun ? (file) => planned.push(file) : (file, content) => write(file, content))
  log(`命令      : ${bins.filter((b) => !b.endsWith('.cmd')).join('、')}`)

  const wanted = opts.agents ?? ['codex', 'claude', 'cursor']
  const registrations = []
  for (const agent of wanted) {
    if (agent === 'codex') {
      const file = path.join(opts.home, '.codex', 'config.toml')
      if (fs.existsSync(file)) registrations.push(registerCodex(file, installDir, write, log))
    } else if (agent === 'claude') {
      const file = path.join(opts.home, '.claude.json')
      if (fs.existsSync(file)) registrations.push(registerJson(file, installDir, write, log, 'claude'))
    } else if (agent === 'cursor') {
      const file = path.join(opts.home, '.cursor', 'mcp.json')
      if (fs.existsSync(file)) registrations.push(registerJson(file, installDir, write, log, 'cursor'))
    } else if (agent === 'dsh') {
      if (opts.dshProfile === null) throw new UsageError('agent=dsh 时要一起给 --dsh-profile <名字>')
      registrations.push(registerDsh(opts.home, opts.dshProfile, prefix, write, log))
    } else {
      throw new UsageError(`不认识的 agent：${agent}（可选 codex,claude,cursor,dsh）`)
    }
  }
  const label = { added: '已写入', present: '已是本安装器的', foreign: '已存在（别人写的，未动）', manual: '需手工' }
  const detected = registrations.map((r) => `${r.agent}:${label[r.action] ?? r.action}`)
  log(`注册      : ${detected.length > 0 ? detected.join('、') : '(没检测到任何 agent 的配置——手工片段见下)'}`)
  const snippet = JSON.stringify({ mcpServers: { aura: { command: 'node', args: [path.join(installDir, 'bin/aura-mcp.mjs')] } } })
  log(`任意 MCP 客户端可用：${snippet}`)

  const manual = registrations.filter((r) => r.action === 'manual')
  /**
   * 宿主 peer + **导入冒烟测试**（装的时候就做，不等重启）。
   *
   * 为什么必须在**装**的时候做：dsh 只在启动时导入插件模块、不热更新，
   * 所以 peer 缺失的后果要到**下次重启**才爆——那时离安装已经很远，“是不是装的锅”都得重新排。
   * 这里当场 import 一次，失败就在回执里点名（并且写进状态文件，--doctor 也会再报一次）。
   */
  const peerRoots = hostPeerRoots()
  const peers = opts.dryRun ? null : linkHostPeers(prefix, peerRoots)
  const dshSmoke = opts.dryRun
    ? []
    : ['aura-read', 'aura-edit'].map((name) => ({
        name,
        entry: path.join(installDir, name, 'index.js'),
        smoke: importSmoke(path.join(installDir, name, 'index.js')),
      }))
  if (peers !== null) {
    if (peers.linked.length > 0) log(`宿主 peer  : 已接入 ${peers.linked.join('、')}（junction 到 dsh 自带的那一份）`)
    if (peers.present.length > 0 && peers.linked.length === 0) log(`宿主 peer  : 已在位 ${peers.present.join('、')}`)
    if (peers.missing.length > 0) {
      log(`宿主 peer  : ⚠ 没找到 ${peers.missing.join('、')}（找过：${peers.searched.join(' / ') || '无候选目录'}）`)
      log(`             这会让 DSH 重启后加载插件失败（ERR_MODULE_NOT_FOUND）；把 dsh 自带的同名包 junction 到 ${path.join(prefix, 'node_modules', '@deepseek-ai')} 即可`)
    }
  }
  for (const item of dshSmoke) {
    log(`导入冒烟  : ${item.name} ${item.smoke.ok ? `ok（${item.smoke.detail}）` : `✗ ${item.smoke.detail}`}`)
  }
  const smokeFailed = dshSmoke.filter((item) => !item.smoke.ok)

  const test = opts.dryRun ? { cli: 'skipped', mcp: 'skipped' } : selftest(installDir, log, path.join(prefix, '.cache'))
  if (!opts.dryRun) {
    // `files` 是**体检的依据**，`treeHash`/`buildStamp` 是**升级的依据**：
    // 没有它们，doctor 回答不了"这份被动过吗"，升级回答不了"这份字节是不是我以为的那份"。
    const info = treeInfo(installDir)
    saveState(opts, paths, buildState(paths, info, {
      installedAt: new Date().toISOString(),
      previousVersion: null,
      payload: describePayload(payloadLabel, payload),
      registrations,
      // 记下“插件能不能被 import”这件事：--doctor 靠它区分“文件在”与“能加载”
      dshLoad: dshSmoke.map((item) => ({ name: item.name, entry: item.entry, ok: item.smoke.ok, detail: item.smoke.detail })),
    }))
    log(`内容哈希  : ${info.treeHash}（构建戳 ${info.buildStamp}）`)
    log(
      process.platform === 'win32'
        ? `PATH 建议 : 把 ${binDir} 加进用户 PATH（系统属性 → 环境变量；不建议用 setx 拼 %PATH%）`
        : `PATH 建议 : export PATH="${binDir}:$PATH"（写进 ~/.zshrc 或 ~/.bashrc）`,
    )
  }
  /**
   * 整体 ok 的判据包含**导入冒烟**。
   *
   * 从前这里只看 CLI/MCP 自检——而那两个走的是 node:fs 路径，与 DSH 插件那条路（ESM 导入 +
   * 从插件位置解析 peer）完全不同。实测：peer 缺失时 CLI/MCP 全绿、`fs.existsSync` 也全绿，
   * 只有真 `import()` 会红。所以它必须进来，否则安装器会报一个“重启才爆”的成功。
   */
  const ok = test.cli === 'ok' && test.mcp.startsWith('ok') && smokeFailed.length === 0
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok,
          version,
          installDir,
          binDir,
          registrations,
          selftest: test,
          ...(peers === null ? {} : { hostPeers: peers }),
          ...(opts.dryRun ? {} : { dshLoad: dshSmoke.map((item) => ({ name: item.name, ok: item.smoke.ok, detail: item.smoke.detail })) }),
          planned,
          notes: lines,
        },
        null,
        2,
      )}\n`,
    )
  } else {
    process.stdout.write(`aura-basetools 安装${opts.dryRun ? '预演' : ''}（${version}）\n`)
    for (const line of lines) process.stdout.write(`  ${line}\n`)
    for (const item of manual) process.stdout.write(`  ⚠️  ${item.hint}\n`)
    process.stdout.write(`\n${ok || opts.dryRun ? '完成' : '装是装上了，但自检没过——把上面那行原样贴给我'}：${opts.dryRun ? '去掉 --dry-run 即真装' : '重开 agent 会话后即可用 aura_read / aura_edit'}\n`)
  }
  if (!ok && !opts.dryRun) return 2
  return 0
}

/** 递归列出安装目录里的普通文件（相对路径 → sha256）。体检与（以后的）升级校验共用。 */
function hashTree(dir, base = dir, out = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) hashTree(full, base, out)
    else out[path.relative(base, full).replaceAll('\\', '/')] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
  }
  return out
}

/** 三个面各自的生效时机。这是**实测出来的行为**，不是推测：DSH 宿主启动时导入模块，改文件不热更新。 */
const SURFACES = [
  ['CLI（aura / aura-mcp）', '立即生效：每次调用读磁盘'],
  ['MCP（Codex / Claude Code / Cursor）', '新会话生效：服务由客户端按会话启动，正在跑的会话仍是旧代码'],
  ['DSH 工具（aura_read / aura_edit）', '需重启 dsh：宿主启动时导入模块，改文件不热更新'],
]

/** `--version`：报的还是**磁盘上那一份**（不是状态文件里的旧记录），并把内容哈希与构建戳摆出来。 */
function reportVersion(opts, paths) {
  const { installDir, statePath } = paths
  const info = fs.existsSync(installDir) ? treeInfo(installDir) : null
  const state = fs.existsSync(statePath) ? readJsonOrNull(statePath) : null
  const surfaces = surfaceReport(info?.version ?? null, null, paths)
  const recorded = state === null ? null : {
    version: state.version ?? null,
    treeHash: state.treeHash ?? null,
    buildStamp: state.buildStamp ?? null,
  }
  const report = {
    ok: info !== null,
    version: info?.version ?? null,
    treeHash: info?.treeHash ?? null,
    buildStamp: info?.buildStamp ?? null,
    installDir,
    installedAt: state?.installedAt ?? null,
    upgradedAt: state?.upgradedAt ?? null,
    previousVersion: state?.previousVersion ?? null,
    recorded,
    // 记录与磁盘是不是同一份：版本号一样而字节不一样时，这里是唯一的警报
    agrees: recorded === null ? null : recorded.treeHash === info?.treeHash,
    surfaces,
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else {
    process.stdout.write(`aura-basetools ${report.version ?? '(没找到安装目录)'}${report.buildStamp === null ? '' : `（构建戳 ${report.buildStamp}）`}\n`)
    process.stdout.write(`  内容哈希 : ${report.treeHash ?? '(缺失)'}\n`)
    process.stdout.write(`  安装位置 : ${installDir}\n`)
    process.stdout.write(`  安装时间 : ${report.installedAt ?? '(没有状态文件)'}${report.upgradedAt === null ? '' : `（升级于 ${report.upgradedAt}）`}\n`)
    if (report.previousVersion !== null) process.stdout.write(`  可回滚到 : ${report.previousVersion}（node install.mjs --rollback）\n`)
    process.stdout.write(`  三面版本 : ${surfacesLine(surfaces)}\n`)
    // `SURFACES` 是**二元组**列表（`[名字, 生效时机]`），所以要按数组解构。
    // 这里曾经写成对象解构 `{ name, when }`：数组上取不存在的属性不报错，
    // 只会印出三行 `· undefined：undefined`——一个只看成败的测试永远抓不到的错。
    // 同一个列表在 `doctor` 里（L884）用的是正确的数组解构，两处写法不一致就是这个 bug 的入口。
    for (const [name, when] of SURFACES) process.stdout.write(`  · ${name}：${when}\n`)
    if (report.agrees === false) {
      process.stdout.write(`  ⚠️  状态文件记的是 ${recorded.buildStamp ?? String(recorded.treeHash).slice(0, 12)}…… —— 与磁盘上这份不是同一份字节（用 --doctor 细看）\n`)
    }
  }
  return report.ok ? 0 : 2
}

/**
 * 体检：升级之前先在**当前**安装上回答“它还好着吗、被动过吗、三面各自什么状态”。
 * 判据取“装包集合”：只有真的比对得到的东西才报，缺依据时明说缺依据。
 */
/**
 * 体检：在**当前**安装上回答"它还好着吗、被动过吗、三面各自什么版本"（§4.3）。
 * 判据取"装包集合"：只有真的比对得到的东西才报，缺依据时明说缺依据。
 * 它是**只读**的：上次升级留下的残局只在这里被认出来，收拾残局是 --rollback / --upgrade 的事。
 */
function doctor(opts, paths) {
  const { installDir, binDir } = paths
  const lines = []
  const say = (line) => lines.push(line)
  const problems = []
  const problemsText = []
  const recovery = []
  const manifestPath = path.join(installDir, 'package.json')
  const state = fs.existsSync(paths.statePath) ? readJsonOrNull(paths.statePath) : null
  const info = fs.existsSync(installDir) ? treeInfo(installDir) : null
  const installed = info?.version ?? null
  if (installed === null) problems.push(`安装目录不可用：${manifestPath} 不存在`)
  say(`版本      : ${installed ?? '(缺失)'}${info === null ? '' : `（构建戳 ${info.buildStamp}）`}`)
  if (info !== null) say(`内容哈希  : ${info.treeHash}`)

  // 上次升级的残局：journal 是唯一依据，判据与 --upgrade/--rollback 收拾时用的那套完全一样
  const leftover = journalState(paths, readJournal(paths))
  if (leftover !== null) {
    say(`上次升级  : ${leftover.text}`)
    say(`下一步    : ${leftover.next}`)
    recovery.push(leftover.next)
    // 只有"现网不是完整的一份"才算问题：换名前被打断（现网仍是完整旧版）不需要动作
    if (leftover.kind === 'gap') problems.push(`现网目录缺席（换名中间被打断）：${leftover.text}；${leftover.next}`)
    if (leftover.kind === 'pending') problems.push(`换名已完成但状态没落盘：${leftover.text}；${leftover.next}`)
    if (leftover.kind === 'unknown') problems.push(`无法对应的升级残局：${leftover.text}；${leftover.next}`)
  }
  const staging = fs.existsSync(paths.staging) ? fs.readdirSync(paths.staging) : []
  if (staging.length > 0) {
    say(`staging   : ${staging.length} 项残留（${staging.slice(0, 3).join('、')}${staging.length > 3 ? '…' : ''}）—— 排查用的落脚点，可随时删`)
  }

  if (info !== null) {
    if (state?.files === undefined) {
      say('完整性    : 这份安装没记录文件清单，跳过（重装一次即可获得该能力）')
    } else if (leftover?.kind === 'pending') {
      // 换名完成但状态没落盘时，磁盘与旧记录当然不一致：这时候报"不一致"是误导
      say('完整性    : 与换名记录一致（状态文件待补写，见上一行）')
    } else {
      const changed = Object.keys(info.files).filter((name) => state.files[name] !== undefined && state.files[name] !== info.files[name])
      const added = Object.keys(info.files).filter((name) => state.files[name] === undefined)
      const missing = Object.keys(state.files).filter((name) => info.files[name] === undefined)
      say(`完整性    : 记录 ${Object.keys(state.files).length} 个文件，改动 ${changed.length}、多出 ${added.length}、缺失 ${missing.length}`)
      if (changed.length > 0) problems.push(`安装目录有文件与安装记录不一致（被改过或被别的版本覆盖）：${changed.slice(0, 5).join(', ')}`)
      if (missing.length > 0) problems.push(`安装目录有缺失文件：${missing.slice(0, 5).join(', ')}`)
      // “多出文件”不算问题（调试产物、缓存可能落在这里），只报数
    }
    if (leftover?.kind !== 'pending' && typeof state?.treeHash === 'string' && state.treeHash !== info.treeHash) {
      problems.push(
        `磁盘的树哈希与安装记录不同：记录 ${state.treeHash.slice(0, 12)}…，磁盘 ${info.treeHash.slice(0, 12)}…（同一个版本号下可能是两份不同字节）`,
      )
    }
  }

  for (const item of state?.registrations ?? []) {
    if (item.action === 'foreign') continue
    if (!fs.existsSync(item.file)) {
      problems.push(`注册项所指的配置不存在：${item.file}`)
      continue
    }
    const text = fs.readFileSync(item.file, 'utf8')
    /**
     * 每个 agent 的“正常”是**不同形状**的，不能共用一条判据。
     *
     * 旧版只分了 codex 与“其它”：`else` 那一支按 MCP 的 JSON 形状查 `mcpServers.aura`。
     * 而 dsh 注册的是 **YAML patch**（`- insert: ... name: '<路径>'`），它里面永远没有 `mcpServers`，
     * 于是 dsh 这一项**必然**被判成“不对劲”并计进 problems——即“全新安装、体检结论却不是全部正常”。
     * 这是实测出来的（临时 home 装完带 `--agents dsh` 跑 `--doctor`，报的就是这句）。
     *
     * 判据改成“**它指向的模块是不是本安装目录里的**”这个统一问题，各 agent 用各自的形式回答它：
     *   · codex  —— TOML 表 + 本安装目录的 MCP 路径
     *   · dsh    —— patch 里的两个工具行指向本安装目录里的两个 `index.js`
     *   · 其余（claude / cursor）—— `mcpServers.aura` 等于本安装目录的条目
     */
    const dshTargets = [path.join(installDir, 'aura-read/index.js'), path.join(installDir, 'aura-edit/index.js')]
    const mine =
      item.agent === 'codex'
        ? text.includes(`[${CODEX_TABLE}]`) && text.includes(JSON.stringify(path.join(installDir, 'bin/aura-mcp.mjs')))
        : item.agent === 'dsh'
          ? text.includes('tool-aura-read') && text.includes('tool-aura-edit') && dshTargets.every((t) => text.includes(t))
          : JSON.stringify(readJsonOrNull(item.file)?.mcpServers?.aura) === JSON.stringify(jsonEntry(installDir))
    say(`注册      : ${item.agent} ${mine ? '正常' : '不对劲'}（${item.file}）`)
    if (!mine) problems.push(`${item.agent} 的注册项指向的不是本安装目录：${item.file}`)
  }

  /**
   * profile 那一侧的独立安装。紧跟在注册检查之后是有意的：
   * 注册检查回答“本安装写进去的那两行对不对”，这一条回答“**还有没有别的行**”。
   */
  const elsewhere = profileAuraFindings(opts.home, installed)
  if (elsewhere.findings.length === 0) {
    say(`其它安装  : 看了 ${elsewhere.looked.length} 处（${elsewhere.looked.join('、')}），没有第二份 ${PKG_NAME}`)
  } else {
    for (const finding of elsewhere.findings) {
      say(`其它安装  : ${finding}`)
      problems.push(`profile 那一侧还有一份 ${PKG_NAME}：${finding}`)
    }
  }

  const test = info === null ? { cli: 'skipped', mcp: 'skipped', serverInfo: { name: null, version: null } } : selftest(installDir, say, paths.cacheDir)
  if (test.cli !== 'ok') problems.push(`CLI 自检不过：${test.cli}`)
  if (!String(test.mcp).startsWith('ok')) problems.push(`MCP 自检不过：${test.mcp}`)
  // 三面版本：握手里的 serverInfo.version 才是"正在应答的那个进程"的版本，拿它跟磁盘比
  const surfaces = surfaceReport(installed, test, paths)
  say(`三面版本  : ${surfacesLine(surfaces)}`)
  if (typeof test.serverInfo?.version === 'string' && test.serverInfo.version !== installed) {
    problems.push(`MCP 握手自报的版本是 ${test.serverInfo.version}，磁盘上是 ${String(installed)} —— 这个进程跑的不是磁盘上那一份`)
  }
  if (!surfaces.dsh.reachable) {
    problems.push(`DSH 补丁指向的模块在安装目录里找不到：${surfaces.dsh.patch.filter((file) => !fs.existsSync(file)).join('、')}`)
  }
  // “文件在”与“能加载”是两种不同的病。只报前一种，后一种会带着“全部正常”出门。
  if (surfaces.dsh.reachable && !surfaces.dsh.loadable) {
    const why = surfaces.dsh.loadDetail
      .filter((d) => !d.ok)
      .map((d) => `${path.basename(path.dirname(d.file))}: ${d.detail}`)
      .join('；')
    problems.push(
      `DSH 插件**加载不了**（文件在，但 import 失败）：${why}。最常见的原因是缺宿主 peer——` +
        `把 dsh 自带的 @deepseek-ai/{schemastery,dsh-tools} junction 到 ${path.join(paths.prefix, 'node_modules', '@deepseek-ai')} 即可（现在重跑安装器会自动接）`,
    )
  }
  if (surfaces.dsh.loadable) say('DSH 加载  : 两个插件都能 import（重启后可用）')
  if (state?.lastFailure !== undefined) {
    say(`上次失败  : 升到 ${state.lastFailure.attempted ?? '(未知)'} 时 ${state.lastFailure.reason ?? '(没记原因)'}；坏掉的那份在 ${state.lastFailure.parked ?? '(已清)'}`)
  }

  // 观测缓存不可写会让新鲜度闸门降级（回执里带 unverified_region），所以体检要查它
  try {
    fs.mkdirSync(paths.cacheDir, { recursive: true })
    const probe = path.join(paths.cacheDir, '.doctor-probe')
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe, { force: true })
    say(`缓存      : 可写（${paths.cacheDir}）`)
  } catch (error) {
    problems.push(`缓存目录不可写：${String(error?.message ?? error)}`)
  }

  say(`命令      : ${binDir}`)
  for (const [name, when] of SURFACES) say(`  · ${name}：${when}`)
  for (const problem of problems) problemsText.push(problem)
  say(problems.length === 0 ? '体检结论  : 全部正常' : `体检结论  : ${problems.length} 项需要处理`)

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: problems.length === 0, version: installed, buildStamp: info?.buildStamp ?? null, treeHash: info?.treeHash ?? null, previousVersion: state?.previousVersion ?? null, surfaces, problems, recovery, notes: lines }, null, 2)}\n`,
    )
  } else {
    process.stdout.write(`aura-basetools 体检\n`)
    for (const line of lines) process.stdout.write(`  ${line}\n`)
    for (const problem of problemsText) process.stdout.write(`  ⚠️  ${problem}\n`)
  }
  return problems.length === 0 ? 0 : 2
}

function uninstall(opts, paths) {
  const { installDir, binDir, statePath, lines, log } = paths
  const state = fs.existsSync(statePath) ? readJson(statePath) : null
  const registrations = state?.registrations ?? []
  // 只撤“我们写的”：'added' 本次写入；'present' 已存在且内容就是本安装器那份；
  // 'foreign' 是别人配置里本来就有同名项 —— 卸载时留着并说明，宁可不删也不误删
  const ours = registrations.filter((item) => item.action === 'added' || item.action === 'present')
  const foreign = registrations.filter((item) => item.action === 'foreign')
  const touched = []
  for (const item of ours) {
    if (!fs.existsSync(item.file)) continue
    const action = item.agent === 'codex' ? unregisterCodex(item.file) : unregisterJson(item.file)
    touched.push(`${item.agent}:${action}`)
  }
  // 没有状态文件时，按各家常见路径再清一遍，但要求内容确实指向本安装目录
  if (state === null) {
    const codex = path.join(opts.home, '.codex', 'config.toml')
    const mineMcp = JSON.stringify(path.join(installDir, 'bin/aura-mcp.mjs'))
    const codexText = fs.existsSync(codex) ? fs.readFileSync(codex, 'utf8') : ''
    if (codexText.includes(`[${CODEX_TABLE}]`) && codexText.includes(mineMcp)) {
      touched.push(`codex:${unregisterCodex(codex)}`)
    }
    for (const [agent, file] of [
      ['claude', path.join(opts.home, '.claude.json')],
      ['cursor', path.join(opts.home, '.cursor', 'mcp.json')],
    ]) {
      if (!fs.existsSync(file)) continue
      const config = readJsonOrNull(file)
      if (config !== null && JSON.stringify(config.mcpServers?.aura) === JSON.stringify(jsonEntry(installDir))) {
        touched.push(`${agent}:${unregisterJson(file)}`)
      }
    }
  }
  for (const item of foreign) log(`保留      : ${item.agent} 里那个 aura 项不是本安装器写的（${item.file}），没动它`)
  log(`撤销注册  : ${touched.length > 0 ? touched.join('、') : '(没有它加过的项)'}`)
  if (fs.existsSync(installDir)) {
    if (!opts.dryRun) fs.rmSync(path.dirname(installDir), { recursive: true, force: true })
    log(`删除安装  : ${path.dirname(installDir)}`)
  }
  if (!opts.dryRun && fs.existsSync(statePath)) fs.rmSync(statePath, { force: true })
  // previous/、staging/ 与 journal 也是本安装器自己的东西：不一起删干净，
  // 用户以为卸完了，其实还占着几十 MB，下次 "重装" 还可能被旧残局影响
  for (const dir of [paths.staging, path.dirname(paths.previous)]) {
    if (!fs.existsSync(dir)) continue
    if (!opts.dryRun) fs.rmSync(dir, { recursive: true, force: true })
    log(`清理      : ${dir}`)
  }
  if (!opts.dryRun) fs.rmSync(paths.journalPath, { force: true })
  if (!opts.dryRun && fs.existsSync(binDir) && fs.readdirSync(binDir).length === 0) fs.rmSync(binDir, { recursive: true, force: true })
  if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, uninstalled: true, touched, notes: lines }, null, 2)}\n`)
  else {
    process.stdout.write(`aura-basetools 卸载${opts.dryRun ? '预演' : ''}\n`)
    for (const line of lines) process.stdout.write(`  ${line}\n`)
    process.stdout.write('\n备份文件（*.bak-aura-*）保留着，确认没问题可以自己删。\n')
  }
  return 0
}

// ── ⑤ 服务化升级：staging → 预检 → 原子换名 → 终检 → 失败自动回滚（§4.2） ──────
//
// 为什么是这一套：注册进各家客户端的路径是**稳定路径**（node_modules/aura-basetools/...），
// 升级只换这个目录的内容，配置一个字节都不用改；而换目录用同盘 rename（一次系统调用、原子），
// 所以任何时刻磁盘上要么是完整旧版、要么是完整新版，不会出现"写了一半"的中间态。
// 代价要说清楚：rename 要求目标为空，所以两次 rename 之间现网目录会缺席一瞬——
// 文件系统没有"原子对调两个目录"这回事，能做的是把这一瞬缩到最短，并在此之前把
// journal 落盘：doctor 见到 journal 就知道上次死在哪一步、下一步该敲哪条命令。

/** 升级要动的全部路径。所有写入都必须落在这几处之内 —— --prefix 之外一个字节不碰。 */
function layout(opts) {
  const prefix = opts.prefix ?? path.join(opts.home, '.aura', 'pkg')
  return {
    prefix,
    installDir: path.join(prefix, 'node_modules', PKG_NAME),
    binDir: path.join(prefix, 'bin'),
    staging: path.join(prefix, 'staging'),
    stagingPkg: path.join(prefix, 'staging', PKG_NAME),
    previous: path.join(prefix, 'previous', PKG_NAME),
    statePath: path.join(prefix, 'install.json'),
    journalPath: path.join(prefix, 'upgrade-journal.json'),
    cacheDir: path.join(prefix, '.cache'),
  }
}

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/**
 * 产物树整体哈希：只从 `files` 推出来，所以"逐文件清单"与"整体哈希"永远不会互相打架。
 * 为什么需要它：版本号不足以标识产物 —— 同一个 0.4.1 下可以躺着两份不同字节的包。
 */
const treeDigest = (files) =>
  crypto
    .createHash('sha256')
    .update(Object.keys(files).sort().map((name) => `${name}\0${files[name]}\n`).join(''))
    .digest('hex')

/** 构建戳 = 版本 + 树哈希前 12 位：人一眼能读，又能区分"同版不同字节"。 */
const buildStampOf = (version, treeHash) => `${version}+${treeHash.slice(0, 12)}`

/** 认"是不是我们的包"看 package.json 的 name，不看目录名 —— 别人塞的东西不许当我们的包。 */
function pkgAt(dir) {
  const file = path.join(dir, 'package.json')
  if (!fs.existsSync(file)) return null
  const manifest = readJsonOrNull(file)
  if (manifest?.name !== PKG_NAME || typeof manifest.version !== 'string') return null
  return { dir, version: manifest.version }
}

/** 目录 → { version, files, treeHash, buildStamp }；不是我们的包就给 null。 */
function treeInfo(dir) {
  const pkg = pkgAt(dir)
  if (pkg === null) return null
  const files = hashTree(dir)
  const treeHash = treeDigest(files)
  return { version: pkg.version, files, treeHash, buildStamp: buildStampOf(pkg.version, treeHash) }
}

/** 来源描述：目录来源没有归档字节，sha256 就记 null（不编一个假值进去）。 */
function describePayload(label, localFile) {
  if (fs.statSync(localFile).isDirectory()) return { source: `dir:${label}`, sha256: null, kind: 'dir' }
  const lower = localFile.toLowerCase()
  const kind = lower.endsWith('.zip') ? 'zip' : lower.endsWith('.tgz') || lower.endsWith('.tar.gz') ? 'tgz' : 'file'
  return { source: `${/^https?:\/\//.test(label) ? 'url' : 'file'}:${label}`, sha256: sha256File(localFile), kind }
}

/**
 * **profile 那一侧有没有第二份 aura-basetools**。
 *
 * 这不是假想的病。本机 `~/.dsh/profiles/auratest` 就这么活了 **8 天**：9/21 建的实验 profile，
 * 依赖 `dist/aura-tools/aura-tools-0.2.1.tgz`（那个 dist 目录后来整个没了），而
 * `dsh --profile auratest` **真的会**加载那份 0.2.1 的 `aura_read` / `aura_edit`。
 * 与此同时三面版本、完整性、注册项、CLI/MCP 自检、全部测试**都是绿的**——
 * 因为那些判据都只看得见**本安装目录**，没有任何一条会往 profile 那一侧看一眼。
 *
 * 两条判据，都是问题（fail-closed）：
 *   · 声明了却没有载荷，或声明的 `file:` 包体已不存在 ⇒ 那个 profile 现在起不来 / 补不回来；
 *   · 载荷在、但版本与本安装不同 ⇒ 它是**另一份字节**，安装器永远升级不到它。
 *
 * 稳定路线（profile 的 `cordis.patch.yml` 指向本安装目录）不会在这里报任何东西：
 * 那条路线不在 profile 里放局部的 `node_modules/aura-basetools`，三面本来就是同一份字节。
 *
 * @returns `{ findings, looked }`——`looked` 列出**到底看了哪几处**，
 *   让"查过了、没有"与"根本没查"在输出里能分开（体检里最坏的一种绿是"我压根没看"）。
 */
function profileAuraFindings(home, installed) {
  const root = dshProfilesRoot(home)
  let names = []
  try {
    names = fs.readdirSync(root)
  } catch {
    return { findings: [], looked: [] } // 没有 profiles 目录 = 这台机器没装 dsh，不是问题
  }
  const targets = [{ name: '共享 node_modules', label: 'profiles/node_modules（各 profile 共享的那份）', dir: path.join(root, 'node_modules') }]
  for (const name of names) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    targets.push({ name, label: `profile ${name}`, dir: path.join(root, name) })
  }
  const findings = []
  const looked = []
  for (const { name, label, dir } of targets) {
    looked.push(name)
    const manifest = readJsonOrNull(path.join(dir, 'package.json'))
    const declared =
      manifest !== null &&
      (manifest.dependencies?.[PKG_NAME] !== undefined || (manifest.dsh?.profile?.bundles ?? []).includes(PKG_NAME))
    const armed = readJsonOrNull(path.join(dir, 'node_modules', PKG_NAME, 'package.json'))?.version ?? null
    if (!declared && armed === null) continue
    const spec = manifest?.dependencies?.[PKG_NAME]
    const fileSpec = typeof spec === 'string' && spec.startsWith('file:') ? spec.slice('file:'.length) : null
    if (armed === null) {
      findings.push(`${label} 声明了 ${PKG_NAME} 但没装 —— 那个 profile 现在起不来（补装，或删掉它）`)
    } else if (fileSpec !== null && !fs.existsSync(fileSpec)) {
      findings.push(
        `${label} 自带 ${PKG_NAME} ${armed}，但它声明的包体 ${fileSpec} 已经不存在 —— 补不回来：删掉这个 profile，或把它的 cordis.patch.yml 改指 ${path.join(home, '.aura', 'pkg')}`,
      )
    } else {
      findings.push(`${label} 自带 ${PKG_NAME} ${armed}（本安装是 ${String(installed)}）—— 这是**另一份字节**，安装器升级不到它`)
    }
  }
  return { findings, looked }
}

/** 三面各自的版本与生效时机（§六）。CLI 报磁盘版本；MCP 报握手自报的版本；DSH 只能报"需重启"。 */
function surfaceReport(installed, test, paths) {
  const patch = [path.join(paths.installDir, 'aura-read/index.js'), path.join(paths.installDir, 'aura-edit/index.js')]
  return {
    cli: { version: installed, effective: '立即生效：每次调用读磁盘' },
    mcp: {
      version: installed,
      serverInfo: test?.serverInfo ?? null,
      effective: '新会话生效：服务由客户端按会话启动，正在跑的会话仍是启动时那一版',
    },
    dsh: {
      version: installed,
      effective: '需重启 dsh：宿主启动时导入模块，改文件不热更新',
      patch,
      /**
       * `reachable` 曾经是 `patch.every(fs.existsSync)`——**假绿**。
       *
       * 实测过的反例（也就是它必须改的原因）：宿主 peer 缺失时，两个 `index.js` 确实都在，
       * `existsSync` 全 true，而 DSH 重启后 `import()` 抛 `ERR_MODULE_NOT_FOUND`。
       * 于是安装器报“reachable: true、重启 dsh 生效”，而真实结果是启动报错——
       * 而因为 dsh 只在启动时导入插件模块，这个错要到**重启**才现形。
       * 现在补上 `loadable`：**真 import 一次**（子进程，与安装时共用 `importSmoke`）。
       */
      reachable: patch.every((file) => fs.existsSync(file)),
      loadable: patch.every((file) => fs.existsSync(file) && importSmoke(file).ok),
      loadDetail: patch.map((file) => ({ file, ...importSmoke(file) })),
    },
  }
}

/** 三面的一行话（人看的输出用）。 */
const surfacesLine = (surfaces) =>
  `CLI ${surfaces.cli.version ?? '(缺失)'}（立即生效）；MCP ${surfaces.mcp.serverInfo?.version ?? surfaces.mcp.version ?? '(缺失)'}（新会话生效）；DSH ${surfaces.dsh.version ?? '(缺失)'}（需重启 dsh）`

// —— 故障注入缝（只给 build/upgrade-test.mjs 用；默认无效果，见 USAGE 末尾） ——

const FAULT_STAGES = ['after-staging', 'after-precheck', 'after-backup', 'after-clear', 'after-swap', 'final-check', 'after-rollback-swap']

/**
 * 在指定阶段之后注入故障：默认"立即中止"（等价于此刻被 SIGKILL：本文件全是同步 fs 调用、无 exit 钩子）。
 * 例外的 final-check：不中止而是把刚换上去的那份弄坏，让**终检真的失败**，
 * 从验证"终检失败 → 自动回滚"这条真路径（而不是靠断言假装它会回滚）。
 */
function faultPoint(stage, options = {}) {
  const wanted = process.env.AURA_UPGRADE_FAULT
  if (wanted === undefined || wanted === '') return
  if (!FAULT_STAGES.includes(wanted)) {
    throw new InstallError(`不认识的故障阶段：${wanted}（可选：${FAULT_STAGES.join(' / ')}）`)
  }
  if (wanted !== stage) return
  if (options.corrupt !== undefined) {
    fs.appendFileSync(options.corrupt, "\nthrow new Error('AURA_UPGRADE_FAULT=final-check：故意让终检失败')\n")
    fs.writeSync(2, `故障注入：已按 final-check 弄坏 ${options.corrupt} —— 接下来的终检必须失败\n`)
    return
  }
  const delay = Number.parseInt(process.env.AURA_UPGRADE_FAULT_DELAY_MS ?? '', 10)
  if (Number.isFinite(delay) && delay > 0) {
    // 同步等待，给测试留一个"从外面真杀进程"的窗口（Atomics.wait 在主线程可用）
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
  }
  // 回执要写出来再死：--json 的调用方（探针）靠它区分"中止"与"没实现/未知参数"。
  // 用 writeSync 而不是 process.stdout.write：后者可能还在管道缓冲里，process.exit 会把它们丢掉。
  if (jsonMode) {
    fs.writeSync(1, `${JSON.stringify({ ok: false, command: 'upgrade', aborted: true, fault: stage, note: `故障注入：在 ${stage} 之后立即中止（AURA_UPGRADE_FAULT）；此刻的磁盘状态就是要断言的对象` }, null, 2)}\n`)
  }
  fs.writeSync(2, `故障注入：在 ${stage} 之后立即中止（AURA_UPGRADE_FAULT）—— 此刻的磁盘状态就是要断言的对象\n`)
  process.exit(7)
}

// —— journal："上次走到哪一步"的唯一依据 ——

/**
 * 为什么不让 install.json 兼做 journal：install.json 描述的是**已经装好的那一份**，
 * 换名中间它本来就是过时的；两件事塞一个文件，人就分不清"记录"与"意图"了。
 * 先写临时文件再 rename，读者不会看到半截 JSON。
 */
function writeJournal(paths, journal) {
  fs.mkdirSync(paths.prefix, { recursive: true })
  const tmp = `${paths.journalPath}.aura-tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...journal }, null, 2)}\n`)
  fs.renameSync(tmp, paths.journalPath)
}

const readJournal = (paths) => readJsonOrNull(paths.journalPath)
const clearJournal = (paths) => fs.rmSync(paths.journalPath, { force: true })

/**
 * 只读地回答"上次升级留下了什么局面"（doctor 与 reconcile 共用一套判据）：
 *   intact  —— 现网是完整旧版，换名还没发生
 *   pending —— 换名已完成，只差终检/状态（磁盘已是完整新版）
 *   gap     —— 现网目录缺席、previous/ 里是完整旧版（换名中间被打断）
 *   unknown —— journal 与磁盘对不上（两份都不是记录的哪一份）
 */
function journalState(paths, journal) {
  if (journal === null) return null
  const live = treeInfo(paths.installDir)
  const previous = pkgAt(paths.previous)
  const from = journal.from ?? {}
  const to = journal.to ?? {}
  const source = journal.source ?? '<来源>'
  if (live !== null && to.treeHash !== undefined && live.treeHash === to.treeHash) {
    return {
      kind: 'pending',
      text: `上次升级在「${journal.phase}」阶段后中断：现网已是完整的 ${live.version}（换名完成，只差终检与状态落盘）`,
      next: `node install.mjs --upgrade --from ${source}（收尾）或 --rollback（退回 ${from.version ?? '旧版'}）`,
    }
  }
  if (live !== null && from.treeHash !== undefined && live.treeHash === from.treeHash) {
    return {
      kind: 'intact',
      text: `上次升级在「${journal.phase}」阶段后中断：现网仍是完整的 ${live.version}（换名没发生）`,
      next: `重跑 node install.mjs --upgrade --from ${source}`,
    }
  }
  if (live === null && previous !== null) {
    return {
      kind: 'gap',
      text: `上次升级在换名中间被打断：现网目录缺席，previous/ 里是完整的 ${previous.version}`,
      next: 'node install.mjs --rollback（一步恢复现网）',
    }
  }
  return {
    kind: 'unknown',
    text: `上次升级留下 journal（阶段 ${journal.phase}），但现网与 previous/ 都对不上记录`,
    next: `人工看一眼 ${paths.prefix}：要么 node install.mjs --uninstall 重装，要么把完整包体放好再 --upgrade --from <来源>`,
  }
}

/**
 * staging 是落脚点：用完就收。只在**空**的时候删 —— 里面有 failed-* 时那是排查证据，不能顺手清了。
 */
function cleanStaging(paths) {
  if (!fs.existsSync(paths.staging)) return
  if (fs.readdirSync(paths.staging).length === 0) fs.rmSync(paths.staging, { recursive: true, force: true })
}

/** 给 staging 里的临时停靠目录起个不撞的名字（同一秒内可能连换两次）。 */
const parkName = (label) => `${label}-${stamp()}-${crypto.randomBytes(3).toString('hex')}`

/** 状态文件：先写临时文件再 rename —— doctor/--version 永远读不到半截 JSON。 */
function saveState(opts, paths, state) {
  if (opts.dryRun) return
  fs.mkdirSync(paths.prefix, { recursive: true })
  const tmp = `${paths.statePath}.aura-tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  fs.renameSync(tmp, paths.statePath)
}

/**
 * install.json 的唯一构造点（§4.4）。registrations 必须**沿用**它自己写过的那份：
 * 不同步过来的话，升级一次就再也卸不干净了（卸载依据就在这个字段里）。
 */
function buildState(paths, info, fields) {
  const state = {
    version: info.version,
    installedAt: fields.installedAt,
    previousVersion: fields.previousVersion ?? null,
    installDir: paths.installDir,
    binDir: paths.binDir,
    payload: fields.payload,
    files: info.files,
    treeHash: info.treeHash,
    buildStamp: info.buildStamp,
    registrations: fields.registrations ?? [],
    surfaces: surfaceReport(info.version, null, paths),
  }
  if (fields.upgradedAt !== undefined) state.upgradedAt = fields.upgradedAt
  if (fields.rolledBackAt !== undefined) state.rolledBackAt = fields.rolledBackAt
  if (fields.lastFailure !== undefined) state.lastFailure = fields.lastFailure
  return state
}

/**
 * 升级/回滚开工前先收拾上次的残局（doctor 是只读的，所以自愈只发生在这里）。
 * 返回 null 表示没有残局，否则返回"收拾成了什么样"。
 */
function reconcile(opts, paths, log) {
  const journal = readJournal(paths)
  if (journal === null) return null
  if (opts.dryRun) {
    log(`注意      : 上次升级留下 journal（阶段 ${journal.phase}）；--dry-run 不动它，真跑时会先收拾`)
    return null
  }
  const state = journalState(paths, journal)
  log(`收拾      : ${state.text}`)
  if (state.kind === 'pending') {
    const live = treeInfo(paths.installDir)
    const test = selftest(paths.installDir, log, paths.cacheDir)
    if (!(test.cli === 'ok' && String(test.mcp).startsWith('ok'))) return 'broken'
    const old = readJsonOrNull(paths.statePath)
    saveState(opts, paths, buildState(paths, live, {
      installedAt: old?.installedAt ?? new Date().toISOString(),
      previousVersion: journal.from?.version ?? old?.previousVersion ?? null,
      payload: journal.payload ?? old?.payload ?? { source: 'unknown', sha256: null, kind: 'unknown' },
      registrations: old?.registrations ?? [],
      upgradedAt: new Date().toISOString(),
    }))
    clearJournal(paths)
    log(`已收尾    : 状态文件补写成 ${live.version}（终检过了）`)
    return 'finished'
  }
  if (state.kind === 'intact') {
    clearJournal(paths)
    return 'intact'
  }
  if (state.kind === 'gap') {
    fs.mkdirSync(path.dirname(paths.installDir), { recursive: true })
    fs.renameSync(paths.previous, paths.installDir)
    clearJournal(paths)
    log('已恢复    : previous/ 已换回现网')
    return 'restored'
  }
  throw new Rejected('UPGRADE_JOURNAL_UNKNOWN', `${state.text}；${state.next}`, rejectDetail('reconcile', null, null, true, { journal }))
}

// —— 清单（§4.5）：本地文件与 URL 行为完全一样；只有显式给了 URL 才联网 ——

/**
 * 读清单。返回里带 `file`（本地路径）与 `url`（远程清单的原始 URL）——
 * 因为清单里的**相对 url** 要相对"清单自己"解析：本地清单相对清单文件所在目录，
 * 远程清单相对清单 URL（RFC 惯例）。不这样做的话，内网"zip 与清单放一起"就不是可预期的行为。
 */
async function loadManifest(source, scratchDir) {
  if (/^https?:\/\//.test(source)) {
    let file = null
    try {
      file = await download(source, path.join(scratchDir, 'manifest'))
    } catch (error) {
      // 只有显式给了 URL 才会走到这里（默认不联网），所以失败就说清楚"是这次联网没成"
      throw new Rejected('MANIFEST_REJECTED', `清单下载失败（${String(error?.message ?? error)}）：${source}`, rejectDetail('manifest', null, null, true, { manifest: source }))
    }
    return { json: readJson(file), file, url: source, network: true }
  }
  if (!fs.existsSync(source)) {
    throw new Rejected('MANIFEST_REJECTED', `清单不存在：${source}`, rejectDetail('manifest', null, null, true, { manifest: source }))
  }
  try {
    // url 显式记 null（本地清单没有"自己的 URL"）：调用点靠它选相对 url 的基准，
    // 留成 undefined 会让 `loaded.url !== null` 误判成"远程清单"
    return { json: readJson(source), file: path.resolve(source), url: null, network: false }
  } catch (error) {
    throw new Rejected('MANIFEST_REJECTED', `清单不是合法 JSON（${String(error?.message ?? error)}）：${source}`, rejectDetail('manifest', null, null, true, { manifest: source }))
  }
}

function pickChannel(manifest, source, channel) {
  const bad = (reason, extra = {}) => new Rejected('MANIFEST_REJECTED', reason, rejectDetail('manifest', null, null, true, { manifest: source, ...extra }))
  if (manifest?.tool !== PKG_NAME) throw bad(`清单不是 ${PKG_NAME} 的（tool=${JSON.stringify(manifest?.tool)}）：${source}`)
  const channels = manifest?.channels ?? {}
  const entry = channels[channel]
  if (entry === undefined) throw bad(`清单里没有渠道 ${channel}（有：${Object.keys(channels).join(',') || '(一个都没有)'}）：${source}`)
  if (typeof entry.version !== 'string' || entry.version === '') throw bad(`渠道 ${channel} 的清单缺 version：${JSON.stringify(entry)}`)
  return entry
}

/** 只做升级判断需要的比较：数字段逐段比，带预发布（-beta.1）的算更小。不做完整 semver。 */
function compareVersions(left, right) {
  const parse = (value) => {
    const [core, pre = ''] = String(value).split('-', 2)
    return { nums: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre }
  }
  const a = parse(left)
  const b = parse(right)
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i += 1) {
    const diff = (a.nums[i] ?? 0) - (b.nums[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  if (a.pre === b.pre) return 0
  if (a.pre === '') return 1
  if (b.pre === '') return -1
  return a.pre < b.pre ? -1 : 1
}

/**
 * 解析包体来源：--from 给包体，--manifest 给 sha256 与"可用版本"（离线时是本地文件）。
 * 两者同时给：包体听 --from、字节听清单 —— 这才是"先校验再动手"的意义。
 */
async function resolveUpgradeSource(opts, paths, log) {
  const notes = { manifest: null, expectedSha: null, network: false }
  let source = opts.from
  if (opts.manifest !== null) {
    const loaded = await loadManifest(opts.manifest, paths.staging)
    const entry = pickChannel(loaded.json, opts.manifest, opts.channel)
    notes.network = loaded.network
    notes.expectedSha = typeof entry.sha256 === 'string' && entry.sha256 !== '' ? entry.sha256.toLowerCase() : null
    notes.manifest = { source: opts.manifest, channel: opts.channel, version: entry.version, minNode: entry.minNode ?? null }
    log(
      `清单      : ${opts.manifest}（渠道 ${opts.channel} → ${entry.version}${notes.expectedSha === null ? '，没给 sha256' : `，sha256 ${notes.expectedSha.slice(0, 16)}…`}）`,
    )
    if (entry.minNode !== undefined && Number.parseInt(process.versions.node, 10) < Number.parseInt(entry.minNode, 10)) {
      throw new Rejected(
        'UPGRADE_MIN_NODE',
        `清单要求 Node ≥${entry.minNode}，当前是 ${process.versions.node}`,
        rejectDetail('manifest', pkgAt(paths.installDir)?.version ?? null, entry.version, true, { minNode: entry.minNode, node: process.versions.node }),
      )
    }
    if (source === null) {
      if (typeof entry.url !== 'string' || entry.url === '') {
        throw new Rejected(
          'MANIFEST_REJECTED',
          `渠道 ${opts.channel} 的清单里没有 url，也没给 --from：无从知道去哪拿包体`,
          rejectDetail('manifest', pkgAt(paths.installDir)?.version ?? null, entry.version, true, { manifest: opts.manifest }),
        )
      }
      // 相对 url 的基准写死在这里，不靠猜：远程清单 → 相对清单 URL；本地清单 → 相对清单文件所在目录
      if (/^https?:\/\//.test(entry.url) || path.isAbsolute(entry.url)) source = entry.url
      else if (loaded.url !== null) source = new URL(entry.url, loaded.url).href
      else source = path.resolve(path.dirname(loaded.file), entry.url)
      log(`来源      : 清单里的 ${entry.url} → ${source}`)
    }
  }
  if (source === null) throw new UsageError('--upgrade 要指定来源：--from <本地目录|.tgz|.zip|URL> 或 --manifest <清单>')
  const label = source
  if (/^https?:\/\//.test(source)) {
    notes.network = true
    if (opts.dryRun) return { source: null, label, notes }
    source = await download(source, path.join(paths.staging, 'download'))
    log(`下载      : 已取回 ${source}`)
  }
  if (!fs.existsSync(source)) {
    throw new Rejected('PAYLOAD_MISSING', `包体不存在：${source}`, rejectDetail('resolve', pkgAt(paths.installDir)?.version ?? null, notes.manifest?.version ?? null, true, { source }))
  }
  if (notes.expectedSha !== null) {
    if (fs.statSync(source).isDirectory()) {
      log('校验      : 包体是目录，清单里的 sha256 只对归档有意义 —— 跳过字节校验，改用版本 + 树哈希比对')
    } else {
      const actual = sha256File(source)
      if (actual !== notes.expectedSha) {
        throw new Rejected(
          'UPGRADE_SHA256_MISMATCH',
          `校验不过：期望 sha256 ${notes.expectedSha}，实际 ${actual}（${source}）—— 现网未动`,
          rejectDetail('verify', pkgAt(paths.installDir)?.version ?? null, notes.manifest?.version ?? null, true, { expected: notes.expectedSha, actual, source }),
        )
      }
      log(`校验      : sha256 一致（${actual.slice(0, 16)}…）`)
    }
  }
  return { source, label, notes }
}

/** 新命令的统一回执：`--json` 给机器，否则先标题再逐行（每一步先打印再执行）。 */
function emit(opts, { title, lines, json, code = 0 }) {
  if (opts.json) process.stdout.write(`${JSON.stringify(json, null, 2)}\n`)
  else {
    process.stdout.write(`${title}\n`)
    for (const line of lines) process.stdout.write(`  ${line}\n`)
  }
  return code
}

// —— --check / --upgrade / --rollback ——

/** `--check`：只比版本。没给清单就什么都不联网，并如实说"为什么这次不回答有没有新版"。 */
async function checkUpdate(opts, paths) {
  const info = fs.existsSync(paths.installDir) ? treeInfo(paths.installDir) : null
  const state = readJsonOrNull(paths.statePath)
  const current = info === null ? null : { version: info.version, treeHash: info.treeHash, buildStamp: info.buildStamp, installedAt: state?.installedAt ?? null }
  const base = { ok: true, command: 'check', current, channel: opts.channel, available: null, upgrade: null, network: false }
  const lines = [`当前      : ${current === null ? '(没装)' : `${current.version}（构建戳 ${current.buildStamp}）`}`]
  if (opts.manifest === null) {
    lines.push(
      '清单      : (没给)',
      '结论      : 默认不联网，所以"有没有新版"这次不回答 —— 要查就给 --manifest <本地文件|URL> 或 --check-url <URL>',
    )
    return emit(opts, {
      title: 'aura-basetools 检查更新',
      lines,
      json: { ...base, note: '没给清单：默认不联网。要检查更新就给 --manifest <本地文件|URL> 或 --check-url <URL>', notes: lines },
      code: 0,
    })
  }
  const loaded = await loadManifest(opts.manifest, paths.staging)
  const entry = pickChannel(loaded.json, opts.manifest, opts.channel)
  const cmp = current === null ? null : compareVersions(current.version, entry.version)
  lines.push(
    `当前      : ${current === null ? '(没装)' : `${current.version}（构建戳 ${current.buildStamp}）`}`,
    `渠道      : ${opts.channel}（清单 ${opts.manifest}${loaded.network ? '，这次联网了' : '，本地文件'}）`,
    `可用      : ${entry.version}${entry.minNode === undefined ? '' : `（要求 Node ≥${entry.minNode}）`}${typeof entry.sha256 === 'string' ? `，sha256 ${entry.sha256.slice(0, 16)}…` : '，没给 sha256'}`,
    cmp === null
      ? '是否可升  : 现网还没装 —— 先装一次：node install.mjs --yes'
      : cmp < 0
        ? `是否可升  : 是（现有 ${current.version} → ${entry.version}）`
        : cmp === 0
          ? '是否可升  : 否（版本号相同；同版是否同字节要等包体到手后才能比）'
          : `是否可升  : 否（现网 ${current.version} 比清单里的 ${entry.version} 还新）`,
  )
  return emit(opts, {
    title: 'aura-basetools 检查更新',
    lines,
    json: {
      ...base,
      network: loaded.network,
      available: { version: entry.version, url: entry.url ?? null, sha256: entry.sha256 ?? null, minNode: entry.minNode ?? null },
      upgrade: cmp === null ? null : cmp < 0,
      notes: lines,
    },
    code: 0,
  })
}

/** §4.2 的 1–10 步。每一步先打印再执行；失败分成"用法错/拒绝升级"两类退出码。 */
async function upgrade(opts, paths) {
  const lines = []
  const log = (line) => lines.push(line)
  const existing = fs.existsSync(paths.installDir) ? treeInfo(paths.installDir) : null
  if (existing === null && fs.existsSync(paths.installDir)) {
    throw new Rejected(
      'UPGRADE_LIVE_NOT_OURS',
      `现网目录不是 ${PKG_NAME} 的包（package.json.name 对不上）：${paths.installDir} —— 不硬来；要么先 --uninstall，要么换 --prefix`,
      rejectDetail('resolve', null, null, true, { installDir: paths.installDir }),
    )
  }
  const oldState = readJsonOrNull(paths.statePath)
  const registrations = oldState?.registrations ?? []
  const installedAt = oldState?.installedAt ?? new Date().toISOString()
  reconcile(opts, paths, log)
  const live = fs.existsSync(paths.installDir) ? treeInfo(paths.installDir) : null
  // 1–2 解析来源（有清单就校 sha256）
  const { source, label, notes } = await resolveUpgradeSource(opts, paths, log)
  const payload = describePayload(label, source ?? paths.installDir)
  const step = (index, text) => log(`${String(index).padStart(2, ' ')}. ${text}`)
  if (opts.dryRun) {
    step(1, `来源 : ${label}${notes.network ? '（要联网）' : '（本地，不联网）'}`)
    step(2, `校验 : ${notes.expectedSha === null ? '清单没给 sha256，跳过' : `sha256 ${notes.expectedSha.slice(0, 16)}…`}`)
    step(3, `解包 : → ${paths.stagingPkg}（预演不落盘）`)
    step(4, '预检 : 在 staging 里跑 CLI 取景 + MCP 握手（预演不跑）')
    step(5, `版本 : 现网 ${live?.version ?? '(没装)'} → 包体 ${notes.manifest?.version ?? '(未知，解包后才知道)'}`)
    step(6, `备份 : ${paths.installDir} → ${paths.previous}`)
    step(7, `换名 : ${paths.stagingPkg} → ${paths.installDir}`)
    step(8, '终检 : 在最终位置再跑一次预检')
    step(9, '失败 : 终检不过就自动回滚到 previous/，坏的那份留在 staging/failed-*')
    step(10, '落盘 : 写 install.json（version/treeHash/buildStamp/previousVersion）')
    return emit(opts, {
      title: 'aura-basetools 升级预演',
      lines,
      json: { ok: true, command: 'upgrade', dryRun: true, from: label, current: live?.version ?? null, manifest: notes.manifest, network: notes.network, notes: lines },
      code: 0,
    })
  }
  // 目录来源可以先把"是不是同一份"问清楚：连 staging 都不用落
  if (live !== null && source !== null && fs.statSync(source).isDirectory()) {
    const same = treeInfo(source)
    if (same !== null && same.version === live.version) {
      if (same.treeHash === live.treeHash) {
        log(`已是最新  : ${live.version}（构建戳 ${live.buildStamp}）与来源逐文件一致 —— 没有写盘`)
        return emit(opts, {
          title: 'aura-basetools 升级',
          lines,
          json: { ok: true, command: 'upgrade', upgraded: false, reason: 'up-to-date', version: live.version, treeHash: live.treeHash, buildStamp: live.buildStamp, notes: lines },
          code: 0,
        })
      }
      throw new Rejected(
        'UPGRADE_SAME_VERSION_DIFFERENT_BYTES',
        `同版不同字节：现网 ${live.version}（构建戳 ${live.buildStamp}）与来源（构建戳 ${same.buildStamp}）版本号相同但不是同一份产物 —— 不换（换上去只会让版本号更不可信）；请重装或换一份包体`,
        rejectDetail('version-compare', live.version, same.version, true, { installedTreeHash: live.treeHash, sourceTreeHash: same.treeHash }),
      )
    }
  }
  // 3 解包到 staging：这里是"可随时删"的落脚点，绝不碰现网
  fs.mkdirSync(paths.staging, { recursive: true })
  fs.rmSync(paths.stagingPkg, { recursive: true, force: true })
  try {
    materialize(source, paths.stagingPkg, log)
  } catch (error) {
    // 解不开/不像我们的包（CRC 不过、截断、name 不对）都归这一类：现网没动过，包体留 staging 供排查
    clearJournal(paths)
    if (error instanceof Rejected) throw error
    throw new Rejected(
      'PAYLOAD_REJECTED',
      `包体不可用：${String(error?.message ?? error)}`,
      rejectDetail('staging', live?.version ?? null, notes.manifest?.version ?? null, true, { source: label }),
    )
  }
  const staged = treeInfo(paths.stagingPkg)
  const journalBase = {
    action: 'upgrade',
    source: label,
    payload,
    from: live === null ? null : { version: live.version, treeHash: live.treeHash },
    to: { version: staged.version, treeHash: staged.treeHash },
  }
  writeJournal(paths, { ...journalBase, phase: 'staging' })
  faultPoint('after-staging')
  // 4 预检：在 staging 里跑，现网一个字节都没动
  const pre = selftest(paths.stagingPkg, log, paths.cacheDir)
  if (!(pre.cli === 'ok' && String(pre.mcp).startsWith('ok'))) {
    clearJournal(paths)
    throw new Rejected(
      'UPGRADE_PRECHECK_FAILED',
      `staging 预检不过：CLI ${pre.cli}；MCP ${pre.mcp} —— 现网仍是 ${live?.version ?? '(没有安装)'}，一个字节没动；这份坏包体留在 ${paths.stagingPkg} 供排查`,
      rejectDetail('precheck', live?.version ?? null, staged.version, true, { cli: pre.cli, mcp: pre.mcp, staging: paths.stagingPkg }),
    )
  }
  writeJournal(paths, { ...journalBase, phase: 'prechecked' })
  faultPoint('after-precheck')
  // 5 版本比对：同版本 → 清掉 staging 报"已是最新"（幂等，不写盘）
  if (live !== null && live.version === staged.version) {
    clearJournal(paths)
    fs.rmSync(paths.stagingPkg, { recursive: true, force: true })
    cleanStaging(paths)
    if (live.treeHash !== staged.treeHash) {
      throw new Rejected(
        'UPGRADE_SAME_VERSION_DIFFERENT_BYTES',
        `同版不同字节：现网 ${live.version}（构建戳 ${live.buildStamp}）与包体（构建戳 ${staged.buildStamp}）版本号相同但不是同一份产物 —— 不换；请重装或换一份包体`,
        rejectDetail('version-compare', live.version, staged.version, true, { installedTreeHash: live.treeHash, sourceTreeHash: staged.treeHash }),
      )
    }
    log(`已是最新  : ${live.version}（构建戳 ${live.buildStamp}）—— 没有写盘`)
    return emit(opts, {
      title: 'aura-basetools 升级',
      lines,
      json: { ok: true, command: 'upgrade', upgraded: false, reason: 'up-to-date', version: live.version, treeHash: live.treeHash, buildStamp: live.buildStamp, notes: lines },
      code: 0,
    })
  }
  // 6 备份
  //   为什么不是 rename：rename 一走开现网目录就缺席了，而"备份完、还没换名"这一刻
  //   必须是"完整旧版且现网可用"—— 复制完再动现网，这一刻两边各有一份完整旧版。
  writeJournal(paths, { ...journalBase, phase: 'backup' })
  if (live !== null) {
    try {
      fs.rmSync(paths.previous, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(paths.previous), { recursive: true })
      fs.cpSync(paths.installDir, paths.previous, { recursive: true, filter: (src) => path.basename(src) !== 'node_modules' })
    } catch (error) {
      clearJournal(paths)
      throw new Rejected(
        'UPGRADE_BACKUP_FAILED',
        `备份失败：${paths.installDir} → ${paths.previous}（${String(error?.message ?? error)}）—— 没有备份就不往下走，现网一个字节没动`,
        rejectDetail('backup', live?.version ?? null, staged.version, true, { installDir: paths.installDir }),
      )
    }
  }
  faultPoint('after-backup')
  // 7 换名：先把现网挪到同盘的 staging（rename 原子；被占用就抛错，此刻现网还完整），
  //   再把 staging 里的新版 rename 上来。两次 rename 之间是唯一的"现网缺席"窗口（见本节开头）。
  writeJournal(paths, { ...journalBase, phase: 'swapping' })
  let movedAside = null
  if (live !== null) {
    movedAside = path.join(paths.staging, parkName('moved'))
    fs.mkdirSync(paths.staging, { recursive: true })
    try {
      fs.renameSync(paths.installDir, movedAside)
    } catch (error) {
      // Windows 上目录被占用（正在跑的 MCP 会话 / DSH 宿主加载过里面的模块）会走到这里：
      // 明确报出来 + 保持现网不动，绝不硬来（§4.2 的 Windows 注意、§八的"无提示替换"禁令）
      clearJournal(paths)
      // 这次升级没有发生，所以连刚做的那份备份也撒回：previous/ 的语义是"上一版"，
      // 放一份与现网完全相同的拷贝进去，只会让 --rollback 变成原地打转。
      // 用树哈希而不是版本号对比：同版不同字节的情况不能误删。
      if (live !== null && treeInfo(paths.previous)?.treeHash === live.treeHash) {
        fs.rmSync(paths.previous, { recursive: true, force: true })
      }
      throw new Rejected(
        'UPGRADE_SWAP_OCCUPIED',
        `换名失败：${paths.installDir} 被占用或不可改（${String(error?.message ?? error)}）—— 现网一个字节没动，那份旧版原样可用；把占用它的面让开再试：① 重开 Codex/Claude/Cursor 会话（或退出正在跑的 MCP 服务）；② 重启 dsh 宿主；③ 关掉正在用这套包的终端`,
        rejectDetail('swap', live.version, staged.version, true, { installDir: paths.installDir, error: String(error?.message ?? error) }),
      )
    }
  }
  faultPoint('after-clear')
  fs.mkdirSync(path.dirname(paths.installDir), { recursive: true })
  fs.renameSync(paths.stagingPkg, paths.installDir)
  writeJournal(paths, { ...journalBase, phase: 'swapped' })
  if (movedAside !== null) {
    try {
      fs.rmSync(movedAside, { recursive: true, force: true })
    } catch (error) {
      // 删不掉不影响正确性（previous/ 里已有一份完整旧版），只是 staging 多留一份，如实记一笔
      log(`注意      : 旧的那份没删掉（${String(error?.message ?? error)}），留在 ${movedAside}，下次升级会覆盖`)
    }
  }
  faultPoint('after-swap')
  faultPoint('final-check', { corrupt: path.join(paths.installDir, 'lib', 'ops.mjs') })
  // 8 终检：在**最终位置**再跑一次 4 的两步
  const post = selftest(paths.installDir, log, paths.cacheDir)
  if (post.cli === 'ok' && String(post.mcp).startsWith('ok')) {
    const fresh = treeInfo(paths.installDir)
    saveState(opts, paths, buildState(paths, fresh, {
      installedAt,
      previousVersion: live?.version ?? null,
      payload,
      registrations,
      upgradedAt: new Date().toISOString(),
    }))
    clearJournal(paths)
    cleanStaging(paths)
    log(`完成      : ${live?.version ?? '(没装)'} → ${fresh.version}（构建戳 ${fresh.buildStamp}）`)
    log(`回滚点    : ${paths.previous}（${live?.version ?? '无'}）—— 不满意就 node install.mjs --rollback`)
    return emit(opts, {
      title: 'aura-basetools 升级',
      lines,
      json: {
        ok: true,
        command: 'upgrade',
        upgraded: true,
        from: live?.version ?? null,
        version: fresh.version,
        treeHash: fresh.treeHash,
        buildStamp: fresh.buildStamp,
        previousVersion: live?.version ?? null,
        registrations,
        selftest: post,
        network: notes.network,
        notes: lines,
      },
      code: 0,
    })
  }
  // 9 终检失败 → 自动回滚到 previous（坏的那份挪去 staging/failed-*，不进 previous/）
  const reason = `CLI ${post.cli}；MCP ${post.mcp}`
  const previousPkg = pkgAt(paths.previous)
  const parked = path.join(paths.staging, parkName('failed'))
  if (previousPkg === null) {
    // 首次安装就终检不过：没有可回滚的版本，把坏的那份挪走并如实报两条出路
    fs.mkdirSync(paths.staging, { recursive: true })
    fs.renameSync(paths.installDir, parked)
    clearJournal(paths)
    throw new Rejected(
      'UPGRADE_FINAL_CHECK_FAILED_NO_PREVIOUS',
      `终检不过（${reason}），而且没有 previous/ 可回滚 —— 坏的那份留在 ${parked}；两条出路：① 换一份好包体：node install.mjs --home ${opts.home} --upgrade --from <好包>；② 重装：node install.mjs --home ${opts.home} --yes --from <好包>`,
      rejectDetail('final-check', live?.version ?? null, staged.version, false, { cli: post.cli, mcp: post.mcp, parked, rolledBackTo: null }),
    )
  }
  log(`终检不过  : ${reason} → 自动回滚到 previous/ 的 ${previousPkg.version}`)
  const restored = autoRollback(opts, paths, {
    journalBase: { ...journalBase, phase: 'auto-rollback' },
    label,
    payload,
    reason,
    oldPayload: oldState?.payload ?? { source: `previous/${PKG_NAME}`, sha256: null, kind: 'dir' },
    registrations,
    installedAt,
    log,
  })
  if (!restored.ok) {
    throw new Rejected(
      'UPGRADE_ROLLBACK_FAILED',
      `终检不过（${reason}）→ 已把 previous/ 换回现网，但换回来的那份自检也过不了（CLI ${restored.cli}；MCP ${restored.mcp}）—— 停手，不叠补丁；两条出路：① 重装：node install.mjs --home ${opts.home} --yes --from <完整包体>；② 手工：把 ${restored.parked} 与 ${paths.installDir} 打开看一眼，再把完整包体放回去`,
      rejectDetail('final-check', live?.version ?? null, staged.version, false, { cli: post.cli, mcp: post.mcp, parked: restored.parked, rolledBackTo: previousPkg.version }),
    )
  }
  log(`已回滚    : 现网 = ${restored.version}；坏掉的那份留在 ${restored.parked} 供排查`)
  return emit(opts, {
    title: 'aura-basetools 升级',
    lines,
    json: {
      ok: false,
      command: 'upgrade',
      code: 'UPGRADE_FINAL_CHECK_FAILED_ROLLED_BACK',
      stage: 'final-check',
      from: live?.version ?? null,
      to: staged.version,
      liveUntouched: false,
      upgraded: false,
      rolledBackTo: restored.version,
      reason: `终检失败：${reason}`,
      attempted: staged.version,
      parked: restored.parked,
      selftest: restored.test,
      network: notes.network,
      notes: lines,
    },
    code: 2,
  })
}

/**
 * 终检失败后的自动回滚（§4.2 第 9 步）：坏的那份挪去 staging/failed-*，previous/ 换回现网。
 * 为什么坏的不进 previous/：previous/ 是"可回滚目标"，塞一份坏进去等于给下次回滚埋雷。
 */
function autoRollback(opts, paths, ctx) {
  const broken = treeInfo(paths.installDir)
  const parked = path.join(paths.staging, parkName('failed'))
  const previousInfo = treeInfo(paths.previous)
  writeJournal(paths, {
    ...ctx.journalBase,
    action: 'auto-rollback',
    parked,
    reason: ctx.reason,
    from: broken === null ? null : { version: broken.version, treeHash: broken.treeHash },
    to: previousInfo === null ? null : { version: previousInfo.version, treeHash: previousInfo.treeHash },
  })
  fs.mkdirSync(paths.staging, { recursive: true })
  if (fs.existsSync(paths.installDir)) fs.renameSync(paths.installDir, parked)
  fs.mkdirSync(path.dirname(paths.installDir), { recursive: true })
  fs.renameSync(paths.previous, paths.installDir)
  const test = selftest(paths.installDir, ctx.log, paths.cacheDir)
  const ok = test.cli === 'ok' && String(test.mcp).startsWith('ok')
  if (!ok) return { ok: false, cli: test.cli, mcp: test.mcp, parked }
  const restored = treeInfo(paths.installDir)
  saveState(opts, paths, buildState(paths, restored, {
    installedAt: ctx.installedAt,
    previousVersion: null,
    payload: ctx.oldPayload,
    registrations: ctx.registrations,
    rolledBackAt: new Date().toISOString(),
    lastFailure: {
      at: new Date().toISOString(),
      attempted: broken?.version ?? null,
      reason: ctx.reason,
      source: ctx.label,
      parked,
    },
  }))
  clearJournal(paths)
  return { ok: true, version: restored.version, parked, test }
}

/**
 * 对称换名：现网 ↔ previous/（三步 rename，各自原子，每一步前先落 journal）。
 * 用 staging 当中转是必须的：rename 要求目标为空，两步之间必然有"现网缺席"的一瞬，
 * 这一瞬无法消除，只能留证据 + 让 --rollback / doctor 能接着收拾。
 */
function swapWithPrevious(paths, journalBase) {
  const park = path.join(paths.staging, parkName('swap'))
  const hasLive = fs.existsSync(paths.installDir)
  if (hasLive) {
    fs.mkdirSync(paths.staging, { recursive: true })
    writeJournal(paths, { ...journalBase, phase: 'rollback-parked' })
    fs.renameSync(paths.installDir, park)
  }
  writeJournal(paths, { ...journalBase, phase: 'rollback-incoming' })
  fs.mkdirSync(path.dirname(paths.installDir), { recursive: true })
  fs.renameSync(paths.previous, paths.installDir)
  if (hasLive) {
    writeJournal(paths, { ...journalBase, phase: 'rollback-outgoing' })
    fs.renameSync(park, paths.previous)
  }
  writeJournal(paths, { ...journalBase, phase: 'rolled-back' })
}

/** `--rollback`：把 previous/ 换回现网。仍然先预检 —— 不把坏的那份换上来。 */
async function rollback(opts, paths) {
  const lines = []
  const log = (line) => lines.push(line)
  const oldState = readJsonOrNull(paths.statePath)
  const registrations = oldState?.registrations ?? []
  const installedAt = oldState?.installedAt ?? new Date().toISOString()
  const reconciled = reconcile(opts, paths, log)
  const current = fs.existsSync(paths.installDir) ? treeInfo(paths.installDir) : null
  const previous = pkgAt(paths.previous)
  const twoWays =
    `① 用旧包体升级回去：node install.mjs --home ${opts.home} --upgrade --from <旧包体>；` +
    `② 重装：node install.mjs --home ${opts.home} --yes --from <完整包体>`
  // 上一行的 reconcile 可能已经把这次请求做完了（换名中间被打断的那种残局：previous/ 换回现网），
  // 那就报到手的结果，而不是报"没有可回滚的版本"—— 用户要的恢复已经发生了
  if (reconciled === 'restored' && previous === null) {
    log(`已恢复    : 现网 = ${current?.version ?? '(缺失)'}（上次升级的残局已收拾，previous/ 已用掉）`)
    return emit(opts, {
      title: 'aura-basetools 回滚',
      lines,
      json: { ok: true, command: 'rollback', reconciled, version: current?.version ?? null, previousVersion: null, notes: lines },
      code: 0,
    })
  }
  if (previous === null) {
    throw new Rejected(
      'ROLLBACK_NO_PREVIOUS',
      `previous/ 里没有可回滚的版本（${paths.previous} 不存在或不是 ${PKG_NAME}）；${twoWays}`,
      rejectDetail('rollback-resolve', current?.version ?? null, null, true, { previousVersion: null }),
    )
  }
  const previousInfo = treeInfo(paths.previous)
  log(`现网      : ${current === null ? '(目录缺席)' : `${current.version}（构建戳 ${current.buildStamp}）`}`)
  log(`回滚目标  : ${previousInfo.version}（构建戳 ${previousInfo.buildStamp}，${paths.previous}）`)
  if (opts.dryRun) {
    log('预演      : 先预检 previous/，再现网 ↔ previous/ 对调（三步 rename），最后在现网跑一次终检')
    return emit(opts, {
      title: 'aura-basetools 回滚预演',
      lines,
      json: { ok: true, command: 'rollback', dryRun: true, current: current?.version ?? null, rollbackTo: previousInfo.version, notes: lines },
      code: 0,
    })
  }
  const pre = selftest(paths.previous, log, paths.cacheDir)
  if (!(pre.cli === 'ok' && String(pre.mcp).startsWith('ok'))) {
    throw new Rejected(
      'ROLLBACK_PREVIOUS_UNUSABLE',
      `previous/ 里的 ${previousInfo.version} 自检不过：CLI ${pre.cli}；MCP ${pre.mcp} —— 不换（换上去等于把坏的那份推到现网）；${twoWays}`,
      rejectDetail('rollback-precheck', current?.version ?? null, previousInfo.version, true, { cli: pre.cli, mcp: pre.mcp }),
    )
  }
  const journalBase = {
    action: 'rollback',
    source: paths.previous,
    from: current === null ? null : { version: current.version, treeHash: current.treeHash },
    to: { version: previousInfo.version, treeHash: previousInfo.treeHash },
  }
  swapWithPrevious(paths, journalBase)
  faultPoint('after-rollback-swap')
  const post = selftest(paths.installDir, log, paths.cacheDir)
  if (!(post.cli === 'ok' && String(post.mcp).startsWith('ok'))) {
    // 回滚后的终检也不过：把两边换回去，停手报清楚（不叠补丁）
    swapWithPrevious(paths, { ...journalBase, action: 'rollback-undo' })
    clearJournal(paths)
    throw new Rejected(
      'ROLLBACK_FINAL_CHECK_FAILED',
      `回滚后终检不过（CLI ${post.cli}；MCP ${post.mcp}）—— 已把 ${current?.version ?? '原现网'} 换回现网；${twoWays}`,
      rejectDetail('rollback-final-check', current?.version ?? null, previousInfo.version, false, { cli: post.cli, mcp: post.mcp }),
    )
  }
  const restored = treeInfo(paths.installDir)
  const nowInstalled = pkgAt(paths.previous)
  saveState(opts, paths, buildState(paths, restored, {
    installedAt,
    previousVersion: nowInstalled?.version ?? null,
    payload: oldState?.payload ?? { source: `previous/${PKG_NAME}`, sha256: null, kind: 'dir' },
    registrations,
    rolledBackAt: new Date().toISOString(),
  }))
  clearJournal(paths)
  log(`已回滚    : 现网 = ${restored.version}（构建戳 ${restored.buildStamp}）`)
  log(`再回滚    : previous/ 里现在是 ${nowInstalled?.version ?? '(空)'}（可以再 --rollback 换回去）`)
  return emit(opts, {
    title: 'aura-basetools 回滚',
    lines,
    json: {
      ok: true,
      command: 'rollback',
      from: current?.version ?? null,
      version: restored.version,
      treeHash: restored.treeHash,
      buildStamp: restored.buildStamp,
      previousVersion: nowInstalled?.version ?? null,
      selftest: post,
      notes: lines,
    },
    code: 0,
  })
}

/**
 * 结构化拒绝的细节：字段名固定（stage/from/to/liveUntouched），别在每个调用点各写一套 ——
 * 调用方（agent、探针）要的是稳定契约，不是好看的中文。
 */
const rejectDetail = (stage, from, to, liveUntouched, extra = {}) => ({ stage, from: from ?? null, to: to ?? null, liveUntouched, ...extra })

/**
 * 结构化拒绝（§4.3 的退出码 2）：码与细节稳定、message 给人看。
 * “现网有没有被动过”是 liveUntouched：拒绝发生在动现网之前 → true；升完又回滚过 → false。
 */
class Rejected extends InstallError {
  constructor(code, reason, detail = {}) {
    super(reason)
    this.code = code
    this.detail = detail
  }
}

try {
  process.exitCode = await main()
} catch (error) {
  const usage = error instanceof UsageError
  const rejected = error instanceof InstallError
  // 三类退出码（§4.3）：用法错 1、结构化拒绝 2（含意外崩溃：它不是用法错，不该共用一个码）、成功 0
  if (jsonMode) {
    // 拒绝类错误的字段是平铺的（ok/code/stage/from/to/liveUntouched/reason）：
    // 调用方要能一行取到，不必在嵌套对象里找
    process.stdout.write(
      `${JSON.stringify({ ok: false, kind: usage ? 'usage' : rejected ? 'rejected' : 'internal', code: error.code ?? (usage ? 'USAGE' : 'INTERNAL'), reason: error.message, ...(error.detail ?? {}) }, null, 2)}\n`,
    )
    process.stderr.write(`${error.message}\n`)
  } else if (usage) {
    process.stderr.write(`用法错误：${error.message}\n\n${USAGE}`)
  } else {
    // 只有意外崩溃才带栈："拒绝执行"是我们预料到的，栈对用户没用
    process.stderr.write(`${rejected ? '' : `${error.stack ?? error.message}\n`}${rejected ? '拒绝执行' : '安装失败'}：${error.message}\n`)
  }
  process.exitCode = usage ? 1 : 2
}
