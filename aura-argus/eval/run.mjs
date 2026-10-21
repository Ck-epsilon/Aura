// 检索评测：注册表覆盖 + 别名 + 英文/中文 + 未知实体 + 兜底。
// 每条问题同时检查结构（entity/mode/minSources）与金标准事实。
import fs from 'node:fs';
import { search } from '../src/lib/router.mjs';

const cases = JSON.parse(fs.readFileSync(new URL('./questions.json', import.meta.url), 'utf8'));
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length);
const selected = only ? cases.filter((item) => item.id === only) : cases;

const rows = [];
let hardPassed = 0;
let hardTotal = 0;
let softPassed = 0;
let softTotal = 0;

for (const item of selected) {
  const started = Date.now();
  let result;
  let error = null;
  try {
    result = await search(item.q, {
      cache: false,
      fallback: item.options?.fallback !== false,
      maxSources: item.options?.maxSources ?? 3,
    });
  } catch (caught) {
    error = caught;
    result = { entity: null, mode: 'error', evidence: [], attempts: [] };
  }
  const evidenceText = result.evidence.flatMap((entry) => entry.passages.map((p) => p.text)).join('\n');

  const structural = [];
  if ('entity' in item) structural.push(['entity', result.entity === item.entity, `got ${result.entity}`]);
  if (item.mode) structural.push(['mode', result.mode === item.mode, `got ${result.mode}`]);
  if (item.minSources !== undefined) structural.push(['sources', result.evidence.length >= item.minSources, `got ${result.evidence.length}`]);

  const facts = (item.checks || []).map(([name, pattern]) => [name, new RegExp(pattern, 'i').test(evidenceText), pattern]);
  const checks = [...structural, ...facts];
  const passed = checks.filter(([, ok]) => ok).length;
  const soft = item.soft === true;
  if (soft) { softPassed += passed; softTotal += checks.length; }
  else { hardPassed += passed; hardTotal += checks.length; }

  rows.push({
    id: item.id,
    q: item.q,
    soft,
    entity: result.entity,
    mode: result.mode,
    sources: result.evidence.map((entry) => entry.url),
    ms: Date.now() - started,
    chars: evidenceText.length,
    checks: checks.map(([name, ok, detail]) => ({ name, ok, detail })),
    error: error ? String(error.message) : null,
  });

  const misses = checks.filter(([, ok]) => !ok).map(([name]) => name);
  console.error(
    `${item.id.padEnd(18)} ${String(result.mode).padEnd(13)} ${String(result.evidence.length).padStart(2)}src ${String(Date.now() - started).padStart(5)}ms ${passed}/${checks.length} ${misses.length ? 'MISS:' + misses.join(',') : ''}${soft ? ' (soft)' : ''}`,
  );
}

const summary = {
  at: new Date().toISOString(),
  questions: rows.length,
  hard: { passed: hardPassed, total: hardTotal },
  soft: { passed: softPassed, total: softTotal },
  failures: rows.filter((row) => !row.soft && row.checks.some((check) => !check.ok)).map((row) => ({
    id: row.id,
    entity: row.entity,
    mode: row.mode,
    misses: row.checks.filter((check) => !check.ok).map((check) => check.name),
  })),
  rows,
};

fs.writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ questions: summary.questions, hard: summary.hard, soft: summary.soft, failures: summary.failures }, null, 2));
process.exitCode = summary.failures.length ? 2 : 0;
