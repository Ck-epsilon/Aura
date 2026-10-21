// 从行文本里选「能回答问题的段」：打分 + 邻行窗口。
import { collapse } from './text.mjs';

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

function buildWeights(lines, terms) {
  const weights = new Map();
  const total = Math.max(1, lines.length);
  for (const term of terms) {
    if (term.length < 2) continue;
    let df = 0;
    for (const line of lines) if (line.toLowerCase().includes(term)) df++;
    weights.set(term, 1 + Math.log(1 + total / (df + 1)));
  }
  return weights;
}

export function scoreLine(line, terms, weights = null) {
  let score = 0;
  const low = line.toLowerCase();
  for (const term of terms) {
    if (term.length < 2) continue;
    if (low.includes(term)) score += (/^[a-z0-9.]+$/.test(term) ? 3 : 2) * (weights?.get(term) ?? 1);
  }
  if (/\d/.test(line)) score += 2;
  if (/\$\d/.test(line)) score += 4;
  if (/\d{4}-\d{2}-\d{2}|\d{4}年|per 1,000|qps|seconds|秒|3600/i.test(line)) score += 3;
  if (/^[a-z_]+\s*:\s*\d+/i.test(line)) score += 4;
  if (/cookie|登录|注册|版权所有|copyright|隐私政策|subscribe|newsletter/i.test(line)) score -= 5;
  if (/^(menu|expand|light mode|dark mode|auto light\/dark|skip to content|search syntax|configured engines|about searxng|why use a private instance)/i.test(line)) score -= 6;
  return score;
}

export function selectPassages(rawLines, terms, { max = 6, window = 1, maxChars = 800 } = {}) {
  const lines = mergeBlocks(rawLines);
  const weights = buildWeights(lines, terms);
  const ranked = lines
    .map((line, index) => ({ index, line, score: scoreLine(line, terms, weights) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const picked = [];
  const seen = new Set();
  for (const hit of ranked) {
    if (picked.length >= max) break;
    const from = Math.max(0, hit.index - window);
    const to = Math.min(lines.length - 1, hit.index + window);
    const text = collapse(lines.slice(from, to + 1).join(' ')).slice(0, maxChars);
    if (text.length < 40) continue;
    const key = text.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push({ text, score: hit.score });
  }
  return picked;
}
