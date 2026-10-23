/**
 * repo-map.mjs —— **仓库级粗粒度地图**（T26）：`aura_basetools_read <目录>` 该回什么。
 *
 * ## 为什么不是“文件的 map 的 map”
 *
 * 文件级 `map` 之所以便宜，靠“重要性排序 + 预算填充”把几百个符号压到几十行。
 * 放大到仓库规模，这条路直接爆预算（2884 个文件 × 每文件一行 = 2884 行）。
 * 所以换一种**粗粒度**：目录 → 模块，而不是符号 → 行。
 *
 * ## 设计约束（全部来自实测，不是偏好）
 *
 * 1. **必须先选候选、再读内容**。实测（`_map-probe`，本机 Windows/NTFS）：
 *    给每个源文件读 8 KiB 文件头，2884 个文件的仓库要 **14.1 秒**、756 个要 3.7 秒。
 *    而只遍历目录只要 107 ms / 27 ms。⇒ 内容读取必须**只发生在被选中的少数文件上**。
 *    这不是优化，是“能不能用”的分界：十几秒的探索工具没人会用第二次。
 * 2. **预算由框架剪枝阀派生**（与 `directoryHint` 同一条）：`dsh-compaction-tool-result-pruner`
 *    对超过 8192 字符的工具结果保留 前 4096 + marker + 后 1024，中间**静默移除**。
 *    所以这里自己先截、自己先说（`omitted` / `truncated`），不让下游默默抽掉。
 * 3. **不得新增必填参数**（T26 原文）：模型的 `mode` 主动选择率只有 4%，它宁愿让工具选。
 *    所以地图由 `auto` 在“目标是目录”时自己选，不给模型多一个决策。
 * 4. **忽略规则只住一份**：两个宿主壳（DSH / 独立 CLI）各有自己的目录读取 API，
 *    但“哪些目录不看、哪些扩展名算源码、候选怎么排”必须是同一套判据——
 *    否则两个面的地图会长得不一样。本文件导出 {@link MAP_SPEC} 与纯函数，
 *    宿主只负责“按规范把字节取回来”。
 *
 * ## 这个文件不做 I/O
 *
 * 与 `locator-lab` 的其余部分一致：宿主提供 `listDir` / `readHead`，本文件只做判据与渲染。
 * 这样 DSH 壳（`ctx.fs`）与独立 CLI（`node:fs`）共用同一份地图逻辑。
 */
import { langOf } from './struct-core.mjs'

/** 目录遍历规范：宿主照着走，判据只有这一份。 */
export const MAP_SPEC = {
  /**
   * 这些**目录**不看：既不下钻，自己也不进地图。
   *
   * 只放“几乎不可能是人类维护的源码”的那些：依赖树、版本控制元数据、缓存、虚拟环境、
   * 编译中间产物（`target/` 是 Rust 的、`__pycache__` 是 Python 的、`site-packages` 是 virtualenv 的）。
   *
   * **刻意不放 `dist/` / `build/` / `out/`**：很多项目的**手写源码就在那儿**（尤其打包型前端），
   * 把它们一律跳过会让地图凭空少一大块——而漏掉的模块在地图上表现为“不存在”，比多列几个目录坏得多。
   * 宁可多列，不可少列：这张地图的读者是一个会真去读那些文件的 agent。
   */
  ignoreDirs: new Set([
    'node_modules',
    '.git',
    '.hg',
    '.svn',
    '__pycache__',
    '.venv',
    'venv',
    'env',
    '.tox',
    'target',
    '.next',
    '.nuxt',
    '.cache',
    'coverage',
    '.pytest_cache',
    '.mypy_cache',
    '.ruff_cache',
    'dist-info',
    'site-packages',
    '.idea',
    '.vscode',
  ]),
  /**
   * 哪些扩展名算“模块”。
   *
   * 刻意**不含** `.json` / `.yml` / `.md`：它们是数据与文档，不是模块。
   * 地图回答的是“这个仓库由哪些模块组成”，把 500 个数据文件混进来会把模块淹掉。
   * （T26 的原始观察是模型在建“模块地图”，数据文件对那个目的只是噪声。）
   */
  sourceExtensions: new Set([
    '.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts',
    '.py', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.rb', '.php', '.cs',
    '.c', '.h', '.cc', '.cpp', '.hpp', '.swift', '.m', '.mm',
    '.sh', '.bash', '.zsh', '.ps1', '.lua', '.pl', '.r', '.jl', '.dart',
    '.ex', '.exs', '.erl', '.hs', '.ml', '.mli', '.clj', '.cljs', '.vue', '.svelte',
  ]),
  /** 递归上限：再深的目录对“仓库结构”这个目的没有信息量，只是把预算吃掉。 */
  maxDepth: 12,
  /** 单个文件最多读多少字节的文件头（提取 export / import 只需要开头）。 */
  headBytes: 4096,
  /**
   * 最多读几个文件的头。**这是性能与信息量的唯一旋钮**，见文件头第 1 条实测。
   *
   * 取 120 的依据（实测，两次测量的差别本身就是结论）：
   *   · 冷盘首次读 120 × 4 KiB = **638 ms**（5.3 ms/文件）；
   *   · 同样 120 个文件第二次读 = **8 ms**（0.07 ms/文件）。
   * 也就是说付钱的是“第一次把那些块从盘上拉起来”，而探索仓库本来就是冷启动场景。
   * 638 ms 对一次要花掉模型好几轮来回的探索任务是可以接受的上限；
   * 再往上加会线性推高冷启动成本，而地图的信息量并不会跟着涨（后面都是不重要的小文件）。
   */
  maxSampled: 120,
  /** 最多列几个“被依赖最多”的模块。 */
  maxModules: 24,
  /** 最多列几个入口。 */
  maxEntries: 12,
  /** 目录树里最多列几个目录（按文件数排序）。 */
  maxDirs: 40,
  /** 单条 import 值不值得记（太长的多半是拼出来的路径，不是模块名）。 */
  maxSpecifierChars: 120,
}

/** 地图的输出预算。与 {@link directoryHint} 同一条依据（框架剪枝阀）。 */
export const MAP_BUDGET = 7600

/**
 * 目录名对“看起来像源码目录”的权重。
 *
 * 这是**候选选择**用的，不是最终排名：先按路径把人造的/生成的目录排到后面，
 * 免得 120 个候选名额被 `fixtures/` 与 `vendor/` 吃光。
 * 权重的量级刻意小：它只用来打破“同分”的僵局，不该压过文件大小这种实打实的信号。
 */
const DIR_HINTS = [
  [/^(src|lib|app|core|pkg|internal|cmd|server|client|engine|tools?)$/i, 3],
  [/^(test|tests|spec|specs|__tests__|e2e|bench|benchmarks?|examples?|docs?|samples?|fixtures?|mocks?|vendor|third_party|generated|gen|build|out)$/i, -4],
]

/** 这些文件名说明它是入口（T26 三个问题之一：“入口点在哪”）。 */
const ENTRY_HINTS = /^(index|main|cli|app|server|mod|__init__|__main__)\.[a-z]+$/i

const posix = (p) => p.replaceAll('\\', '/')

/**
 * 从一条 import/export 语句里取模块说明符。
 *
 * 刻意写得**笨而全**：它只服务“谁被引用得多”这个粗信号，不必精确到 AST。
 * 各语言的写法差异（`import` / `from ... import` / `require` / `use` / `#include`）在这里穷举，
 * 比每种语言写一套解析器便宜得多，也不会因为某个语言没配置就整块失效。
 *
 * @param line - 一行源码
 * @returns 说明符字符串，取不到则 null
 */
export function specifierOf(line) {
  const t = line.trim()
  if (t.length === 0 || t.length > MAP_SPEC.maxSpecifierChars) return null
  /**
   * 注释行不算。
   *
   * **不要用正则去猜语言**：实测踩过一次——把 `'''` / `"""` 当“注释开头”时，
   * `tests/a.test.mjs`（一个正常的 JS 测试文件）被判成 Python 文档串，整个文件的 import 全丢。
   * 那种误伤的代价不对称：少算一条边只是排名差一点，而**整份文件消失**是看不见的（它不会报错）。
   * 所以这里只认三件**确定无误**的事：行首 `//`、行首 `#`（`#include` 除外，那是 C/C++ 的真 import）、
   * 行首 `--`（SQL / Lua / Haskell）。`*` 只在一行开头且单独成行时才算注释体。
   */
  if (/^(\/\/|#(?!include)|--)/.test(t)) return null
  if (/^\*+\s*$/.test(t) || /^\*\s/.test(t)) return null
  let m
  // import x from 'y' / import 'y' / export ... from 'y'
  if ((m = /^(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/.exec(t)) !== null) return m[1]
  if ((m = /^import\s*['"]([^'"]+)['"]/.exec(t)) !== null) return m[1]
  if ((m = /^(?:const|let|var)\s+[^=]*?=\s*require\(\s*['"]([^'"]+)['"]/.exec(t)) !== null) return m[1]
  if ((m = /^require\(\s*['"]([^'"]+)['"]/.exec(t)) !== null) return m[1]
  // Python: from y import z
  if ((m = /^from\s+([.\w]+)\s+import\b/.exec(t)) !== null) return m[1]
  // Go: import "y" —— 单个、不带 from
  if ((m = /^import\s+(?:[\w.]+\s+)?["`]([^"`]+)["`]/.exec(t)) !== null) return m[1]
  // Rust: use crate::a::b / mod x;
  if ((m = /^use\s+([\w:]+)/.exec(t)) !== null) return m[1]
  // C/C++: #include "y.h"
  if ((m = /^#include\s*[<"]([^>"]+)[>"]/.exec(t)) !== null) return m[1]
  // Ruby/PHP: require 'y' / require_relative 'y' / include 'y'
  if ((m = /^(?:require_relative|require|include|include_once|require_once)\s*\(?\s*['"]([^'"]+)['"]/.exec(t)) !== null) return m[1]
  return null
}

/**
 * 这份文件头里出现的模块说明符（去重）。
 *
 * **截断必须按行切**：字节上限可能把一条 `import` 切成半句，
 * 半句既解析不出说明符、又可能解析出**错的**说明符（`from './a` 这种）。
 * 所以丢掉最后一行（除非它以换行结束）。
 *
 * @param head - 文件头文本
 * @returns {string[]}
 */
export function specifiersIn(head) {
  if (typeof head !== 'string' || head.length === 0) return []
  const complete = head.endsWith('\n') ? head : head.slice(0, Math.max(0, head.lastIndexOf('\n')))
  const seen = new Set()
  for (const line of complete.split('\n')) {
    const spec = specifierOf(line)
    if (spec !== null) seen.add(spec)
  }
  return [...seen]
}

/** 路径的目录名权重之和。 */
function dirWeight(relPath) {
  let w = 0
  for (const seg of relPath.split('/').slice(0, -1)) {
    for (const [re, value] of DIR_HINTS) if (re.test(seg)) w += value
  }
  return w
}

/**
 * 从一条说明符里取“最可能的模块名”，用来把“谁引用了谁”连起来。
 *
 * 各语言的写法差异比看上去大，实测踩到过两个：
 *   · Python 的 `from util import helper` —— 说明符是 `util`，但**导入的名字**是 `helper`；
 *     要的是模块名 `util`，而 逗号 分开的多名字（`from a import b, c`）与 `as` 别名都要剔掉。
 *   · Rust 的 `use crate::a::b` / `use super::x` —— `crate`/`super`/`self` 是**路径前缀**不是模块名，
 *     取最后一段（与 `[/\\:]` 切分一致）。
/**
 * 从一条说明符得到“按优先级排的候选键”（最长 → 最短）。
 *
 * 各语言的写法差异在这里穷举，比每种语言写一套模块解析器便宜得多：
 *   · `./util.mjs` / `../lib/util` / `lib/util.mjs` —— 相对或仓库内路径
 *   · `from src.util import fmt` —— Python：点号是分隔符，**末段是文件名**
 *   · `use crate::a::b` —— Rust：`crate`/`super`/`self` 是前缀，不是模块名
 *   · `#include "util.h"` / `require('pkg')` —— 直接就是文件名
 *
 * 为什么不返回单个标识符：单标识符必须靠猜（猜“末段是文件名”还是“倒数第二段是文件名”），
 * 而那个猜测在两种语言上是相反的（见上面 repoMap 里第 1 条实测教训）。
 * 返回候选列表就把猜变成了查表：谁真存在谁就赢。
 *
 * @param spec - 说明符
 * @param selfPath - 引用方自己的相对路径（用于解 `./` 与 `../`）
 * @returns 候选键数组（可能为空）
 */
function candidateIds(spec, selfPath) {
  const withoutExt = spec
    .replace(/,.*$/, '')
    .replace(/\s+as\s+.*$/, '')
    .trim()
    .replace(/\.(mjs|cjs|js|ts|tsx|jsx|py|go|rs|rb|php|java|kt|cs|swift|c|h|cc|cpp|hpp|scala|ex|erl|hs|ml|clj|lua|pl|sh)$/i, '')
  if (withoutExt === '') return []
  // 分隔符归一：`/` 与 `\` 与 `::` 都是路径分隔；点号另说（可能是扩展名也可能是包分隔符，已在上面剥过一层）
  const normalized = withoutExt.replaceAll('::', '/').replaceAll('\\', '/')
  const raw = normalized.replaceAll('.', '/').split('/').filter((p) => p !== '')
  if (raw.length === 0) return []

  let parts = raw
  if (raw[0] === '.') parts = raw.slice(1)
  else if (raw[0] === '..') {
    // 相对上级：从引用方所在目录往上退，再拼上剩余段
    const dir = selfPath.split('/').slice(0, -1)
    let up = 0
    while (parts[up] === '..') up += 1
    parts = [...dir.slice(0, Math.max(0, dir.length - up)), ...raw.slice(up)]
  }
  if (parts.length === 0) return []
  // 语言前缀不是模块名（Rust 的 crate/super/self；Python 的相对导入会剩一个空段）
  while (parts.length > 0 && ['crate', 'super', 'self'].includes(parts[0])) parts = parts.slice(1)
  if (parts.length === 0) return []

  const out = []
  const push = (value) => {
    if (value !== '' && !out.includes(value)) out.push(value)
  }
  // 从最长（最具体）到最短
  for (let k = 0; k < parts.length; k += 1) push(parts.slice(k).join('/'))
  // 包目录：末段被当成文件名时，去掉它剩下的就是包路径（`src/util/fmt` → `src/util`）
  for (let k = 0; k < parts.length - 1; k += 1) push(parts.slice(k, parts.length - 1).join('/'))
  // `__init__.py` / `mod.rs` 这类“包本身”的另一种写法：`pkg.inner` 指向 `pkg/inner/__init__.py`
  if (parts[parts.length - 1] !== 'index' && parts[parts.length - 1] !== '__init__') {
    push(`${parts.join('/')}/__init__`)
  }
  return out
}

/**
 * 建一张仓库地图（纯函数：**不做 I/O**，宿主负责把字节取回来）。
 *
 * @param files - 文件记录：`{ relPath, bytes, head?, isEntry? }`（`head` 只在被选中读头的文件上有）
 * @param directories - 目录汇总：`{ relPath, files, bytes }[]`（相对根，`''` 表示根本身）
 * @param options.budget - 输出字符预算
 * @param options.root - 回执里显示的根路径
 * @param options.omittedFiles - 因遍历上限而没纳入的文件数（宿主统计）
 * @returns 与 `readWith` 同形的信封
 */
export function repoMap(files, directories, options = {}) {
  const budget = Number.isInteger(options.budget) && options.budget > 0 ? options.budget : MAP_BUDGET
  const root = options.root ?? '.'
  const rows = files.map((f) => {
    const relPath = posix(f.relPath ?? f.path)
    const ext = relPath.slice(relPath.lastIndexOf('.'))
    const lang = langOf(relPath)
    const file = relPath.slice(relPath.lastIndexOf('/') + 1)
    return {
      relPath,
      file,
      ext,
      lang,
      bytes: f.bytes ?? 0,
      entry: f.isEntry === true || ENTRY_HINTS.test(file),
      head: typeof f.head === 'string' ? f.head : null,
    }
  })

  /**
   * 提取每个**被采样**文件的模块说明符。
   *
   * ## 为什么这里**不数符号、不数导出**（一次实测后的结论，记下来免得重做）
   *
   * 第一版用 `indexStructure(文件头)` 算每个模块的符号数与导出数，直接印了一列
   * 「0 exports」给一个 2000 行、48 个导出的文件。原因不是解析器错，而是**问题本身错了**：
   * 我们只读了文件头（4 KiB），而结构索引需要**整份文件**才能建。
   * 于是那一列在真实仓库里是“**文件的导出都长在开头**”这个假设的产物——
   * 长文件全报 0，短文件报真值，而读者无法从回执里分辨这两种情况。
   *
   * 零是**最坏的一种错**：它看起来像一个测量结果，而不像“不知道”。
   * 现在只报**从文件头真正看得见**的东西——它 import 了什么。
   * 想要导出面就用 `map`（它会读整份文件）或 `mode=search`，两者都把预算花在真正的结构上。
   */
  let sampled = 0
  for (const row of rows) {
    if (row.head === null) continue
    sampled += 1
    row.specifiers = specifiersIn(row.head)
  }

  /**
   * 入向引用：把说明符解析到仓库里的某个文件上。
   *
   * ## 两条被实测教训过的规则
   *
   * 1. **不按 basename 单键索引**。第一版就是那样：`./util` 与 `../lib/util` 都映射到 `util.*`。
   *    它在 JS 的相对导入上恰好能用（末段就是文件名），但在**点号分隔路径**的语言上直接错：
   *    `from src.util import fmt` 里被导入的文件是 `fmt`，而 `util` 只是**包名**。
   *    实测后果：`src/util/fmt.mjs` 少算了一条边。
   * 2. **从最长候选往下试**（`src/util/fmt` → `util/fmt` → `fmt`）。
   *    只取最后一段会把 `./x/index.mjs` 指到 **`index` 键**上，而那个键可能是另一个文件
   *    （`a/index.mjs`）——那就不是“少算一条边”而是**算错一条边**，比没算更坏。
   *    按路径尾部匹配时，`x/index` 会先输给真存在的那个 `x/index`。
   *
   * 仍是**粗信号**：不解析 tsconfig 路径别名、不跟包入口字段。那些不值这个价——
   * 地图只回答“谁重要”，不回答“import 得对不对”。
   */
  const byCandidate = new Map()
  const addCandidate = (key, row) => {
    if (key === '') return
    if (!byCandidate.has(key)) byCandidate.set(key, [])
    byCandidate.get(key).push(row)
  }
  for (const row of rows) {
    const noExt = row.relPath.replace(/\.[^.]+$/, '')
    const parts = noExt.split('/')
    // 每一种**路径尾部**都登记：`src/util/fmt` / `util/fmt` / `fmt`
    for (let k = 0; k < parts.length; k += 1) addCandidate(parts.slice(k).join('/'), row)
    // 目录包：`src/util/fmt.mjs` 能被 `from src.util import ...` 命中靠的是 `src/util` / `util`
    for (let k = 0; k < parts.length - 1; k += 1) addCandidate(parts.slice(k, parts.length - 1).join('/'), row)
  }
  for (const row of rows) row.inbound = 0
  for (const row of rows) {
    for (const spec of row.specifiers ?? []) {
      const candidates = candidateIds(spec, row.relPath)
      let hit = null
      for (const key of candidates) {
        const found = byCandidate.get(key)
        if (found !== undefined && found.length > 0) {
          hit = found
          break
        }
      }
      if (hit === null) continue
      for (const target of hit) {
        if (target === row) continue
        target.inbound += 1
      }
    }
  }

  // ── 目录汇总 ──
  const dirRows = (directories ?? []).map((d) => {
    const rel = posix(d.relPath ?? '')
    return { relPath: rel, files: d.files ?? 0, bytes: d.bytes ?? 0, depth: rel === '' ? 0 : rel.split('/').length }
  })
  for (const d of dirRows) {
    const prefix = d.relPath === '' ? '' : `${d.relPath}/`
    const members = rows.filter((r) => (prefix === '' ? true : r.relPath.startsWith(prefix)))
    d.inbound = members.reduce((a, r) => a + (r.inbound ?? 0), 0)
    d.entries = members.filter((r) => r.entry).length
  }

  /**
   * 排名：**先看“有多少个别的模块依赖它”**，再看入口身份，最后看体量。
   *
   * 为什么 inbound 排第一：地图要回答的是“这个仓库的核心在哪”，而“被引用最多”
   * 是最接近那个答案的廉价代理（T26 原文建议的代理之一就是这个）。
   * 文件数/字节数排最后：否则最大的目录永远第一——那只是“大”，不是“重要”。
   */
  dirRows.sort(
    (a, b) => b.inbound - a.inbound || b.entries - a.entries || b.files - a.files || a.relPath.localeCompare(b.relPath),
  )
  rows.sort(
    (a, b) => b.inbound - a.inbound || Number(b.entry) - Number(a.entry) || b.bytes - a.bytes || a.relPath.localeCompare(b.relPath),
  )

  const totalBytes = rows.reduce((a, r) => a + r.bytes, 0)
  const langs = new Map()
  for (const row of rows) {
    if (row.lang === null) continue
    langs.set(row.lang, (langs.get(row.lang) ?? 0) + 1)
  }
  const entries = rows.filter((r) => r.entry)

  // ── 渲染：按“信息密度”排列，预算不够时从上往下砍 ──
  // 顺序不是装饰：目录骨架回答“有什么”（每个模块都能在它里面被找到），
  // 重要模块回答“核心在哪”，入口回答“从哪读起”，最后一节回答“下一步怎么走”。
  // 后面几节被预算砍掉时，前面几节仍然完整——这就是这个顺序存在的理由。
  /** 只用于“共几行”的统计；真正的预算收敛按段做（见 {@link sections}）。 */
  const lines = []
  const omitted = []
  /**
   * 分段记录：预算不够时**从后往前丢**，丢哪一节都自报。
   *
   * 为什么不用二分（第一版的做法）：那要先认出“哪一段是模块列表”、再把行号区间切出来，
   * 而“哪一段”这件事随渲染改动而变——两处得同步维护，正是本项目反复吃的“同一决策写两处”的亽。
   * 分段把边界变成数据：{@link push} 每进一节就记一笔。
   */
  const sections = []
  const push = (text, title = null) => {
    if (text === '') return
    const block = text.split('\n')
    for (const line of block) lines.push(line)
    lines.push('')
    sections.push({ title: title ?? block[0], lines: block })
  }
  push(
    [
      `repo ${root}`,
      `${rows.length} modules · ${(totalBytes / 1024).toFixed(0)} KiB · ${langs.size} language${langs.size === 1 ? '' : 's'}` +
        (files.length === 0 ? ' — no source files found under this path' : '') +
        (sampled < rows.length ? ` · ${sampled} sampled for imports` : ''),
    ].join('\n'),
  )

  // 1) 目录骨架：{@link rankCandidates} 之外的**每个**模块都能在这里被定位
  //
  // 根目录（`relPath === ''`）**不列**：它的汇总值与头部那行重复，而“0 modules, N inbound”
  // 这种行读起来像是根目录自己有 N 个入向引用（实测就这么印过）——自相矛盾的展示。
  // 头部的 `N modules · X KiB · L languages` 已经把全仓汇总说完了。
  /**
   * 目录骨架：**没有子目录时整节不出现**。
   *
   * 实测（本机读 `src/locator-lab`，一个 47 文件的扁平目录）：
   * 回执开头是 `directories (0):` 一个空标题，接着模块清单的第一行是 `./`。
   * 两处都是噪声：一个 0 项的标题看起来像“我漏列了目录”，而 `./` 在扁平目录里
   * 对读者零信息（他本来就在这个目录里）。现在只在这种情形下印一行说明。
   *
   * 单数要一起换：第一版只把名词加了 `s`，于是 1 个模块时印出 `all 1 module **are** …`——
   * 而这行恰恰最容易在“单文件目录”上出现（我实测一个 1 模块目录时就碰到了）。
   */
  const childDirs = dirRows.filter((d) => d.relPath !== '')
  const only = rows.length === 1
  push(
    childDirs.length === 0
      ? `all ${rows.length} module${only ? '' : 's'} ${only ? 'is' : 'are'} directly in this directory (no subdirectories)`
      : `directories (${childDirs.length}):`,
    'the directory skeleton',
  )
  const dirLines = []
  for (const d of childDirs.slice(0, MAP_SPEC.maxDirs)) {
    dirLines.push(
      `  ${d.relPath}  — ${d.files} module${d.files === 1 ? '' : 's'}, ${d.inbound} inbound${d.entries > 0 ? `, ${d.entries} entry` : ''}, ${(d.bytes / 1024).toFixed(0)} KiB`,
    )
  }
  if (childDirs.length > MAP_SPEC.maxDirs) {
    dirLines.push(`  … ${childDirs.length - MAP_SPEC.maxDirs} more directories (not listed)`)
    omitted.push(`${childDirs.length - MAP_SPEC.maxDirs} directories beyond the top ${MAP_SPEC.maxDirs} are not listed`)
  }
  push(dirLines.join('\n'))

  /**
   * 逐模块文件清单（按目录分组）。
   *
   * ## 为什么必须全列（这是 T26 验收②的兑现，也是我第一版的错）
   *
   * 第一版只把**有入向边**的模块列出来（“最被依赖的模块”那一节），于是“能从中定位到指定模块”
   * 只对**被别人引用过**的模块成立。测试当场抽到三个反例：`src/legacy.mjs`（没人 import）、
   * `tests/a.test.mjs`（测试文件本来就少被 import）、`tools/gen.py`（入口脚本）——
   * 它们**真实存在**，却在地图里找不到。而探索仓库时最先要问的恰恰是“有没有一个叫 X 的文件”。
   *
   * ## 为什么这个成本付得起
   *
   * 实测（本仓 64 模块 / 866 模块 / 2884 模块三个仓）：
   * 每模块一个名字的字符成本 ≈ 16 字符，所以 866 个模块 ≈ 14 KB——**超预算**。
   * 所以它必须可丢：它排在目录骨架之后、其它节之前，预算不够时它是第一个被完整舍掉的。
   * 结果是：小仓库（开发者日常在改的那一类，几十到几百模块）能拿到**完整模块清单**，
   * 大仓库退回“目录 + 重要模块”，而舍掉什么会写进 `omitted`。
   */
  /**
   * 逐模块清单：**按目录分组，但每个模块印全路径**。
   *
   * 为什么不用缩写（第一版的写法：`  scripts/  gen.py`）：那样读者必须自己把目录名和文件名拼起来，
   * 而这份清单的**全部目的**就是给出一串能直接拿去用的 `file_path`。
   * 实测代价：全路径每条约 3–8 字符，866 模块的仓多出约 6 KB——但那条路本来就会因超预算而丢掉整节（见下），
   * 而小仓库上多付几 KB 换“可直接使用”是值的。
   * 目录分组保留：它让“这个目录里有什么”一眼可见（这才是粗粒度）。
   */
  const byDir = new Map()
  for (const r of rows) {
    const slash = r.relPath.lastIndexOf('/')
    const dir = slash === -1 ? '.' : r.relPath.slice(0, slash)
    if (!byDir.has(dir)) byDir.set(dir, [])
    byDir.get(dir).push(r.relPath)
  }
  for (const names of byDir.values()) names.sort()
  /**
   * 目录分组行：**根本身（`dir === '.'`）不缩进、不带头**。
   *
   * 实测：扁平目录（47 个文件全在 `./`）下会印出
   * ```
   * modules (47):
   *   ./
   *     adapters.mjs
   * ```
   * `./` 那一行对读者零信息（他本来就在这个目录里），而多一层缩进让所有文件名都往后挪两个字符。
   * 扁平目录恰恰是最常见的一种（一个 `src/` 里一堆文件），所以这一格值得对齐。
   */
  const groupLines = []
  for (const [dir, names] of [...byDir.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (dir === '.') groupLines.push(...names.map((n) => `  ${n}`))
    else groupLines.push(`  ${dir}/`, ...names.map((n) => `    ${n}`))
  }
  push([`modules (${rows.length}):`, ...groupLines].join('\n'), 'the module list')

  // 2) 最被依赖的模块：地图的主答案（“核心在哪”）
  const withInbound = rows.filter((r) => r.inbound > 0)
  const moduleRows = withInbound.slice(0, MAP_SPEC.maxModules)
  push(
    `most depended-on modules (${moduleRows.length} of ${withInbound.length}):\n` +
      moduleRows
        .map((r) => `  ${r.relPath}  — imported by ${r.inbound}${r.entry ? ', entry' : ''}${describeModule(r) === '' ? '' : ` · ${describeModule(r)}`}`)
        .join('\n'),
    'the most depended-on modules',
  )
  if (withInbound.length > moduleRows.length) {
    omitted.push(`${withInbound.length - moduleRows.length} modules with inbound imports are not listed`)
  }

  // 3) 入口：T26 三个问题之一（“从哪读起”）。全仓入口通常很少，全列也便宜。
  const entryRows = entries.slice(0, MAP_SPEC.maxEntries)
  push(
    entryRows.length === 0
      ? 'entry points: none recognised by name (index/main/cli/app/server/mod/__init__)'
      : `entry points (${entryRows.length}${entries.length > entryRows.length ? ` of ${entries.length}` : ''}):\n` +
          entryRows.map((r) => `  ${r.relPath}  — ${r.bytes} B, ${describeModule(r) || 'no local imports in the first 4 KiB'}`).join('\n'),
    'the entry points',
  )
  if (entries.length > entryRows.length) omitted.push(`${entries.length - entryRows.length} entry points are not listed`)

  // 4) 可追问的指令（T26 原文：“输出形态应是可追问的目录”）
  /**
   * 什么时候该建议“缩小范围”。
   *
   * 实测（AuraPolaris 881 个模块）：`state/ab3/` 下的**工作区状态目录里塞着多份仓库副本**，
   * 于是同一棵 `skills/.../tools` 出现了 20 次，把地图的前半屏占满，
   * 而真正的 `tools/`（42 个模块）被排到最后（它自己的 inbound 少）。
   *
   * 地图**不隐瞒**这个事实（它忠实反映了磁盘上真有什么，那些副本确实在），
   * 但必须同时告诉读者“怎么把噪声切掉”，否则这一页会被误读成“这个仓库就是这样的”。
   * 判据只用两个已经算出来的数：有没有被预算截掉、以及“同名目录重复出多少份”。
   */
  const leafCounts = new Map()
  for (const d of childDirs) {
    const leaf = d.relPath.slice(d.relPath.lastIndexOf('/') + 1)
    leafCounts.set(leaf, (leafCounts.get(leaf) ?? 0) + 1)
  }
  const repeated = [...leafCounts].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1])[0]
  push(
    [
      'next:',
      '  read a module        → file_path=<path> (no mode needed)',
      '  one function inside  → file_path=<path>, around=<name>',
      '  who imports a module → file_path=<a module>, mode=search, search=<name>',
      ...(omitted.length > 0 || repeated !== undefined
        ? [
            '  narrow the scope     → file_path=<a directory from above> (the map then covers only that subtree)',
            ...(repeated === undefined
              ? []
              : [`  note: the directory name "${repeated[0]}" appears ${repeated[1]} times — likely copies or state snapshots, not ${repeated[1]} separate components`]),
          ]
        : []),
    ].join('\n'),
    'the next-step hints',
  )

  /**
   * 预算收敛：**优先舍逐模块清单**，其余按反向重要性从后往前丢。
   *
   * 为什么模块清单第一个舍：它是唯一**体量随仓库规模线性增长**的一节（实测 ≈16 字符/模块，
   * 866 模块的仓就要 14 KB）。其它节都是常数级的。
   * 而它的价值恰恰在**小仓库上最高**——日常在改的那一类只有几十个模块，那时它全额放得下，
   * 读者得到的是“这个仓库里到底有哪些文件”。大仓库上它只能列一部分，
   * 而“一部分文件清单”比“目录骨架 + 最被依赖的模块”信息量更低，所以宁可不列、并且说出来。
   *
   * 目录骨架与头部**永不丢**：它们是“定位一个模块”的最后保障。
   */
  let text = sections.map((s) => s.lines.join('\n')).join('\n\n')
  const moduleIndex = sections.findIndex((s) => s.title === 'the module list')
  if (text.length > budget && moduleIndex > 0) {
    const [dropped] = sections.splice(moduleIndex, 1)
    omitted.push(`${dropped.title} was dropped to fit the ${budget}-char budget`)
    text = sections.map((s) => s.lines.join('\n')).join('\n\n')
  }
  while (text.length > budget && sections.length > 2) {
    const dropped = sections.pop()
    omitted.push(`${dropped.title} was dropped to fit the ${budget}-char budget`)
    text = sections.map((s) => s.lines.join('\n')).join('\n\n')
  }
  if (text.length > budget) {
    text = `${text.slice(0, budget)}\n… (truncated to the ${budget}-char budget)`
    omitted.push(`the map was truncated at the ${budget}-char budget`)
  }


  return {
    mode: 'repo',
    totalLines: lines.length,
    contentBudget: budget,
    label: `repo map of ${root}`,
    text,
    ...(omitted.length === 0 ? {} : { omitted: omitted.join('; '), next: 'read one module with file_path=<path> to go deeper' }),
    ...(options.omittedFiles > 0
      ? { note: `${options.omittedFiles} files beyond the traversal limits were not scanned` }
      : {}),
  }
}

/**
 * 一句话说明这个模块“是什么”。
 *
 * 刻意**不猜职责**（不写“这个模块负责 X”）：那是编出来的，模型会当真，
 * 而地图上一个编错的职责描述比没有描述坏得多——它会把探索引向错的文件。
 * 只写从文件头里**看得见**的东西：它引用了几个本地模块、以及被谁引用。
 * 看不见就返回空串（调用方会写成“no local imports in the first 4 KiB”，而不是留白）。
 */
function describeModule(row) {
  const specs = row.specifiers ?? []
  const local = specs.filter((s) => s.startsWith('.')).length
  const external = specs.length - local
  const bits = []
  if (local > 0) bits.push(`${local} local import${local === 1 ? '' : 's'}`)
  if (external > 0) bits.push(`${external} external`)
  return bits.join(', ')
}

/**
 * 建一张仓库地图：**引擎驱动遍历**，宿主只提供两件原始能力。
 *
 * 为什么不让两个宿主壳各写一遍遍历（第一版的写法）：遍历里藏着全部判据——
 * 忽略哪些目录、认哪些扩展名、候选怎么排、读多少字节、拿谁去排序。
 * 两个面各写一份的结果不是“多写几十行”，而是**两个面的地图会长得不一样**，
 * 而用户无法从回执里分辨自己看的是哪一份（DSH 与 CLI 是同一产品的两个入口）。
 *
 * 适配器（宿主实现，两三个方法就能接上）：
 *   · `listChildren(dir)` → `{ name, type, size?, target? }[]`（只列直接子项）
 *   · `readHead(entry, bytes)` → string（读不到就返回空串，**不要抛**：截断/权限都是常态）
 *   · `joinRel(dirRel, name)` → 相对路径（省略则拼 '/'；Windows 壳可换成 '\\'）
 *
 * @param adapter - 见上
 * @param root - 宿主自己的目录句柄（引擎不解释它，只传给 adapter）
 * @param options.rootPath - 回执里显示的路径
 * @param options.budget - 输出预算
 * @returns 与 `readWith` 同形的信封，外加 `modules` / `dirs` 两个计数
 */
export async function collectRepoMap(adapter, root, options = {}) {
  const files = []
  const directories = []
  const joinRel = adapter.joinRel ?? ((dirRel, name) => (dirRel === '' ? name : `${dirRel}/${name}`))

  /** 广度无关的深度优先遍历；只收集元数据，**一个字节都不读**。 */
  const walk = async (dir, dirRel, depth) => {
    if (depth > MAP_SPEC.maxDepth) return
    let children
    try {
      children = await adapter.listChildren(dir)
    } catch {
      return
    }
    let count = 0
    let bytes = 0
    for (const child of children) {
      // 隐藏目录不看（`.github` 例外：它常常是 CI 配置的所在地，但那不是模块，所以也跳过）
      if (child.name.startsWith('.')) continue
      const childRel = joinRel(dirRel, child.name)
      if (child.type === 'directory') {
        if (MAP_SPEC.ignoreDirs.has(child.name)) continue
        await walk(child.target, childRel, depth + 1)
        continue
      }
      if (child.type !== 'file') continue
      /**
       * **两道检查，各管一种东西**（第一版只有前一道，于是漏了一整类）：
       *
       *   1. 目录名在忽略表里 ⇒ 既不下钻，也**不把它的直接子文件当成模块收进来**。
       *      第一版只挡了“下钻”那一半：`node_modules/x.mjs` 这种**直接子文件**照样进了地图。
       *   2. 名字以点开头 ⇒ 跳过（`.gitignore` / `.env` / `.eslintrc.js` 不是模块）。
       *      点目录在上面已经被挡过一次（`child.name.startsWith('.')`），这里盖的是**文件**那一半。
       *
       * 同一个忽略表服务两类条目（目录 / 文件）——测试里确好有一格是 `.venv/site.mjs`，
       * 也就是“忽略目录的直接子文件”，它跳过靠的就是第 1 条。
       */
      if (MAP_SPEC.ignoreDirs.has(child.name)) continue
      if (child.name.startsWith('.')) continue
      if (!isModulePath(child.name)) continue
      files.push({ relPath: childRel, bytes: child.size ?? 0, target: child.target })
      count += 1
      bytes += child.size ?? 0
    }
    if (depth > 0 && count > 0) directories.push({ relPath: dirRel, files: count, bytes })
  }
  await walk(root, '', 0)

  // 只给**被选中**的候选读头：未选中的文件从不会被打开。
  // 这一步的顺序是整个设计的性能关键，依据见 MAP_SPEC.maxSampled 的注释。
  const chosen = rankCandidates(files).slice(0, MAP_SPEC.maxSampled)
  for (const file of chosen) {
    try {
      file.head = await adapter.readHead(file.target, Math.min(file.bytes, MAP_SPEC.headBytes))
    } catch {
      file.head = null
    }
  }

  const env = repoMap(files, directories, { root: options.rootPath ?? String(root), budget: options.budget })
  return { ...env, modules: files.length, dirs: directories.length }
}

/** 供调用方（宿主壳）复用：这个扩展名算不算模块。 */
export function isModulePath(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  return MAP_SPEC.sourceExtensions.has(ext)
}

/**
 * 候选排序：**在读任何内容之前**决定谁值得读。
 *
 * 依据只有三样不需要读文件的东西：路径深度（浅的更能代表结构）、
 * 目录提示词（`src/` 加分、`fixtures/` 减分）、字节数（大文件信息多）。
 * 排序结果只用来决定 {@link MAP_SPEC.maxSampled} 个名额给谁。
 *
 * @param entries - `{relPath, bytes}[]`
 * @returns 排好序的副本（不改原数组）
 */
export function rankCandidates(entries) {
  return [...entries].sort((a, b) => {
    const sa = candidateScore(a)
    const sb = candidateScore(b)
    return sb - sa || a.relPath.localeCompare(b.relPath)
  })
}

function candidateScore(entry) {
  const relPath = posix(entry.relPath)
  const depth = relPath.split('/').length - 1
  const file = relPath.slice(relPath.lastIndexOf('/') + 1)
  // 入口加分：地图三个问题之一是“入口在哪”，入口必须先被读到。
  const entryBonus = ENTRY_HINTS.test(file) ? 6 : 0
  /**
   * 目录提示词的权重，**再乘上一个**“入口免疫”系数。
   *
   * 实测踩过：`scripts/gen.py`（一个真入口脚本）因为所在目录命中 `tools?/scripts?` 的 -4 提示，
   * 被挤出 {@link MAP_SPEC.maxSampled} 个候选之外 ⇒ 它的 import 边全丢、在地图的**模块清单里虽然还在**
   * 但从不被读。而入口恰恰是地图三个问题之一（“从哪读起”），把它排到候选之外是自相矛盾。
   *
   * 所以规则写成两句：**入口不因目录名被降级**；非入口才吃目录提示词的乘法。
   */
  const hint = entryBonus > 0 ? Math.max(0, dirWeight(relPath) * 3) : dirWeight(relPath) * 3
  // 深度惩罚刻意弱（每层 1 分）：浅的优先，但不能把 `src/a/b/c.mjs` 这种核心模块挤掉
  return hint + entryBonus - depth
}
