/**
 * capabilities-test —— 0.9.5：能力清单必须与源码同源，且**与线上那张脸同词**。
 *
 * 判据两条方向：
 *   · 对内：清单里的语言数/地址档/读模式/限制与环境包声明，逐项等于源码导出值；任何一处手抄漂了会红；
 *   · 对外：清单点名的取值必须是**线上工具真的认**的名字（`mode.enum`、`op.enum`、声明的参数名），
 *     以及落盘的 `dist/capabilities.json` 必须等于现在派生的那份（A2b~A2e、D1）。
 * 只 import 生成器 + 一次 spawn 现取 `tools/list`，不读散文、不读第二份表。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildCapabilities } from './capabilities.mjs'
import { LANGS } from '../src/locator-lab/struct-core.mjs'
import { FLAT_ADDRESS_KEYS, MT_MAX_TARGETS, MT_POOL } from '../src/locator-lab/args.mjs'
import { CONTENT_BUDGET, DEFAULT_ENVELOPE_ALLOWANCE, DEFAULT_PRUNE_BUDGET, MODES } from '../src/locator-lab/read-core.mjs'
import { DOC_KINDS, indexDocument } from '../src/locator-lab/doc-structure.mjs'
import { HANDLE_MAX_PER_RECEIPT } from '../src/locator-lab/handle-core.mjs'
import { SUPPORTED_ENCODINGS } from '../src/aura-standalone/lib/encoding.mjs'

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
/** 线上 `tools/list` 的两个工具声明（一次 spawn，与宿主拿到的是同一份）。 */
const liveTools = () => {
  const bin = path.join(path.resolve(import.meta.dirname, '..'), 'src', 'aura-standalone', 'bin', 'aura-mcp.mjs')
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'capabilities-test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]
  const res = spawnSync(process.execPath, [bin], { input: `${frames.map((f) => JSON.stringify(f)).join('\n')}\n`, encoding: 'utf8', timeout: 60000 })
  for (const line of String(res.stdout ?? '').split('\n')) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg?.id !== 2) continue
    return new Map((msg.result?.tools ?? []).map((tool) => [tool.name, tool]))
  }
  return new Map()
}
const live = liveTools()
/** `aura_basetools_read` 的 `mode.enum`。 */
const liveReadModeEnum = () => live.get('aura_basetools_read')?.inputSchema?.properties?.mode?.enum ?? null
/** apply 面**法律上存在**的参数名：顶层声明 ∪ `hunks` 元素声明（`targets` 元素在 JSON Schema 里是
 *  开放对象，其名单由运行期判，已由 argument-surface 的 C4 对着同一份导出常量夹住）。 */
const liveApplyParamNames = () => {
  const applyTool = live.get('aura_basetools_apply')
  const top = Object.keys(applyTool?.inputSchema?.properties ?? {})
  const hunkItem = Object.keys(applyTool?.inputSchema?.properties?.hunks?.items?.properties ?? {})
  return new Set([...top, ...hunkItem])
}
const read = cap.tools.find((tool) => tool.name === 'aura_basetools_read')
const apply = cap.tools.find((tool) => tool.name === 'aura_basetools_apply')

/** 两份表的路径级差异（最多 4 条、每条截 160 字），只为让 D1 红的时候当场能看出漂在哪，不参与判定。 */
function diffKeys(a, b, prefix = '', out = []) {
  if (out.length >= 4) return out
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
  for (const key of keys) {
    const pa = `${prefix}${key}`
    const va = a?.[key]
    const vb = b?.[key]
    const same = JSON.stringify(va) === JSON.stringify(vb)
    if (same) continue
    if (isPlain(va) && isPlain(vb) || Array.isArray(va) && Array.isArray(vb)) {
      diffKeys(va, vb, `${pa}.`, out)
      continue
    }
    out.push(`${pa}: ${cut(va)} vs ${cut(vb)}`)
    if (out.length >= 4) return out
  }
  return out
}
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const cut = (v) => {
  const text = v === undefined ? '(缺)' : JSON.stringify(v)
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

say('=== A. 工具 / 读模式 / 地址档 ===')
check('A1 两个工具都在', read !== undefined && apply !== undefined && cap.tools.length === 2, cap.tools.map((tool) => tool.name).join(','))
check('A2 读模式 = auto + MODES', JSON.stringify(read?.modes) === JSON.stringify(['auto', ...MODES]), JSON.stringify(read?.modes))
/**
 * A2b 能力清单点名的每一个"视图名"，都必须是**线上工具真的接受**的 `mode` 取值。
 *
 * 为什么单独一条：`views` 曾把 `entity`/`grep`/`image` 与八个模式平铺在同一张表里，读起来像
 * `mode` 的取值——照它发 `mode:"grep"` 的判决是 `READ_BAD_MODE`（实测三条全拒），而既有各条
 * 只验"名单里的名字等于源码常量"，两边各自都对、接起来是坏的。现在 `views` 删了，这条改成
 * 双向夹住：清单说的模式 == 线上 enum，且**不得再有第二张视图名单**（`views` 重新出现就红，
 * 免得下一次又靠人来发现"这个名字不在 enum 里"）。那三个能力本身在描述里写对了：
 * `entity` 参数 / 目录 + `search` / 图片路径（`SERVER_INSTRUCTIONS` 那句）。
 */
{
  const liveEnum = liveReadModeEnum()
  check('A2b 清单模式与线上 mode.enum 逐字相等（不多不少）', JSON.stringify(read?.modes) === JSON.stringify(liveEnum), JSON.stringify({ cap: read?.modes, live: liveEnum }))
  check('A2c 能力清单里没有第二张视图名单（views 已删）', read?.views === undefined, JSON.stringify(Object.keys(read)))
}
/**
 * A2d/A2e 同一把尺子量 apply 面：清单点名的**操作名**必须逐字等于线上 `op.enum`，
 * 点名的**参数名**必须在线上声明里存在。
 *
 * 为什么是两条而不是一堆：`views` 那次红在"清单里有名字、线上不认"，而这张表的 apply 半边
 * 同样是手抄的（operations / options / addressKinds / addressSafety 四组名单）。逐个名字写用例
 * 只能证明抄的那一天一致；这里按字段类别各夹一次——名字漂出去（少一个键、多一个键、改了名）
 * 都会撞在"线上声明"这面墙上，而线上声明正是 argument-surface C2/C4 已经验过"送达引擎"的那一份。
 */
{
  const liveOpEnum = live.get('aura_basetools_apply')?.inputSchema?.properties?.op?.enum ?? null
  check('A2d 清单操作与线上 op.enum 逐字相等（不多不少）', JSON.stringify(apply?.operations) === JSON.stringify(liveOpEnum), JSON.stringify({ cap: apply?.operations, live: liveOpEnum }))
  const declared = liveApplyParamNames()
  const nameFields = { options: apply?.options, addressKinds: apply?.addressKinds, ...apply?.addressSafety }
  const orphans = []
  for (const [field, values] of Object.entries(nameFields)) {
    if (!Array.isArray(values)) continue
    for (const name of values) if (!declared.has(name)) orphans.push(`${field}:${name}`)
  }
  check('A2e 清单点名的每个参数名都在线上声明里（options/addressKinds/addressSafety）', orphans.length === 0 && declared.size > 0, `${orphans.join(',') || '(无孤儿)'} / 声明 ${declared.size} 键`)
}
for (const kind of ['target', 'lines', 'line_cue', 'anchor', 'old', 'context', 'handle', 'position']) {
  check(`A3 地址档含 ${kind}`, apply?.addressKinds.includes(kind), JSON.stringify(apply?.addressKinds))
}
check('A4 地址档与 FLAT_ADDRESS_KEYS 同源', FLAT_ADDRESS_KEYS.every((key) => apply?.addressKinds.includes(key)), FLAT_ADDRESS_KEYS.join(','))
check('A4b apply 选项含 replace_all', apply?.options?.includes('replace_all'), JSON.stringify(apply?.options))
check('A4c apply 选项含 require_observation；写入口默认带观察闸', apply?.options?.includes('require_observation') && apply?.writeSafety?.cli?.includes('observation-gate') && apply?.writeSafety?.mcp?.includes('observation-gate'), JSON.stringify({ options: apply?.options, safety: apply?.writeSafety }))
check('A4d apply 含 write 操作且选项含 eol', apply?.operations?.includes('write') && apply?.options?.includes('eol'), JSON.stringify({ operations: apply?.operations, options: apply?.options }))
check('A4e apply 在 DSH 面也宣称观察闸/区域闸/回读（不宣称事务/undo/锁）', apply?.writeSafety?.dsh?.includes('observation-gate') && apply.writeSafety.dsh.includes('stale-region-gate') && apply.writeSafety.dsh.includes('byte-verify') && !apply.writeSafety.dsh.includes('transaction') && !apply.writeSafety.dsh.includes('undo') && !apply.writeSafety.dsh.includes('workspace-lock'), JSON.stringify(apply?.writeSafety))
// 1.0.2：交付覆盖闸是写路径的常开判据，三个面都得宣称——声明面掉一个，模型就会以为那一面可以盲写。
check('A4f apply 三面都宣称交付覆盖闸（delivered-coverage）', ['cli', 'mcp', 'dsh'].every((face) => apply?.writeSafety?.[face]?.includes('delivered-coverage')), JSON.stringify(apply?.writeSafety))
check('A5 命令含 doctor', cap.commands.includes('basetools doctor'), cap.commands.join(','))
check('A5b 命令含 capabilities（运行时命令与构建清单同源）', cap.commands.includes('basetools capabilities'), cap.commands.join(','))
check('A5d 命令含 apply（唯一写入口）', cap.commands.includes('basetools apply'), cap.commands.join(','))
check('A5c CLI/MCP 的 apply 宣称 lock/闸/回读，不宣称 undo', Array.isArray(apply?.writeSafety?.dsh) && apply.writeSafety.dsh.includes('stale-region-gate') && !apply.writeSafety.dsh.includes('workspace-lock') && !apply.writeSafety.cli.includes('undo') && apply.writeSafety.cli.includes('workspace-lock'), JSON.stringify(apply?.writeSafety))

say('')
say('=== B. 语言表与限制 ===')
check('B1 languages 等于 LANGS 的键', JSON.stringify(cap.langs) === JSON.stringify(Object.keys(LANGS).sort()), `${cap.langs.length}`)
// 反馈 D7/B1：寻址安全等级与文本编码是机器可读事实，不能只靠散文。
{
  const apply = cap.tools.find((tool) => tool.name === 'aura_basetools_apply')
  check(
    'A6 寻址安全等级与实测一致（coordinate 默认不设闸）',
    apply?.addressSafety?.coordinate?.includes('lines') &&
      apply?.addressSafety?.contentVerified?.includes('old') &&
      apply.addressSafety.coordinateNeedsObservation === false &&
      apply.addressSafety.lineAddressNeedsExpect?.includes('lines'),
    JSON.stringify(apply?.addressSafety),
  )
  {
    // B7 文档类型词表：等于引擎分发表的取值，且**每个取值当场能派出一个结构索引**。
    // 这条是 `views` 那一类在文档词表上的收口：清单多写一个名字（如 `ini`）不是"多一个能力"，
    // 而是"照着清单发 `mode=map` 会拿到 `no structure index for ini` 的空目录"。
    const fixture = { markdown: '# A\ntext\n', json: '{"a":1}\n', yaml: 'a: 1\n', toml: '[t]\nk = 1\n' }
    const declared = [...new Set(Object.values(DOC_KINDS))]
    check('B7 文档类型 = 引擎 DOC_KINDS 的取值（不再手抄）', JSON.stringify(cap.docKinds) === JSON.stringify(declared), JSON.stringify({ cap: cap.docKinds, declared }))
    const inert = cap.docKinds.filter((kind) => {
      const src = fixture[kind]
      if (src === undefined) return true
      const indexed = indexDocument(src, kind)
      // 只拒"这套分发表里没这个种类"那一句降级；其它 note 是合法降级（如 JSON 解析不完整），不算空转。
      return !(indexed?.entries?.length > 0) || /^no structure index for/.test(String(indexed.note ?? ''))
    })
    check('B7b 每个宣称的文档类型都能派出非空结构目录', inert.length === 0, `派不出：${inert.join(',') || '(无)'}`)
  }
  check(
    'B5 文本编码声明与 encoding.mjs 同源（含非 UTF-8）',
    JSON.stringify(cap.textEncodings) === JSON.stringify(SUPPORTED_ENCODINGS) && cap.textEncodings.includes('gb18030'),
    JSON.stringify(cap.textEncodings),
  )
  check('B6 full 的默认预算是事实字段', cap.limits.defaultContentBudget === CONTENT_BUDGET && cap.limits.maxContentBudget === null, JSON.stringify({ d: cap.limits.defaultContentBudget, m: cap.limits.maxContentBudget }))
}
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
say('=== D. 送达的清单 = 源码派生的清单')
/**
 * D1 落盘的 `dist/capabilities.json` 必须**等于**源码现在派生的那份。
 *
 * 为什么单独立一条：这张表是消费方（agent / 插件市场 / 评测）读的那一份，落盘只在构建里刷新。
 * 实测踩过：删掉 `views` 后用 `make-bundle`（不带 `--pack`）+ `make-split-packages --pack` 重建，
 * A1~C2 全绿（它们判的是内存里派生的那份），落盘文件里 `views:[…,"entity","grep","image"]` 原样还在——
 * 正是 1.0.2 那三个事故的同形：**每一层各自都对，接起来是坏的**。构建器现已无条件刷新（`make-bundle.mjs`），
 * 这条管的是刷新之外：判据只取一个方向——文件在 ⇒ 逐字节同表（时间戳除外），漂了当场点名到
 * `tools.0.views` 这一级；文件不在 ⇒ 只许承认"未构建"，不许拿旧表冒充。
 */
{
  const delivered = path.join(import.meta.dirname, '..', 'dist', 'capabilities.json')
  if (fs.existsSync(delivered)) {
    const stripGenerated = (obj) => {
      const { generatedAt: _generatedAt, ...rest } = obj
      return rest
    }
    let onDisk = null
    let err = ''
    try {
      onDisk = stripGenerated(JSON.parse(fs.readFileSync(delivered, 'utf8')))
    } catch (e) {
      err = String(e?.message ?? e)
    }
    const now = stripGenerated(cap)
    check('D1 落盘清单 = 源码派生清单（时间戳除外）', onDisk !== null && JSON.stringify(onDisk) === JSON.stringify(now), err === '' ? `差异：${diffKeys(onDisk, now).join(',') || '(无)'}` : err)
  } else {
    check('D1 落盘清单尚未生成（本次只验内存派生；发布前必须跑 make-bundle）', true, delivered)
  }
}

say('')
say(`--- 能力清单：${pass}/${pass + fail} 通过 ---`)
process.exitCode = fail === 0 ? 0 : 1
