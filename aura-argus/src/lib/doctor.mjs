// 源可达性检查。供 CLI doctor 与测试复用。
import { getCoverage } from './registry.mjs';
import { fetchRaw } from './fetch.mjs';

export async function checkSources({ timeoutMs = 12_000, concurrency = 4, allowPrivate = false, sites = true, sitesFile } = {}) {
  const tasks = [];
  const coverage = getCoverage({ sites, sitesFile });
  for (const [entity, value] of Object.entries(coverage.entities)) {
    for (const source of value.sources) {
      tasks.push({ entity, url: source.url, origin: source.origin || 'registry', ...(source.fallback ? { fallback: true } : {}) });
    }
  }
  const rows = new Array(tasks.length);
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor++;
      const task = tasks[index];
      const started = Date.now();
      try {
        const page = await fetchRaw(task.url, { timeoutMs, retries: 0, allowPrivate });
        rows[index] = { ...task, ok: true, status: page.status, bytes: page.bytes, ms: Date.now() - started };
      } catch (error) {
        rows[index] = { ...task, ok: false, code: error.code || 'ERROR', message: String(error.message), ms: Date.now() - started };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, worker));
  return rows;
}
