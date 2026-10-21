// 取回层：校验 URL、私网拦截、限大小、限时、重试；再转成文档（title + markdown）。
import dns from 'node:dns/promises';
import net from 'node:net';
import { ArgusError, CODES } from './errors.mjs';
import { extractTitle, htmlToMarkdown } from './text.mjs';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export function validateUrl(input) {
  let url;
  try { url = new URL(String(input)); } catch { throw new ArgusError(CODES.BAD_URL, `not a valid URL: ${input}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ArgusError(CODES.BAD_URL, `unsupported scheme: ${url.protocol}`);
  }
  if (url.username || url.password) throw new ArgusError(CODES.BAD_URL, 'URL must not contain credentials');
  if (!url.hostname) throw new ArgusError(CODES.BAD_URL, 'URL has no host');
  return url;
}

const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal', 'metadata.goog', 'instance-data']);
const BLOCKED_V4 = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0x64400000, 0x647fffff], // 100.64.0.0/10
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0000000, 0xc00000ff], // 192.0.0.0/24
  [0xc0000200, 0xc00002ff], // 192.0.2.0/24
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
  [0xc6120000, 0xc613ffff], // 198.18.0.0/15
  [0xc6336400, 0xc63364ff], // 198.51.100.0/24
  [0xcb007100, 0xcb0071ff], // 203.0.113.0/24
  [0xe0000000, 0xefffffff], // 224.0.0.0/4
  [0xf0000000, 0xffffffff], // 240.0.0.0/4
];

function ipv4ToInt(ip) {
  return ip.split('.').reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

function isPrivateIPv4(ip) {
  const value = ipv4ToInt(ip);
  return BLOCKED_V4.some(([start, end]) => value >= start && value <= end);
}

function isPrivateIPv6(raw) {
  let ip = raw.toLowerCase().replace(/^\[|\]$/g, '');
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  if (ip === '::' || ip === '::1') return true;
  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice(7);
    return net.isIP(mapped) === 4 ? isPrivateIPv4(mapped) : true;
  }
  const first = ip.split(':')[0];
  if (first.startsWith('fc') || first.startsWith('fd')) return true; // fc00::/7
  if (first.startsWith('fe8') || first.startsWith('fe9') || first.startsWith('fea') || first.startsWith('feb')) return true; // fe80::/10
  if (first.startsWith('ff')) return true; // ff00::/8
  if (first === '2001' && ip.startsWith('2001:db8')) return true; // documentation
  return false;
}

function isPrivateAddress(address) {
  const version = net.isIP(address);
  if (version === 4) return isPrivateIPv4(address);
  if (version === 6) return isPrivateIPv6(address);
  return false;
}

/**
 * Reject loopback/private/link-local/metadata targets unless explicitly opted in.
 * DNS is resolved before the request; redirects are re-checked by the caller.
 */
export async function assertPublicUrl(input, { allowPrivate = false } = {}) {
  const url = input instanceof URL ? input : validateUrl(input);
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || BLOCKED_HOSTS.has(host)) {
    throw new ArgusError(CODES.PRIVATE_ADDRESS, `blocked private host: ${host}`, { host });
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new ArgusError(CODES.PRIVATE_ADDRESS, `blocked private address: ${host}`, { host });
    return url;
  }
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    return url; // unresolved names fail at fetch time with a network error
  }
  const blocked = addresses.find((entry) => isPrivateAddress(entry.address));
  if (blocked) throw new ArgusError(CODES.PRIVATE_ADDRESS, `blocked private address for ${host}: ${blocked.address}`, { host, address: blocked.address });
  return url;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
}

function backoffMs(attempt, retryAfterMs, { retryBaseMs, retryMaxMs, deadline }) {
  const exponential = Math.min(retryMaxMs, retryBaseMs * 2 ** attempt);
  const jittered = exponential * (0.5 + Math.random() * 0.5);
  const wait = Math.max(jittered, Math.min(retryAfterMs, retryMaxMs));
  const remaining = deadline - Date.now();
  return Math.max(0, Math.min(wait, Math.max(0, remaining - 100)));
}

/**
 * 带重试的取回。重试条件：网络错误 / 超时 / 408、425、429、5xx；其余 4xx 不重试。
 * 默认拒绝私网；重定向逐跳复检；总耗时受 totalTimeoutMs 约束。
 *
 * @param {string} input
 * @param {{ timeoutMs?: number, retries?: number, totalTimeoutMs?: number, maxBytes?: number, headers?: Record<string,string>, retryBaseMs?: number, retryMaxMs?: number, allowPrivate?: boolean }} [options]
 */
export async function fetchRaw(input, {
  timeoutMs = 12_000,
  retries = 2,
  totalTimeoutMs = Math.max(20_000, timeoutMs * 2),
  maxBytes = 5_000_000,
  headers = {},
  retryBaseMs = 300,
  retryMaxMs = 3_000,
  allowPrivate = false,
} = {}) {
  const url = validateUrl(input);
  const startAll = Date.now();
  const deadline = startAll + totalTimeoutMs;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const tries = attempt + 1;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      lastError = new ArgusError(CODES.TIMEOUT, `total timeout ${totalTimeoutMs}ms: ${url.href}`, { url: url.href, totalTimeoutMs, tries });
      break;
    }
    const attemptTimeout = Math.min(timeoutMs, remaining);

    try {
      let current = url;
      let response;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        await assertPublicUrl(current, { allowPrivate });
        response = await fetch(current.href, {
          redirect: 'manual',
          signal: AbortSignal.timeout(attemptTimeout),
          headers: {
            'user-agent': UA,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.7,*/*;q=0.6',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            ...headers,
          },
        });
        if (!REDIRECT_STATUS.has(response.status)) break;
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new ArgusError(CODES.HTTP_ERROR, `redirect without location: ${current.href}`, { status: response.status, url: current.href });
        if (hop === MAX_REDIRECTS) throw new ArgusError(CODES.TOO_MANY_REDIRECTS, `too many redirects: ${url.href}`, { url: url.href, max: MAX_REDIRECTS });
        current = new URL(location, current);
      }

      const length = Number(response.headers.get('content-length') || 0);
      if (length > maxBytes) {
        await response.body?.cancel();
        throw new ArgusError(CODES.TOO_LARGE, `response too large: ${length} bytes`, { bytes: length, maxBytes, tries });
      }

      if (!response.ok) {
        const status = response.status;
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        await response.body?.cancel();
        lastError = new ArgusError(CODES.HTTP_ERROR, `HTTP ${status} for ${current.href}`, { status, url: current.href, tries, retryAfterMs });
        if (RETRYABLE_STATUS.has(status) && attempt < retries) {
          await sleep(backoffMs(attempt, retryAfterMs, { retryBaseMs, retryMaxMs, deadline }));
          continue;
        }
        throw lastError;
      }

      const text = await response.text();
      const bytes = Buffer.byteLength(text);
      if (bytes > maxBytes) throw new ArgusError(CODES.TOO_LARGE, `response too large: ${bytes} bytes`, { bytes, maxBytes, tries });
      return {
        url: url.href,
        finalUrl: current.href,
        status: response.status,
        contentType: response.headers.get('content-type') || '',
        text,
        bytes,
        ms: Date.now() - startAll,
        tries,
      };
    } catch (error) {
      if (error instanceof ArgusError) {
        if (error.code === CODES.TIMEOUT && attempt < retries) {
          lastError = error;
          await sleep(backoffMs(attempt, 0, { retryBaseMs, retryMaxMs, deadline }));
          continue;
        }
        throw error;
      }
      const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      lastError = isTimeout
        ? new ArgusError(CODES.TIMEOUT, `timeout after ${attemptTimeout}ms: ${url.href}`, { url: url.href, timeoutMs: attemptTimeout, tries })
        : new ArgusError(CODES.FETCH_FAILED, `fetch failed: ${error?.cause?.code || error?.message || error}`, { url: url.href, tries });
      if (attempt < retries) {
        await sleep(backoffMs(attempt, 0, { retryBaseMs, retryMaxMs, deadline }));
        continue;
      }
      throw lastError;
    }
  }

  throw lastError;
}

const TEXTUAL = /text\/html|application\/xhtml\+xml|text\/plain|text\/markdown|application\/json|application\/xml|text\/xml/i;

/**
 * 取回一页并转成可读文档。非文本类型直接拒绝。
 */
export async function fetchDocument(input, { maxChars = 20_000, timeoutMs = 12_000, format = 'markdown', headers = {}, allowPrivate = false } = {}) {
  const started = Date.now();
  const raw = await fetchRaw(input, { timeoutMs, headers, allowPrivate });
  if (!TEXTUAL.test(raw.contentType)) {
    throw new ArgusError(CODES.UNSUPPORTED_CONTENT_TYPE, `unsupported content-type: ${raw.contentType || 'unknown'}`, {
      contentType: raw.contentType,
      url: raw.finalUrl,
    });
  }
  const isHtml = /html|xhtml/i.test(raw.contentType);
  const title = isHtml ? extractTitle(raw.text) : '';
  const body = isHtml && format === 'markdown' ? htmlToMarkdown(raw.text) : raw.text;
  const truncated = body.length > maxChars;
  const text = truncated ? body.slice(0, maxChars) : body;
  return {
    schemaVersion: 1,
    url: raw.url,
    finalUrl: raw.finalUrl,
    status: raw.status,
    title,
    text,
    chars: text.length,
    truncated,
    contentType: raw.contentType,
    tookMs: Date.now() - started,
  };
}
