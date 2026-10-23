/**
 * policy-arg-test.mjs —— 验证 aura_basetools_edit 确实把**会话的沙箱策略**传给了 mutation。
 *
 * 为什么必须专门测这个：原来的 41/41 全绿，但 mock 里的 editText 是
 * `async (t, req) => …`（两个参数），而真实后端是
 * `editText(target, edit, expected, signal, sandboxPolicy)`（五个）。
 * **mock 比框架宽松，等于没测。** 这正是那个 bug 能穿过全部测试的原因。
 *
 * 所以本测试的 mock 与真实签名同形，并且把"第 5 个参数是什么"当成断言对象。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply as applyEdit } from '../aura-edit/index.js'

const say = (m) => fs.writeSync(1, `${m}\n`)
let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    pass += 1
    say(`  ✓ ${label}`)
  } else {
    fail += 1
    say(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const tmp = path.join(os.tmpdir(), `policyarg-${Date.now()}`)
fs.mkdirSync(tmp, { recursive: true })

/** 造一个 ctx：签名与真实 fs 服务逐字对齐（五个参数）。 */
function makeCtx({ policy, files, seen }) {
  return {
    fs: {
      resolve: async (p, opts) => {
        // 与真实 fs 服务同形：相对路径相对 opts.cwd 解析。
        // 第一版这里直接 `targetKey: p`，于是相对路径解析不出来，
        // 测出来的"not found"是 mock 的缺陷，不是被测代码的。
        const abs = path.isAbsolute(p) ? p : path.join(opts?.cwd ?? process.cwd(), p)
        return { displayPath: p, targetKey: abs, _opts: opts }
      },
      stat: async (t) => (fs.existsSync(t.targetKey) ? { version: 'v1' } : undefined),
      readText: async (t) => fs.readFileSync(t.targetKey, 'utf8'),
      editText: async (t, edit, expected, signal, sandboxPolicy) => {
        seen.push({ call: 'editText', expected, signal, sandboxPolicy })
        const cur = fs.readFileSync(t.targetKey, 'utf8')
        fs.writeFileSync(t.targetKey, cur.split(edit.oldString).join(edit.newString), 'utf8')
        return { version: 'v2', operation: 'update' }
      },
      writeText: async (t, content, expected, signal, sandboxPolicy) => {
        seen.push({ call: 'writeText', expected, signal, sandboxPolicy })
        fs.writeFileSync(t.targetKey, content, 'utf8')
        return { version: 'v1', operation: 'create', after: content }
      },
    },
    inject: (deps, fn) => {
      // 与真实 Cordis 同形：服务存在时才绑定回调。这里刻意走真实路径，
      // 而不是让被测代码通过 get 拿到策略——那样就绕过了 apply 期的注册方式。
      if (deps.includes('sandboxPolicy') && policy !== undefined) fn({ sandboxPolicy: policy })
    },
    tools: { register: () => {} },
    emit: () => {},
    systemPrompt: { section: () => () => {} },
  }
}

// ── 1. 有 sandboxPolicy 服务时：必须解析出会话策略并传下去 ────────────────
say('=== 1. 存在 sandboxPolicy 服务：策略必须传到 mutation ===')
{
  const target = path.join(tmp, 'a.js')
  fs.writeFileSync(target, 'export const a = 1;\n', 'utf8')
  const seen = []
  const SESSION = { header: { cwd: tmp } }
  const resolved = { mode: 'danger-full-access', workspaceRoot: tmp }
  const policy = {
    resolve: (req) => {
      // 必须带 session —— 不带就等于"没有会话的策略"，那正是原来的 bug
      if (req?.session !== SESSION) throw new Error('resolve 没有收到 session')
      return resolved
    },
  }
  let reg = null
  const ctx = makeCtx({ policy, files: {}, seen })
  ctx.tools.register = (x) => (reg = x)
  applyEdit(ctx)
  const exec = { agent: { session: SESSION }, signal: 'SIG' }

  await reg.execute({ file_path: target, hunks: [{ lines: [1], replace: 'export const a = 2;' }] }, exec)
  // 写回原语自 C12 起是 writeText（提供方级 CAS 的整份写）；此处**不加 `?? editText` 兜底**：
  // 兜底会让“退回旧原语”这类回归静默通过，而 byte-fidelity 段D 正靠“两者行为不同”成立。
  const call = seen.find((s) => s.call === 'writeText')
  check('writeText 收到了策略对象', call?.sandboxPolicy === resolved, JSON.stringify(call?.sandboxPolicy))
  check('writeText 仍然收到 signal', call?.signal === 'SIG')
  // 写回必须带提供方级版本守：读到的 version 原样交出去，读后被第三方改过才会被拒（FS_STALE_VERSION）
  check(
    'writeText 带了版本守（replaceIfVersion + 读到的 version）',
    call?.expected?.kind === 'replaceIfVersion' && call?.expected?.version === 'v1',
    JSON.stringify(call?.expected),
  )
  check('写入生效', fs.readFileSync(target, 'utf8') === 'export const a = 2;\n')
}

// ── 2. 没有 sandboxPolicy 服务时：必须安静降级，不抛错 ────────────────────
say('')
say('=== 2. 不部署沙箱：软取失败必须降级而不是报错 ===')
{
  const target = path.join(tmp, 'b.js')
  fs.writeFileSync(target, 'export const b = 1;\n', 'utf8')
  const seen = []
  let reg = null
  const ctx = makeCtx({ policy: undefined, files: {}, seen })
  ctx.tools.register = (x) => (reg = x)
  applyEdit(ctx)
  const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }

  await reg.execute({ file_path: target, hunks: [{ lines: [1], replace: 'export const b = 9;' }] }, exec)
  const call = seen.find((s) => s.call === 'writeText')
check('writeText 收到 policy=undefined', call !== undefined && call.sandboxPolicy === undefined)
  check('写入仍然生效', fs.readFileSync(target, 'utf8') === 'export const b = 9;\n')
}

// ── 3. 创建路径：同样必须带策略 ───────────────────────────────────────────
say('')
say('=== 3. create 路径也要带策略 ===')
{
  const target = path.join(tmp, 'c.js')
  const seen = []
  const SESSION = { header: { cwd: tmp } }
  const resolved = { mode: 'workspace-write', workspaceRoot: tmp }
  const policy = { resolve: () => resolved }
  let reg = null
  const ctx = makeCtx({ policy, files: {}, seen })
  ctx.tools.register = (x) => (reg = x)
  applyEdit(ctx)

  await reg.execute({ file_path: target, create: 'export const c = 1;\n' }, { agent: { session: SESSION } })
  const call = seen.find((s) => s.call === 'writeText')
  check('writeText 收到了策略对象', call?.sandboxPolicy === resolved)
  check('创建生效', fs.readFileSync(target, 'utf8') === 'export const c = 1;\n')
}

// ── 4. 恢复提示必须是英文（工具结果会进英文会话）──────────────────────────
// 载体换了：这段提示以前搭在 `error.message` 上，现在搭在**失败回执的 `message`** 上
// （锚点失败＝判定不出意图 ⇒ 走结果通道，fs-contract-v2 / C3）。换载体的理由正是这条断言
// 存在的理由：框架只读 `error.message`，而回执正文才是模型真看得见的那段。
say('')
say('=== 4. 锚点失败时的恢复提示：不得出现中文 ===')
{
  const target = path.join(tmp, 'd.js')
  fs.writeFileSync(target, 'function alpha() {\n  return 1\n}\n', 'utf8')
  let reg = null
  const ctx = makeCtx({ policy: undefined, files: {}, seen: [] })
  ctx.tools.register = (x) => (reg = x)
  applyEdit(ctx)
  let message = ''
  let threw = null
  let receipt = null
  try {
    receipt = await reg.execute(
      { file_path: target, hunks: [{ anchor: 'TEXT THAT IS NOT IN THIS FILE', replace: 'x' }] },
      { agent: { session: { header: { cwd: tmp } } } },
    )
  } catch (e) {
    threw = e
  }
  message = String(receipt?.message ?? '')
  check('锚点失败不再抛错（走结果通道）', threw === null && receipt !== null, `threw=${threw ? String(threw.message).slice(0, 40) : 'no'}`)
  check(
    `回执 outcome=${receipt?.outcome} code=${receipt?.code}`,
    receipt?.outcome === 'not_found' && receipt?.code === 'PATCH_NOT_FOUND',
    `${receipt?.outcome}/${receipt?.code}`,
  )
  check('回执里带上了符号目录', message.includes('structural directory'))
  check('符号目录用的是 lines 而不是 行', message.includes('lines 1-3'), message.slice(0, 200))
  // eslint-disable-next-line no-control-regex
  const hasCJK = /[\u4e00-\u9fff]/.test(message)
  check('回执里没有中文字符', !hasCJK, hasCJK ? message.match(/[\u4e00-\u9fff]+/g)?.join(',') : '')
  check('被拦下时磁盘未变', fs.readFileSync(target, 'utf8') === 'function alpha() {\n  return 1\n}\n')
}

// ── 5. 位置解析必须用策略里的 workspaceRoot ──────────────────────────────
say('')
say('=== 5. 相对路径要相对策略的 workspaceRoot 解析 ===')
{
  const policyRoot = path.join(tmp, 'policy-root')
  fs.mkdirSync(policyRoot, { recursive: true })
  const target = path.join(policyRoot, 'e.js')
  fs.writeFileSync(target, 'export const e = 1;\n', 'utf8')
  const sessionCwd = path.join(tmp, 'session-cwd')
  fs.mkdirSync(sessionCwd, { recursive: true })
  let resolveOpts = null
  let reg = null
  const ctx = makeCtx({ policy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: policyRoot }) }, files: {}, seen: [] })
  const origResolve = ctx.fs.resolve
  ctx.fs.resolve = async (p, opts) => {
    resolveOpts = opts
    return origResolve(p, opts)
  }
  ctx.tools.register = (x) => (reg = x)
  applyEdit(ctx)

  await reg.execute(
    { file_path: 'e.js', hunks: [{ lines: [1], replace: 'export const e = 2;' }] },
    { agent: { session: { header: { cwd: sessionCwd } } } },
  )
  check('resolve 用的是策略的 workspaceRoot', resolveOpts?.cwd === policyRoot, String(resolveOpts?.cwd))
}

fs.rmSync(tmp, { recursive: true, force: true })
say('')
say(`--- ${pass}/${pass + fail} 通过 ---`)
process.exitCode = fail === 0 ? 0 : 1
