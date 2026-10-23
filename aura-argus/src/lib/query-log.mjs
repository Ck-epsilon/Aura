// 本地查询日志（opt-in）：只写本机 JSONL，供覆盖率缺口分析；不发送任何数据。
import fs from 'node:fs';
import path from 'node:path';
import { defaultCacheDir } from './paths.mjs';

export function queryLogFile(env = process.env) {
  const value = env.AURA_ARGUS_QUERY_LOG;
  if (!value || value === '0' || value === 'false') return null;
  if (value === '1' || value === 'true') return path.join(defaultCacheDir(env), 'queries.jsonl');
  return path.resolve(value);
}

export function logQuery(result, { file = queryLogFile() } = {}) {
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const record = {
      at: new Date().toISOString(),
      question: String(result.question || '').slice(0, 2000),
      entity: result.entity ?? null,
      entities: (result.entities || []).map((entry) => entry.id),
      mode: result.mode,
      confidence: result.confidence?.score ?? null,
      confidenceLabel: result.confidence?.label ?? null,
      facetRatio: result.facets?.ratio ?? null,
      missing: result.facets?.missing ?? [],
      sources: result.evidence?.length ?? 0,
      chars: (result.evidence || []).reduce(
        (sum, entry) => sum + (entry.passages || []).reduce((inner, passage) => inner + (passage.text?.length || 0), 0),
        0,
      ),
      ms: result.tookMs ?? result.timings?.totalMs ?? null,
      cached: Boolean(result.cached),
    };
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function readQueryLog(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
