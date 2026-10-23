// 结果质量：查询 facet 覆盖与启发式置信度。只做可解释的本地计算，不调用模型。
import { GENERIC_TERMS } from './extract.mjs';

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'when', 'which', 'how', 'does', 'do',
  'is', 'are', 'was', 'were', 'of', 'to', 'in', 'on', 'at', 'by', 'or', 'an', 'a', 'be', 'as', 'it',
  'its', 'can', 'could', 'should', 'would', 'will', 'may', 'might', 'not', 'no', 'than', 'then',
  'there', 'their', 'they', 'you', 'your', 'much', 'many',
]);

/**
 * 参与 facet 覆盖检查的词：拉丁词/短语 + 实体 id/别名。
 * 中文二元组不进 facet（噪音高）；中文问题靠 CN_EN 展开出的英文词和实体名兜底。
 */
export function facetTerms(terms, { entity = null, limit = 8, exclude = [] } = {}) {
  const list = Array.isArray(terms) ? terms : [...terms];
  const out = [];
  const seen = new Set();
  const blocked = new Set(exclude.map((value) => String(value || '').toLowerCase()).filter(Boolean));
  const add = (value) => {
    const term = String(value || '').trim().toLowerCase();
    if (!term || seen.has(term) || blocked.has(term)) return;
    seen.add(term);
    out.push(term);
  };
  if (entity) {
    add(entity.id);
    // 别名不作为独立 facet：同一实体的 react.js/reactjs 会把覆盖率压低。
  }
  for (const term of list) {
    if (term.length < 3) continue;
    if (/^\d+$/.test(term)) continue;
    if (/\s/.test(term)) continue;
    if (!/^[a-z0-9._-]+$/i.test(term)) continue;
    if (STOP.has(term) || GENERIC_TERMS.has(term)) continue;
    add(term);
  }
  return out.sort((a, b) => b.length - a.length).slice(0, limit);
}

export function scoreFacets(evidence, facets) {
  const text = evidence
    .flatMap((entry) => entry.passages || [])
    .map((passage) => passage.text || '')
    .join('\n')
    .toLowerCase();
  const covered = [];
  const missing = [];
  for (const facet of facets) {
    (text.includes(facet) ? covered : missing).push(facet);
  }
  return {
    terms: facets,
    covered,
    missing,
    ratio: facets.length ? Number((covered.length / facets.length).toFixed(3)) : 0,
  };
}

/**
 * 置信度是给调用方的排序/重试信号，不是概率保证。
 * 权重：facet 覆盖 55%、最佳段落分 25%、来源数 20%。
 */
export function confidenceFor({ evidence, facets, allFailed = false }) {
  if (allFailed || evidence.length === 0) {
    return { score: 0, label: 'none', reason: allFailed ? 'all-sources-failed' : 'no-evidence' };
  }
  const coverage = facets?.ratio ?? 0;
  const topScore = Math.max(...evidence.map((entry) => entry.passages?.[0]?.score ?? 0), 0);
  const scoreFactor = Math.min(1, topScore / 25);
  const sourceFactor = Math.min(1, evidence.length / 2);
  let score = Number((0.55 * coverage + 0.25 * scoreFactor + 0.2 * sourceFactor).toFixed(2));
  // 关键 facet 缺失时不能标 high；否则 agent 会把“官方页”误当成“已回答”。
  const missing = facets?.missing || [];
  const critical = missing.filter((term) => term.length >= 5 && !GENERIC_TERMS.has(term));
  if (critical.length) score = Math.min(score, 0.74);
  else if (missing.length && coverage < 0.75) score = Math.min(score, 0.65);
  const label = score >= 0.75 ? 'high' : score >= 0.5 ? 'medium' : 'low';
  return { score, label };
}

/**
 * 一次算出结果契约里的 facets/confidence/next。
 */
export function qualityFor({ terms, entity, evidence, allFailed = false, exclude = [] }) {
  const termsList = facetTerms(terms, { entity, exclude });
  const facets = scoreFacets(evidence, termsList);
  const confidence = confidenceFor({ evidence, facets, allFailed });
  const next = evidence.length === 0
    ? { hint: 'no evidence; set site to a domain or enable fallback' }
    : facets.missing.length
      ? { missingFacets: facets.missing.slice(0, 5), hint: 'fetch a more specific page or set site to narrow the source' }
      : null;
  return { facets, confidence, ...(next ? { next } : {}) };
}
