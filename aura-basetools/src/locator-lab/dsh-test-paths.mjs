/**
 * dsh-test-paths.mjs —— 测试专用的 DSH 语料定位器（不进 npm 包）。
 *
 * 为什么需要它：struct/read/read2 以前把 `E:\\software\\npx...\\@deepseek-ai` 写死在
 * 文件里，本地能过，GitHub runner（macOS/Linux/Windows）没有这个盘符，整批测试直接
 * ENOENT。判据是“这些文件可读”，不是“这台机器上恰好有这个路径”。
 *
 * 解析顺序：
 *   ① AURA_DSH_NM（显式覆盖，CI 或特殊布局）
 *   ② <cwd>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai（安装了 @deepseek-ai/dsh）
 *   ③ <cwd>/node_modules/@deepseek-ai（平铺安装）
 *   ④ `npm root -g` + 同样的两级布局（本机全局 DSH）
 * 找不到就返回 null；调用方打印跳过并 exit 0，不把“环境缺语料”伪装成通过或失败。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const has = (dir, name) => dir !== null && fs.existsSync(path.join(dir, name))

export function dshModulesRoot() {
  const candidates = []
  if (process.env.AURA_DSH_NM) candidates.push(process.env.AURA_DSH_NM)
  candidates.push(path.join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
  candidates.push(path.join(process.cwd(), 'node_modules', '@deepseek-ai'))
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const globalRoot = execFileSync(npm, ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
      // Windows 的 npm 是 .cmd，execFileSync 直接调会 ENOENT/EINVAL；走 shell 才解析。
      shell: process.platform === 'win32',
    }).trim()
    candidates.push(path.join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
  } catch {
    // 没有 npm / 没装 DSH：不把它当成错误，交给调用方跳过。
  }
  return candidates.find((dir) => has(dir, 'dsh-tool-fs')) ?? null
}
