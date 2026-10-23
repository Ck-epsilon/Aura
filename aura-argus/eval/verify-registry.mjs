// 源健康检查：registry + 站点包，逐源可达性 + 体积 + 耗时。
// 用法：node eval/verify-registry.mjs [--json] [--registry-only] [--allow-private] [--retries 1] [--timeout 12000]
import { getCoverage } from '../src/lib/registry.mjs';
import { fetchRaw } from '../src/lib/fetch.mjs';

const json = process.argv.includes('--json');
const registryOnly = process.argv.includes('--registry-only');
const allowPrivate = process.argv.includes('--allow-private');
const retries = Number(process.argv.find((arg) => arg.startsWith('--retries='))?.split('=')[1] ?? 1);
const timeoutMs = Number(process.argv.find((arg) => arg.startsWith('--timeout='))?.split('=')[1] ?? 12_000);
const coverage = getCoverage({ sites: !registryOnly });
const rows = [];

for (const [entity, value] of Object.entries(coverage.entities)) {
  for (const source of value.sources) {
    const started = Date.now();
    try {
      const page = await fetchRaw(source.url, { timeoutMs, retries, allowPrivate });
      rows.push({
        entity,
        url: source.url,
        origin: source.origin || 'registry',
        ...(source.fallback ? { fallback: true } : {}),
        ok: true,
        status: page.status,
        bytes: page.bytes,
        ms: Date.now() - started,
      });
    } catch (error) {
      rows.push({
        entity,
        url: source.url,
        origin: source.origin || 'registry',
        ...(source.fallback ? { fallback: true } : {}),
        ok: false,
        code: error.code || 'ERROR',
        message: String(error.message),
        ms: Date.now() - started,
      });
    }
  }
}

const failed = rows.filter((row) => !row.ok);
const summary = {
  coverageVersion: coverage.version,
  entities: Object.keys(coverage.entities).length,
  total: rows.length,
  ok: rows.length - failed.length,
  failed: failed.length,
};
if (json) {
  console.log(JSON.stringify({ ...summary, rows }, null, 2));
} else {
  for (const row of rows) {
    const tag = row.fallback ? ' fallback' : '';
    console.log(`${row.ok ? 'OK  ' : 'FAIL'} ${String(row.entity).padEnd(18)} ${String(row.status ?? row.code).padEnd(6)} ${String(row.bytes ?? '').padStart(8)}B ${String(row.ms).padStart(6)}ms ${row.url}${tag}`);
  }
  console.log(`\n${summary.entities} entities / ${summary.total} sources · ${summary.ok}/${summary.total} reachable · ${summary.coverageVersion}`);
}
process.exitCode = failed.length ? 2 : 0;
