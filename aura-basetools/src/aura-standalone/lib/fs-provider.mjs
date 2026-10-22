/**
 * fs-provider.mjs —— 给独立 CLI / MCP 用的**本机文件提供方**（node:fs，零依赖，跨平台）。
 *
 * 引擎（`locator-lab/write-path.mjs`）只认一个四方法契约，不认框架：
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
 * 只读头尾，不整份读；但足以发现常见的内容改写。
 *
 * 写入边界（v0.6.19 起）：
 *   · 现有文件的 mode 在替换后保留（POSIX；Windows 只保留可写位语义）；
 *   · 符号链接**写穿**到 realpath，链接本身保留；悬空链接拒绝；
 *   · 硬链接（nlink > 1）拒绝，因为 rename 会打断另一个名字；
 *   · 文本读取/写入有大小上限（默认 512 MiB，可由 `AURA_MAX_FILE_BYTES` 覆盖）；
 *   · `readByteRange` 只读请求区间，不再整份读。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const SAMPLE = 4096
export const DEFAULT_MAX_TEXT_BYTES = 512 * 1024 * 1024

/** 读文件（返回 Buffer）；文件不存在 / 不是普通文件 / 超限抛带 code 的错误。 */
function readOrThrow(target, maxBytes) {
  let st
  try {
    st = fs.statSync(target)
  } catch (error) {
    if (error?.code === 'ENOENT') throw Object.assign(new Error(`cannot read "${target}": not found`), { code: 'FS_NOT_FOUND' })
    throw error
  }
  if (st.isDirectory()) throw Object.assign(new Error(`cannot read "${target}": not a regular file`), { code: 'FS_NOT_REGULAR_FILE' })
  if (!st.isFile()) throw Object.assign(new Error(`cannot read "${target}": not a regular file`), { code: 'FS_NOT_REGULAR_FILE' })
  if (st.size > maxBytes) {
    throw Object.assign(
      new Error(`cannot read "${target}": file is ${st.size} bytes, over the ${maxBytes}-byte text limit`),
      { code: 'FS_TOO_LARGE', size: st.size, limit: maxBytes },
    )
  }
  try {
    return fs.readFileSync(target)
  } catch (error) {
    if (error?.code === 'ENOENT') throw Object.assign(new Error(`cannot read "${target}": not found`), { code: 'FS_NOT_FOUND' })
    throw error
  }
}

/** 版本指纹：size + mtimeMs + 头尾采样哈希。 */
export function fingerprintOf(buffer, stat) {
  const head = buffer.subarray(0, SAMPLE)
  const tail = buffer.length > SAMPLE ? buffer.subarray(buffer.length - SAMPLE) : Buffer.alloc(0)
  const hash = crypto.createHash('sha256').update(head).update(tail).update(String(buffer.length)).digest('hex').slice(0, 16)
  // ctime 不能由普通写者回拨；把它纳入版本，能抓住“改中间 + 恢复 mtime”的改写。
  // 优先用 ctimeNs：Linux 上写入与 utimes 可能落在同一毫秒，ctimeMs 截断后看起来没变。
  const ctime = stat.ctimeNs !== undefined ? stat.ctimeNs.toString() : String(Math.trunc(stat.ctimeMs ?? 0))
  return `${buffer.length}:${Math.trunc(stat.mtimeMs)}:${ctime}:${hash}`
}

/** 只读一段；短读时返回实际读到的字节，不补零。 */
function readExact(fd, length, position) {
  if (length <= 0) return Buffer.alloc(0)
  const buffer = Buffer.alloc(length)
  let got = 0
  while (got < length) {
    const n = fs.readSync(fd, buffer, got, length - got, position + got)
    if (n === 0) break
    got += n
  }
  return got === length ? buffer : buffer.subarray(0, got)
}

/** 头尾采样指纹：不再为了 fingerprintOf 把整份文件读进内存。 */
function fingerprintFile(file, stat) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const head = readExact(fd, Math.min(SAMPLE, stat.size), 0)
    const tailLength = stat.size > SAMPLE ? Math.min(SAMPLE, stat.size - SAMPLE) : 0
    const tail = tailLength > 0 ? readExact(fd, tailLength, stat.size - tailLength) : Buffer.alloc(0)
    const hash = crypto.createHash('sha256').update(head).update(tail).update(String(stat.size)).digest('hex').slice(0, 16)
    const ctime = stat.ctimeNs !== undefined ? stat.ctimeNs.toString() : String(Math.trunc(stat.ctimeMs ?? 0))
    return `${stat.size}:${Math.trunc(stat.mtimeMs)}:${ctime}:${hash}`
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* 不覆盖原始错误 */ }
    }
  }
}

/**
 * 原子写：同目录临时文件 + fsync + rename（跨平台）。
 *
 * `mode` 非空时在 POSIX 上把临时文件 chmod 回原 mode；Windows 的 mode 只承载可写位，
 * 不做 chmod，避免把只读位带上临时文件后 rename 失败。ACL / xattr 不在本实现的保全范围。
 */
function writeAtomic(target, content, { mode = null, beforeRename = null } = {}) {
  const dir = path.dirname(target)
  const tmp = path.join(dir, `.${path.basename(target)}.aura-${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.tmp`)
  let fd
  try {
    fd = fs.openSync(tmp, 'wx', mode ?? 0o666)
    const buffer = Buffer.from(content)
    let offset = 0
    while (offset < buffer.length) {
      offset += fs.writeSync(fd, buffer, offset, buffer.length - offset)
    }
    // 数据落盘后再 rename；不支持的 FS 上 fsync 失败不应把一个已经写好的临时文件变成脏状态。
    try { fs.fsyncSync(fd) } catch { /* 尽力而为 */ }
    fs.closeSync(fd)
    fd = undefined
    // 最后一道 CAS：临时文件已经写好，rename 前再确认一次目标版本。
    // 它把“检查 → rename”的窗口压到最小；不是跨进程锁，但能挡住绝大多数并发写者。
    if (beforeRename !== null) beforeRename()
    if (mode !== null && path.sep !== '\\') fs.chmodSync(tmp, mode)
    fs.renameSync(tmp, target)
    // 目录项也尽量落盘；失败不影响已经完成的 rename。
    try {
      const dirFd = fs.openSync(dir, 'r')
      try { fs.fsyncSync(dirFd) } catch { /* 尽力而为 */ }
      fs.closeSync(dirFd)
    } catch { /* 尽力而为 */ }
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* 不覆盖原始错误 */ }
    }
    try { fs.rmSync(tmp, { force: true }) } catch { /* 清理失败不影响正确性 */ }
    throw error
  }
}

/**
 * 写目标解析：符号链接写穿到 realpath；硬链接拒绝。
 *
 * 为什么硬链接要拒绝：原子替换是“换一个 inode”，另一个硬链接仍指向旧 inode。
 * 这会让两个名字在写入后看到不同内容——对一个声称逐字节保真的编辑器来说，静默发生比拒绝更坏。
 */
function resolveWriteTarget(target) {
  let lst
  try {
    lst = fs.lstatSync(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return { file: target, exists: false, stat: null }
    throw error
  }
  if (lst.isSymbolicLink()) {
    let real
    try {
      real = fs.realpathSync.native(target)
    } catch {
      throw Object.assign(new Error(`cannot patch "${target}": dangling symbolic link`), { code: 'FS_SYMLINK_BROKEN' })
    }
    let st
    try {
      st = fs.statSync(real)
    } catch {
      throw Object.assign(new Error(`cannot patch "${target}": symbolic link target is not readable`), { code: 'FS_SYMLINK_BROKEN' })
    }
    if (!st.isFile()) throw Object.assign(new Error(`cannot patch "${target}": not a regular file`), { code: 'FS_NOT_REGULAR_FILE' })
    if (st.nlink > 1) {
      throw Object.assign(
        new Error(`cannot patch "${target}": file has ${st.nlink} hard links; atomic replace would break the other names`),
        { code: 'FS_HARDLINK_UNSUPPORTED', links: st.nlink },
      )
    }
    return { file: real, exists: true, stat: st }
  }
  if (!lst.isFile()) throw Object.assign(new Error(`cannot patch "${target}": not a regular file`), { code: 'FS_NOT_REGULAR_FILE' })
  if (lst.nlink > 1) {
    throw Object.assign(
      new Error(`cannot patch "${target}": file has ${lst.nlink} hard links; atomic replace would break the other names`),
      { code: 'FS_HARDLINK_UNSUPPORTED', links: lst.nlink },
    )
  }
  return { file: target, exists: true, stat: lst }
}

/**
 * 造一个提供方。
 * @param options.resolveRoot - 相对路径的解析根（默认进程 cwd）；对象里只留绝对路径，避免"被检查的路径"与"被写的路径"不是同一个。
 * @param options.maxTextBytes - 单次文本读/写的上限；默认读 `AURA_MAX_FILE_BYTES`，否则 512 MiB。
 */
export function createNodeFsProvider(options = {}) {
  const root = path.resolve(options.resolveRoot ?? process.cwd())
  const abs = (p) => (path.isAbsolute(p) ? path.normalize(p) : path.resolve(root, p))
  const configuredMax = options.maxTextBytes ?? Number(process.env.AURA_MAX_FILE_BYTES)
  const maxTextBytes = Number.isSafeInteger(configuredMax) && configuredMax > 0 ? configuredMax : DEFAULT_MAX_TEXT_BYTES

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
    return { type: 'file', version: fingerprintFile(file, st), size: st.size }
  }

  return {
    /** 工作区根（事务日志/锁的键；DSH 侧不使用本提供方）。 */
    root,
    /** 解析成绝对路径（CLI 的显示路径 → 真实路径的唯一次转换）。 */
    resolve: (p) => abs(p),
    stat,
    async readText(target) {
      const buffer = readOrThrow(abs(target), maxTextBytes)
      if (buffer.includes(0)) throw Object.assign(new Error(`cannot read "${target}": binary file`), { code: 'FS_NOT_TEXT' })
      // 与 dsh-fs-local 同形：fatal 解码 + 默认 ignoreBOM（第一个 BOM 被吃掉，其余 U+FEFF 留在文本里）
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    },
    async readByteRange(target, range) {
      const file = abs(target)
      let st
      try {
        st = fs.statSync(file)
      } catch (error) {
        if (error?.code === 'ENOENT') throw Object.assign(new Error(`cannot read "${target}": not found`), { code: 'FS_NOT_FOUND' })
        throw error
      }
      if (!st.isFile()) throw Object.assign(new Error(`cannot read "${target}": not a regular file`), { code: 'FS_NOT_REGULAR_FILE' })
      const offset = Math.min(st.size, Math.max(0, range?.offset ?? 0))
      const length = Math.min(Math.max(0, range?.length ?? 0), st.size - offset)
      if (length === 0) return new Uint8Array(0)
      let fd
      try {
        fd = fs.openSync(file, 'r')
        return new Uint8Array(readExact(fd, length, offset))
      } finally {
        if (fd !== undefined) {
          try { fs.closeSync(fd) } catch { /* 不覆盖原始错误 */ }
        }
      }
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
      const display = target
      const bytes = Buffer.byteLength(content)
      if (bytes > maxTextBytes) {
        throw Object.assign(
          new Error(`cannot patch "${display}": content is ${bytes} bytes, over the ${maxTextBytes}-byte text limit`),
          { code: 'FS_TOO_LARGE', size: bytes, limit: maxTextBytes },
        )
      }
      const resolved = resolveWriteTarget(abs(target))
      if (expected?.kind === 'createIfAbsent' && resolved.exists) {
        throw Object.assign(new Error(`cannot overwrite existing "${display}" without reading it first`), { code: 'FS_NOT_OBSERVED' })
      }
      if (expected?.kind === 'replaceIfVersion') {
        if (!resolved.exists) throw Object.assign(new Error(`cannot patch "${display}": file no longer exists`), { code: 'FS_STALE_VERSION' })
        const current = fingerprintFile(resolved.file, resolved.stat)
        if (current !== expected.version) {
          throw Object.assign(new Error(`cannot patch "${display}": file changed since it was read`), { code: 'FS_STALE_VERSION' })
        }
      }
      let beforeRename = null
      if (expected?.kind === 'replaceIfVersion') {
        beforeRename = () => {
          let st
          try { st = fs.statSync(resolved.file) } catch {
            throw Object.assign(new Error(`cannot patch "${display}": file no longer exists`), { code: 'FS_STALE_VERSION' })
          }
          if (fingerprintFile(resolved.file, st) !== expected.version) {
            throw Object.assign(new Error(`cannot patch "${display}": file changed while the patch was being written`), { code: 'FS_STALE_VERSION' })
          }
        }
      } else if (expected?.kind === 'createIfAbsent') {
        beforeRename = () => {
          if (fs.existsSync(resolved.file)) {
            throw Object.assign(new Error(`cannot overwrite existing "${display}" without reading it first`), { code: 'FS_NOT_OBSERVED' })
          }
        }
      }
      writeAtomic(resolved.file, content, {
        mode: resolved.exists ? resolved.stat.mode & 0o7777 : null,
        beforeRename,
      })
      const after = fs.statSync(resolved.file)
      return { version: fingerprintFile(resolved.file, after) }
    },
  }
}
