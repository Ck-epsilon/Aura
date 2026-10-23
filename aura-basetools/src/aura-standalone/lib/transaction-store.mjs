/**
 * transaction-store.mjs —— 写事务日志、回滚与 undo。
 *
 * 一次写事务在 `~/.aura/transactions/<workspace-key>/<id>/` 下留下：
 *   · `meta.json` —— 事务状态与每个文件的原始 mode/版本/备份名；
 *   · `originals/<n>.bin` —— 写前原始字节（逐字节，含 BOM/行尾）。
 *
 * 事务的生命周期：
 *   pending → committed（写成功，可 undo）
 *           → rolled_back（写失败，已恢复原字节）
 *           → recovery_required（写失败且恢复也失败；meta 里留着可手工恢复的路径）
 *   committed → undone（undo 成功）
 *
 * 回滚/undo 前会比一次 `afterVersion`：文件在事务之后又被别人改过就拒绝覆盖（`--force` 才强制）。
 * 这不是安全边界；它只保证遵守本协议的进程不会静默覆盖并发写。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const KEEP = 20

function cacheRoot() {
  return process.env.AURA_CACHE_DIR ?? path.join(os.homedir(), '.aura')
}

function fnvWorkspace(root) {
  return crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16)
}

export function transactionsRoot(root) {
  return path.join(cacheRoot(), 'transactions', fnvWorkspace(root))
}

function transactionId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch { /* Windows / 非 owner */ }
}

function writeTextAtomic(file, text, mode = 0o600) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`
  try {
    fs.writeFileSync(tmp, text, { mode })
    try { fs.chmodSync(tmp, mode) } catch { /* Windows */ }
    fs.renameSync(tmp, file)
    try { fs.chmodSync(file, mode) } catch { /* Windows */ }
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 清理失败不影响正确性 */ }
    throw error
  }
}

function writeBytesAtomic(file, bytes, mode = 0o600) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`
  let fd
  try {
    fd = fs.openSync(tmp, 'wx', mode)
    let offset = 0
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset)
    try { fs.fsyncSync(fd) } catch { /* 尽力而为 */ }
    fs.closeSync(fd)
    fd = undefined
    try { fs.chmodSync(tmp, mode) } catch { /* Windows */ }
    fs.renameSync(tmp, file)
    try { fs.chmodSync(file, mode) } catch { /* Windows */ }
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* 不覆盖原始错误 */ }
    }
    try { fs.rmSync(tmp, { force: true }) } catch { /* 清理失败不影响正确性 */ }
    throw error
  }
}

function normalizeTarget(provider, target) {
  const resolved = typeof provider.resolve === 'function' ? provider.resolve(target) : target
  return path.resolve(resolved)
}

function realPathOf(display) {
  try {
    return fs.realpathSync.native(display)
  } catch {
    return display
  }
}

function loadMeta(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
}

function saveMeta(meta) {
  writeTextAtomic(path.join(meta.dir, 'meta.json'), JSON.stringify(meta, null, 1))
}

function fileSummary(entry) {
  return {
    path: entry.path,
    realPath: entry.realPath,
    existed: entry.existed,
    mode: entry.mode,
    written: entry.written,
    afterVersion: entry.afterVersion ?? null,
    backup: entry.backup ?? null,
  }
}

/**
 * 创建一个 pending 事务。此时还没有任何文件被记录；第一次 writeText 前才记原始字节。
 *
 * @param root - 工作区根
 * @param tool - 产生它的工具名（仅记录）
 */
export function createTransaction(root, tool = 'aura_basetools_edit') {
  const id = transactionId()
  const dir = path.join(transactionsRoot(root), id)
  ensureDir(dir)
  const meta = {
    id,
    tool,
    root: path.resolve(root),
    createdAt: new Date().toISOString(),
    status: 'pending',
    files: [],
    dir,
  }
  saveMeta(meta)
  const entries = new Map()
  let closed = false

  const entryKey = (provider, target) => normalizeTarget(provider, target)

  const record = async (provider, target) => {
    const key = entryKey(provider, target)
    if (entries.has(key)) return entries.get(key)
    const display = key
    let lst
    try {
      lst = fs.lstatSync(display)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const entry = { path: display, realPath: display, existed: false, mode: null, backup: null, written: false }
      entry.metaIndex = meta.files.length
      entries.set(key, entry)
      meta.files.push(fileSummary(entry))
      saveMeta(meta)
      return entry
    }
    const realPath = lst.isSymbolicLink() ? realPathOf(display) : display
    const st = fs.statSync(realPath)
    if (!st.isFile()) throw Object.assign(new Error(`cannot journal "${display}": not a regular file`), { code: 'FS_NOT_REGULAR_FILE' })
    const index = entries.size
    const backup = path.join('originals', `${index}.bin`)
    writeBytesAtomic(path.join(dir, backup), fs.readFileSync(realPath), 0o600)
    const entry = {
      path: display,
      realPath,
      existed: true,
      mode: st.mode & 0o7777,
      backup,
      written: false,
    }
    entry.metaIndex = meta.files.length
    entries.set(key, entry)
    meta.files.push(fileSummary(entry))
    saveMeta(meta)
    return entry
  }

  const tx = {
    id,
    dir,
    meta,
    entries,
    /** 把 provider 的 writeText 包一层：第一次写前记录原始字节，写后记录 afterVersion。 */
    proxy(provider) {
      const proxy = Object.create(provider)
      proxy.writeText = async (target, content, expected) => {
        const entry = await record(provider, target)
        const result = await provider.writeText(target, content, expected)
        entry.written = true
        entry.afterVersion = result?.version ?? null
        const summary = meta.files[entry.metaIndex]
        if (summary !== undefined) {
          summary.written = true
          summary.afterVersion = entry.afterVersion
        }
        saveMeta(meta)
        return result
      }
      return proxy
    },
    commit() {
      if (closed) return
      meta.status = 'committed'
      meta.committedAt = new Date().toISOString()
      // 只有 meta 真正落盘后才 closed；否则调用方还能 rollback 已经写出的文件。
      saveMeta(meta)
      closed = true
      prune(root)
    },
    summary() {
      return { id, dir, status: meta.status, files: meta.files.length }
    },
    async rollback(provider, options = {}) {
      if (closed) return { status: meta.status, restored: 0, conflicts: [] }
      closed = true
      const force = options.force === true
      const conflicts = []
      let restored = 0
      for (const entry of entries.values()) {
        if (!entry.written) continue
        let current
        try { current = provider.stat(entry.path) } catch { current = undefined }
        if (!force && entry.afterVersion !== null && current?.version !== entry.afterVersion) {
          conflicts.push({ path: entry.path, reason: 'changed after this transaction', expected: entry.afterVersion, actual: current?.version ?? null })
          continue
        }
        try {
          if (entry.existed) {
            writeBytesAtomic(entry.realPath, fs.readFileSync(path.join(dir, entry.backup)), entry.mode ?? 0o600)
          } else {
            fs.rmSync(entry.realPath, { force: true })
          }
          restored += 1
        } catch (error) {
          conflicts.push({ path: entry.path, reason: String(error?.message ?? error) })
        }
      }
      meta.status = conflicts.length === 0 ? 'rolled_back' : 'recovery_required'
      meta.rolledBackAt = new Date().toISOString()
      meta.conflicts = conflicts
      saveMeta(meta)
      return { status: meta.status, restored, conflicts }
    },
  }
  return tx
}

function readAllMeta(root) {
  const dir = transactionsRoot(root)
  let names
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of names) {
    if (!entry.isDirectory()) continue
    try {
      out.push(loadMeta(path.join(dir, entry.name)))
    } catch { /* 坏事务不拖垮列表 */ }
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

/** 取最近一条可 undo 的 committed 事务。 */
export function latestCommitted(root) {
  return readAllMeta(root).find((meta) => meta.status === 'committed') ?? null
}

export function listTransactions(root) {
  return readAllMeta(root).map((meta) => ({
    id: meta.id,
    tool: meta.tool,
    createdAt: meta.createdAt,
    status: meta.status,
    files: Array.isArray(meta.files) ? meta.files.length : 0,
    dir: meta.dir,
  }))
}

function prune(root, keep = KEEP) {
  const metas = readAllMeta(root).filter((meta) => meta.status !== 'pending')
  for (const meta of metas.slice(keep)) {
    try { fs.rmSync(meta.dir, { recursive: true, force: true }) } catch { /* 旧日志删不掉不阻断新事务 */ }
  }
}

/**
 * 撤销一条 committed 事务。
 *
 * 任何文件在当前时间点的版本与事务提交后的版本不一致 ⇒ 默认拒绝，避免覆盖后续编辑；
 * `force: true` 才强制恢复旧字节。
 */
export async function undoTransaction(root, provider, options = {}) {
  const metas = readAllMeta(root)
  const meta = options.id ? metas.find((m) => m.id === options.id) : metas.find((m) => m.status === 'committed')
  if (meta === undefined) {
    throw Object.assign(new Error(options.id ? `transaction not found: ${options.id}` : 'no committed transaction to undo'), {
      code: 'TRANSACTION_NOT_FOUND',
    })
  }
  if (meta.status !== 'committed') {
    throw Object.assign(new Error(`transaction ${meta.id} is ${meta.status}, not committed`), {
      code: 'TRANSACTION_NOT_UNDOABLE',
      status: meta.status,
    })
  }
  const force = options.force === true
  /**
   * 先做一次**只读预检**：任何文件在事务后又被改过 ⇒ 整个 undo 拒绝。
   * 旧顺序会先把还能恢复的文件写回去，再发现某个文件冲突——那就是一次部分 undo；
   * 对一个以“不会静默改错”为卖点的工具，部分恢复比拒绝更坏。
   */
  const plans = []
  const conflicts = []
  for (const entry of meta.files) {
    if (!entry.written) continue
    let current
    try { current = provider.stat(entry.path) } catch { current = undefined }
    if (!force && entry.afterVersion !== null && current?.version !== entry.afterVersion) {
      conflicts.push({ path: entry.path, reason: 'changed since this transaction', expected: entry.afterVersion, actual: current?.version ?? null })
    }
    plans.push(entry)
  }
  if (conflicts.length > 0) {
    throw Object.assign(new Error(`transaction ${meta.id} cannot be undone: ${conflicts.length} file(s) changed after it`), {
      code: 'TRANSACTION_STALE',
      transaction: meta.id,
      conflicts,
    })
  }
  let restored = 0
  for (const entry of plans) {
    try {
      if (entry.existed) {
        writeBytesAtomic(entry.realPath, fs.readFileSync(path.join(meta.dir, entry.backup)), entry.mode ?? 0o600)
      } else {
        fs.rmSync(entry.realPath, { force: true })
      }
      restored += 1
    } catch (error) {
      conflicts.push({ path: entry.path, reason: String(error?.message ?? error) })
    }
  }
  meta.status = conflicts.length === 0 ? 'undone' : 'recovery_required'
  meta.undoneAt = new Date().toISOString()
  meta.undoConflicts = conflicts
  saveMeta(meta)
  return { transaction: meta.id, status: meta.status, restored, conflicts, dir: meta.dir }
}
