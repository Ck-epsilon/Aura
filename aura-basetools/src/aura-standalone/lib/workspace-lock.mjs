/**
 * workspace-lock.mjs —— 同一工作区的写事务互斥锁（best effort，跨进程）。
 *
 * 这不是文件系统 CAS，也不是安全边界；它只保证**遵守本协议的 Aura 进程**不会同时写同一个工作区。
 * 锁文件放在 `~/.aura/locks/<workspace-key>.lock`（`AURA_CACHE_DIR` 可覆盖），内容只有
 * `{ pid, createdAt, root }`。
 *
 * 语义：
 *   · `wx` 创建锁文件；已存在时等持有者结束或超时；
 *   · 持有者进程已不存在、或锁龄超过 staleMs ⇒ 视为陈旧锁并删除；
 *   · `AURA_NO_LOCK=1` 完全跳过（测试/单进程场景）；
 *   · `AURA_LOCK_TIMEOUT_MS` / `AURA_LOCK_STALE_MS` 可调。
 *
 * 锁不防止不遵守协议的外部编辑器；删除/恢复仍由事务日志和版本校验兜底。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_STALE_MS = 10 * 60 * 1000
/** 空锁（已创建、PID 还没写进去）的宽限：短于这个年龄不判陈旧，避免抢走刚持有的锁。 */
const EMPTY_LOCK_GRACE_MS = 2000
const RETRY_MS = 50

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function cacheRoot() {
  return process.env.AURA_CACHE_DIR ?? path.join(os.homedir(), '.aura')
}

function workspacePath(root) {
  const resolved = path.resolve(root)
  try {
    return fs.realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

export function workspaceKey(root) {
  return crypto.createHash('sha256').update(workspacePath(root)).digest('hex').slice(0, 16)
}

function lockPath(root) {
  return path.join(cacheRoot(), 'locks', `${workspaceKey(root)}.lock`)
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 表示进程存在但当前用户无权发信号；按存活处理更安全。
    return error?.code === 'EPERM'
  }
}

/**
 * 在 workspace 锁内执行一次写事务。
 *
 * @param root - 工作区根（provider.root）
 * @param fn - async () => T
 * @param options.timeoutMs - 等锁上限
 * @param options.staleMs - 锁龄超过它即视为陈旧
 * @returns fn 的结果
 */
export async function withWorkspaceLock(root, fn, options = {}) {
  if (process.env.AURA_NO_LOCK === '1') return fn()
  const timeoutMs = Number(options.timeoutMs ?? process.env.AURA_LOCK_TIMEOUT_MS) > 0
    ? Number(options.timeoutMs ?? process.env.AURA_LOCK_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS
  const staleMs = Number(options.staleMs ?? process.env.AURA_LOCK_STALE_MS) > 0
    ? Number(options.staleMs ?? process.env.AURA_LOCK_STALE_MS)
    : DEFAULT_STALE_MS
  const file = lockPath(root)
  const started = Date.now()
  let held = false

  while (!held) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const fd = fs.openSync(file, 'wx', 0o600)
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now(), root: workspacePath(root) }))
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      held = true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const holder = readLock(file)
      /**
       * **空锁不是陈旧锁**：`open(..., 'wx')` 与写入 PID 之间有窗口，另一个进程此时读到的
       * 是空文件（`readLock` 返回 null）。旧判据把 `holder === null` 直接当陈旧 ⇒ 会删掉
       * 一个刚被持有、还没写完元数据的锁，两个进程同时进入临界区。实测：4 个进程并发改
       * 同一文件的不同行，偶发 1 个进程的陈旧闸门报错、两行修改丢失。
       * 现在空锁给 2 秒宽限：只有 mtime 超过宽限（或超过 staleMs）才回收。
       */
      let stale
      if (holder === null) {
        let mtime = 0
        try {
          mtime = fs.statSync(file).mtimeMs
        } catch {
          continue // 锁刚被释放，下一轮重试
        }
        stale = Date.now() - mtime > Math.min(staleMs, EMPTY_LOCK_GRACE_MS)
      } else {
        const age = Date.now() - Number(holder.createdAt ?? 0)
        stale = age > staleMs || !processAlive(holder.pid)
      }
      if (stale) {
        try { fs.rmSync(file, { force: true }) } catch { /* 下一轮再试 */ }
        continue
      }
      if (Date.now() - started > timeoutMs) {
        const holderLabel = holder === null ? 'an empty lock (pid not written yet)' : `pid ${holder.pid}`
        throw Object.assign(new Error(`workspace is locked by ${holderLabel}`), {
          code: 'WORKSPACE_LOCKED',
          holder: holder ?? null,
        })
      }
      await sleep(RETRY_MS)
    }
  }

  try {
    return await fn()
  } finally {
    try {
      const holder = readLock(file)
      if (holder?.pid === process.pid) fs.rmSync(file, { force: true })
    } catch { /* 锁释放失败不覆盖本次结果；陈旧锁会按 staleMs 回收 */ }
  }
}

export function lockFileFor(root) {
  return lockPath(root)
}
