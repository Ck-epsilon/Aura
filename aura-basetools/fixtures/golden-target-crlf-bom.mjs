/**
 * golden-target-crlf-bom —— 带 UTF-8 BOM 与 CRLF 行尾的夹具。
 *
 * 它钉的是"字节层的两件事"：提供方解码时剥掉**恰好一个**前导 BOM，
 * 而 CRLF 的行尾在回执里必须按源文件的样子出现（不能被悄悄归一成 LF）。
 */
export const MARKER = 'crlf-bom'

/** 逐行去掉行尾空白（不敢用 trim，怕把有意义的缩进也吃掉）。 */
export function stripTrailing(text) {
  return text.split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n')
}

export class CrlfReader {
  constructor(source) {
    this.source = source
    this.lines = source.split(/\r?\n/)
  }

  get count() {
    return this.lines.length
  }

  at(index) {
    return this.lines[index] ?? null
  }
}
