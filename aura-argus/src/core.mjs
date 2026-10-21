// 公共 API。任何 Node 进程 import 这里即可。
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const version = pkg.version;
export { search, searchBatch } from './lib/router.mjs';
export { fetchDocument } from './lib/fetch.mjs';
export { listEntities, matchEntity, registryVersion } from './lib/registry.mjs';
export { ArgusError, CODES, toErrorPayload } from './lib/errors.mjs';
export { defaultCacheDir } from './lib/paths.mjs';
