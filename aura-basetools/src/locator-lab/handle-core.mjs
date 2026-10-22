/**
 * handle-core.mjs —— 区间句柄：形状、指纹、解析。
 *
 * ## 它治的是什么
 *
 * 编辑失败的残余成因是**引用本身失真**：模型转述原文时漏字、错行、跨行断在词中、
 * 把两行并成一行。工具侧对"信息充分而工具不做"已经到顶，剩下的错在**转述**这一步。
 *
 * 句柄把这一步拿掉：被编辑的那段字节由**工具自己算出的指纹**充当凭据，
 * 模型只需回抄一个 21 字符的短串，不必复述任何一个字的原文。
 *
 * ## 三条形状约束（契约 §3，已冻结）
 *
 * 1. **定长、无歧义**：`h` + 4 位身份标签 + 8 位区间摘要 + `:` + 起始行 + `-` + 结束行。
 * 2. **不含路径**：编辑调用本来就带 `file_path`；句柄里塞路径既浪费字符又制造两个真值来源。
 * 3. **自描述 ⇒ 零持久化**：解析不需要任何句柄表——拿 `file_path` 读到的内容现算同一份摘要
 *    就能核对。这是本文件**不依赖账本**的原因。
 *
 * ## 为什么本文件零依赖（连 `read-core.mjs` 都不 import）
 *
 * 摘要口径要与引擎既有的 `contentToken`（`read-core.mjs` 的 FNV-1a 32 位 + 长度）
 * **逐字一致**——但"一致"可以是**同一段算法**，不必是**同一条 import**。
 *
 * 而 import 会造出环：`write-path.mjs` 已经 `import` 了 `read-core`（编辑侧要用它），
 * 编辑侧又要 `import` 本文件；若本文件再去 `import` `read-core`，
 * 模块图里就出现 `read-core → handle-core → read-core`。
 * ESM 的环不一定崩，但会让**求值顺序**变得依赖入口，是最难查的那类故障。
 *
 * 所以本文件是**叶子**：导入表为空、只导出纯函数。
 * **本文件是 FNV-1a 的唯一实现处**：`read-core.mjs` 的 `contentToken`（全文版本令牌）
 * import 这里的 {@link fnv1a32}。先前担心"两份实现会漂开"而在这里留一份副本是多余的——
 * 本文件是叶子（导入表为空），而 read-core 本来就 import 它，方向盘只有一个。
 * 现在全仓只剩**一处** FNV 常数与循环。
 *
 * 零内置依赖是硬约束：不许 `node:crypto`、不许任何 `node:` 模块——
 * 引擎现在 7 个文件全零内置依赖，这是「可脱离既有框架」那条性质的实证，也被打包守卫盯着。
 * FNV-1a 是**纯算术**，本来就不需要哈希库。
 */

/** 身份标签与区间摘要的进制：十六进制小写，定长。 */
const HEX = 16

/** FNV-1a 32 位的偏移基线。 */
const FNV_OFFSET_BASIS = 2166136261
/** FNV-1a 32 位的质数。 */
const FNV_PRIME = 16777619
/** UTF-8 BOM 的字符形式。 */
const BYTE_ORDER_MARK = '\uFEFF'

/**
 * **全仓唯一的 FNV-1a 32 位实现**（`read-core.mjs` 的 `contentToken` 也走这一条）。
 *
 * 为什么是纯算术而不是 `node:crypto`：引擎要能脱离既有框架跑，零内置依赖是那条性质的实证。
 * FNV-1a 只有两个常数与一次循环，自己写比引一个哈希库更短，也没有版本/平台差异。
 *
 * `byteOrderMark = true` 时在文本前补 U+FEFF 再算——这是**刻意**的：
 * 只差一个 BOM 的两个文件必须拿到不同令牌，否则 `changed` 会说"没变"
 * （`read-core.mjs` 的 `contentToken` 长注释里写着这件事的来历）。
 *
 * @param text - 待摘要的文本
 * @param byteOrderMark - 是否按"这份内容带 UTF-8 BOM"的口径算
 * @returns 32 位无符号整数的**十六进制**写法（不补零；调用方按自己的定长要求补）
 */
export function fnv1a32(text, byteOrderMark = false) {
  const effective = byteOrderMark === true ? BYTE_ORDER_MARK + text : text
  let h = FNV_OFFSET_BASIS
  for (let i = 0; i < effective.length; i += 1) {
    h ^= effective.charCodeAt(i)
    h = Math.imul(h, FNV_PRIME)
  }
  return (h >>> 0).toString(HEX)
}

/** 身份标签占 4 位十六进制。 */
const ID_TAG_HEX = 4
/** 区间摘要占 8 位十六进制（= `contentToken` 指纹段的前 8 位）。 */
const FINGERPRINT_HEX = 8

/**
 * 句柄的**唯一**形状。解析、校验、测试都从这里取，不各写一份正则
 * （同一形状两种写法＝两个真值来源，本项目已因同类问题裁过一次）。
 */
export const HANDLE_RE = /^h([0-9a-f]{4})([0-9a-f]{8}):(\d+)-(\d+)$/

/**
 * 单条回执附带的句柄数上限（契约 §4：超限只报数，不发句柄）。
 *
 * 取值理由见 `read-core.mjs` 的 `HANDLE_MAX_PER_RECEIPT` 注释（那里是实际用它的地方）。
 */
export const HANDLE_MAX_PER_RECEIPT = 20

/**
 * 句柄的字符长度：`h` + 4 + 8 + `:` + 行号 + `-` + 行号。
 *
 * 行号是十进制**自然写法**（契约 §3 的正则是 `\d+`，钉死了这一点），所以这个数
 * 只在行号占 3～4 位时等于 21——也就是契约里那个例子 `h9f3ac1b2e4d5:120-160` 所在的档，
 * 以及**任何上千行的真实文件**所在的档。行号是 1 位数时它是 18。
 *
 * 为什么不把行号补零成定长 4 位去硬凑 21：那会让 `1-3` 变成 `0001-0003`，
 * 而句柄的坐标是**给编辑侧当行号用的**——补零就改变了它的语义
 * （`parseHandle` 还原出来的是 1 还是 0001，取决于谁来解析，这正是两个真值来源）。
 * 宁可长度随行号位数浮动。
 *
 * 导出成常量是为了让"体积核算"与"测试"共用同一个来源，不各写一个魔数；
 * 但核算时要按实际行号算（见 `handleCharsFor`），不能拿 21 硬乘。
 */
export const HANDLE_CHARS = 21

/**
 * 按行号算出该区间句柄的**确切**字符数。
 *
 * 用它而不是常量 21：体积核算里差 3 个字符不会有人发现，但"句柄长度恒为 21"
 * 这条判据会在小行号上红——与其在测试里写豁免，不如把真实公式交出来。
 *
 * @param startLine - 1-based 起始行
 * @param endLine - 1-based 结束行
 */
export function handleCharsFor(startLine, endLine) {
  const digits = (n) => String(n).length
  // 1(`h`) + 4(身份标签) + 8(区间摘要) + 1(`:`) + 1(`-`)
  return 15 + digits(startLine) + digits(endLine)
}

/**
 * 区间字节的摘要：`contentToken` 指纹段的**前 8 位**。
 *
 * `byteOrderMark` 的口径与读全文时**完全一致**（带 BOM 就在区间字节前补 U+FEFF），
 * 否则同一段内容在"整文件令牌"与"区间摘要"两个地方会给出互相矛盾的说法。
 *
 * **必须补零到 8 位**：契约 §3 把摘要定成 8 位（形状 21 字符全靠它）；
 * 而 `toString(16)` 省掉前导 0，所以哈希值落在 `0x0000000`–`0xfffffff` 这一档（约 1/16 的区间）时
 * 只有 1~7 位。
 *
 * 这一条不是理论洁癖——**实测就有**：本套件靶子 `return x + 1` 那一段的指纹是 7 位，
 * 于是句柄是 17 字符而不是 21，`length === 21` 那条判据当场变红。
 * 一个约 1/16 概率触发的形状破坏，比一个稳定触发的更难查。
 *
 * 与 `contentToken` 的关系：本函数 = `fnv1a32(...)` 的前 8 位（补零），
 * 而 `contentToken` = `fnv1a32(...)` + `:` + 含 BOM 的字符数。**同一个哈希，两种用法**；
 * `handle-read-test.mjs` 有一条断言拿两份真实输出对拍，钉住这件事。
 *
 * @param regionText - 区间的原始字节（`lines.slice(a, b).join('\n')`，未加行号、未截断）
 * @param byteOrderMark - 这份文件是否带 UTF-8 BOM
 * @returns 8 位小写十六进制（定长）
 */
export function regionFingerprint(regionText, byteOrderMark = false) {
  return fnv1a32(regionText, byteOrderMark).slice(0, FINGERPRINT_HEX).padStart(FINGERPRINT_HEX, '0')
}

/**
 * 身份标签：**账本键**（`resolveLedgerKey` 口径算出的那个键）的摘要前 4 位。
 *
 * 它回答的问题只有一个：「这个句柄来自另一个文件吗」——判据是**同一个口径的键**，
 * 于是同一份文件、同一个路径写法，无论从壳进程还是独立面读，标签都一样。
 *
 * 与指纹同族（FNV-1a），因为它的职责也一样：当**查表键**，不当安全边界。
 *
 * **必须补零到 4 位**：契约 §3 把形状定成**定长**（`h` + 4 + 8 + `:` + 行号 + `-` + 行号，例 21 字符），
 * 而 32 位哈希的十六进制表示在极端情况下不足 4 位：`(h >>> 0).toString(16)` 省掉前导 0，
 * 所以哈希值落在 `0x0000`–`0xffff` 这一档（约 1/65536 的键）时只有 1~3 位。
 * 不补零就有极少数键铸出 18~20 字符的柄，
 * 而"长度恒为 21"这条判据会在那些键上静默失效——极低频的失效比高频失效更难查。
 * 补零是安全的：它只是在十六进制表示里显式写出被省略的前导 0，
 * 同一个键仍然只有一个标签（仍是纯函数），且正则仍然认它。
 *
 * @param ledgerKey - 已归一化的账本键（字符串）
 */
export function identityTag(ledgerKey) {
  const text = typeof ledgerKey === 'string' ? ledgerKey : String(ledgerKey ?? '')
  // 账本键不带 BOM 语义：它是键，不是内容。
  return fnv1a32(text).slice(0, ID_TAG_HEX).padStart(ID_TAG_HEX, '0')
}

/**
 * 铸一个句柄。**纯函数**：同样的入参永远给出同一个字符串，不看时间、不看账本、不看进程。
 *
 * 这是"同一份未变区间重读 ⇒ 同一个句柄"那条判据的实现基础（幂等、可对账、可当内容凭据）。
 *
 * @param ledgerKey - 已归一化的账本键
 * @param regionText - 区间原始字节（**未加行号、未截断**——否则摘要会随预算变化）
 * @param byteOrderMark - 这份文件是否带 UTF-8 BOM
 * @param startLine - 区间起始行（1-based，含）
 * @param endLine - 区间结束行（1-based，含）
 * @returns 形如 `h9f3ac1b2e4d5:120-160`
 */
export function mintHandle({ ledgerKey, regionText, byteOrderMark = false, startLine, endLine }) {
  return `h${identityTag(ledgerKey)}${regionFingerprint(regionText, byteOrderMark)}:${startLine}-${endLine}`
}

/**
 * 解析句柄。**不认识就说不知道**，不抛错、不猜。
 *
 * 形状不对（连正则都不匹配）在**参数面**是要抛错的（契约 §5 第 0 步）；
 * 但形状对不对是**调用方**的判断，所以这里只回 `{ok:false}`——把抛错留给参数层，
 * 本函数保持"从不抛错"这一个语义，便于两侧共用。
 *
 * @param text - 待解析的字符串
 * @returns `{ok:true,idTag,fingerprint,startLine,endLine}` 或 `{ok:false}`
 */
export function parseHandle(text) {
  if (typeof text !== 'string') return { ok: false }
  const m = HANDLE_RE.exec(text)
  if (m === null) return { ok: false }
  const startLine = Number(m[3])
  const endLine = Number(m[4])
  return { ok: true, idTag: m[1], fingerprint: m[2], startLine, endLine }
}
