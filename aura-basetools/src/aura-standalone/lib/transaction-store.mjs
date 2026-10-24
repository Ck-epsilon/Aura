/**
 * transaction-store.mjs —— 写事务日志与**失败回滚**（内部实现，不再暴露 undo/transactions 工具）。
 *
 * 一次写事务在 `~/.aura/transactions/<workspace-key>/<id>/` 下留下：
 *   · `meta.json` —— 事务状态与每个文件的原始 mode/版本/备份名；
 *   · `originals/<n>.bin` —— 写前原始字节（逐字节，含 BOM/行尾）。
 *
 * 事务的生命周期：
 *   pending → committed（写成功；日志仅用于内部回滚，不再提供 undo）
 *           → rolled_back（写失败，已恢复原字节）
 *           → recovery_required（写失败且恢复也失败；meta 里留着可手工恢复的路径）
 *
 * 回滚前会比一次 `afterVersion`：文件在事务之后又被别人改过就拒绝覆盖。
 * 这不是安全边界；它只保证遵守本协议的进程不会静默覆盖并发写。
 */
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
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
    writtenBackup: entry.writtenBackup ?? null,
    rollbackBackup: entry.rollbackBackup ?? null,
  }
}

/**
 * 创建一个 pending 事务。此时还没有任何文件被记录；第一次 writeText 前才记原始字节。
 *
 * @param root - 工作区根
 * @param tool - 产生它的工具名（仅记录）
 */
function utf8Text(buf) {
  const text = buf.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(buf)) return null
  if (text.includes('\u0000')) return null
  return text
}

/**
 * 2-way fast path + `git merge-file` 的三方合并。
 *
 * 文字层合并，不碰二进制；一方没变时直接取另一方，避免为无关文件启动 git。
 * Git 不可用或冲突时返回 conflict，调用方拒绝提交，不写任何文件。
 */
function mergeText(baseBuf, oursBuf, theirsBuf, tmpDir) {
  const base = utf8Text(baseBuf)
  const ours = utf8Text(oursBuf)
  const theirs = utf8Text(theirsBuf)
  if (base === null || ours === null || theirs === null) return { ok: false, reason: 'not-utf8' }
  if (ours === base) return { ok: true, bytes: theirsBuf }
  if (theirs === base) return { ok: true, bytes: oursBuf }
  ensureDir(tmpDir)
  const stem = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  const baseFile = path.join(tmpDir, `${stem}.base`)
  const oursFile = path.join(tmpDir, `${stem}.ours`)
  const theirsFile = path.join(tmpDir, `${stem}.theirs`)
  try {
    fs.writeFileSync(baseFile, baseBuf)
    fs.writeFileSync(oursFile, oursBuf)
    fs.writeFileSync(theirsFile, theirsBuf)
    const res = spawnSync('git', ['merge-file', '-p', '--diff3', oursFile, baseFile, theirsFile], {
      encoding: null,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
    if (res.error?.code === 'ENOENT') return { ok: false, reason: 'git-unavailable' }
    if (res.status === 0) return { ok: true, bytes: Buffer.from(res.stdout) }
    if (res.status === 1) {
      return { ok: false, reason: 'overlap', conflictText: Buffer.from(res.stdout).toString('utf8').slice(0, 4000) }
    }
    return { ok: false, reason: 'git-error', exitCode: res.status, stderr: String(res.stderr ?? '').slice(0, 500) }
  } finally {
    for (const file of [baseFile, oursFile, theirsFile]) {
      try { fs.rmSync(file, { force: true }) } catch { /* 临时文件清不掉不影响判定 */ }
    }
  }
}

function makeTransaction(root, meta, dir) {
  const entries = new Map()
  for (let i = 0; i < meta.files.length; i += 1) {
    const saved = meta.files[i]
    entries.set(saved.path, { ...saved, metaIndex: i })
  }
  let closed = meta.status !== 'pending'

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
    id: meta.id,
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
        const writtenPath = path.join('written', `${entry.metaIndex}.bin`)
        writeBytesAtomic(path.join(dir, writtenPath), fs.readFileSync(entry.realPath), 0o600)
        entry.writtenBackup = writtenPath
        const summary = meta.files[entry.metaIndex]
        if (summary !== undefined) {
          summary.written = true
          summary.afterVersion = entry.afterVersion
          summary.writtenBackup = entry.writtenBackup
        }
        saveMeta(meta)
        return result
      }
      return proxy
    },
    /**
     * 提交前的并发合并：事务写过的文件若被外部改过，尝试把我们的 diff 三方合并到当前内容。
     * **先规划所有文件，全部可合并才写；任一冲突 ⇒ 零写入**，返回 conflicts 供调用方拒绝。
     */
    mergeOnCommit(provider) {
      const plans = []
      const conflicts = []
      for (const entry of entries.values()) {
        if (!entry.written) continue
        let current
        try { current = provider.stat(entry.path) } catch { current = undefined }
        if (entry.afterVersion !== null && current?.version === entry.afterVersion) continue
        if (!entry.writtenBackup || !entry.backup) {
          conflicts.push({ path: entry.path, reason: 'no-merge-base' })
          continue
        }
        let baseBytes
        let oursBytes
        let theirsBytes
        try {
          baseBytes = fs.readFileSync(path.join(dir, entry.backup))
          oursBytes = fs.readFileSync(path.join(dir, entry.writtenBackup))
          theirsBytes = fs.readFileSync(entry.realPath)
        } catch (error) {
          conflicts.push({ path: entry.path, reason: String(error?.message ?? error) })
          continue
        }
        const merged = mergeText(baseBytes, oursBytes, theirsBytes, path.join(dir, 'merge-tmp'))
        if (!merged.ok) {
          conflicts.push({ path: entry.path, reason: merged.reason, ...(merged.conflictText === undefined ? {} : { conflictText: merged.conflictText }), ...(merged.exitCode === undefined ? {} : { exitCode: merged.exitCode }) })
          continue
        }
        plans.push({ entry, theirsBytes, bytes: merged.bytes })
      }
      if (conflicts.length > 0) return { merged: [], conflicts }
      const merged = []
      for (const plan of plans) {
        const { entry } = plan
        const rollbackBackup = path.join('rollback', `${entry.metaIndex}.bin`)
        writeBytesAtomic(path.join(dir, rollbackBackup), plan.theirsBytes, 0o600)
        entry.rollbackBackup = rollbackBackup
        writeBytesAtomic(entry.realPath, plan.bytes, entry.mode ?? 0o600)
        const writtenBackup = path.join('written', `${entry.metaIndex}.bin`)
        writeBytesAtomic(path.join(dir, writtenBackup), plan.bytes, 0o600)
        entry.writtenBackup = writtenBackup
        entry.afterVersion = provider.stat(entry.path)?.version ?? null
        const summary = meta.files[entry.metaIndex]
        if (summary !== undefined) {
          summary.afterVersion = entry.afterVersion
          summary.writtenBackup = entry.writtenBackup
          summary.rollbackBackup = entry.rollbackBackup
        }
        merged.push({ path: entry.path, merged: true })
      }
      if (merged.length > 0) saveMeta(meta)
      return { merged, conflicts: [] }
    },
    /** 交叉调用提交前的乐观校验：事务写过的文件必须仍停在 afterVersion。 */
    assertFresh(provider) {
      const conflicts = []
      for (const entry of entries.values()) {
        if (!entry.written) continue
        let current
        try { current = provider.stat(entry.path) } catch { current = undefined }
        if (entry.afterVersion !== null && current?.version !== entry.afterVersion) {
          conflicts.push({ path: entry.path, expected: entry.afterVersion, actual: current?.version ?? null })
        }
      }
      return conflicts
    },
    commit() {
      if (closed) return
      meta.status = 'committed'
      meta.committedAt = new Date().toISOString()
      saveMeta(meta)
      closed = true
      prune(root)
    },
    summary() {
      return { id: meta.id, dir, status: meta.status, files: meta.files.length, written: meta.files.filter((f) => f.written).length }
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
            const backup = entry.rollbackBackup ?? entry.backup
            writeBytesAtomic(entry.realPath, fs.readFileSync(path.join(dir, backup)), entry.mode ?? 0o600)
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
  return makeTransaction(root, meta, dir)
}

/** 打开一个仍处于 pending 的跨调用事务。 */
export function openTransaction(root, id) {
  const dir = path.join(transactionsRoot(root), id)
  const meta = loadMeta(dir)
  if (meta.status !== 'pending') {
    throw Object.assign(new Error(`transaction ${id} is ${meta.status}, not open`), { code: 'TX_NOT_OPEN' })
  }
  return makeTransaction(root, meta, dir)
}

/** 读一个事务的元数据（状态/文件数）；不存在时抛 TX_NOT_FOUND。 */
export function getTransactionMeta(root, id) {
  try {
    return loadMeta(path.join(transactionsRoot(root), id))
  } catch {
    throw Object.assign(new Error(`transaction not found: ${id}`), { code: 'TX_NOT_FOUND' })
  }
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


function prune(root, keep = KEEP) {
  const metas = readAllMeta(root).filter((meta) => meta.status !== 'pending')
  for (const meta of metas.slice(keep)) {
    try { fs.rmSync(meta.dir, { recursive: true, force: true }) } catch { /* 旧日志删不掉不阻断新事务 */ }
  }
}

