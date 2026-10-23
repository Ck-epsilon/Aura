// 从行文本里选「能回答问题的段」：打分 + 邻行窗口。
import { createHash } from 'node:crypto';

import { collapse } from './text.mjs';

export function slugifyHeading(value) {
  return String(value || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function shortId(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 12);
}

export function mergeBlocks(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/:\s*$/.test(line)) {
      const extra = [];
      let j = i + 1;
      while (j < lines.length && /^[-*]\s+/.test(lines[j]) && extra.length < 8) { extra.push(lines[j]); j++; }
      if (extra.length) { out.push(`${line} ${extra.join(' ')}`); i = j - 1; continue; }
    }
    if (line.length <= 40) {
      const run = [line];
      let j = i + 1;
      while (j < lines.length && lines[j].length <= 40 && run.length < 6) { run.push(lines[j]); j++; }
      if (run.length >= 3) { out.push(run.join(' ')); i = j - 1; continue; }
    }
    out.push(line);
  }
  return out;
}

function packSentences(line, maxChars) {
  if (line.length <= maxChars) return [line];
  const parts = line.split(/(?<=[.!?。！？])\s+/);
  const out = [];
  let buffer = '';
  const flush = () => { if (buffer) { out.push(buffer); buffer = ''; } };
  for (const part of parts) {
    if (!part) continue;
    if (buffer && buffer.length + 1 + part.length > maxChars) flush();
    if (part.length <= maxChars) {
      buffer = buffer ? `${buffer} ${part}` : part;
      continue;
    }
    flush();
    let rest = part;
    while (rest.length > maxChars) {
      let cut = rest.lastIndexOf(' ', maxChars);
      if (cut < maxChars / 2) cut = maxChars;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    buffer = rest;
  }
  flush();
  return out;
}

/**
 * 选段块：标题、代码行、短行组各自成块；长正文按句子打包，避免整页一大段被截断。
 */
export function buildChunks(lines, { maxChars = 600 } = {}) {
  const out = [];
  const stack = [];
  let heading = '';
  let headingPath = '';
  let anchor = '';
  const slugs = new Map();
  const push = (text, kind, startLine, endLine) => {
    if (text && text.trim()) out.push({ text, kind, heading, headingPath, anchor, startLine, endLine });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line.trim())) {
      i += 1;
      const code = [];
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        code.push({ text: lines[i].replace(/\s+$/, ''), line: i + 1 });
        i += 1;
      }
      let group = [];
      let chars = 0;
      const flush = () => {
        if (group.length) {
          push(group.map((item) => item.text).join('\n'), 'code', group[0].line, group[group.length - 1].line);
          group = [];
          chars = 0;
        }
      };
      for (const item of code) {
        if (!item.text.trim()) {
          if (group.length) { group.push(item); chars += 1; }
          continue;
        }
        if (group.length && chars + item.text.length + 1 > maxChars) flush();
        group.push(item);
        chars += item.text.length + 1;
      }
      flush();
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^(#{1,6})/)[1].length;
      heading = line.replace(/^#+\s*/, '').replace(/\s*#\s*$/, '').trim();
      stack[level - 1] = heading;
      stack.length = level;
      headingPath = stack.filter(Boolean).join(' > ');
      const base = slugifyHeading(heading) || 'section';
      const seen = (slugs.get(base) || 0) + 1;
      slugs.set(base, seen);
      anchor = seen === 1 ? base : `${base}-${seen}`;
      push(line, 'heading', i + 1, i + 1);
      continue;
    }
    if (/:\s*$/.test(line)) {
      const extra = [];
      let j = i + 1;
      while (j < lines.length && /^[-*]\s+/.test(lines[j]) && extra.length < 8) { extra.push(lines[j]); j++; }
      if (extra.length) { push(`${line} ${extra.join(' ')}`, 'list', i + 1, j); i = j - 1; continue; }
    }
    if (line.length <= 40) {
      const run = [line];
      let j = i + 1;
      while (j < lines.length && lines[j].length <= 40 && !/^```|^#{1,6}\s/.test(lines[j]) && run.length < 6) {
        run.push(lines[j]);
        j++;
      }
      if (run.length >= 3) { push(run.join(' '), / \| /.test(run.join(' ')) ? 'table' : 'list', i + 1, j); i = j - 1; continue; }
    }
    for (const part of packSentences(line, maxChars)) push(part, / \| /.test(part) ? 'table' : 'prose', i + 1, i + 1);
  }
  return out;
}

const GENERIC = new Set([
  'api', 'command', 'configuration', 'configure', 'docs', 'documentation', 'error', 'example', 'file', 'function',
  'guide', 'install', 'method', 'module', 'option', 'options', 'server', 'settings', 'usage', 'version',
]);

export { GENERIC as GENERIC_TERMS };

export function buildWeights(lines, terms) {
  const weights = new Map();
  const total = Math.max(1, lines.length);
  for (const term of terms) {
    if (term.length < 2) continue;
    let df = 0;
    for (const line of lines) if (line.toLowerCase().includes(term)) df++;
    // 页面里根本不存在的词（常见于中文二元组）不参与打分，也不会被 IDF 放大。
    if (df === 0) continue;
    const idf = Math.min(4.5, 1 + Math.log(1 + total / (df + 1)));
    weights.set(term, idf * (GENERIC.has(term) ? 0.55 : 1));
  }
  return weights;
}

export function scoreLine(line, terms, weights = null, meta = null) {
  const list = Array.isArray(terms) ? terms : [...terms];
  let score = 0;
  const low = line.toLowerCase();
  for (const term of list) {
    if (term.length < 2) continue;
    if (!low.includes(term)) continue;
    // 英文/短语按 3 计，中文二元组按 2 计；短语本身已经在 expandTerms 里作为一个词加入。
    const base = /^[a-z0-9.\s_-]+$/.test(term) ? 3 : 2;
    score += base * (weights?.get(term) ?? 1);
  }
  if (/^#{1,6}\s/.test(line) && score > 0) score += 2;
  if (meta?.kind === 'code' && score > 0) score += 1.5;
  if (meta?.kind === 'table' && score > 0) score += 1.5;
  if (meta?.heading && score > 0) {
    const heading = meta.heading.toLowerCase();
    let bonus = 0;
    for (const term of list) {
      if (term.length >= 3 && heading.includes(term)) bonus = Math.min(3, bonus + 1);
    }
    score += bonus;
  }
  if (/\d/.test(line)) score += 2;
  if (/\$\d/.test(line)) score += 4;
  if (/\d{4}-\d{2}-\d{2}|\d{4}年|per 1,000|qps|seconds|秒|3600/i.test(line)) score += 3;
  if (/^[a-z_]+\s*:\s*\d+/i.test(line)) score += 4;
  // 价格问题里，带货币金额的段落优先于泛泛介绍免费额度的营销段落。
  const priceQuery = list.includes('pricing') || list.includes('price') || list.includes('cost') || list.includes('billing');
  if (priceQuery && /(?:[$€£¥]\s?\d|\d+(?:\.\d+)?\s*(?:usd|cents?|per (?:credit|request|1,000)))/i.test(line)) score += 10;
  if (/cookie|登录|注册|版权所有|copyright|隐私政策|subscribe|newsletter/i.test(line)) score -= 5;
  if (/^(menu|expand|light mode|dark mode|auto light\/dark|skip to content|search syntax|configured engines|about searxng|why use a private instance)/i.test(line)) score -= 6;
  return score;
}

function clipAround(text, terms, maxChars) {
  if (text.length <= maxChars) return text;
  const low = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    if (term.length < 2) continue;
    const index = low.indexOf(term);
    if (index >= 0 && (at < 0 || index < at)) at = index;
  }
  if (at < 0 || at < maxChars * 0.6) return text.slice(0, maxChars);
  const start = Math.max(0, at - Math.floor(maxChars * 0.25));
  return `…${text.slice(start, start + maxChars - 1)}`;
}

export function selectPassages(rawLines, terms, { max = 6, window = 1, maxChars = 800 } = {}) {
  const list = [...terms];
  const chunks = buildChunks(rawLines);
  const weights = buildWeights(chunks.map((chunk) => chunk.text), list);
  const ranked = chunks
    .map((chunk, index) => ({ index, chunk, line: chunk.text, score: scoreLine(chunk.text, list, weights, chunk) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const picked = [];
  const ranges = [];
  const seen = new Set();
  const take = (hit) => {
    const from = Math.max(0, hit.index - window);
    const to = Math.min(chunks.length - 1, hit.index + window);
    const overlapIndex = ranges.findIndex(([start, end]) => !(to < start - 1 || from > end + 1));
    if (overlapIndex >= 0) {
      const [start, end] = ranges[overlapIndex];
      if (from >= start && to <= end) return false;
      // 相邻窗口并入已有段落，避免“following pragma:”与真正的命令被拆开。
      const newFrom = Math.min(start, from);
      const newTo = Math.max(end, to);
      const merged = collapse(chunks.slice(newFrom, newTo + 1).map((chunk) => chunk.text).join(' '));
      const mergedFocus = list.filter((term) => term.length >= 2 && merged.toLowerCase().includes(term));
      const text = clipAround(merged, mergedFocus, maxChars);
      if (text.length < 40) return false;
      ranges[overlapIndex] = [newFrom, newTo];
      picked[overlapIndex].text = text;
      picked[overlapIndex].score = Math.max(picked[overlapIndex].score, hit.score);
      picked[overlapIndex].lineStart = chunks[newFrom]?.startLine ?? picked[overlapIndex].lineStart;
      picked[overlapIndex].lineEnd = chunks[newTo]?.endLine ?? picked[overlapIndex].lineEnd;
      seen.add(text.toLowerCase().slice(0, 120));
      return true;
    }
    const focus = list.filter((term) => term.length >= 2 && hit.line.toLowerCase().includes(term));
    const text = clipAround(collapse(chunks.slice(from, to + 1).map((chunk) => chunk.text).join(' ')), focus, maxChars);
    if (text.length < 40) return false;
    const key = text.toLowerCase().slice(0, 120);
    if (seen.has(key)) return false;
    seen.add(key);
    ranges.push([from, to]);
    picked.push({
      text,
      score: hit.score,
      kind: hit.chunk.kind,
      heading: hit.chunk.heading || '',
      headingPath: hit.chunk.headingPath || '',
      anchor: hit.chunk.anchor || '',
      lineStart: chunks[from]?.startLine ?? null,
      lineEnd: chunks[to]?.endLine ?? null,
    });
    return true;
  };

  // 给最具体的高权重词预留少量位置，防止泛词段落把 API 名挤出证据包。
  const facets = [...weights.entries()]
    .filter(([term, weight]) => weight >= 3.2 && term.length >= 4 && !GENERIC.has(term))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([term]) => term);
  const reserve = Math.min(facets.length, Math.floor(max / 3));
  const termCount = (line) => list.filter((term) => term.length >= 2 && line.toLowerCase().includes(term)).length;
  const headingMatch = (chunk) => list.some((term) => term.length >= 4 && String(chunk.heading || '').toLowerCase().includes(term));
  const bestCode = ranked.find((entry) => entry.chunk.kind === 'code' && entry.score >= 6 && (termCount(entry.line) >= 2 || (termCount(entry.line) >= 1 && headingMatch(entry.chunk))));
  const codeReserve = bestCode ? 1 : 0;

  for (const hit of ranked) {
    if (picked.length >= max - reserve - codeReserve) break;
    take(hit);
  }
  for (const term of facets) {
    if (picked.length >= max) break;
    if (picked.some((passage) => passage.text.toLowerCase().includes(term))) continue;
    const hit = ranked.find((entry) => entry.line.toLowerCase().includes(term));
    if (hit) take(hit);
  }
  if (bestCode) take(bestCode);
  for (const hit of ranked) {
    if (picked.length >= max) break;
    take(hit);
  }
  return picked.map((passage) => ({
    ...passage,
    id: shortId(`${passage.headingPath || ''}\n${passage.text}`),
    anchorType: passage.anchor ? 'heading-slug' : null,
  }));
}

