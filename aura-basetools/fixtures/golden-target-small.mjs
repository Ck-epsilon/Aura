/**
 * golden-target-small —— 单目标读回执黄金集的小样本夹具。
 *
 * 它是**固定输入**：判据比的是"同一份输入下回执是否逐字节不变"，
 * 因此这个文件一旦改动就等于换了一份夹具（黄金集必须重采）。
 */
import path from 'node:path'

const DEFAULTS = { limit: 8, prune: 8192 }

/** 把一行文本按给定分隔符切开。 */
export function splitRow(text, sep = ',') {
  if (typeof text !== 'string') return []
  return text.split(sep).map((cell) => cell.trim())
}

/**
 * 一个记账用的小容器：只保留最近 N 条。
 */
export class Ring {
  constructor(limit = DEFAULTS.limit) {
    this.limit = limit
    this.items = []
  }

  push(item) {
    this.items.push(item)
    if (this.items.length > this.limit) this.items.shift()
    return this.items.length
  }

  get latest() {
    return this.items.length === 0 ? null : this.items[this.items.length - 1]
  }
}

/** 目录提示：把绝对路径压成仓内相对路径。 */
export function relHint(target, root) {
  const rel = path.relative(root, target)
  return rel.split(path.sep).join('/')
}

export const VERSION = '0.6.9'
