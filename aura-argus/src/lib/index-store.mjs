// 本地 section 索引：把常用实体的官方页切成可检索段落，支持无需联网的 fast 查询。
import fs from 'node:fs';
import path from 'node:path';

import { fetchRaw } from './fetch.mjs';
import { PageCache } from './page-cache.mjs';
import { getCoverage } from './registry.mjs';
import { defaultCacheDir } from './paths.mjs';
import { extractTitle, htmlToMarkdown, extractLinks } from './text.mjs';
import { buildChunks, buildWeights, scoreLine, shortId, GENERIC_TERMS } from './extract.mjs';
import { collectSitemapUrls, rankCandidates, rankLinkCandidates } from './discover.mjs';

const TEXTUAL = /text\/html|application\/xhtml\+xml|text\/plain|text\/markdown|application\/json|application\/xml|text\/xml/i;
const BOILERPLATE = /cookie|登录|注册|版权所有|copyright|隐私政策|subscribe|newsletter|skip to content|^menu$|^expand$/i;

export function indexPath(env = process.env) {
  return env.AURA_ARGUS_INDEX_DIR
    ? path.resolve(env.AURA_ARGUS_INDEX_DIR)
    : path.join(defaultCacheDir(env), 'index');
}

export function indexTtlMs(env = process.env) {
  return Number(env.AURA_ARGUS_INDEX_TTL_MS ?? 24 * 60 * 60_000);
}

function entityFile(indexDir, id) {
  const safe = String(id).replace(/[^a-z0-9._-]/gi, '_');
  return path.join(indexDir, 'entities', `${safe}.json`);
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
}

export function loadEntityIndex(id, { indexDir = indexPath() } = {}) {
  const record = readJson(entityFile(indexDir, id));
  if (!record || record.id !== id || !Array.isArray(record.sections)) return null;
  return record;
}

function isStale(index, { ttlMs, coverageVersion }) {
  if (coverageVersion && index.coverageVersion && coverageVersion !== index.coverageVersion) return true;
  return Date.now() - Number(index.builtAt || 0) > ttlMs;
}

async function cachedPage(url, { cache, timeoutMs, allowPrivate, validators = null }) {
  const hit = cache.get(url, { allowPrivate });
  if (hit?.fresh) return { page: hit.page, notModified: false };
  if (hit) {
    const page = await fetchRaw(url, {
      timeoutMs,
      allowPrivate,
      validators: { etag: hit.etag, lastModified: hit.lastModified },
    });
    if (page.notModified) {
      cache.touch(url, { allowPrivate });
      return { page: hit.page, notModified: true };
    }
    cache.set(url, page, { allowPrivate });
    return { page, notModified: false };
  }
  if (validators && (validators.etag || validators.lastModified)) {
    const page = await fetchRaw(url, { timeoutMs, allowPrivate, validators });
    if (page.notModified) return { page: null, notModified: true };
    cache.set(url, page, { allowPrivate });
    return { page, notModified: false };
  }
  const page = await fetchRaw(url, { timeoutMs, allowPrivate });
  cache.set(url, page, { allowPrivate });
  return { page, notModified: false };
}

function rootOf(host) {
  return String(host || '').toLowerCase().split('.').slice(-2).join('.');
}

function deepTerms(entity) {
  const terms = new Set([
    entity.id,
    ...(entity.aliases || []),
    ...(entity.sources || []).flatMap((source) => source.covers || []),
    'docs', 'documentation', 'guide', 'reference', 'handbook', 'tasks',
    'configure', 'release-notes', 'manual', 'api',
  ]);
  return new Set([...terms].map((term) => String(term).toLowerCase()).filter((term) => term.length >= 3));
}

async function discoverDeepUrls(entity, { cache, timeoutMs, allowPrivate, maxPages, maxDepth }) {
  const seeds = (entity.sources || []).filter((source) => source.fallback !== true).map((source) => source.url);
  if (!seeds.length) return [];
  const roots = new Set(seeds.map((url) => rootOf(hostOf(url))).filter(Boolean));
  const loadText = async (url) => {
    const { page } = await cachedPage(url, { cache, timeoutMs, allowPrivate });
    return page?.text || '';
  };
  const terms = deepTerms(entity);
  const urls = [];
  const seen = new Set();
  const add = (url) => {
    if (!url || seen.has(url)) return false;
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (![...roots].some((root) => host === root || host.endsWith(`.${root}`))) return false;
      if (!/^https?:$/.test(parsed.protocol)) return false;
      if (/\.(?:pdf|zip|png|jpe?g|gif|svg|webp|ico|css|js|json)$/i.test(parsed.pathname)) return false;
    } catch { return false; }
    seen.add(url);
    urls.push(url);
    return true;
  };

  for (const seed of seeds) add(seed);

  try {
    const sitemap = await collectSitemapUrls({
      seeds,
      fetchText: loadText,
      maxDepth,
      maxSitemaps: 12,
      maxUrls: 5000,
    });
    if (sitemap.urls.length) {
      for (const candidate of rankCandidates(sitemap.urls, { terms, limit: Math.max(1, maxPages) })) add(candidate.url);
    }
  } catch { /* sitemap is optional */ }

  // Link BFS fills the gap for sites without a sitemap (e.g. TypeScript docs).
  const queue = seeds.map((url) => ({ url, depth: 0 }));
  while (queue.length && urls.length < maxPages) {
    const current = queue.shift();
    if (current.depth >= maxDepth) continue;
    let html;
    try { html = await loadText(current.url); } catch { continue; }
    if (!html) continue;
    const links = extractLinks(html, current.url).filter((link) => {
      try {
        const host = new URL(link.href).hostname.toLowerCase();
        return [...roots].some((root) => host === root || host.endsWith(`.${root}`));
      } catch { return false; }
    });
    const ranked = rankLinkCandidates(links, { terms, limit: 4 });
    for (const link of ranked) {
      if (urls.length >= maxPages) break;
      if (add(link.url)) queue.push({ url: link.url, depth: current.depth + 1 });
    }
  }
  return urls.slice(0, Math.max(1, maxPages));
}

/**
 * 为一个或多个实体构建深度索引：先发现官方深页，再建 section 索引。
 * 与在线递归不同，这个命令离线跑一次，查询时直接读本地索引。
 */
export async function buildDeepIndex({
  entities = null,
  top = 20,
  all = false,
  maxPages = 80,
  maxDepth = 2,
  concurrency = 2,
  timeoutMs = 15_000,
  allowPrivate = false,
  sites = true,
  sitesFile,
  indexDir = indexPath(),
  pageCacheDir,
  maxSectionsPerSource = 500,
  incremental = true,
  env = process.env,
} = {}) {
  const coverage = getCoverage({ sites, sitesFile, env });
  const entries = Object.entries(coverage.entities);
  const wanted = Array.isArray(entities) && entities.length
    ? new Set(entities.map((id) => String(id).trim()).filter(Boolean))
    : null;
  // 深索引的默认策略是覆盖全部实体：浅源无法回答深主题是结构性问题，
  // 只给部分实体建索引会把“能力”变成“记住考题”。--top 仅作资源受限时的截断。
  const selected = wanted
    ? entries.filter(([id]) => wanted.has(id))
    : (all === true ? entries : entries.slice(0, Math.max(1, Number(top) || 20)));
  const cache = new PageCache({
    dir: pageCacheDir || defaultCacheDir(env),
    ttlMs: Number(env.AURA_ARGUS_PAGE_TTL_MS ?? 6 * 60 * 60_000),
    enabled: env.AURA_ARGUS_NO_CACHE !== '1',
  });
  const rows = [];
  const sectionCap = Math.max(1, Number(maxSectionsPerSource) || 500);
  let cursor = 0;
  let totalSections = 0;

  async function worker() {
    while (true) {
      const position = cursor++;
      if (position >= selected.length) return;
      const [id, entity] = selected[position];
      const started = Date.now();
      const previous = loadEntityIndex(id, { indexDir });
      const fresh = previous && Date.now() - Number(previous.builtAt || 0) <= indexTtlMs(env);
      const sameSettings = previous?.deep === true
        && Number(previous.settings?.maxPages ?? 0) === Math.max(1, maxPages)
        && Number(previous.settings?.maxDepth ?? 0) === Math.max(1, maxDepth)
        && Number(previous.settings?.maxSectionsPerSource ?? 0) === sectionCap;
      if (incremental && fresh && sameSettings && previous.coverageVersion === coverage.version) {
        const sections = previous.sections?.length || 0;
        totalSections += sections;
        rows.push({ entity: id, sources: previous.sources?.length || 0, sections, failed: 0, reused: true, updated: 0, notModified: 0, builtAt: previous.builtAt, ms: Date.now() - started, deep: true });
        continue;
      }

      const urls = await discoverDeepUrls(entity, {
        cache,
        timeoutMs,
        allowPrivate,
        maxPages: Math.max(1, maxPages),
        maxDepth: Math.max(1, maxDepth),
      });
      const previousByUrl = new Map((previous?.sources || []).map((source) => [source.requested || source.url, source]));
      const previousSections = previous?.sections || [];
      const sections = [];
      const sourceRows = [];
      let failed = 0;
      for (const url of urls) {
        const prevSource = previousByUrl.get(url);
        try {
          const { page, notModified } = await cachedPage(url, {
            cache,
            timeoutMs,
            allowPrivate,
            validators: prevSource ? { etag: prevSource.etag, lastModified: prevSource.lastModified } : null,
          });
          if (incremental && notModified && prevSource && !page) {
            const reused = previousSections.filter((section) => (section.sourceKey || section.url) === url).slice(0, sectionCap);
            if (reused.length) {
              sections.push(...reused);
              sourceRows.push({ ...prevSource, requested: url, sections: reused.length, notModified: true });
              continue;
            }
          }
          if (!page || !TEXTUAL.test(page.contentType || '')) { failed += 1; continue; }
          const title = extractTitle(page.text) || '';
          const lines = htmlToMarkdown(page.text).split('\n').filter((line) => line.trim());
          const chunks = buildChunks(lines).filter((chunk) => chunk.text.length >= 40 && chunk.text.length <= 1200 && !BOILERPLATE.test(chunk.text));
          const capped = chunks.slice(0, sectionCap);
          for (const chunk of capped) {
            sections.push({
              sourceKey: url,
              url: page.finalUrl || url,
              title,
              heading: chunk.heading || '',
              headingPath: chunk.headingPath || '',
              anchor: chunk.anchor || '',
              kind: chunk.kind,
              text: chunk.text,
            });
          }
          sourceRows.push({
            requested: url,
            url: page.finalUrl || url,
            title,
            sections: capped.length,
            etag: page.etag || null,
            lastModified: page.lastModified || null,
            notModified: false,
          });
        } catch {
          failed += 1;
        }
      }
      const record = {
        id,
        deep: true,
        coverageVersion: coverage.version,
        builtAt: Date.now(),
        settings: { deep: true, maxPages: Math.max(1, maxPages), maxDepth: Math.max(1, maxDepth), maxSectionsPerSource: sectionCap },
        sources: sourceRows,
        sections,
      };
      writeJson(entityFile(indexDir, id), record);
      totalSections += sections.length;
      rows.push({
        entity: id,
        sources: sourceRows.length,
        sections: sections.length,
        failed,
        reused: false,
        updated: sourceRows.filter((source) => !source.notModified).length,
        notModified: sourceRows.filter((source) => source.notModified).length,
        builtAt: record.builtAt,
        ms: Date.now() - started,
        deep: true,
      });
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, Number(concurrency) || 2), Math.max(1, selected.length)) },
    worker,
  ));
  const manifestFile = path.join(indexDir, 'manifest.json');
  const previousManifest = readJson(manifestFile) || { entities: {} };
  const manifest = {
    version: 2,
    coverageVersion: coverage.version,
    builtAt: Date.now(),
    entities: { ...(previousManifest.entities || {}) },
  };
  for (const row of rows) {
    manifest.entities[row.entity] = {
      builtAt: row.builtAt || Date.now(),
      sources: row.sources,
      sections: row.sections,
      deep: true,
      reused: row.reused === true,
      updated: row.updated || 0,
    };
  }
  writeJson(manifestFile, manifest);
  return {
    indexDir,
    coverageVersion: coverage.version,
    entities: selected.length,
    sections: totalSections,
    reused: rows.filter((row) => row.reused).length,
    updatedSources: rows.reduce((sum, row) => sum + (row.updated || 0), 0),
    notModifiedSources: rows.reduce((sum, row) => sum + (row.notModified || 0), 0),
    deep: true,
    rows: rows.sort((a, b) => a.entity.localeCompare(b.entity)),
  };
}

/**
 * 为一个或多个实体构建 section 索引。默认只抓每个实体的前 2 个主源。
 */
export async function buildIndex({
  entities = null,
  top = 20,
  all = false,
  maxSources = 2,
  concurrency = 4,
  timeoutMs = 15_000,
  allowPrivate = false,
  sites = true,
  sitesFile,
  indexDir = indexPath(),
  pageCacheDir,
  maxSectionsPerSource = 500,
  incremental = true,
  deep = false,
  deepMaxPages = 80,
  deepMaxDepth = 2,
  env = process.env,
} = {}) {
  if (deep) return buildDeepIndex({
    entities, top, all, maxPages: deepMaxPages, maxDepth: deepMaxDepth, concurrency,
    timeoutMs, allowPrivate, sites, sitesFile, indexDir, pageCacheDir,
    maxSectionsPerSource, incremental, env,
  });
  const coverage = getCoverage({ sites, sitesFile, env });
  const entries = Object.entries(coverage.entities);
  const wanted = Array.isArray(entities) && entities.length
    ? new Set(entities.map((id) => String(id).trim()).filter(Boolean))
    : null;
  const selected = wanted
    ? entries.filter(([id]) => wanted.has(id))
    : (all === true ? entries : entries.slice(0, Math.max(1, Number(top) || 20)));
  const cache = new PageCache({
    dir: pageCacheDir || defaultCacheDir(env),
    ttlMs: Number(env.AURA_ARGUS_PAGE_TTL_MS ?? 6 * 60 * 60_000),
    enabled: env.AURA_ARGUS_NO_CACHE !== '1',
  });
  const rows = [];
  let cursor = 0;
  let totalSections = 0;

  async function worker() {
    while (true) {
      const position = cursor++;
      if (position >= selected.length) return;
      const [id, entity] = selected[position];
      const started = Date.now();
      const sources = (entity.sources || []).filter((source) => source.fallback !== true).slice(0, Math.max(1, Number(maxSources) || 2));
      const previous = loadEntityIndex(id, { indexDir });
      const previousSources = previous?.sources || [];
      const prevByKey = new Map(previousSources.map((source) => [source.requested || source.url, source]));
      const prevKeys = previousSources.map((source) => source.requested || source.url);
      const sameSourceSet = sources.length === prevKeys.length && sources.every((source) => prevKeys.includes(source.url));
      const sectionCap = Math.max(1, Number(maxSectionsPerSource) || 500);
      const sameSettings = Number(previous?.settings?.maxSectionsPerSource ?? 500) === sectionCap;
      const fresh = previous && Date.now() - Number(previous.builtAt || 0) <= indexTtlMs(env);
      if (incremental && fresh && previous.coverageVersion === coverage.version && sameSourceSet && sameSettings) {
        const sections = previous.sections?.length || 0;
        totalSections += sections;
        rows.push({
          entity: id,
          sources: previousSources.length,
          sections,
          failed: 0,
          reused: true,
          updated: 0,
          notModified: 0,
          builtAt: previous.builtAt,
          ms: Date.now() - started,
        });
        continue;
      }

      const sections = [];
      const sourceRows = [];
      let failed = 0;
      for (const source of sources) {
        const prevSource = prevByKey.get(source.url);
        const priorForRequest = incremental ? prevSource : null;
        try {
          const { page, notModified } = await cachedPage(source.url, {
            cache,
            timeoutMs,
            allowPrivate,
            validators: priorForRequest ? { etag: priorForRequest.etag, lastModified: priorForRequest.lastModified } : null,
          });
          if (incremental && notModified && priorForRequest && !page) {
            const reused = (previous?.sections || [])
              .filter((section) => (section.sourceKey || section.url) === source.url)
              .slice(0, sectionCap);
            if (reused.length) {
              sections.push(...reused);
              sourceRows.push({ ...prevSource, requested: source.url, sections: reused.length, notModified: true });
              continue;
            }
          }
          if (!page) { failed += 1; continue; }
          if (!TEXTUAL.test(page.contentType || '')) { failed += 1; continue; }
          const title = extractTitle(page.text) || source.title || '';
          const lines = htmlToMarkdown(page.text).split('\n').filter((line) => line.trim());
          const chunks = buildChunks(lines).filter((chunk) => chunk.text.length >= 40 && chunk.text.length <= 1200 && !BOILERPLATE.test(chunk.text));
          const capped = chunks.slice(0, sectionCap);
          for (const chunk of capped) {
            sections.push({
              sourceKey: source.url,
              url: page.finalUrl || source.url,
              title,
              heading: chunk.heading || '',
              headingPath: chunk.headingPath || '',
              anchor: chunk.anchor || '',
              kind: chunk.kind,
              text: chunk.text,
            });
          }
          sourceRows.push({
            requested: source.url,
            url: page.finalUrl || source.url,
            title,
            sections: capped.length,
            etag: page.etag || priorForRequest?.etag || null,
            lastModified: page.lastModified || priorForRequest?.lastModified || null,
            notModified: false,
          });
        } catch {
          failed += 1;
        }
      }
      const record = {
        id,
        coverageVersion: coverage.version,
        builtAt: Date.now(),
        settings: { maxSectionsPerSource: sectionCap },
        sources: sourceRows,
        sections,
      };
      writeJson(entityFile(indexDir, id), record);
      totalSections += sections.length;
      rows.push({
        entity: id,
        sources: sourceRows.length,
        sections: sections.length,
        failed,
        reused: false,
        updated: sourceRows.filter((source) => !source.notModified).length,
        notModified: sourceRows.filter((source) => source.notModified).length,
        builtAt: record.builtAt,
        ms: Date.now() - started,
      });
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, Number(concurrency) || 4), Math.max(1, selected.length)) },
    worker,
  ));

  const manifestFile = path.join(indexDir, 'manifest.json');
  const previous = readJson(manifestFile) || { entities: {} };
  const manifest = {
    version: 2,
    coverageVersion: coverage.version,
    builtAt: Date.now(),
    entities: { ...(previous.entities || {}) },
  };
  for (const row of rows) {
    manifest.entities[row.entity] = {
      builtAt: row.builtAt || Date.now(),
      sources: row.sources,
      sections: row.sections,
      reused: row.reused === true,
      updated: row.updated || 0,
    };
  }
  writeJson(manifestFile, manifest);

  return {
    indexDir,
    coverageVersion: coverage.version,
    entities: selected.length,
    sections: totalSections,
    reused: rows.filter((row) => row.reused).length,
    updatedSources: rows.reduce((sum, row) => sum + (row.updated || 0), 0),
    notModifiedSources: rows.reduce((sum, row) => sum + (row.notModified || 0), 0),
    rows: rows.sort((a, b) => a.entity.localeCompare(b.entity)),
  };
}

/**
 * 用已有索引检索。返回 null 表示该实体没有索引；evidence 为空表示索引里没有命中。
 */
export function searchIndex({
  entity,
  terms,
  indexDir = indexPath(),
  ttlMs = indexTtlMs(),
  coverageVersion,
  max = 6,
  maxChars = 800,
} = {}) {
  const index = loadEntityIndex(entity.id, { indexDir });
  if (!index) return null;
  const list = Array.isArray(terms) ? terms : [...terms];
  const weights = buildWeights(index.sections.map((section) => section.text), list);
  const ranked = index.sections
    .map((section) => ({
      ...section,
      score: scoreLine(section.text, list, weights, { kind: section.kind, heading: section.heading }),
    }))
    .filter((section) => section.score > 0)
    .sort((a, b) => b.score - a.score);

  // 版本意图：URL/标题命中精确版本号的 section 大幅加分，
  // 否则“TypeScript 5.9 新特性”会把 3.9/4.2 的 release notes 排在前面。
  const versions = list.filter((term) => /^\d+(?:\.\d+){1,2}$/.test(term) || /^\d{2,3}$/.test(term));
  if (versions.length) {
    const releaseNotes = /release|whats-?new|changelog|previous|deprecated/i;
    for (const section of ranked) {
      const hay = `${section.url} ${section.heading || ''}`.toLowerCase();
      if (versions.some((version) => hay.includes(version))) {
        section.score += releaseNotes.test(hay) ? 30 : 14;
      }
    }
    ranked.sort((a, b) => b.score - a.score);
  }

  const limit = max * 2;
  const picked = [];
  const seen = new Set();
  const perUrl = new Map();
  for (const hit of ranked) {
    if (picked.length >= limit) break;
    const count = perUrl.get(hit.url) || 0;
    if (count >= max) continue;
    const key = `${hit.url}|${hit.text.slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    perUrl.set(hit.url, count + 1);
    picked.push({ ...hit, text: hit.text.slice(0, maxChars) });
  }

  // 稀有 facet 预留：防止泛词页面把真正的 API/配置词挤出索引证据。
  const facets = [...weights.entries()]
    .filter(([term, weight]) => weight >= 3 && term.length >= 4 && !GENERIC_TERMS.has(term))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([term]) => term);
  const replaceWorst = (hit) => {
    if (picked.length < limit) { picked.push({ ...hit, text: hit.text.slice(0, maxChars) }); return; }
    let worst = 0;
    for (let index = 1; index < picked.length; index += 1) {
      if (picked[index].score < picked[worst].score) worst = index;
    }
    picked[worst] = { ...hit, text: hit.text.slice(0, maxChars) };
  };
  for (const facet of facets) {
    if (picked.some((item) => item.text.toLowerCase().includes(facet))) continue;
    const hit = ranked.find((section) => section.text.toLowerCase().includes(facet)
      && !picked.some((item) => item.url === section.url && item.text === section.text));
    if (hit) replaceWorst(hit);
  }

  // 代码命令预留：索引里也要保留 SQL/CLI 的关键命令。
  const termCount = (section) => list.filter((term) => term.length >= 2 && section.text.toLowerCase().includes(term)).length;
  const headingMatch = (section) => list.some((term) => term.length >= 4 && String(section.heading || '').toLowerCase().includes(term));
  const bestCode = ranked.find((section) => section.kind === 'code' && (termCount(section) >= 2 || (termCount(section) >= 1 && headingMatch(section))) && !picked.some((item) => item.url === section.url && item.text === section.text));
  if (bestCode) {
    const codeHit = { ...bestCode, text: bestCode.text.slice(0, maxChars) };
    if (picked.length < limit) picked.push(codeHit);
    else {
      let worst = 0;
      for (let index = 1; index < picked.length; index += 1) {
        if (picked[index].score < picked[worst].score) worst = index;
      }
      picked[worst] = codeHit;
    }
  }

  const evidence = [];
  for (const hit of picked) {
    let entry = evidence.find((item) => item.url === hit.url);
    if (!entry) {
      entry = {
        id: shortId(hit.url),
        url: hit.url,
        title: hit.title,
        site: hostOf(hit.url),
        origin: 'index',
        entity: entity.id,
        via: 'index',
        updated: new Date(index.builtAt || Date.now()).toISOString(),
        passages: [],
      };
      evidence.push(entry);
    }
    const anchor = hit.anchor || '';
    const baseUrl = String(hit.url).split('#')[0];
    entry.passages.push({
      id: shortId(`${baseUrl}\n${hit.headingPath || ''}\n${hit.text}`),
      text: hit.text,
      score: hit.score,
      kind: hit.kind,
      heading: hit.heading || '',
      headingPath: hit.headingPath || '',
      anchor,
      anchorType: anchor ? 'heading-slug' : null,
      sourceId: entry.id,
      url: hit.url,
      citation: anchor ? `${baseUrl}#${anchor}` : baseUrl,
    });
  }
  evidence.sort((a, b) => (b.passages[0]?.score ?? 0) - (a.passages[0]?.score ?? 0));

  return {
    evidence,
    builtAt: index.builtAt,
    stale: isStale(index, { ttlMs, coverageVersion }),
    sections: index.sections.length,
    matched: ranked.length,
    deep: index.deep === true,
  };
}
