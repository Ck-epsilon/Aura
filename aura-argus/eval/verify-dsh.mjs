// 验证 DSH 是否已经把 search/fetch 指到 AuraArgus。
// 用法：node eval/verify-dsh.mjs [--live]
//   --live 额外用 provider 真跑一次检索（联网）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProviders, SEARCH_ID, FETCH_ID } from '../adapters/dsh/index.mjs';

const patchPath = process.env.DSH_WEB_PATCH || path.join(os.homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml');
const checks = [];

let text = '';
try {
  text = fs.readFileSync(patchPath, 'utf8');
  checks.push(['patch readable', true, patchPath]);
} catch (error) {
  checks.push(['patch readable', false, String(error.message)]);
}

if (text) {
  checks.push(['adapter inserted', /adapters[\\/]dsh[\\/]index\.mjs/.test(text), 'patch references adapters/dsh/index.mjs']);
  checks.push(['searchProvider = ' + SEARCH_ID, new RegExp(`searchProvider:\\s*${SEARCH_ID}\\b`).test(text), 'web.searchProvider']);
  checks.push(['fetchProvider = ' + FETCH_ID, new RegExp(`fetchProvider:\\s*${FETCH_ID}\\b`).test(text), 'web.fetchProvider']);
  checks.push(['mcp server inserted', /mcp-aura-argus/.test(text), 'dsh-mcp-client entry']);
}

const { searchProvider, fetchProvider } = createProviders();
checks.push(['search provider available', searchProvider.available(), SEARCH_ID]);
checks.push(['fetch provider available', fetchProvider.available(), FETCH_ID]);
checks.push(['provider ids', searchProvider.id === SEARCH_ID && fetchProvider.id === FETCH_ID, `${SEARCH_ID} / ${FETCH_ID}`]);

let live = null;
if (process.argv.includes('--live')) {
  try {
    const result = await searchProvider.search({ query: 'SearXNG 对 429 的冷却时间是多少秒？', maxResults: 2 });
    live = { ok: true, sources: result.sources.map((source) => ({ url: source.url, title: source.title })) };
    checks.push(['live search via provider', result.sources.length > 0, JSON.stringify(live.sources)]);
  } catch (error) {
    live = { ok: false, error: String(error.message) };
    checks.push(['live search via provider', false, String(error.message)]);
  }
}

for (const [name, ok, detail] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
if (live) console.log('\nlive:', JSON.stringify(live, null, 2));
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
console.log('note: 运行中的 dsh 需要重启才会加载 patch。');
process.exitCode = failed.length ? 2 : 0;
