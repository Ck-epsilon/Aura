#!/usr/bin/env node
/**
 * aura CLI（薄壳）：参数解析 → `lib/ops.mjs` → 一行 JSON。
 *
 *   aura read  --file F [--mode …] [--around X] [--lines a,b] [--search S] [--since V] [--max-chars N]
 *   aura edit  --file F (--hunks '<json>' | --hunks-file P) [--dry-run] [--create <文本|@文件>]
 *   aura mcp                     启动 MCP stdio 服务（Codex / Claude Code / Cursor …）
 *   aura --help | --version
 *
 * 退出码：0 成功；2 结构化拒绝（回执带 code/next 一类信息）；1 用法错误。
 */
import fs from 'node:fs'
import process from 'node:process'
import { openProvider, readEnvelope, editEnvelope } from '../lib/ops.mjs'
// 平铺形状与行区间收敛同住一层（`locator-lab/args.mjs`），DSH 壳与 CLI 共用同一份容错规则。
import { flatHunk } from '../locator-lab/args.mjs'

// 版本从包自己的 package.json 读（写死过一次，对外报的版本就停在旧值）；开发树里取不到报 dev
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return 'dev'
  }
})()
const argv = process.argv.slice(2)

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
const BOOLEAN_FLAGS = new Set(['pretty', 'dry-run'])
const isBooleanFlag = (token) => typeof token === 'string' && BOOLEAN_FLAGS.has(token.replace(/^--/, ''))

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

const USAGE = [
  `aura ${VERSION} —— 按意图读写文件（独立版：不依赖 DeepSeek Harness，Windows / macOS / Linux 同形）`,
  '',
  '  aura read  --file <路径> [--mode map|digest|full|around|lines|search|changed]',
  '             [--around <符号>] [--lines <a,b>|<a-b>|<n>] [--start-line <n> --end-line <n>]',
  '             [--search <子串>] [--since <令牌>] [--max-chars <n>]',
  // `--file` 指向**目录**时直接给一张仓库地图（模块/目录/依赖方向），不需要额外旗标。
  '             （--file 传目录 ⇒ 仓库地图：模块清单 + 目录骨架 + 被依赖最多的模块 + 入口点）',
  "  aura edit  --file <路径> --create <内容|@文件>                     # 建文件（不必再给 --hunks）",
  "  aura edit  --file <路径> (--hunks '<json>' | --hunks-file <路径>) [--dry-run]",
  '   aura edit  --file <路径> --lines <a,b> --replace <文本> [--expect <文本>] [--near <n>]',
  "              （只改一处时不必包成 JSON：--target / --lines / --start-line+--end-line / --line-cue / --anchor 任选其一）",
  '  aura mcp                    启动 MCP stdio 服务',
  '  aura --help | --version',
  '',
  'hunks 形状：[{"target":"符号名"|"lines":[a,b]|"line_cue":"唯一词"|"anchor":"记得的原文",',
  '              "replace":"替换文本","expect":"该处应是什么","near":行号}]',
  '',
  '例：',
  "  aura edit --file a.mjs --hunks '[{\"lines\":[5,5],\"replace\":\"x\"}]'   # 单引号包住整段 JSON",
  '  aura edit --file a.mjs --hunks-file hunks.json                        # 内容走文件，绕开引号',
  '  aura edit --file new.md --create @body.md                             # @文件 ——推荐给长内容',
  '  aura edit --file new.md --create=---                                  # 值以 -- 开头时必须用 = 形式',
  '  aura read --file ./src                                                # 目录 ⇒ 仓库地图',
  '',
  'PowerShell 两个已踩过的坑：',
  '  · 反引号 `n 写进 JSON 字符串会变成控制字符（JSON 不允许）⇒ 用 --hunks-file 或单引号 heredoc；',
  '  · 5.1 的 Set-Content -Encoding UTF8 默认写 BOM ⇒ 本工具会剥掉前导 BOM，但更早的工具链可能不认。',
  '加 --pretty 输出多行 JSON。先 read 拿令牌，再 edit——编辑会核对“这块区域在你读之后有没有被改过”。',
].join('\n')

const command = argv[0]
if (command === undefined || command === '--help' || command === '-h') emit({ ok: true, usage: USAGE }, 0)
if (command === '--version' || command === '-v') emit({ ok: true, version: VERSION }, 0)
if (command === 'mcp') {
  const { serve } = await import('./aura-mcp.mjs')
  await serve()
  process.exit(0)
}

const provider = openProvider(typeof flag('cwd') === 'string' ? flag('cwd') : process.cwd())

if (command === 'read' || command === 'outline') {
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
    since: flag('since'),
    // 光写 `--max-chars` 不带值时 flag() 回 true，Number(true)=1 会变成"预算 1 字符"这种怪值
    maxChars: typeof flag('max-chars') === 'string' ? Number(flag('max-chars')) : undefined,
  })
  emit(env, env.ok ? 0 : 2)
}

if (command === 'edit') {
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
    replace: flag('replace'),
    expect: flag('expect'),
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
          'edit 需要 --hunks/--hunks-file，或平铺一组地址旗标（--target / --lines / --start-line+--end-line / --line-cue / --anchor，外加 --replace），或 --create <整份内容>',
        code: 'USAGE',
      },
      1,
    )
  }
  const createRaw = flag('create')
  // `@文件` 形式：内容完全不经过命令行引号。创建含引号/换行/front matter 的内容时这是最稳的路。
  const create = typeof createRaw === 'string' && createRaw.startsWith('@') ? fs.readFileSync(createRaw.slice(1), 'utf8') : createRaw
  const env = await editEnvelope(provider, { file, hunks: hunks ?? [], dryRun: has('dry-run'), create })
  emit(env, env.ok ? 0 : 2)
  emit(env, env.ok ? 0 : 2)
}

emit({ ok: false, error: `unknown command ${JSON.stringify(command)}（试 aura --help）`, code: 'USAGE' }, 1)
