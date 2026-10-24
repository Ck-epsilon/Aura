#!/usr/bin/env node
/**
 * aura CLI（薄壳）：参数解析 → `lib/ops.mjs` → 一行 JSON。
 *
 *   aura basetools read  --file F [--mode …] [--around X] [--lines a,b] [--search S] [--since V] [--max-chars N]
 *   aura basetools edit  --file F (--hunks '<json>' | --hunks-file P) [--dry-run] [--verify "命令"] [--create <文本|@文件>]
 *   aura basetools read  --targets '[...]|@spec.json'                    一次读多个目标（与 --file 互斥）
 *   aura basetools edit  --targets '[...]|@spec.json'                    一次改多个文件（与 --file 互斥；任一规划失败 ⇒ 零写入）
 *   aura basetools mcp
 *   aura --help | --version
 *
 * 退出码：0 成功；2 结构化拒绝（回执带 code/next 一类信息）；1 用法错误。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  openProvider,
  readEnvelope,
  editEnvelope,
  flatHunk,
  // 多目标（fs-contract-v2）的引擎绑定：与单目标同一处（`lib/ops.mjs`），bin 里不另找引擎。
  readManyWith,
  editManyEnvelope,
  capabilitiesEnvelope,
  writeEnvelope,
  assertReadTargets,
  assertEditTargets,
  assertKnownArgs,
  MT_READ_ELEMENT_KEYS,
  MT_EDIT_ELEMENT_KEYS,
  errorEvidence,
} from '../lib/ops.mjs'
// `flatHunk` 是 `locator-lab/args.mjs` 里那一份容错规则（DSH 壳与 CLI 共用），但**不在这里定位引擎**：
// 引擎由 `lib/ops.mjs` 一处解析（`engineBase`），两种布局各一个候选。CLI 自己也写一条
// `../locator-lab/…` 就等于又多一个只在摊平布局下成立的引用——src 布局会因此照旧 ERR_MODULE_NOT_FOUND。

// 版本从包自己的 package.json 读（写死过一次，对外报的版本就停在旧值）；开发树里取不到报 dev
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return 'dev'
  }
})()
const rootArgv = process.argv.slice(2)
/**
 * CLI 命名空间：`aura basetools <verb>`。
 *
 * 顶层 `read` / `edit` / `write` ... 不再保留别名：以后会有多个 aura 产品共用 `aura`
 * 这个入口，顶层动词迟早撞名。命名空间只改**调用写法**，引擎与回执不变。
 */
let argv = rootArgv
const namespaced = rootArgv[0] === 'basetools'
if (namespaced) argv = argv.slice(1)
let command = argv[0]

/**
/**
 * 本 CLI 的**布尔旗标**名单。
 *
 * 为什么必须有这份名单：`flag()` 原本把“下一个参数以 `--` 开头”一律当成“这个旗标没带值”，
 * 于是 `--create "---\ntitle: x"`（YAML front matter、`--` 注释横幅这类内容）**值被静默丢掉**，
 * 跟着报的错是 `PATCH_NOT_FOUND … to create it, pass `create``——传了 create 却被叫去传 create。
 * 实测复现于 0.5.3（T6 第 3 条）。
 *
 * 有了这份名单，“下一个是已知布尔旗标”才当没带值，**其它以 `--` 开头的东西都当值**。
 * 代价是名单要维护；收益是那个静默丢值的路径从根上消失，而不是靠叫用户改写法。
 */
const BOOLEAN_FLAGS = new Set(['pretty', 'dry-run', 'plan', 'no-overwrite', 'replace-all', 'require-observation', 'allow-unobserved', 'json'])
const isBooleanFlag = (token) => typeof token === 'string' && BOOLEAN_FLAGS.has(token.replace(/^--/, ''))

/**
 * 每个命令认识的旗标（唯一一份）。`flag()` 只读取它要找的那个名字；**不在这里的 `--xxx`
 * 以前会被静默忽略**——`--dryrun` 于是变成“没传 dry-run”的一次真写盘。
 *
 * 这里同时承担两件事：未知旗标拒绝（`ARGS_UNKNOWN_KEY`）与扫描时的“这个旗标要不要吃值”。
 * 合法键名与命令实现放在同一张表里，新增旗标不会出现“parser 认、校验不认”的分叉。
 */
const COMMAND_FLAGS = {
  read: {
    value: ['cwd', 'file', 'targets', 'mode', 'around', 'lines', 'start-line', 'end-line', 'search', 'since', 'context', 'kind', 'budget', 'max-chars', 'offset', 'limit'],
    bool: ['pretty'],
  },
  edit: {
    value: ['cwd', 'file', 'targets', 'hunks', 'hunks-file', 'create', 'target', 'lines', 'start-line', 'end-line', 'line-cue', 'anchor', 'old', 'context', 'handle', 'line', 'position', 'replace', 'expect', 'near', 'eol', 'verify'],
    bool: ['pretty', 'dry-run', 'plan', 'replace-all', 'require-observation'],
  },
  write: {
    value: ['cwd', 'file', 'content', 'eol', 'verify'],
    bool: ['pretty', 'dry-run', 'plan', 'no-overwrite', 'allow-unobserved'],
  },
  doctor: { value: ['cwd'], bool: ['pretty', 'json'] },
  capabilities: { value: ['cwd'], bool: ['pretty'] },
  mcp: { value: ['cwd'], bool: ['pretty'] },
}

/**
 * 扫一遍命令后的 argv：未知旗标 / 裸位置参数 / 布尔旗标带值 一律拒绝。
 *
 * **值旗标吃下一个 token**（与 `flag()` 的既有语义一致）：`--content "---"` 这种以 `--`
 * 开头的正文不能被误判成旗标。没有值的值旗标不在这一层判（各命令会给出自己的错误）。
 */
function validateCommandFlags(command, tokens) {
  const spec = COMMAND_FLAGS[command]
  if (spec === undefined) return undefined
  const valueFlags = new Set(spec.value)
  const boolFlags = new Set(spec.bool)
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (typeof token !== 'string' || !token.startsWith('--')) {
      return `unexpected argument ${JSON.stringify(token)} — this command takes flags only`
    }
    const eq = token.indexOf('=')
    const name = token.slice(2, eq === -1 ? undefined : eq)
    if (boolFlags.has(name)) {
      if (eq !== -1) return `--${name} is a boolean flag and takes no value (got ${JSON.stringify(token.slice(eq + 1))})`
      continue
    }
    if (!valueFlags.has(name)) {
      const legal = [...spec.value, ...spec.bool].sort().map((flag) => `--${flag}`).join(', ')
      return `unknown flag --${name}; this command accepts: ${legal}`
    }
    if (eq === -1) {
      const next = tokens[i + 1]
      // 与 `flag()` 同一条：下一个 token 若是本命令的布尔旗标，就当“这个值旗标没带值”，
      // 不去吃它（否则 `--content --dry-run` 会把 dry-run 藏进正文里）。
      if (next !== undefined && !(next.startsWith('--') && boolFlags.has(next.slice(2)))) i += 1
    }
  }
  return undefined
}

const flag = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`)
  if (i >= 0) {
    const v = argv[i + 1]
    return v === undefined || isBooleanFlag(v) ? true : v
  }
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  return eq === undefined ? fallback : eq.slice(name.length + 3)
}
const has = (name) => argv.includes(`--${name}`)
const emit = (obj, code) => {
  process.stdout.write(`${has('pretty') ? JSON.stringify(obj, null, 2) : JSON.stringify(obj)}\n`)
  process.exit(code)
}
/** `@文件` 参数读不到时回一条 JSON 回执，而不是把 Node 栈抛给调用方。 */
const readArgumentFile = (target, flagName) => {
  try {
    return fs.readFileSync(target, 'utf8')
  } catch (error) {
    emit({ ok: false, error: `${flagName} 读不到 ${target}：${error.message}`, code: 'USAGE' }, 1)
  }
}

const USAGE = [
  `aura ${VERSION} —— 按意图读写文件（独立版：不依赖 DeepSeek Harness，Windows / macOS / Linux 同形）`,
  '',
  '  aura basetools read  --file <路径> [--mode map|digest|full|around|lines|search|changed]',
  '             [--around <符号>] [--lines <a,b>|<a-b>|<n>] [--start-line <n> --end-line <n>]',
  '             [--search <子串>] [--context <n>] [--kind <类型>] [--budget <字符数>] [--since <令牌>] [--max-chars <n>] [--offset <n> --limit <n>]',
  // `--file` 指向**目录**时直接给一张仓库地图（模块/目录/依赖方向），不需要额外旗标。
  '             （--file 传目录 ⇒ 仓库地图：模块清单 + 目录骨架 + 被依赖最多的模块 + 入口点）',
  '  aura basetools read  --targets <json|@文件>                               # 一次读多个目标（≤32 项；与 --file 互斥）',
  '  aura basetools edit  --targets <json|@文件> [--dry-run|--plan] [--verify "命令"]  # 一次改多个文件（先全量规划，任一失败则零写入）',
  "  aura basetools edit  --file <路径> --create <内容|@文件>                     # 建文件（不必再给 --hunks）",
  "  aura basetools edit  --file <路径> (--hunks '<json>' | --hunks-file <路径>) [--dry-run|--plan] [--verify \"命令\"] [--eol auto|preserve|lf|crlf] [--require-observation]",
  '   aura basetools edit  --file <路径> --lines <a,b> --replace <文本> [--expect <文本>] [--near <n>]',
  '   aura basetools edit  --file <路径> --old <原文> --replace <文本> --replace-all        # 改全部非重叠出现',
          "              （只改一处时不必包成 JSON：--target / --lines / --start-line+--end-line / --line-cue / --anchor 任选其一）",
  // 句柄（fs-contract-v2 §5）：读侧发的柄 + 三种定位写法。下面三行是三种**用法**，不是三种键。
  '   aura basetools edit  --file <路径> --handle <h…> --replace <文本>                          # 整段替换：区间由柄定，不靠转述',
  '   aura basetools edit  --file <路径> --handle <h…> --line <段内行号> --replace <文本>            # 只换区间内第 k 行（1-based，从区间首行数起）',
  '   aura basetools edit  --file <路径> --handle <h…> --position before|after --replace <文本>  # 在区间边界插入，区间本身不动',
  "              （--line / --position 是从属键：只有与 --handle 同时给才成立，单独给不构成一次编辑）",
  '  aura basetools mcp                    启动 MCP stdio 服务',
  '  aura basetools write --file <路径> --content <文本|@文件> [--no-overwrite] [--dry-run|--plan] [--verify "命令"] [--allow-unobserved] [--eol auto|preserve|lf|crlf]',
  '             （覆写默认要求先读过这一版；--allow-unobserved 才允许盲写）',
  '  aura basetools doctor [--json]        自检：Node/版本/MCP 握手/缓存与锁目录可写',
  '  aura basetools capabilities [--pretty] 能力清单：读模式/地址档/语言/限制（JSON）',
  '  aura --help | --version',
  '',
      'hunks 形状：[{"target":"符号名"|"lines":[a,b]|"line_cue":"唯一词"|"anchor":"记得的原文",',
  '              "replace":"替换文本","expect":"该处应是什么","near":行号}]',
  '',
  '例：',
  "  aura basetools edit --file a.mjs --hunks '[{\"lines\":[5,5],\"replace\":\"x\"}]'   # 单引号包住整段 JSON",
  '  aura basetools edit --file a.mjs --hunks-file hunks.json                        # 内容走文件，绕开引号',
  '  aura basetools edit --file new.md --create @body.md                             # @文件 ——推荐给长内容',
  '  aura basetools edit --file new.md --create=---                                  # 值以 -- 开头时必须用 = 形式',
  '  aura basetools read --file ./src                                                # 目录 ⇒ 仓库地图',
  '',
  'PowerShell 两个已踩过的坑：',
  '  · 反引号 `n 写进 JSON 字符串会变成控制字符（JSON 不允许）⇒ 用 --hunks-file 或单引号 heredoc；',
  '  · 5.1 的 Set-Content -Encoding UTF8 默认写 BOM ⇒ 本工具会剥掉前导 BOM，但更早的工具链可能不认。',
  '加 --pretty 输出多行 JSON。先 read 拿令牌，再 edit——编辑会核对“这块区域在你读之后有没有被改过”。',
].join('\n')

/**
 * `--targets <spec>`：一次给多个目标（fs-contract-v2 §2.1/§2.2）。
 *
 * 取值形状与 `--hunks` **同形**：字面 JSON，或 `@文件`（`@` 前缀读文件、剥掉前导 BOM ——
 * 理由与 `--hunks-file` 的注释同一条：PowerShell 5.1 的 `Set-Content -Encoding UTF8` 默认写 BOM，
 * 而那个字符用户看不见）。spec 是 `[...]`（每个元素就是单目标那套参数），
 * 或 `{"targets": [...], "dryRun": false}`。
 *
 * **形状判定一条都不在这里**：数组 / 上限 32 / 空批 / 逐项路径 / 与单目标形状互斥，全部由引擎
 * （`locator-lab/args.mjs` 的 `assertReadTargets` / `assertEditTargets`）判 —— 两个调用面各写
 * 一份必然漂开。本函数只做三件事：把 `targets` 取出来、把 `--file` 作为 `file_path` 一并递进去
 * （于是“两个都给”由那条唯一判据说话）、把引擎抛的参数面错接到 exit 1 那一档。
 *
 * @param assertShape - 读侧 `assertReadTargets`、写侧 `assertEditTargets`（同一个判据，两套提示语）
 * @param toolName - 回执里点名的工具（`aura_basetools_read` / `aura_basetools_edit`）
 * @returns `{ targets, dryRun }`（逐项判决在引擎里，这里只递参数）
 */
const engineTargets = (assertShape, toolName, elementKeys) => {
  const raw = flag('targets')
  const where = typeof raw === 'string' && raw.startsWith('@') ? `--targets @${raw.slice(1)}` : '--targets'
  if (typeof raw !== 'string') {
    emit(
      {
        ok: false,
        error: '--targets 需要跟一个 JSON 字符串，或 `@文件`（例：--targets \'[{"file_path":"a.mjs","mode":"digest"}]\'）',
        code: 'USAGE',
      },
      1,
    )
  }
  let text = raw
  if (raw.startsWith('@')) {
    try {
      text = fs.readFileSync(raw.slice(1), 'utf8')
    } catch (error) {
      emit({ ok: false, error: `${where} 读不到：${error.message}`, code: 'USAGE' }, 1)
    }
    text = text.replace(/^\uFEFF/, '')
  }
  let spec
  try {
    spec = JSON.parse(text)
  } catch (error) {
    emit(
      {
        ok: false,
        error:
          `${where} 不是合法 JSON：${error.message}；接受 \`[...]\`（每个元素就是单目标那套参数），或 \`{"targets": [...]}\`` +
          (raw.startsWith('@') ? '' : '；内容含引号/换行时用 `--targets @文件`'),
        code: 'USAGE',
      },
      1,
    )
  }
  if (spec === null || typeof spec !== 'object') {
    emit({ ok: false, error: `${where} 需要数组或对象，收到 ${JSON.stringify(spec)}；接受 \`[...]\` 或 \`{"targets": [...]}\``, code: 'USAGE' }, 1)
  }
  const array = Array.isArray(spec)
  const source = array ? { targets: spec } : { ...spec }
  if (!array) {
    // 顶层不认识的键不许静默忽略：`{"targets":…,"dryrun":true}` 会变成“以为 dry-run 了、其实真写盘”。
    // 合法键名单与报错方式都交给引擎那份守卫（判据只有一处）。
    try {
      assertKnownArgs(spec, ['targets', 'dryRun'], toolName)
    } catch (error) {
      refuseShape(where, error)
    }
  }
  if (typeof flag('file') === 'string') source.file_path = flag('file')
  let targets
  try {
    targets = assertShape(source, { toolName, elementKeys })
  } catch (error) {
    refuseShape(where, error)
  }
  if (targets === undefined) {
    emit({ ok: false, error: `${where} 里没有 targets 数组：接受 \`[...]\`（每个元素就是单目标那套参数），或 \`{"targets": [...]}\``, code: 'USAGE' }, 1)
  }
  return { targets, dryRun: !array && spec.dryRun === true }
}

/**
 * 引擎的形状判据抛错 ⇒ **参数面** 拒绝（exit 1，与既有 `USAGE` 档一致）。
 *
 * 引擎自己那个码放在 `shape` 里原样带出来（`ARGS_TARGETS_LIMIT` / `ARGS_SHAPE_EXCLUSIVE` …）：
 * 退出码那一档是本 CLI 的既有档位，而“是哪条判据拒的”必须能机读 —— 两者各归各的字段。
 */
const refuseShape = (where, error) =>
  emit(
    {
      ok: false,
      error: `${where}：${String(error?.message ?? error)}`,
      code: 'USAGE',
      ...(typeof error?.code === 'string' ? { shape: error.code } : {}),
      ...errorEvidence(error),
    },
    1,
  )

if (command === undefined || command === '--help' || command === '-h') emit({ ok: true, usage: USAGE }, 0)
if (command === '--version' || command === '-v') emit({ ok: true, version: VERSION }, 0)
/**
 * 旧顶层动词只给**迁移提示**，不再作为别名执行——保留别名等于保留未来的撞名。
 * 只提示、不执行：`aura basetools read` 不会偷偷改文件。
 */
const MOVED_COMMANDS = new Set(['read', 'outline', 'edit', 'write', 'mcp', 'doctor', 'capabilities'])
if (!namespaced && MOVED_COMMANDS.has(command)) {
  emit(
    {
      ok: false,
      error: `command moved: use \`aura basetools ${command}\` (top-level verbs are reserved for product namespaces)`,
      code: 'USAGE',
      shape: 'CLI_NAMESPACE_REQUIRED',
    },
    1,
  )
}
const flagProblem = validateCommandFlags(command, argv.slice(1))
if (flagProblem !== undefined) {
  emit({ ok: false, error: flagProblem, code: 'USAGE', shape: 'ARGS_UNKNOWN_KEY' }, 1)
}
if (command === 'mcp') {
  const { serve } = await import('./aura-mcp.mjs')
  await serve()
  process.exit(0)
}

const provider = openProvider(typeof flag('cwd') === 'string' ? flag('cwd') : process.cwd())

if (command === 'capabilities') {
  const env = { ok: true, version: VERSION, ...capabilitiesEnvelope() }
  process.stdout.write(`${JSON.stringify(env, null, has('pretty') ? 2 : 0)}\n`)
  process.exit(0)
}

if (command === 'write') {
  const file = flag('file')
  if (typeof file !== 'string') emit({ ok: false, error: 'write 需要 --file <路径>', code: 'USAGE' }, 1)
  const raw = flag('content')
  if (typeof raw !== 'string') emit({ ok: false, error: 'write 需要 --content <文本|@文件>', code: 'USAGE' }, 1)
  const content = raw.startsWith('@') ? readArgumentFile(raw.slice(1), '--content') : raw
  const eol = flag('eol')
  if (eol !== undefined && typeof eol !== 'string') {
    emit({ ok: false, error: 'write 的 --eol 需要跟一个值：auto|preserve|lf|crlf', code: 'USAGE' }, 1)
  }
  const env = await writeEnvelope(provider, {
    file,
    content,
    dryRun: has('dry-run') || has('plan'),
    noOverwrite: has('no-overwrite'),
    allowUnobserved: has('allow-unobserved'),
    ...(typeof eol === 'string' ? { eol } : {}),
    ...(typeof flag('verify') === 'string' ? { verify: flag('verify') } : {}),
  })
  emit(env, env.ok ? 0 : 2)
}

if (command === 'doctor') {
  /**
   * `aura basetools doctor`：把“装完能不能用”的机械检查放在 CLI 自己身上。
   * 与安装器的 `--doctor` 不同：这里不假设 DSH profile，只查这个包自己的入口、MCP 握手与缓存目录。
   */
  const checks = []
  const add = (id, ok, detail) => checks.push({ id, ok, detail })
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10)
  add('node', nodeMajor >= 18, `node ${process.versions.node} (need >=18)`)
  add('version', typeof VERSION === 'string' && VERSION.length > 0, VERSION)
  const mcpPath = fileURLToPath(new URL('./aura-mcp.mjs', import.meta.url))
  add('mcp-bin', fs.existsSync(mcpPath), mcpPath)
  const cacheDir = process.env.AURA_CACHE_DIR ?? path.join(os.homedir(), '.aura')
  if (fs.existsSync(mcpPath)) {
    const frames = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'aura-doctor', version: '1' } } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      '',
    ].join('\n')
    const res = spawnSync(process.execPath, [mcpPath], {
      input: frames,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, AURA_CACHE_DIR: cacheDir },
    })
    const tools = String(res.stdout ?? '').split('\n').flatMap((line) => {
      try { return JSON.parse(line).result?.tools?.map((tool) => tool.name) ?? [] } catch { return [] }
    })
    add('mcp-handshake', res.status === 0 && tools.includes('aura_basetools_read') && tools.includes('aura_basetools_edit'), `exit=${res.status} tools=${tools.join(',') || '(none)'}`)
  } else {
    add('mcp-handshake', false, 'skipped: mcp bin missing')
  }
  const probeWritable = (dir, id) => {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const probe = path.join(dir, `.doctor-${process.pid}`)
      fs.writeFileSync(probe, 'ok')
      const text = fs.readFileSync(probe, 'utf8')
      fs.rmSync(probe, { force: true })
      add(id, text === 'ok', dir)
    } catch (error) {
      add(id, false, `${dir}: ${String(error?.message ?? error)}`)
    }
  }
  probeWritable(cacheDir, 'cache-writable')
  probeWritable(path.join(cacheDir, 'locks'), 'lock-writable')
  const ok = checks.every((check) => check.ok)
  const report = {
    ok,
    version: VERSION,
    node: process.versions.node,
    checks,
    ...(process.env.AURA_NO_LOCK === '1' ? { notes: ['AURA_NO_LOCK=1: workspace lock is disabled'] } : {}),
  }
  if (has('json')) {
    process.stdout.write(`${JSON.stringify(report)}\n`)
    process.exit(ok ? 0 : 2)
  }
  process.stdout.write(`aura basetools doctor: ${ok ? 'ok' : 'FAILED'} (${VERSION}, node ${process.versions.node})\n`)
  for (const check of checks) process.stdout.write(`  ${check.ok ? '✓' : '✗'} ${check.id}: ${check.detail}\n`)
  process.exit(ok ? 0 : 2)
}

if (command === 'read' || command === 'outline') {
  /**
   * 多目标（fs-contract-v2 §2.1）：`--targets` 在场 ⇒ 引擎的批入口。
   * `--file` 那条路一个字不动（就在下面，含它自己的 `USAGE` 与 `outline ⇒ map`）。
   */
  if (has('targets')) {
    const { targets } = engineTargets(assertReadTargets, 'aura_basetools_read', MT_READ_ELEMENT_KEYS)
    const env = await readManyWith(provider, targets)
    emit(env, env.ok ? 0 : 2)
  }
  const file = flag('file')
  if (typeof file !== 'string') emit({ ok: false, error: 'read 需要 --file <路径>', code: 'USAGE' }, 1)
  // 行区间**原样**交给收敛层（locator-lab/args.mjs）：`--lines 5`、`--lines 5,8`、`--lines 5-8`
  // 与 `--start-line/--end-line` 都认，解不出来时由它回一句"接受哪些写法"。
  // 旧写法在这里自己用正则挑 `a,b`，其余情况**静默退回 auto** —— 用户以为读了第 5 行，
  // 实际读了别的（与 0.4.1 修掉的那条 MCP/CLI 形状 bug 同一类：宁可报错，不可默默换语义）。
  // `await` 不能省：`readEnvelope` 现在是 async（目录路径要走仓库地图）。
  // 漏掉它的后果不是报错而是**谎言**——`JSON.stringify(Promise)` 是 `{}`，
  // 而退出码由 `env.ok` 决定也变成 undefined⇒2：看起来像“结构化拒绝”，实际什么都没发生。
  const env = await readEnvelope(provider, {
    file,
    mode: typeof flag('mode') === 'string' ? flag('mode') : command === 'outline' ? 'map' : undefined,
    around: flag('around'),
    lines: flag('lines'),
    start_line: flag('start-line'),
    end_line: flag('end-line'),
    search: flag('search'),
    context: typeof flag('context') === 'string' ? Number(flag('context')) : undefined,
    kind: typeof flag('kind') === 'string' ? flag('kind') : undefined,
    budget: typeof flag('budget') === 'string' ? Number(flag('budget')) : undefined,
    since: flag('since'),
    // 0.10.0：内置 Read 的分页形状（offset 0-based；limit 行数；默认 2000）。
    offset: typeof flag('offset') === 'string' ? Number(flag('offset')) : undefined,
    limit: typeof flag('limit') === 'string' ? Number(flag('limit')) : undefined,
    // 光写 `--max-chars` 不带值时 flag() 回 true，Number(true)=1 会变成"预算 1 字符"这种怪值
    maxChars: typeof flag('max-chars') === 'string' ? Number(flag('max-chars')) : undefined,
  })
  emit(env, env.ok ? 0 : 2)
}

if (command === 'edit') {
  /**
   * 多目标（fs-contract-v2 §2.2）：`--targets` 在场 ⇒ 引擎的三阶段批入口
   * （全量规划 → 全部可落才提交 → 逐文件回读校验）。`--file` 那条路一个字不动（就在下面）。
   *
   * `dryRun` 两个来源都认：spec 里的 `dryRun`（与 DSH 壳同名）与既有的 `--dry-run` 旗标。
   */
  if (has('targets')) {
    const spec = engineTargets(assertEditTargets, 'aura_basetools_edit', MT_EDIT_ELEMENT_KEYS)
    const env = await editManyEnvelope(provider, {
      targets: spec.targets,
      dryRun: has('dry-run') || has('plan') || spec.dryRun,
      ...(has('require-observation') ? { requireObservation: true } : {}),
      ...(typeof flag('verify') === 'string' ? { verify: flag('verify') } : {}),
    })
    emit(env, env.ok ? 0 : 2)
  }
  const file = flag('file')
  if (typeof file !== 'string') emit({ ok: false, error: 'edit 需要 --file <路径>', code: 'USAGE' }, 1)
  /**
   * 单个 hunk 也可以**平铺成旗标**：`--lines 5,8 --replace 'X'`。
   *
   * 与 DSH 壳那边容错同一个形状（那边实测 27 次失败是 `{file_path,start_line,end_line,replace}`）。
   * CLI 这边本来就是人/脚本在用，但“一个 hunk 不必先包成 JSON 数组”对脚本更友好：
   * 现在 `--lines 5 --replace X` 就能改一行，不必再手写转义过的 JSON。
   * 两边**共用同一个 `flatHunk`**（引擎里），不是各写一份容错规则。
   */
  const flat = flatHunk({
    target: flag('target'),
    lines: flag('lines'),
    start_line: flag('start-line'),
    end_line: flag('end-line'),
    line_cue: flag('line-cue'),
    anchor: flag('anchor'),
    // 句柄（fs-contract-v2 / HD2）：`handle` 是地址键，`line` / `position` 是它的**从属键**。
    // 后两个照 `target`/`lines`/`line_cue`/`anchor` 同形递进去（旗标值就是字符串，`line` 由引擎的
    // `toLineNumber` 收敛）。**这里不判“单独给算不算地址”**——那是 `FLAT_ADDRESS_KEYS` /
    // `HANDLE_SHAPE_KEYS` 的语义（`flatHunk` 只看地址键），CLI 另判一份就是第二份判据。
    handle: flag('handle'),
    line: flag('line'),
    position: flag('position'),
    // 内容地址（0.10.2）：平铺 CLI 也能直接给逐字原文；`--replace-all` 用它改全部出现。
    old: flag('old'),
    context: flag('context'),
    replace: flag('replace'),
    expect: flag('expect'),
    eol: flag('eol'),
    replace_all: has('replace-all') ? true : undefined,
    // 旗标值天然是字符串：`--near 42` ⇒ `'42'`。收敛层只认整数，所以在这里转一次
    near: typeof flag('near') === 'string' && flag('near').trim() !== '' ? Number(flag('near')) : flag('near'),
  })
  const hunksFile = typeof flag('hunks-file') === 'string' ? flag('hunks-file') : undefined
  /**
   * 读 hunks 来源，并把错误报到**真正的来源**上。
   *
   * 两个实测过的坑（T6 第 2 条）：
   *   1. **BOM 会把干净的 JSON 打死**：PowerShell 5.1 的 `Set-Content -Encoding UTF8` 默认写 BOM，
   *      于是 `JSON.parse` 报 `Unexpected token '\uFEFF'`。这是**工具可以自己处理**的事——剥掉前导 BOM 就好，
   *      没有理由把这个转嫁给用户（何况他看不见那个字符）。
   *   2. 旧代码无论来源是哪个都报 `--hunks 不是合法 JSON`：错报来源会把排查引到错的方向（他压根没用 --hunks）。
   */
  const readHunksSource = () => {
    if (hunksFile !== undefined) {
      let text
      try {
        text = fs.readFileSync(hunksFile, 'utf8')
      } catch (error) {
        emit({ ok: false, error: `--hunks-file 读不到 ${hunksFile}：${error.message}`, code: 'USAGE' }, 1)
      }
      return { text: text.replace(/^\uFEFF/, ''), where: `--hunks-file ${hunksFile}` }
    }
    return { text: flag('hunks'), where: '--hunks' }
  }
  const from = hunksFile === undefined && flag('hunks') === undefined ? null : readHunksSource()
  let hunks = flat === null ? null : [flat]
  if (from !== null) {
    if (typeof from.text !== 'string') emit({ ok: false, error: `${from.where} 需要跟一个 JSON 字符串`, code: 'USAGE' }, 1)
    try {
      hunks = JSON.parse(from.text)
    } catch (error) {
      emit(
        {
          ok: false,
          error:
            `${from.where} 不是合法 JSON：${error.message}` +
            // 给出两条真实出路：内容走文件绕开命令行引号，或先 read 拿形状。
            // 不说的话，用户只能反复调引号——而那正是 PowerShell 下最容易撞的坑。
            '；若内容里含引号/换行，优先用 `--hunks-file <路径>`（也接受平铺旗标 `--lines 5 --replace X`）；' +
            '写文件时注意别写 UTF-8 BOM（本工具会剥掉前导 BOM，但更早的工具链可能不认）',
          code: 'USAGE',
        },
        1,
      )
    }
    if (!Array.isArray(hunks)) emit({ ok: false, error: `${from.where} 必须是数组`, code: 'USAGE' }, 1)
  }
  /**
   * `create` **可以单独用**（不要求 hunks），与 DSH 壳看齐。
   *
   * 旧行为：`edit --file F --create "hello"` 报 `edit 需要 --hunks/--hunks-file`——
   * 一句话里有两个错：真正在做的事是**建文件**（不需要 hunks），而报错让人以为“还得多给一个参数”。
   * DSH 壳早就修过同一个坑（`aura-edit/index.js`：`create` 在时 hunks 可为空，
   * 且注释原文写着“第一版把‘hunks 非空’当无条件校验，于是创建被自己的校验挡住”）。
   * 这里只是把同一件事在 CLI 面补上；`--hunks '[]' --create` 这种 workaround 仍照旧可用。
   */
  const creating = typeof flag('create') === 'string'
  if (hunks === null && !creating) {
    emit(
      {
        ok: false,
        error:
      'edit 需要 --hunks/--hunks-file，或平铺一组地址旗标（--target / --lines / --start-line+--end-line / --line-cue / --anchor / --handle（配 --line 或 --position），外加 --replace），或 --create <整份内容>',
        code: 'USAGE',
      },
      1,
    )
  }
  const createRaw = flag('create')
  // `@文件` 形式：内容完全不经过命令行引号。创建含引号/换行/front matter 的内容时这是最稳的路。
  const create = typeof createRaw === 'string' && createRaw.startsWith('@') ? readArgumentFile(createRaw.slice(1), '--create') : createRaw
  const env = await editEnvelope(provider, {
    file,
    hunks: hunks ?? [],
    dryRun: has('dry-run') || has('plan'),
    create,
    ...(has('require-observation') ? { requireObservation: true } : {}),
    ...(typeof flag('verify') === 'string' ? { verify: flag('verify') } : {}),
  })
  emit(env, env.ok ? 0 : 2)
}

emit({ ok: false, error: `unknown command ${JSON.stringify(command)}（试 aura --help）`, code: 'USAGE' }, 1)
