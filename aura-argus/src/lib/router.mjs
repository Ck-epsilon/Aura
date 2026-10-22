// 检索编排：注册表命中 → 抓官方源 → 选段；未命中 → 网页兜底。
import { Cache } from './cache.mjs';
import { ArgusError, CODES } from './errors.mjs';
import { fetchRaw } from './fetch.mjs';
import { extractLinks, extractTitle, extractXmlLocs, htmlToMarkdown } from './text.mjs';
import { selectPassages } from './extract.mjs';
import { expandTerms, matchEntity, rankSources, registryVersion } from './registry.mjs';
import { normalizeSite, webFallback } from './fallback.mjs';
import { defaultCacheDir } from './paths.mjs';

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

// 页面级缓存 + in-flight 去重：同一 URL 在一批问题里只抓一次。
const pageCache = new Map();
const inFlightPages = new Map();
const PAGE_TTL_MS = 10 * 60_000;
const PAGE_MAX = 120;

async function getPage(url, timeoutMs, useCache) {
  if (!useCache) return fetchRaw(url, { timeoutMs });
  const hit = pageCache.get(url);
  if (hit && hit.expires > Date.now()) return hit.page;
  const pending = inFlightPages.get(url);
  if (pending) return pending;
  const promise = fetchRaw(url, { timeoutMs })
    .then((page) => {
      pageCache.set(url, { expires: Date.now() + PAGE_TTL_MS, page });
      if (pageCache.size > PAGE_MAX) pageCache.delete(pageCache.keys().next().value);
      return page;
    })
    .finally(() => inFlightPages.delete(url));
  inFlightPages.set(url, promise);
  return promise;
}

async function discover(spec, terms, timeoutMs, useCache) {
  if (!spec) return [];
  try {
    const page = await getPage(spec.url, timeoutMs, useCache);
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

async function fetchSource(source, terms, timeoutMs, useCache) {
  const started = Date.now();
  try {
    const page = await getPage(source.url, timeoutMs, useCache);
    // Markdown 保留标题、代码围栏与表格分隔；纯行文本会把代码缩进和表头丢掉。
    const lines = htmlToMarkdown(page.text).split('\n').filter((line) => line.trim());
    const passages = selectPassages(lines, terms);
    return {
      attempt: { url: source.url, ok: true, ms: Date.now() - started, passages: passages.length, tries: page.tries ?? 1 },
      evidence: passages.length
        ? [{
            url: page.finalUrl,
            title: extractTitle(page.text) || source.title || '',
            site: (() => { try { return new URL(page.finalUrl).hostname; } catch { return ''; } })(),
            passages,
          }]
        : [],
    };
  } catch (error) {
    return {
      attempt: {
        url: source.url,
        ok: false,
        ms: Date.now() - started,
        error: error?.code || 'ERROR',
        message: String(error?.message || error),
        ...(error?.details?.tries !== undefined ? { tries: error.details.tries } : {}),
        ...(error?.details?.status !== undefined ? { status: error.details.status } : {}),
      },
      evidence: [],
    };
  }
}

/**
 * @param {string} question
 * @param {{ maxSources?: number, cache?: boolean, fallback?: boolean, site?: string, timeoutMs?: number }} [options]
 */
export async function search(question, options = {}) {
  const started = Date.now();
  const trimmed = String(question || '').trim();
  if (!trimmed) throw new ArgusError(CODES.BAD_REQUEST, 'question is required');
  const maxSources = Math.max(1, Math.min(6, Number(options.maxSources ?? 3)));
  const timeoutMs = Number(options.timeoutMs ?? 12_000);
  const site = normalizeSite(options.site);
  const useFallback = options.fallback === true || site !== null;
  const useCache = options.cache !== false;
  const cache = getCache(options);
  const cacheKey = cache ? Cache.key(['search', registryVersion, trimmed, maxSources, useFallback, site ?? '']) : null;
  if (cache && cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit) return { ...hit, cached: true, tookMs: Date.now() - started };
  }

  const entity = site === null ? matchEntity(trimmed) : null;
  let result;
  if (entity) {
    const terms = expandTerms(trimmed);
    const sources = rankSources(entity, terms).slice(0, maxSources);
    let evidence = [];
    const attempts = [];
    let discovered = false;

    // 同题多源并行：各源通常是不同 host，串行只是白等。
    const outcomes = await Promise.all(sources.map((source) => fetchSource(source, terms, timeoutMs, useCache)));
    for (const outcome of outcomes) {
      attempts.push(outcome.attempt);
      evidence.push(...outcome.evidence);
    }

    if (evidence.length === 0 && entity.discovery) {
      discovered = true;
      const extra = await discover(entity.discovery, terms, timeoutMs, useCache);
      const discoveredOutcomes = await Promise.all(extra.map((candidate) => fetchSource(
        { url: candidate.url, title: candidate.title },
        terms,
        timeoutMs,
        useCache,
      )));
      for (const outcome of discoveredOutcomes) {
        attempts.push(outcome.attempt);
        evidence.push(...outcome.evidence);
      }
    }

    // 相关性闸门：明显低于最佳源的来源不进证据包（减少 agent 的噪音）。
    if (evidence.length > 1) {
      const top = Math.max(...evidence.map((entry) => entry.passages[0]?.score ?? 0));
      const floor = Math.max(6, top * 0.45);
      evidence = evidence.filter((entry) => (entry.passages[0]?.score ?? 0) >= floor);
    }

    const allFailed = evidence.length === 0 && attempts.length > 0 && attempts.every((attempt) => !attempt.ok);
    result = {
      schemaVersion: 1,
      question: trimmed,
      entity: entity.id,
      mode: 'registry',
      evidence,
      attempts,
      ...(discovered ? { note: 'discovered-via-source-map' } : {}),
      ...(allFailed ? { error: { code: CODES.ALL_SOURCES_FAILED, message: `all ${attempts.length} sources failed`, attempts: attempts.length } } : {}),
      tookMs: Date.now() - started,
      cached: false,
    };
  } else if (useFallback) {
    const evidence = await webFallback(trimmed, { site });
    result = {
      schemaVersion: 1,
      question: trimmed,
      entity: null,
      mode: evidence.length ? 'web-fallback' : 'none',
      evidence,
      attempts: [],
      ...(site ? { site } : {}),
      tookMs: Date.now() - started,
      cached: false,
    };
  } else {
    result = {
      schemaVersion: 1,
      question: trimmed,
      entity: null,
      mode: 'none',
      evidence: [],
      attempts: [],
      tookMs: Date.now() - started,
      cached: false,
    };
  }

  if (cache && cacheKey && result.evidence.length > 0) cache.set(cacheKey, result);
  return result;
}

/**
 * 批量检索：按 concurrency 并发跑多个问题；单题失败不拖垮整批。
 * 顺序与输入一致；页面缓存与 in-flight 去重在批内共享。
 *
 * @param {string[]} questions
 * @param {{ concurrency?: number, maxSources?: number, cache?: boolean, fallback?: boolean, timeoutMs?: number, budgetMs?: number }} [options]
 */
export async function searchBatch(questions, options = {}) {
  const list = (Array.isArray(questions) ? questions : [questions]).map((question) => String(question ?? '').trim());
  const concurrency = Math.max(1, Math.min(8, Number(options.concurrency ?? 3)));
  const budgetMs = Math.max(0, Number(options.budgetMs ?? 0));
  const deadline = budgetMs > 0 ? Date.now() + budgetMs : Infinity;
  const results = new Array(list.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= list.length) return;
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
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, list.length)) }, worker));
  return results;
}

export { registryVersion };
