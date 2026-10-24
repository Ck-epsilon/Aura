// 公共 API。任何 Node 进程 import 这里即可。
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const version = pkg.version;
export { search as aura_argus_search, searchBatch as aura_argus_search_batch, coverageVersion as aura_argus_coverage_version } from './lib/router.mjs';
export { fetchDocument as aura_argus_fetch_document } from './lib/fetch.mjs';
export { getCoverage as aura_argus_sources, listEntities as aura_argus_list_entities, matchEntities, matchEntity, registryVersion } from './lib/registry.mjs';
export { PageCache } from './lib/page-cache.mjs';
export { loadSites } from './lib/sites.mjs';
export { ArgusError, CODES, toErrorPayload } from './lib/errors.mjs';
export { defaultCacheDir, defaultSitesFile } from './lib/paths.mjs';
