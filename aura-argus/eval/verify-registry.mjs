// 注册表健康检查：每个源可达性 + 体积 + 耗时。可选 --json。
import { listEntities } from '../src/lib/registry.mjs';
import { fetchRaw } from '../src/lib/fetch.mjs';

const json = process.argv.includes('--json');
const entities = listEntities();
const rows = [];

for (const entity of entities) {
  for (const source of entity.sources) {
    const started = Date.now();
    try {
      const page = await fetchRaw(source, { timeoutMs: 12_000, retries: 0 });
      rows.push({ entity: entity.id, url: source, ok: true, status: page.status, bytes: page.bytes, ms: Date.now() - started });
    } catch (error) {
      rows.push({ entity: entity.id, url: source, ok: false, code: error.code || 'ERROR', message: String(error.message), ms: Date.now() - started });
    }
  }
}

const failed = rows.filter((r) => !r.ok);
if (json) {
  console.log(JSON.stringify({ total: rows.length, ok: rows.length - failed.length, failed: failed.length, rows }, null, 2));
} else {
  for (const row of rows) {
    console.log(`${row.ok ? 'OK  ' : 'FAIL'} ${row.entity.padEnd(12)} ${String(row.status ?? row.code).padEnd(6)} ${String(row.bytes ?? '').padStart(8)}B ${String(row.ms).padStart(6)}ms ${row.url}`);
  }
  console.log(`\n${rows.length - failed.length}/${rows.length} sources reachable`);
}
process.exitCode = failed.length ? 2 : 0;
