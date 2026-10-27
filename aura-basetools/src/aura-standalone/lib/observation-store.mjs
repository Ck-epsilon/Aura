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
 *
 * ── 键必须是**同一个磁盘文件**的键，不是**同一个路径字符串**的键（C56）─────────────
 *
 * C54 把账本的路径同一性做进了引擎：纯词法归一（`.` 段／冗余分隔符／正反斜线／盘符大小写）
 * 加一个**会话内**的折叠别名索引。DSH 壳是长进程，那条路有效；**独立面每次调用都是新进程**，
 * 别名索引随进程消失 ⇒ 剩下的洞是：
 *
 *   进程1 `aura read  --file <tmp>/Beta.js`     （建立观测，写进 observations.json）
 *   第三方                   改掉**被寻址的那一行**
 *   进程2 `aura edit  --file <tmp>/beta.js`     （无 `expect`）
 *   ⇒ 改前实测：`{"ok":true,…, "unverified_region":true}` —— **静默覆盖**（点斜线写法在同实验里被拒）。
 *
 * `unverified_region: true` 是诚实的标注，但它的代价是那一行**没有闸门**：写侧的版本 CAS 在
 * 一次调用**内部**取 `stat`，调用之前发生的第三方写入对它是"当前状态"，不是冲突 —— 这个洞一旦
 * 被穿过，"模型手上的行号来自更早的一版"这件事没有任何东西能替它发现。
 *
 * ## 本文件怎么解：**归一到"盘上那一份"**，而且只认文件系统事实
 *
 * 引擎不能自己解：ENGINE 清单里的文件被两道闸禁止直接碰 `node:fs` 与平台分支
 * （`build/make-bundle.mjs` 的 `copyFile` 守卫 + `public-surface-test` …… 见 `read-core.mjs`
 * 顶部那段「为什么是词法 + 别名」），而"这个文件系统是不是大小写敏感"**正是平台事实**。
 * **独立面不受这条限制**（`make-bundle` 里 `aura-standalone/**` 走 host 档：允许 `node:fs`）。
 * 注意：本文件的守卫禁的是**平台分支**（平台字段那个字面量），写在注释里也照样红 ——
 * 所以这段注释与 `read-core.mjs` 里同义的注一样，只描述事实、不写那个字段。
 * 落盘键也正好在这里 —— 引擎每次记账/查询都要经过本文件，于是：
 *
 *   · {@link identityKey} = 这个路径**盘上是哪一份文件**：
 *     `fs.realpathSync.native` 一次同时解掉大小写、8.3 短名、`.`/`..` 段、冗余分隔符、
 *     符号链接与 junction（本机实测：`…\Beta.js` / `…\beta.js` / `…\BETA.JS` 三种写法都给出
 *     盘上的真名 `…\Beta.js`；`realpathSync` 的 JS 版**不折叠大小写**，所以必须用 `.native`）。
 *   · 五个账本入口（remember / latest / entry / recall / has）都先过它，
 *     调用点一处都不重复实现（{@link accountKeys} 是唯一那道缝）。
 *
 * ## 为什么这不是"猜"，也不会把两个真文件并成一个键
 *
 * 判据是**文件系统给的**，不是平台猜的：`realpath` 只在**两次调用解析到同一份盘上文件**时才相等。
 * 于是——
 *   · 大小写敏感目录里 `Beta.js` 与 `beta.js` 并存 ⇒ 两次 realpath 给出两个不同的真名
 *     ⇒ 两个键，各自的观测互不顶替（`observation-store-identity-test` 段B 用真·两个文件钉住，
 *     `stale-gate-test` 段O 是进程内那条同源判据）；
 *   · 文件**不存在**（`--create` 场景）⇒ realpath 抛错 ⇒ 退到**纯词法**的 `path.resolve`
 *     （只归一 `.` 段、冗余分隔符与盘符大小写，**不折叠文件名大小写**）。这个方向是安全的：
 *     不存在就没有"盘上那一份"可认，宁可认不出来（闸门如实带 `unverified_region`），也不许并键。
 *   · 查询侧只在**精确键查不到**时才走归一（`data.latest` 命中就返回）——常见形态下不额外真调
 *     一次 realpath；归一结果按进程缓存，一条命中的路径只调一次。
 *
 * ## 与引擎那一侧的边界（一处实现，不复制第二份）
 *
 * 引擎的 `ledgerPathKey` / `resolveLedgerKey` 仍然是**进程内**那一半（词法 + 会话别名），一行未动；
 * 本文件是**跨进程**那一半（盘上事实）。两者不重叠：引擎那半在引擎里，这半在宿主里，
 * 没有任何判据被写两遍。C54 的三段判据（`stale-gate-test` 段M/N/O）在改后一条不许少。
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

/** 归一结果的进程内缓存（同一个进程里同一条路径只真调一次 realpath）。 */
const IDENTITY_CACHE = new Map()
const IDENTITY_CACHE_LIMIT = 4096

/**
 * 这个路径**盘上是哪一份文件** —— 跨进程的路径同一性。
 *
 * 判据只有文件系统能给：`realpath` 解掉大小写、8.3 短名、`.`/`..`、冗余分隔符、符号链接与 junction。
 * 拿不到（文件不存在 / 权限 / 路径太怪）就退到纯词法 —— 那个方向**只会认不出来，不会并错**。
 *
 * @param filePath - 调用方给的路径（引擎传进来的是它自己词法归一后的键；非字符串原样返回）
 * @returns 账本键的**同一性**部分
 */
export function identityKey(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return filePath
  const cached = IDENTITY_CACHE.get(filePath)
  if (cached !== undefined) return cached
  let accounted = null
  try {
    accounted = fs.realpathSync.native(filePath)
  } catch {
    // 不存在 / 解析不了：没有"盘上那一份"可认 ⇒ 下面的纯词法兜底（不折叠文件名大小写）
    try {
      accounted = fs.realpathSync(filePath)
    } catch {
      accounted = path.resolve(filePath)
    }
  }
  IDENTITY_CACHE.set(filePath, accounted)
  while (IDENTITY_CACHE.size > IDENTITY_CACHE_LIMIT) IDENTITY_CACHE.delete(IDENTITY_CACHE.keys().next().value)
  return accounted
}

/**
 * 记账的键：`identityKey` 的别名改写（{@link createDiskStore} 里唯一那道缝）。
 *
 * 返回 `{ key, canonical }`：
 *   · `canonical` = **盘上那一份**的名字（`null` = 拿不到文件系统事实，别写别名表）；
 *   · `key`       = 这一条目**该存在哪个键下**（盘上那个写法优先，其次这一份已有的别名，最后原样）。
 *
 * 优先级为什么是这个顺序：盘上名字优先，是为了让不同拼写**收敛到同一个存放位置**（否则第一条
 * 在那里、第二条在这里，`data.latest` 会跟着改写的写法来回搬家）；一份文件已经有存放位置时不
 * 改搬（`Beta.js` 先被观测、之后才出现 `beta.js` 的写法 ⇒ 观测仍留在 `Beta.js` 键下）。
 */
function accountKeys(filePath, aliases) {
  const key = identityKey(filePath)
  if (key === filePath) return { key, canonical: null } // 已经是盘上的名字（或拿不到事实）
  const known = aliases.get(key)
  if (known !== undefined) return { key: known, canonical: key }
  return { key, canonical: key }
}

export function createDiskStore(file = observationsPath()) {
  let data = { seen: [], latest: {} }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (raw !== null && typeof raw === 'object' && Array.isArray(raw.seen) && typeof raw.latest === 'object') data = raw
  } catch {
    // 没有缓存文件 / 内容坏了 ⇒ 当空缓存启动（"没观测过"是合法状态，不是错误）
  }
  /**
   * 别名表：`路径写法 → 存放键`（**落盘**，与 seen / latest 同一次 save）。
   *
   * 为什么它必须落盘：跨进程那一半证据只能活在盘上。旧缓存文件没有这一栏 ⇒ 当空表起，
   * 之后的记账会把条目补上（不迁移、不猜）。
   */
  const aliases = new Map(Object.entries(typeof data.aliases === 'object' && data.aliases !== null ? data.aliases : {}))

  /** 清掉指向已不存在条目的别名：留着它只会让下一次查询解析到一个空键。 */
  const dropDanglingAliases = () => {
    const alive = new Set(data.seen.map((e) => e.key))
    for (const [spelling, target] of aliases) if (!alive.has(target)) aliases.delete(spelling)
  }

  /**
   * 落盘状态的新鲜度标记。多个 CLI/MCP 进程会同时读写同一个 `observations.json`；
   * 旧实现“启动时读一次、结束时整份写回”会让后写的进程覆盖先写的观测（并发读两个文件，
   * 最后只剩一条）——严格新鲜度随后对刚读过的文件报 `never-read`。
   */
  let lastStamp = null
  const fileStamp = () => {
    try {
      const st = fs.statSync(file)
      return `${st.mtimeMs}:${st.size}`
    } catch {
      return 'missing'
    }
  }
  lastStamp = fileStamp()

  /** 从盘上重新读一份合法缓存；坏文件/不存在都当空（“没观测过”是合法状态）。 */
  const loadDisk = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (raw !== null && typeof raw === 'object' && Array.isArray(raw.seen) && typeof raw.latest === 'object') return raw
    } catch {
      /* 落到 null */
    }
    return null
  }

  /** 把盘上条目并进内存：seen 按 key 去重（本地优先），latest/aliases 本地优先。 */
  const mergeDisk = (disk) => {
    if (disk === null) return
    const seen = new Map()
    for (const entry of disk.seen) seen.set(entry.key, entry)
    for (const entry of data.seen) seen.set(entry.key, entry)
    data.seen = [...seen.values()]
    data.latest = { ...disk.latest, ...data.latest }
    if (typeof disk.aliases === 'object' && disk.aliases !== null) {
      for (const [spelling, target] of Object.entries(disk.aliases)) {
        if (!aliases.has(spelling)) aliases.set(spelling, target)
      }
    }
  }

  /** 查询前刷新：长进程（MCP）也能看见别的进程刚写下的观测。 */
  const refresh = () => {
    const stamp = fileStamp()
    if (stamp === lastStamp) return
    mergeDisk(loadDisk())
    lastStamp = stamp
  }

  /**
   * 写锁：同一个缓存文件同时只允许一个进程做 read-merge-write。
   *
   * 锁是**旁路文件**（`observations.json.lock`，`wx` 原子创建），不引入平台分支；
   * 陈旧锁（进程崩溃留下）超过 `LOCK_STALE_MS` 后清掉。拿不到锁时仍做一次尽力而为的
   * 合并写入——缓存损坏/丢一条都不该让编辑失败，但正常情况下不会走到这条。
   */
  // Runner 上 6 个 Node 进程同时启动时，2s 不够；拿不到锁仍写入会互相覆盖（实测 CI 偶发）。
  // 锁只覆盖一次极小的 read-merge-write，15s 是安全上限，不是常态等待。
  const LOCK_STALE_MS = 30000
  const LOCK_WAIT_MS = 15000
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  const acquireLock = () => {
    const lock = `${file}.lock`
    const deadline = Date.now() + LOCK_WAIT_MS
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    } catch {
      return null
    }
    for (;;) {
      try {
        const fd = fs.openSync(lock, 'wx', 0o600)
        try { fs.writeFileSync(fd, String(process.pid)) } finally { fs.closeSync(fd) }
        return lock
      } catch (error) {
        // Windows 上另一个进程正在 rename/unlink 时，`wx` 可能给 EPERM/EACCES 而不是 EEXIST；
        // 这不是“没锁可用”，而是“锁正在换手”，继续等到 deadline。
        if (error?.code !== 'EEXIST' && error?.code !== 'EPERM' && error?.code !== 'EACCES') return null
        try {
          const st = fs.statSync(lock)
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            fs.unlinkSync(lock)
            continue
          }
        } catch {
          continue
        }
        if (Date.now() >= deadline) return null
        sleep(10)
      }
    }
  }
  const releaseLock = (lock) => {
    if (lock === null) return
    try { fs.unlinkSync(lock) } catch { /* 已被清理：没有需要撤销的状态 */ }
  }

  const save = () => {
    try {
      const dir = path.dirname(file)
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      // 目录已存在时 mkdir 的 mode 不生效；显式收紧一次（Windows 的 mode 语义不同，跳过）。
      if (path.sep !== '\\') {
        try { fs.chmodSync(dir, 0o700) } catch { /* 不是 owner / 文件系统不支持：不阻断缓存 */ }
      }
      const tmp = `${file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify({ ...data, aliases: Object.fromEntries(aliases) }), { mode: 0o600 })
      if (path.sep !== '\\') {
        try { fs.chmodSync(tmp, 0o600) } catch { /* 同上 */ }
      }
      // Windows：另一个进程正读 observations.json 时，rename 目标可能短暂 EPERM/EBUSY。
      // 不重试就会静默丢掉这一条观测（CI 的 6 并发实测 1/5 概率）。
      let renamed = false
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          fs.renameSync(tmp, file)
          renamed = true
          break
        } catch (error) {
          if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || attempt === 49) throw error
          sleep(20)
        }
      }
      if (!renamed) throw new Error('observation cache rename did not complete')
      lastStamp = fileStamp()
      if (path.sep !== '\\') {
        try { fs.chmodSync(file, 0o600) } catch { /* 同上 */ }
      }
    } catch {
      // 缓存写不进去**不能**让编辑失败：最坏结果只是下一轮少一次新鲜度判据
    }
  }
  const findEntry = (filePath, version) => data.seen.find((e) => e.key === `${filePath}@${version}`) ?? null

  return {
    remember(filePath, version, source, byteOrderMark = false) {
      if (typeof source !== 'string') return
      /**
       * 超过 `MAX_SOURCE` 的文件**仍然记令牌**，只是不存全文。
       *
       * 旧行为是整条丢掉，于是严格新鲜度（`requireObservedRevision`）对大文件永远返回
       * `never-read`——而它要求的恢复动作（先读一次）根本不可能成功。令牌足够回答
       * “这一版读过没有”；区域级闸门拿不到全文时如实退回 `basis:'none'`（见 `regionGate`）。
       */
      const omitted = source.length > MAX_SOURCE
      const lock = acquireLock()
      try {
        // 先合并盘上条目，再算键与写入：否则两个并发进程会各自用旧快照覆盖对方。
        mergeDisk(loadDisk())
        const accounted = accountKeys(filePath, aliases)
        if (accounted.canonical !== null) aliases.set(accounted.canonical, accounted.key)
        const key = `${accounted.key}@${version}`
        // 同一版本重记（同一份内容读了两次）不能把上一次的交付覆盖抹掉：写闸要看的就是它。
        const previous = data.seen.find((e) => e.key === key)
        data.seen = data.seen.filter((e) => e.key !== key)
        data.seen.push({
          key,
          version,
          source: omitted ? null : source,
          ...(omitted ? { source_omitted: true } : {}),
          byteOrderMark: byteOrderMark === true,
          delivered: Array.isArray(previous?.delivered) ? previous.delivered : [],
          at: Date.now(),
        })
        while (data.seen.length > LIMIT) data.seen.shift()
        data.latest[accounted.key] = key
        // 指针指向已被淘汰的条目时一并清掉：留着它只会让"最近观测"指向不存在的全文
        const alive = new Set(data.seen.map((e) => e.key))
        for (const [p, k] of Object.entries(data.latest)) if (!alive.has(k)) delete data.latest[p]
        dropDanglingAliases()
        save()
      } finally {
        releaseLock(lock)
      }
    },
    /**
     * 交付覆盖（1.0.2）：读侧渲染完之后补的那一步。条目不在就什么都不做——
     * 没有交付事实的后果是写闸拒绝，而不是造一条假观测。
     */
    deliver(filePath, version, labels) {
      if (!Array.isArray(labels)) return
      const lock = acquireLock()
      try {
        mergeDisk(loadDisk())
        const accounted = accountKeys(filePath, aliases)
        const wanted = new Set([`${accounted.key}@${version}`])
        if (accounted.canonical !== null) wanted.add(`${accounted.canonical}@${version}`)
        const entry = data.seen.find((e) => wanted.has(e.key))
        if (entry === undefined) return
        entry.delivered = labels
        save()
      } finally {
        releaseLock(lock)
      }
    },
    latest(filePath) {
      refresh()
      /**
       * 快路：**精确键**命中就直接返回（引擎传进来的通常是它自己登记过的那个键）。
       * 只有查不到时才用文件系统事实再问一次"这个写法是不是盘上那一份" —— 于是常见形态下
       * 这一步不额外真调 realpath（归一结果本身也按进程缓存）。
       */
      let stored = data.latest[filePath]
      if (stored === undefined) {
        const accounted = accountKeys(filePath, aliases)
        stored = data.latest[accounted.key]
        if (stored === undefined && accounted.canonical !== null && accounted.key !== accounted.canonical) {
          stored = data.latest[accounted.canonical]
        }
      }
      if (stored === undefined) return null
      const entry = data.seen.find((e) => e.key === stored)
      if (entry === undefined) return null
      return {
        version: entry.version,
        source: entry.source,
        byteOrderMark: entry.byteOrderMark === true,
        source_omitted: entry.source_omitted === true,
        delivered: Array.isArray(entry.delivered) ? entry.delivered : [],
      }
    },
    entry(filePath, version) {
      refresh()
      const direct = findEntry(filePath, version)
      if (direct !== null) {
        return { source: direct.source, byteOrderMark: direct.byteOrderMark === true, source_omitted: direct.source_omitted === true, delivered: Array.isArray(direct.delivered) ? direct.delivered : [] }
      }
      const accounted = accountKeys(filePath, aliases)
      const entry = findEntry(accounted.key, version) ?? (accounted.canonical === null ? null : findEntry(accounted.canonical, version))
      return entry === null
        ? null
        : { source: entry.source, byteOrderMark: entry.byteOrderMark === true, source_omitted: entry.source_omitted === true, delivered: Array.isArray(entry.delivered) ? entry.delivered : [] }
    },
    recall(filePath, version) {
      refresh()
      const direct = findEntry(filePath, version)
      if (direct !== null) return direct.source
      const accounted = accountKeys(filePath, aliases)
      return findEntry(accounted.key, version)?.source ?? (accounted.canonical === null ? null : findEntry(accounted.canonical, version)?.source) ?? null
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
      refresh()
      if (findEntry(filePath, version) !== null) return true
      const accounted = accountKeys(filePath, aliases)
      return findEntry(accounted.key, version) !== null || (accounted.canonical !== null && findEntry(accounted.canonical, version) !== null)
    },
    count: () => {
      refresh()
      return data.seen.length
    },
  }
}
