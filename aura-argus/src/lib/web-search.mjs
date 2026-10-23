// 自持兜底搜索：优先本地/自托管 SearXNG，其次多引擎 keyless HTML 适配。
// 这里只负责“发现 URL + 摘要”；正文抓取和引用由 fallback.mjs 统一处理。
import { fetchRaw } from './fetch.mjs';
import { collapse, decodeEntities } from './text.mjs';

const FAILURE_COOLDOWN_MS = 5 * 60_000;
const failures = new Map();

const clean = (value) => collapse(decodeEntities(String(value || '').replace(/<[^>]+>/g, ' ')));

const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'when', 'where', 'which', 'how', 'why', 'does', 'can', 'use', 'using', 'api', 'doc', 'docs', 'official', 'example', 'guide', 'best', 'from', 'that', 'this', 'are', 'you', 'your']);

function relevanceTokens(query) {
  const tokens = new Set();
  for (const match of String(query).toLowerCase().matchAll(/[a-z0-9][a-z0-9._-]{2,}/g)) {
    if (!STOP.has(match[0])) tokens.add(match[0]);
  }
  for (const match of String(query).matchAll(/[\u3400-\u9fff]{2,}/g)) {
    const text = match[0];
    if (text.length <= 6) tokens.add(text);
    for (let index = 0; index + 2 <= text.length; index += 2) tokens.add(text.slice(index, index + 2));
  }
  return [...tokens];
}

function relevantResults(results, query) {
  const tokens = relevanceTokens(query);
  if (!tokens.length) return true;
  return results.some((result) => {
    const text = `${result.title || ''} ${result.snippet || ''}`.toLowerCase();
    return tokens.some((token) => text.includes(token));
  });
}


function providerState(name) {
  const state = failures.get(name) || { count: 0, until: 0 };
  return state.until > Date.now() ? 'cooldown' : 'ready';
}

function noteFailure(name) {
  const state = failures.get(name) || { count: 0, until: 0 };
  state.count += 1;
  if (state.count >= 2) state.until = Date.now() + FAILURE_COOLDOWN_MS;
  failures.set(name, state);
}

function noteSuccess(name) {
  failures.delete(name);
}

export function providerHealth() {
  return [...new Set(['searxng', 'bing', 'so360', 'duckduckgo'])].map((name) => ({ name, state: providerState(name) }));
}

function decodeDdg(href, base = 'https://duckduckgo.com') {
  const value = href.startsWith('//') ? `https:${href}` : href;
  try {
    const parsed = new URL(value.replace(/&amp;/g, '&'), base);
    const target = parsed.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : parsed.href;
  } catch { return null; }
}

function decodeBing(href) {
  const raw = href.replace(/&amp;/g, '&');
  try {
    const parsed = new URL(raw, 'https://www.bing.com');
    const value = parsed.searchParams.get('u');
    if (value?.startsWith('a1')) {
      const base64 = value.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      return Buffer.from(base64, 'base64').toString('utf8');
    }
    return parsed.href;
  } catch { return null; }
}

function usefulUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    if (/^(?:www\.)?(?:bing|duckduckgo|so|sogou)\.com$/.test(url.hostname)) return null;
    if (/\.(?:pdf|zip|png|jpe?g|gif|svg|webp|ico|css|js|json|xml)$/i.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

export function parseBing(html) {
  const results = [];
  for (const block of String(html).split('<li class="b_algo"').slice(1)) {
    const title = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!title) continue;
    const href = usefulUrl(decodeBing(title[1]));
    if (!href) continue;
    const snippet = block.match(/class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/)
      || block.match(/class="b_caption"[\s\S]{0,800}?<p[^>]*>([\s\S]*?)<\/p>/);
    results.push({ url: href, title: clean(title[2]), snippet: clean(snippet?.[1] || '') });
  }
  return results;
}

export function parseDuckDuckGo(html) {
  const results = [];
  const anchors = [...String(html).matchAll(/class="result__a"[^>]*href="([^"]+)"/g)];
  for (let index = 0; index < anchors.length; index += 1) {
    const match = anchors[index];
    const href = usefulUrl(decodeDdg(match[1]));
    if (!href) continue;
    const slice = String(html).slice(match.index, anchors[index + 1]?.index ?? match.index + 3000);
    const snippet = slice.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/);
    results.push({ url: href, title: '', snippet: clean(snippet?.[1] || '') });
  }
  return results;
}

export function parse360(html) {
  const results = [];
  for (const block of String(html).split('<li class="res-list').slice(1)) {
    const title = block.match(/<h3[^>]*class="res-title[^"]*"[^>]*>\s*<a[^>]*data-mdurl="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!title) continue;
    const href = usefulUrl(decodeEntities(title[1]));
    if (!href) continue;
    const snippet = block.match(/<p class="res-desc"[^>]*>([\s\S]*?)<\/p>/);
    results.push({ url: href, title: clean(title[2]), snippet: clean(snippet?.[1] || '') });
  }
  return results;
}

async function engineSearch(name, query, { allowPrivate, signal }) {
  if (name === 'searxng') {
    const base = String(process.env.AURA_ARGUS_SEARXNG_URL || '').replace(/\/+$/, '');
    if (!base) return [];
    const page = await fetchRaw(`${base}/search?q=${encodeURIComponent(query)}&format=json&categories=general`, {
      timeoutMs: 10_000,
      totalTimeoutMs: 14_000,
      retries: 0,
      allowPrivate,
      signal,
      headers: { accept: 'application/json' },
    });
    let data;
    try { data = JSON.parse(page.text); } catch { return []; }
    return (Array.isArray(data.results) ? data.results : []).map((entry) => ({
      url: usefulUrl(entry.url),
      title: entry.title || '',
      snippet: entry.content || entry.snippet || '',
    })).filter((entry) => entry.url);
  }
  if (name === 'bing') {
    const page = await fetchRaw(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10&setlang=en`, {
      timeoutMs: 10_000,
      totalTimeoutMs: 14_000,
      retries: 1,
      allowPrivate,
      signal,
      headers: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    });
    return parseBing(page.text);
  }
  if (name === 'so360') {
    const page = await fetchRaw(`https://www.so.com/s?q=${encodeURIComponent(query)}`, {
      timeoutMs: 10_000,
      totalTimeoutMs: 14_000,
      retries: 1,
      allowPrivate,
      signal,
      headers: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    });
    return parse360(page.text);
  }
  if (name === 'duckduckgo') {
    const page = await fetchRaw(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      timeoutMs: 10_000,
      totalTimeoutMs: 14_000,
      retries: 0,
      allowPrivate,
      signal,
      headers: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    });
    return parseDuckDuckGo(page.text);
  }
  return [];
}

function configuredProviders(query = '') {
  const raw = String(process.env.AURA_ARGUS_WEB_PROVIDERS || '').split(',').map((item) => item.trim()).filter(Boolean);
  const cjk = /[\u3400-\u9fff]/.test(String(query));
  const defaults = cjk
    ? ['searxng', 'so360', 'bing', 'duckduckgo']
    : ['searxng', 'bing', 'so360', 'duckduckgo'];
  const requested = raw.length ? raw : defaults;
  return requested.filter((name) => ['searxng', 'bing', 'so360', 'duckduckgo'].includes(name));
}

/**
 * @param {string} query
 * @param {{limit?: number, allowPrivate?: boolean, signal?: AbortSignal, required?: string[]}} [options]
 * @returns {Promise<{provider: string|null, results: Array<{url:string,title:string,snippet:string}>, attempts: Array<{provider:string, count:number, error?:string}>}>}
 */
export async function webSearch(query, { limit = 10, allowPrivate = false, signal = null, required = [] } = {}) {
  const requiredTerms = (required || []).map((term) => String(term).toLowerCase()).filter(Boolean);
  const attempts = [];
  for (const provider of configuredProviders(query)) {
    if (providerState(provider) === 'cooldown') {
      attempts.push({ provider, count: 0, error: 'cooldown' });
      continue;
    }
    try {
      const results = await engineSearch(provider, query, { allowPrivate, signal });
      const unique = [];
      const seen = new Set();
      for (const result of results) {
        if (!result.url || seen.has(result.url)) continue;
        if (requiredTerms.length) {
          const haystack = `${result.url} ${result.title || ''} ${result.snippet || ''}`.toLowerCase();
          if (!requiredTerms.some((term) => haystack.includes(term))) continue;
        }
        seen.add(result.url);
        unique.push(result);
        if (unique.length >= limit) break;
      }
      if (unique.length && relevantResults(unique, query)) {
        noteSuccess(provider);
        attempts.push({ provider, count: unique.length });
        return { provider, results: unique, attempts };
      }
      const reason = unique.length ? 'irrelevant' : (requiredTerms.length ? 'no-required-term' : 'empty');
      attempts.push({ provider, count: unique.length, error: reason });
      // 冷却只给真实故障（网络错误/反爬页）；查询没命中不该拉黑 provider。
      // 连续跑错误题批时，聚焦查询经常在某引擎无结果，拉黑会让后续题全部失去兜底。
    } catch (error) {
      if (error?.code === 'ABORTED') throw error;
      noteFailure(provider);
      attempts.push({ provider, count: 0, error: error?.code || String(error?.message || error) });
    }
  }
  return { provider: null, results: [], attempts };
}
