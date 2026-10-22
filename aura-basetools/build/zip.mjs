/**
 * 极简 ZIP 写入器 —— 只为"把交付包发给人"这一个用途，零依赖。
 *
 * 为什么不用系统工具：交付对象是 macOS 用户，双击 `.command` 要求该文件带**可执行位**，
 * 而 Windows 自带压缩（Compress-Archive）不写 Unix 模式；ZIP 的外部属性字段能带上它，
 * 于是这里自己写容器：deflate 压缩（node:zlib）+ 外部属性带 0755/0644 + 文件名标 UTF-8
 * （中文文件名不加这个标志会变乱码）。校验靠外部解压器（macOS 归档工具 / unzip /
 * PowerShell Expand-Archive）真的解开对一遍，不靠自己读自己。
 *
 * 格式只实现需要的部分：本地文件头 + 中央目录 + EOCD，无 ZIP64（交付包远小于 4 GB）。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** DOS 时间戳：秒只有 2 秒精度，年份从 1980 起算 —— ZIP 的格式限制，不是我们的选择。 */
function dosStamp(date) {
  return {
    time: ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & 0xffff,
    date: (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff,
  }
}

/**
 * 写一个 zip。
 * @param entries - `[{ name, data, mode }]`；`name` 用 `/` 分隔的相对路径，`mode` 默认 0o644
 * @param outFile - 输出文件路径
 * @returns 条目数与总字节数
 */
export function writeZip(entries, outFile) {
  const stamp = dosStamp(new Date())
  const chunks = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const deflated = zlib.deflateRawSync(data, { level: 9 })
    const useDeflate = deflated.length < data.length
    const body = useDeflate ? deflated : data
    const method = useDeflate ? 8 : 0
    const crc = crc32(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4) // 解压所需版本
    header.writeUInt16LE(0x0800, 6) // 标志位：文件名为 UTF-8
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(stamp.time, 10)
    header.writeUInt16LE(stamp.date, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(body.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    header.writeUInt16LE(0, 28)
    chunks.push(header, nameBytes, body)
    central.push({ nameBytes, crc, method, compressed: body.length, size: data.length, offset, mode: entry.mode ?? 0o644 })
    offset += header.length + nameBytes.length + body.length
  }
  const centralStart = offset
  for (const item of central) {
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(0x031e, 4) // 生成方：Unix（3）× 版本 30 —— 外部属性里的模式位才有人认
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(item.method, 10)
    header.writeUInt16LE(stamp.time, 12)
    header.writeUInt16LE(stamp.date, 14)
    header.writeUInt32LE(item.crc, 16)
    header.writeUInt32LE(item.compressed, 20)
    header.writeUInt32LE(item.size, 24)
    header.writeUInt16LE(item.nameBytes.length, 28)
    header.writeUInt16LE(0, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt16LE(0, 34)
    header.writeUInt16LE(0, 36)
    header.writeUInt32LE((item.mode << 16) >>> 0, 38)
    header.writeUInt32LE(item.offset, 42)
    chunks.push(header, item.nameBytes)
    offset += header.length + item.nameBytes.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(central.length, 8)
  end.writeUInt16LE(central.length, 10)
  end.writeUInt32LE(offset - centralStart, 12)
  end.writeUInt32LE(centralStart, 16)
  end.writeUInt16LE(0, 20)
  chunks.push(end)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, Buffer.concat(chunks))
  return { entries: central.length, bytes: offset + end.length }
}

/** 递归列出目录下的普通文件，返回 `{ relative, absolute }`（`relative` 用 `/` 分隔）。 */
export function walkFiles(dir, base = dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full, base))
    else out.push({ relative: path.relative(base, full).replaceAll('\\', '/'), absolute: full })
  }
  return out.sort((a, b) => a.relative.localeCompare(b.relative))
}
