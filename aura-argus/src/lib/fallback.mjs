// 未注册实体的兜底：360 / 搜狗 的网页结果。只返回链接 + 摘要，不抓正文。
import { ArgusError, CODES } from './errors.mjs';
import { fetchRaw, UA } from './fetch.mjs';
import { collapse, decodeEntities, extractLinks, extractTitle, extractXmlLocs, htmlToMarkdown } from './text.mjs';
import { selectPassages, shortId } from './extract.mjs';
import { expandTerms } from './registry.mjs';
import { webSearch } from './web-search.mjs';
import { errorMarker, errorHint } from './answerability.mjs';

const TEXTUAL = /text\/html|application\/xhtml\+xml|text\/plain|text\/markdown|application\/json|application\/xml|text\/xml/i;

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

async function runEngine(base, query, parser, allowPrivate) {
  try {
    const url = `${base}${encodeURIComponent(query)}`;
    const page = await fetchRaw(url, { timeoutMs: 8_000, retries: 1, totalTimeoutMs: 12_000, allowPrivate });
    return parser(page.text).map((hit) => ({ ...hit, base }));
  } catch {
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

async function discoverSite(site, question, timeoutMs, allowPrivate) {
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
    const map = await fetchRaw(`https://${site}/sitemap.xml`, { timeoutMs, retries: 0, totalTimeoutMs: timeoutMs + 2_000, allowPrivate });
    const locs = extractXmlLocs(map.text);
    const nested = locs.filter((url) => /\.xml(?:$|\?)/i.test(url)).slice(0, 2);
    const nestedLocs = await Promise.all(nested.map(async (url) => {
      try {
        const page = await fetchRaw(url, { timeoutMs, retries: 0, totalTimeoutMs: timeoutMs + 2_000, allowPrivate });
        return extractXmlLocs(page.text);
      } catch { return []; }
    }));
    found.push(...collect([...locs.filter((url) => !/\.xml(?:$|\?)/i.test(url)), ...nestedLocs.flat()], 'sitemap'));
  } catch { /* 没 sitemap 就试首页链接 */ }
  if (!found.length) {
    try {
      const home = await fetchRaw(`https://${site}/`, { timeoutMs, retries: 0, totalTimeoutMs: timeoutMs + 2_000, allowPrivate });
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

async function fetchSiteEvidence(hit, question, timeoutMs, allowPrivate) {
  try {
    const page = await fetchRaw(hit.url, { timeoutMs, retries: 0, totalTimeoutMs: timeoutMs + 2_000, allowPrivate });
    const lines = htmlToMarkdown(page.text).split('\n').filter((line) => line.trim());
    const sourceId = shortId(page.finalUrl);
    const baseUrl = String(page.finalUrl).split('#')[0];
    const passages = selectPassages(lines, expandTerms(question), { max: 4 }).map((passage) => ({
      ...passage,
      id: shortId(`${baseUrl}\n${passage.headingPath || ''}\n${passage.text}`),
      sourceId,
      url: page.finalUrl,
      citation: passage.anchor ? `${baseUrl}#${passage.anchor}` : baseUrl,
    }));
    if (!passages.length) return null;
    return {
      id: sourceId,
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
async function fetchWebEvidence(hit, question, { timeoutMs, allowPrivate, provider }) {
  try {
    const page = await fetchRaw(hit.url, {
      timeoutMs,
      retries: 0,
      totalTimeoutMs: timeoutMs + 2_000,
      maxBytes: 2_000_000,
      allowPrivate,
    });
    if (!TEXTUAL.test(page.contentType || '')) return null;
    const lines = htmlToMarkdown(page.text).split('\n').filter((line) => line.trim());
    const sourceId = shortId(page.finalUrl);
    const baseUrl = String(page.finalUrl).split('#')[0];
    const passages = selectPassages(lines, expandTerms(question), { max: 4 }).map((passage) => ({
      ...passage,
      id: shortId(`${baseUrl}\n${passage.headingPath || ''}\n${passage.text}`),
      sourceId,
      url: page.finalUrl,
      citation: passage.anchor ? `${baseUrl}#${passage.anchor}` : baseUrl,
    }));
    if (!passages.length) return null;
    return {
      id: sourceId,
      url: page.finalUrl,
      title: extractTitle(page.text) || hit.title || '',
      site: new URL(page.finalUrl).hostname,
      origin: 'web-fallback',
      provider,
      passages,
    };
  } catch {
    return null;
  }
}

function snippetEvidence(hit, provider) {
  const url = hit.url;
  const text = String(hit.snippet || hit.title || '').trim();
  if (!url || !text) return null;
  const sourceId = shortId(url);
  return {
    id: sourceId,
    url,
    title: hit.title || '',
    site: (() => { try { return new URL(url).hostname; } catch { return ''; } })(),
    origin: 'web-fallback',
    provider,
    snippet: true,
    passages: [{
      id: shortId(`${url}\n${text}`),
      sourceId,
      url,
      citation: url,
      text: text.slice(0, 500),
      score: 1,
    }],
  };
}

export async function webFallback(question, { limit = 6, maxPages = 4, site = null, timeoutMs = 8_000, allowPrivate = false, signal = null } = {}) {
  const normalizedSite = normalizeSite(site);
  const query = normalizedSite ? `${question} site:${normalizedSite}` : question;
  if (normalizedSite) {
    const [so360, sogou] = await Promise.all([
      runEngine('https://www.so.com/s?q=', query, parse360, allowPrivate),
      runEngine('https://www.sogou.com/web?query=', query, parseSogou, allowPrivate),
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
      if (!siteMatch(host, normalizedSite)) continue;
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
    // 搜索引擎经常对 360/搜狗 返回空/验证码；官方站的 sitemap 是更稳的站内发现入口。
    const discovered = await discoverSite(normalizedSite, question, timeoutMs, allowPrivate);
    const seenUrls = new Set(results.map((entry) => entry.url));
    for (const entry of discovered) {
      if (seenUrls.has(entry.url)) continue;
      seenUrls.add(entry.url);
      results.unshift(entry);
    }
    const top = results.slice(0, 3);
    const detailed = await Promise.all(top.map((hit) => fetchSiteEvidence(hit, question, timeoutMs, allowPrivate)));
    const byUrl = new Map(detailed.filter(Boolean).map((entry) => [entry.url, entry]));
    return results
      .map((entry) => byUrl.get(entry.url) ?? entry)
      .filter((entry) => entry.passages?.length > 0)
      .slice(0, limit);
  }

  const marker = errorMarker(question);
  // 错误题把查询重写成“实体 + 错误码 + error fix”：中文疑问词会让引擎返回官网首页/教程页。
  let searchQuery = query;
  let required = [];
  if (marker) {
    const subject = String(question)
      .replace(/报错|错误|异常|怎么解决|怎么办|怎么处理|如何解决|怎么排查|怎么修|？|\?/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    searchQuery = `${subject} ${marker} error fix solution`;
    required = [marker.toLowerCase()];
  }
  const search = await webSearch(searchQuery, { limit: Math.max(limit * 2, 6), allowPrivate, signal, required });
  const hits = search.results.slice(0, Math.min(Math.max(1, maxPages), search.results.length));
  if (!hits.length) return [];
  const detailed = await Promise.all(hits.map((hit) => fetchWebEvidence(hit, question, {
    timeoutMs,
    allowPrivate,
    provider: search.provider,
  })));
  // 引擎索引里的摘要可能比实时页面新（或页面是 JS 渲染）：抓回来的正文缺错误码时，
  // 把摘要并进证据，保证错误码 + 解法至少有一段可引用文本。
  if (marker) {
    const markerLow = marker.toLowerCase();
    for (let index = 0; index < detailed.length; index += 1) {
      const entry = detailed[index];
      const snippet = hits[index]?.snippet || '';
      if (!entry || !snippet) continue;
      const hasMarker = entry.passages.some((passage) => String(passage.text || '').toLowerCase().includes(markerLow));
      if (!hasMarker && snippet.toLowerCase().includes(markerLow)) {
        entry.passages.push({
          id: shortId(`${entry.url}\n${snippet}`),
          sourceId: entry.id,
          url: entry.url,
          citation: entry.url,
          text: snippet.slice(0, 500),
          score: 1,
          kind: 'prose',
          snippet: true,
        });
      }
    }
  }
  const evidence = rerankForQuestion(detailed.filter(Boolean), question);
  if (evidence.length) return evidence;
  return rerankForQuestion(
    hits.map((hit) => snippetEvidence(hit, search.provider)).filter(Boolean),
    question,
  ).slice(0, Math.max(1, maxPages));
}

/**
 * 错误/版本题的兜底证据重排：错误码 + 可操作提示同段命中的来源排前，
 * 段落内同时含错误码与修复词的排前。否则搜索前几页常常只有错误码没有解法。
 */
function rerankForQuestion(evidence, question) {
  if (!Array.isArray(evidence) || evidence.length <= 1) return evidence;
  const marker = errorMarker(question);
  if (!marker) return evidence;
  const hint = errorHint(question);
  const markerLow = marker.toLowerCase();

  const passageRank = (passage) => {
    const text = String(passage?.text || '').toLowerCase();
    if (!text.includes(markerLow)) return 0;
    return hint.test(text) ? 3 : 1;
  };
  const scored = evidence.map((entry) => {
    const passages = [...(entry.passages || [])].sort((a, b) => passageRank(b) - passageRank(a));
    const best = passages.reduce((max, passage) => Math.max(max, passageRank(passage)), 0);
    return { entry, passages, best };
  });
  scored.sort((a, b) => b.best - a.best);
  return scored
    .filter(({ best }) => best > 0 || true)
    .map(({ entry, passages, best }) => (best > 0 ? { ...entry, passages } : entry));
}
