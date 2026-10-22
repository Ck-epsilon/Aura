/**
 * observation-store.mjs —— 观测缓存的**落盘实现**（给独立 CLI 用）。
 *
 * 引擎默认用进程内 Map（`locator-lab/read-core.mjs` 的 `createMemoryStore`）。DSH 壳是长进程，
 * 够用；但独立 CLI **每次调用都是新进程**，上一轮的观测必须活到进程外——否则区域级新鲜度闸门
 * （"你读之后这块区域被人动过"，C13）在 CLI 上永远拿不到基准，等于没有。
 *
 * 落在 `~/.aura/observations.json`（macOS / Linux / Windows 同形，用 `os.homedir()`）。
 * 有界：最多 `LIMIT` 条；**超大文件不入缓存**（不为了缓存把内存/硬盘吃掉）——不存就是"没观测过"，
 * 闸门放行并在回执里带 `unverified_region`，语义与淘汰一致。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LIMIT = 32
const MAX_SOURCE = 262144 // 256 KiB：比这大的文件不进缓存

/** 缓存目录：默认 `~/.aura`；`AURA_CACHE_DIR` 可覆盖（测试、CI、或不想在 home 里落文件的人）。 */
export function observationsPath() {
  const dir = process.env.AURA_CACHE_DIR ?? path.join(os.homedir(), '.aura')
  return path.join(dir, 'observations.json')
}

export function createDiskStore(file = observationsPath()) {
  let data = { seen: [], latest: {} }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (raw !== null && typeof raw === 'object' && Array.isArray(raw.seen) && typeof raw.latest === 'object') data = raw
  } catch {
    // 没有缓存文件 / 内容坏了 ⇒ 当空缓存启动（"没观测过"是合法状态，不是错误）
  }

  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify(data))
      fs.renameSync(tmp, file)
    } catch {
      // 缓存写不进去**不能**让编辑失败：最坏结果只是下一轮少一次新鲜度判据
    }
  }
  const findEntry = (filePath, version) => data.seen.find((e) => e.key === `${filePath}@${version}`) ?? null

  return {
    remember(filePath, version, source, byteOrderMark = false) {
      if (typeof source !== 'string' || source.length > MAX_SOURCE) return
      const key = `${filePath}@${version}`
      data.seen = data.seen.filter((e) => e.key !== key)
      data.seen.push({ key, version, source, byteOrderMark: byteOrderMark === true })
      while (data.seen.length > LIMIT) data.seen.shift()
      data.latest[filePath] = key
      // 指针指向已被淘汰的条目时一并清掉：留着它只会让"最近观测"指向不存在的全文
      const alive = new Set(data.seen.map((e) => e.key))
      for (const [p, k] of Object.entries(data.latest)) if (!alive.has(k)) delete data.latest[p]
      save()
    },
    latest(filePath) {
      const key = data.latest[filePath]
      if (key === undefined) return null
      const entry = data.seen.find((e) => e.key === key)
      if (entry === undefined) return null
      return { version: entry.version, source: entry.source, byteOrderMark: entry.byteOrderMark === true }
    },
    entry(filePath, version) {
      const entry = findEntry(filePath, version)
      return entry === null ? null : { source: entry.source, byteOrderMark: entry.byteOrderMark === true }
    },
    recall(filePath, version) {
      return findEntry(filePath, version)?.source ?? null
    },
    /**
     * “路径@版本”在不在账本里。
     *
     * 为什么单要这个方法：`latest` 是**按路径**给最新一条，回答不了"现在磁盘上这份内容，
     * 是不是我们观测过的那一版"；而闸门要问的正是后者（T21）——
     * 不在账本里就说明这份内容是在我们最后一次观测之后由别人写下的，
     * 模型手上的行号来自更早的一版，且没有任何东西能替它发现这件事。
     */
    has(filePath, version) {
      return findEntry(filePath, version) !== null
    },
    count: () => data.seen.length,
  }
}
