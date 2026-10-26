/**
 * image-info.mjs — header-only dimensions from magic bytes (no decoding, no dependencies).
 *
 * WHERE TO CHANGE:
 *   imageInfo — add a format branch; recognized-but-short headers return IMAGE_HEADER_TRUNCATED
 *   isImagePath — the extension hint list; only formats imageInfo can parse belong here
 *
 * USED BY:
 *   (wiring layer: image read receipts; no call sites yet)
 */

// ── byte reader ──

function readerOf(input) {
  let bytes = null
  if (input instanceof Uint8Array) bytes = input
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input)
  if (bytes === null) return null
  const n = bytes.length
  const at = (i) => (i >= 0 && i < n ? bytes[i] : null)
  const u16le = (i) => {
    const a = at(i)
    const b = at(i + 1)
    return a === null || b === null ? null : a | (b << 8)
  }
  const u16be = (i) => {
    const a = at(i)
    const b = at(i + 1)
    return a === null || b === null ? null : (a << 8) | b
  }
  const u32be = (i) => {
    const a = at(i)
    const b = at(i + 1)
    const c = at(i + 2)
    const d = at(i + 3)
    return a === null || b === null || c === null || d === null ? null : ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
  }
  const u32le = (i) => {
    const a = at(i)
    const b = at(i + 1)
    const c = at(i + 2)
    const d = at(i + 3)
    return a === null || b === null || c === null || d === null ? null : (a | (b << 8) | (c << 16) | (d << 24)) >>> 0
  }
  const i32le = (i) => {
    const value = u32le(i)
    if (value === null) return null
    return value > 0x7fffffff ? value - 0x100000000 : value
  }
  const ascii = (i, length) => {
    let out = ''
    for (let k = 0; k < length; k += 1) {
      const value = at(i + k)
      if (value === null) return null
      out += String.fromCharCode(value)
    }
    return out
  }
  return { n, at, u16le, u16be, u32be, u32le, i32le, ascii }
}

// ── results ──

const ok = (r, mime, width, height, extra = {}) => ({ ok: true, mime, bytes: r.n, width, height, ...extra })
const truncated = (r, mime) => ({
  ok: false,
  code: 'IMAGE_HEADER_TRUNCATED',
  mime,
  bytes: r.n,
  message: `${mime} magic matched, but the header is too short to read dimensions`,
})
const notAnImage = (r) => ({ ok: false, code: 'NOT_AN_IMAGE', mime: null, bytes: r === null ? 0 : r.n })

// ── formats ──

function pngInfo(r) {
  if (r.n < 8) return null
  if (!(r.at(0) === 0x89 && r.ascii(1, 3) === 'PNG' && r.at(4) === 0x0d && r.at(5) === 0x0a && r.at(6) === 0x1a && r.at(7) === 0x0a)) return null
  let width = null
  let height = null
  let animated = false
  let offset = 8
  for (let guard = 0; guard < 64 && offset + 8 <= r.n; guard += 1) {
    const length = r.u32be(offset)
    const type = r.ascii(offset + 4, 4)
    if (length === null || type === null) return null
    if (type === 'IHDR') {
      if (length < 8 || offset + 16 > r.n) return { truncated: true }
      width = r.u32be(offset + 8)
      height = r.u32be(offset + 12)
      if (width === null || height === null) return { truncated: true }
    } else if (type === 'acTL') {
      animated = true
    } else if (type === 'IDAT') {
      break
    }
    // A chunk running past EOF means the file is short, but IHDR may already be complete.
    if (length > r.n) break
    offset += 12 + length
  }
  if (width === null) return { truncated: true }
  return { width, height, animated }
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function jpegInfo(r) {
  if (r.n < 2 || r.at(0) !== 0xff || r.at(1) !== 0xd8) return null
  let offset = 2
  while (offset + 3 < r.n) {
    if (r.at(offset) !== 0xff) {
      offset += 1
      continue
    }
    let marker = r.at(offset + 1)
    while (marker === 0xff) {
      offset += 1
      marker = r.at(offset + 1)
    }
    if (marker === null) break
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) break
    const length = r.u16be(offset + 2)
    if (length === null || length < 2) break
    if (SOF_MARKERS.has(marker)) {
      if (offset + 8 >= r.n) return { truncated: true }
      const height = r.u16be(offset + 5)
      const width = r.u16be(offset + 7)
      if (width === null || height === null) return { truncated: true }
      return { width, height }
    }
    offset += 2 + length
  }
  return { truncated: true }
}

function gifInfo(r) {
  if (r.n < 10) return null
  const magic = r.ascii(0, 6)
  if (magic !== 'GIF87a' && magic !== 'GIF89a') return null
  const width = r.u16le(6)
  const height = r.u16le(8)
  if (width === null || height === null) return { truncated: true }
  return { width, height }
}

function webpInfo(r) {
  if (r.n < 12 || r.ascii(0, 4) !== 'RIFF' || r.ascii(8, 4) !== 'WEBP') return null
  const chunk = r.ascii(12, 4)
  if (chunk === 'VP8 ') {
    if (r.n < 30) return { truncated: true }
    if (r.at(23) !== 0x9d || r.at(24) !== 0x01 || r.at(25) !== 0x2a) return { truncated: true }
    const width = r.u16le(26)
    const height = r.u16le(28)
    if (width === null || height === null) return { truncated: true }
    return { width: width & 0x3fff, height: height & 0x3fff }
  }
  if (chunk === 'VP8L') {
    if (r.n < 25) return { truncated: true }
    if (r.at(20) !== 0x2f) return { truncated: true }
    const b1 = r.at(21)
    const b2 = r.at(22)
    const b3 = r.at(23)
    const b4 = r.at(24)
    if (b1 === null || b2 === null || b3 === null || b4 === null) return { truncated: true }
    const width = 1 + (((b2 & 0x3f) << 8) | b1)
    const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6))
    return { width, height }
  }
  if (chunk === 'VP8X') {
    if (r.n < 30) return { truncated: true }
    const flags = r.at(20)
    if (flags === null) return { truncated: true }
    const width = 1 + (r.at(24) | (r.at(25) << 8) | (r.at(26) << 16))
    const height = 1 + (r.at(27) | (r.at(28) << 8) | (r.at(29) << 16))
    return { width, height, animated: (flags & 0x02) !== 0 }
  }
  return { truncated: true }
}

function bmpInfo(r) {
  if (r.n < 2 || r.at(0) !== 0x42 || r.at(1) !== 0x4d) return null
  if (r.n < 26) return { truncated: true }
  const dibSize = r.u32le(14)
  if (dibSize === null || dibSize < 40) return { truncated: true }
  const width = r.i32le(18)
  const height = r.i32le(22)
  if (width === null || height === null) return { truncated: true }
  return { width, height: Math.abs(height) }
}

// ── public ──

export function imageInfo(buffer) {
  const r = readerOf(buffer)
  if (r === null) return notAnImage(null)

  const parsers = [
    ['image/png', pngInfo],
    ['image/jpeg', jpegInfo],
    ['image/gif', gifInfo],
    ['image/webp', webpInfo],
    ['image/bmp', bmpInfo],
  ]
  for (const [mime, parse] of parsers) {
    const info = parse(r)
    if (info === null) continue
    if (info.truncated === true) return truncated(r, mime)
    return ok(r, mime, info.width, info.height, info.animated === undefined ? {} : { animated: info.animated })
  }
  return notAnImage(r)
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])

/** Extension hint only (png/jpg/jpeg/gif/webp/bmp — exactly what imageInfo parses). */
export function isImagePath(filePath) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(filePath ?? ''))
  return match !== null && IMAGE_EXTENSIONS.has(match[1].toLowerCase())
}
