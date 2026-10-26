/**
 * encoding-context.mjs —— 用**同目录的语料**给短文件的编码判决补一个先验。
 *
 * ## 为什么需要
 *
 * 20 行以内的 GBK 配置文件在分类器上没有足够证据（`medium`），写成“拒绝写、请显式指定”。
 * 而 Windows 上的真实目录往往是**混质**的：一个老项目同一个目录里十几个文件都是 GBK。
 * 那就是证据：给短文件投票的不是它自己那几十个字节，而是它所在的目录。
 *
 * ## 边界（三条，都是为了不把“投票”变成“猜”）
 *
 *   ① 只在**探测置信度不足**时介入；`utf-8`（合法）与显式指定都不动；
 *   ② 先验只提“候选”，最终仍要过**逐字节可逆**：`probeEncoding(buffer, { hint })` 会算
 *      `roundTrip`，不可逆就保持原判决（读得到、写被拒）；
 *   ③ 样本门槛：≥5 个高置信兄弟、且同一编码 ≥90%。达不到就不投票。
 *
 * 投票失败不会让事情变坏：结果就是原来的 `medium`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { probeEncoding } from './encoding.mjs'

const SAMPLE_BYTES = 64 * 1024
const MAX_FILES = 24
const MIN_SAMPLES = 5
const MIN_AGREEMENT = 0.9

/** 目录级缓存：键是目录的 mtime（文件增减会变）；只缓存“判定过”的结果。 */
const cache = new Map()

function directoryPrior(filePath) {
  let dir
  try {
    dir = path.dirname(filePath)
    const st = fs.statSync(dir)
    const key = `${dir}|${st.mtimeMs}`
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    const counts = new Map()
    let total = 0
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    let seen = 0
    for (const entry of entries) {
      if (seen >= MAX_FILES) break
      if (!entry.isFile()) continue
      const candidate = path.join(dir, entry.name)
      if (candidate === filePath) continue
      let size
      try {
        size = fs.statSync(candidate).size
      } catch {
        continue
      }
      if (size === 0 || size > SAMPLE_BYTES * 8) continue
      let bytes
      try {
        const fd = fs.openSync(candidate, 'r')
        try {
          const buf = Buffer.alloc(Math.min(size, SAMPLE_BYTES))
          const read = fs.readSync(fd, buf, 0, buf.length, 0)
          bytes = buf.subarray(0, read)
        } finally {
          fs.closeSync(fd)
        }
      } catch {
        continue
      }
      seen += 1
      if (bytes.includes(0)) continue // UTF-16/二进制不参与 CJK 投票
      const probe = probeEncoding(bytes)
      if (probe.encoding === null || probe.encoding === 'utf-8') continue
      if (probe.confidence !== 'high') continue
      counts.set(probe.encoding, (counts.get(probe.encoding) ?? 0) + 1)
      total += 1
    }
    let prior = null
    if (total >= MIN_SAMPLES) {
      const [encoding, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
      if (count / total >= MIN_AGREEMENT) prior = { encoding, samples: total, agreement: count / total }
    }
    const result = { prior, total }
    cache.set(key, result)
    return result
  } catch {
    return { prior: null, total: 0 }
  }
}

/**
 * 用目录先验细化一个探测结果。返回**新** probe（不改入参）。
 *
 * @param {Buffer} buffer - 该文件的字节
 * @param {object} probe - `probeEncoding` 的结果
 * @param {string} filePath - 绝对路径
 */
export function refineWithDirectory(buffer, probe, filePath) {
  if (probe?.explicit === true) return probe
  if (probe?.encoding === null || probe?.encoding === undefined) return probe
  if (probe.encoding === 'utf-8' && probe.confidence === 'high') return probe
  // 已经高置信且可逆：没有改进空间
  if (probe.confidence === 'high' && probe.roundTrip === true) return probe
  const { prior } = directoryPrior(filePath)
  if (prior === null) return probe
  const viaHint = probeEncoding(buffer, { hint: prior.encoding })
  if (viaHint.encoding !== prior.encoding || viaHint.roundTrip !== true) return probe
  return {
    ...viaHint,
    // 先验不是“显式指定”：保留这个区别，回执才说得清来源。
    explicit: false,
    confidence: 'high',
    directory_prior: { encoding: prior.encoding, samples: prior.samples, agreement: Number(prior.agreement.toFixed(3)) },
  }
}
