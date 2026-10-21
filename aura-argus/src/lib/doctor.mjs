// 源可达性检查。供 CLI doctor 与测试复用。
import { listEntities } from './registry.mjs';
import { fetchRaw } from './fetch.mjs';

export async function checkSources({ timeoutMs = 12_000, concurrency = 4 } = {}) {
  const tasks = [];
  for (const entity of listEntities()) {
    for (const url of entity.sources) tasks.push({ entity: entity.id, url });
  }
  const rows = new Array(tasks.length);
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor++;
      const task = tasks[index];
      const started = Date.now();
      try {
        const page = await fetchRaw(task.url, { timeoutMs, retries: 0 });
        rows[index] = { ...task, ok: true, status: page.status, bytes: page.bytes, ms: Date.now() - started };
      } catch (error) {
        rows[index] = { ...task, ok: false, code: error.code || 'ERROR', message: String(error.message), ms: Date.now() - started };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, worker));
  return rows;
}
