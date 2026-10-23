// 汇总本地查询日志：哪些实体/缺口最常见，哪些查询没有证据或置信度低。
export function summarizeQueries(records) {
  const modes = {};
  const entities = {};
  const missing = {};
  let noEvidence = 0;
  let lowConfidence = 0;
  let highConfidence = 0;

  for (const record of records) {
    modes[record.mode] = (modes[record.mode] || 0) + 1;
    if (record.entity) entities[record.entity] = (entities[record.entity] || 0) + 1;
    for (const term of record.missing || []) missing[term] = (missing[term] || 0) + 1;
    if (!record.sources) noEvidence += 1;
    if (record.confidenceLabel === 'low' || record.confidence === 0) lowConfidence += 1;
    if (record.confidenceLabel === 'high') highConfidence += 1;
  }

  const top = (value, limit = 10) => Object.entries(value)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([id, count]) => ({ id, count }));

  return {
    total: records.length,
    modes,
    noEvidence,
    lowConfidence,
    highConfidence,
    topEntities: top(entities),
    topMissing: top(missing),
    recent: records.slice(-20),
  };
}
