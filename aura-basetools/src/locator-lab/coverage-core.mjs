/**
 * coverage-core.mjs —— 交付覆盖：哪些行**真的送到过调用方手里**。
 *
 * 它只回答一个问题：读的时候交付了哪些行、这次要替换哪些行，后者是否被前者覆盖。
 * 不碰 IO、不碰账本、不 import 任何模块（与 handle-core 一样是叶子），
 * 于是这条判据可以单独复核，也可以被读侧与写侧各调一次而不产生第二份实现。
 *
 * 区间在存储里是 `"12"` / `"12-20"` 这样的字符串（`observations.json` 里就是这两行字），
 * 解析、合并、求差只在本文件发生。
 */

// ── 解析 ────────────────────────────────────────────────────────────────────

/** `"12"` / `"12-20"` → `[12, 20]`；空、越界、倒序、非数字一律 null（坏数据当没交付）。 */
export function parseRange(label) {
  const text = typeof label === 'string' ? label.trim() : ''
  const match = /^(\d+)(?:-(\d+))?$/.exec(text)
  if (match === null) return null
  const start = Number(match[1])
  const end = match[2] === undefined ? start : Number(match[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
  if (start < 1 || end < start) return null
  return [start, end]
}

// ── 合并 ────────────────────────────────────────────────────────────────────

/** 任意形状的区间集合（字符串或 `[a,b]`）→ 排序、相邻合并后的 `[[a,b], ...]`。 */
export function coalesce(ranges) {
  const pairs = []
  for (const value of Array.isArray(ranges) ? ranges : []) {
    const pair = Array.isArray(value) ? value : parseRange(value)
    if (!Array.isArray(pair)) continue
    const start = Number(pair[0])
    const end = Number(pair[1])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) continue
    if (start < 1 || end < start) continue
    pairs.push([start, end])
  }
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out = []
  for (const [start, end] of pairs) {
    const last = out[out.length - 1]
    // 相邻（end+1）也算连续：两次读 `1-10` 与 `11-20` 合起来就是整份交付。
    if (last !== undefined && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else out.push([start, end])
  }
  return out
}

/** `[[a,b], ...]` → `["1-9", "12"]`（只用于回执与存储）。 */
export function formatRanges(ranges) {
  return coalesce(ranges).map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`))
}

/** 两组存储标签的并集（同一版本多次读的累积）。 */
export function mergeLabels(existing, incoming) {
  return formatRanges([
    ...(Array.isArray(existing) ? existing : []),
    ...(Array.isArray(incoming) ? incoming : []),
  ])
}

// ── 判据 ────────────────────────────────────────────────────────────────────

/**
 * `delivered` 覆盖 `[start, end]` 时返回 `[]`，否则返回**没交付**的那些区间。
 * 空覆盖 ⇒ 整段都是缺口（这是 probe / map 读之后的状态）。
 */
export function missingRanges(delivered, start, end) {
  const from = Number.isSafeInteger(start) ? start : 1
  const to = Number.isSafeInteger(end) ? end : from
  if (to < from) return []
  const gaps = []
  let cursor = from
  for (const [a, b] of coalesce(delivered)) {
    if (b < cursor) continue
    if (a > to) break
    if (a > cursor) gaps.push([cursor, Math.min(a - 1, to)])
    cursor = Math.max(cursor, b + 1)
    if (cursor > to) break
  }
  if (cursor <= to) gaps.push([cursor, to])
  return gaps
}
