// 未注册实体的兜底：360 / 搜狗 的网页结果。只返回链接 + 摘要，不抓正文。
import { ArgusError, CODES } from './errors.mjs';
import { fetchRaw, UA } from './fetch.mjs';
import { collapse, decodeEntities, extractLinks, extractTitle, extractXmlLocs, htmlToMarkdown } from './text.mjs';
import { selectPassages } from './extract.mjs';
import { expandTerms } from './registry.mjs';

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
export function normalizeSite(value) {
  if (value === undefined || value === null || value === '') return null;
  let site = String(value).trim().toLowerCase();
  site = site.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(site)) {
    throw new ArgusError(CODES.BAD_REQUEST, `invalid site domain: ${value}`, { site: String(value) });
  }
  return site;
}

function siteMatch(host, site) {
  return host === site || host.endsWith(`.${site}`);
}

async function discoverSite(site, question, timeoutMs) {
  const terms = [...expandTerms(question)];
  const score = (url) => {
    const low = url.toLowerCase();
    let value = terms.reduce((sum, term) => sum + (term.length >= 3 && low.includes(term) ? 3 : 0), 0);
    // 官方站里 blog/news 常比 docs/api 更容易命中词面；显式偏向文档路径。
    if (/\/(docs?|api|manual|reference|guide|learn|handbook)\//i.test(low)) value += 5;
    if (/\/(blog|news|community|events|podcast)\//i.test(low)) value -= 4;
    return value;
  };
  const collect = (urls, source) => urls
    .filter((url) => { try { return siteMatch(new URL(url).hostname, site); } catch { return false; } })
    .map((url) => ({ url, title: '', score: score(url), source }));

  const found = [];
  try {
    const map = await fetchRaw(`https://${site}/sitemap.xml`, { timeoutMs, retries: 0, totalTimeoutMs: timeoutMs + 2_000 });
    const locs = extractXmlLocs(map.text);
    const nested = locs.filter((url) => /\.xml(?:$|\?)/i.test(url)).slice(0, 2);
    const nestedLocs = await Promise.all(nested.map(async (url) => {
      try {
        const page = await fetchRaw(url, { timeoutMs, retries: 0, totalTimeoutMs: timeoutMs + 2_000 });
        return extractXmlLocs(page.text);
      } catch { return []; }
    }));
    found.push(...collect([...locs.filter((url) => !/\.xml(?:$|\?)/i.test(url)), ...nestedLocs.flat()], 'sitemap'));
  } catch { /* 没 sitemap 就试首页链接 */ }
  if (!found.length) {
    try {
      const home = await fetchRaw(`https://${site}/`, { timeoutMs, retries: 0, totalTimeoutMs: timeoutMs + 2_000 });
      found.push(...collect(extractLinks(home.text, home.finalUrl).map((link) => link.href), 'home'));
    } catch { /* 站点不可达，返回空 */ }
  }
  const ranked = found
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .filter((item, index, all) => all.findIndex((other) => other.url === item.url) === index)
    .slice(0, 3);
  return ranked.map((item) => ({ url: item.url, title: item.title, site, passages: [] }));
}

async function fetchSiteEvidence(hit, question, timeoutMs) {
  try {
    const page = await fetchRaw(hit.url, { timeoutMs, retries: 0, totalTimeoutMs: timeoutMs + 2_000 });
    const lines = htmlToMarkdown(page.text).split('\n').filter((line) => line.trim());
    const passages = selectPassages(lines, expandTerms(question), { max: 4 });
    if (!passages.length) return null;
    return {
      url: page.finalUrl,
      title: extractTitle(page.text) || hit.title || '',
      site: new URL(page.finalUrl).hostname,
      passages,
    };
  } catch {
    return null;
  }
}

/**
 * 兜底网页搜索。返回 evidence 形状，失败时返回空数组（由调用方决定是否报 NO_EVIDENCE）。
 *
 * `site` 是**站点边界**：它把搜索限制到该域，并抓取前两条结果正文做证据，
 * 而不是只返回搜索摘要。这使未注册实体也能在指定官方站内得到可引用段落。
 */
export async function webFallback(question, { limit = 6, site = null, timeoutMs = 8_000 } = {}) {
  const normalizedSite = normalizeSite(site);
  const query = normalizedSite ? `${question} site:${normalizedSite}` : question;
  const [so360, sogou] = await Promise.all([
    runEngine('https://www.so.com/s?q=', query, parse360),
    runEngine('https://www.sogou.com/web?query=', query, parseSogou),
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
    if (normalizedSite && !siteMatch(host, normalizedSite)) continue;
    seen.add(url);
    const snippet = hit.snippet || hit.title;
    if (!snippet || snippet.length < 8) continue;
    results.push({
      url,
      title: hit.title || extractTitle(`<title>${snippet}</title>`),
      site: host,
      passages: [{ text: snippet.slice(0, 500), score: 1 }],
    });
  }
  if (normalizedSite) {
    // 搜索引擎经常对 360/搜狗 返回空/验证码；官方站的 sitemap 是更稳的站内发现入口。
    // 即使搜索有结果也补一次 sitemap：搜索摘要常常不是可引用正文。
    const discovered = await discoverSite(normalizedSite, question, timeoutMs);
    const seenUrls = new Set(results.map((entry) => entry.url));
    for (const entry of discovered) {
      if (seenUrls.has(entry.url)) continue;
      seenUrls.add(entry.url);
      results.unshift(entry);
    }
    const top = results.slice(0, 3);
    const detailed = await Promise.all(top.map((hit) => fetchSiteEvidence(hit, question, timeoutMs)));
    const byUrl = new Map(detailed.filter(Boolean).map((entry) => [entry.url, entry]));
    return results
      .map((entry) => byUrl.get(entry.url) ?? entry)
      .filter((entry) => entry.passages?.length > 0)
      .slice(0, limit);
  }
  return results;
}
