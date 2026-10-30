/**
 * encoding-memory.mjs —— 记住“这个文件是什么编码”，设一次就够。
 *
 * ## 为什么需要它
 *
 * 探测在中/低置信度时会**拒绝写**（`ENCODING_AMBIGUOUS`）——这是对的：写错编码等于写坏字节。
 * 但用户每次都要 `AURA_ENCODING=gb18030` 才能改同一个文件，体验很差。
 *
 * 所以：**显式指定过一次，就记住**。下次同一文件（大小与 mtime 都没变）自动沿用，
 * 不需要再设环境变量。
 *
 * ## 为什么不无条件信任记忆
 *
 * 文件被别的工具重写后，编码可能变了（甚至从 GBK 改成 UTF-8）。所以记忆条目带
 * `{size, mtimeMs}` 指纹：**对不上就忽略**，回到探测。宁可再问一次，不可写错。
 *
 * 存放位置：`AURA_CACHE_DIR`（默认 `~/.aura`）下的 `encodings.json`；目录不可写时静默跳过
 * ——记忆是加速器，不是正确性依赖。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isKnownEncodingName, normalizeEncodingName } from './encoding.mjs'

const MAX_ENTRIES = 500

function storePath() {
  const dir = process.env.AURA_CACHE_DIR ?? path.join(os.homedir(), '.aura')
  return path.join(dir, 'encodings.json')
}

function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeAll(map) {
  try {
    const file = storePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(map))
    fs.renameSync(tmp, file)
  } catch {
    /* 记忆是加速器，不是正确性依赖 */
  }
}

/** 指纹：大小 + mtime；任一缺失就当作“不知道”，不冒险复用。 */
function stampOf(stat) {
  if (stat === undefined || stat === null) return null
  const size = Number(stat.size)
  const mtimeMs = Number(stat.mtimeMs)
  if (!Number.isFinite(size) || !Number.isFinite(mtimeMs)) return null
  return { size, mtimeMs: Math.trunc(mtimeMs) }
}

/** 记住一个文件的编码（UTF-8 不记：它是默认值，记住只会让表变脏）。 */
export function rememberEncoding(displayPath, encoding, stat) {
  if (typeof displayPath !== 'string' || typeof encoding !== 'string') return
  if (!isKnownEncodingName(encoding)) return
  if (encoding === 'utf-8') return
  const stamp = stampOf(stat)
  if (stamp === null) return
  const all = readAll()
  all[path.resolve(displayPath)] = { encoding, ...stamp }
  // 简单的 LRU：超上限时按 mtime 丢掉最旧的一半。
  const keys = Object.keys(all)
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => (all[a].mtimeMs ?? 0) - (all[b].mtimeMs ?? 0))
    for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete all[key]
  }
  writeAll(all)
}

/** 取回记忆的编码；指纹对不上返回 undefined。 */
export function recallEncoding(displayPath, stat) {
  if (typeof displayPath !== 'string') return undefined
  const key = path.resolve(displayPath)
  const all = readAll()
  const entry = all[key]
  if (entry === undefined || typeof entry.encoding !== 'string') return undefined
  /**
   * 表里这个词表外的名字**只可能来自旧版本**（现在写侧已经挡住了）。留着它，
   * 这个文件的每一次调用都会解码失败，而失败原因藏在表里看不见——所以直接抹掉这条，
   * 回到探测。记忆是加速器：**认不出来的记忆必须等于没有记忆**。
   */
  if (!isKnownEncodingName(entry.encoding)) {
    delete all[key]
    writeAll(all)
    return undefined
  }
  const stamp = stampOf(stat)
  if (stamp === null) return undefined
  if (entry.size !== stamp.size || entry.mtimeMs !== stamp.mtimeMs) return undefined
  return normalizeEncodingName(entry.encoding)
}
