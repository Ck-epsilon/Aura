// 从已引用的 passages 里抽取可核对的结构化事实。确定性规则，不推测、不补全。
import { collapse } from './text.mjs';
import { shortId } from './extract.mjs';

const CURRENCY = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'CNY' };
const MONEY = /([$€£¥])\s?(\d[\d,]*(?:\.\d+)?)(?:\s*(?:per|\/|each)\s*([A-Za-z0-9,._-]+))?/gi;
const CODE_MONEY = /\b(USD|EUR|GBP|CNY)\s?(\d[\d,]*(?:\.\d+)?)(?:\s*(?:per|\/|each)\s*([A-Za-z0-9,._-]+))?/gi;
const PERCENT = /\b(\d+(?:\.\d+)?)\s?%/g;
const SEMVER = /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/g;
const DATE = /\b(\d{4}-\d{2}-\d{2})\b|\b(\d{4})年(\d{1,2})月(?:(\d{1,2})日)?|\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/gi;
const LIMIT = /\b(\d[\d,]*)\s*(requests?|credits?|tokens?|rpm|qps|rps|seconds?|secs?|ms|milliseconds?|minutes?|hours?|days?|每秒|每分钟|每小时|每天|每月|秒|毫秒|分钟|小时|天)\b/gi;
const STATUS = /\b(?:HTTP|status(?:\s+code)?|error)\D{0,12}([45]\d{2})\b/gi;

const VERSION_CONTEXT = /\b(?:version|release|requires?|minimum|since|until|before|after|deprecated|支持|版本|发布|最低|要求)\b/i;
const ERROR_INTENT = new Set(['error']);

function snippet(text, index, length) {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + length + 60);
  return collapse(`${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`);
}

function number(value) {
  return Number(String(value).replace(/,/g, ''));
}

function add(out, seen, fact) {
  const source = fact.sourceId || fact.url || '';
  const key = `${fact.type}|${fact.value}|${fact.unit || ''}|${fact.passageId || ''}|${source}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ id: shortId(key), ...fact });
}

/**
 * @param {Array<{id?:string,url?:string,passages?:Array}>} evidence
 * @param {{intent?: string, max?: number}} [options]
 */
export function extractFacts(evidence, { intent = 'fact', max = 20 } = {}) {
  const out = [];
  const seen = new Set();
  for (const entry of evidence || []) {
    for (const passage of entry.passages || []) {
      const text = String(passage.text || '');
      if (!text) continue;
      const base = {
        passageId: passage.id || null,
        sourceId: passage.sourceId || entry.id || null,
        url: passage.url || entry.url || null,
        citation: passage.citation || passage.url || entry.url || null,
      };
      const push = (fact) => add(out, seen, { ...base, ...fact });

      MONEY.lastIndex = 0;
      for (const match of text.matchAll(MONEY)) {
        const [full, symbol, amount, rawUnit] = match;
        const unit = rawUnit ? rawUnit.replace(/[),.;:]+$/, '').toLowerCase() : '';
        push({
          type: 'price',
          value: number(amount),
          currency: CURRENCY[symbol] || null,
          ...(unit ? { unit } : {}),
          text: snippet(text, match.index, full.length),
          confidence: 0.9,
        });
      }
      CODE_MONEY.lastIndex = 0;
      for (const match of text.matchAll(CODE_MONEY)) {
        const [full, currency, amount, rawUnit] = match;
        const unit = rawUnit ? rawUnit.replace(/[),.;:]+$/, '').toLowerCase() : '';
        push({
          type: 'price',
          value: number(amount),
          currency,
          ...(unit ? { unit } : {}),
          text: snippet(text, match.index, full.length),
          confidence: 0.9,
        });
      }

      for (const match of text.matchAll(PERCENT)) {
        push({
          type: 'percent',
          value: Number(match[1]),
          unit: '%',
          text: snippet(text, match.index, match[0].length),
          confidence: 0.85,
        });
      }

      for (const match of text.matchAll(SEMVER)) {
        const prefix = text.slice(Math.max(0, match.index - 3), match.index);
        if (/[$€£¥]\s?$/.test(prefix)) continue;
        if (/\b(?:USD|EUR|GBP|CNY)\s?$/i.test(prefix)) continue;
        if (intent !== 'version' && !VERSION_CONTEXT.test(text.slice(Math.max(0, match.index - 60), match.index))) continue;
        push({
          type: 'version',
          value: match[1],
          text: snippet(text, match.index, match[0].length),
          confidence: 0.8,
        });
      }

      for (const match of text.matchAll(DATE)) {
        const value = match[1]
          || (match[2] ? `${match[2]}-${String(match[3]).padStart(2, '0')}-${String(match[4] || '1').padStart(2, '0')}` : null)
          || (match[5] ? `${match[5]} ${match[6]}, ${match[7]}` : null);
        if (!value) continue;
        push({
          type: 'date',
          value,
          text: snippet(text, match.index, match[0].length),
          confidence: 0.85,
        });
      }

      for (const match of text.matchAll(LIMIT)) {
        const unit = match[2].toLowerCase();
        if (/^(?:requests?|credits?|tokens?)$/.test(unit)) {
          const before = text.slice(Math.max(0, match.index - 3), match.index);
          if (/[$€£¥]\s?$/.test(before)) continue;
        }
        push({
          type: 'limit',
          value: number(match[1]),
          unit,
          text: snippet(text, match.index, match[0].length),
          confidence: 0.8,
        });
      }

      if (ERROR_INTENT.has(intent)) {
        for (const match of text.matchAll(STATUS)) {
          push({
            type: 'status',
            value: Number(match[1]),
            text: snippet(text, match.index, match[0].length),
            confidence: 0.85,
          });
        }
      }
      if (out.length >= max * 2) break;
    }
    if (out.length >= max * 2) break;
  }
  const priority = intent === 'pricing'
    ? ['price', 'percent', 'limit']
    : intent === 'version'
      ? ['version', 'date', 'limit']
      : intent === 'error'
        ? ['status', 'limit', 'percent']
        : ['price', 'version', 'date', 'limit', 'percent', 'status'];
  const allowed = new Set(priority);
  const rank = (fact) => {
    const index = priority.indexOf(fact.type);
    return index >= 0 ? index : priority.length;
  };
  return out
    .filter((fact) => intent === 'fact' || intent === 'compare' || intent === 'howto' || intent === 'list' || allowed.has(fact.type))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, max);
}
