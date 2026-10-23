// 跨来源一致性：只比较单位相同的数值事实；同一来源给出多个值时视为歧义并跳过。
const COMPARABLE = new Set(['price', 'percent', 'limit', 'status']);

function sourceOf(fact) {
  return fact.sourceId || fact.url || fact.citation || 'unknown';
}

function sourceRef(fact) {
  return {
    sourceId: fact.sourceId || null,
    url: fact.url || null,
    citation: fact.citation || fact.url || null,
    passageId: fact.passageId || null,
  };
}

function keyOf(fact) {
  return [fact.type, fact.unit || '', fact.currency || ''].join('|');
}

/**
 * @param {Array<{url?:string}>} evidence
 * @param {Array<object>} facts
 */
export function buildConsensus(evidence, facts) {
  const sources = new Set((evidence || []).map((entry) => entry.url).filter(Boolean));
  if (sources.size < 2 || !Array.isArray(facts) || !facts.length) return null;

  const groups = new Map();
  for (const fact of facts) {
    if (!COMPARABLE.has(fact.type)) continue;
    const key = keyOf(fact);
    if (!groups.has(key)) {
      groups.set(key, {
        type: fact.type,
        unit: fact.unit || null,
        currency: fact.currency || null,
        bySource: new Map(),
      });
    }
    const group = groups.get(key);
    const source = sourceOf(fact);
    if (!group.bySource.has(source)) group.bySource.set(source, new Map());
    group.bySource.get(source).set(String(fact.value), fact);
  }

  const agreements = [];
  const conflicts = [];
  for (const group of groups.values()) {
    if (group.bySource.size < 2) continue;
    const byValue = new Map();
    for (const [source, sourceValues] of group.bySource) {
      for (const [value, fact] of sourceValues) {
        if (!byValue.has(value)) byValue.set(value, []);
        const list = byValue.get(value);
        if (!list.some((item) => item.source === source)) list.push({ source, ...sourceRef(fact) });
      }
    }
    const base = {
      type: group.type,
      ...(group.unit ? { unit: group.unit } : {}),
      ...(group.currency ? { currency: group.currency } : {}),
    };
    const simple = [...group.bySource.values()].every((values) => values.size === 1);
    if (simple) {
      if (byValue.size === 1) {
        const [value, sourcesForValue] = [...byValue.entries()][0];
        agreements.push({ ...base, value, sources: sourcesForValue });
      } else {
        conflicts.push({ ...base, values: [...byValue.entries()].map(([value, list]) => ({ value, sources: list })) });
      }
      continue;
    }
    // 一个来源列出多个价格/限额时不做冲突判定；只把跨来源重复出现的值记为一致。
    for (const [value, list] of byValue) {
      const distinctSources = new Set(list.map((item) => item.source));
      if (distinctSources.size >= 2) agreements.push({ ...base, value, sources: list });
    }
  }

  const comparable = agreements.length + conflicts.length;
  if (!comparable) return null;
  const sortSources = (list) => list.sort((a, b) => String(a.source).localeCompare(String(b.source)));
  agreements.sort((a, b) => `${a.type}|${a.unit}|${a.currency}`.localeCompare(`${b.type}|${b.unit}|${b.currency}`));
  conflicts.sort((a, b) => `${a.type}|${a.unit}|${a.currency}`.localeCompare(`${b.type}|${b.unit}|${b.currency}`));
  for (const item of agreements) sortSources(item.sources);
  for (const item of conflicts) for (const value of item.values) sortSources(value.sources);
  return {
    sourceCount: sources.size,
    comparable,
    agreementRatio: Number((agreements.length / comparable).toFixed(2)),
    agreements,
    conflicts,
  };
}
