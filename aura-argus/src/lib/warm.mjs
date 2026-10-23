// 预热：把常用实体的主源抓进持久页缓存，后续查询直接命中。
import { fetchRaw } from './fetch.mjs';
import { getCoverage } from './registry.mjs';
import { PageCache } from './page-cache.mjs';
import { defaultCacheDir } from './paths.mjs';

export async function warmSources({
  entities = null,
  top = 20,
  maxSources = 2,
  concurrency = 4,
  timeoutMs = 12_000,
  allowPrivate = false,
  sites = true,
  sitesFile,
  pageCacheDir,
  pageCacheTtlMs,
} = {}) {
  const coverage = getCoverage({ sites, sitesFile });
  const all = Object.entries(coverage.entities);
  const wanted = Array.isArray(entities) && entities.length
    ? new Set(entities.map((id) => String(id).trim()).filter(Boolean))
    : null;
  const selected = (wanted ? all.filter(([id]) => wanted.has(id)) : all.slice(0, Math.max(1, Number(top) || 20)));
  const dir = pageCacheDir || defaultCacheDir();
  const ttlMs = Number(pageCacheTtlMs ?? process.env.AURA_ARGUS_PAGE_TTL_MS ?? 6 * 60 * 60_000);
  const cache = new PageCache({ dir, ttlMs });
  const rows = [];
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= selected.length) return;
      const [id, entity] = selected[index];
      const sources = (entity.sources || []).filter((source) => source.fallback !== true).slice(0, Math.max(1, Number(maxSources) || 2));
      const started = Date.now();
      let ok = 0;
      let failed = 0;
      let bytes = 0;
      await Promise.all(sources.map(async (source) => {
        try {
          const page = await fetchRaw(source.url, { timeoutMs, allowPrivate });
          cache.set(source.url, page, { allowPrivate });
          ok += 1;
          bytes += page.bytes || 0;
        } catch {
          failed += 1;
        }
      }));
      rows.push({ entity: id, sources: sources.length, ok, failed, bytes, ms: Date.now() - started });
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, Number(concurrency) || 4), Math.max(1, selected.length)) },
    worker,
  ));

  return {
    coverageVersion: coverage.version,
    cacheDir: dir,
    entities: selected.length,
    rows: rows.sort((a, b) => a.entity.localeCompare(b.entity)),
  };
}
