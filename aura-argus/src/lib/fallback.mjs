// 未注册实体的兜底：360 / 搜狗 的网页结果。只返回链接 + 摘要，不抓正文。
import { ArgusError, CODES } from './errors.mjs';
import { fetchRaw, UA } from './fetch.mjs';
import { collapse, decodeEntities, extractTitle } from './text.mjs';

const clean = (s) => collapse(decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')));

async function resolveRedirect(href, base) {
  let url;
  try { url = new URL(href, base); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const isRedirector = /(^|\.)(so|sogou)\.com$/.test(url.hostname) && /^\/link/.test(url.pathname);
  if (!isRedirector) return url.href;
  try {
    const response = await fetch(url.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(6000),
      headers: { 'user-agent': UA, accept: 'text/html,*/*;q=0.8' },
    });
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) return null;
    const target = new URL(location, url);
    return target.protocol === 'http:' || target.protocol === 'https:' ? target.href : null;
  } catch {
    return null;
  }
}

function parse360(html) {
  const hits = [];
  for (const chunk of html.split(/class="res-list"/i).slice(1, 9)) {
    const title = chunk.match(/<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!title) continue;
    const desc = chunk.match(/class="res-desc"[^>]*>([\s\S]*?)<\/(?:p|div)>/i) || chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    hits.push({ href: title[1], title: clean(title[2]), snippet: desc ? clean(desc[1]) : '' });
  }
  return hits;
}

function parseSogou(html) {
  const hits = [];
  for (const chunk of html.split(/class="vrwrap"/i).slice(1, 9)) {
    const title = chunk.match(/<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!title) continue;
    const desc = chunk.match(/class="(?:text-layout|space-txt|str-text-info)"[^>]*>([\s\S]*?)<\/div>/i) || chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    hits.push({ href: title[1], title: clean(title[2]), snippet: desc ? clean(desc[1]) : '' });
  }
  return hits;
}

async function runEngine(base, query, parser) {
  try {
    const url = `${base}${encodeURIComponent(query)}`;
    const page = await fetchRaw(url, { timeoutMs: 8_000, retries: 1, totalTimeoutMs: 12_000 });
    return parser(page.text).map((hit) => ({ ...hit, base }));
  } catch (error) {
    if (error instanceof ArgusError) return [];
    return [];
  }
}

/**
 * 兜底网页搜索。返回 evidence 形状，失败时返回空数组（由调用方决定是否报 NO_EVIDENCE）。
 */
export async function webFallback(question, { limit = 6 } = {}) {
  const [so360, sogou] = await Promise.all([
    runEngine('https://www.so.com/s?q=', question, parse360),
    runEngine('https://www.sogou.com/web?query=', question, parseSogou),
  ]);
  const merged = [...so360, ...sogou].slice(0, limit * 2);
  const results = [];
  const seen = new Set();
  for (const hit of merged) {
    if (results.length >= limit) break;
    const url = await resolveRedirect(hit.href, hit.base);
    if (!url || seen.has(url)) continue;
    const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
    if (host === 'www.so.com' || host === 'www.sogou.com') continue;
    seen.add(url);
    const snippet = hit.snippet || hit.title;
    if (!snippet || snippet.length < 8) continue;
    results.push({
      url,
      title: hit.title || extractTitle(`<title>${snippet}</title>`),
      site: (() => { try { return new URL(url).hostname; } catch { return ''; } })(),
      passages: [{ text: snippet.slice(0, 500), score: 1 }],
    });
  }
  return results;
}
