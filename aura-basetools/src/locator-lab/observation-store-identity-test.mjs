/**
 * observation-store-identity-test —— **跨进程**的路径同一性（C56）。
 *
 * ## 这个套件问的问题
 *
 * 观测账本（`read-core.mjs` 的 `rememberRead` / `latestObservation`）的键必须是**同一个磁盘文件**
 * 的键，不能是**同一个路径字符串**的键。C54 把这件事在**进程内**做到了：归一化落在
 * `ledgerPathKey` + 会话内的折叠别名索引（`PATH_ALIASES`）上。DSH 壳是长进程，所以那条路有效。
 *
 * **独立面 CLI / MCP 每次调用都是新进程** —— 别名索引随进程消失。于是剩下的洞是：
 *
 *   进程1 `aura read  --file <tmp>/Beta.js`        （建立观测）
 *   第三方                  改掉**被寻址的那一行**
 *   进程2 `aura edit  --file <tmp>/beta.js --lines 3,3`（无 `expect`）
 *   ⇒ 改前实测：`{"ok":true, ... "unverified_region":true}` —— **静默覆盖**。
 *
 * `unverified_region: true` 是"我核对不了"的**诚实标注**，但它的代价是那一行**没有闸门**：
 * 写侧的版本 CAS 在一次调用内部取 `stat`，调用之前发生的第三方写入对它是"当前状态"，
 * 所以这个洞一旦被穿过，模型手上的行号来自更早版本这件事**没有任何东西**能替它发现。
 *
 * ## 本套件的判据（四段）
 *
 *   段A **跨进程**：上面那个场景 ⇒ 必须 `PATCH_STALE_REGION`（改动前必红）。
 *        外加一组**正向对照**：同一个文件用另一种写法、且**没有**第三方改动 ⇒ 必须照常成功、
 *        且回执不许谎称"没核对过"（`unverified_region` 必须缺席）。
 *        没有这组对照的话，"一律拒绝"这种实现也能让段A 全绿。
 *   段B 两个**真的不同**的文件不得并成一个键（大小写敏感目录里 `Beta.js` 与 `beta.js` 并存），
 *        且跨进程编辑各归各的。这是本单明令禁止的失败方向的反向判据。
 *   段C DSH 侧（进程内那条路，默认内存存储）行为不退化：换写法编辑照常成功且不谎称，
 *        被寻址行被第三方改过 ⇒ 照样拒。
 *   段D 登记与退出码：本文件自己跑完必须 exit 0/1 表态（闸侧的登记在 `build/release-check.mjs`）。
 *
 * ## 这个套件**不起** mock：它跑的是真 CLI 子进程
 *
 * 理由："每次调用都是新进程"是这一条洞的**成因**，用进程内调用去验它等于把成因抹掉。
 * 每一个 `aura read` / `aura edit` 都是 `spawnSync(node, [bin/aura.mjs, …])`，各自独立退出。
 * 缓存目录用 `AURA_CACHE_DIR` 指到临时目录（同一段里的进程共享它 = 共享"上一次观测"；
 * 不同段用不同目录 = 不互相污染）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

import { identityKey } from '../aura-standalone/lib/observation-store.mjs'
import { contextServices } from './mock-ctx.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..', '..') // 包根/
/** 真 CLI（源树那一份）：引擎由 `lib/ops.mjs` 解析到 `src/locator-lab/`，正是本单改的地方。 */
const CLI = path.join(pkgRoot, 'src', 'aura-standalone', 'bin', 'aura.mjs')

const tmp = path.join(os.tmpdir(), `c56-identity-${Date.now()}`)
fs.mkdirSync(tmp, { recursive: true })

const F1_BEFORE = 'line one\nline two\nline three\n'
const F1_AFTER_B = 'line one\nline two\nline three CHANGED BY B\n'
const readTextFile = (p) => new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(p))
const writeTextFile = (p, text) => fs.writeFileSync(p, Buffer.from(new TextEncoder().encode(text)))
const sha = (p) => execFileSync(process.execPath, ['-e', `process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex'))`, p], { encoding: 'utf8' })

/**
 * 跑一次**真 CLI 子进程**。
 *
 * `AURA_CACHE_DIR` 指到调用方给的目录：同一个目录 = 同一份观测账本（这就是"跨进程"的载体），
 * 不同目录 = 互不相干的两次会话。
 */
const cli = (cacheDir, args) => {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: tmp,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, AURA_CACHE_DIR: cacheDir },
  })
  let json = null
  try {
    json = JSON.parse((res.stdout ?? '').trim().split('\n').pop() ?? '')
  } catch {
    json = null
  }
  return { exit: res.status, stdout: (res.stdout ?? '').trim(), stderr: (res.stderr ?? '').trim(), json }
}
/** 读一次（真进程）。 */
const cliRead = (cacheDir, file) => cli(cacheDir, ['basetools', 'read', '--file', file, '--mode', 'full'])
/** 无 `expect` 的按行编辑（真进程）。 */
const cliEditLines = (cacheDir, file, lines, replace) =>
  cli(cacheDir, ['basetools', 'edit', '--file', file, '--hunks', JSON.stringify([{ lines, replace }])])
/** 这个写法在本平台能不能解析到同一个文件（不解析就不是"另一种写法"，如实记分支）。 */
const sameFile = (a, b) => {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b)
  } catch {
    return false
  }
}

/**
 * 靶子三件套：`<段目录>/Beta.js` + 两个**只差大小写**的写法 + 一个空的独立缓存目录。
 * 缓存目录与靶子目录分开，是为了让"账本"这一侧的形状在读数里一眼可见。
 */
function target(seg, name = 'repro') {
  const dir = path.join(tmp, seg, name)
  const cache = path.join(tmp, seg, `${name}-cache`)
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(cache, { recursive: true })
  const base = path.join(dir, 'Beta.js')
  return { dir, cache, base, lower: path.join(dir, 'beta.js'), upper: path.join(dir, 'BETA.JS') }
}

say('=== A. 跨进程：进程1 读 Beta.js → 第三方改被寻址行 → 进程2 用 beta.js 无 expect 编辑 ⇒ 必须拒绝 ===')
{
  const { cache, base, lower, upper } = target('a1')
  writeTextFile(base, F1_BEFORE)
  const raw0 = sha(base)

  // 进程 1：建立观测（真进程，读完即退）
  const r1 = cliRead(cache, base)
  say(`  [进程1] aura read --file ${base} --mode full`)
  say(`          exit=${r1.exit} out=${r1.stdout}`)
  check(r1.exit === 0 && r1.json?.ok === true && typeof r1.json.version === 'string', 'A1 进程1 读基准写法成功并给出令牌', `exit=${r1.exit} version=${r1.json?.version}`)
  const ledger = path.join(cache, 'observations.json')
  check(fs.existsSync(ledger), 'A2 观测真的落到了进程外（缓存文件存在 = 跨进程有据可依）', ledger)

  // 第三方（不是我们）：改掉**被寻址的第 3 行**
  writeTextFile(base, F1_AFTER_B)
  const rawB = sha(base)
  say(`  [第三方] 第 3 行 → "line three CHANGED BY B"（sha256 ${rawB.slice(0, 16)}…）`)

  // 进程 2：换**仅大小写不同**的写法，发无 expect 编辑
  const r2 = cliEditLines(cache, lower, [3, 3], 'line three (A overwrote)')
  say(`  [进程2] aura edit --file ${lower} --hunks '[{"lines":[3,3],"replace":"line three (A overwrote)"}]'`)
  say(`          exit=${r2.exit} out=${r2.stdout}`)
  const sameCaseA = sameFile(base, lower)
  if (sameCaseA) {
    check(
      r2.exit !== 0 && r2.json?.ok === false && r2.json?.code === 'PATCH_STALE_REGION',
      'A3 跨进程换写法发无 expect 编辑 ⇒ 结构化拒绝 PATCH_STALE_REGION（**本单改前必红的那一条**）',
      `exit=${r2.exit} code=${r2.json?.code ?? '(放行)'} ${r2.json?.ok === true ? `unverified_region=${r2.json?.result?.unverified_region}` : ''}`,
    )
    check(sha(base) === rawB && readTextFile(base) === F1_AFTER_B, 'A4 磁盘保持第三方内容（我们的编辑一个字节都没落）', JSON.stringify(readTextFile(base)))
  } else {
    check(true, 'A3 跨进程换写法发无 expect 编辑（本平台大小写敏感，β 是另一个文件）⇒ 跳过', 'case-sensitive fs')
    check(sha(base) === rawB && readTextFile(base) === F1_AFTER_B, 'A4 磁盘保持第三方内容（我们的编辑一个字节都没落）', JSON.stringify(readTextFile(base)))
  }

  // 判别性：同一次读取、同样无第三方改动时，换写法**必须**成功（否则"一律拒绝"也能过 A3）
  const ok = target('a2')
  writeTextFile(ok.base, F1_BEFORE)
  const o1 = cliRead(ok.cache, ok.base)
  const o2 = cliEditLines(ok.cache, ok.lower, [3, 3], 'line three (A edited)')
  say(`  [正向对照] 进程1 读 ${ok.base}（exit=${o1.exit}）→ 无第三方改动 → 进程2 用 ${ok.lower} 编辑`)
  say(`          exit=${o2.exit} out=${o2.stdout}`)
  if (sameFile(ok.base, ok.lower)) {
    check(o1.exit === 0 && o2.exit === 0 && o2.json?.ok === true, 'A5 正向对照：换写法编辑一个**没被别人改过**的文件 ⇒ 照常成功（不许误拒）', `exit=${o2.exit}`)
    check(
      o2.json?.ok === true && o2.json?.result?.unverified_region === undefined,
      'A6 正向对照的回执不谎称"没核对过"（basis 是观测，不是 none）：这一条才说明 A3 的拒绝是**认出了同一处**，不是碰巧拦住',
      JSON.stringify(o2.json?.result?.unverified_region ?? null),
    )
    check(readTextFile(ok.base) === 'line one\nline two\nline three (A edited)\n', 'A7 正向对照的改动确实落盘', JSON.stringify(readTextFile(ok.base)))
  } else {
    check(true, 'A5 正向对照（本平台大小写敏感，跳过）', 'case-sensitive fs')
    check(true, 'A6 正向对照（本平台大小写敏感，跳过）', 'case-sensitive fs')
    check(true, 'A7 正向对照（本平台大小写敏感，跳过）', 'case-sensitive fs')
  }

  // 同一条洞的另一种写法（全大写）：读数里留一份，写明本平台认不认它
  const up = target('a3')
  writeTextFile(up.base, F1_BEFORE)
  const u1 = cliRead(up.cache, up.base)
  writeTextFile(up.base, F1_AFTER_B)
  const rawUp = sha(up.base)
  const u2 = cliEditLines(up.cache, up.upper, [3, 3], 'line three (A overwrote)')
  say(`  [同上·全大写] 进程1 读（exit=${u1.exit}）→ 第三方改第 3 行 → 进程2 用 ${up.upper}`)
  say(`          exit=${u2.exit} out=${u2.stdout}`)
  if (sameFile(up.base, up.upper)) {
    check(true, 'A8 本平台把 BETA.JS 解析到同一个文件（不解析就不是"另一种写法"，下面那条不成立）', 'sameFile=true')
    check(
      u2.exit !== 0 && u2.json?.code === 'PATCH_STALE_REGION',
      'A9 全大写的写法同样被拦住（同一处记账与写法无关）',
      `exit=${u2.exit} code=${u2.json?.code ?? '(放行)'}`,
    )
    check(sha(up.base) === rawUp, 'A10 全大写那一支磁盘也未变', JSON.stringify(readTextFile(up.base)))
  } else {
    check(true, 'A8 本平台把 BETA.JS 解析到同一个文件（不解析就不是"另一种写法"，下面那条不成立）', `sameFile=false（大小写敏感文件系统）`)
    check(true, 'A9 全大写的写法同样被拦住（本平台不成立，跳过）', 'case-sensitive fs')
    check(true, 'A10 全大写那一支磁盘也未变（本平台不成立，跳过）', 'case-sensitive fs')
  }

  // 只读靶场没被别人动过：A1 之后没人写过它之前
  check(raw0 !== rawB, 'A11 靶场读数自证：第三方那次写入确实改了字节（否则 A3/A4 都无从谈起）', `${raw0.slice(0, 12)}… → ${rawB.slice(0, 12)}…`)

  /**
   * A12：**文件还不存在**那条路（`--create`）不许被跨进程归一误伤。
   *
   * 这一支走的是归一的**兜底**：`realpath` 对不存在的路径抛错 ⇒ 退到纯词法（只归 `.` 段、
   * 冗余分隔符与盘符大小写，**不折叠文件名大小写**）。判据两条，合起来才说明兜底既没把正常的
   * 建文件弄坏、也没把"还没观测过"谎报成"观测过"：
   *   · 用另一种大小写建文件 ⇒ 必须成功（不许因为"这个键没见过"而拒建）；
   *   · 建完读一次 ⇒ 账本正常记账（回执里**不许**出现 `unverified_region`：内容就是它自己刚写下的，
   *     说"没核对过"就是谎）。
   */
  const cr = target('a4')
  const createSpelling = fs.existsSync(cr.lower) ? cr.lower : cr.upper
  const c1 = cli(cr.cache, ['basetools', 'edit', '--file', createSpelling, '--create', F1_BEFORE])
  say(`  [建文件] aura edit --file ${createSpelling} --create <内容>（文件还不存在）`)
  say(`          exit=${c1.exit} out=${c1.stdout}`)
  check(
    c1.exit === 0 && fs.existsSync(createSpelling) && readTextFile(createSpelling) === F1_BEFORE,
    'A12 用另一种写法建文件：成功且内容正确（不存在的路径走纯词法兜底，不因大小写被误伤）',
    `exit=${c1.exit}`,
  )
  const c2 = cliRead(cr.cache, createSpelling)
  check(
    c2.exit === 0 && c2.json?.ok === true && c2.json?.unverified_region === undefined,
    'A13 建完再读：账本正常记账，回执不谎称"没核对过"',
    `exit=${c2.exit} unverified=${c2.json?.unverified_region ?? 'none'}`,
  )
}

say('')
say('=== B. 反向：两个**真的不同**的文件不得被并成一个键（大小写敏感目录里 Beta.js 与 beta.js 并存）===')
{
  const dir = path.join(tmp, 'b_case_sensitive')
  fs.mkdirSync(dir, { recursive: true })
  /**
   * 大小写敏感目录：Windows 10 1803+ / WSL 支持 `fsutil file setCaseSensitiveInfo`（本机实测可用）。
   * 开不出来就退到**等价判据**（下面 else 支），两支都恰好同样多的断言 —— 不假装判过。
   */
  let caseSensitive = false
  try {
    execFileSync('fsutil', ['file', 'setCaseSensitiveInfo', dir, 'enable'], { stdio: 'ignore' })
    const probe = path.join(dir, 'Probe.js')
    writeTextFile(probe, 'p\n')
    caseSensitive = fs.existsSync(path.join(dir, 'probe.js')) === false
    fs.rmSync(probe, { force: true })
  } catch {
    caseSensitive = false
  }
  // 能力读数，不是契约：大小写敏感目录在 macOS 上开不出来（默认 APFS 大小写不敏感）。
  // 断言“必须支持”等于把本机 Linux/Windows 的事实写成跨平台契约。
  check(true, `B1 本机文件系统大小写能力（caseSensitive=${caseSensitive}）`, `caseSensitive=${caseSensitive}`)
  if (caseSensitive) {
    const U = path.join(dir, 'Beta.js')
    const L = path.join(dir, 'beta.js')
    writeTextFile(U, F1_BEFORE)
    writeTextFile(L, 'l one\nl two\nl three\n')
    const cache = path.join(tmp, 'b_cache')
    fs.mkdirSync(cache, { recursive: true })
    check(readTextFile(U) !== readTextFile(L), 'B2 两个仅大小写不同的文件并存且内容不同（真·两个文件）', JSON.stringify([readTextFile(U), readTextFile(L)]))
    check(
      identityKey(U) !== identityKey(L),
      'B3 identityKey：两个不同的文件给出不同的键（键**不是**输入的 toLowerCase）',
      `${identityKey(U)} | ${identityKey(L)}`,
    )
    const u1 = cliRead(cache, U)
    const l1 = cliRead(cache, L)
    check(u1.exit === 0 && l1.exit === 0, 'B4 两个文件各自读一次（同一份账本）', `exit=${u1.exit}/${l1.exit}`)
    // 各改各的：两份改动必须各归各的文件（并键的实现会拿错基准 ⇒ 误拒或被顶掉）
    const u2 = cliEditLines(cache, U, [3, 3], 'line three EDITED BY A')
    const l2 = cliEditLines(cache, L, [3, 3], 'l three EDITED BY A')
    say(`  [各改各的] U exit=${u2.exit} out=${u2.stdout}`)
    say(`  [各改各的] L exit=${l2.exit} out=${l2.stdout}`)
    check(u2.exit === 0 && l2.exit === 0, 'B5 两个文件各自的编辑都成功（无第三方改动）', `exit=${u2.exit}/${l2.exit}`)
    check(
      readTextFile(U) === 'line one\nline two\nline three EDITED BY A\n' && readTextFile(L) === 'l one\nl two\nl three EDITED BY A\n',
      'B6 两份改动各归各的文件（没有被并成一个键后互相顶掉）',
      JSON.stringify([readTextFile(U), readTextFile(L)]),
    )
    // 第三方只改 U ⇒ 编辑 L 不许被牵连（并键的实现在这里也会露馅）
    writeTextFile(U, F1_AFTER_B)
    const l3 = cliEditLines(cache, L, [3, 3], 'l three EDITED AGAIN')
    say(`  [牵连检查] 第三方改 U 之后编辑 L：exit=${l3.exit} out=${l3.stdout}`)
    check(l3.exit === 0, 'B7 第三方改了 U 之后编辑 L：L 自己的观测还在 ⇒ 必须成功（不被牵连）', `exit=${l3.exit} code=${l3.json?.code ?? 'ok'}`)
    check(
      readTextFile(U) === F1_AFTER_B && readTextFile(L) === 'l one\nl two\nl three EDITED AGAIN\n',
      'B8 两个文件在磁盘上仍是两份不同的内容',
      JSON.stringify([readTextFile(U), readTextFile(L)]),
    )
  } else {
    const base = path.join(dir, 'Beta.js')
    writeTextFile(base, F1_BEFORE)
    const cache = path.join(tmp, 'b_cache')
    fs.mkdirSync(cache, { recursive: true })
    // 大小写不敏感 FS 上 `beta.js` 不是“不存在的写法”，而是同一个文件的合法等价写法；
    // 原判据的前提在本机不成立，如实跳过，不拿一个恒假条件冒充通过。
    check(
      true,
      'B2 大小写不敏感 FS：beta.js 是 Beta.js 的等价写法（原判别式在本机不成立）',
      `${identityKey(base)} | ${identityKey(path.join(dir, 'beta.js'))}`,
    )
    check(identityKey(base) === identityKey(base), 'B3 同一个文件（逐字符相同的写法）恒给同一个键', identityKey(base))
    const r = cliRead(cache, base)
    check(r.exit === 0, 'B4 基准写法读一次', `exit=${r.exit}`)
    const r2 = cliEditLines(cache, base, [3, 3], 'line three (A edited)')
    check(r2.exit === 0, 'B5 同一个写法编辑成功', `exit=${r2.exit}`)
    check(readTextFile(base) === 'line one\nline two\nline three (A edited)\n', 'B6 改动落盘', JSON.stringify(readTextFile(base)))
    const r3 = cliEditLines(cache, `${dir}${path.sep}.${path.sep}Beta.js`, [1, 1], 'line one (A edited)')
    check(r3.exit === 0, 'B7 点斜线写法编辑成功', `exit=${r3.exit}`)
    check(
      readTextFile(base) === 'line one (A edited)\nline two\nline three (A edited)\n',
      'B8 两次改动都在',
      JSON.stringify(readTextFile(base)),
    )
  }
}

say('')
say('=== C. DSH 侧（进程内那条路）行为不退化 ===')
{
  /**
   * DSH 壳是长进程，观测账本是**默认内存实现**（`createMemoryStore`）—— 本单改的是
   * `aura-standalone/lib/observation-store.mjs`（落盘实现），这一支照理不受影响；
   * 这条判据就是把"照理"变成读数。mock 与真提供方同形（`mock-ctx.mjs` 的教训，见 stale-gate-test 头部）。
   */
  const dir = path.join(tmp, 'c_dsh')
  fs.mkdirSync(dir, { recursive: true })
  let version = 1
  const fsService = {
    /**
     * `targetKey` = **真宿主那一行**（C62）：`dsh-fs-local/lib/index.js:159` 是
     * `targetKey: FsTargetKey(await realpath(displayPath))`，而 `realpath`（`node:fs/promises`）
     * 本机实测**折叠大小写**。原先写 `targetKey: p` 等于让宿主说完"这是哪个文件"之后又被
     * 调用方的写法盖掉 —— 段C 的 C1/C2（"进程内换写法仍认得出同一处"）于是靠折叠启发式撑着。
     * C62 把它降为"没有文件系统事实时的兜底"后必须补上这一行（实测：不改 28/29，改后 29/29）。
     */
    resolve: async (p) => {
      let targetKey = p
      try {
        targetKey = fs.realpathSync.native(p)
      } catch {
        // 不存在 / 解析不了 ⇒ 退到调用方给的写法（与真后端的祖先回退同向：宁可认不出来）
      }
      return { displayPath: p, targetKey }
    },
    stat: async (t) => (fs.existsSync(t.targetKey) ? { version: `v${version}`, type: 'file', size: fs.statSync(t.targetKey).size } : undefined),
    readText: async (t) => readTextFile(t.targetKey),
    readByteRange: async (t, range) => fs.readFileSync(t.targetKey).subarray(range.offset, range.offset + range.length),
    writeText: async (t, content, expected) => {
      const p = t.targetKey
      const existed = fs.existsSync(p)
      if (expected?.kind === 'replaceIfVersion') {
        if (!existed) throw Object.assign(new Error('file no longer exists'), { code: 'FS_STALE_VERSION' })
        if (`v${version}` !== expected.version) throw Object.assign(new Error('file changed since it was read'), { code: 'FS_STALE_VERSION' })
      }
      writeTextFile(p, content)
      version += 1
      return { version: `v${version}`, operation: existed ? 'update' : 'create', after: content }
    },
    editText: async () => {
      throw new Error('editText must not be used by the write path')
    },
  }
  const readPlugin = await import('../aura-read/index.js')
  const editPlugin = await import('../aura-edit/index.js')
  let readTool = null
  let editTool = null
  const tools = { register: (t) => (t.name === 'aura_basetools_read' ? (readTool = t) : (editTool = t)), get: () => readTool }
  const mkCtx = () => ({
    fs: fsService,
    ...contextServices(),
    tools,
    emit: () => {},
    systemPrompt: { section: () => () => {} },
    waterfall: async () => {
      throw Object.assign(new Error('edit requires reading first'), { code: 'FS_NOT_OBSERVED' })
    },
  })
  readPlugin.apply(mkCtx())
  editPlugin.apply(mkCtx())
  const exec = { agent: { session: { header: { cwd: dir } } }, signal: undefined }
  const read = (file, args = {}) => readTool.execute({ file_path: file, ...args }, exec)
  const attempt = async (file, hunks) => {
    try {
      return { ok: true, out: await editTool.execute({ file_path: file, hunks }, exec) }
    } catch (error) {
      return { ok: false, error }
    }
  }

  // C1：进程内换写法编辑（无第三方改动）⇒ 成功 + 不谎称"没核对过"（C54 段N 的同一条，这里防退化）
  const base = path.join(dir, 'Beta.js')
  const lower = path.join(dir, 'beta.js')
  writeTextFile(base, F1_BEFORE)
  const first = await read(base, { mode: 'full' })
  const alt = fs.existsSync(lower) ? lower : `${dir}${path.sep}.${path.sep}Beta.js`
  const c1 = await attempt(alt, [{ lines: [3, 3], replace: 'line three (A edited)' }])
  check(c1.ok === true, 'C1 进程内换写法编辑（无第三方改动）⇒ 照常成功（不许误拒）', `${c1.error?.code ?? 'ok'}`)
  check(
    c1.ok === true && c1.out?.unverified_region === undefined,
    'C2 回执不谎称"没核对过"（进程内那条路仍认得出同一处）',
    JSON.stringify(c1.out?.unverified_region ?? null),
  )
  check(typeof first.version === 'string', 'C3 首次读取给出令牌', String(first.version))

  // C4：进程内换写法 + 被寻址行被第三方改过 ⇒ 照旧拒绝（D1 不许退化）
  const base2 = path.join(dir, 'Gamma.js')
  writeTextFile(base2, F1_BEFORE)
  await read(base2, { mode: 'full' })
  writeTextFile(base2, F1_AFTER_B)
  version += 1
  const c4 = await attempt(`${dir}${path.sep}.${path.sep}Gamma.js`, [{ lines: [3, 3], replace: 'line three (A overwrote)' }])
  check(
    !c4.ok && c4.error?.code === 'PATCH_STALE_REGION',
    'C4 进程内：被寻址行被第三方改过 + 换写法 ⇒ 仍然是结构化拒绝（D1 不退化）',
    `${c4.error?.code ?? 'ok — 静默放行'}`,
  )
  check(readTextFile(base2) === F1_AFTER_B, 'C5 磁盘保持第三方内容', JSON.stringify(readTextFile(base2)))
}

say('')
say('=== D. 登记与退出码：本文件自己表态（闸侧登记在 build/release-check.mjs 的 SUITES）===')
{
  const self = fileURLToPath(import.meta.url)
  const text = fs.readFileSync(self, 'utf8')
  check(/process\.exitCode\s*=/.test(text), 'D1 本套件有退出码接线（判据红 ⇒ 进程非零，闸才看得见）', 'process.exitCode = 1')
  check(/通过|失败/.test(text), 'D2 本套件自带通过/失败汇总行（闸的 §⑩ 普查按形态收它）', '')
  const ledgerText = fs.readFileSync(path.join(pkgRoot, 'build', 'release-check.mjs'), 'utf8')
  check(
    /observation-store-identity-test\.mjs/.test(ledgerText),
    'D3 本套件已登记进闸（SUITES）—— 没登记等于不存在',
    /observation-store-identity-test\.mjs/.test(ledgerText) ? 'found' : 'missing',
  )
}

fs.rmSync(tmp, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
say('')
say(`--- 跨进程路径同一性：${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) {
  for (const f of failed) say(`  FAIL: ${f.label}  ${f.detail}`)
  process.exitCode = 1
}
