/**
 * struct-core —— 零依赖、跨语言的结构化定位器。
 *
 * 设计约束（为什么不是别的东西）：
 *
 * 1. **不写"每语言一个解析器"。** 那样每加一门语言就要改一处解析代码，是补丁的温床。
 *    这里把差异全部收敛进配置表：注释语法、字符串语法、符号识别规则。扫描器只有一份。
 *
 * 2. **不假装是完整 AST。** 全量语法分析要引依赖（tree-sitter/typescript），且把通用工具
 *    绑死在特定语言上。这里建的是**词法级结构**：token 流 + 括号配平的作用域树 + 声明符号表。
 *    它回答的是定位问题真正需要的那部分——"这个文件里有哪些命名区域、它们从哪到哪"。
 *
 * 3. **不需要时不算。** 建索引有成本，因此只在文本层够不到的时候才建（见 locate 的调用方）。
 *
 * 对外只给三件事：`indexStructure` 建索引、`resolveTarget` 按符号/结构解析目标、
 * `regionConfidence` 给任意区域打分。三者都是纯函数、无 I/O、无语言专属分支。
 * 唯一的内部状态是 `indexStructure` 手里那层**内容派生的记忆化缓存**（见该函数上方注释）：
 * 它不改变任何返回值，只是让同一份内容不再被重复解析。
 */

// ── 通用字符扫描器 ─────────────────────────────────────────────────────────

/**
 * `/` 出现在这里时，它可能是正则的开头吗？
 *
 * 只看 token 流里**前一个 token**，不回溯文本。规则是"前面不可能结束一个表达式"：
 *   · 没有前一个 token（文件开头）
 *   · 前一个是标点，但**不是** `)` `]` `}` `++` `--`（这些能结束一个表达式，
 *     所以后面跟的 `/` 是除号）
 *   · 前一个是关键字，且该关键字后面期待一个表达式（`return /x/` `typeof /x/` `case /x/`）
 * 其余情况（前一个是标识符、数字、字符串、正则、或闭合括号）都判为除号。
 *
 * 这是启发式而非精确规则——`if (x) /re/.test(y)` 这种写法会被判成除法。
 * 代价可接受且方向正确：误判成除法的后果是回到**修复前**的行为（正则被当标点），
 * 而误判成正则的后果是吃掉一小段文本。前者是本文件最贵 bug 的成因，因此判据偏向识别正则。
 *
 * @param tokens - 已产出的 token 流
 * @returns 真表示此处的 `/` 应按正则字面量处理
 */
/**
 * 这个 token 出现在这里时，后面还期待一个表达式吗？
 *
 * 同一个问题有两个消费者：`/` 是不是正则的开头，以及换行处表达式要不要续行。
 * 因此只有一份实现——两份实现必然会在某个空白/标点组合上不一致，而那种不一致极难发现。
 *
 * @param prev - 前一个 token（可能不存在）
 * @returns 真表示"后面还期待表达式"
 */
function tokenExpectsExpression(prev) {
  if (prev === undefined) return true
  if (prev.type === 'punct') {
    // `)` `]` `}` `++` `--` 能结束一个表达式，因此后面不期待新表达式
    return ![')', ']', '}', '++', '--'].includes(prev.value)
  }
  if (prev.type === 'ident') {
    // 只有"后面期待表达式"的关键字才算；`x / y` 里 x 是标识符 → 不期待
    return REGEX_PRECEDING_KEYWORDS.has(prev.value)
  }
  return false
}

function previousTokenAllowsRegex(tokens) {
  return tokenExpectsExpression(tokens[tokens.length - 1])
}

/**
 * 前面出现它们时，`/` 更可能是正则的开头而不是除号。
 * 刻意保持很小：这是**词法**判据，不是关键字表，因此不放进按语言的 `keywords`。
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw',
])

/**
 * 把源码扫成 token 流。
 *
 * 语言差异只体现在 `lang` 的注释/字符串配置上；扫描逻辑本身不含任何语言判断。
 * 关键不变式：**注释与字符串已经吃掉了，因此 symbol 规则永远不会被注释里的词或
 * 字符串里的 "function" 触发**——这是它比纯文本匹配结构上更强的地方。
 *
 * @param {string} src - 源码全文
 * @param {object} lang - 语言配置（见 LANGS）
 * @returns {Array<{type, value, line, start, end}>} token 流；type ∈ ident/number/string/punct
 */
function tokenize(src, lang) {
  const tokens = []
  const n = src.length
  let i = 0
  let line = 1
  const { lineComments, blockComments, strings, backtick } = lang

  const push = (type, start, end) => {
    tokens.push({ type, value: src.slice(start, end), line, start, end })
  }

  while (i < n) {
    const c = src[i]
    if (c === '\n') {
      line += 1
      i += 1
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i += 1
      continue
    }

    // 注释：整体吃掉，且**不产出 token**
    let matchedComment = false
    for (const lc of lineComments) {
      if (!src.startsWith(lc, i)) continue
      /**
       * 行注释的**起始限制**：某些语言里注释符在特定上下文中是合法字符。
       *
       * 具体是 shell：`#` 起注释，但 `$#`（参数个数）与 `${#var}`（长度）里它是操作符的一部分。
       * 没有这道限制，`echo $#` 之后的内容会被当注释整行吃掉——而"整行被吃掉"是**静默**的，
       * 表现为后面的声明凭空消失，极难定位。
       *
       * 这是语言相关的真差异，因此与其他差异一样进配置表，不进扫描器逻辑。
       */
      const blockers = lang.commentBlockers?.[lc]
      if (blockers !== undefined && i > 0 && blockers.includes(src[i - 1])) continue
      while (i < n && src[i] !== '\n') i += 1
      matchedComment = true
      break
    }
    if (matchedComment) continue
    for (const [open, close] of blockComments) {
      if (src.startsWith(open, i)) {
        i += open.length
        while (i < n && !src.startsWith(close, i)) {
          if (src[i] === '\n') line += 1
          i += 1
        }
        i = Math.min(n, i + close.length)
        matchedComment = true
        break
      }
    }
    if (matchedComment) continue

    // 字符串：整体吃掉，产出一个 string token（不暴露内部标识符）
    let matchedString = false
    for (const [open, close] of strings) {
      if (!src.startsWith(open, i)) continue
      const start = i
      i += open.length
      while (i < n) {
        if (src[i] === '\\') {
          i += 2
          continue
        }
        if (src[i] === '\n') line += 1
        if (src.startsWith(close, i) && i > start + open.length - 1) {
          i += close.length
          break
        }
        i += 1
      }
      push('string', start, Math.min(i, n))
      matchedString = true
      break
    }
    if (matchedString) continue

    /**
     * 正则字面量：整体吃掉。
     *
     * 判据 `previousTokenAllowsRegex` 只看**前一个 token**——这是唯一不需要回溯猜测的通用规则：
     * 只有前面不可能结束一个表达式时，`/` 才可能是正则的开头。
     * 字符类 `[...]` 内部的 `/` 不是结束符（`/[/]/` 合法），因此要单独跟踪。
     * 转义（`\/` `\[`）必须跳过，否则 `\(` 会留下不配对的 open，
     * 而 `matchBrackets` 一旦失衡，其后的声明跨度全部错乱。
     */
    if (lang.regexLiterals !== undefined && c === lang.regexLiterals.open && previousTokenAllowsRegex(tokens)) {
      const start = i
      i += 1
      let inClass = false
      while (i < n) {
        const rc = src[i]
        if (rc === '\n') break // 未闭合的正则只可能是一行，别吃掉整个文件
        if (rc === lang.regexLiterals.escapes) {
          i += 2
          continue
        }
        if (rc === '[') inClass = true
        else if (rc === ']') inClass = false
        else if (rc === lang.regexLiterals.close && !inClass) {
          i += 1
          break
        }
        i += 1
      }
      push('regex', start, Math.min(i, n))
      continue
    }

    // 模板串（JS）：整体吃掉，但**内部 ${} 不求值**——宁可漏识别，不可误识别
    if (backtick !== undefined && c === backtick.open) {
      const start = i
      i += 1
      while (i < n) {
        if (src[i] === '\\') {
          i += 2
          continue
        }
        if (src[i] === '\n') line += 1
        if (src[i] === backtick.close) {
          i += 1
          break
        }
        i += 1
      }
      push('string', start, Math.min(i, n))
      continue
    }

    // 标识符：ASCII 字母下划线 + 非 ASCII（覆盖中文标识符）
    if (/[A-Za-z_$\u0080-\uffff]/.test(c)) {
      const start = i
      while (i < n && /[A-Za-z0-9_$\u0080-\uffff]/.test(src[i])) i += 1
      /**
       * **连字符可作为标识符的一部分**（PowerShell 是唯一需要它的语言：`Get-Thing` 是**一个**名字）。
       *
       * 难点是同一个 `-` 在别处是减号。判据不新增名单，而是**复用已有的 `multiPunct` 表**：
       *   `-` 后面接的两个字符若是已知的多字符操作符（`-eq` `-ne` `-gt` …），它就是操作符；
       *   否则它是名字的一部分。
       * 于是 `Get-Thing` 里 `-Th` 不是操作符 → 名字继续；`$a -eq $b` 里 `-eq` 是操作符 → 停下。
       *
       * 代价（如实记录）：`$a-$b` 这类**无空格减法**会被并成一个标识符。
       * 这是可接受的取舍——误并的后果是少一个符号，而漏掉连字符名字会让 PowerShell
       * 的函数**全部**只剩第一段（实测 `Get-Thing` 被切成 `Get`）。
       */
      if (lang.dashInIdent === true) {
        while (src[i] === '-' && i + 1 < n && /[A-Za-z_\u0080-\uffff]/.test(src[i + 1])) {
          if (lang.multiPunct.includes(src.slice(i, i + 3))) break
          i += 2
          while (i < n && /[A-Za-z0-9_$\u0080-\uffff]/.test(src[i])) i += 1
        }
      }
      push('ident', start, i)
      continue
    }

    // 数字
    if (/[0-9]/.test(c)) {
      const start = i
      while (i < n && /[0-9a-fA-FxX._]/.test(src[i])) {
        // Erlang 的 `.` 既是语句终结符、又可能是小数点：`1.` 是整数 1 + 终结符，
        // `1.0` 才是浮点。只在 `.` 后面还有数字时把它算进数字，否则留给标点层。
        if (lang.dotTerminatesNumber === true && src[i] === '.' && !/[0-9]/.test(src[i + 1] ?? '')) break
        i += 1
      }
      push('number', start, i)
      continue
    }

    // 标点：**按表里最长的项优先**（T14）。
    //
    // 先前只看 2 字符窗口，于是表里写的 `===` / `!==` / `...` **永远匹配不到**——
    // 它们会被拆成 `==` + `=` 之类。后果是“表里写了、代码不认”的静默失败：
    // 将来任何测试 `===` 的规则都会永不命中，而看不出原因。
    // 现在按长度降序试：先试 3 字符，再 2，最后 1。
    let matched = 0
    for (const width of [3, 2]) {
      if (i + width > n) continue
      if (lang.multiPunct.includes(src.slice(i, i + width))) {
        push('punct', i, i + width)
        i += width
        matched = width
        break
      }
    }
    if (matched > 0) continue
    push('punct', i, i + 1)
    i += 1
  }
  return tokens
}

// ── 语言配置表（差异只在这里）──────────────────────────────────────────────
//
// 每门语言三条信息：注释、字符串、符号规则。**扫描器不含任何语言判断。**
//
// 规则里的原语：
//   `'word'`    字面量 token
//   `$name`     捕获符号名（决定声明跨度）
//   `$param`    跳过一个括号组（必选）
//   `$param*`   可选：有括号/泛型就跳，没有就跳过这一段（让有参无参共用一条规则）
//   `$mods*`    可选：吃掉任意个 `modifiers` 里的修饰符（让 public/static/final 组合共用一条规则）
//   `guard`     `notKeyword` 拒关键字；`memberName` 拒 `foo.bar(...)` 这种成员访问

/**
 * 正则字面量：**第三种词法类别**，先前配置表里没有它的位置。
 *
 * 这是本文件最贵的一个缺口，实测后果（`read-core.mjs` 自己就是最好的标本）：
 * 它 10 个顶层 `function` 声明里，**索引只认出 2 个**，其余 8 个凭空消失
 * （`renderChanged` `renderFull` `renderMap` `renderAround` `renderLines`
 * `renderSearch` `windowEnvelope` `fitWithin`），而已认出的 `renderDigest`
 * 跨度是 `69-69`（真实 69-164）。于是 `aura_basetools_edit target=<这些名字>` 全部
 * `STRUCT_NOT_FOUND`，而 `map` 把这些函数报成不存在——**本工具连自己的引擎都定位不了。**
 *
 * 机制：`/` 被当成普通标点，于是
 *   · 正则里的引号开了一个**字符串** token，把后面的代码整段吃掉
 *     （`/['"]/` 之后 `function after(){}` 消失）；
 *   · 正则里的转义括号（`\(`）留下一个**不配对的 open**，而每一个
 *     `declarationSpan` 与 `$param*` 跳过都依赖 `matchBrackets`——它一旦失衡，
 *     其后的声明跨度全部错乱。
 *
 * **只给真正有正则字面量的语言**（目前是 JS/TS），因此它挂在 `C_LIKE` 而不是
 * `C_LIKE_BASE` 上。Go / Rust / Java / C# / Kotlin / Swift / C / Scala / Dart 都没有
 * 正则字面量，`return a / b` 在它们那里是**除法**；若跟着 base 一起拿到这一项，
 * 那个 `/` 会被当成正则开头并吃掉后面的代码——即用一个新缺陷换掉一个旧缺陷。
 * 这条边界是实测出来的，不是推断：`C_LIKE_BASE` 被 10 个语言共用。
 */
const JS_REGEX_LITERALS = { open: '/', close: '/', escapes: '\\' }

/**
 * 换行处**能继续声明头部**的关键字。
 *
 * 头部扫描遇到换行时要回答"上一行的声明还有没有下文"：`class A extends B` 后面换行接
 * `implements C {`，那个 `implements` 不是新语句；`const ok = a` 后面换行接 `instanceof B`
 * 同理。这类关键字是语言相关的真差异，因此与 `modifiers`、`bodyOpen` 一样进配置表。
 *
 * 漏列一个的后果是跨度偏短，所以 `scanBodyOpen` 对**非 variable 种类**还有一道自检：
 * 换行处停在一个不是"声明起头"的关键字上时判为不确定 → fail-closed（见该函数）。
 */
const C_LIKE_HEADER_KEYWORDS = new Set(['extends', 'implements', 'as', 'satisfies', 'instanceof', 'in', 'of'])

/**
 * 配置里没写 `headerKeywords` 时的默认值：没有跨行子句。
 * 这不是"安全默认"，是"如实默认"：没有列出来的语言本来就不该在换行处续行。
 * 有跨行子句的语言（`extends` / `implements` / `where`…）必须在配置表里列出来。
 */
const NO_HEADER_KEYWORDS = new Set([])

/**
 * 块体**终结规则**：`bodyOpen: null` 的语言靠它把跨度补到真实末端。
 *
 * 这是配置表里第三条语言相关的真差异（前两条是注释与字符串语法）。缺了它，跨度就只有签名行，
 * 而后果是**静默**的：`aura_basetools_edit target=<函数名>` 只换掉签名、旧函数体原样留下，
 * `python -m py_compile` 仍然返回 0。因此判据在这里，与其它差异并列：
 *
 *   { style: 'indent' }                        缩进决定块体（Python / Cython）
 *   { style: 'closer', closer, openers, ... }  关键字配对（Ruby / Lua）
 *
 * **两者都没有的语言 = 跨度判不了**：符号被标记 `spanComplete: false`，`target=` 一律拒绝
 * （fail-closed），而不是交出一个偏短的跨度让调用方静默改错地方。
 *
 * `headerEnds` 是这四种差异里的第四种：头部**以什么 token 收尾**、块体从哪一行开始。
 * Python/Cython 是 `:`，OCaml/Haskell 的 `let … =` 是 `=`。缺省是 `:`，方向安全：
 * 某门语言的头若以别的 token 收尾，判据返回 -1 ⇒ fail-closed，而不是猜一个块体起点。
 */
const INDENT_BLOCK = { style: 'indent', headerEnds: new Set([':']) }

/**
 * 语句**终结符**收尾的块体（SQL 的 `;`、Erlang 的 `.`、Vim 的 `endfunction`）。
 *
 * 为什么不复用 `closer`：那一种是**开块词与收尾词配对计数**（Ruby 的 `if … end`），
 * 而这里的语言压根没有配对的收尾词——SQL 只有语句终结符，Erlang 的函数子句只有一个 `.`。
 * 硬套 `closer` 要给每条规则编一个假开块词，那是在配置里写谎话。
 *
 * `newlineStops` 默认 true：没有终结符时，换行是安全方向的兜底（SQL 的多语句、Vim 的无尾声明）。
 * Erlang 关掉它：函数体的换行是普通空白，唯一合法的收尾是 `.`；开启会把多行函数体截在签名行。
 * 关掉后必须在文件内找到终结符，否则跨度判为不完整（fail-closed）——见 terminatorBlockEnd。
 */
const TERMINATOR_BLOCK = (terminators, { newlineStops = true } = {}) => ({
  style: 'terminator',
  terminators: new Set(terminators),
  newlineStops,
})


/**
 * 除 `bodyOpen` 之外还算块开符的字符：`[` —— `const X = [ … ]` 这种字面量体。
 *
 * 刻意**不含 `(`**：`(` 是参数表/调用实参的括号，把它算成块开符会让
 * 每一个“参数表之后没有块括号”的声明塌成一行（Kotlin 的 `fun f(a: Int): Int {`）。
 * 需要用 `(` 当块体的语言（Lisp 家族）在配置里显式写 `bodyOpens: ['(']`。
 */
const DEFAULT_BODY_OPENS = new Set(['['])

/**
 * `end` 收尾的块体。字段全是数据，判据在 `closerBlockEnd` 里只有一份：
 *   · `openers`      开块词
 *   · `closer`       收尾词
 *   · `altCloser`    第二种收尾词（Lua 的 `repeat … until`）
 *   · `modifiers`    这些词**只有落在子句起始位置**才开块——Ruby 的 `puts x if y` 是后置修饰符
 *   · `markers`      跟在 `loopOpeners` 之后时是循环体的引导词，不额外计数（`for i=1,10 do`）
 */
const RUBY_BLOCK = {
  style: 'closer',
  closer: 'end',
  openers: new Set(['def', 'class', 'module', 'if', 'unless', 'while', 'until', 'for', 'case', 'begin', 'do']),
  modifiers: new Set(['if', 'unless', 'while', 'until']),
  markers: new Set(['do']),
  loopOpeners: new Set(['for', 'while', 'until']),
}

const LUA_BLOCK = {
  style: 'closer',
  closer: 'end',
  altCloser: 'until',
  openers: new Set(['function', 'if', 'for', 'while', 'do', 'repeat']),
  modifiers: new Set([]),
  markers: new Set(['do']),
  loopOpeners: new Set(['for', 'while']),
}

/** 行注释只有 `//`、字符串只有引号、块体是 `{}` 的语言共用的骨架。 */
const C_LIKE_BASE = {
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  strings: [
    ['"', '"'],
    ["'", "'"],
  ],
  multiPunct: [
    '=>', '->', '::', '==', '!=', '<=', '>=', '&&', '||', '?.', '??', '**', '++', '--',
    // 去重：`?.` 此前写了两次。表里的重复项不会报错、只会让人以为改过一处就生效了。
    '+=', '-=', '*=', '/=', '<<', '>>', '...', '===', '!==', '|>',
  ],
  brackets: { '(': ')', '[': ']', '{': '}' },
  bodyOpen: '{',
}

const C_LIKE = {
  ...C_LIKE_BASE,
  regexLiterals: JS_REGEX_LITERALS,
  backtick: { open: '`', close: '`' },
  headerKeywords: C_LIKE_HEADER_KEYWORDS,
  modifiers: new Set(['async', 'static', 'public', 'private', 'protected', 'readonly', 'abstract', 'declare', 'export', 'default']),
  /**
   * 只保留**有明确声明关键字**的形态。刻意不写通用的 `$name ( $param ) {` 作为方法规则——
   * 试过，它把函数参数和对象字面量属性认成方法声明（197 行文件里 29 个假 method）。
   * 代价是对象字面量里的方法无法按名字定位，这是如实的能力边界。
   */
  rules: [
    { kind: 'function', pattern: ['$mods*', 'function', '$name', '$param*'] },
    { kind: 'class', pattern: ['$mods*', 'class', '$name', '$param*'] },
    { kind: 'variable', pattern: ['$mods*', 'const', '$name'], guard: 'notKeyword' },
    { kind: 'variable', pattern: ['$mods*', 'let', '$name'], guard: 'notKeyword' },
    { kind: 'variable', pattern: ['$mods*', 'var', '$name'], guard: 'notKeyword' },
  ],
  keywords: new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'class', 'const', 'let', 'var',
    'new', 'typeof', 'await', 'else', 'do', 'try', 'finally', 'of', 'in', 'async', 'yield',
    'import', 'export', 'from', 'extends', 'super', 'this', 'case', 'break', 'continue', 'delete', 'void',
  ]),
}

const TYPESCRIPT = {
  ...C_LIKE,
  rules: [
    { kind: 'interface', pattern: ['$mods*', 'interface', '$name', '$param*'] },
    { kind: 'type', pattern: ['$mods*', 'type', '$name'] },
    { kind: 'enum', pattern: ['$mods*', 'enum', '$name'] },
    ...C_LIKE.rules,
  ],
  keywords: new Set([...C_LIKE.keywords, 'interface', 'type', 'enum', 'namespace', 'declare', 'implements', 'readonly', 'abstract', 'keyof', 'infer', 'satisfies']),
}

const PYTHON = {
  lineComments: ['#'],
  blockComments: [],
  strings: [
    ['"""', '"""'],
    ["'''", "'''"],
    ['"', '"'],
    ["'", "'"],
  ],
  multiPunct: ['->', '==', '!=', '<=', '>=', '**', '//', '+=', '-=', '*=', '/=', ':=', '...'],
  brackets: { '(': ')', '[': ']', '{': '}' },
  /** Python 没有块括号：块体由**缩进**给出，因此终结规则进 `blockEnd`，扫描器里不写语言分支。 */
  bodyOpen: null,
  blockEnd: INDENT_BLOCK,
  rules: [
    { kind: 'class', pattern: ['class', '$name', '$param*'] },
    { kind: 'function', pattern: ['$mods*', 'def', '$name', '$param*'] },
  ],
  modifiers: new Set(['async']),
  keywords: new Set([
    'if', 'elif', 'else', 'for', 'while', 'return', 'def', 'class', 'import', 'from', 'as', 'with',
    'try', 'except', 'finally', 'lambda', 'yield', 'pass', 'raise', 'in', 'not', 'and', 'or', 'is',
    'None', 'True', 'False', 'global', 'nonlocal', 'assert', 'del', 'async', 'await', 'match', 'case',
  ]),
}

const GO = {
  ...C_LIKE_BASE,
  strings: [
    ['"', '"'],
    ['`', '`'],
    ["'", "'"],
  ],
  /** Go 的泛型是 `[T any]`，不是 `<>`，所以额外处理方括号。 */
  rules: [
    { kind: 'function', pattern: ['func', '$name', '$param*'] },
    { kind: 'method', pattern: ['func', '$param', '$name', '$param*'] },
    { kind: 'type', pattern: ['type', '$name'] },
    { kind: 'variable', pattern: ['$mods*', 'var', '$name'], guard: 'notKeyword' },
    { kind: 'variable', pattern: ['$mods*', 'const', '$name'], guard: 'notKeyword' },
  ],
  modifiers: new Set([]),
  keywords: new Set([
    'if', 'for', 'return', 'func', 'type', 'struct', 'interface', 'range', 'go', 'defer', 'chan',
    'select', 'case', 'switch', 'package', 'import', 'var', 'const', 'map', 'default', 'fallthrough', 'goto',
  ]),
}

const RUST = {
  ...C_LIKE_BASE,
  headerKeywords: new Set(['where', 'as', 'for']),
  rules: [
    { kind: 'function', pattern: ['$mods*', 'fn', '$name', '$param*'] },
    { kind: 'struct', pattern: ['$mods*', 'struct', '$name', '$param*'] },
    { kind: 'enum', pattern: ['$mods*', 'enum', '$name', '$param*'] },
    { kind: 'trait', pattern: ['$mods*', 'trait', '$name', '$param*'] },
    { kind: 'impl', pattern: ['impl', '$param*', '$name'] },
    { kind: 'mod', pattern: ['$mods*', 'mod', '$name'] },
    // Rust 的常量/静态绑定：`const`/`static` 本身也在 modifiers 里，规则必须带 `$mods*`，
    // 否则 `pub const R` 会被“前一 token 是修饰符”的去重闸门判掉。
    // `$mods*` 的逐长度回溯（matchPattern）让 `pub const` 能停在 `pub` 之后、把 `const` 留给字面量。
    { kind: 'variable', pattern: ['$mods*', 'const', '$name'], guard: 'notKeyword' },
    { kind: 'variable', pattern: ['$mods*', 'static', '$name'], guard: 'notKeyword' },
  ],
  modifiers: new Set(['pub', 'unsafe', 'async', 'const', 'extern', 'default']),
  keywords: new Set([
    'fn', 'let', 'mut', 'struct', 'enum', 'trait', 'impl', 'match', 'if', 'else', 'for', 'while',
    'loop', 'return', 'pub', 'use', 'mod', 'where', 'self', 'Self', 'crate', 'super', 'dyn', 'ref',
    'as', 'in', 'move', 'static', 'const', 'type', 'unsafe', 'async', 'await', 'box',
  ]),
}

const JAVA = {
  ...C_LIKE_BASE,
  headerKeywords: new Set(['extends', 'implements', 'throws', 'permits', 'instanceof']),
  /** `@Override` 之类的注解：让扫描器把它们当噪声吃掉，不要卡住声明匹配。 */
  rules: [
    { kind: 'class', pattern: ['$mods*', 'class', '$name', '$param*'] },
    { kind: 'interface', pattern: ['$mods*', 'interface', '$name', '$param*'] },
    { kind: 'enum', pattern: ['$mods*', 'enum', '$name'] },
    { kind: 'record', pattern: ['$mods*', 'record', '$name', '$param*'] },
  ],
  modifiers: new Set([
    'public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized', 'native',
    'transient', 'volatile', 'strictfp', 'sealed', 'non-sealed', 'default',
  ]),
  keywords: new Set([
    'if', 'for', 'while', 'switch', 'case', 'return', 'class', 'interface', 'enum', 'record',
    'new', 'extends', 'implements', 'throws', 'throw', 'try', 'catch', 'finally', 'package',
    'import', 'void', 'int', 'long', 'double', 'float', 'boolean', 'char', 'byte', 'short',
    'public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized', 'instanceof', 'this', 'super',
  ]),
}

const CSHARP = {
  ...C_LIKE_BASE,
  headerKeywords: new Set(['where', 'is', 'as', 'in']),
  rules: [
    { kind: 'class', pattern: ['$mods*', 'class', '$name', '$param*'] },
    { kind: 'interface', pattern: ['$mods*', 'interface', '$name', '$param*'] },
    { kind: 'enum', pattern: ['$mods*', 'enum', '$name'] },
    { kind: 'struct', pattern: ['$mods*', 'struct', '$name', '$param*'] },
    { kind: 'record', pattern: ['$mods*', 'record', '$name', '$param*'] },
    { kind: 'namespace', pattern: ['namespace', '$name'] },
  ],
  modifiers: new Set([
    'public', 'private', 'protected', 'internal', 'static', 'readonly', 'sealed', 'abstract',
    'partial', 'virtual', 'override', 'async', 'extern', 'unsafe', 'new', 'const',
  ]),
  keywords: new Set([
    'if', 'for', 'foreach', 'while', 'switch', 'case', 'return', 'class', 'interface', 'enum',
    'struct', 'record', 'namespace', 'new', 'using', 'public', 'private', 'protected', 'internal',
    'static', 'readonly', 'sealed', 'abstract', 'partial', 'virtual', 'override', 'async', 'await',
    'var', 'void', 'int', 'string', 'bool', 'double', 'float', 'decimal', 'in', 'out', 'ref', 'where',
  ]),
}

const KOTLIN = {
  ...C_LIKE_BASE,
  headerKeywords: new Set(['where', 'by', 'as', 'is']),
  rules: [
    { kind: 'class', pattern: ['$mods*', 'class', '$name', '$param*'] },
    { kind: 'interface', pattern: ['$mods*', 'interface', '$name', '$param*'] },
    { kind: 'object', pattern: ['$mods*', 'object', '$name'] },
    { kind: 'function', pattern: ['$mods*', 'fun', '$param*', '$name'] },
    { kind: 'variable', pattern: ['$mods*', 'val', '$name'], guard: 'notKeyword' },
    { kind: 'variable', pattern: ['$mods*', 'var', '$name'], guard: 'notKeyword' },
  ],
  modifiers: new Set(['public', 'private', 'protected', 'internal', 'open', 'final', 'abstract', 'sealed', 'data', 'inline', 'suspend', 'operator', 'override', 'lateinit', 'const', 'tailrec', 'external', 'annotation']),
  keywords: new Set([
    'fun', 'class', 'interface', 'object', 'val', 'var', 'if', 'else', 'when', 'for', 'while', 'return',
    'package', 'import', 'is', 'as', 'in', 'out', 'by', 'where', 'init', 'constructor', 'companion',
    'public', 'private', 'protected', 'internal', 'open', 'override', 'data', 'sealed', 'suspend',
  ]),
}

const SWIFT = {
  ...C_LIKE_BASE,
  headerKeywords: new Set(['where', 'throws', 'rethrows', 'async', 'as', 'is']),
  rules: [
    { kind: 'function', pattern: ['$mods*', 'func', '$name', '$param*'] },
    { kind: 'class', pattern: ['$mods*', 'class', '$name', '$param*'] },
    { kind: 'struct', pattern: ['$mods*', 'struct', '$name', '$param*'] },
    { kind: 'enum', pattern: ['$mods*', 'enum', '$name', '$param*'] },
    { kind: 'protocol', pattern: ['$mods*', 'protocol', '$name', '$param*'] },
    { kind: 'extension', pattern: ['$mods*', 'extension', '$name'] },
    { kind: 'variable', pattern: ['$mods*', 'let', '$name'], guard: 'notKeyword' },
    { kind: 'variable', pattern: ['$mods*', 'var', '$name'], guard: 'notKeyword' },
  ],
  modifiers: new Set(['public', 'private', 'internal', 'fileprivate', 'open', 'final', 'static', 'class', 'mutating', 'nonmutating', 'override', 'required', 'convenience', 'lazy', 'weak', 'unowned', 'indirect', 'prefix', 'postfix']),
  keywords: new Set([
    'func', 'class', 'struct', 'enum', 'protocol', 'extension', 'let', 'var', 'if', 'else', 'guard',
    'switch', 'case', 'for', 'while', 'repeat', 'return', 'import', 'init', 'deinit', 'subscript',
    'public', 'private', 'internal', 'fileprivate', 'open', 'final', 'static', 'override', 'mutating',
    'in', 'where', 'as', 'is', 'try', 'throws', 'async', 'await', 'some', 'any',
  ]),
}

const C_FAMILY = {
  ...C_LIKE_BASE,
  // C++ 的基类表可以写成 `class A :\n public B {`（`:` 是标点，自动续行；`public` 要在这里列）
  headerKeywords: new Set(['public', 'private', 'protected', 'virtual']),
  /** C 预处理指令：整行吃掉，否则 `#define MAX(a,b)` 会被当成函数声明。 */
  lineComments: ['//'],
  strings: [
    ['"', '"'],
    ["'", "'"],
  ],
  rules: [
    { kind: 'struct', pattern: ['$mods*', 'struct', '$name', '$param*'] },
    { kind: 'union', pattern: ['$mods*', 'union', '$name'] },
    { kind: 'enum', pattern: ['$mods*', 'enum', '$name'] },
    { kind: 'class', pattern: ['$mods*', 'class', '$name', '$param*'] },
    { kind: 'namespace', pattern: ['namespace', '$name'] },
    /**
     * C/C++ 的函数定义：`ret name(params) {`。
     *
     * 这是"通用形态"唯一一处**配得上**用的场合，因为 C 没有声明关键字，没有别的办法。
     * 与 JS 里被我删掉的那条通用方法规则的区别在于**有硬判别器**：
     *   - `$ident*` 吃掉返回类型（`static inline unsigned long *`）；它必须是非贪婪的，
     *     否则会把函数名一起吃掉（匹配器为此带回溯，见 {@link matchPattern}）
     *   - `guard: 'body'` 要求参数表之后必须是 `{`
     * 调用 `foo(x);` 与声明 `int foo(int);` 都以 `;` 结尾，因此被这两道挡在外面。
     *
     * 模式里**不能**写末尾的 `'{'`：守卫要检查的就是那个 token，模式先消费掉它之后
     * 守卫只能看到块体内部（`return`），于是每次匹配都在守卫处失败——这是本规则最隐蔽的坑，
     * 表现为"规则看起来完全正确，却一个函数都索引不到"。
     */
    { kind: 'function', pattern: ['$ident*', '$nameNotKeyword', '$param*'], guard: 'body' },
    { kind: 'typeAlias', pattern: ['typedef', '$ident*', 'struct', '$name'] },
    { kind: 'typeAlias', pattern: ['typedef', '$ident*', '$name'] },
  ],
  /**
   * 只有**修饰符**进这个词表，类型名不进。
   *
   * 曾经把 `int` `char` `unsigned` `long` 也塞进来，结果 `static int bar(int a) {` 里
   * `bar` 的前一个 token 是 `int`，被 `precededByModifier` 闸门误判成"这不是声明起点"，
   * 整个函数被丢掉。类型由 `$ident*` 负责，词表只管修饰符——两件事不能混用一个名单。
   */
  modifiers: new Set(['static', 'inline', 'extern', 'register', 'virtual', 'explicit', 'friend', 'constexpr', 'mutable', 'typename', 'public', 'private', 'protected']),
  keywords: new Set([
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'return', 'struct', 'union',
    'enum', 'class', 'namespace', 'typedef', 'static', 'const', 'extern', 'inline', 'void', 'int',
    'char', 'float', 'double', 'long', 'short', 'unsigned', 'signed', 'sizeof', 'goto', 'break',
    'continue', 'new', 'delete', 'this', 'template', 'try', 'catch', 'throw', 'using', 'operator',
    'public', 'private', 'protected', 'virtual', 'explicit', 'friend', 'constexpr', 'mutable', 'typename', 'auto',
  ]),
}

const RUBY = {
  lineComments: ['#'],
  blockComments: [['=begin', '=end']],
  strings: [
    ['"', '"'],
    ["'", "'"],
  ],
  multiPunct: ['=>', '==', '!=', '<=', '>=', '<=>', '===', '**', '<<', '>>', '&&', '||', '+=', '-=', '||=', '&&=', '&.'],
  brackets: { '(': ')', '[': ']', '{': '}' },
  /** Ruby 用 `end` 收尾，没有块括号：块体由开块词与 `end` 配对给出。 */
  bodyOpen: null,
  blockEnd: RUBY_BLOCK,
  rules: [
    { kind: 'class', pattern: ['class', '$name'] },
    { kind: 'module', pattern: ['module', '$name'] },
    { kind: 'function', pattern: ['def', '$name', '$param*'] },
  ],
  modifiers: new Set([]),
  keywords: new Set([
    'def', 'class', 'module', 'end', 'if', 'elsif', 'else', 'unless', 'while', 'until', 'for', 'do',
    'return', 'yield', 'begin', 'rescue', 'ensure', 'raise', 'require', 'include', 'extend', 'attr_accessor',
    'attr_reader', 'attr_writer', 'self', 'nil', 'true', 'false', 'and', 'or', 'not', 'then', 'case', 'when', 'lambda', 'proc',
  ]),
}

const PHP = {
  headerKeywords: new Set(['extends', 'implements', 'as', 'instanceof']),
  lineComments: ['//', '#'],
  blockComments: [['/*', '*/']],
  strings: [
    ['"', '"'],
    ["'", "'"],
  ],
  multiPunct: ['=>', '->', '::', '==', '!=', '===', '!==', '<=', '>=', '&&', '||', '??', '**', '+=', '-=', '*=', '/=', '...', '?->'],
  brackets: { '(': ')', '[': ']', '{': '}' },
  bodyOpen: '{',
  rules: [
    { kind: 'class', pattern: ['$mods*', 'class', '$name', '$param*'] },
    { kind: 'interface', pattern: ['$mods*', 'interface', '$name', '$param*'] },
    { kind: 'trait', pattern: ['$mods*', 'trait', '$name'] },
    { kind: 'enum', pattern: ['$mods*', 'enum', '$name'] },
    { kind: 'function', pattern: ['$mods*', 'function', '$name', '$param*'] },
    { kind: 'variable', pattern: ['$mods*', 'const', '$name'], guard: 'notKeyword' },
  ],
  modifiers: new Set(['public', 'private', 'protected', 'static', 'final', 'abstract', 'readonly']),
  keywords: new Set([
    'if', 'else', 'elseif', 'for', 'foreach', 'while', 'do', 'switch', 'case', 'return', 'function',
    'class', 'interface', 'trait', 'enum', 'namespace', 'use', 'new', 'public', 'private', 'protected',
    'static', 'final', 'abstract', 'const', 'echo', 'print', 'require', 'include', 'try', 'catch', 'finally',
    'as', 'instanceof', 'clone', 'yield', 'fn', 'match',
  ]),
}

const SCALA = {
  ...C_LIKE_BASE,
  headerKeywords: new Set(['extends', 'with', 'derives', 'as', 'is']),
  rules: [
    { kind: 'class', pattern: ['$mods*', 'class', '$name', '$param*'] },
    { kind: 'trait', pattern: ['$mods*', 'trait', '$name', '$param*'] },
    { kind: 'object', pattern: ['$mods*', 'object', '$name'] },
    { kind: 'function', pattern: ['$mods*', 'def', '$name', '$param*'] },
    { kind: 'variable', pattern: ['$mods*', 'val', '$name'], guard: 'notKeyword' },
    { kind: 'variable', pattern: ['$mods*', 'var', '$name'], guard: 'notKeyword' },
  ],
  modifiers: new Set(['private', 'protected', 'override', 'final', 'sealed', 'abstract', 'implicit', 'lazy', 'case']),
  keywords: new Set([
    'class', 'trait', 'object', 'def', 'val', 'var', 'if', 'else', 'match', 'case', 'for', 'while',
    'return', 'package', 'import', 'new', 'extends', 'with', 'yield', 'implicit', 'override', 'sealed', 'abstract',
  ]),
}

const LUA = {
  lineComments: ['--'],
  blockComments: [['--[[', ']]']],
  strings: [
    ['"', '"'],
    ["'", "'"],
    ['[[', ']]'],
  ],
  multiPunct: ['==', '~=', '<=', '>=', '..', '...', '::'],
  brackets: { '(': ')', '[': ']', '{': '}' },
  /** Lua 用 `end`/`until` 收尾：块体由开块词配对给出。 */
  bodyOpen: null,
  blockEnd: LUA_BLOCK,
  rules: [
    { kind: 'function', pattern: ['function', '$name', '$param*'] },
    { kind: 'method', pattern: ['function', '$param', '$name', '$param*'] },
    { kind: 'variable', pattern: ['local', 'function', '$name'] },
  ],
  modifiers: new Set(['local']),
  keywords: new Set([
    'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in',
    'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while',
  ]),
}

const DART = {
  ...C_LIKE_BASE,
  headerKeywords: new Set(['extends', 'implements', 'with', 'on', 'async', 'sync', 'as', 'is']),
  rules: [
    { kind: 'class', pattern: ['$mods*', 'class', '$name', '$param*'] },
    { kind: 'mixin', pattern: ['$mods*', 'mixin', '$name'] },
    { kind: 'enum', pattern: ['$mods*', 'enum', '$name'] },
    { kind: 'extension', pattern: ['$mods*', 'extension', '$name'] },
    { kind: 'function', pattern: ['$mods*', '$name', '$param', '{'], guard: 'memberName' },
  ],
  modifiers: new Set(['abstract', 'static', 'final', 'const', 'external', 'factory', 'late', 'async']),
  keywords: new Set([
    'class', 'mixin', 'enum', 'extension', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
    'return', 'import', 'library', 'part', 'export', 'new', 'var', 'final', 'const', 'void', 'dynamic',
    'async', 'await', 'yield', 'get', 'set', 'factory', 'abstract', 'static', 'late',
  ]),
}

const SHELL = {
  lineComments: ['#'],
  blockComments: [],
  strings: [
    ['"', '"'],
    ["'", "'"],
  ],
  /**
   * shell 的 `#` 在这些字符之后**不是**注释：`$#`（参数个数）、`${#var}`（长度）、
   * 以及 `#!`（shebang 由 `#` 起，但那本来就是要吃掉的注释）。
   * 少了这一条，`echo $#` 之后整行被吞——静默丢失，最难查。
   */
  commentBlockers: { '#': ['$', '{'] },
  /**
   * 刻意**不把 `((` / `))` 当单 token**。
   *
   * 它们是两个独立的开符/闭符：`COMPREPLY=($(compgen … ${cur}))` 里那个 `))` 要关掉两层，
   * 而单 token 的 `))` 一个也关不掉（`closeOf['(']` 是 `)`，不是 `))`），于是栈上留下未配平的 `(`，
   * 函数的 `{` 永远等不到它的 `}`——跨度要么截断（静默）要么判不了（fail-closed）。
   * 去掉这两项后 `((`/`))` 退化成两个 token，配平自然成立（实测：三个 shell completion 脚本）。
   */
  multiPunct: ['&&', '||', ';;', '>>', '<<', '|&', '&>', '>&', '[[', ']]', '==', '!='],
  /**
   * 括号对。`${var}` 与 `$(cmd)` **不需要**单独列：`$` 先被标识符规则吃掉（`$` 是合法的
   * 标识符起始字符），所以词法器永远不会产出 `${` / `$(` 这样的 token——列了也是死配置。
   * 真正会出现的形状是 `$` + `{` 与 `$` + `(`，它们由普通括号对配平。
   */
  brackets: { '(': ')', '[': ']', '{': '}' },
  /**
   * shell 的函数体是复合命令 `{ … }`（`fi`/`done` 收的是 `if`/`for`，不是声明）。
   * 因此块括号与其它花括号语言同形；`name() {` 形态把 `{` 吃进了规则模式里，
   * 那一处由 declarationSpan 的“匹配末端就是块开符”处理。
   */
  bodyOpen: '{',
  rules: [
    // `name() {` 是 POSIX 函数定义；`function name` 是 bash/ksh 风格
    { kind: 'function', pattern: ['$nameNotKeyword', '$param', '{'], guard: 'memberName' },
    { kind: 'function', pattern: ['function', '$nameNotKeyword', '$param*'] },
  ],
  modifiers: new Set(['function']),
  keywords: new Set([
    'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
    'in', 'function', 'select', 'time', 'coproc', 'return', 'break', 'continue', 'local',
    'export', 'readonly', 'declare', 'typeset', 'unset', 'shift', 'eval', 'exec', 'exit', 'source',
    'set', 'trap', 'wait', 'echo', 'printf', 'read', 'test', 'true', 'false',
  ]),
}

const POWERSHELL = {
  lineComments: ['#'],
  blockComments: [['<#', '#>']],
  strings: [
    ['"', '"'],
    ["'", "'"],
  ],
  multiPunct: ['||', '&&', '::', '..', '-eq', '-ne', '-gt', '-lt', '-ge', '-le', '-and', '-or', '-not', '-like', '-match', '-replace', '-contains', '-in', '-is', '-as', '+=', '-=', '*=', '/=', '|>', '??'],
  brackets: { '(': ')', '[': ']', '{': '}' },
  bodyOpen: '{',
  /** PowerShell 的函数名可以带连字符：`Get-Thing` 是一个名字，不是 `Get` 减 `Thing`。 */
  dashInIdent: true,
  rules: [
    { kind: 'class', pattern: ['$mods*', 'class', '$name', '$param*'] },
    { kind: 'enum', pattern: ['$mods*', 'enum', '$name'] },
    { kind: 'function', pattern: ['$mods*', 'function', '$name', '$param*'] },
    { kind: 'function', pattern: ['$mods*', 'filter', '$name', '$param*'] },
    { kind: 'variable', pattern: ['$mods*', '$name', '='], guard: 'notKeyword' },
  ],
  modifiers: new Set(['hidden', 'static', 'global', 'local', 'script', 'private', 'public']),
  keywords: new Set([
    'function', 'filter', 'class', 'enum', 'if', 'else', 'elseif', 'switch', 'foreach', 'for',
    'while', 'do', 'until', 'return', 'break', 'continue', 'try', 'catch', 'finally', 'throw',
    'param', 'process', 'begin', 'end', 'in', 'function', 'using', 'namespace', 'hidden', 'static',
  ]),
}

const CYTHON = {
  lineComments: ['#'],
  blockComments: [],
  strings: [
    ['"""', '"""'],
    ["'''", "'''"],
    ['"', '"'],
    ["'", "'"],
  ],
  multiPunct: ['->', '==', '!=', '<=', '>=', '**', '//', '+=', '-=', '*=', '/=', ':=', '||', '|'],
  brackets: { '(': ')', '[': ']', '{': '}' },
  /** 缩进语言：与 Python 同一条规则（Cython 的 `cdef`/`cpdef` 也是缩进块体）。 */
  bodyOpen: null,
  blockEnd: INDENT_BLOCK,
  rules: [
    { kind: 'class', pattern: ['$mods*', 'class', '$name', '$param*'] },
    { kind: 'function', pattern: ['def', '$name', '$param*'] },
    { kind: 'function', pattern: ['cdef', '$name', '$param*'] },
    { kind: 'function', pattern: ['cpdef', '$name', '$param*'] },
    { kind: 'type', pattern: ['ctypedef', '$name'] },
    { kind: 'variable', pattern: ['$mods*', 'cdef', '$name'], guard: 'notKeyword' },
  ],
  modifiers: new Set(['async', 'extern', 'public', 'api', 'inline', 'readonly']),
  keywords: new Set([
    'def', 'cdef', 'cpdef', 'ctypedef', 'class', 'if', 'elif', 'else', 'for', 'while', 'return',
    'import', 'from', 'as', 'with', 'try', 'except', 'finally', 'lambda', 'yield', 'pass', 'raise',
    'in', 'not', 'and', 'or', 'is', 'None', 'True', 'False', 'cimport', 'include', 'struct', 'union', 'enum',
  ]),
}

const PROTO = {
  headerKeywords: new Set(['returns']),
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  strings: [
    ['"', '"'],
    ["'", "'"],
  ],
  multiPunct: ['==', '!=', '<=', '>=', '||', '&&'],
  brackets: { '(': ')', '[': ']', '{': '}' },
  bodyOpen: '{',
  rules: [
    { kind: 'message', pattern: ['message', '$name'] },
    { kind: 'enum', pattern: ['enum', '$name'] },
    { kind: 'service', pattern: ['service', '$name'] },
    { kind: 'rpc', pattern: ['rpc', '$name', '$param*'] },
    { kind: 'oneof', pattern: ['oneof', '$name'] },
  ],
  modifiers: new Set(['optional', 'required', 'repeated']),
  keywords: new Set([
    'syntax', 'package', 'import', 'option', 'message', 'enum', 'service', 'rpc', 'returns',
    'oneof', 'map', 'reserved', 'extend', 'extensions', 'stream', 'optional', 'required', 'repeated',
    'public', 'weak', 'true', 'false',
  ]),
}

const PERL = {
  lineComments: ['#'],
  blockComments: [],
  strings: [
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
  ],
  multiPunct: ['=>', '->', '::', '==', '!=', '<=', '>=', '=~', '!~', '&&', '||', '//', '**', '..', '...', '+=', '-=', '.=', 'x='],
  brackets: { '(': ')', '[': ']', '{': '}' },
  bodyOpen: '{',
  rules: [
    { kind: 'package', pattern: ['package', '$name'] },
    { kind: 'function', pattern: ['sub', '$name', '$param*'] },
    { kind: 'variable', pattern: ['our', '$name'], guard: 'notKeyword' },
  ],
  modifiers: new Set(['our', 'my', 'local', 'state', 'sub']),
  keywords: new Set([
    'sub', 'package', 'use', 'require', 'my', 'our', 'local', 'state', 'if', 'elsif', 'else',
    'unless', 'while', 'until', 'for', 'foreach', 'do', 'return', 'last', 'next', 'redo', 'given',
    'when', 'print', 'say', 'printf', 'die', 'warn', 'eval', 'bless', 'ref', 'scalar', 'wantarray',
    'and', 'or', 'not', 'xor', 'eq', 'ne', 'lt', 'gt', 'le', 'ge', 'cmp',
  ]),
}

const BATCH = {
  lineComments: ['REM ', 'rem ', '::'],
  blockComments: [],
  strings: [
    ['"', '"'],
  ],
  multiPunct: ['==', '&&', '||', '>>', '2>&1', '>>&1'],
  brackets: { '(': ')', '[': ']' },
  /**
   * batch **刻意不给终结规则**：它的“函数”是约定（`:label` 段 + `goto :eof`），不是语法，
   * 而本配置的 function 规则会把任意裸标识符行都当函数（`set x=1` → 符号 `x`）。
   * 在一个不可信的符号上再套一个猜出来的跨度，只会把“改错地方”从签名行扩大到整段。
   * 因此 .bat 的符号一律 `spanComplete: false` → `target=` 结构化拒绝（fail-closed）。
   */
  bodyOpen: null,
  rules: [
    { kind: 'label', pattern: [':', '$name'] },
    { kind: 'function', pattern: ['$mods*', '$name', '$param*'], guard: 'notKeyword' },
  ],
  modifiers: new Set(['call', 'goto']),
  keywords: new Set([
    'if', 'else', 'for', 'in', 'do', 'set', 'setlocal', 'endlocal', 'call', 'goto', 'exit',
    'echo', 'rem', 'shift', 'pushd', 'popd', 'cd', 'copy', 'del', 'move', 'mkdir', 'rmdir',
    'errorlevel', 'exist', 'not', 'defined', 'start', 'type', 'find', 'findstr',
  ]),
}

/**
 * SQL：语句以 `;` 收尾，没有块括号也没有配对收尾词。
 *
 * 规则只收 `CREATE <对象> <名字>`：`table` 在 SQL 里既可以是关键字也可以是表名
 * （`CREATE TABLE table (...)`），而且 `table`/`view` 这几个词本身就是常见列名。
 * 因此它们**不当规则词表**——字面量必须是 `CREATE` 这个不会出现在列名里的词，
 * 否则一个 `CREATE INDEX` 就能在列定义里造出假符号。
 * 代价是 `CREATE PROCEDURE` 这类不认，这是刻意的能力边界。
 *
 * `NULL` 与 `TRUE` 进关键字表：本文件的关键字表就是**模式里的字面量词表**，
 * 它同时承担“这些名字不可能是符号名”的判定（见 `looksLikeBinding`）。
 */
const SQL = {
  lineComments: ['--'],
  blockComments: [['/*', '*/']],
  strings: [
    ["'", "'"],
    ['"', '"'],
  ],
  multiPunct: ['||', '::', '>=', '<=', '<>', '!='],
  brackets: { '(': ')', '[': ']', '{': '}' },
  bodyOpen: null,
  blockEnd: TERMINATOR_BLOCK([';']),
  rules: [
    { kind: 'table', pattern: ['CREATE', 'TABLE', '$mods*', '$name'] },
    { kind: 'view', pattern: ['CREATE', 'VIEW', '$name'] },
    { kind: 'index', pattern: ['CREATE', '$mods*', 'INDEX', '$name'] },
  ],
  modifiers: new Set(['OR', 'REPLACE', 'TEMP', 'TEMPORARY', 'UNIQUE', 'IF', 'NOT', 'EXISTS']),
  keywords: new Set([
    'select', 'from', 'where', 'group', 'by', 'order', 'having', 'limit', 'offset', 'join', 'inner',
    'left', 'right', 'full', 'outer', 'on', 'as', 'and', 'or', 'not', 'null', 'is', 'in', 'exists',
    'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'alter', 'drop', 'table', 'view',
    'index', 'primary', 'key', 'foreign', 'references', 'default', 'unique', 'check', 'constraint',
    'case', 'when', 'then', 'else', 'end', 'union', 'all', 'distinct', 'asc', 'desc', 'between', 'like',
    'true', 'false', 'with', 'returning', 'begin', 'commit', 'rollback', 'declare', 'function', 'procedure',
  ]),
}

/**
 * GraphQL SDL：声明是 `type Foo { … }`，块体就是那对花括号。
 *
 * `extend` **不进**规则：`extend type Foo @key(...)` 与 `type Foo` 捕获同一个名字，
 * 两处并存时 `target=Foo` 报歧义。宁可少一个符号，不要一个必然歧义的符号。
 */
const GRAPHQL = {
  lineComments: ['#'],
  blockComments: [],
  strings: [['"', '"'], ['"""', '"""']],
  multiPunct: ['...', '&&', '||'],
  brackets: { '(': ')', '[': ']', '{': '}' },
  bodyOpen: '{',
  rules: [
    { kind: 'type', pattern: ['type', '$name', '$param*'] },
    { kind: 'interface', pattern: ['interface', '$name', '$param*'] },
    { kind: 'enum', pattern: ['enum', '$name'] },
    { kind: 'schema', pattern: ['schema', '$param*'] },
    { kind: 'input', pattern: ['input', '$name'] },
    { kind: 'union', pattern: ['union', '$name'] },
    { kind: 'directive', pattern: ['directive', '$name', '$param*'] },
  ],
  modifiers: new Set([
    'query', 'mutation', 'subscription', 'fragment', 'on', 'implements', 'repeatable',
    'extend', 'scalar', 'type', 'interface', 'enum', 'union', 'input', 'schema', 'directive',
  ]),
  keywords: new Set([
    'query', 'mutation', 'subscription', 'fragment', 'on', 'true', 'false', 'null', 'implements',
    'type', 'interface', 'enum', 'union', 'input', 'schema', 'directive', 'extend', 'scalar', 'repeatable',
  ]),
}

/**
 * HCL（Terraform）：块名是**带引号的字符串**（`resource "aws_instance" "web"`），
 * 不是标识符——`$name` 的契约是“只捕标识符”，硬放宽会波及其它 40 余种语言。
 * 新增的 `$label` 专治这一个形状：它收标识符**或字符串**，并把引号剥掉，
 * 于是 `.tf` 的块名与其它语言一样是一个可寻址的名字。
 * 不捕字符串的代价是**一个符号都提不出来**（实测），那比“名字取自哪一个标签”重要得多。
 */
const TERRAFORM = {
  lineComments: ['#', '//'],
  blockComments: [['/*', '*/']],
  strings: [['"', '"']],
  multiPunct: ['=>', '==', '!=', '<=', '>=', '&&', '||', '...'],
  brackets: { '(': ')', '[': ']', '{': '}' },
  // 块闭符当停止条件：`{ … }` 里换行不是末尾，而 `variable "x" {` 这种只有头部的声明
  // 也不会卡在 `scanBodyOpen` 的“既不续行也不起声明”分支上（那会让 span 不完整）。
  bodyOpen: null,
  blockEnd: TERMINATOR_BLOCK([';']),
  rules: [
    // 块名一律用 `$label`：它同时认裸标识符（`variable region`）与带引号的字符串
    // （`resource "aws_instance" "web"`）。第二种形状里**捕的是第一个标签**，即**类型**
    // （`aws_instance`）而不是实例名（`web`）。
    // 这是刻意的取舍：类型名在同一个块里是位置确定的，实例名却在第二个标签上，
    // 要捕它就得再加一个原语。代价是同类多个块同名（`target=` 报歧义，需行号消歧）；
    // 而“没有名字的符号完全无法寻址”更差。
    { kind: 'resource', pattern: ['resource', '$label', '$param*'] },
    { kind: 'variable', pattern: ['variable', '$label', '$param*'] },
    { kind: 'output', pattern: ['output', '$label', '$param*'] },
    { kind: 'module', pattern: ['module', '$label', '$param*'] },
    // `data` 与 `resource` 同形（`data "aws_ami" "ubuntu" {`），捕第一个标签。
    { kind: 'data', pattern: ['data', '$label', '$param*'] },
  ],
  modifiers: new Set(['resource', 'data', 'variable', 'output', 'module', 'provider', 'locals', 'terraform', 'dynamic', 'for_each']),
  keywords: new Set([
    'resource', 'data', 'variable', 'output', 'module', 'provider', 'locals', 'terraform', 'dynamic',
    'for_each', 'if', 'for', 'in', 'true', 'false', 'null', 'count', 'depends_on', 'lifecycle',
  ]),
}

/**
 * Vue / Svelte 的单文件组件：两者都允许在组件里写真正的 JS。
 *
 * 复用 `C_LIKE` 的规则（`const`/`let`/`function`/`class`），换两处：
 *
 *   1. **终结规则**换成 `terminator(';')`：这里没有“函数体必须包在花括号里”的保证
 *      （`const title = 'x'` 就是完整声明），而 terminator 自带“行尾就是末尾”的停止条件。
 *      若改回 `bodyOpen: '{'`，`const title = 'x'` 会停在 `scanBodyOpen` 里一个
 *      既不续行也不起声明的 token 上，`spanComplete` 变 false，`target=` 被拒。
 *   2. **关掉正则字面量**。这一条是实测出来的：`<template><div>{{ x }}</div></template>` 里
 *      `</div>` 的前一个 token 是 `>`（能期待表达式），于是 `/div>` 被当成正则吃掉，
 *      接着 `/template>` 又把**真正的 script 段**一起吞掉——`<script>` 里的 `const`
 *      凭空消失，一个符号都不剩。宁可把 `/` 当除法：代价只是正则字面量里的引号会被
 *      误当字符串（影响面极小），而原来那个代价是**整个 script 段不可见**。
 */
const JS_COMPONENT = {
  ...C_LIKE,
  regexLiterals: undefined,
  bodyOpen: null,
  blockEnd: TERMINATOR_BLOCK([';']),
}

/**
 * Astro：前页（frontmatter）是 JS，正文是 HTML。
 *
 * 与 Vue/Svelte 共用规则，但**不能**共用终结规则：`bodyOpen: '{'` 在这里不是取舍而是必要——
 * `const alpha = () => { return 1 }` 的块体必须由括号配平给出，而 `<div class="x">` 里
 * 那个 `>` 会被词法器当标点吃掉，不影响配平。
 */
const ASTRO = {
  ...C_LIKE,
  bodyOpen: '{',
}

/**
 * R：函数定义就是**赋值**（`alpha <- function(a) { … }`），所以规则用 `$name` + 两个赋值符。
 * 终结规则复用花括号配平（`bodyOpen: '{'`）：R 的函数体一定是 `{ … }`。
 */
const R = {
  lineComments: ['#'],
  blockComments: [],
  strings: [['"', '"'], ["'", "'"]],
  multiPunct: ['<-', '->', '<<-', '->>', '==', '!=', '<=', '>=', '&&', '||', ':::', '::', '%>%'],
  brackets: { '(': ')', '[': ']', '{': '}' },
  bodyOpen: '{',
  rules: [
    { kind: 'function', pattern: ['$name', '<-', 'function', '$param*'] },
    { kind: 'function', pattern: ['$name', '=', 'function', '$param*'] },
  ],
  modifiers: new Set([]),
  keywords: new Set([
    'function', 'if', 'else', 'for', 'while', 'repeat', 'return', 'next', 'break', 'in', 'NULL',
    'Inf', 'NaN', 'TRUE', 'FALSE', 'library', 'require', 'source',
  ]),
}

/**
 * Elixir：`defmodule Alpha do … end`、`def beta(a) do … end`，与 Ruby 同形的 `do … end` 配对。
 *
 * 一行式 `def beta(a), do: a + 1` **不**给跨度：那个 `do:` 不是 `do` token（`do` 与 `:` 分开），
 * 于是 `closerBlockEnd` 找不到收尾词 ⇒ fail-closed。宁可那一种形态拒绝 `target=`，
 * 也不交一个猜出来的跨度——它是 Elixir 里最常见的单行写法，所以这条边界必须写进报告。
 */
/**
 * Elixir / Ruby 共用 `do … end` 的**形状**，但不共用开块词表。
 *
 * Elixir 里 `do` 只是跟在头部后面的**引导词**，块本身由 `defmodule`/`def`/`case` 开。
 * 把 `do` 也算成开块词会让每个 `def … do` 多计一层，于是模块跨度找不到配平、
 * `spanComplete` 变 false（实测：`defmodule` 与 `def` 都拒绝 `target=`）。
 * Ruby 那边**不能**照此改：它的 `do` 出现在 `array.each do` 这类没有别的开块词的写法里，
 * 少计一层会让那些块提前收尾（`closerBlockEnd` 的缩进校验会把它变成 fail-closed）。
 */
const ELIXIR_BLOCK = {
  style: 'closer',
  closer: 'end',
  openers: new Set(['def', 'defp', 'defmacro', 'defmodule', 'defprotocol', 'defimpl', 'defstruct', 'defguard', 'if', 'unless', 'case', 'cond', 'with', 'for', 'try', 'receive', 'fn']),
  modifiers: new Set(['if', 'unless']),
  markers: new Set(['do']),
  loopOpeners: new Set(['for', 'case', 'cond', 'with', 'receive']),
}

const ELIXIR = {
  lineComments: ['#'],
  blockComments: [],
  strings: [['"""', '"""'], ['"', '"'], ["'", "'"]],
  multiPunct: ['->', '<-', '|>', '<>', '==', '!=', '<=', '>=', '&&', '||', '::', '..', '\\'],
  brackets: { '(': ')', '[': ']', '{': '}' },
  bodyOpen: null,
  blockEnd: ELIXIR_BLOCK,
  rules: [
    { kind: 'module', pattern: ['defmodule', '$name', '$param*'] },
    { kind: 'function', pattern: ['def', '$nameNotKeyword', '$param*'] },
    { kind: 'function', pattern: ['defp', '$nameNotKeyword', '$param*'] },
    { kind: 'function', pattern: ['defmacro', '$nameNotKeyword', '$param*'] },
  ],
  modifiers: new Set(['def', 'defp', 'defmodule', 'defmacro', 'defstruct', 'defprotocol', 'defimpl', 'defguard']),
  keywords: new Set([
    'def', 'defp', 'defmodule', 'defmacro', 'defstruct', 'defprotocol', 'defimpl', 'defguard',
    'do', 'end', 'fn', 'case', 'cond', 'if', 'unless', 'else', 'elsif', 'when', 'with', 'for',
    'receive', 'try', 'rescue', 'catch', 'after', 'raise', 'import', 'alias', 'use', 'require',
    'and', 'or', 'not', 'in', 'true', 'false', 'nil',
  ]),
}

/**
 * Erlang：行首带 `-` 的是**属性**（`-module(alpha).`），不带的是**函数子句**（`beta(A) -> … .`）。
 *
 * 终结规则是语句终结符 `.`（不是 `end`）：Erlang 的函数子句以 `.` 收尾，属性也是。
 * `attributeClause` 闸门把“`-` 开头”与“裸名字开头”分开——少了它，`-module(alpha)` 会被
 * 函数规则命中并报出一个叫 `module` 的假函数。
 */
const ERLANG = {
  lineComments: ['%'],
  blockComments: [],
  strings: [['"', '"'], ["'", "'"]],
  multiPunct: ['->', '<-', '==', '/=', '=<', '>=', '++', '--', '::', '||', '|>', '<<', '>>'],
  brackets: { '(': ')', '[': ']', '{': '}' },
  bodyOpen: null,
  dotTerminatesNumber: true,

  blockEnd: TERMINATOR_BLOCK(['.'], { newlineStops: false }),

  rules: [
    // `$param` 是**跳过**一个括号组、不捕获任何名字，所以属性名必须写 `'(' '$name'`：
    // 用 `$param` 的结果是 `cap.$name` 为空 ⇒ 符号被 `indexStructure` 静默丢弃（实测 0 个符号）。
    // 三条属性规则用 `$rest`（主代理为 `.hrl` 加的原语）：名字与 `)` 之间的实参可能是
    // 「逗号 + 字面量」（`-define(ALPHA, 1)`）——`$ident*` 只吃标识符、跳不过去。
    { kind: 'module', pattern: ['-', 'module', '(', '$name', '$rest', ')'] },
    { kind: 'record', pattern: ['-', 'record', '(', '$name', '$rest', ')'] },
    { kind: 'variable', pattern: ['-', 'define', '(', '$name', '$rest', ')'] },
    { kind: 'function', pattern: ['$nameNotKeyword', '$param'], guard: 'attributeClause' },
  ],
  modifiers: new Set([]),
  keywords: new Set([
    'module', 'export', 'import', 'record', 'define', 'include', 'behaviour', 'spec', 'type', 'end',
    'case', 'of', 'if', 'receive', 'after', 'try', 'catch', 'fun', 'when', 'begin', 'andalso', 'orelse',
    'not', 'div', 'rem', 'band', 'bor', 'bxor', 'bsl', 'bsr',
  ]),
}

/**
 * Haskell：类型签名（`beta :: Int -> Int`）与函数定义（`beta a = a + 1`）是**两种**声明。
 *
 * 缩进决定块体（`blockEnd: INDENT_BLOCK` + `headerEnds: ['=']`）：Haskell 的 `=` 就是头部收尾符。
 * 规则必须**以捕获的名字开头**（没有前导字面量），因为 Haskell 的声明没有关键字可锚定；
 * 代价是 `a + 1` 这种表达式也满足 `$nameNotKeyword '$param*' '='`——所以 `where`/`let`/`in`
 * 必须进关键字表，它们是最常见的“裸名字后跟 `=`”的绑定形式。
 *
 * **当前状态：未登记**（安全优先，见 LANGS 表里 `hs` 处的注释）。本定义保留作修法依据：
 * 需要"第一列 layout 守卫"与"签名/实现合并"两件，否则会给假符号或造歧义。
 */
const HASKELL = {
  lineComments: ['--'],
  blockComments: [['{-', '-}']],
  strings: [['"', '"'], ["'", "'"]],
  multiPunct: ['->', '<-', '=>', '::', '==', '/=', '<=', '>=', '&&', '||', '..', '>>=', '>>', '.', '$'],
  brackets: { '(': ')', '[': ']', '{': '}' },
  bodyOpen: null,
  blockEnd: { style: 'indent', headerEnds: new Set(['=']) },
  // 2026-09-22 修（主代理）：旧的三条规则会给**假符号**（把函数体内的 `a = a + 1` 当顶层绑定，
  // 实测报出 `a@4-4`），而假符号比没符号危险。现在两条修法都用上了：
  //   ① `guard: 'topLevel'`（第一列 layout 闸门）区分顶层绑定与函数体内绑定；
  //   ② **去掉 `::` 类型签名规则**：它与实现 `beta a = a + 1` 同名，会造出 `STRUCT_AMBIGUOUS`
  //      （`target=beta` 直接不可用）。代价：只写签名的接口文件不再出符号——如实记录。
  // `$ident*` 接住裸参数（`beta a = …` 的 `a`），它不是模式的最后一个元素（后面还有 `=`），
  // 因此不会退化成"跳一个可选括号组"。
  rules: [
    { kind: 'function', pattern: ['$nameNotKeyword', '$ident*', '='], guard: 'topLevel' },
  ],
  modifiers: new Set([]),
  keywords: new Set([
    'module', 'where', 'import', 'qualified', 'as', 'hiding', 'data', 'type', 'newtype', 'class',
    'instance', 'deriving', 'let', 'in', 'do', 'case', 'of', 'if', 'then', 'else', 'infix', 'infixl',
    'infixr', 'foreign', 'default', 'True', 'False', 'otherwise',
  ]),
}

/**
 * OCaml：`let alpha a =`（函数）与 `let x = 1`（绑定）都由 `=` 收尾，块体由缩进给出。
 *
 * 两条规则分开写，而不是合成 `$nameNotKeyword '$param*' '='`：后者的 `$param*` 会让
 * `let alpha a =` 的**参数**先被 `$param*` 吃掉、再由 `$name` 捕到 `a`，于是符号名变成参数名。
 * 分开写时第一条规则只允许**恰好一个**参数（`$param` 必选），第二条完全没有参数。
 */
const OCAML = {
  lineComments: [],
  blockComments: [['(*', '*)']],
  strings: [['"', '"']],
  multiPunct: ['->', '<-', '::', ':=', '==', '!=', '<=', '>=', '&&', '||', '|>', '@@'],
  brackets: { '(': ')', '[': ']', '{': '}' },
  bodyOpen: null,
  blockEnd: { style: 'indent', headerEnds: new Set(['=']) },
  rules: [
    { kind: 'function', pattern: ['let', '$name', '$param', '='] },
    { kind: 'variable', pattern: ['let', '$name', '='] },
  ],
  modifiers: new Set(['rec', 'and', 'mutable', 'private', 'virtual']),
  keywords: new Set([
    'let', 'rec', 'and', 'in', 'module', 'open', 'type', 'struct', 'sig', 'end', 'fun', 'function',
    'match', 'with', 'if', 'then', 'else', 'for', 'while', 'do', 'done', 'begin', 'try', 'exception',
    'val', 'mutable', 'class', 'object', 'method', 'inherit', 'true', 'false',
  ]),
}

/**
 * Clojure / ClojureScript / Emacs Lisp：声明是**列表**，块体就是那对括号本身。
 *
 * `bodyOpens: ['(']` 让 `scanBodyOpen` 把 `(defn beta [a] …)` 的 `(` 当作块开符，
 * 跨度由配平闭符给出——对 Lisp 来说这是唯一正确的跨度定义（没有别的“体”）。
 * 规则里刻意**不写 `(`**：字面量写进去会让声明起点落在括号上，跨度反而偏长。
 */
const LISP = {
  lineComments: [';'],
  blockComments: [],
  strings: [['"', '"']],
  multiPunct: ['->', '::', '#{', '#(', '~@'],
  brackets: { '(': ')', '[': ']', '{': '}' },
  bodyOpen: '(',
  bodyOpens: new Set(['(']),
  blockEnd: undefined,
  rules: [
    // 末尾**不写** `(`：Clojure 的形参表是 `[a]`（不是 `(a)`），而块体那对括号
    // 由 `bodyOpen: '('` 给出。写进去会让 `(defn beta [a] …)` 匹配不上（实测 0 个符号）。
    { kind: 'namespace', pattern: ['ns', '$nameNotKeyword'] },
    { kind: 'function', pattern: ['defn', '$nameNotKeyword'] },
    { kind: 'function', pattern: ['defn-', '$nameNotKeyword'] },
    { kind: 'macro', pattern: ['defmacro', '$nameNotKeyword'] },
    { kind: 'variable', pattern: ['def', '$nameNotKeyword'] },
  ],
  modifiers: new Set(['defn', 'defn-', 'def', 'defmacro', 'defmulti', 'defmethod', 'defonce', 'ns']),
  keywords: new Set([
    'def', 'defn', 'defn-', 'defmacro', 'defmulti', 'defmethod', 'defonce', 'ns', 'let', 'fn', 'if',
    'do', 'when', 'cond', 'loop', 'recur', 'quote', 'var', 'set!', 'true', 'false', 'nil',
  ]),
}

/**
 * Vimscript：`function! Alpha(a) … endfunction`，收尾词是关键字而不是 `}` 或 `end`。
 *
 * `!` 必须进 `multiPunct` 并在规则里当**字面量**写：`function!` 是一个声明形式，
 * 而 `!` 默认是单字符标点——写进模式才能同时覆盖 `function` 与 `function!` 两种写法。
 */
const VIM = {
  lineComments: ['"'],
  blockComments: [],
  strings: [['"', '"'], ["'", "'"]],
  multiPunct: ['==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '.=', '..', '!~', '=~', '!'],
  brackets: { '(': ')', '[': ']', '{': '}' },
  bodyOpen: null,
  blockEnd: TERMINATOR_BLOCK(['endfunction', 'enddef']),
  rules: [
    { kind: 'function', pattern: ['function', '!', '$nameNotKeyword', '$param*'] },
    { kind: 'function', pattern: ['function', '$nameNotKeyword', '$param*'] },
  ],
  modifiers: new Set(['function', 'function!']),
  keywords: new Set([
    'function', 'endfunction', 'def', 'enddef', 'if', 'else', 'elseif', 'endif', 'while', 'endwhile',
    'for', 'endfor', 'try', 'catch', 'finally', 'endtry', 'return', 'let', 'call', 'set', 'unlet',
  ]),
}

/**
 * Emacs Lisp：与 Clojure 同形（`(defun alpha (a) …)`），但声明词是 `defun`/`defmacro`/`defvar`。
 * 注释只有 `;`，字符串只有 `"`——比 Clojure 少一套（没有 `;` 之外的注释起始符）。
 */
const EMACS_LISP = {
  ...LISP,
  rules: [
    // `$param` 紧跟在名字后、且**不是**最后一个元素：这样 `$param*` 才是可选的块开符。
    // `(defun alpha (a)` 里 `$param*` 先跳过形参表 `(a)`，再吃到函数体的 `(`；
    // 少了它，跨度只盖住第一行、把第二行的 `)` 留成孤儿（实测 `alpha@1-1`）。
    { kind: 'function', pattern: ['defun', '$nameNotKeyword', '$param*', '('] },
    { kind: 'macro', pattern: ['defmacro', '$nameNotKeyword', '$param*', '('] },
    { kind: 'variable', pattern: ['defvar', '$nameNotKeyword', '$param*'] },
    { kind: 'variable', pattern: ['defconst', '$nameNotKeyword', '$param*'] },
  ],
  modifiers: new Set(['defun', 'defmacro', 'defvar', 'defconst', 'defcustom', 'defsubst']),
  keywords: new Set([
    'defun', 'defmacro', 'defvar', 'defconst', 'defcustom', 'defsubst', 'let', 'let*', 'if', 'cond',
    'when', 'unless', 'while', 'lambda', 'progn', 'setq', 'quote', 't', 'nil',
  ]),
}

/**
 * Nim：`proc alpha(a: int): int =`，块体由**缩进**给出，头部以 `=` 收尾。
 * 与 OCaml 同样的理由：`$param*` 会把参数吃成名字，所以参数用必选的 `$param`。
 */
const NIM = {
  lineComments: ['#'],
  blockComments: [['#[', ']#']],
  strings: [['"""', '"""'], ['"', '"'], ["'", "'"]],
  multiPunct: ['->', '=>', '==', '!=', '<=', '>=', '..', '+=', '-=', '*=', '/=', '&='],
  brackets: { '(': ')', '[': ']', '{': '}' },
  bodyOpen: null,
  blockEnd: { style: 'indent', headerEnds: new Set(['=']) },
  rules: [
    // 刻意**不写** `$mods*`：`proc` 同时是模式里的字面量、又在 `modifiers` 词表里，
    // 于是 `$mods*` 会先把 `proc` 吃掉，后面的字面量 `proc` 再没有 token 可对
    // （实测：Nim 一个符号都提不出来）。代价是 `export proc` 这类前缀不认，如实记录。
    // **缩进体语言（`bodyOpen: null`）的写法**：模式里既**不写终结符**也不加 `guard: 'body'`——
    // 终结符交给 `blockEnd`（Nim 已配 `headerEnds: ['=']`），而 `guard: 'body'` 只适用于大括号体。
    // 实测：`proc alpha(a: int): int =` → `alpha@1-2`、`target=` 成功；
    // 之前的 `['proc','$name','$param','=']` 永远匹配不上——参数表与 `=` 之间还夹着**返回类型** `: int`，
    // 而 `:` 不是标识符、没有原语能跳过它。
    { kind: 'function', pattern: ['proc', '$name', '$param'] },
    { kind: 'function', pattern: ['proc', '$name', '$param', '='] },
    { kind: 'function', pattern: ['func', '$name', '$param', '='] },
    { kind: 'function', pattern: ['method', '$name', '$param', '='] },
    { kind: 'function', pattern: ['iterator', '$name', '$param', '='] },
    { kind: 'type', pattern: ['type', '$name'] },
    { kind: 'variable', pattern: ['let', '$name', '='], guard: 'notKeyword' },
    { kind: 'variable', pattern: ['var', '$name', '='], guard: 'notKeyword' },
  ],
  modifiers: new Set([]),
  keywords: new Set([
    'proc', 'func', 'method', 'iterator', 'template', 'macro', 'converter', 'type', 'let', 'var',
    'const', 'if', 'elif', 'else', 'when', 'case', 'of', 'for', 'while', 'return', 'discard', 'import',
    'from', 'include', 'echo', 'nil', 'true', 'false',
  ]),
}

/**
 * Zig：`fn alpha(a: i32) i32 { … }`——返回类型是**裸标识符**，没有 `:` 也没有 `->`。
 * 因此函数规则的参数表用 `$param*`（可有可无），后面直接跟块开符 `{`（与 C 家族同形）。
 * Zig 没有正则字面量，`/` 是除法；注释只有 `//`。
 */
const ZIG = {
  lineComments: ['//'],
  blockComments: [],
  strings: [['"', '"'], ["'", "'"]],
  multiPunct: ['=>', '->', '==', '!=', '<=', '>=', '&&', '||', '**', '<<', '>>', '.*', '..', '...', '??', 'orelse', 'catch'],
  brackets: { '(': ')', '[': ']', '{': '}' },
  bodyOpen: '{',
  rules: [
    // 三条规则覆盖 Zig 的三种函数头：`fn f(a: i32) i32 {`（有参数表 + 返回类型）、
    // `fn f() void {`（空参数表 + 返回类型）、`fn f() {`（无返回类型）。
    //
    // **不能用 `$param*` 把前两种合成一条**：`$param*` 跳完参数组后若下一个 token 仍不是 `{`，
    // 它会回溯到「不跳」的分支去要求 `{`（那时 token 是 `(`）——整条规则作废，实测 0 个符号。
    // 返回类型用 `$ident*`（非贪婪吃标识符）接住，`$name` 因此仍捕到函数名而不是类型名。
    // `$ident*` 后面接 `{` 时，`$ident*` 不能是**最后一个**元素——那会让它退化成
    // 「匹配一个可选括号组」而不是「吃掉若干标识符」（`$ident*` 与 `$param*` 共用一条
    // skipOptional 分支，末尾位置的分支语义不同，实测两条规则都匹配不上 ⇒ 0 个符号）。
    // **块开符不能写进模式**：C 家族就是这么写的（`['$ident*','$nameNotKeyword','$param*']` + `guard: 'body'`），
    // 块开符交给 `bodyOpen` 判。之前三条都写了 `{`，所以一个都匹配不上。
    // 实测覆盖三种头：`fn f(a: i32) i32 {`、`fn f() void {`、`fn f() {` → 均得 `名字@1-3` 且 `target=` 成功。
    { kind: 'function', pattern: ['fn', '$name', '$param', '$ident*'], guard: 'body' },
    { kind: 'function', pattern: ['fn', '$name', '$ident*', '$param', '{'], guard: 'body' },
    { kind: 'function', pattern: ['fn', '$name', '$ident*', '{'], guard: 'body' },
    { kind: 'function', pattern: ['fn', '$name', '$param', '{'], guard: 'body' },
    { kind: 'variable', pattern: ['const', '$nameNotKeyword'] },
    { kind: 'variable', pattern: ['var', '$nameNotKeyword'] },
  ],
  modifiers: new Set(['pub', 'extern', 'export', 'inline', 'noinline', 'comptime']),
  keywords: new Set([
    'fn', 'const', 'var', 'pub', 'if', 'else', 'while', 'for', 'switch', 'return', 'break', 'continue',
    'defer', 'errdefer', 'try', 'catch', 'orelse', 'struct', 'enum', 'union', 'error', 'comptime',
    'test', 'usingnamespace', 'export', 'extern', 'inline', 'noinline', 'true', 'false', 'null',
  ]),
}

export const LANGS = {
  js: C_LIKE,
  mjs: C_LIKE,
  cjs: C_LIKE,
  jsx: C_LIKE,
  ts: TYPESCRIPT,
  tsx: TYPESCRIPT,
  mts: TYPESCRIPT,
  cts: TYPESCRIPT,
  py: PYTHON,
  pyi: PYTHON,
  go: GO,
  rs: RUST,
  java: JAVA,
  cs: CSHARP,
  kt: KOTLIN,
  kts: KOTLIN,
  swift: SWIFT,
  c: C_FAMILY,
  h: C_FAMILY,
  cc: C_FAMILY,
  cpp: C_FAMILY,
  cxx: C_FAMILY,
  hpp: C_FAMILY,
  hh: C_FAMILY,
  rb: RUBY,
  php: PHP,
  scala: SCALA,
  lua: LUA,
  dart: DART,
  // 按本机真实文件密度补的第二批
  sh: SHELL,
  bash: SHELL,
  zsh: SHELL,
  ksh: SHELL,
  ps1: POWERSHELL,
  psm1: POWERSHELL,
  psd1: POWERSHELL,
  pyx: CYTHON,
  pxd: CYTHON,
  pxi: CYTHON,
  proto: PROTO,
  pl: PERL,
  pm: PERL,
  bat: BATCH,
  cmd: BATCH,
  // 第三批：验收清单点名、而前两批漏掉的常见格式（它们的缺失代价是 `target=` 直接
  // LOCATOR_NO_LANGUAGE，连符号表都没有）。`gql` 与 `graphql`、`ex` 与 `exs` 同义。
  sql: SQL,
  graphql: GRAPHQL,
  gql: GRAPHQL,
  vue: JS_COMPONENT,
  svelte: JS_COMPONENT,
  astro: ASTRO,
  tf: TERRAFORM,
  r: R,
  ex: ELIXIR,
  exs: ELIXIR,
  clj: LISP,
  cljs: LISP,
  el: EMACS_LISP,
  vim: VIM,
  cython: CYTHON,
  // `.erl`/`.hs`/`.ml` 登记但**不出符号**（跨度判据没做对，见交付报告）：登记的理由是
  // "格式认得出来"——不登记的话 `target=` 会退化成 `LOCATOR_NO_LANGUAGE`（那个错误码的含义是
  // "这个扩展名不认识"），而事实是认识、只是索引不出东西；两种失败必须可区分。
  // 注（2026-09-22 更新）：`nim`/`zig` 已修好并登记（见各自定义里的写法注释），`hrl` 仍未登记
  // ——它需要引擎原语层的改造（见 map 末尾那条注释），不是配置能补的。
  erl: ERLANG,
  // `hs` 加回来了（2026-09-22）：两条修法都落地——`guard: 'topLevel'`（第一列 layout 闸门，
  // 见 matchRule 里的注释）区分顶层绑定与函数体内绑定；并去掉 `::` 签名规则以免与实现同名造歧义。
  hs: HASKELL,
  ml: OCAML,
  // `hs` **刻意不登记**（安全优先）：它当前的规则会给出**假符号**——
  // `['$nameNotKeyword','$param','=']` 匹配不了 `beta a = a + 1`（Haskell 的参数是裸标识符、
  // 不是括号组），而 `['$nameNotKeyword','=']` 会把函数体里的 `a = a + 1` 当成顶层绑定
  // （实测符号表里出现 `a@4-4`）。**假符号比没符号危险**：`target=a` 会改到参数身上。
  // 正确修法（两件，属规则层、不是原语层）：
  //   ① 用 **layout（第一列）守卫**区分顶层绑定与函数体内的绑定；
  //   ② 类型签名 `beta :: Int -> Int` 与实现 `beta a = a + 1` 同名 → 两条规则会造出
  //      `STRUCT_AMBIGUOUS`，需要"签名与实现合并成一个符号"（或只取实现那条）。
  // HASKELL 的定义先留着（带修法注释），修好后再加回这张表。
  nim: NIM,
  zig: ZIG,
  // `hrl` 与 `erl` 同一套规则：`.hrl` 就是 Erlang 头文件。它的常见形态需要 `$rest` 原语
  // （名字与 `)` 之间夹着「逗号 + 字面量」），该原语已加到匹配器里，见 `skipToGroupClose`。
  hrl: ERLANG,
  // `hrl` 仍**不登记**：`.hrl` 的常见形态是 `-define(NAME, 1).` / `-record(name, {...}).`，
  // 名字与 `)` 之间夹着「逗号 + 字面量」，而现有原语（`$param` 跳括号组、`$ident*` 吃标识符、
  // `$mods*` 吃词表、`$label` 捕字符串）**都跳不过它**（两种写法都实测过：加 `')'` 匹配失败、
  // 不加则拿不到符号）。正确修法是给匹配器加一个"跳到当前括号组收尾"的原语（或让 `declarationSpan`
  // 容忍未闭合的组），属**引擎原语层**改造，另开工作令。
}

/** 只按扩展名选语言；不认识就返回 null，调用方据此放弃结构化路径而不是猜。 */
export function langOf(filePath) {
  const m = /\.([A-Za-z0-9]+)$/.exec(filePath ?? '')
  if (m === null) return null
  return LANGS[m[1].toLowerCase()] ?? null
}

// ── 结构索引 ───────────────────────────────────────────────────────────────

/** 从 token 位置反推行号的二分查找表：建一次，查询 O(log n)。 */
function lineIndexFor(src) {
  const starts = [0]
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') starts.push(i + 1)
  return (offset) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

/**
 * 括号配平，得到每个开括号 token 的作用域跨度。
 * 语言无关——`brackets` 表把 `(` `[` `{` 映射到各自的闭括号。
 * @returns {Map<number, number>} 开 token 下标 -> 闭 token 下标
 */
function matchBrackets(tokens, lang) {
  const pairs = new Map()
  const stack = []
  const closeOf = lang.brackets
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]
    if (t.type !== 'punct') continue
    if (closeOf[t.value] !== undefined) stack.push(i)
    else if (stack.length > 0 && tokens[stack[stack.length - 1]].value !== undefined && closeOf[tokens[stack[stack.length - 1]].value] === t.value) {
      pairs.set(stack.pop(), i)
    }
  }
  return pairs
}

/** 跳过一个配平括号组（或单个 token），返回其后的下标。 */
function skipGroup(tokens, k, pairs) {
  const t = tokens[k]
  if (t !== undefined && t.type === 'punct' && pairs.has(k)) return pairs.get(k) + 1
  return k + 1
}

/**
 * 泛型参数表的 `<>` 配平。
 *
 * 为什么不能进 `brackets` 表统一处理：`<` 与 `>` 同时是**小于/大于运算符**，
 * 全局配平会把 `a < b` 到某个 `>` 之间的整段代码当成泛型参数吞掉。
 * 因此它只在**声明头部**被显式调用（`$param*` 里），并带三道保险：
 *   - 嵌套计数必须回到 0
 *   - 扫过的 token 里不允许出现语句终结符（`;` `{` `}`），出现即判定这不是泛型参数表
 *   - token 数上限 `MAX_ANGLE_SCAN`，挡住"文件里全是 `<` 却始终配不平"的病态扫描
 *
 * 上限是**防御性**的，不是语义边界：正常的泛型参数表在几十个 token 内必定闭合。
 * 把它写成命名常量而不是裸 `64`，是因为一个没有名字、没有理由的数字，
 * 下一个读代码的人只能猜它是不是可以改。
 */
const MAX_ANGLE_SCAN = 64

function matchAngle(tokens, open) {
  let depth = 0
  for (let k = open; k < tokens.length && k <= open + MAX_ANGLE_SCAN; k += 1) {
    const t = tokens[k]
    if (t.type !== 'punct') continue
    if (t.value === '<') depth += 1
    else if (t.value === '>') {
      depth -= 1
      if (depth === 0) return k
    } else if (t.value === ';' || t.value === '{' || t.value === '}') return -1
  }
  return -1
}

/**
 * 按模式匹配一条规则，**带回溯**。
 *
 * 为什么必须回溯：`$ident*`（吃掉任意个非关键字标识符）是唯一能表达 C 返回类型的办法，
 * 而它**必须是非贪婪的**——`int foo(void) {` 里若先把 `int` 和 `foo` 都吃掉，后面的 `$name`
 * 就没东西可捕。贪婪版本需要"匹配完再退回一步"这种补丁式修补；回溯是同一件事的干净写法。
 *
 * 模式原语：
 *   `'word'`    字面量 token，必须相等
 *   `$name`     捕获符号名（必须是标识符；决定声明起点）
 *   `$param`    跳过一个配平括号组（必选）
 *   `$param*`   可选：有 `()` 或 `<>` 就跳，没有就跳过这一段
 *   `$mods*`    可选：吃掉任意个 `modifiers` 词表里的修饰符；**逐长度回溯**（字面量本身在词表里时能停在中途）
 *   `$ident*`   可选（**非贪婪**）：吃掉任意个非关键字标识符
 *   `$rest`     跳到**当前所在括号组的收尾 token**（见 `skipToGroupClose`）
 *
 * @returns {{cap, end}|null} cap 是捕获到的命名段；end 是规则末端 token 下标
 */
/**
 * 跳到**当前所在括号组的收尾 token**（`)` 那一个）。
 *
 * 为什么需要这个原语：Erlang 头文件的 `-define(ALPHA, 1).` / `-record(alpha, {beta = 1}).`
 * 里，名字与 `)` 之间夹着「**逗号 + 字面量**」。现有的四个原语都跳不过它——
 * `$ident*` 只吃标识符、`$param`/`$param*` 只跳**完整的**括号组、`$mods*` 只吃修饰词表。
 * 实测两种旧写法都失败：加 `')'` 匹配不上、不加则拿不到符号。
 *
 * 做法：配对表 `pairs` 里找**包含当前位置的最内层**组，跳到它的收尾 token，
 * 让模式里接下来的字面量 `)` 去对上。返回 -1 表示当前不在任何括号组内（规则不匹配）。
 */
function skipToGroupClose(tokens, start, pairs) {
  let bestOpen = -1
  let bestClose = -1
  for (const [open, close] of pairs) {
    if (open < start && start <= close && open > bestOpen) {
      bestOpen = open
      bestClose = close
    }
  }
  return bestClose
}

function matchPattern(tokens, start, pattern, pi, cap, lang, pairs) {
  if (pi === pattern.length) return { cap, end: start }
  const part = pattern[pi]
  const t = tokens[start]

  if (part === '$mods*') {
    /**
     * 修饰符段要**逐个长度回溯**，不能只试「全吃」与「不吃」。
     *
     * `pub const G: i32 = 1` 里 `const` 同时是 Rust 的 modifier 和规则字面量：
     * 全吃 ⇒ 后面的字面量 `const` 永远等不到；不吃 ⇒ 字面量对不上 `pub`。
     * 中间那一步（吃 `pub`、留 `const`）才是解。`pub const fn f` 仍由全吃那一支命中。
     */
    const stops = [start]
    let i = start
    while (tokens[i] !== undefined && tokens[i].type === 'ident' && lang.modifiers !== undefined && lang.modifiers.has(tokens[i].value)) {
      i += 1
      stops.push(i)
    }
    for (let s = stops.length - 1; s >= 0; s -= 1) {
      const hit = matchPattern(tokens, stops[s], pattern, pi + 1, cap, lang, pairs)
      if (hit !== null) return hit
    }
    return null
  }
  if (part === '$param*' || part === '$ident*') {
    // 先试"跳"的版本，失败再试"不跳"的版本——这就是回溯
    const advanced = skipOptional(tokens, start, part, lang, pairs)
    if (advanced !== start) {
      const hit = matchPattern(tokens, advanced, pattern, pi + 1, cap, lang, pairs)
      if (hit !== null) return hit
    }
    return matchPattern(tokens, start, pattern, pi + 1, cap, lang, pairs)
  }

  if (t === undefined) return null
  if (part.startsWith('$')) {
    if (part.startsWith('$param')) {
      return matchPattern(tokens, skipGroup(tokens, start, pairs), pattern, pi + 1, cap, lang, pairs)
    }
    /**
     * `$label`：块名可以是一个**带引号的字符串**（HCL 的 `resource "aws_type" "name"`）。
     * 把它单独作为一种原语，而不是把 `$name` 放宽到任意 token——`$name` 的“只捕标识符”
     * 是其它 40 余种语言的跨度根基，放宽它等于把所有语言的规则一起改掉。
     * 剥引号后仍要求像标识符：`""` 与 `"a b"` 不是名字，宁可这条规则不匹配。
     */
    if (part === '$rest') {
      const close = skipToGroupClose(tokens, start, pairs)
      if (close === -1) return null
      return matchPattern(tokens, close, pattern, pi + 1, cap, lang, pairs)
    }
    if (part === '$label') {
      // 捕获值先保持**原样**（含引号）：`matchRule` 靠“值相等”反查名字 token 来定声明起点，
      // 在这里剥引号会让那次反查找不到 token（实测：起点退回模式起点，绑定闸门误杀整条规则）。
      // 剥引号的动作放在 `indexStructure` 推符号之前，两处各管一件事。
      if (t.type !== 'ident' && t.type !== 'string') return null
      return matchPattern(tokens, start + 1, pattern, pi + 1, { ...cap, $name: t.value }, lang, pairs)
    }
    if (t.type !== 'ident') return null
    // 名字的关键字约束必须**在这里**判，不能放到事后的 guard 里。
    // 事后 guard 只能返回 null，而 null 会让整条规则回溯到"不跳"的分支——它无法让
    // `$ident*` 换个长度重试。实测后果：`int foo(void) {` 里 `$ident*` 先贪婪吃下
    // `int foo`，`$name` 捕到 `foo` 是对的，但事后按名字反查找到了第一个叫 `int` 的 token，
    // 判成关键字，整条规则作废——报出 0 个函数。
    // 把约束放进捕获点，匹配器就能连同 `$ident*` 的长度一起回溯出正确解。
    if (part === '$nameNotKeyword' && lang.keywords.has(t.value)) return null
    return matchPattern(tokens, start + 1, pattern, pi + 1, { ...cap, [part === '$nameNotKeyword' ? '$name' : part]: t.value }, lang, pairs)
  }
  if (t.value !== part) return null
  return matchPattern(tokens, start + 1, pattern, pi + 1, cap, lang, pairs)
}

/** 可选段的"跳"这一步（`$param*` / `$ident*`）：跳不动就原地返回，由调用方回溯。 */
function skipOptional(tokens, k, part, lang, pairs) {
  if (part === '$ident*') {
    // 只吃**非关键字**标识符：关键字是模式里的字面量，不该被这个段吞掉
    let i = k
    while (tokens[i] !== undefined && tokens[i].type === 'ident' && !lang.keywords.has(tokens[i].value)) i += 1
    return i
  }
  // $param*
  let i = k
  if (tokens[i] !== undefined && tokens[i].type === 'punct' && tokens[i].value === '(' && pairs.has(i)) i = pairs.get(i) + 1
  // 一个字符串也算可选段：HCL 的 `resource "aws_type" "name" {` 里 `$label` 捕走第一个标签后，
  // `$param*` 必须跳过第二个，否则块开符永远等不到（跨度只剩签名行）。
  if (tokens[i] !== undefined && tokens[i].type === 'string') i += 1
  const lt = tokens[i]
  if (lt !== undefined && lt.type === 'punct' && lt.value === '<') {
    const close = matchAngle(tokens, i)
    if (close !== -1) i = close + 1
  }
  return i
}

/**
 * 一条规则能否落在 tokens[i] 上，并给出声明起点。
 *
 * 关键区分：`$name` 是**捕获**，`$param` 是**跳过**。跨度只能由捕获与字面量决定——
 * 曾经把两者都当"消费"，于是 `function describe(a, b) {` 的跨度从参数里的 `(` 起算，
 * 塌成一行；`const todos = items.map((item) => ...)` 的跨度从箭头函数参数起算，把
 * `for` 的块当成了变量作用域。这不是参数问题，是跨度语义错了。
 *
 * @returns {{cap, startTok, matchStart, end}|null} startTok 是名字所在 token；
 *   matchStart 是规则**起点**——两者不同，且用途不能混（见 indexStructure 的唯一性闸门）
 */
function matchRule(tokens, i, rule, lang, pairs, lineAt) {
  const hit = matchPattern(tokens, i, rule.pattern, 0, {}, lang, pairs)
  if (hit === null) return null
  const { cap, end } = hit
  // 声明起点是**名字**所在的位置，不是模式起点：C 的 `static int *foo(` 起点在 `foo`。
  // 用名字 token 反查，避免把返回类型算进声明跨度。
  // `$label` 捕到的可能是**字符串** token（`resource "aws_instance"`），所以除了 ident
  // 也要认 string——但只认“值恰好等于捕获值”的那个（`$label` 不剥引号，见 matchPattern）。
  let startTok = i
  if (typeof cap.$name === 'string') {
    for (let k = i; k < end; k += 1) {
      if (tokens[k].value === cap.$name) {
        startTok = k
        break
      }
    }
  }
  const k = end
  if (rule.guard === 'notKeyword' && lang.keywords.has(cap.$name)) return null
  // 成员访问闸门：`foo.bar(...)` 里的 `bar` 是调用/属性，不是方法声明。
  // 没有这一道，`Object.assign({...})`、`ctx.sessionProjections.register({...})`
  // 会被认成方法声明——实测一个 197 行的文件里冒出 29 个假 method。
  if (rule.guard === 'memberName') {
    const prev = tokens[i - 1]
    if (prev !== undefined && prev.type === 'punct' && (prev.value === '.' || prev.value === '?.')) return null
    if (lang.keywords.has(cap.$name)) return null
  }
  // `body` 守卫：规则匹配完之后，下一个有效 token 必须是块体开符。
  // 这是 C 家族函数定义规则的判别器——`ret name(params) {` 与"调用 `foo(x);`"、
  // "声明 `int foo(int);`"在词法上唯一的硬差别就是参数表后面那个 `{`。
  // 名字不能是关键字这一条由模式里的 `$nameNotKeyword` 在**捕获点**判（见 matchPattern），
  // 放这里会因为无法回溯而误杀。
  if (rule.guard === 'body') {
    if (tokens[k] === undefined || tokens[k].value !== lang.bodyOpen) return null
  }
  /**
   * Erlang 的**子句**闸门：`beta(A) ->` 是函数子句，`-module(alpha).` 是属性。
   *
   * 两个判据：
   *   1. 名字前一个 token 不能是 `-`——属性规则（`['-', 'module', '$param']`）已经捕了属性，
   *      少了这一条，同一个 `-module(alpha)` 会被函数规则再命中一次并报出一个叫 `module`
   *      的假函数（名字来自属性词而不是真名字）。
   *   2. 参数表的**下一个** token 必须是 `->`：这是 Erlang 里函数子句与函数**调用**
   *      （`foo(1),` 在体里到处出现）在词法上唯一的硬差别——与 C 家族的 `body` 守卫同理。
   */
  /**
   * **第一列（layout）闸门**：仅当名字是该行**第一个** token 时才认。
   *
   * 为 Haskell 加的：那里的顶层绑定没有关键字可锚定（`beta a = a + 1` 与函数体内的
   * `a = a + 1` 在 token 流上完全同形），唯一的硬差别是 **layout 规则**——顶层绑定的名字在第一列。
   * 没有这一道，实测会报出假符号 `a@4-4`，而**假符号比没符号危险**：`target=a` 会改到参数身上。
   */
  if (rule.guard === 'topLevel' && !clauseInitial(tokens, startTok, lineAt)) return null
  if (rule.guard === 'attributeClause') {
    /**
     * Erlang 函数子句是**语句级**声明：只能出现在文件开头、上一语句的 `.` 之后，
     * 或同一函数上一子句的 `;` 之后。
     *
     * 这条边界同时挡住三类假符号：属性里的名字（`-module(alpha)` / `-define(ALPHA, …)`）、
     * `-spec f(A) -> …` 里的 `f`（spec 内部也有 `->`，只看箭头会误收）、以及函数体里的
     * 调用 `foo(X)`（前一 token 是 `(` / `,` / `=` 等）。
     *
     * 前一 token 是 `;` 表示同一函数的后续子句：它们共享到最后一个 `.` 的跨度，
     * 重复登记会让 `target=f` 报 STRUCT_AMBIGUOUS，所以只登记第一个子句。
     */
    const prev = tokens[i - 1]
    if (prev !== undefined) {
      if (prev.type !== 'punct' || (prev.value !== '.' && prev.value !== ';')) return null
      if (prev.value === ';') return null
    }
    const open = tokens[startTok + 1]
    if (open === undefined || open.type !== 'punct' || open.value !== '(' || !pairs.has(startTok + 1)) return null
    // 参数组之后可以是 `->`，也可以先是 `when` 守卫（`f(X) when X > 0 -> …`）。
    // 守卫里没有 `->`；遇到 `;` / `.` 仍没有 `->` 说明这不是函数子句。
    let j = end
    for (; j < tokens.length; j += 1) {
      const t = tokens[j]
      if (t.type !== 'punct') continue
      if (t.value === ';' || t.value === '.') return null
      if (pairs.has(j)) {
        j = pairs.get(j)
        continue
      }
      if (t.value === '->') break
    }
    if (j >= tokens.length) return null
  }
  // 放最后，因为它与其它守卫互不依赖。
  if (looksLikeBinding(tokens, startTok, k, lang)) return null
  return { cap, startTok, matchStart: i, end: k }
}

/**
 * 这一处是不是"绑定"而非"声明"。
 *
 * 两个判据，缺一不可：
 *   1. **名字本身不能是关键字**。`export` 在 JS 的 `modifiers` 词表里（它是修饰符），
 *      但 `export function alpha` 里 `function` 已被"前有修饰符"闸门跳过，于是 `export`
 *      自己匹配上 `$mods* $name` 并把 **`function` 当成符号名**——符号表里出现两个 `alpha`，
 *      坐标完全相同，解析时报歧义、`target=alpha` 直接失效。
 *   2. **名字后面不能跟 `of` / `in`**，否则 `const item of list` 的 `item` 会被当成变量声明，
 *      跨度还覆盖整个循环体。
 *
 * 第一版只做了第 2 条，于是 `export function` / `public class`（凡是"修饰符+关键字"的写法）
 * 都会多出一个同名假符号。一个只查了后半段的守卫，比没有守卫更糟——它看起来在防护。
 *
 * @param tokens - token 流
 * @param nameTok - 名字所在下标
 * @param after - 名字之后的下标
 * @param lang - 语言配置（用它的关键字表判定，不新增名单）
 */
function looksLikeBinding(tokens, nameTok, after, lang) {
  const name = tokens[nameTok]
  if (name !== undefined && lang.keywords.has(name.value)) return true
  const t = tokens[after]
  return t !== undefined && t.type === 'ident' && lang.keywords.has(t.value) && (t.value === 'of' || t.value === 'in')
}

/**
 * 声明起点前不能是修饰符。
 *
 * `$mods*` 让"修饰符 + 关键字"的组合共用一条规则，代价是同一个声明能在多个位置匹配上：
 * `public static final class A` 会在 `class`、`static`、`public` 三处各命中一次，报出四个同名符号。
 * 这不是匹配错了，是**没有定义唯一性**——声明起点就是关键字本身，前面还有修饰符就说明
 * 命中的不是起点。用词表判定，因此对每门语言自动成立。
 */
function precededByModifier(tokens, i, lang) {
  const prev = tokens[i - 1]
  return prev !== undefined && prev.type === 'ident' && lang.modifiers !== undefined && lang.modifiers.has(prev.value)
}

// ── 块体终结：跨度必须覆盖符号真实占据的整段 ────────────────────────────────

/** 一行的前导空白。 */
const LEADING_SPACE = /^[ \t]*/

const leadingSpace = (line) => LEADING_SPACE.exec(line)[0]

/**
 * 两行的缩进关系：`inside`（更深）、`outside`（同级或更浅）、`ambiguous`（判不了）。
 *
 * 比的是**前导空白串**而不是格数：`    ` 与 `\t` 谁更深取决于制表位宽度（Python 取 8），
 * 而这种"看着更深、实际同级"的差别正是缩进型语言最贵的静默错误。只有前缀关系成立才判得了；
 * 空格与制表符混用时返回 ambiguous，调用方据此 fail-closed，绝不猜。
 */
function indentRelation(inner, base) {
  if (inner === base) return 'outside'
  if (inner.startsWith(base)) return 'inside'
  if (base.startsWith(inner)) return 'outside'
  return 'ambiguous'
}

/**
 * 缩进型声明的头部末端：`def`/`class` 的头一定以 `:` 收尾。
 *
 * 必须先找这个 `:` 而不是直接拿 `)`，因为头部可以有续行（`def f(\n  a) -> T:` 合法，
 * 且括号内的续行**可以顶格写**——那时按缩进判断会把头部后半截当成块体之外）。
 * 头部收尾符之后的 `=` / `;`（头部里不可能出现）说明已经走进块体，返回 -1 交给 fail-closed。
 * 但 `=` 对 OCaml/Haskell 恰恰**是**头部的收尾符，因此哪些 token 收尾由 `headerEnds` 给定，
 * 不写死成 `:`——写死会让那两门语言的每一个 `let … =` 都判成“头部没有收尾符”。
 *
 * @param headerEnds - 可作头部收尾符的 token 集合
 * @returns {number} 头部收尾符的 token 下标；找不到返回 -1
 */
function headerColon(tokens, fromTok, headerEnds, lineAt, pairs) {
  let depth = 0
  for (let k = fromTok + 1; k < tokens.length; k += 1) {
    const t = tokens[k]
    // 换行即停（括号**内**的续行不算，那时 depth > 0）：
    // 少了这一条，扫描会越过本声明去撞**下一条语句**的 `=`，
    // 于是 `let alpha a =\n  a + 1\n\nlet gamma = 2` 里 `alpha` 的"头部收尾符"变成了
    // `gamma` 那一行的 `=`（实测：跨度从 1-2 变成 1-4，把下一条声明也盖进来）。
    if (depth === 0 && k > fromTok + 1 && lineAt(t.start) > lineAt(tokens[k - 1].end)) return -1
    if (t.type !== 'punct') continue
    // **整个括号组一次跳过**：参数表里的 `:` 不是头部收尾符。
    // 少了这一条，Nim 的 `proc alpha(a: int): int =` 会在形参的 `a:` 上就"找到"收尾符
    // （实测：符号全部 spanComplete=false、一个符号都提不出来）。
    if (pairs !== undefined && pairs.has(k)) {
      const close = pairs.get(k)
      if (lineAt(tokens[close].end) > lineAt(t.start)) depth += 1
      k = close
      continue
    }
    if (t.value === '(' || t.value === '[' || t.value === '{') depth += 1
    else if (t.value === ')' || t.value === ']' || t.value === '}') depth -= 1
    else if (depth === 0 && headerEnds.has(t.value)) return k
    // `=` 是「块体开始」的信号，但它**只有在本语言里不是头部收尾符时**才是。
    // Nim 的 `proc f(a: int): int =` 里返回类型那段先出现 `:`，若在这里就认 `=`，
    // 判据会返回 -1（实测：Nim 的符号全部 spanComplete=false）。
    else if (t.value === ';' && depth === 0 && !headerEnds.has(';')) return -1
    else if (t.value === '=' && depth === 0 && !headerEnds.has('=')) return -1
  }
  return -1
}

/**
 * 缩进块体的末端（Python / Cython）。
 *
 * 判据只有一条：块体是**头部之后、第一条不比声明行更深的内容行之前**的整段。
 * 走 token 流而不是行文本，是为了让空行、注释行、多行字符串自然落到正确的一侧：
 *   · 空行与纯注释行不产 token，因此不会被收进跨度（收进去等于静默删注释）；
 *   · 三引号字符串是一个 token，跟着它走到**结束行**，不会被字符串里顶格的文本误判成块体结束。
 *
 * @returns {{endTok: number, note: string}} 判不了时 endTok = -1，note 带上实际值（行号与两种缩进）
 */
function indentBlockEnd(tokens, lines, fromTok, baseLine, baseIndent, lineAt, headerEnds, pairs) {
  const colon = headerColon(tokens, fromTok, headerEnds, lineAt, pairs)
  if (colon === -1) {
    return {
      endTok: -1,
      note: `line ${baseLine}: no ${[...headerEnds].map((h) => JSON.stringify(h)).join('/')} terminates this declaration's header, so its block cannot be delimited`,
    }
  }
  let last = colon
  const headerLine = lineAt(tokens[colon].end)
  /**
   * 头部收尾符就是**最后一个 token**：声明是单行的（`main = print 1`、`let gamma = 2`）。
   * 那时跨度就是这一行——没有块体，也没有"判不了"的成分。
   *
   * 这一条不能省：循环会因为越界直接结束，`last` 停在收尾符上，而调用方**无法区分**
   * “真的只有一行”与“循环没走完”。实测（Haskell 的 `main =`、OCaml 的 `let gamma =`）
   * 两种语言的文件末尾绑定都因此被标成 `spanComplete: false` 并拒绝 `target=`。
   */
  if (colon === tokens.length - 1) return { endTok: colon, note: '' }
  for (let k = colon + 1; k < tokens.length; k += 1) {
    const startLine = lineAt(tokens[k].start)
    if (startLine <= headerLine) {
      // 头部的续行（`def f(\n  a):`）不是块体，但必须落在跨度里
      last = k
      continue
    }
    const indent = leadingSpace(lines[startLine - 1] ?? '')
    const rel = indentRelation(indent, baseIndent)
    if (rel === 'inside') {
      last = k
      continue
    }
    if (rel === 'outside') break
    return {
      endTok: -1,
      note: `line ${startLine} is indented ${JSON.stringify(indent)} while the declaration line ${baseLine} is indented ${JSON.stringify(baseIndent)} — tabs and spaces cannot be compared, so the block end is not determinable`,
    }
  }
  return { endTok: last, note: '' }
}

/**
 * 后置修饰符判据：`if`/`unless`/`while`/`until` 出现在这些 token 之后时，它开的是一个块
 * （`x = if c … end`、`foo(if c then … end)`）；出现在别处（标识符/数字/字符串/`)` 之后）则是
 * **后置修饰符**（`puts x if y`），不开块。
 *
 * 与 `REGEX_PRECEDING_KEYWORDS` 同类：这是**词法**判据表，不是关键字表，因此不进语言的 `keywords`。
 * 表里少一项只会让跨度偏短，而那会被 `closerBlockEnd` 的缩进校验拦住 → fail-closed，方向是安全的。
 */
const CLAUSE_BOUNDARY = new Set([
  ';', 'then', 'else', 'elsif', 'do', '=', '(', '[', '{', ',', ':', '=>', '?',
  '&&', '||', 'and', 'or', 'not', '!',
  '+=', '-=', '*=', '/=', '%=', '**=', '||=', '&&=', '<<=', '>>=', '|=', '&=',
])

/** 这个关键字是否落在子句起始位置（行首，或紧跟一个不能结束表达式的 token）。 */
function clauseInitial(tokens, k, lineAt) {
  const prev = tokens[k - 1]
  if (prev === undefined) return true
  if (lineAt(prev.end) !== lineAt(tokens[k].start)) return true
  return CLAUSE_BOUNDARY.has(prev.value)
}

/** 成员访问闸门：`x.class` 里的 `class` 是方法名，不是开块词。 */
function isMemberName(tokens, k) {
  const prev = tokens[k - 1]
  return prev !== undefined && prev.type === 'punct' && (prev.value === '.' || prev.value === '&.' || prev.value === '::')
}

/**
 * 这一处的 `<<` 是不是 heredoc 引入符（`<<~TAG` / `<<-TAG` / `<<"TAG"` / `<<TAG`）。
 *
 * 词法器**不认识 heredoc**：它的正文会被当成代码扫成 token，于是正文里顶格的一行 `end`
 * 会被当成真收尾词，把跨度截在正文中间——静默改错地方。判据取"紧贴 + 位于行尾"：
 * 真的 heredoc 引入符后面紧跟标签并立即换行。代价是 `list <<ITEM` 这种紧贴写法会被误判，
 * 后果只是该符号拒绝 `target=`（安全方向）——这是刻意接受的过近似。
 */
function heredocAt(tokens, k, lineAt) {
  const t = tokens[k]
  const next = tokens[k + 1]
  if (next === undefined || next.start !== t.end) return false
  let end = k + 1
  if (next.value === '~' || next.value === '-') {
    // `<<~TAG` / `<<-TAG`：前缀之后才是标签
    const tag = tokens[k + 2]
    if (tag === undefined || tag.start !== next.end) return false
    end = k + 2
  }
  const tag = tokens[end]
  const named = tag.type === 'ident' && /^[A-Z_]/.test(tag.value)
  const quoted = tag.type === 'string' && (tag.value.startsWith('"') || tag.value.startsWith("'"))
  if (!named && !quoted) return false
  // heredoc 的正文从**下一行**开始：引入符这一行的标签之后不该再有 token
  const after = tokens[end + 1]
  return after === undefined || lineAt(after.start) > lineAt(t.start)
}

/**
 * `end` 收尾块体的末端（Ruby / Lua）。
 *
 * 按 `openers` 与 `closer` 配对计数，深度回到 0 的那个收尾词就是末端。两道校验把"数错了"
 * 变成 fail-closed 而不是偏短的跨度：
 *   1. **缩进校验**：Ruby/Lua 的收尾词与它的开块词对齐，因此收尾词所在行的前导空白必须与声明行相同。
 *      正则里的 `end`（`/end/`）会在这里露馅。
 *   2. **heredoc 校验**：见 {@link heredocAt}。
 *
 * @returns {{endTok: number, note: string}} 判不了时 endTok = -1，note 带上实际值
 */
function closerBlockEnd(tokens, startTok, fromTok, spec, lineAt, lines) {
  const baseLine = lineAt(tokens[startTok].start)
  const baseIndent = leadingSpace(lines[baseLine - 1] ?? '')
  let depth = 1
  let loopLine = -1
  for (let k = fromTok + 1; k < tokens.length; k += 1) {
    const t = tokens[k]
    const line = lineAt(t.start)
    if (t.type === 'punct' && t.value === '<<' && heredocAt(tokens, k, lineAt)) {
      return { endTok: -1, note: `line ${line}: heredoc is not understood by the lexer, so the block end is not determinable` }
    }
    if (t.type !== 'ident') continue
    if (spec.markers.has(t.value) && loopLine !== -1) {
      // 循环体的引导词：`for i=1,10 do` 只有一个块，这一处的 `do` 不额外计数
      loopLine = -1
      continue
    }
    if (loopLine !== -1 && line !== loopLine) loopLine = -1
    if (spec.openers.has(t.value)) {
      if (spec.modifiers.has(t.value) && !clauseInitial(tokens, k, lineAt)) continue
      if (isMemberName(tokens, k)) continue
      depth += 1
      if (spec.loopOpeners.has(t.value)) loopLine = line
      continue
    }
    if (t.value === spec.closer || (spec.altCloser !== undefined && t.value === spec.altCloser)) {
      depth -= 1
      if (depth > 0) continue
      const closeIndent = leadingSpace(lines[line - 1] ?? '')
      if (closeIndent !== baseIndent) {
        return {
          endTok: -1,
          note: `the "${t.value}" at line ${line} that would close the declaration at line ${baseLine} is indented ${JSON.stringify(closeIndent)} instead of ${JSON.stringify(baseIndent)}`,
        }
      }
      return { endTok: k, note: '' }
    }
  }
  return { endTok: -1, note: `no "${spec.closer}" closes the declaration at line ${baseLine} (depth ${depth} at end of file)` }
}

/**
 * 语句终结符收尾的块体末端（SQL 的 `;`、Erlang 的 `.`、Vim 的 `endfunction`）。
 *
 * 三条停止条件，都取自本文件的既有概念：
 *   1. **终结符**：`terminators` 里的 token（SQL 的 `;`、Erlang 的 `.`）或关键字
 *      （Vim 的 `endfunction`）。关键字按小写比对——Vim 允许 `EndFunction`，
 *      只比原样会把跨度截短（静默）。
 *   2. **换行**：行尾停下的 token 是**上一行**的末尾，因此终结符在下一行时
 *      （`CREATE TABLE alpha (\n  beta INTEGER\n);`）照常能走到它；一行里没找到终结符时
 *      宣告终结的那一位就是块闭符（HCL 的 `}`）——跳过 `{ … }` 整层时记下的正是它。
 *   3. **括号组整层跨过**：`SELECT COUNT(*) AS n` 里的 `(` `)` 一次跳完，
 *      于是“终结符在括号外”只需看括号**之后**那个 token，不必维护深度变量。
 *
 * 跳层必须把它落在**组尾**上（`skippedEnd`），不能只是把游标移过去：块体本身就是那个组时
 * （HCL 的 `variable "x" { … }`），组尾就是声明的最后一位，丢掉它会让跨度只剩签名行。
 *
 * @returns {{endTok: number, note: string}} 找不到任何收尾时 endTok = -1（fail-closed）。
 *   不退回“只有签名行”：那正是本文件最贵的那个静默失效。
 *
 * ── 为什么要跳表（这段曾经的 O(n²) 退化）────────────────────────────────────
 * 三条停止条件里，第 1、3 条在**整份文件只有一行**、且语言是终结符型（SQL / Erlang / Vim）时
 * 永不成立：没有换行，语料里也没有终结符 ⇒ 每个声明都一路扫到 token 流末尾 ⇒ 全文件 O(n²)。
 * 退化形状（`CREATE TABLE` 声明并成一行、一个 `;` 都没有；1k/2k/4k/8k）中位数实测：
 * 改前 76.9 / 277.1 / 1145.8 / 5709.9 ms（每翻一倍 ×3.6～×5.0），改后 14.6 / 26.0 / 51.6 / 87.2 ms
 *（×1.7～×2.0），末档提速 ×65.5。读数时机内另有并行负载，判据取比值不取绝对值。
 *
 * 改法 = 两张长度 n 的 `Int32Array` 后缀最小值表（每次 `buildStructure` **只建一次**，O(n)）：
 *   · `nextStop[j]`     = 最小的 `i ≥ j`，使 `isTerminatorToken(i)` 或（`i` 不是括号开符且 `nl(i)`）；
 *   · `nextPairOpen[j]` = 最小的 `i ≥ j` 且 `i` 是配平括号组的开符。
 * 同一个 k 上的判定次序照抄原循环（终结符 → 括号跳层 → 换行），所以「既是开符又换行」的位置
 * **不进** `nextStop`；`nl(i)` 就是原来的 `lineAt(tokens[i].start) > lineAt(tokens[i-1].end)`（`i ≥ 1`）
 * —— 跳层之后 `i - 1` 正好是组尾，与原代码逐字一致。于是每个 k 只做一次 O(1) 的读表：
 * 两张表里先到的那个决定「返回」还是「整层跳过去」，而跳层次数被括号层数封顶 ⇒ 每份声明 O(跳层数)。
 *
 * 首 token（`fromTok + 1`）不适用换行那条（原循环的 `k > fromTok + 1` 守卫），单独处理一次。
 * 换行命中返回的仍是 `skippedEnd`（没有跳层时退回 `s - 1`），与逐 token 扫描逐字相同。
 */
/** 终结符 token 判据：`punct` 比原值、`ident` 比小写（其余 token 类型一律不是）。 */
function isTerminatorToken(t, terminators) {
  if (t.type === 'punct') return terminators.has(t.value)
  if (t.type === 'ident') return terminators.has(t.value.toLowerCase())
  return false
}

/**
 * {@link terminatorBlockEnd} 用的两张后缀最小值表。判定优先级与逐 token 扫描同一个 k 上的次序相同。
 * 只在该语言真的走终结符风格时才会被调用。
 */
function terminatorScan(tokens, pairs, lineAt, terminators, newlineStops) {
  const n = tokens.length
  const nextStop = new Int32Array(n)
  const nextPairOpen = new Int32Array(n)
  /**
   * `chainEnd[j]` = 从 `j` 起**只做括号跳层**能走到的最后一个开符（没有就是 -1）。
   *
   * 为什么要它：一个停止条件都找不到时，原循环会把能碰到的顶层括号组逐个跨过去，最后停在
   * **最后一个**组尾上（不是第一个）——逐组跳是 O(组数)，而这条链的尾巴可以在建表时一次算完。
   * 这一支正是退化形状（整份文件一行、无终结符，而声明带括号参数表）里每一份声明都要走的那条路。
   */
  const chainEnd = new Int32Array(n)
  const chainEndFrom = new Int32Array(n)
  let stop = -1
  let open = -1
  for (let i = n - 1; i >= 0; i -= 1) {
    const t = tokens[i]
    const isOpen = t.type === 'punct' && pairs.has(i)
    if (isOpen) {
      open = i
      // 跳过本组之后的第一个开符若已算过，就接上它的链尾（下标严格更大 ⇒ 从右往左一定算过了）
      const after = pairs.get(i) + 1
      chainEnd[i] = after < n && nextPairOpen[after] !== -1 ? chainEnd[nextPairOpen[after]] : i
    }
    // 终结符优先于括号跳层，括号跳层优先于换行 —— 与原循环在同一个 k 上的判定次序一一对应
    // 终结符优先于括号跳层，括号跳层优先于换行（newlineStops=false 时换行不是停止条件）
    if (isTerminatorToken(t, terminators) || (newlineStops && !isOpen && i >= 1 && lineAt(t.start) > lineAt(tokens[i - 1].end))) {
      stop = i
    }
    nextStop[i] = stop
    nextPairOpen[i] = open
    chainEndFrom[i] = open === -1 ? -1 : chainEnd[open]
  }
  return { nextStop, nextPairOpen, chainEndFrom }
}

/**
 * **每次建索引只建一次**的跳表：第一次真的用到时才建（非终结符型语言一个字都不付），
 * 之后同一份内容的所有声明共用同一张表 —— 这正是把 O(n²) 拉回 O(n) 的那一步。
 */
function lazyTerminatorScan(tokens, pairs, lineAt) {
  let table = null
  return (spec) => {
    if (table === null) table = terminatorScan(tokens, pairs, lineAt, spec.terminators, spec.newlineStops !== false)
    return table
  }
}

/**
 * 语句终结符收尾的块体末端（SQL 的 `;`、Erlang 的 `.`、Vim 的 `endfunction`）。
 * 三条停止条件、跳层的落点、以及为什么要跳表，写在上面那一段里（那段就是这个函数的文档，
 * 判据与跳表分别落在 {@link isTerminatorToken} 与 {@link terminatorScan} 上）。
 */
function terminatorBlockEnd(tokens, pairs, fromTok, spec, lineAt, scan) {
  // 只认终结符（Erlang）：找不到就是跨度不完整，不能拿换行/组尾兜底当一个完整跨度。
  const onlyTerminator = spec.newlineStops === false
  let skippedEnd = -1
  let k = fromTok + 1
  if (k >= tokens.length) return { endTok: -1, note: '' }
  // 首 token 不适用「换行」那条（原循环的 `k > fromTok + 1` 守卫）：单独处理，其后全部走表。
  const first = tokens[k]
  if (isTerminatorToken(first, spec.terminators)) return { endTok: k, note: '' }
  if (first.type === 'punct' && pairs.has(k)) {
    skippedEnd = pairs.get(k)
    k = skippedEnd + 1
  } else k += 1
  const { nextStop, nextPairOpen, chainEndFrom } = scan
  while (k < tokens.length) {
    const s = nextStop[k]
    const o = nextPairOpen[k]
    if (s !== -1 && (o === -1 || s < o)) {
      // stop 位置一定不是括号开符（建表时就排除了），所以 `s === o` 不可能出现
      if (isTerminatorToken(tokens[s], spec.terminators)) return { endTok: s, note: '' }
      if (onlyTerminator) return { endTok: -1, note: '' }
      return { endTok: skippedEnd === -1 ? s - 1 : skippedEnd, note: '' }
    }
    if (o === -1) return { endTok: onlyTerminator ? -1 : skippedEnd, note: '' }
    // 这一段里一个停止条件都没有：原循环会一路跨到**最后一个**组尾 ⇒ 用链尾表一次到位（O(1)）
    if (s === -1) return { endTok: onlyTerminator ? -1 : pairs.get(chainEndFrom[k]), note: '' }
    skippedEnd = pairs.get(o)
    k = skippedEnd + 1
  }
  return { endTok: onlyTerminator ? -1 : skippedEnd, note: '' }
}

/**
 * 头部扫描：从规则末端走到块开符（或走到语句边界）。
 *
 * 原实现是一个 `endTok + 6` 的 token 窗口，窗口够不到就退回"只有签名行"：
 * `const f = (a, b) => { … }` 的块开符在第 7 个 token，于是 `target=f` 只换签名行、
 * 函数体原样留下，而 `spanComplete` 仍然是 true——静默改错地方。
 * 现在**长度不再是判据**，判据是结构：
 *   1. 配平括号组（参数表、泛型、调用实参）**整层跨过** ⇒ 多长都只是一步
 *   2. 深度 0 的块开符 `{` 就是块体；`[` 也算（`const X = [ … ]` 的跨度要盖住整个字面量）
 *   3. `;` 与 `}` 是语句/块边界 ⇒ 声明到此结束（没有块体）
 *   4. 换行处看下一 token 能不能续行（见 {@link headerContinues}），不能就是新语句开始
 *
 * 返回的 `lastTok` 是**属于这个声明的最后一个 token**：有块体时是闭符，没有块体时是语句末尾。
 * 因此"没有块体"不再等于"只有签名行"——`const ok = first\n  && second` 的跨度是两行。
 *
 * 返回的 `uncertainTok` 不是"兜底"，是把"判不了"如实报出来：停在了一个既不能续行、
 * 也不能起新声明的 token 上（例如某个续行关键字漏进了配置表）。那种时候宁可拒绝，
 * 不交出一个偏短的跨度。
 *
 * @returns {{bodyOpen: number, lastTok: number, sawBinding: boolean, uncertainTok: number}}
 *   bodyOpen = -1 表示没有块体；uncertainTok = -1 表示这个判断是确定的
 */
function scanBodyOpen(tokens, pairs, endTok, lang, lineAt, kind) {
  const open = lang.bodyOpen
  const clauses = lang.headerKeywords ?? NO_HEADER_KEYWORDS
  let last = endTok
  let sawBinding = false
  let k = endTok + 1
  while (k < tokens.length) {
    const t = tokens[k]
    const prev = tokens[k - 1]
    if (t.type === 'punct' && (t.value === ';' || t.value === '}')) break
    /**
     * Lisp 族：声明本身是列表的第一个元素（`(ns alpha.core)`、`(defn f [a] a)`）。
     * 名字之后遇到收口 `)` 就是**包住这个声明的那对括号**收尾了——后面的 `(`（下一个 form）
     * 不是块体。少了这一条，`(ns alpha)` 会把下一行 `(defn …)` 的 `(` 当体，跨度扩到整个文件，
     * `target=alpha` 会连后面的函数一起删掉（lang-coverage 的 cljs 夹具就是这个形状）。
     */
    if (open === '(' && t.type === 'punct' && t.value === ')') break
    /**
     * 块开符判定：`bodyOpen` 本身，加上**配置声明的**其它块开符（`[$ … ]` 字面量体），
     * 再加上 `bodyOpens` 里显式列出的字符。
     *
     * 这里曾经无条件把 `(` 也算作块开符（为了让 Lisp 的 `(defn name [args] …)` 成立），
     * 那是**回归**：`fun alpha(a: Int): Int {` 的参数表就是一个配平的 `(`，
     * 于是跨度从函数定义塌到参数表那一行（实测 Kotlin/KTS 的 `target=` 从 1-3 变成 1-1，
     * 且 `spanComplete` 还是 true —— 静默改错地方，正是本文件最贵的那个失效）。
     * 判据因此回到配置表：不写 `bodyOpens` 的语言拿不到 `(`。
     */
    const blockOpens = lang.bodyOpens ?? DEFAULT_BODY_OPENS
    if (t.type === 'punct' && (t.value === open || blockOpens.has(t.value))) {
      if (pairs.has(k)) return { bodyOpen: k, lastTok: pairs.get(k), sawBinding, uncertainTok: -1 }
      /**
       * 块开符出现了，却没有配平 ⇒ 配平表对这个文件不可信（典型起因：字符串/转义的扫描
       * 吃掉了一个闭符）。此时继续往前走会拿**内层的**块当本声明的块体（实测
       * `install.ps1` 的 `ForEach-Object { … }` 被当成了 `Get-RelFiles` 的体）。
       * 宁可拒绝，不赌。
       */
      return { bodyOpen: -1, lastTok: last, sawBinding, uncertainTok: k }
    }
    if (kind === 'variable' && t.type === 'punct' && t.value === '=>') sawBinding = true
    if (kind === 'variable' && t.type === 'ident' && t.value === 'function') sawBinding = true
    if (t.type === 'punct' && pairs.has(k)) {
      // 跨过一整层：参数表 / 泛型 / 调用实参无论多长都算一步
      last = pairs.get(k)
      k = last + 1
      continue
    }
    if (lineAt(t.start) > lineAt(prev.end) && !headerContinues(tokens, k, prev, clauses)) {
      /**
       * 停在新语句的开头。变量声明到这里就结束了（表达式已经完整）。
       * 其它种类（function / class / rpc…）只有当下一个 token 确实能**起一个新声明**时，
       * 才敢断言"这个声明没有块体"；停在别的关键字上说明头部可能被截早了——fail-closed。
       */
      if (kind !== 'variable' && !declarationStartTokens(lang).has(t.value) && k < tokens.length - 1) {
        return { bodyOpen: -1, lastTok: last, sawBinding, uncertainTok: k }
      }
      // 停在**最后**一个 token 上 = 文件到此为止：不是"判不了"，是"这就是末尾"。
      // 少了这个区分，块括号语言的文件末尾声明（`main = print 1`）会被标成跨度不完整。
      break
    }
    last = k
    k += 1
  }
  return { bodyOpen: -1, lastTok: last, sawBinding, uncertainTok: -1 }
}

/**
 * 一个语言的"声明起头" token：规则模式里的第一个字面量（`function` / `class` / `rpc`…）
 * 加上修饰符词表（`export` / `public`…）。
 *
 * 用于判断换行处那一行是**新声明**还是本声明的续行。从配置表派生，不手写名单——
 * 手写名单必然与规则脱节，而脱节是静默的（本文件反复踩过的那个坑）。
 * 按语言对象缓存：索引一份文件时每个声明都会问，不缓存就是反复遍历规则表。
 */
const DECLARATION_STARTS = new WeakMap()

function declarationStartTokens(lang) {
  let starts = DECLARATION_STARTS.get(lang)
  if (starts === undefined) {
    starts = new Set(lang.modifiers ?? [])
    for (const rule of lang.rules ?? []) {
      for (const part of rule.pattern) {
        if (typeof part === 'string' && !part.startsWith('$')) {
          starts.add(part)
          break
        }
      }
    }
    DECLARATION_STARTS.set(lang, starts)
  }
  return starts
}

/**
 * 换行处：下一个 token 还在声明头部里吗？
 *
 * 两层判据，回答的都是"上一行结束的子句/表达式还有没有下文"：
 *   · 上一 token **期待一个表达式**（`=`、`,`、`=>`、`+`…，复用 {@link tokenExpectsExpression}）
 *     或上一 token 是子句关键字（`extends` / `implements` / `where`…）⇒ 续行
 *   · 下一 token 是子句关键字，或是一个**起不了句的标点**（`&&`、`.`、`,`、`=`…）⇒ 续行
 *   · 其余（标识符、关键字、字面量）⇒ 新语句开始，声明到此结束
 *
 * 最后一条是保守方向：只在"上一 token 能收尾"且"下一 token 像新语句的开头"时才断开。
 * 断错的代价是跨度偏短（`class A extends B\n implements C {` 的 `implements` 若不在配置表里），
 * 因此子句关键字与其它语言差异一样进配置表。
 *
 * @returns 真表示下一 token 仍属于声明头部
 */
function headerContinues(tokens, k, prev, clauses) {
  if (tokenExpectsExpression(prev) || clauses.has(prev.value)) return true
  const t = tokens[k]
  if (clauses.has(t.value)) return true
  return t.type === 'punct' && t.value !== ')' && t.value !== ']' && t.value !== '}'
}

/**
 * 声明跨度与**声明种类**：从规则起点到其块体（`{...}`）的配平闭括号，没有块体则到规则末端。
 *
 * 块体边界是语言相关的真差异（花括号 / Python 的缩进 / Ruby 的 `end`），因此它进配置表
 * （`bodyOpen` 或 `blockEnd`），扫描器里不写语言分支。
 *
 * **跨度必须覆盖符号真实占据的整段**：拿不到完整跨度时不是退化成签名行，而是标记
 * `spanComplete: false` —— 调用方（`locate`，进而 `aura_basetools_edit`）据此刻拒绝 `target=` 替换。
 * 理由是实测的：偏短的跨度会让"只换签名行"这件事**静默**发生，落盘之后语法检查毫无反应。
 *
 * 这里还要分辨一件事：`const describe = (x) => { ... }` 是**函数绑定**，不是普通变量。
 * 判据写在跨度计算里，因为它与"块体从哪开始"是同一个决策——都必须先跨过赋值右侧。
 * 用独立的第二条规则去做会与变量规则重复命中同一个位置，靠规则顺序决定谁赢，
 * 那是在用"顺序"掩盖语义，典型补丁。
 */
function declarationSpan(tokens, pairs, declStartTok, startTok, endTok, lang, lineAt, kind, lines, termScan) {
  const open = lang.bodyOpen
  let bodyOpen = null
  let binding = kind
  let last = endTok
  let spanComplete = true
  let spanNote = ''

  if (open !== null) {
    /**
     * 规则末端**就是**块开符的形态（`name() {`、`int f() {`：模式把 `{` 写进去了）。
     * 那时块体从它开始，不必再扫——扫反而会撞上块体内部的第一个 `[` / `{`：
     * 实测 `alpha() { if [ -n "$x" ]; then … }` 的跨度会截在 `[ … ]` 那一行。
     */
    const ruleEndsAtBody =
      tokens[endTok] !== undefined && tokens[endTok].type === 'punct' && tokens[endTok].value === open && pairs.has(endTok)
    const scan = ruleEndsAtBody
      ? { bodyOpen: endTok, lastTok: pairs.get(endTok), sawBinding: false, uncertainTok: -1 }
      : scanBodyOpen(tokens, pairs, endTok, lang, lineAt, kind)
    last = scan.lastTok
    if (scan.bodyOpen !== -1) {
      bodyOpen = scan.bodyOpen
      if (kind === 'variable' && scan.sawBinding) binding = 'function'
    } else if (scan.uncertainTok !== -1) {
      spanComplete = false
      spanNote = `line ${lineAt(tokens[scan.uncertainTok].start)}: the header scan stopped at ${JSON.stringify(tokens[scan.uncertainTok].value)} without a block opener, and that token can neither continue the header nor start a declaration, so the span cannot be delimited`
    }
  } else {
    // 语言没有块括号：块体终结规则全在配置表里（`blockEnd`），扫描器里不写语言分支。
    const spec = lang.blockEnd
    if (spec === undefined) {
      spanComplete = false
      spanNote = `line ${lineAt(tokens[startTok].start)}: the language config declares no block terminator (neither bodyOpen nor blockEnd), so only the declaration line is known`
    } else if (spec.style === 'indent') {
      const baseLine = lineAt(tokens[startTok].start)
      const baseIndent = leadingSpace(lines[baseLine - 1] ?? '')
      // 头部扫描必须从**名字**那一 token 起（`startTok`），不能从规则末端 `endTok` 起。
      // 头部收尾符（`:` / `=`）是**头部的一部分**：从名字之后开始扫才找得到它。
      // 从 `endTok` 起会把收尾符自己跳过去（实测：`main = print 1` 里 `=` 就在 endTok 上，
      // 于是判据转去扫下一行、返回 -1，Haskell/OCaml/Nim 的符号全部 spanComplete=false）。
      const hit = indentBlockEnd(tokens, lines, startTok, baseLine, baseIndent, lineAt, spec.headerEnds, pairs)
      if (hit.endTok === -1) {
        spanComplete = false
        spanNote = hit.note
      } else last = hit.endTok
    } else if (spec.style === 'terminator') {
      const hit = terminatorBlockEnd(tokens, pairs, endTok, spec, lineAt, termScan(spec))
      if (hit.endTok === -1) {
        spanComplete = false
        spanNote = `line ${lineAt(tokens[startTok].start)}: no statement terminator closes this declaration, and no later line starts a new one, so the span cannot be delimited`
      } else last = hit.endTok
    } else if (spec.style === 'closer') {
      const hit = closerBlockEnd(tokens, startTok, endTok, spec, lineAt, lines)
      if (hit.endTok === -1) {
        spanComplete = false
        spanNote = hit.note
      } else last = hit.endTok
    } else {
      // 配置写错的风格名不能静默退化成签名行
      spanComplete = false
      spanNote = `line ${lineAt(tokens[startTok].start)}: unknown blockEnd style ${JSON.stringify(spec.style)}`
    }
  }

  return {
    kind: binding,
    // 声明起点是**规则起点**（含修饰符/返回类型），不是名字 token：`export function\nalpha()`
    // 若从名字所在行算起，整行替换会把上一行的 `export function` 留成悬空前缀。
    startLine: lineAt(tokens[declStartTok].start),
    endLine: lineAt(tokens[last].end),
    startTok,
    endTok: last,
    declStartTok,
    bodyOpen,
    spanComplete,
    spanNote,
  }
}

// ── 结构索引的记忆化 ───────────────────────────────────────────────────────
/**
 * `indexStructure` 是热路径：`aura_basetools_read` 的每个结构化模式、`aura_basetools_edit` 每次结构化编辑都会建一次
 * 完整索引（token 流 + 括号配平 + 符号表）。实测本仓最大的引擎文件（本文件，施工前 97 KB /
 * 2573 行）建一次 **15.8 ms**，而同一份内容在一轮里常被连问几次（read 的 map → digest → target
 * 各一次，edit 的 plan 与 verify 各一次）——同一份工作被反复做。这一层把它记住。
 *
 * 三条设计判据：
 *
 * 1. **键是内容本身，不是路径。** Map 的键就是源码字符串——JS 的字符串相等是逐字符的，
 *    因此命中即“内容一字不差”，不存在哈希碰撞这种会让“改了内容却拿到旧索引”成真的路径。
 *    同路径内容变了 ⇒ 键不同 ⇒ 必然重算；不同路径内容相同 ⇒ 键相同 ⇒ 命中
 *    （这正是要的：索引只取决于内容）。实测 97 KB 字符串的 `Map.get` 约 28 µs，
 *    是重算代价的约 1/560。
 * 2. **语言单独比对，且按对象身份。** `langOf()` 返回的是 `LANGS` 表里的单例
 *    （与 `DECLARATION_STARTS` 同一套做法）：身份不同即未命中，结构相同的两个语言对象
 *    只会各自重算，绝不会互相返回对方的索引——错命中比未命中危险得多。
 * 3. **有界。** 条目数与估算字节双上限，超出按 LRU 淘汰（Map 的插入序即访问序，
 *    命中时 delete+set 就把它挪到队尾）。字节那一条是**按可用内存算出来的额度**（不是一个拍
 *    出来的常数），三个输入、四种落点、为何本机安全，都写在下方额度块里。
 *
 * 对调用方**完全透明**：返回值逐字段与不缓存时相同（`index-cache-test.mjs` 段C 做全量深比较）；
 * 命中时返回的是**浅拷贝**，因此“每次调用都拿到自己的顶层对象”这条性质不变（调用方往索引上
 * 挂字段不会漏给下一次调用）。载荷（tokens / symbols / pairs / lineAt）是共享的，调用方须当只读：
 * 本仓全部消费者都是只读的（`listSymbols` / `rankSymbols` 都产出新数组，`resolveTarget` 展开复制）。
 */

/**
 * ── 额度（内存预算）怎么定：三个可测量的量，不是一个拍出来的常数 ─────────────
 *
 * ① **单份索引的实测字节**（定下限）。目标档是「100000 行 / 2.4 MB 的源码」。本机实测
 *    （node v24.15.0，Windows，用 `--expose-gc` 量 `heapUsed` 常驻）：这样一份索引**实测常驻
 *    40.91 MiB**，{@link structureBytes} 估 51.75 MiB（估算是上界，比值见该函数）。额度必须
 *    ≥ 单份的两倍——否则“目标档必然未命中 ⇒ 每次调用都重建”这个 bug 就会回来：旧常数 32 MiB
 *    正是如此，90000 行（est 36.8 MiB）起就全部未命中、冷热同价（本机复现：`readWith(mode=lines)`
 *    90000 行冷 5.5 s / 热 5.8 s；95000 行冷 7.1 s / 热 8.2 s）。
 * ② **进程可见的可用内存** `process.availableMemory()`（定基准）。额度 = 它的 1/16。
 * ③ **绝对下限 96 MiB / 上限 256 MiB**（定边界）。下限 ≈ 目标档单份实测的两倍多；上限则是因为
 *    缓存不该成为进程的主内存项（宿主进程整只 RSS 也才几百 MiB）。
 *
 * 合起来：`额度 = clamp(可用内存/16, min(96 MiB, 可用内存/4), 256 MiB)`。四种落点都有意义：
 *   · 本机（实测可用内存 2.7～3.6 GiB 波动）⇒ **182～222 MiB**（本次交付跑出 182.55 MiB），
 *     占**可用**内存 6.25%、占总内存 1.4%，目标档稳进；
 *   · 可用内存中等（< 1.5 GiB）⇒ 落到 96 MiB 下限，仍是目标档单份实测的两倍多；
 *   · 可用内存告急（< 384 MiB）⇒ 下限随可用内存缩到 1/4，宁可少缓存也不跟别人抢内存；
 *   · 取不到可用内存（非 node 宿主 / 老版本）⇒ 退回 96 MiB 下限，不赌。
 *
 * 为什么本机这一档（180 MiB 上下）是安全的（三条都能复核，不是一句话）：
 *   · 它是**估算**字节，而估算在这台机器上实测**盖得住**真实常驻（est/real 实测 1.2～2.0，
 *     即真实占用比额度小两成以上；交付读数：上限 169.51 MiB 时 gc 后实测常驻 144.17 MiB；
 *     段B 直接在目标档上断言 est ≥ 实测）；
 *   · 占可用内存 6.25%、占总内存 1.4%，与宿主进程现有 RSS 同量级——不是“再开一个进程”；
 *   · 额度要被“真的索引过那么多内容”才兑现，且条目上限 16 同时生效：不是一上来就吃掉两百兆。
 *
 * 额度**定一次、进程内不变**：可用内存会随机器负载漂移，而缓存判定必须确定（同一份内容在同一
 * 进程里只能有一个结论）。要改这个数用环境变量 `AURA_INDEX_CACHE_MB` / `AURA_INDEX_CACHE_BYTES`
 * （读一次，同样被 [8 MiB, 256 MiB] 夹住）——**可配，但不许把机器打爆**。
 *
 * ── 超限怎么淘汰：LRU + 按字节预算（两个上限同时生效，谁先到谁触发）───────────
 *   · **字节预算**（上面那个额度）管大文件：16 条之内也可能超额度，那时按访问序淘汰最旧的；
 *   · **条目 16** 管小文件：一轮对话里真正碰到的文件是个位数（被读的文件 + 它的编辑目标 +
 *     少数邻居），16 是两倍余量；小文件的字节远够不到额度，靠条目数兜底。
 * 单份索引本身就超额度 ⇒ 不缓存（它每次重算，也不许挤掉整个缓存）：这是唯一“未命中不入缓存”的路径。
 * 没有这两个上限，缓存就是用内存换速度的无界泄漏。
 */
const INDEX_CACHE_MAX_ENTRIES = 16
/** 下限：≈ 目标档（100000 行 / 实测 40.91 MiB）单份索引的两倍多。 */
const INDEX_CACHE_MIN_BYTES = 96 * 1024 * 1024
/** 上限：缓存不许成为进程的主内存项（宿主整只 RSS 也才几百 MiB）。 */
const INDEX_CACHE_MAX_BYTES = 256 * 1024 * 1024
/** 环境变量可调区间（用户可以往下调，不许往上越过上限）。 */
const INDEX_CACHE_ENV_MIN_BYTES = 8 * 1024 * 1024
/** 基准份额：可用内存的 1/16。 */
const INDEX_CACHE_SHARE = 16
/** 可用内存告急时，下限压到可用内存的 1/4（宁可少缓存，也不跟别人抢内存）。 */
const INDEX_CACHE_LOW_MEMORY_SHARE = 4

/**
 * 进程可见的可用内存；取不到（非 node 宿主 / 老版本 / 读数非法）返回 null。
 *
 * 引擎**不 import 任何 node 内建模块**（“可搬走”是它对外的承诺），因此这里只用全局 `process`：
 * `process.availableMemory()` 自 Node 22 起存在。
 */
function availableMemoryBytes() {
  if (typeof process === 'undefined' || typeof process.availableMemory !== 'function') return null
  try {
    const bytes = process.availableMemory()
    return Number.isFinite(bytes) && bytes > 0 ? bytes : null
  } catch {
    return null
  }
}

/** 环境变量覆写：`AURA_INDEX_CACHE_MB`（优先，便于手写）> `AURA_INDEX_CACHE_BYTES`；被 [8 MiB, 256 MiB] 夹住。 */
function envBudgetBytes() {
  if (typeof process === 'undefined' || process.env === undefined || process.env === null) return null
  const pick = (name, scale) => {
    const raw = process.env[name]
    if (typeof raw !== 'string' || raw.trim().length === 0) return null
    const value = Number(raw.trim())
    return Number.isFinite(value) && value > 0 ? value * scale : null
  }
  const bytes = pick('AURA_INDEX_CACHE_MB', 1024 * 1024) ?? pick('AURA_INDEX_CACHE_BYTES', 1)
  if (bytes === null) return null
  return Math.min(INDEX_CACHE_MAX_BYTES, Math.max(INDEX_CACHE_ENV_MIN_BYTES, bytes))
}

/**
 * `额度 = clamp(可用内存/16, min(96 MiB, 可用内存/4), 256 MiB)`——取值理由见上方长注释。
 * `source` 记的是**这台机器上这个数是怎么来的**，给观测与测试用（{@link indexCacheStats}）。
 */
function indexCacheBudget() {
  const fromEnv = envBudgetBytes()
  if (fromEnv !== null) return { bytes: fromEnv, source: 'env(AURA_INDEX_CACHE_*)' }
  const available = availableMemoryBytes()
  if (available === null) return { bytes: INDEX_CACHE_MIN_BYTES, source: 'floor(no-available-memory)' }
  const floor = Math.min(INDEX_CACHE_MIN_BYTES, available / INDEX_CACHE_LOW_MEMORY_SHARE)
  const share = Math.min(INDEX_CACHE_MAX_BYTES, available / INDEX_CACHE_SHARE)
  if (share >= floor) return { bytes: share, source: 'available-memory/16' }
  return { bytes: floor, source: available / INDEX_CACHE_LOW_MEMORY_SHARE < INDEX_CACHE_MIN_BYTES ? 'available-memory/4(low)' : 'floor' }
}

/** 本进程的额度（**定一次**）。 */
const INDEX_CACHE_BUDGET = indexCacheBudget()

/** `Map<源码字符串, {lang, index, bytes}>`；插入序即 LRU 序（队首最旧）。 */
const INDEX_CACHE = new Map()
let INDEX_CACHE_BYTES = 0

/**
 * 一条索引的常驻字节**上界估算**：src 本身 + token / 符号对象 + 配平表。
 *
 * 系数是**量出来的**，不是拍的：在 7 种形状上各量一次真实常驻（`--expose-gc` 前后 `heapUsed` 差，
 * 每份都留活口以免被 GC 拉负），得到每 token ≈ 93 B、每符号 ≈ 245 B、每配对 ≈ 0～30 B、
 * 每字符 ≤ 2 B（V8 对源码字符串用 Latin-1 或 UTF-16，两种表示都不超过 2 B/字符）。
 * 这里取 96 / 288 / 64 / 2（即 ~20% 余量）后，实测 est/real 落在 **1.19～2.02**：
 *
 *   形状                         src 字符  token    symbol  pair   实测 MiB  est MiB  est/real
 *   块状 JS 20000 行              478665   79992    5713    8575     8.40     10.33    1.23
 *   块状 JS 50000 行             1206898  200000   14285   21433    20.15     25.84    1.28
 *   **块状 JS 100000 行（目标档）** 2446271  400004   28571   42862    40.91     51.75    1.27
 *   长字符串 / 少 token 5000 行    983890   20000    5000       0     2.52      5.08    2.02
 *   每行 20 token 5000 行          222230   85000       0   10000     7.38      8.82    1.19
 *   深层嵌套 5000 行               182780  140000       0   65000    11.89     17.13    1.44
 *   本仓引擎文件（97 KB）          101412   15814     248    1568     1.39      1.81    1.30
 *
 * 它**必须盖得住**实测：额度就是按这个数记账的，估算偏低 ⇒ 缓存的真实占用越过额度。
 * 旧公式（`src*4 + token*64 + symbol*192 + pair*48`）在 token 密集档上正是如此（每行 20 token 那档
 * 只有 0.88，即“额度说没超、内存已经超了”）。偏大只会更早淘汰，不会漏淘汰；
 * 而“盖得住”这件事由 `index-cache-test.mjs` 段B 在**目标档**上直接断言（est ≥ 实测），
 * 不靠这句注释。
 */
function structureBytes(index) {
  return index.src.length * 2 + index.tokens.length * 96 + index.symbols.length * 288 + index.pairs.size * 64
}

/** 淘汰到预算以内；队首（最近最少用）先走。两个上限：字节预算（大文件）+ 条目数（小文件）。 */
function evictStructureCache() {
  while (INDEX_CACHE.size > INDEX_CACHE_MAX_ENTRIES || INDEX_CACHE_BYTES > INDEX_CACHE_BUDGET.bytes) {
    const oldest = INDEX_CACHE.keys().next()
    if (oldest.done === true) return
    const entry = INDEX_CACHE.get(oldest.value)
    INDEX_CACHE.delete(oldest.value)
    INDEX_CACHE_BYTES -= entry.bytes
  }
}

/**
 * 真正的建索引：token 流 + 括号配平 + 符号表。**不缓存**——`indexStructure` 是它的记忆化外壳。
 * 拆成两个名字是为了让“缓存”这件事只出现在一个地方：这里一行都不谈命中与淘汰。
 */
function buildStructure(src, lang) {
  const tokens = tokenize(src, lang)
  const pairs = matchBrackets(tokens, lang)
  const lineAt = lineIndexFor(src)
  // 缩进型语言的块体终结要看行文本（前导空白），build 一次供全部符号共用
  const lines = src.split(/\r?\n/)
  // 终结符型语言（SQL / Erlang / Vim）的块体终结走跳表：**每次建索引只建一次**，见 terminatorBlockEnd
  const termScan = lazyTerminatorScan(tokens, pairs, lineAt)
  const symbols = []

  for (let i = 0; i < tokens.length; i += 1) {
    for (const rule of lang.rules) {
      const hit = matchRule(tokens, i, rule, lang, pairs, lineAt)
      if (hit === null) continue
      // 声明起点前是修饰符 → 这一处不是起点（真正的起点在修饰符之前那一次命中）。
      //
      // 必须查 **matchStart**（规则起点），不能查 `startTok`（名字位置）。
      // 查错的后果：`export function alpha` 会在 i=0（规则起点 `export`）与 i=1（规则起点
      // `function`）各命中一次；i=1 那次若去看 `tokens[1-1]` 即 `function`，它不是修饰符，
      // 闸门放行，于是同一处被推两次、坐标完全相同，`target=alpha` 直接报歧义失效。
      if (precededByModifier(tokens, hit.matchStart, lang)) continue
      // `$label` 的捕获值可能带引号（`"aws_instance"`）：符号名要的是**名字本身**。
      // 剥引号只在这里做一次——`matchRule` 那边必须保留原样才有办法反查名字 token（见该函数）。
      const name = typeof hit.cap.$name === 'string' ? hit.cap.$name.replace(/^['"]|['"]$/g, '') : hit.cap.$name
      // 符号名必须是**标识符形状**。这是所有语言共用的一条硬闸门，不是“新语言专用补丁”：
      // 没有它，那些**没有前导字面量**的规则（Haskell 的 `name ::`、Nim 的 `name(...)=`）
      // 会捕到参数列表里的 `a:` 这种半截 token 并报出一个不存在的符号。
      // 它比“只捕标识符”的 `$name` 严——`$name` 不校验**字符串**内容，而 `$label` 会带引号进来。
      if (typeof name !== 'string' || !/^[A-Za-z_$\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff-]*$/.test(name)) continue
      const span = declarationSpan(tokens, pairs, hit.matchStart, hit.startTok, hit.end - 1, lang, lineAt, rule.kind, lines, termScan)
      /**
       * 规则在名字之前只有 `$mods*` / `$ident*` 这类“可选前缀段”、没有字面量时，匹配器可能
       * 一段都没吃到：C 的 `static int alpha`（`$ident*` 只吃非关键字，`int` 是关键字）、
       * Dart 的 `int alpha(...)`（规则是 `$mods* $name …`，返回类型不在模式里）。此时
       * `declStartTok` 落在名字上，类型若回到**上一行**，行区间会把上一行留成悬空前缀。
       *
       * 这里只做标记，判据放在定位层（{@link sharedLineContent}）：它能看到行文本与上一行
       * 是否真的像声明头。`matchStart !== startTok` 说明前缀已经被吃进跨度，没有这个盲区。
       */
      const nameAt = rule.pattern.findIndex((part) => part === '$name' || part === '$nameNotKeyword')
      const prefixParts = nameAt > 0 ? rule.pattern.slice(0, nameAt) : []
      const declStartUnknown =
        hit.matchStart === hit.startTok && prefixParts.length > 0 && prefixParts.every((part) => part.startsWith('$'))
      symbols.push({ name, ...span, ...(declStartUnknown ? { declStartUnknown: true } : {}) })
      break
    }
  }

  // 归属（enclosing）：每个符号最内层的包含者。字段语义、旧实现的实测代价、新解法的等价性
  // 论证、以及「区间重叠但不包含时给出什么」，全部写在 {@link attributeEnclosing} 上方那一段里。
  attributeEnclosing(symbols)

  return { symbols, tokens, pairs, lineAt, src }
}

/**
 * 归属（`enclosing`）：每个符号**最内层**的包含者。**一趟扫掠 + 后缀最小值，O(n log n)**。
 *
 * ── 这个字段的语义（对外契约，不许改）────────────────────────────────────────
 *
 * 对每个符号 `s`，答案是符号表里**第一个**满足下面三条的 `c`（次序 = 宽度升序、宽度并列时按
 * `symbols` 原序）：
 *
 *     c !== s 且 c.startTok <= s.startTok 且 c.endTok >= s.endTok 且 宽度(c) > 宽度(s)
 *
 * 换个说法：**容器里最窄的那个；宽度并列时取在 `symbols` 里靠前的那个**；没有容器 ⇒ `null`。
 * 这不是「能算就行」的装饰字段：没有它，`todos` 在文件里出现两次就无法区分——不是匹配算法
 * 不够聪明，是模型缺字段（那一课写在 `buildStructure` 里）。
 *
 * ── 旧实现为什么必须换掉（实测，不是推断）─────────────────────────────────
 *
 * 旧实现把符号表按宽度排一遍，然后**每个符号都扫一遍全表**。平坦文件里没有任何符号包含别的
 * 符号 ⇒ 每个符号都扫满全表 ⇒ 完整的 O(n²)。本机复跑（内容 = `export const vN = N;` × N 行，
 * 每次都拿一个全新模块实例当冷路径）：
 *
 *     N（符号=行）  旧实现冷索引     µs/行   ｜ 对照：同样行数、零符号的文件
 *          5000      110.8 ms       22.2   ｜ 20000 行  106.7 ms（5.3 µs/行）
 *         10000      382.2 ms       38.2   ｜ 40000 行  133.7 ms（3.3 µs/行）
 *         20000     1311.3 ms       65.6   ｜
 *         40000     7081.4 ms      177.0   ｜
 *        100000    67579.0 ms      675.8   ｜
 *
 * 每行成本随规模上升 = 超线性，而扫描器本身是平的（右列）。`--cpu-prof` 的行级 tick 把账算死：
 * 40000 符号档 `buildStructure` 自身 3763 个采样点里，**2530 / 2531 / 2532 三行占 3732 个
 * （99.2%）**，而 tokenize / matchRule / matchBrackets / scanBodyOpen 加起来不到 1%
 * （`declarationSpan` 只有 4 个点）。也就是说「一次读卡几十秒」全部来自这一段：不是壳、不是 IO、
 * 不是账本。
 *
 * ── 新解法：按 startTok 扫掠 + 按 endTok 的后缀最小值（Fenwick 树）─────────────
 *
 * 容器判据是一个**二维支配**查询（`c.startTok <= s.startTok` 且 `c.endTok >= s.endTok`）：
 *   · 按 `startTok` 升序扫掠 ⇒ 已经插进树里的 `c` 天然满足前半条；
 *   · 后半条由一棵**按 endTok 建的后缀最小值树**回答（endTok 越大位置越靠前，于是「后缀」就是
 *     Fenwick 的前缀查询）；
 *   · 树里存的键是 `(宽度, 原下标)` 的**字典序**——这正是旧实现「按宽度升序、并列按原序」那条
 *     次序，所以「树里的最小值」就是旧实现「第一个命中的容器」。
 *
 * 逐条等价性论证（不是「看起来一样」；段C 在真实语料上再逐符号对一遍）：
 *
 *   1. **同区间的符号答案必然相同。** 判据只看 `(startTok, endTok)`，同区间的符号宽度也相同；
 *      它们互为候选时都被「宽度严格更大」挡掉（包含 + 宽度相等 ⇒ `(startTok, endTok)` 全等）。
 *      于是同区间并成一组、算一次、写给全组 ⇒ 逐条等于旧实现。
 *   2. **组内按 endTok 降序、每组「先问后插」。** 问 `s` 时树里恰好是
 *      `{c : c.startTok < s.startTok} ∪ {c : c.startTok == s.startTok 且 c.endTok > s.endTok}`：
 *      前者由扫掠序保证，后者由「同 start 组按 end 降序 + 先问后插」保证。`c.endTok < s.endTok`
 *      的本来也包含不了 `s`；`(startTok, endTok)` 全等的那一组就是 `s` 自己（还没插进去）。
 *      ⇒ 树里**恰好**是全部容器，不多不少。
 *   3. **「宽度严格更大」不必再查。** `c` 包含 `s` 且不是 `s` 那一组 ⇒ `宽度(c) >= 宽度(s)`，
 *      取等只在 `(startTok, endTok)` 全等 ⇒ 自动严格更大。所以查到的每一个都合法。
 *
 * ── 区间**不严格嵌套**（重叠但不包含）时给出什么 ─────────────────────────────
 *
 * 这一条不能靠「代码看起来对」过关，逐条说清：
 *   · 上面的论证**没有一处用到嵌套**：新解法回答的就是「满足那两条不等式的容器里键最小的
 *     那个」，与旧实现的判据逐字同源。因此**交叉区间两边都给 `null`**——例如 A=[1,100]、
 *     B=[50,150]：A 的容器要 `c.startTok <= 1`，而 B 的 startTok 是 50；B 的容器要
 *     `c.endTok >= 150`，而 A 的 endTok 是 100。旧实现给的就是这个答案，新解法给同一个。
 *   · 会给出**不同**答案的是「按 start 排序后用栈顶当包含者」那种经典写法：对 A=[0,100]、
 *     B=[5,20] 这类「后开的区间反而更长」的形状，它会把 B 报成 A 的包含者（旧实现判 `null`，
 *     因为 `B.endTok = 20 < A.endTok = 100`）。**本实现没有采用那个写法**，正是因为它在这类
 *     输入上不等价。段C 因此除了真实语料，还单独构造交叉 / 同 start / 同 end / 等宽的形状逐条比。
 *
 * 复杂度：排序 O(n log n) + 树 O(n log m)（n = 符号数，m = 不同 endTok 数）。
 *
 * @param {Array<object>} symbols - `buildStructure` 的符号表；**原地**写 `enclosing`
 */
function attributeEnclosing(symbols) {
  const n = symbols.length
  for (let i = 0; i < n; i += 1) symbols[i].enclosing = null
  if (n < 2) return // 一个符号不可能有包含者；零个符号连扫掠都不必进

  // 扫掠序：startTok 升序；同 start 时 endTok **降序**（见论证 2）；末位按原下标收尾（全序 ⇒ 确定性）。
  const ord = new Array(n)
  for (let i = 0; i < n; i += 1) ord[i] = i
  ord.sort((a, b) => {
    const byStart = symbols[a].startTok - symbols[b].startTok
    if (byStart !== 0) return byStart
    const byEnd = symbols[b].endTok - symbols[a].endTok
    return byEnd !== 0 ? byEnd : a - b
  })

  // endTok 的压缩排名：`posOf(end) = m - rank` ⇒ 「endTok >= s.endTok」就是 Fenwick 的**前缀**查询。
  const ends = new Array(n)
  for (let i = 0; i < n; i += 1) ends[i] = symbols[i].endTok
  ends.sort((a, b) => a - b)
  let m = 0
  for (let i = 0; i < n; i += 1) {
    if (i > 0 && ends[i] === ends[i - 1]) continue
    ends[m] = ends[i]
    m += 1
  }
  const posOf = new Map()
  for (let r = 0; r < m; r += 1) posOf.set(ends[r], m - r)

  // 最小值树的键是 (宽度, 原下标) 的字典序；只做「插入时取更小」，正是 Fenwick 前缀最小值的前提。
  const treeWidth = new Float64Array(m + 1).fill(Infinity)
  const treeIndex = new Int32Array(m + 1).fill(-1)

  let g = 0
  while (g < n) {
    const head = ord[g]
    const startTok = symbols[head].startTok
    const endTok = symbols[head].endTok
    let stop = g + 1
    while (stop < n) {
      const j = ord[stop]
      if (symbols[j].startTok !== startTok || symbols[j].endTok !== endTok) break
      stop += 1
    }
    const pos = posOf.get(endTok)

    // 先问：此刻树里恰好是全部容器（论证 2）。
    let bestWidth = Infinity
    let bestIndex = -1
    for (let i = pos; i > 0; i -= i & -i) {
      const w = treeWidth[i]
      if (w < bestWidth || (w === bestWidth && treeIndex[i] < bestIndex)) {
        bestWidth = w
        bestIndex = treeIndex[i]
      }
    }
    const enclosing = bestIndex === -1 ? null : symbols[bestIndex].name
    for (let k = g; k < stop; k += 1) symbols[ord[k]].enclosing = enclosing

    // 后插：一组只占一条记录（同区间的后来者答案完全相同、宽度也相同 ⇒ 谁也当不了谁的容器）。
    const width = endTok - startTok
    for (let i = pos; i <= m; i += i & -i) {
      const w = treeWidth[i]
      if (width < w || (width === w && head < treeIndex[i])) {
        treeWidth[i] = width
        treeIndex[i] = head
      }
    }
    g = stop
  }
}

/**
 * 建结构索引：符号表 + 作用域配对表。
 *
 * **同一份内容重复调用不再重复解析**：命中判据、上限与透明性见本函数上方的记忆化说明。
 * 对调用方而言签名、返回形状与语义都没有变——缓存只在“这份内容刚算过、语言也一致”时生效。
 *
 * @param {string} src - 源码全文
 * @param {object} lang - 语言配置
 * @returns {{symbols: Array, tokens: Array, pairs: Map, lineAt: Function}}
 */
export function indexStructure(src, lang) {
  /**
   * 非字符串不进缓存。
   *
   * Map 对非字符串键按**对象身份**比对，而调用方完全可能复用同一个 Buffer 反复装填内容
   * （读文件循环里的常见写法）——那正好会让“改了内容却命中旧索引”真的发生。
   * 不缓存就与改动前逐字一致，这正是这里要的：正确性优先于命中率。
   */
  if (typeof src !== 'string') return buildStructure(src, lang)

  const hit = INDEX_CACHE.get(src)
  if (hit !== undefined && hit.lang === lang) {
    // LRU：命中即刷新访问序（Map 保持插入序，先删再插 = 挪到队尾）。
    INDEX_CACHE.delete(src)
    INDEX_CACHE.set(src, hit)
    return { ...hit.index }
  }
  const index = buildStructure(src, lang)
  const bytes = structureBytes(index)
  // 单条就超额度：宁可它每次重算，也不让一条挤掉整个缓存（额度取值见上方长注释）。
  if (bytes > INDEX_CACHE_BUDGET.bytes) return index
  if (hit !== undefined) {
    // 同一份内容配了另一个语言对象：旧的那份对本调用方没用，替换而不是并存。
    INDEX_CACHE.delete(src)
    INDEX_CACHE_BYTES -= hit.bytes
  }
  INDEX_CACHE.set(src, { lang, index, bytes })
  INDEX_CACHE_BYTES += bytes
  evictStructureCache()
  return { ...index }
}

/**
 * 缓存现状快照（**只读观测**：不改任何行为、不动缓存、不影响命中）。
 *
 * 存在的理由：额度是个**从可用内存算出来的数**，所以“上限是多少、现在用了多少”必须是能在外部
 * 复核的事实——测试要断言「实际字节 ≤ 上限」，运维要知道缓存吃了多少内存。没有这个口子，判据
 * 只能去读源码里的常数（那正是本轮要消灭的东西）。
 *
 * `bytes` 是 {@link structureBytes} 的**估算**合计（不是精确账本）；`availableBytes` 取不到时为 null。
 * 返回的是每次新建的普通对象，不冻结：它是给人看的读数，不是内部状态本身。
 *
 * @returns {{entries: number, bytes: number, maxBytes: number, maxEntries: number, budgetSource: string, availableBytes: number|null}}
 */
export function indexCacheStats() {
  return {
    entries: INDEX_CACHE.size,
    bytes: INDEX_CACHE_BYTES,
    maxBytes: INDEX_CACHE_BUDGET.bytes,
    maxEntries: INDEX_CACHE_MAX_ENTRIES,
    budgetSource: INDEX_CACHE_BUDGET.source,
    availableBytes: availableMemoryBytes(),
  }
}

/**
 * 把符号查询解析成唯一区域。
 *
 * 目标写法（可组合）：
 *   `name`              按名字
 *   `kind:name`         限定种类（function/class/variable）
 *   `Outer/Inner`       限定归属，消除同名嵌套歧义
 *   `name#2`            第 2 个同名（1-based）
 * 三者可叠加：`function:apply/todos#1`
 *
 * @param {object} index - indexStructure 的结果
 * @param {string} target - 目标写法
 * @param {number|null} near - 可选行号提示，用于同名消歧
 * @returns {{startLine, endLine, name, kind}} 1-based 行区间
 * @throws 找不到或歧义时抛出带 code 的错误
 */
export function resolveTarget(index, target, near = null) {
  const raw = String(target ?? '').trim()
  if (raw.length === 0) throw Object.assign(new Error('empty target'), { code: 'STRUCT_EMPTY_TARGET' })

  let kind = null
  let rest = raw
  const colon = raw.indexOf(':')
  if (colon > 0) {
    kind = raw.slice(0, colon)
    rest = raw.slice(colon + 1)
  }
  let ordinal = null
  const hash = rest.lastIndexOf('#')
  if (hash > 0) {
    const n = Number.parseInt(rest.slice(hash + 1), 10)
    if (Number.isInteger(n) && n > 0) {
      ordinal = n
      rest = rest.slice(0, hash)
    }
  }
  // 归属限定：`Outer/Inner`，取最后一段为名字，前面全部是归属链
  const parts = rest.split('/').map((p) => p.trim()).filter((p) => p.length > 0)
  if (parts.length === 0) throw Object.assign(new Error('empty target'), { code: 'STRUCT_EMPTY_TARGET' })
  const name = parts[parts.length - 1]
  const scope = parts.length > 1 ? parts[parts.length - 2] : null

  const match = (s) => s.name === name && (kind === null || s.kind === kind)
  let hits = index.symbols.filter(match)
  if (hits.length === 0) {
    // 退一步：唯一前缀匹配。只在前缀唯一时接受，否则仍算找不到。
    const prefixed = index.symbols.filter((s) => s.name.startsWith(name) && (kind === null || s.kind === kind))
    const distinct = [...new Set(prefixed.map((s) => s.name))]
    if (distinct.length === 1) hits = prefixed
  }
  if (hits.length > 0 && scope !== null) {
    const scoped = hits.filter((s) => s.enclosing === scope)
    if (scoped.length > 0) hits = scoped
  }
  if (hits.length === 0) {
    throw Object.assign(new Error(`no symbol matching "${raw}"`), { code: 'STRUCT_NOT_FOUND' })
  }
  if (ordinal !== null) {
    if (ordinal > hits.length) {
      throw Object.assign(new Error(`"${raw}" has only ${hits.length} occurrence(s)`), { code: 'STRUCT_NOT_FOUND' })
    }
    hits = [hits[ordinal - 1]]
  }
  if (hits.length === 1) return { ...hits[0], ambiguous: false }

  if (near !== null && near !== undefined) {
    let best = null
    let bestD = Infinity
    let ties = 0
    for (const h of hits) {
      const d = Math.abs(h.startLine - near)
      if (d < bestD) {
        bestD = d
        best = h
        ties = 1
      } else if (d === bestD) ties += 1
    }
    if (ties === 1) return { ...best, ambiguous: false }
  }
  // 歧义不猜：把候选全部回报（含归属），让调用方决定。这是与 edit 的分水岭。
  throw Object.assign(new Error(`"${raw}" matched ${hits.length} symbols and near did not disambiguate`), {
    code: 'STRUCT_AMBIGUOUS',
    candidates: hits.map((h) => ({ name: h.name, kind: h.kind, enclosing: h.enclosing, startLine: h.startLine, endLine: h.endLine })),
  })
}

/**
 * 给一个候选区域打结构置信度：这个区域是否**恰好**对应一个完整符号（或其完整函数体）。
 *
 * 用途不是"排序文本像不像"，而是回答另一个问题：**这个区域是不是一个语法上完整的单位**。
 * 文本相似度高的两个区域，只有一个可能是完整的函数体——这就是结构能给而文本给不了的信号。
 *
 * @returns {number} 0..1，1 表示区间与某个符号的声明跨度完全吻合
 */
export function regionConfidence(index, startLine, endLine) {
  if (index.symbols.length === 0) return 0
  let best = 0
  for (const s of index.symbols) {
    if (s.startLine === startLine && s.endLine === endLine) return 1
    const overlap = Math.max(0, Math.min(s.endLine, endLine) - Math.max(s.startLine, startLine) + 1)
    const span = Math.max(s.endLine - s.startLine + 1, endLine - startLine + 1)
    best = Math.max(best, overlap / span)
  }
  return best
}

/**
 * 按重要性给符号排序：**"展示哪些符号"这个决策的唯一依据**。
 *
 * 为什么排序是必需的，而不是锦上添花：展示符号的目标函数是
 * "最大化模型下一步能直接寻址的概率"，而不是"展示最多符号"。这两个函数对排序的要求
 * 截然不同——后者不在乎顺序，前者必须按重要性排。而**声明顺序与重要性零相关**：
 * 实测按声明顺序取前 24 个，其中 49% 是函数内局部量（`variable v` 这类，重名率极高）。
 *
 * 放在本模块（而非 read 或 locator）是因为它只依赖符号表与行文本，两边都要用：
 * 内容侧用它决定地图展示什么，定位侧用它决定失败回执给哪些候选。
 * 曾经两边各有一份实现，结果只修了一处、漏了另一处——共享一份是避免那种漏改的唯一办法。
 *
 * 级别依据（全部取自现有索引，不引入新概念）：
 *   3 导出         —— 一个文件的接口就是它的导出面，最可能被改
 *   2 顶层结构     —— function/class 等，其次
 *   1 顶层变量 / 嵌套结构
 *   0 函数内局部量 —— `const v = ...` 这类。**不展示**，不是因为它不重要，
 *                     而是因为模型改它时不必看见它：它已有行号（`lines` 层），
 *                     或用外层函数名定位即可。展示行是稀缺资源。
 *
 * @param index - indexStructure 的结果
 * @param lines - 文件按行切分（用于识别 `export` 与顶层性）
 * `exported` 必须**一并带出**，不能只留一个分数。它在这里已经算出来了（`isExported`），
 * 而先前的返回值把它丢掉、只给 `imp`，于是两个消费方各自用 `imp === 3` 反推"是否导出"——
 * 一个数字同时承担"重要性排序"与"是否导出"两种含义，是典型的双义字段：
 * 一旦重要性分级扩容（比如再加一级），"导出"会静默变成别的东西而没人发现。
 * 现在把已算出的布尔值直接给出，两个消费方都不再反推。
 *
 * @returns {{s, imp, exported}[]} 按重要性降序、同级别按行号升序
 */
export function rankSymbols(index, lines) {
  return listSymbols(index)
    .map((s) => {
      const own = lines[s.startLine - 1] ?? ''
      const isExported = /\bexport\b/.test(own)
      const top = s.enclosing === null || s.enclosing === undefined
      const structural =
        s.kind === 'function' || s.kind === 'class' || s.kind === 'type' || s.kind === 'interface' || s.kind === 'enum'
      let imp = 0
      if (top && isExported) imp = 3
      else if (top && structural) imp = 2
      else if (top || structural) imp = 1
      return { s, imp, exported: isExported }
    })
    .sort((a, b) => b.imp - a.imp || a.s.startLine - b.s.startLine)
}

/**
 * 列出符号表，供 `list` 查询（模型据此在不知道确切名字时先看目录）。
 *
 * 投影里**必须保留 `enclosing`**。曾经这里只返回 name/kind/startLine/endLine，
 * 结果消费方（read 的 digest 模式）拿到的 `enclosing` 恒为 `undefined`，
 * 于是"函数体内的局部变量不是导出"这条过滤完全失效——`let sum` 被当成导出报了出去。
 *
 * 教训：投影丢字段是一种静默失败。它不报错，只是让下游的某个判断**永远走另一条分支**，
 * 而且看起来一切正常。凡是可能被"归属/作用域"类判断用到的字段，都不能在投影里省。
 *
 * @param index - indexStructure 的结果
 * @param kind - 只列某一类符号；null 表示全部
 * @returns 符号投影（含 enclosing）
 */
export function listSymbols(index, kind = null) {
  return index.symbols
    .filter((s) => kind === null || s.kind === kind)
    .map((s) => ({
      name: s.name,
      kind: s.kind,
      startLine: s.startLine,
      endLine: s.endLine,
      enclosing: s.enclosing ?? null,
      // 跨度是否覆盖了符号真实占据的整段。少了它，调用方分不出"完整符号"与"只有签名行"，
      // 而那个区别决定了 `target=` 能不能替换。
      spanComplete: s.spanComplete !== false,
      spanNote: s.spanNote ?? '',
    }))
}

/** 符号体内的引用位置：用于重命名全量改写这类需要"所有出现处"的操作。 */
export function findReferences(index, name) {
  const out = []
  for (const s of index.symbols) {
    for (let k = s.startTok; k <= s.endTok; k += 1) {
      const t = index.tokens[k]
      if (t !== undefined && t.type === 'ident' && t.value === name) {
        out.push({ startLine: t.line, endLine: t.line, within: s.name })
      }
    }
  }
  return out
}
