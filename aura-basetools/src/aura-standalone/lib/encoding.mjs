/**
 * encoding.mjs —— 非 UTF-8 文本的**探测 / 解码 / 回编码**（零依赖）。
 *
 * ## 为什么这层存在
 *
 * 内置读写工具只认 UTF-8；CJK 老项目、GBK 配置、Windows 导出文件、UTF-16 的
 * PowerShell 输出都读不了。反馈（2026-10-25）把它列为第一条产品边界。
 *
 * ## 为什么可以零依赖
 *
 * Node 的 `TextDecoder`（full ICU）**能解码** gbk / gb18030 / shift_jis / euc-kr /
 * big5 / windows-1252 / utf-16le / utf-16be；但没有对应的 `TextEncoder`。
 * 反向表可以**暴力建**：把双字节空间逐对解码，拿到“字符 → 字节”的映射。
 * 实测（Node 24）：GBK 23,939 条 / 11ms，Shift_JIS 9,269 条 / 7ms，EUC-KR 8,442 条 / 4ms。
 * 每个编码只建一次，进程内缓存。
 *
 * ## 一条硬边界：**只写回编码可逆的文件**
 *
 * 同一个字符在一个编码里可能有多个字节表示（重复映射），GB18030 的 4 字节形式更是
 * 覆盖到 BMP 之外。若 `decode → encode` 不能逐字节还原原文件，那么“改一行”可能会把
 * **没改的行**也换一种字节写法——逐字节保真的承诺就破了。
 *
 * 所以 `probeEncoding` 会顺手做一次往返校验：不可逆的编码一律**只读**，
 * 写操作拒绝（`ENCODING_NOT_ROUNDTRIP_SAFE`）并给出“先转成 UTF-8”的下一步。
 * 这不是能力缺失，而是把“能读”与“能安全写”分开——后者才是本工具的价值。
 */

/** BOM 按**从长到短**匹配：UTF-32LE 的前两字节与 UTF-16LE 相同。 */
const BOMS = [
  { bytes: [0x00, 0x00, 0xfe, 0xff], encoding: 'utf-32be' },
  { bytes: [0xff, 0xfe, 0x00, 0x00], encoding: 'utf-32le' },
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8' },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le' },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be' },
]

/** 探测候选（顺序 = 并列时的优先级；windows-1252 是最终兜底，任何字节都能解码）。 */
export const ENCODING_CANDIDATES = ['gb18030', 'shift_jis', 'euc-kr', 'big5', 'windows-1252']

/**
 * 本工具能读能写的编码（UTF-32 只读，不在此列）。`capabilities.textEncodings` 取这一份。
 *
 * 单字节代码页都在：它们不进探测候选（单字节解码永远不会失败，会抢 CJK 的判决），
 * 但**显式指定**时与多字节编码走同一套反向表（懒建、逐字节写回）。
 */
export const SUPPORTED_ENCODINGS = [
  'utf-8',
  'utf-16le',
  'utf-16be',
  'gb18030',
  'shift_jis',
  'euc-kr',
  'big5',
  'windows-1252',
  'windows-1250',
  'windows-1251',
  'windows-1253',
  'windows-1254',
  'windows-1255',
  'windows-1256',
  'windows-1257',
  'windows-1258',
  'iso-8859-2',
  'iso-8859-5',
  'iso-8859-7',
  'iso-8859-9',
  'iso-8859-15',
  'koi8-r',
  'koi8-u',
]

/** 不支持“回编码”的编码（Node 能解码，但这里不建表）：UTF-32 只读。 */
const READ_ONLY_ENCODINGS = new Set(['utf-32le', 'utf-32be'])

/**
 * 调用方写的编码名 → {@link SUPPORTED_ENCODINGS} 里的规范名。
 *
 * 这些别名是**真实在用的写法**（GBK/GB2312 是 Windows 中文环境里 `encoding` 的默认叫法，
 * `utf8` 是 Node 的写法），不是测试里造的字符串。
 */
export const ENCODING_ALIASES = {
  utf8: 'utf-8',
  gbk: 'gb18030',
  gb2312: 'gb18030',
  cp936: 'gb18030',
  latin1: 'windows-1252',
  'iso-8859-1': 'windows-1252',
  utf16le: 'utf-16le',
  utf16be: 'utf-16be',
  sjis: 'shift_jis',
  'shift-jis': 'shift_jis',
  cp1251: 'windows-1251',
  cp1252: 'windows-1252',
}

/** 规范名；不是字符串则 null（调用方自己决定“没给”还是“给错”）。 */
export function normalizeEncodingName(name) {
  if (typeof name !== 'string') return null
  const lower = name.trim().toLowerCase()
  return ENCODING_ALIASES[lower] ?? lower
}

/** 认得的编码名：能读能写的那份 + 只读的 UTF-32（写回另有一道 `ENCODING_NOT_ROUNDTRIP_SAFE`）。 */
const KNOWN_ENCODING_NAMES = new Set([...SUPPORTED_ENCODINGS, ...READ_ONLY_ENCODINGS])

/** 这个名字在不在词表里（别名先折算）。记忆库读写两侧都用它，判据只有一份。 */
export function isKnownEncodingName(name) {
  const normalized = normalizeEncodingName(name)
  return normalized !== null && KNOWN_ENCODING_NAMES.has(normalized)
}

/**
 * 编码名必须落在这张表里，否则**大声拒绝**——这是唯一的入口判据。
 *
 * 为什么判在探测之前（而不是让下游报错）：`hint` 不是“可以忽略的偏好”，它是调用方对
 * 这份字节的主张。放一个不存在的名字过去，`new TextDecoder('x')` 抛 Node 的
 * `ERR_ENCODING_NOT_SUPPORTED`，而读路径的 catch 把任何解码失败都翻成
 * “这个文件不是 UTF-8 文本”——**报错把人推向错的方向**（该改的是参数，文案却让你去 `from`/op=convert）。
 * 更坏的一半：这个名字会按路径 `rememberEncoding` 记下来，于是**同一个文件后面的每一次调用**
 * 都坏，连没带 `encoding` 的调用也坏，坏因看不见（2026-10-30 由 C2 探针实测）。
 *
 * @param name - 调用方给的编码名（别名可以）
 * @param where - 回执里点名的参数（`encoding` / `from` / `AURA_ENCODING`）
 * @returns 规范名
 * @throws {{code:'ENCODING_UNSUPPORTED'}} 词表不在表里
 */
export function assertEncodingName(name, where = 'encoding') {
  const normalized = normalizeEncodingName(name)
  if (normalized !== null && KNOWN_ENCODING_NAMES.has(normalized)) return normalized
  throw Object.assign(
    new Error(
      `${where}=${JSON.stringify(name)} is not an encoding this tool knows. Supported: ${SUPPORTED_ENCODINGS.join(', ')} (aliases: ${Object.keys(ENCODING_ALIASES).join(', ')}). Nothing was read with it.`,
    ),
    { code: 'ENCODING_UNSUPPORTED', encoding: name },
  )
}

const decoderCache = new Map()
function decoderFor(encoding) {
  if (!decoderCache.has(encoding)) decoderCache.set(encoding, new TextDecoder(encoding))
  return decoderCache.get(encoding)
}
function fatalDecoderFor(encoding) {
  const key = `${encoding}:fatal`
  if (!decoderCache.has(key)) decoderCache.set(key, new TextDecoder(encoding, { fatal: true }))
  return decoderCache.get(key)
}

function bomOf(buffer) {
  for (const bom of BOMS) {
    if (buffer.length >= bom.bytes.length && bom.bytes.every((byte, index) => buffer[index] === byte)) {
      return { encoding: bom.encoding, bytes: bom.bytes }
    }
  }
  return null
}

/**
 * 双重编码检测：文本是不是“原本的 UTF-8 字节被当成 Latin-1/GBK 又存了一次”的产物。
 *
 * 只认**可逆**的那一类：能拿当前文本按原编码还原出字节、再按 UTF-8 解出**更像正文**的文本。
 * `锟斤拷` 那种（UTF-8 解码失败后被替换字符落盘）不可逆，这里**不假装能救**——返回 null。
 *
 * 判据故意保守：解出来的文本必须有 ≥3 个汉字，而当前文本里一个汉字都没有。
 * 宁可漏报，不可把一段合法的法文/代码字符当乱码“修复”掉。
 */
export function detectDoubleEncoding(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  if (/[\u4e00-\u9fff]/u.test(text)) return null // 已有汉字：不是这一类乱码
  const latin1 = countLatin1Supplement(text)
  if (latin1 >= text.length * 0.5 && latin1 >= 3) {
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(text, 'latin1'))
      if (hanCount(decoded) >= 3) return { kind: 'latin1-then-utf8', via: 'latin1' }
    } catch {
      /* 不是可逆的一类 */
    }
  }
  try {
    const bytes = encodeText(text, { encoding: 'gb18030', bom: [] })
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (hanCount(decoded) >= 3) return { kind: 'gb18030-then-utf8', via: 'gb18030' }
  } catch {
    /* 不是可逆的一类 */
  }
  return null
}

/** 把检测到的双重编码还原成正文（纯函数；不可逆时抛错）。 */
export function repairDoubleEncoding(text, detected) {
  if (detected === null || detected === undefined) throw Object.assign(new Error('no double-encoding detected'), { code: 'CONVERT_NO_DOUBLE_ENCODING' })
  const bytes = detected.via === 'latin1' ? Buffer.from(text, 'latin1') : encodeText(text, { encoding: 'gb18030', bom: [] })
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function countLatin1Supplement(text) {
  let count = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code >= 0x80 && code <= 0xff) count += 1
  }
  return count
}

function hanCount(text) {
  let count = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code >= 0x4e00 && code <= 0x9fff) count += 1
  }
  return count
}

/**
 * 无 BOM UTF-16 的端序推断：只看 NUL 的**位置分布**。
 * 返回 'utf-16le' / 'utf-16be' / null。
 */
function inferBomlessUtf16(buffer) {
  if (buffer.length < 4 || buffer.length % 2 !== 0) return null
  let zeros = 0
  let evenZeros = 0
  let oddZeros = 0
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] !== 0) continue
    zeros += 1
    if (i % 2 === 0) evenZeros += 1
    else oddZeros += 1
  }
  if (zeros < buffer.length * 0.15) return null
  if (oddZeros >= zeros * 0.85) return 'utf-16le'
  if (evenZeros >= zeros * 0.85) return 'utf-16be'
  return null
}

/**
 * 控制符/替换符比例过高就不是“干净文本”。
 * 无 BOM 的 UTF-16 推断只针对**以 ASCII 为主**的文本（纯 CJK 的 UTF-16 几乎没有 NUL，
 * 信息上不可判）；所以解出来的非 ASCII 码点必须很少——否则一段带 NUL 的二进制字节
 * 会被误当成 UTF-16。
 */
function plausibleText(text) {
  let bad = 0
  let wide = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code === 0xfffd) return false
    if (code > 0x7e) wide += 1
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) bad += 1
  }
  if (wide > text.length * 0.1) return false
  return bad <= Math.max(1, text.length * 0.01)
}

/** ASCII 之外是否还有字节：纯 ASCII 不必猜，UTF-8 就是对的。 */
function isAscii(buffer) {
  for (const byte of buffer) if (byte > 0x7f) return false
  return true
}

/**
 * 高频汉字（简 + 繁）。不是语言模型，只用来区分“解出来是真中文”与“解出来是随机汉字”：
 * GBK 字节被错解成 Shift_JIS 时，得到的基本是生僻/不相关的汉字，命中率明显低。
 */
const COMMON_HANZI = new Set(
  ('的一是不了人我在有他这为之大来以个中上们到说国和地也子时道出而要于就下得可你年生' +
    '看天年自子手何文头学过对面当起就看所以外中前定行方多月给出就明利得实行方都事家等' +
    '信里现所点边法三小将机分那好行开通于发水成只作当想看太得知不少经现方事面而及全两' +
    '体西气月教分战百见小报必马公将话次新十明个外员对原系最了事动成问高但自里外还分新' +
    '的一是不了人我在有他這為之大來以個中上們到說國和地也子時道出而要於就下得可你年生' +
    '看天年自子手何文頭學過對面當起就看所以外中前定行方多月給出就明利得實行方都事家等' +
    '信裡現所點邊法三小將機分那好行開通於發水成只作當想看太得知不少經現方事面而及全兩').split(''),
)
const KANA = /[\u3040-\u30ff]/
const HANGUL = /[\uac00-\ud7af]/

/** 控制字符（除 \t \n \r）与私用区越多，越不像“正确的编码”。 */
function plausibility(text) {
  let score = 0
  let cjk = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) score += 200
    else if (code === 0xfffd) score += 10000
    else if (code >= 0xe000 && code <= 0xf8ff) score += 40
    else if (code >= 0x4e00 && code <= 0x9fff) cjk += 1
    else if (code >= 0x80 && code <= 0xff) score += 3
    else if (code >= 0x2e80 && code <= 0x9fff) cjk += 0.5
  }
  return score - cjk
}

/**
 * 编码专属加分：
 *   · Shift_JIS 文本几乎必带假名；
 *   · EUC-KR 文本几乎必带谚文（超范围，几乎不会误中）；
 *   · GB18030 / Big5 用高频汉字命中率区分简繁。
 * 注意：纯汉字短句（如“日本語”）本质上有歧义，所以分差小的时候报 `medium` 而不是硬猜。
 */
function encodingBonus(text, encoding) {
  let kana = 0
  let hangul = 0
  let commonHangul = 0
  let common = 0
  let simplified = 0
  let traditional = 0
  let script = 0
  for (const char of text) {
    if (KANA.test(char)) {
      kana += 1
      script += 1
    } else if (HANGUL.test(char)) {
      hangul += 1
      if (COMMON_HANGUL.has(char)) commonHangul += 1
      script += 1
    } else {
      const code = char.codePointAt(0)
      if (code >= 0x4e00 && code <= 0x9fff) {
        script += 1
        if (COMMON_HANZI.has(char)) common += 1
        if (SIMPLIFIED_ONLY.has(char)) simplified += 1
        if (TRADITIONAL_ONLY.has(char)) traditional += 1
      }
    }
  }
  const total = Math.max(1, script)
  const kanaRatio = kana / total
  const hangulRatio = hangul / total
  /** 真实韩文的高频音节占比很高；噪声谚文几乎命中不了。 */
  const commonHangulRatio = commonHangul / total
  const commonRatio = common / total
  const simplifiedRatio = simplified / total
  const traditionalRatio = traditional / total
  /**
   * 三次方：只有“接近纯某语言”才给大分。
   * 理由：GBK 字节常常在 EUC-KR 里也“合法”，会解出几个谚文——线性计分会让它反超；
   * 真实韩文/日文的假名/谚文占比接近 80%+，三次方把“少数噪声”压下去。
   */
  if (encoding === 'shift_jis') return kanaRatio ** 2 * 120 + commonRatio * 3
  if (encoding === 'euc-kr') return commonHangulRatio ** 2 * 160 + hangulRatio * 4
  if (encoding === 'gb18030') return commonRatio * 10 + simplifiedRatio * 8
  if (encoding === 'big5') return commonRatio * 10 + traditionalRatio * 8
  return 0
}

/**
 * 高频谚文音节（韩国语常用 ~120 个）。
 * 为什么需要它：GBK 字节在 EUC-KR 里常常也“合法”，会解出一堆**随机**谚文；
 * 只看谚文比例会被噪声骗（实测两行中文被认成韩文）。真实韩文用高频音节，噪声不用。
 */
const COMMON_HANGUL = new Set(
  ('이다는의리가에하고한것은어지대로수도시정등그나아부게있하면서요까안않없되받사람우조회국민중소기업계획발전문제관리프램데터트워크컴퓨니스입테스트습').split(''),
)

/** 只简体 / 只繁体的常用字（区分 GB 与 Big5 的强信号）。 */
const SIMPLIFIED_ONLY = new Set('这个说国为时学过对给发经现点边将机开们来还问长见话让东风车书关门听写买卖应'.split(''))
const TRADITIONAL_ONLY = new Set('這個說國為時學過對給發經現點邊將機開們來還問長見話讓東風車書關門聽寫買賣應'.split(''))

/**
 * 探测一个 buffer 的编码。
 *
 * @param buffer - 原始字节
 * @param options.hint - 调用方显式指定（`--encoding` / MCP `encoding`），命中即用，不做猜测
 * @returns {{encoding:string, bom:number[], confidence:'high'|'medium'|'low',
 *            alternatives:string[], roundTrip:boolean, readOnly:boolean}}
 */
export function probeEncoding(buffer, { hint } = {}) {
  if (typeof hint === 'string' && hint.length > 0) {
    const encoding = assertEncodingName(hint)
    const bom = bomOf(buffer)
    return {
      encoding,
      bom: bom?.encoding === encoding ? bom.bytes : [],
      confidence: 'high',
      alternatives: [],
      explicit: true,
      ...roundTripVerdict(buffer, encoding, bom?.encoding === encoding ? bom.bytes : []),
      readOnly: READ_ONLY_ENCODINGS.has(encoding),
    }
  }

  const bom = bomOf(buffer)
  if (bom !== null) {
    // UTF-16/32 的正文里必然有 0 字节，不能再用“含 NUL 即二进制”的判据。
    return {
      encoding: bom.encoding,
      bom: bom.bytes,
      confidence: 'high',
      alternatives: [],
      ...roundTripVerdict(buffer, bom.encoding, bom.bytes),
      readOnly: READ_ONLY_ENCODINGS.has(bom.encoding),
    }
  }

  if (buffer.includes(0)) {
    /**
     * 无 BOM 的 UTF-16：ASCII 为主的文本，NUL 会集中在奇（LE）或偶（BE）位。
     * 这是可判的：≥15% 的字节是 NUL、且 ≥85% 的 NUL 落在同一侧。
     * 解出来必须是干净文本（无替换符、控制符不异常），否则仍按二进制拒。
     * 纯 CJK 的 UTF-16 几乎没有 NUL，信息上不可判——那时仍然拒绝（不猜）。
     */
    const inferred = inferBomlessUtf16(buffer)
    if (inferred !== null) {
      const probe = { encoding: inferred, bom: [], confidence: 'medium', alternatives: [inferred === 'utf-16le' ? 'utf-16be' : 'utf-16le'], ...roundTripVerdict(buffer, inferred, []), readOnly: false, explicit: false }
      if (probe.roundTrip === true) {
        const decoded = decoderFor(inferred).decode(Buffer.from(buffer))
        if (!decoded.includes('\uFFFD') && plausibleText(decoded)) return probe
      }
    }
    // 无 BOM 且判不出端序：按二进制拒绝（与既有 FS_NOT_TEXT 行为一致）。
    return { encoding: null, bom: [], confidence: 'high', alternatives: [], roundTrip: false, readOnly: true }
  }

  // 合法 UTF-8 就是 UTF-8：绝大多数文件走这条，行为与支持多编码之前**逐字节一致**。
  try {
    const text = fatalDecoderFor('utf-8').decode(buffer)
    if (isAscii(buffer) || plausibility(text) <= 0) {
      return { encoding: 'utf-8', bom: [], confidence: 'high', alternatives: [], roundTrip: true, readOnly: false }
    }
    // UTF-8 合法但“不像文本”（私用区/控制符）：继续当 UTF-8——合法性比猜测强。
    return { encoding: 'utf-8', bom: [], confidence: 'high', alternatives: [], roundTrip: true, readOnly: false }
  } catch {
    /* 不是合法 UTF-8，进入候选打分 */
  }

  const scored = []
  for (const encoding of ENCODING_CANDIDATES) {
    let text
    try {
      text = fatalDecoderFor(encoding).decode(buffer)
    } catch {
      continue
    }
    if (text.includes('\u0000')) continue
    scored.push({ encoding, score: plausibility(text) - encodingBonus(text, encoding) })
  }
  if (scored.length === 0) {
    return { encoding: null, bom: [], confidence: 'high', alternatives: [], roundTrip: false, readOnly: true }
  }
  scored.sort((a, b) => a.score - b.score)
  const best = scored[0]
  const second = scored[1]
  // 分差太小 = 猜不准：报 `medium`，把候选交给调用方（`--encoding` 可覆盖）。
  const confidence = second === undefined ? 'high' : second.score - best.score >= 5 ? 'high' : 'medium'
  return {
    encoding: best.encoding,
    bom: [],
    confidence,
    alternatives: scored.slice(1, 4).map((entry) => entry.encoding),
    ...roundTripVerdict(buffer, best.encoding, []),
    readOnly: false,
  }
}

/** 往返校验：解码→回编码能否逐字节还原（BOM 也算进去）。 */
function roundTripVerdict(buffer, encoding, bomBytes) {
  if (READ_ONLY_ENCODINGS.has(encoding)) return { roundTrip: false }
  try {
    const text = decodeBytes(buffer, { encoding, bom: bomBytes })
    /**
     * 引擎的 BOM 约定：BOM 文件写入时，`writeText` 收到的 content **已经带一个 U+FEFF**
     * （引擎把 BOM 当正文首字符再带一份；双/三 BOM 夹具靠这个逐字节保留）。
     * 往返校验必须用同一约定——否则双 BOM 文件会被误判成“不可逆”，写入被拒。
     */
    const content = bomBytes.length > 0 ? `\uFEFF${text}` : text
    const encoded = encodeText(content, { encoding, bom: bomBytes })
    return { roundTrip: Buffer.compare(Buffer.from(encoded), Buffer.from(buffer)) === 0 }
  } catch {
    return { roundTrip: false }
  }
}

/** 解码（剥掉 BOM；TextDecoder 默认 ignoreBOM:false 会吃掉一个前导 BOM）。 */
export function decodeBytes(buffer, probe) {
  return decoderFor(probe.encoding).decode(Buffer.from(buffer))
}

/**
 * GB18030 补充平面（U+10000..U+10FFFF）的 4 字节形式是**线性**映射：
 * 码点 ⇄ 序号 `189000 + (cp - 0x10000)`，序号再按 12600/1260/10 拆成四字节。
 * 实测 U+1F642 🙂 → 95 30 85 32、U+20000 → 95 32 82 36，解码回来逐字相同。
 *
 * BMP 的 4 字节区（如扩展 A 区）不是线性的，需要标准映射表；本工具不内置那张表，
 * 遇到时仍拒绝（宁可拒绝，不可写错）。
 */
function gb18030FourByte(codePoint) {
  const index = codePoint - 0x10000 + 189000
  const rest1 = index % 12600
  const rest2 = rest1 % 1260
  return [0x81 + Math.floor(index / 12600), 0x30 + Math.floor(rest1 / 1260), 0x81 + Math.floor(rest2 / 10), 0x30 + (rest2 % 10)]
}

/** 反向表：字符 → 字节序列。懒建、进程内缓存。 */
const reverseCache = new Map()
export function reverseTable(encoding) {
  if (reverseCache.has(encoding)) return reverseCache.get(encoding)
  const decoder = decoderFor(encoding)
  const table = new Map()
  // 单字节：ASCII 直通；0x80-0xFF 逐个解（半角片假名、Latin-1 补区都在这里）。
  for (let byte = 0x00; byte <= 0xff; byte += 1) {
    const char = decoder.decode(Buffer.from([byte]))
    if (char.length === 1 && char !== '\ufffd') table.set(char, [byte])
  }
  // 双字节：只扫合法引导区，避免 6 万次全空间解码。
  const isUtf16 = encoding === 'utf-16le' || encoding === 'utf-16be'
  if (!isUtf16) {
    for (let high = 0x81; high <= 0xfe; high += 1) {
      for (let low = 0x40; low <= 0xfe; low += 1) {
        const char = decoder.decode(Buffer.from([high, low]))
        if (char.length === 1 && char !== '\ufffd' && !table.has(char)) table.set(char, [high, low])
      }
    }
  }
  reverseCache.set(encoding, table)
  return table
}

/**
 * 回编码。不可表示 / 不可逆时**抛错**，绝不静默替换成 '?'——那会把用户的字节改掉。
 *
 * @throws Error（code: ENCODING_UNREPRESENTABLE / ENCODING_NOT_ROUNDTRIP_SAFE）
 */
export function encodeText(text, probe) {
  const { encoding, bom = [] } = probe
  if (encoding === null || encoding === undefined) {
    throw Object.assign(new Error('cannot encode: unknown source encoding'), { code: 'ENCODING_UNKNOWN' })
  }
  if (READ_ONLY_ENCODINGS.has(encoding)) {
    throw Object.assign(new Error(`cannot write ${encoding}: this encoding is read-only here; convert the file to UTF-8 first`), {
      code: 'ENCODING_NOT_ROUNDTRIP_SAFE',
    })
  }
  /**
   * BOM 归谁：引擎在 BOM 文件上会把 BOM 当**正文的第一个字符**带进 content（历史上如此，
   * 双 BOM 夹具靠它逐字节保留）。所以：
   *   · content 已以 U+FEFF 开头 ⇒ 它自己就是 BOM，**不要再加前缀**；
   *   · 否则用探测到的 BOM 字节补上。
   * 早先“先剥掉再加前缀”会把双 BOM 文件断成一个 BOM（往返校验当场发现 ⇒ 写被拒）。
   */
  const prefix = bom.length > 0 && !text.startsWith('\uFEFF') ? Buffer.from(bom) : Buffer.alloc(0)
  const payload = text
  let body
  if (encoding === 'utf-8') {
    body = Buffer.from(payload, 'utf8')
  } else if (encoding === 'utf-16le') {
    body = Buffer.alloc(payload.length * 2)
    for (let i = 0; i < payload.length; i += 1) body.writeUInt16LE(payload.charCodeAt(i), i * 2)
  } else if (encoding === 'utf-16be') {
    body = Buffer.alloc(payload.length * 2)
    for (let i = 0; i < payload.length; i += 1) body.writeUInt16BE(payload.charCodeAt(i), i * 2)
  } else {
    const table = reverseTable(encoding)
    const chunks = []
    const missing = []
    for (const char of payload) {
      let bytes = table.get(char)
      if (bytes === undefined) {
        const codePoint = char.codePointAt(0)
        // GB18030 的补充平面（emoji / 扩展 B）用 4 字节线性形式，不必查表。
        if (encoding === 'gb18030' && codePoint >= 0x10000) bytes = gb18030FourByte(codePoint)
      }
      if (bytes === undefined) {
        missing.push(char)
        if (missing.length >= 8) break
        continue
      }
      chunks.push(Buffer.from(bytes))
    }
    if (missing.length > 0) {
      const shown = missing.map((char) => `${JSON.stringify(char)}(U+${char.codePointAt(0).toString(16).toUpperCase()})`).join(', ')
      throw Object.assign(
        new Error(`cannot encode to ${encoding}: ${shown} ${missing.length === 1 ? 'has' : 'have'} no mapping in this encoding — nothing was written; convert the file to UTF-8 (or replace those characters) first`),
        { code: 'ENCODING_UNREPRESENTABLE', characters: missing, encoding },
      )
    }
    body = Buffer.concat(chunks)
  }
  return prefix.length === 0 ? body : Buffer.concat([prefix, body])
}

/**
 * 能不能安全回写：编码可逆 + 不是只读编码 + **不是猜不准的**（除非调用方显式指定）。
 *
 * 中/低置信度下回写 = 把“猜错的编码”写回盘上，宁可拒绝。
 */
export function canWrite(probe) {
  if (probe === null || probe === undefined) return false
  if (probe.encoding === null || probe.encoding === undefined) return false
  if (probe.readOnly === true || probe.roundTrip !== true) return false
  return probe.explicit === true || probe.confidence === 'high'
}

/** 为什么不能写（给回执用的可执行理由）；能写返回 null。 */
export function writeRefusal(probe) {
  if (canWrite(probe)) return null
  if (probe?.encoding === null || probe?.encoding === undefined) return { code: 'FS_NOT_TEXT', reason: 'the file is not text' }
  if (probe.readOnly === true || probe.roundTrip !== true) {
    return { code: 'ENCODING_NOT_ROUNDTRIP_SAFE', reason: `${probe.encoding}: decoding/encoding would not reproduce the file byte-for-byte` }
  }
  return {
    code: 'ENCODING_AMBIGUOUS',
    reason: `detected ${probe.encoding} with ${probe.confidence} confidence (alternatives: ${probe.alternatives.join(', ') || 'none'}) — pass the encoding explicitly to write`,
  }
}

/** 供回执/诊断用的一行摘要。 */
export function describeProbe(probe) {
  if (probe?.encoding === null || probe?.encoding === undefined) return 'binary or undecodable'
  const bom = probe.bom.length > 0 ? '+bom' : ''
  const extra = probe.roundTrip ? '' : ' (read-only: not byte-reversible)'
  return `${probe.encoding}${bom}${extra}`
}
