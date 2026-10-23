// 检索编排：注册表命中 → 抓官方源 → 选段；未命中 → 网页兜底。
import { Cache } from './cache.mjs';
import { ArgusError, CODES } from './errors.mjs';
import { fetchRaw } from './fetch.mjs';
import { PageCache } from './page-cache.mjs';
import { extractLinks, extractTitle, extractXmlLocs, htmlToMarkdown } from './text.mjs';
import { selectPassages, shortId, GENERIC_TERMS } from './extract.mjs';
import { qualityFor, facetTerms } from './quality.mjs';
import { extractFacts } from './facts.mjs';
import { buildConsensus } from './consensus.mjs';
import { collectSitemapUrls, rankCandidates, rankLinkCandidates } from './discover.mjs';
import { isAnswerable } from './answerability.mjs';
import { searchIndex } from './index-store.mjs';
import { planQuery } from './plan.mjs';
import { applyVersionRules, resolveVersion } from './versions.mjs';
import { coverageVersion, expandTerms, getCoverage, matchEntities, matchEntity, rankSources, registryVersion } from './registry.mjs';
import { normalizeSite, webFallback } from './fallback.mjs';
import { defaultCacheDir } from './paths.mjs';
import { logQuery } from './query-log.mjs';
import { withHostSlot } from './host-limit.mjs';


let sharedCache = null;
function getCache(options) {
  if (options.cache === false) return null;
  if (!sharedCache) {
    sharedCache = new Cache({
      dir: defaultCacheDir(),
      ttlMs: 15 * 60_000,
      enabled: process.env.AURA_ARGUS_NO_CACHE !== '1',
    });
  }
  return sharedCache;
}

const pageCaches = new Map();
function getPageStore(options) {
  if (options.cache === false) return null;
  const dir = options.pageCacheDir || defaultCacheDir();
  const ttlMs = Number(options.pageCacheTtlMs ?? process.env.AURA_ARGUS_PAGE_TTL_MS ?? 6 * 60 * 60_000);
  const key = `${dir}|${ttlMs}`;
  if (!pageCaches.has(key)) {
    pageCaches.set(key, new PageCache({
      dir,
      ttlMs,
      enabled: process.env.AURA_ARGUS_NO_CACHE !== '1',
    }));
  }
  return pageCaches.get(key);
}

// 进程内页面缓存 + in-flight 去重：同一 URL 在一批问题里只抓一次。
const pageCache = new Map();
const inFlightPages = new Map();
const PAGE_TTL_MS = 10 * 60_000;
const PAGE_MAX = 120;

async function getPage(url, ctx) {
  const { timeoutMs, useCache, allowPrivate, store, signal } = ctx;
  const maxHost = Number(process.env.AURA_ARGUS_HOST_CONCURRENCY ?? 4);
  const fetchLimited = (requestUrl, options) => withHostSlot(
    requestUrl,
    () => fetchRaw(requestUrl, options),
    { max: maxHost, signal },
  );
  if (!useCache) return { ...(await fetchLimited(url, { timeoutMs, allowPrivate, signal })), cache: 'bypass' };

  // 私网窗口与公开窗口分开缓存，避免同进程内把内网页面回给未授权的调用。
  const key = `${allowPrivate ? 'private' : 'public'}:${url}`;
  if (ctx.memoryCache !== false) {
    const hit = pageCache.get(key);
    if (hit && hit.expires > Date.now()) return { ...hit.page, cache: 'memory' };
  }
  if (store) {
    const disk = store.get(url, { allowPrivate });
    if (disk?.fresh) {
      if (ctx.memoryCache !== false) pageCache.set(key, { expires: Date.now() + PAGE_TTL_MS, page: disk.page });
      return { ...disk.page, cache: 'page' };
    }
    if (disk) {
      const pendingKey = `revalidate:${key}`;
      const pending = inFlightPages.get(pendingKey);
      if (pending) return pending;
      const promise = fetchLimited(url, {
        timeoutMs,
        allowPrivate,
        validators: { etag: disk.etag, lastModified: disk.lastModified },
        signal,
      })
        .then((fresh) => {
          if (fresh.notModified) {
            store.touch(url, { allowPrivate });
            const page = { ...disk.page, ms: fresh.ms, tries: fresh.tries, cache: 'page-revalidated' };
            if (ctx.memoryCache !== false) pageCache.set(key, { expires: Date.now() + PAGE_TTL_MS, page });
            return page;
          }
          store.set(url, fresh, { allowPrivate });
          const page = { ...fresh, cache: 'page-miss' };
            if (ctx.memoryCache !== false) pageCache.set(key, { expires: Date.now() + PAGE_TTL_MS, page });
          return page;
        })
        .finally(() => inFlightPages.delete(pendingKey));
      inFlightPages.set(pendingKey, promise);
      return promise;
    }
  }

  const pending = inFlightPages.get(key);
  if (pending) return pending;
  const promise = fetchLimited(url, { timeoutMs, allowPrivate, signal })
    .then((page) => {
      if (store) store.set(url, page, { allowPrivate });
      if (ctx.memoryCache !== false) pageCache.set(key, { expires: Date.now() + PAGE_TTL_MS, page });
      if (pageCache.size > PAGE_MAX) pageCache.delete(pageCache.keys().next().value);
      return { ...page, cache: 'miss' };
    })
    .finally(() => inFlightPages.delete(key));
  inFlightPages.set(key, promise);
  return promise;
}

async function discover(spec, terms, ctx) {
  if (!spec) return [];
  try {
    const page = await getPage(spec.url, ctx);
    const items = spec.type === 'sitemap'
      ? extractXmlLocs(page.text).map((url) => ({ url }))
      : extractLinks(page.text, spec.url);
    return items
      .map((item) => {
        const haystack = `${item.url || ''} ${item.text || ''}`.toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (term.length >= 3 && /^[a-z0-9.]+$/.test(term) && haystack.includes(term)) score += 3;
        }
        return { url: item.url, title: item.text || '', score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  } catch {
    return [];
  }
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function contentLinks(html, base) {
  let baseUrl;
  try { baseUrl = new URL(base); } catch { return []; }
  const seen = new Set();
  const out = [];
  for (const link of extractLinks(html, base).slice(0, 400)) {
    let url;
    try { url = new URL(link.href); } catch { continue; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (url.hostname !== baseUrl.hostname) continue;
    if (url.href.split('#')[0] === base.split('#')[0]) continue;
    if (/\.(?:pdf|zip|png|jpe?g|gif|svg|webp|ico|css|js|json|xml)$/i.test(url.pathname)) continue;
    if (/[?&](?:login|signin|signup|subscribe|newsletter)/i.test(url.search)) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    out.push({ href: url.href, text: link.text || '' });
  }
  return out;
}

export function isHubSource(source, sources) {
  let first;
  try { first = new URL(source.url); } catch { return false; }
  const host = first.host;
  const path = first.pathname.replace(/\/+$/, '');
  if (!path || path === '/') return true;
  return sources.some((other) => {
    if (other === source || !other.url) return false;
    try {
      const candidate = new URL(other.url);
      return candidate.host === host && candidate.pathname.replace(/\/+$/, '').startsWith(`${path}/`);
    } catch {
      return false;
    }
  });
}

async function fetchSource(source, terms, ctx) {
  const started = Date.now();
  const marker = source.fallback === true ? { fallback: true } : {};
  const via = source.via ? { via: source.via } : {};
  try {
    const page = await getPage(source.url, ctx);
    const extractStarted = Date.now();
    // Markdown 保留标题、代码围栏与表格分隔；纯行文本会把代码缩进和表头丢掉。
    const lines = htmlToMarkdown(page.text).split('\n').filter((line) => line.trim());
    const extractMs = Date.now() - extractStarted;
    const selectStarted = Date.now();
    const sourceId = shortId(page.finalUrl);
    const baseUrl = String(page.finalUrl).split('#')[0];
    const passages = selectPassages(lines, terms).map((passage) => ({
      ...passage,
      id: shortId(`${baseUrl}\n${passage.headingPath || ''}\n${passage.text}`),
      sourceId,
      url: page.finalUrl,
      citation: passage.anchor ? `${baseUrl}#${passage.anchor}` : baseUrl,
    }));
    const selectMs = Date.now() - selectStarted;
    return {
      attempt: {
        url: source.url,
        ok: true,
        ms: Date.now() - started,
        passages: passages.length,
        tries: page.tries ?? 1,
        cache: page.cache,
        ...via,
        ...marker,
      },
      evidence: passages.length
        ? [{
            id: sourceId,
            url: page.finalUrl,
            title: extractTitle(page.text) || source.title || '',
            site: hostOf(page.finalUrl),
            origin: source.origin || 'registry',
            ...(source.depth ? { depth: source.depth } : {}),
            ...(source.via ? { via: source.via } : {}),
            ...(source.version ? { version: source.version } : {}),
            updated: page.lastModified || null,
            passages,
          }]
        : [],
      page,
      timings: { extractMs, selectMs },
    };
  } catch (error) {
    if (error?.code === CODES.ABORTED) throw error;
    return {
      attempt: {
        url: source.url,
        ok: false,
        ms: Date.now() - started,
        error: error?.code || 'ERROR',
        message: String(error?.message || error),
        ...via,
        ...marker,
        ...(error?.details?.tries !== undefined ? { tries: error.details.tries } : {}),
        ...(error?.details?.status !== undefined ? { status: error.details.status } : {}),
      },
      evidence: [],
      page: null,
      timings: { extractMs: 0, selectMs: 0 },
    };
  }
}

function applyRelevanceGate(evidence) {
  if (evidence.length <= 1) return evidence;
  const top = Math.max(...evidence.map((entry) => entry.passages[0]?.score ?? 0));
  const floor = Math.max(6, top * 0.45);
  return evidence
    .filter((entry) => (entry.passages[0]?.score ?? 0) >= floor)
    .sort((a, b) => (b.passages[0]?.score ?? 0) - (a.passages[0]?.score ?? 0));
}

function outcomeLinks(outcome) {
  if (!outcome.page) return [];
  if (!outcome.links) outcome.links = contentLinks(outcome.page.text, outcome.page.finalUrl);
  return outcome.links;
}

function followCandidates(outcomes, missing, terms) {
  const list = Array.isArray(terms) ? terms : [...terms];
  const seen = new Set();
  const out = [];
  for (const outcome of outcomes) {
    for (const link of outcomeLinks(outcome)) {
      if (seen.has(link.href)) continue;
      seen.add(link.href);
      const text = (link.text || '').toLowerCase();
      const href = link.href.toLowerCase();
      let score = 0;
      let matched = false;
      for (const facet of missing) {
        if (text.includes(facet)) { score += 6; matched = true; }
        else if (href.includes(facet)) { score += 2; matched = true; }
      }
      if (!matched) continue;
      for (const term of list) {
        if (term.length >= 3 && (text.includes(term) || href.includes(term))) score += 1;
      }
      try {
        const path = new URL(link.href).pathname;
        if (path === '/' || path === '') score -= 5;
        score += Math.min(3, path.split('/').filter(Boolean).length);
      } catch { /* ignore */ }
      if (score > 0) out.push({ url: link.href, title: link.text, score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

async function runEntity(entity, terms, ctx) {
  const started = Date.now();
  const ranked = rankSources(entity, terms);
  const primaryRanked = ranked.filter((source) => source.fallback !== true);
  const fallbackRanked = ranked.filter((source) => source.fallback === true);
  // 只有 fallback 源的实体直接跑 fallback；否则主源优先，必要时再补一轮。
  const sources = (primaryRanked.length ? primaryRanked : fallbackRanked).slice(0, ctx.maxSources);
  const backups = primaryRanked.length ? fallbackRanked.slice(0, 2) : [];

  const allOutcomes = [];
  const indexStarted = Date.now();
  const indexedRaw = ctx.deepIndex
    ? searchIndex({
        entity,
        terms,
        indexDir: ctx.indexDir,
        ttlMs: ctx.indexTtlMs,
        coverageVersion: ctx.coverageVersion,
        max: ctx.maxSources,
      })
    : null;
  const indexed = indexedRaw?.deep === true ? indexedRaw : null;
  let evidence = indexed?.evidence ? [...indexed.evidence] : [];
  let indexMs = indexed ? Date.now() - indexStarted : 0;
  const attempts = [];
  const notes = indexed?.evidence?.length ? ['deep-index'] : [];
  let extractMs = 0;
  let selectMs = 0;

  if (evidence.length) {
    const indexQuality = qualityFor({ terms, entity, evidence, exclude: ctx.excludeTerms });
    const indexAnswerable = isAnswerable({ question: ctx.question, intent: ctx.intent, evidence, terms });
    if (indexQuality.facets.ratio >= 1 && indexQuality.confidence.score >= 0.75 && indexAnswerable) {
      attempts.push({ url: evidence[0].url, ok: true, passages: evidence.reduce((sum, entry) => sum + entry.passages.length, 0), cache: 'index', via: 'index' });
      return {
        entity,
        evidence,
        attempts,
        notes,
        partial: false,
        timings: { fetchMs: 0, extractMs: 0, selectMs: 0, followMs: 0, recursiveMs: 0, indexMs },
        quality: indexQuality,
      };
    }
  }

  let fetchMs = 0;
  let partial = false;
  const expired = () => Date.now() >= ctx.deadline;
  const collect = (outcome) => {
    allOutcomes.push(outcome);
    attempts.push(outcome.attempt);
    evidence.push(...outcome.evidence);
    extractMs += outcome.timings.extractMs;
    selectMs += outcome.timings.selectMs;
  };

  if (sources.length) {
    const ADAPTIVE_INTENTS = new Set(['fact', 'pricing', 'version']);
    const adaptiveEligible = ctx.adaptive !== false
      && sources.length > 1
      && evidence.length === 0
      && ADAPTIVE_INTENTS.has(ctx.intent)
      && !isHubSource(sources[0], sources);
    if (expired()) {
      partial = true;
      notes.push('budget-exhausted');
    } else if (!adaptiveEligible) {
      const parallelStarted = Date.now();
      const outcomes = await Promise.all(sources.map((source) => fetchSource(source, terms, ctx)));
      fetchMs += Date.now() - parallelStarted;
      for (const outcome of outcomes) collect(outcome);
    } else {
      const firstStarted = Date.now();
      const first = await fetchSource(sources[0], terms, ctx);
      fetchMs += Date.now() - firstStarted;
      collect(first);
      const firstQuality = qualityFor({ terms, entity, evidence, exclude: ctx.excludeTerms });
      const early = evidence.length > 0
        && firstQuality.facets.ratio === 1
        && firstQuality.confidence.score >= 0.75;
      if (early) notes.push('early-stop');
      else if (expired()) {
        partial = true;
        notes.push('budget-exhausted');
      } else {
        const restStarted = Date.now();
        const rest = await Promise.all(sources.slice(1).map((source) => fetchSource(source, terms, ctx)));
        fetchMs += Date.now() - restStarted;
        for (const outcome of rest) collect(outcome);
      }
    }
  }

  if (evidence.length === 0 && backups.length && !expired()) {
    const backupStarted = Date.now();
    const backupOutcomes = await Promise.all(backups.map((source) => fetchSource(source, terms, ctx)));
    fetchMs += Date.now() - backupStarted;
    for (const outcome of backupOutcomes) {
      allOutcomes.push(outcome);
      attempts.push(outcome.attempt);
      evidence.push(...outcome.evidence);
      extractMs += outcome.timings.extractMs;
      selectMs += outcome.timings.selectMs;
    }
    if (evidence.length) notes.push('fallback-source');
  }

  if (evidence.length === 0 && entity.discovery && !expired()) {
    const discoveryStarted = Date.now();
    const extra = await discover(entity.discovery, terms, ctx);
    const discoveredOutcomes = await Promise.all(extra.map((candidate) => fetchSource(
      { url: candidate.url, title: candidate.title, via: 'discovery' },
      terms,
      ctx,
    )));
    fetchMs += Date.now() - discoveryStarted;
    for (const outcome of discoveredOutcomes) {
      allOutcomes.push(outcome);
      attempts.push(outcome.attempt);
      evidence.push(...outcome.evidence);
      extractMs += outcome.timings.extractMs;
      selectMs += outcome.timings.selectMs;
    }
    if (evidence.length) notes.push('discovered-via-source-map');
  }

  evidence = applyRelevanceGate(evidence);
  let quality = qualityFor({ terms, entity, evidence, exclude: ctx.excludeTerms });

  let followMs = 0;
  if (ctx.followLinks && ctx.maxFollowLinks > 0 && evidence.length && quality.facets.missing.length && quality.confidence.score < 0.75 && !expired()) {
    const candidates = followCandidates(allOutcomes, quality.facets.missing, terms);
    const followStarted = Date.now();
    for (const candidate of candidates.slice(0, ctx.maxFollowLinks)) {
      const outcome = await fetchSource(
        { url: candidate.url, title: candidate.title, via: 'link', depth: 1 },
        terms,
        ctx,
      );
      attempts.push(outcome.attempt);
      evidence.push(...outcome.evidence);
      extractMs += outcome.timings.extractMs;
      selectMs += outcome.timings.selectMs;
      if (outcome.evidence.length) notes.push('followed-link');
      evidence = applyRelevanceGate(evidence);
      quality = qualityFor({ terms, entity, evidence, exclude: ctx.excludeTerms });
      if (quality.facets.ratio >= 0.75) break;
    }
    followMs = Date.now() - followStarted;
  }

  let recursiveMs = 0;
  if (
    ctx.recursive
    && (ctx.recursiveForce || ['howto', 'list', 'compare'].includes(ctx.intent))
    && ctx.maxRecursivePages > 0
    && evidence.length > 0
    && quality.facets.missing.length > 0
    && quality.confidence.score < 0.55
    && !expired()
  ) {
    const recursiveStarted = Date.now();
    let missing = quality.facets.missing.slice(0, 6);
    const attempted = new Set([
      ...sources.map((source) => source.url),
      ...attempts.map((attempt) => attempt.url),
      ...evidence.map((entry) => entry.url),
    ]);
    let sitemapCandidates = [];
    try {
      const sitemap = await collectSitemapUrls({
        seeds: sources.map((source) => source.url),
        fetchText: (url) => getPage(url, ctx).then((page) => page.text),
        maxDepth: ctx.maxRecursiveDepth,
        maxSitemaps: Math.min(12, Math.max(2, ctx.maxRecursiveDepth * 4)),
        maxUrls: 5000,
      });
      if (sitemap.urls.length) {
        notes.push('recursive-sitemap');
        sitemapCandidates = rankCandidates(sitemap.urls, { missing, terms, limit: 24 });
      }
    } catch { /* sitemap is optional */ }
    let fetched = 0;
    for (let wave = 0; wave < 2 && fetched < ctx.maxRecursivePages && !expired(); wave += 1) {
      const linkUrls = allOutcomes.flatMap((outcome) => outcomeLinks(outcome)).map((link) => link.href);
      const linkCandidates = rankLinkCandidates(linkUrls, { missing, terms, limit: 24 });
      const byUrl = new Map();
      for (const candidate of [...sitemapCandidates, ...linkCandidates]) {
        if (attempted.has(candidate.url)) continue;
        const known = byUrl.get(candidate.url);
        if (!known || candidate.score > known.score) byUrl.set(candidate.url, candidate);
      }
      const queue = [...byUrl.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.min(2, ctx.maxRecursivePages - fetched));
      if (!queue.length) break;
      const outcomes = await Promise.all(queue.map((candidate) => fetchSource(
        { url: candidate.url, title: '', via: 'recursive', depth: 2 },
        terms,
        ctx,
      )));
      for (let index = 0; index < outcomes.length; index += 1) {
        attempted.add(queue[index].url);
        collect(outcomes[index]);
        fetched += 1;
      }
      evidence = applyRelevanceGate(evidence);
      const next = qualityFor({ terms, entity, evidence, exclude: ctx.excludeTerms });
      if (next.facets.ratio > quality.facets.ratio || next.confidence.score > quality.confidence.score) {
        notes.push('recursive-discovery');
      }
      quality = next;
      missing = quality.facets.missing.slice(0, 6);
      if (quality.facets.ratio >= 1) break;
    }
    recursiveMs = Date.now() - recursiveStarted;
    if (!fetched) notes.push('recursive-no-candidate');
  }

  return {
    entity,
    evidence,
    attempts,
    notes: [...new Set(notes)],
    partial,
    timings: { fetchMs, extractMs, selectMs, followMs, recursiveMs, indexMs },
    quality,
  };
}

function mergeRuns(runs, { terms = null, entity = null, intent = null } = {}) {
  const seen = new Set();
  const evidence = [];
  for (const run of runs) {
    for (const entry of run.evidence) {
      if (seen.has(entry.url)) continue;
      seen.add(entry.url);
      evidence.push({ ...entry, entity: run.entity.id });
    }
  }
  return orderEvidence(evidence, terms, entity, intent);
}

/**
 * 证据排序按“本查询 facet 覆盖 → 最佳段落分”：只按页面分排序会把
 * 目录页/概述页排在真正含答案的深页前面（top3 与 FullAll 差距的根因）。
 * facet 覆盖是查询相关的信号，页面分只做同覆盖时的次级排序。
 */
function orderEvidence(evidence, terms, entity, intent = null) {
  if (!Array.isArray(evidence) || evidence.length <= 1) return evidence;
  const facets = facetTerms(terms || [], { entity });
  if (!facets.length) {
    return [...evidence].sort((a, b) => (b.passages[0]?.score ?? 0) - (a.passages[0]?.score ?? 0));
  }
  const textOf = (entry) => (entry.passages || []).map((passage) => String(passage.text || '').toLowerCase()).join('\n');
  // facet 按 IDF 加权：实体名几乎每页都有，判别力来自少数页面才含的 API/配置词。
  const texts = evidence.map(textOf);
  const df = new Map();
  for (const facet of facets) {
    df.set(facet, texts.reduce((sum, text) => (text.includes(facet) ? sum + 1 : sum), 0));
  }
  const weightOf = (facet) => {
    const count = df.get(facet) || 0;
    return 1 + Math.log(evidence.length / Math.max(1, count));
  };
  const coverageOf = (text) => facets.reduce(
    (sum, facet) => (text.includes(facet) ? sum + weightOf(facet) : sum),
    0,
  );
  // how-to 的答案通常在代码块里：命中关键 facet 的 code 段落加分。
  const codeBonusOf = (entry) => {
    if (intent !== 'howto') return 0;
    let bonus = 0;
    for (const passage of entry.passages || []) {
      if (passage.kind !== 'code') continue;
      for (const facet of facets) {
        if (String(passage.text || '').toLowerCase().includes(facet)) bonus = Math.max(bonus, weightOf(facet));
      }
    }
    return bonus;
  };
  return evidence
    .map((entry, index) => ({
      entry,
      index,
      rank: coverageOf(textOf(entry)) + codeBonusOf(entry),
    }))
    .sort((a, b) => b.rank - a.rank
      || (b.entry.passages[0]?.score ?? 0) - (a.entry.passages[0]?.score ?? 0)
      || a.index - b.index)
    .map(({ entry }) => entry);
}

function looksComparative(text) {
  return /\b(?:vs\.?|versus|compare|comparison|between)\b|和|与|对比|比较|区别|差异|哪个更好|哪个好/i.test(text);
}

function fastEligible(text) {
  // fast 索引适合“已知事实”查询；开放 how-to/对比/清单问题仍走 live，避免漏掉 API 名。
  return !/(怎么|如何|为什么|哪些|列出|区别|差异|对比|比较|实现|使用|配置|创建|安装|部署|开启|设置|编写|报错|调试|how\s+(?:do|does|can|to|should)|why|versus|compare|difference|list\s+of|setup|configure|install|deploy|create|build|debug)/i.test(String(text || ''));
}

const MODE_PRESETS = {
  fast: { maxSources: 2, followLinks: false, maxFollowLinks: 0, fast: true, adaptive: true, decompose: false },
  balanced: { maxSources: 3, followLinks: true, maxFollowLinks: 1, fast: false, adaptive: true, decompose: false },
  deep: { maxSources: 6, followLinks: true, maxFollowLinks: 2, fast: false, adaptive: false, decompose: true },
};

export function modePreset(mode) {
  const key = String(mode || '').toLowerCase();
  return MODE_PRESETS[key] ? { mode: key, ...MODE_PRESETS[key] } : null;
}

function hasCriticalMissing(missing = []) {
  return missing.some((term) => String(term).length >= 5 && !GENERIC_TERMS.has(String(term).toLowerCase()));
}

function withFacts(result) {
  if (!Array.isArray(result.facts)) {
    result.facts = extractFacts(result.evidence || [], { intent: result.intent || 'fact' });
  }
  if (!result.consensus) {
    const consensus = buildConsensus(result.evidence || [], result.facts);
    if (consensus) result.consensus = consensus;
  }
  if (result.answerable === undefined) {
    result.answerable = isAnswerable({
      question: result.question,
      intent: result.intent,
      evidence: result.evidence || [],
      terms: result.facets?.terms || [],
    });
  }
  return result;
}

function finalizeResult(result, { started, budgetMs = 0, partial = false, preset = null } = {}) {
  if (preset) result.searchMode = preset.mode;
  if (budgetMs > 0) {
    result.budget = {
      limitMs: budgetMs,
      usedMs: Date.now() - started,
      exhausted: Date.now() >= started + budgetMs,
    };
    if (partial) {
      result.partial = true;
      result.next = {
        ...(result.next || {}),
        hint: 'budget exhausted; partial evidence returned. Increase budgetMs or reduce maxSources.',
      };
    }
  }
  withFacts(result);
  return result;
}

/**
 * @param {string} question
 * @param {{ maxSources?: number, cache?: boolean, fallback?: boolean, site?: string, timeoutMs?: number, allowPrivate?: boolean, sites?: boolean, sitesFile?: string, multi?: boolean, followLinks?: boolean, maxFollowLinks?: number, pageCacheDir?: string, pageCacheTtlMs?: number, fast?: boolean, decompose?: boolean, docVersion?: string, adaptive?: boolean, signal?: AbortSignal }} [options]
 */
export async function search(question, options = {}) {
  const started = Date.now();
  const trimmed = String(question || '').trim();
  if (!trimmed) throw new ArgusError(CODES.BAD_REQUEST, 'question is required');
  if (options.signal?.aborted) throw new ArgusError(CODES.ABORTED, 'request aborted', { question: trimmed });
  const preset = modePreset(options.mode);
  if (options.mode !== undefined && !preset) {
    throw new ArgusError(CODES.BAD_REQUEST, `unknown mode: ${options.mode}`);
  }
  const pick = (value, fallback) => (value === undefined ? fallback : value);
  const maxSources = Math.max(1, Math.min(6, Number(pick(options.maxSources, preset?.maxSources ?? 3))));
  const timeoutMs = Number(options.timeoutMs ?? 12_000);
  const allowPrivate = options.allowPrivate === true;
  const site = normalizeSite(options.site);
  const fallbackMode = options.fallback === true ? 'always' : options.fallback === 'auto' ? 'auto' : null;
  const useFallback = fallbackMode !== null || site !== null;
  const useCache = options.cache !== false;
  const followLinks = pick(options.followLinks, preset?.followLinks ?? true) !== false;
  const multi = options.multi !== false;
  const maxFollowLinks = Math.max(0, Math.min(2, Number(pick(options.maxFollowLinks, preset?.maxFollowLinks ?? 1))));
  const adaptive = pick(options.adaptive, preset?.adaptive ?? true) !== false;
  const fastRequested = pick(options.fast, preset?.fast ?? false) === true;
  const decomposeRequested = pick(options.decompose, preset?.decompose ?? false) === true;
  const budgetMs = Math.max(0, Number(options.budgetMs ?? 0));
  const deadline = budgetMs > 0 ? started + budgetMs : Infinity;
  const recursive = options.recursive !== false;
  const deepIndex = options.deepIndex === true;
  const maxRecursivePages = Math.max(0, Math.min(12, Number(options.maxRecursivePages ?? 5)));
  const maxRecursiveDepth = Math.max(1, Math.min(3, Number(options.maxRecursiveDepth ?? 2)));
  const coverage = getCoverage({ sitesFile: options.sitesFile, sites: options.sites !== false });
  const cache = getCache(options);
  const cacheKey = cache
    ? Cache.key([
        'search', 'v5', coverage.version, trimmed, maxSources, useFallback, fallbackMode ?? '', site ?? '',
        allowPrivate ? 'private' : 'public', multi ? 1 : 0, followLinks ? 1 : 0, maxFollowLinks,
        fastRequested ? 1 : 0, options.indexDir ?? '', options.docVersion ?? '', decomposeRequested ? 1 : 0,
        adaptive ? 1 : 0, preset?.mode ?? '', recursive ? 1 : 0, maxRecursivePages, maxRecursiveDepth,
        options.recursiveForce === true ? 1 : 0,
        deepIndex ? 1 : 0,
      ])
    : null;
  if (cache && cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit) {
      const result = {
        ...hit,
        cached: true,
        cache: 'result',
        tookMs: Date.now() - started,
        timings: { ...(hit.timings || {}), totalMs: Date.now() - started },
      };
      finalizeResult(result, { started, budgetMs, preset });
      logQuery(result);
      return result;
    }
  }

  const terms = expandTerms(trimmed);
  const routeStarted = Date.now();
  const entity = site === null ? matchEntity(trimmed, coverage) : null;
  const candidates = site === null && multi && looksComparative(trimmed)
    ? matchEntities(trimmed, coverage, { limit: Math.min(3, maxSources) })
    : [];
  const baseEntities = candidates.length > 1
    ? candidates
    : entity
      ? [{ id: entity.id, ...entity }]
      : [];
  const entitiesToRun = baseEntities.map((entry) => {
    const resolved = resolveVersion(trimmed, entry, options.docVersion ?? null);
    if (!resolved || !resolved.supported) return { ...entry, docVersion: null };
    return { ...entry, docVersion: resolved.version, sources: applyVersionRules(entry.sources, resolved) };
  });
  const hasDocVersion = entitiesToRun.some((entry) => entry.docVersion);
  const routeMs = Date.now() - routeStarted;

  const plan = planQuery(trimmed);

  const ctx = {
    question: trimmed,
    maxSources,
    timeoutMs,
    useCache,
    allowPrivate,
    store: getPageStore(options),
    followLinks,
    maxFollowLinks,
    memoryCache: options.memoryPageCache !== false,
    adaptive,
    intent: plan.intent,
    signal: options.signal,
    deadline,
    recursive,
    recursiveForce: preset?.mode === 'deep' || options.recursiveForce === true,
    deepIndex,
    indexDir: options.indexDir,
    indexTtlMs: options.indexTtlMs,
    coverageVersion: coverage.version,
    maxRecursivePages,
    maxRecursiveDepth,
  };

  if (decomposeRequested && plan.compound) {
    const decomposeStarted = Date.now();
    const clauseMax = Math.max(1, Math.min(3, Math.ceil(maxSources / 2)));
    const clauses = plan.clauses.map((clause) => {
      if (!entity) return clause;
      const hit = matchEntity(clause, coverage);
      return hit?.id === entity.id ? clause : `${entity.id} ${clause}`;
    });
    const subResults = await Promise.all(clauses.map((clause) => search(clause, {
      ...options,
      decompose: false,
      maxSources: clauseMax,
      ...(budgetMs > 0 ? { budgetMs: Math.max(1, deadline - Date.now()) } : {}),
    })));
    const evidence = [];
    const byUrl = new Map();
    for (let index = 0; index < subResults.length; index++) {
      for (const entry of subResults[index].evidence) {
        const existing = byUrl.get(entry.url);
        if (existing) {
          for (const passage of entry.passages) {
            if (!existing.passages.some((item) => item.text === passage.text)) existing.passages.push(passage);
          }
          if (!existing.clauses.includes(clauses[index])) existing.clauses.push(clauses[index]);
          continue;
        }
        const merged = { ...entry, clause: clauses[index], clauseIndex: index, clauses: [clauses[index]] };
        byUrl.set(entry.url, merged);
        evidence.push(merged);
      }
    }
    for (const entry of evidence) entry.passages.sort((a, b) => b.score - a.score);
    evidence.sort((a, b) => (b.passages[0]?.score ?? 0) - (a.passages[0]?.score ?? 0));
    const entities = [];
    for (const sub of subResults) {
      for (const item of sub.entities || []) {
        if (!entities.some((known) => known.id === item.id)) entities.push(item);
      }
    }
    const attempts = subResults.flatMap((sub) => sub.attempts || []);
    const allFailed = evidence.length === 0 && attempts.length > 0 && attempts.every((attempt) => !attempt.ok);
    const quality = qualityFor({ terms, entity, evidence, allFailed });
    const result = {
      schemaVersion: 1,
      question: trimmed,
      entity: entity?.id ?? null,
      entityOrigin: entity?.origin ?? null,
      version: subResults.find((sub) => sub.version)?.version ?? null,
      entities,
      intent: plan.intent,
      plan: { intent: plan.intent, confidence: plan.confidence, clauses, compound: true },
      mode: evidence.length ? 'registry' : (subResults.some((sub) => sub.mode === 'error') ? 'error' : 'none'),
      evidence,
      attempts,
      timings: {
        routeMs,
        fetchMs: Math.max(0, ...subResults.map((sub) => sub.timings?.fetchMs ?? 0)),
        extractMs: subResults.reduce((sum, sub) => sum + (sub.timings?.extractMs ?? 0), 0),
        selectMs: subResults.reduce((sum, sub) => sum + (sub.timings?.selectMs ?? 0), 0),
        followMs: subResults.reduce((sum, sub) => sum + (sub.timings?.followMs ?? 0), 0),
        recursiveMs: subResults.reduce((sum, sub) => sum + (sub.timings?.recursiveMs ?? 0), 0),
        indexMs: subResults.reduce((sum, sub) => sum + (sub.timings?.indexMs ?? 0), 0),
        decomposeMs: Date.now() - decomposeStarted,
      },
      cache: 'none',
      ...quality,
      cached: false,
    };
    result.tookMs = Date.now() - started;
    result.timings.totalMs = result.tookMs;
    const partial = subResults.some((sub) => sub.partial === true) || (budgetMs > 0 && Date.now() >= deadline);
    finalizeResult(result, { started, budgetMs, partial, preset });
    if (cache && cacheKey && evidence.length && !partial) cache.set(cacheKey, result);
    logQuery(result);
    return result;
  }
  if (fastRequested && !hasDocVersion && entitiesToRun.length && fastEligible(trimmed)) {
    const indexStarted = Date.now();
    const indexed = entitiesToRun.map((entry) => searchIndex({
      entity: entry,
      terms,
      indexDir: options.indexDir,
      ttlMs: options.indexTtlMs,
      coverageVersion: coverage.version,
    }));
    if (indexed.every(Boolean)) {
      const evidence = [];
      const seen = new Set();
      let stale = false;
      for (let index = 0; index < indexed.length; index++) {
        stale = stale || indexed[index].stale;
        for (const entry of indexed[index].evidence) {
          if (seen.has(entry.url)) continue;
          seen.add(entry.url);
          evidence.push({ ...entry, entity: entitiesToRun[index].id });
        }
      }
      evidence.sort((a, b) => (b.passages[0]?.score ?? 0) - (a.passages[0]?.score ?? 0));
      const quality = qualityFor({ terms, entity: entitiesToRun[0], evidence });
      if (evidence.length && quality.facets.ratio >= 0.7 && quality.confidence.score >= 0.5) {
        const result = {
          schemaVersion: 1,
          question: trimmed,
          intent: plan.intent,
          entity: entitiesToRun[0].id,
          entityOrigin: entitiesToRun[0].origin,
          version: entitiesToRun[0].docVersion || null,
          ...(options.docVersion ? { versionRequested: String(options.docVersion) } : {}),
          entities: entitiesToRun.map((entry) => ({ id: entry.id, origin: entry.origin, ...(entry.docVersion ? { version: entry.docVersion } : {}) })),
          mode: 'registry',
          evidence,
          attempts: [],
          timings: { routeMs, fetchMs: 0, extractMs: 0, selectMs: 0, followMs: 0, recursiveMs: 0, indexMs: Date.now() - indexStarted },
          cache: 'index',
          ...quality,
          note: stale ? 'fast-index-stale' : 'fast-index',
          index: { entities: indexed.length, stale, builtAt: Math.max(...indexed.map((item) => item.builtAt || 0)) },
          cached: false,
        };
        result.tookMs = Date.now() - started;
        result.timings.totalMs = result.tookMs;
        finalizeResult(result, { started, budgetMs, preset });
        if (cache && cacheKey && evidence.length) cache.set(cacheKey, result);
        logQuery(result);
        return result;
      }
    }
  }

  let result;
  let partial = false;
  if (entitiesToRun.length) {
    const runs = await Promise.all(entitiesToRun.map((entry) => {
      const perEntity = entitiesToRun.length > 1
        ? Math.max(1, Math.min(2, Math.floor(maxSources / entitiesToRun.length) || 1))
        : maxSources;
      const excludeTerms = entitiesToRun.length > 1
        ? entitiesToRun
            .filter((other) => other.id !== entry.id)
            .flatMap((other) => [other.id, ...(other.aliases || [])])
        : [];
      return runEntity(entry, terms, { ...ctx, maxSources: perEntity, excludeTerms });
    }));
    const evidence = mergeRuns(runs, { terms, entity: entitiesToRun[0], intent: plan.intent });
    const attempts = runs.flatMap((run) => run.attempts);
    const notes = [...new Set(runs.flatMap((run) => run.notes))];
    partial = runs.some((run) => run.partial === true);
    const allFailed = evidence.length === 0 && attempts.length > 0 && attempts.every((attempt) => !attempt.ok);
    const quality = qualityFor({ terms, entity: entitiesToRun[0], evidence, allFailed });
    if (runs.length > 1) {
      const weakest = Math.min(...runs.map((run) => run.quality.confidence.score));
      const score = Number(Math.min(quality.confidence.score, weakest).toFixed(2));
      quality.confidence = { score, label: score >= 0.75 ? 'high' : score >= 0.5 ? 'medium' : 'low' };
    }
    result = {
      schemaVersion: 1,
      question: trimmed,
      intent: plan.intent,
      entity: entitiesToRun[0].id,
      entityOrigin: entitiesToRun[0].origin,
      version: entitiesToRun[0].docVersion || null,
      ...(options.docVersion ? { versionRequested: String(options.docVersion) } : {}),
      entities: runs.map((run) => ({
        id: run.entity.id,
        origin: run.entity.origin,
        version: run.entity.docVersion || null,
        confidence: run.quality.confidence,
        facets: { ratio: run.quality.facets.ratio, missing: run.quality.facets.missing },
      })),
      mode: 'registry',
      evidence,
      attempts,
      timings: {
        routeMs,
        fetchMs: Math.max(0, ...runs.map((run) => run.timings.fetchMs)),
        extractMs: runs.reduce((sum, run) => sum + run.timings.extractMs, 0),
        selectMs: runs.reduce((sum, run) => sum + run.timings.selectMs, 0),
        followMs: runs.reduce((sum, run) => sum + run.timings.followMs, 0),
        recursiveMs: runs.reduce((sum, run) => sum + (run.timings.recursiveMs || 0), 0),
        indexMs: runs.reduce((sum, run) => sum + (run.timings.indexMs || 0), 0),
      },
      cache: 'none',
      ...quality,
      ...(notes.length ? { note: notes.join('+') } : {}),
      ...(allFailed ? { error: { code: CODES.ALL_SOURCES_FAILED, message: `all ${attempts.length} sources failed`, attempts: attempts.length } } : {}),
      cached: false,
    };

    const answerable = isAnswerable({
      question: trimmed,
      intent: plan.intent,
      evidence: result.evidence,
      terms: result.facets?.terms || [],
    });
    const lowConfidence = fallbackMode === 'auto'
      && (!answerable || (result.confidence?.score ?? 0) < 0.6 || hasCriticalMissing(result.facets?.missing || []));
    const shouldFallback = useFallback
      && site === null
      && Date.now() < deadline
      && (result.evidence.length === 0 || lowConfidence);
    if (shouldFallback) {
      const fallbackStarted = Date.now();
      const webEvidence = await webFallback(trimmed, {
        limit: 4,
        maxPages: 4,
        allowPrivate,
        timeoutMs,
        signal: options.signal,
      });
      const seenUrls = new Set(result.evidence.map((entry) => entry.url));
      const fresh = webEvidence.filter((entry) => !seenUrls.has(entry.url));
      if (fresh.length) {
        const combined = [...result.evidence, ...fresh];
        const combinedQuality = qualityFor({ terms, entity: entitiesToRun[0], evidence: combined });
        if (result.evidence.length === 0 || combinedQuality.confidence.score >= (result.confidence?.score ?? 0)) {
          const officialSources = result.evidence.length;
          result.evidence = combined;
          result.mode = 'web-fallback';
          result.fallback = {
            provider: fresh[0]?.provider || null,
            snippets: fresh.some((entry) => entry.snippet === true),
            officialSources,
            webSources: fresh.length,
            augmented: officialSources > 0,
          };
          result.note = [result.note, 'web-fallback'].filter(Boolean).join('+');
          Object.assign(result, combinedQuality);
        }
      }
      result.timings.fallbackMs = Date.now() - fallbackStarted;
    }
  } else if (useFallback && Date.now() < deadline) {
    const evidence = await webFallback(trimmed, { limit: 4, maxPages: 4, site, allowPrivate, timeoutMs, signal: options.signal });
    const quality = qualityFor({ terms, entity: null, evidence });
    result = {
      schemaVersion: 1,
      question: trimmed,
      intent: plan.intent,
      entity: null,
      version: null,
      entities: [],
      mode: evidence.length ? 'web-fallback' : 'none',
      evidence,
      ...(evidence.length ? { fallback: { provider: evidence[0]?.provider || null, snippets: evidence.some((entry) => entry.snippet === true), officialSources: 0, webSources: evidence.length, augmented: false } } : {}),
      attempts: [],
      timings: { routeMs, fetchMs: 0, extractMs: 0, selectMs: 0, followMs: 0, recursiveMs: 0 },
      cache: 'none',
      ...quality,
      ...(site ? { site } : {}),
      cached: false,
    };
  } else {
    partial = Date.now() >= deadline;
    const quality = qualityFor({ terms, entity: null, evidence: [] });
    result = {
      schemaVersion: 1,
      question: trimmed,
      intent: plan.intent,
      entity: null,
      version: null,
      entities: [],
      mode: 'none',
      evidence: [],
      attempts: [],
      timings: { routeMs, fetchMs: 0, extractMs: 0, selectMs: 0, followMs: 0, recursiveMs: 0 },
      cache: 'none',
      ...quality,
      cached: false,
    };
  }

  result.tookMs = Date.now() - started;
  result.timings.totalMs = result.tookMs;
  finalizeResult(result, { started, budgetMs, partial, preset });
  if (cache && cacheKey && result.evidence.length > 0 && !partial) cache.set(cacheKey, result);
  logQuery(result);
  return result;
}

/**
 * 批量检索：按 concurrency 并发跑多个问题；单题失败不拖垮整批。
 * 顺序与输入一致；页面缓存与 in-flight 去重在批内共享。
 *
 * @param {string[]} questions
 * @param {{ concurrency?: number, maxSources?: number, cache?: boolean, fallback?: boolean, timeoutMs?: number, budgetMs?: number, allowPrivate?: boolean, sites?: boolean, sitesFile?: string, signal?: AbortSignal, onProgress?: (event: {index:number,total:number,result:object}) => void }} [options]
 */
export async function searchBatch(questions, options = {}) {
  const list = (Array.isArray(questions) ? questions : [questions]).map((question) => String(question ?? '').trim());
  const concurrency = Math.max(1, Math.min(8, Number(options.concurrency ?? 3)));
  const budgetMs = Math.max(0, Number(options.budgetMs ?? 0));
  const deadline = budgetMs > 0 ? Date.now() + budgetMs : Infinity;
  const results = new Array(list.length);
  let cursor = 0;
  const notify = (index) => {
    try { options.onProgress?.({ index, total: list.length, result: results[index] }); } catch { /* progress is best-effort */ }
  };
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= list.length) return;
      if (options.signal?.aborted) {
        results[index] = {
          schemaVersion: 1,
          question: list[index],
          entity: null,
          version: null,
          mode: 'error',
          evidence: [],
          attempts: [],
          error: { code: 'ABORTED', message: 'request aborted' },
        };
        notify(index);
        continue;
      }
      if (Date.now() >= deadline) {
        results[index] = {
          schemaVersion: 1,
          question: list[index],
          entity: null,
          mode: 'timeout',
          evidence: [],
          attempts: [],
          error: { code: 'BATCH_BUDGET_EXCEEDED', message: `batch budget ${budgetMs}ms exceeded` },
        };
        notify(index);
        continue;
      }
      try {
        results[index] = await search(list[index], options);
      } catch (error) {
        results[index] = {
          schemaVersion: 1,
          question: list[index],
          entity: null,
          mode: 'error',
          evidence: [],
          attempts: [],
          error: { code: error?.code || 'INTERNAL', message: String(error?.message || error) },
        };
      }
      notify(index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, list.length)) }, worker));
  return results;
}

export { coverageVersion, registryVersion };
