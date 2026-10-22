/**
 * 最小接入示例：**只拿 locator-lab 的 7 个引擎文件** + 自己的文件 IO。
 *
 * 这份文件是可运行的，输出见 `README.md`。故意不用任何框架：没有 DSH、没有包管理、没有依赖安装。
 * 全部接入工作量就是下面那个 `myProvider`——四个方法（`listDir` 是可选的第五个，只有仓库地图需要）。
 *
 * ## 怎么跑
 *
 *   mkdir /tmp/lab && cp ../../../src/locator-lab/{read-core,locator-api,struct-core,anchor-core,write-path,args,repo-map}.mjs /tmp/lab/
 *   cp demo.mjs /tmp/lab/ && cd /tmp/lab && node demo.mjs
 *
 * ## 设计上的要点（都是踩出来的，不是风格偏好）
 *
 * · `readText` 必须与引擎同形：**fatal 解码 + 默认 ignoreBOM**（第一个 BOM 不进字符串）。
 *   两个官方面（`dsh-fs-local` 与独立 CLI 的 `fs-provider`）都是这个形状——自己的 provider 若不同形，
 *   BOM 文件的令牌会对不上，表现为“本来核对过”被报成“没核对过”。
 * · `stat().version` 是 CAS 的凭据。示例用 `size:mtimeMs` 只是为了短；**生产环境请用内容指纹或真版本**，
 *   因为同尺寸同时间戳的改写会让 CAS 静默失效（本仓 `atomic-publish-test` 量过这件事）。
 * · `applyEditToProvider` 是**一次完整写回**：读 → 规划 → 新鲜度闸门 → CAS → 回读校验 → 刷新观测。
 *   不要自己拆开做，闸门与回读校验是它不可分割的一部分。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { readWith } from './locator-lab/read-core.mjs'
import { locate } from './locator-lab/locator-api.mjs'
import { applyEditToProvider } from './locator-lab/write-path.mjs'
import { collectRepoMap } from './locator-lab/repo-map.mjs'

// ── ① 你要写的唯一东西：把引擎的契约接到自己的 IO 上 ────────────────────────
function myProvider(root) {
  const abs = (p) => (path.isAbsolute(p) ? p : path.resolve(root, p))
  const versionOf = (file) => {
    const st = fs.statSync(file)
    return `${st.size}:${Math.trunc(st.mtimeMs)}` // 生产环境请换成真版本（见文件头注释）
  }
  return {
    stat: (target) => {
      const file = abs(target)
      if (!fs.existsSync(file)) return undefined
      const st = fs.statSync(file)
      if (st.isDirectory()) return { type: 'directory', size: 0 }
      return { type: 'file', version: versionOf(file), size: st.size }
    },
    readText: (target) => {
      const buf = fs.readFileSync(abs(target))
      return new TextDecoder('utf-8', { fatal: true }).decode(buf)
    },
    readByteRange: (target, range) =>
      new Uint8Array(fs.readFileSync(abs(target)).subarray(range.offset, range.offset + range.length)),
    writeText: (target, content, expected) => {
      const file = abs(target)
      if (expected?.kind === 'replaceIfVersion' && fs.existsSync(file) && versionOf(file) !== expected.version) {
        throw Object.assign(new Error('file changed since it was read'), { code: 'FS_STALE_VERSION' })
      }
      fs.writeFileSync(file, content)
      return { version: versionOf(file) }
    },
    listDir: (target) => {
      const dir = abs(target)
      return fs.readdirSync(dir, { withFileTypes: true }).map((e) => {
        const child = path.join(dir, e.name)
        let size
        if (e.isFile()) size = fs.statSync(child).size
        return { name: e.name, type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other', size, target: child }
      })
    },
  }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-demo-'))
const file = path.join(work, 'demo.mjs')
fs.writeFileSync(file, 'export function alpha() {\n  const n = 1\n  return n\n}\n\nexport function beta() {\n  const n = 2\n  return n\n}\n')
const provider = myProvider(work)
const out = (m) => process.stdout.write(`${m}\n`)

// ── ② 读：给它内容 + 一个请求，拿回信封 ──────────────────────────────────────
const source = provider.readText(file)
const env = readWith(source, { mode: 'auto', filePath: file, byteOrderMark: false })
out(`读：mode=${env.mode}  ${env.totalLines} 行  version=${env.version}`)
out(`${env.text.split('\n').slice(0, 4).join('\n')}\n`)

// ── ③ 定位：按符号名 / 行号 / 线索 / 锚点，四级降级 ─────────────────────────
const hit = locate(source, { target: 'beta', filePath: file })
out(`定位 target=beta ⇒ 第 ${hit.startLine}-${hit.endLine} 行，tier=${hit.tier}`)
const ambiguous = locate(source, { target: 'n', filePath: file })
out(`定位 target=n（两处重名）⇒ ok=${ambiguous.ok} code=${ambiguous.code}`)
out(`  回执：${String(ambiguous.message).slice(0, 118)}\n`)

// ── ④ 写：观测 → 规划 → 新鲜度闸门 → CAS → 回读校验，全在一次调用里 ────────
const applied = await applyEditToProvider(provider, {
  displayPath: file,
  hunks: [{ lines: [7, 7], replace: '  return 42' }],
})
out(`写：applied=${JSON.stringify(applied.applied)}  write_verify=${JSON.stringify(applied.write_verify)}`)
out(`磁盘第 7 行现在 = ${JSON.stringify(fs.readFileSync(file, 'utf8').split('\n')[6])}\n`)

// ── ⑤ 安全网：行号已位移时，闸门会拒绝而不是改错地方 ────────────────────────
fs.writeFileSync(file, `// inserted\n// inserted\n${fs.readFileSync(file, 'utf8')}`) // 第三方在顶部插两行
let refused = 'no'
try {
  await applyEditToProvider(provider, { displayPath: file, hunks: [{ lines: [7, 7], replace: '  WRONG' }] })
} catch (error) {
  refused = error.code ?? 'threw'
}
out(`位移后仍用旧行号 ⇒ ${refused}`)
out(`  磁盘是否被动过：${fs.readFileSync(file, 'utf8').includes('WRONG') ? '被改了（错！）' : '没动 ✓'}\n`)

// ── ⑥ 仓库地图：传目录 ──────────────────────────────────────────────────────
const repo = await collectRepoMap(
  {
    listChildren: (dir) => provider.listDir(dir),
    readHead: (target, bytes) =>
      new TextDecoder('utf-8').decode(provider.readByteRange(target, { offset: 0, length: bytes })),
  },
  work,
  { rootPath: work },
)
out(`仓库地图：${repo.modules} 个模块`)
out(repo.text.split('\n').slice(0, 6).join('\n'))

fs.rmSync(work, { recursive: true, force: true })
