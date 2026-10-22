/**
 * fs-provider.mjs —— 给独立 CLI / MCP 用的**本机文件提供方**（node:fs，零依赖，跨平台）。
 *
 * 引擎（`locator-lab/write-path.mjs`）只认一个四方法的契约，不认框架：
 *   stat(target)                             -> { version, size } | undefined
 *   readText(target)                         -> string   提供方视角（解码时剥掉恰好一个前导 BOM）
 *   readByteRange(target, { offset, length }) -> Uint8Array
 *   writeText(target, content, expected)     -> { version }
 *
 * 与 DSH 那边 `dsh-fs-local` 的语义逐条对齐（这样两条路上的判据才可比）：
 *   · 解码用 `new TextDecoder('utf-8', { fatal: true })` —— 默认 `ignoreBOM:false`，**第一个 BOM 不进字符串**；
 *   · 写入用 `TextEncoder`，**逐字节**，不做行尾归一（DSH 那边踩过的坑：`editText` 会按多数派归一）；
 *   · 落盘走**临时文件 + rename**（同目录），Windows 上 rename 也覆盖已存在文件；
 *   · `expected.kind === 'replaceIfVersion'` 时先比版本，不符抛 `FS_STALE_VERSION`（本机版 CAS）；
 *   · `expected.kind === 'createIfAbsent'` 时文件已存在则抛 `FS_NOT_OBSERVED`。
 *
 * 版本指纹 = `size:mtimeMs:sha256(前 4KB + 后 4KB + size)`：
 * 不整份读（大文件也不心疼），但足以发现内容改写——同尺寸同 mtime 的改写会把哈希打出来。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const SAMPLE = 4096

/** 读文件（返回 Buffer）；文件不存在抛带 code 的错误。 */
function readOrThrow(target) {
  try {
    return fs.readFileSync(target)
  } catch (error) {
    if (error?.code === 'ENOENT') throw Object.assign(new Error(`cannot patch "${target}": not found`), { code: 'FS_NOT_FOUND' })
    throw error
  }
}

/** 版本指纹：size + mtimeMs + 头尾采样哈希。 */
export function fingerprintOf(buffer, stat) {
  const head = buffer.subarray(0, SAMPLE)
  const tail = buffer.length > SAMPLE ? buffer.subarray(buffer.length - SAMPLE) : Buffer.alloc(0)
  const hash = crypto.createHash('sha256').update(head).update(tail).update(String(buffer.length)).digest('hex').slice(0, 16)
  return `${buffer.length}:${Math.trunc(stat.mtimeMs)}:${hash}`
}

/** 原子写：同目录临时文件 + rename（跨平台，Windows 上 rename 会覆盖）。 */
function writeAtomic(target, content) {
  const dir = path.dirname(target)
  const tmp = path.join(dir, `.${path.basename(target)}.aura-${process.pid}-${Date.now().toString(36)}.tmp`)
  try {
    fs.writeFileSync(tmp, content)
    fs.renameSync(tmp, target)
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 清理失败的临时文件不影响正确性：错误照抛 */
    }
    throw error
  }
}

/**
 * 造一个提供方。
 * @param options.resolveRoot - 相对路径的解析根（默认进程 cwd）；对象里只留绝对路径，避免"被检查的路径"与"被写的路径"不是同一个。
 */
export function createNodeFsProvider(options = {}) {
  const root = path.resolve(options.resolveRoot ?? process.cwd())
  const abs = (p) => (path.isAbsolute(p) ? path.normalize(p) : path.resolve(root, p))

  const stat = (target) => {
    const file = abs(target)
    let st
    try {
      st = fs.statSync(file)
    } catch {
      return undefined
    }
    /**
     * 目录**不再抛 `FS_NOT_REGULAR_FILE`**，而是带上 `type` 返回。
     *
     * 为什么改：仓库级地图（T26）需要“这个路径是目录”这件事先被知道。
     * 旧行为下 `aura read <目录>` 报的是 `cannot patch "...": not a regular file`——
     * 一句话里有两个错：动作是读不是改，而真正的原因（它是个目录）根本没提。
     * 类型字段与 `dsh-fs-local` 的 `probe()` 同形（`file` / `directory` / `other`），
     * 两边判据因此可比。
     */
    if (st.isDirectory()) return { type: 'directory', size: 0 }
    if (!st.isFile()) throw Object.assign(new Error(`cannot patch "${target}": not a regular file`), { code: 'FS_NOT_REGULAR_FILE' })
    return { type: 'file', version: fingerprintOf(fs.readFileSync(file), st), size: st.size }
  }

  return {
    /** 解析成绝对路径（CLI 的显示路径 → 真实路径的唯一次转换）。 */
    resolve: (p) => abs(p),
    stat,
    async readText(target) {
      const buffer = readOrThrow(abs(target))
      if (buffer.includes(0)) throw Object.assign(new Error(`cannot read "${target}": binary file`), { code: 'FS_NOT_TEXT' })
      // 与 dsh-fs-local 同形：fatal 解码 + 默认 ignoreBOM（第一个 BOM 被吃掉，其余 U+FEFF 留在文本里）
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    },
    async readByteRange(target, range) {
      const buffer = readOrThrow(abs(target))
      const offset = Math.max(0, range?.offset ?? 0)
      const length = Math.max(0, range?.length ?? 0)
      return new Uint8Array(buffer.subarray(offset, offset + length))
    },
    /**
     * 列直接子项（目录级地图用，T26）。
     *
     * 形状与 `dsh-fs-local.listDir` 对齐而非自创：`{ name, type, size, target }`，
     * `type` ∈ `directory` / `file` / `other`。
     * 两边的地图因此可以由同一份引擎逻辑驱动（`collectRepoMap`），
     * 不会出现“CLI 列目录的规则与 DSH 不一样”这类只有对比才能发现的偏差。
     * `target` 用**绝对路径字符串**：本提供方的其余方法都接受绝对路径，不必再包一层。
     *
     * @param target - 目录（绝对或相对解析根）
     * @returns `{name, type, size, target}[]`，按名字排序（可重现的回执）
     */
    async listDir(target) {
      const dir = abs(target)
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch (error) {
        if (error?.code === 'ENOENT') throw Object.assign(new Error(`cannot list "${target}": not found`), { code: 'FS_NOT_FOUND' })
        throw error
      }
      return entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => {
          const child = path.join(dir, e.name)
          let size
          if (e.isFile()) {
            try {
              size = fs.statSync(child).size
            } catch {
              size = 0
            }
          }
          return {
            name: e.name,
            type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other',
            ...(size === undefined ? {} : { size }),
            target: child,
          }
        })
    },
    async writeText(target, content, expected) {
      const file = abs(target)
      const exists = fs.existsSync(file)
      if (expected?.kind === 'createIfAbsent' && exists) {
        throw Object.assign(new Error(`cannot overwrite existing "${target}" without reading it first`), { code: 'FS_NOT_OBSERVED' })
      }
      if (expected?.kind === 'replaceIfVersion') {
        if (!exists) throw Object.assign(new Error(`cannot patch "${target}": file no longer exists`), { code: 'FS_STALE_VERSION' })
        const current = stat(target).version
        if (current !== expected.version) {
          throw Object.assign(new Error(`cannot patch "${target}": file changed since it was read`), { code: 'FS_STALE_VERSION' })
        }
      }
      writeAtomic(file, content)
      return { version: stat(target).version }
    },
  }
}
