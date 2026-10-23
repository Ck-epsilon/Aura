// 有界发现：robots/sitemap 递归 + 同站链接候选。只发现 URL，不返回证据。
import { extractXmlLocs } from './text.mjs';

const sitemapCache = new Map();
const DEFAULT_TTL_MS = 6 * 60 * 60_000;

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function rootOf(host) {
  return host.split('.').slice(-2).join('.');
}

function allowedHost(host, roots) {
  const low = String(host || '').toLowerCase();
  return [...roots].some((root) => low === root || low.endsWith(`.${root}`));
}

export function clearDiscoveryCache() {
  sitemapCache.clear();
}

function parseRobotsSitemaps(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .map((line) => line.match(/^sitemap:\s*(\S+)/i)?.[1])
    .filter(Boolean);
}

/**
 * 从 seed URL 的 robots.txt / sitemap.xml 递归收集同站 URL。
 * @param {{seeds: string[], fetchText: (url:string)=>Promise<string>, maxDepth?: number, maxSitemaps?: number, maxUrls?: number, ttlMs?: number}} options
 */
export async function collectSitemapUrls({
  seeds,
  fetchText,
  maxDepth = 2,
  maxSitemaps = 20,
  maxUrls = 5000,
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  const validSeeds = (seeds || []).filter((seed) => {
    try { return /^https?:$/.test(new URL(seed).protocol); } catch { return false; }
  });
  if (!validSeeds.length) return { urls: [], sitemaps: 0, cached: false, roots: [] };
  const origin = new URL(validSeeds[0]).origin;
  const roots = new Set(validSeeds.map((seed) => rootOf(hostOf(seed))).filter(Boolean));
  const cacheKey = `${origin}|${[...roots].join(',')}`;
  const cached = sitemapCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return { ...cached.value, cached: true };
  }

  const sitemapQueue = [];
  try {
    const robots = await fetchText(`${origin}/robots.txt`);
    for (const url of parseRobotsSitemaps(robots)) {
      if (allowedHost(hostOf(url), roots)) sitemapQueue.push({ url, depth: 0 });
    }
  } catch { /* robots is optional */ }
  if (!sitemapQueue.length) {
    sitemapQueue.push({ url: `${origin}/sitemap.xml`, depth: 0 });
    sitemapQueue.push({ url: `${origin}/sitemap-index.xml`, depth: 0 });
    sitemapQueue.push({ url: `${origin}/sitemap_index.xml`, depth: 0 });
  }

  const seenSitemaps = new Set();
  const seenUrls = new Set();
  let sitemaps = 0;
  let depthReached = 0;
  while (sitemapQueue.length && sitemaps < Math.max(1, maxSitemaps) && seenUrls.size < Math.max(1, maxUrls)) {
    const current = sitemapQueue.shift();
    if (seenSitemaps.has(current.url)) continue;
    seenSitemaps.add(current.url);
    if (current.depth > maxDepth) continue;
    let xml;
    try { xml = await fetchText(current.url); } catch { continue; }
    if (!/<(?:urlset|sitemapindex)\b/i.test(xml)) continue;
    sitemaps += 1;
    depthReached = Math.max(depthReached, current.depth);
    const locs = extractXmlLocs(xml);
    const isIndex = /<sitemapindex\b/i.test(xml) || (locs.length > 0 && locs.every((url) => /\.xml(?:\.gz)?$/i.test(url)));
    if (isIndex && current.depth < maxDepth) {
      for (const url of locs) {
        if (allowedHost(hostOf(url), roots)) sitemapQueue.push({ url, depth: current.depth + 1 });
        if (sitemapQueue.length + sitemaps >= Math.max(1, maxSitemaps)) break;
      }
      continue;
    }
    for (const url of locs) {
      if (!allowedHost(hostOf(url), roots)) continue;
      if (!/^https?:\/\//i.test(url)) continue;
      if (/\.(?:pdf|zip|png|jpe?g|gif|svg|webp|ico|css|js|json)$/i.test(new URL(url).pathname)) continue;
      seenUrls.add(url.split('#')[0]);
      if (seenUrls.size >= Math.max(1, maxUrls)) break;
    }
  }

  const value = { urls: [...seenUrls], sitemaps, depth: depthReached, roots: [...roots] };
  sitemapCache.set(cacheKey, { expires: Date.now() + ttlMs, value });
  return { ...value, cached: false };
}

const POSITIVE_PATH = /(?:^|\/)(?:docs?|reference|guide|guides|handbook|tasks|configure|concepts|module|modules|release-notes|probes|compose-file|services|api)(?:\/|$)/i;
const NEGATIVE_PATH = /(?:^|\/)(?:login|signin|signup|subscribe|newsletter|download|pricing|blog|community|search|account|cart|checkout)(?:\/|$)/i;
const GENERIC_DISCOVERY = new Set([
  'api', 'configuration', 'configure', 'create', 'deploy', 'docs', 'documentation',
  'example', 'guide', 'install', 'settings', 'usage', 'using', 'version',
]);

function subTokens(term) {
  return String(term)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length >= 3);
}

const TOKEN_HINTS = [
  'liveness', 'readiness', 'startup', 'probe', 'health', 'check',
  'proxy', 'pass', 'release', 'notes', 'configure', 'configuration',
  'settings', 'service', 'deploy', 'deployment', 'operator', 'index',
];

function termTokens(term) {
  const low = String(term).toLowerCase();
  const tokens = new Set(subTokens(term));
  for (const hint of TOKEN_HINTS) {
    if (low.includes(hint)) tokens.add(hint);
  }
  return [...tokens];
}

export function rankCandidates(urls, { missing = [], terms = [], limit = 8 } = {}) {
  const out = [];
  const seen = new Set();
  const missingSource = missing.map((term) => String(term)).filter(Boolean);
  const termSource = Array.isArray(terms) ? terms : [...terms];
  const termList = termSource.map((term) => String(term).toLowerCase()).filter((term) => term.length >= 3);
  for (const url of urls || []) {
    const key = url.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    let parsed;
    try { parsed = new URL(key); } catch { continue; }
    const low = key.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    let score = 0;
    for (const original of missingSource) {
      const term = original.toLowerCase();
      const generic = GENERIC_DISCOVERY.has(term);
      if (path.includes(term)) score += generic ? 4 : 30;
      else if (low.includes(term)) score += generic ? 2 : 10;
      if (generic) continue;
      let tokenScore = 0;
      for (const token of termTokens(original)) {
        if (path.includes(token)) tokenScore += 8;
      }
      score += Math.min(20, tokenScore);
    }
    for (const term of termList) {
      if (path.includes(term)) score += 4;
      else if (low.includes(term)) score += 2;
    }
    if (POSITIVE_PATH.test(path)) score += 4;
    if (/(?:^|\/)compose-file(?:\/|$)/i.test(path)) score += 8;
    if (/(?:^|\/)services(?:\/|$)/i.test(path)) score += 6;
    if (/(?:^|\/)probes?(?:\/|$)/i.test(path)) score += 8;
    if (/(?:^|\/)proxy_module(?:\/|$)/i.test(path)) score += 8;
    if (/(?:^|\/)release-notes(?:\/|$)/i.test(path)) score += 5;
    if (/(?:^|\/)(?:fr|de|id|bn|ja|ko|ru|es|pt-br|uk|vi|fa|pl|hi|it|ca)(?:\/|$)/i.test(path)) score -= 4;
    if (/(?:^|\/)cli(?:\/|$)/i.test(path)) score -= 4;
    if (/(?:^|\/)alpha(?:\/|$)/i.test(path)) score -= 3;
    if (NEGATIVE_PATH.test(path)) score -= 12;
    score += Math.min(4, path.split('/').filter(Boolean).length);
    if (path === '/' || path === '') score -= 20;
    if (score > 0) out.push({ url: key, score });
  }
  return out.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url)).slice(0, Math.max(1, limit));
}

export function rankLinkCandidates(links, { missing = [], terms = [], limit = 8 } = {}) {
  const missingList = missing.map((term) => String(term).toLowerCase()).filter(Boolean);
  const termSource = Array.isArray(terms) ? terms : [...terms];
  const termList = termSource.map((term) => String(term).toLowerCase()).filter((term) => term.length >= 3);
  const out = [];
  const seen = new Set();
  for (const link of links || []) {
    if (!link?.href) continue;
    const key = link.href.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    const text = String(link.text || '').toLowerCase();
    let textScore = 0;
    for (const term of missingList) if (text.includes(term)) textScore += 12;
    for (const term of termList) if (text.includes(term)) textScore += 2;
    const ranked = rankCandidates([key], { missing, terms, limit: 1 })[0];
    const score = (ranked?.score || 0) + textScore;
    if (score > 0) out.push({ url: key, score });
  }
  return out.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url)).slice(0, Math.max(1, limit));
}
