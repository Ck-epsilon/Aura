// 答案可达性：facet 覆盖不等于答案存在，错误/对比/数字题需要更硬的信号。
import { GENERIC_TERMS } from './extract.mjs';

const ERROR_MARKERS = [
  /\b[45]\d{2}\b/,
  /\bE[A-Z]{3,}\b/,
  /\bOOM\b|OOMKilled/i,
  /CrashLoopBackOff|ImagePullBackOff/i,
  /ModuleNotFoundError|ImportError|UnicodeDecodeError|PermissionError|UnhandledPromiseRejection/i,
  /Lock wait timeout/i,
  /too many connections/i,
  /permission denied/i,
  /rate limit|toomanyrequests/i,
  /EADDRINUSE/i,
  /ECONN[A-Z]+/i,
  /Duplicate entry/i,
  /Access denied/i,
  /server has gone away/i,
  /no space left/i,
  /READONLY/i,
  /NOAUTH/i,
];

const ACTION_SIGNALS = /\b(?:maxmemory|eviction|max_connections|superuser_reserved_connections|innodb_lock_wait_timeout|upstream|proxy|docker group|sudo|x-ratelimit|retry|kubectl|describe|logs|pip|sys\.path|listen|kill|port|cooldown|sleep|limit|config(?:ure|uration)?|setting|unique|index|grant|user|flush|memory|image|pull|registry|encoding|decode|catch|rejection|disk|prune|space)\b/i;

const ERROR_HINTS = [
  { match: /OOM|OOMKilled/i, hint: /\b(?:maxmemory|maxmemory-policy|eviction|noeviction|appendonly|memory|limit)\b/i },
  { match: /CrashLoopBackOff|ImagePullBackOff/i, hint: /\b(?:kubectl\s+logs|kubectl\s+describe|events|restart|backoff|image|pull|registry)\b/i },
  { match: /ModuleNotFoundError|ImportError/i, hint: /\b(?:pip|sys\.path|install|virtualenv|module)\b/i },
  { match: /UnicodeDecodeError/i, hint: /\b(?:encoding|decode|utf-?8|bytes)\b/i },
  { match: /PermissionError|permission denied/i, hint: /\b(?:chmod|sudo|permission|owner|docker group|usermod)\b/i },
  { match: /UnhandledPromiseRejection/i, hint: /\b(?:catch|rejection|handler|process)\b/i },
  { match: /EADDRINUSE/i, hint: /\b(?:port|listen|kill|process)\b/i },
  { match: /Lock wait timeout/i, hint: /\b(?:innodb_lock_wait_timeout|lock_wait|deadlock)\b/i },
  { match: /too many connections/i, hint: /\b(?:max_connections|superuser_reserved_connections|connection)\b/i },
  { match: /502|504/i, hint: /\b(?:proxy_pass|connect|timed out|refused|upstream timed|timeout)\b/i },
  { match: /permission denied|docker daemon socket/i, hint: /\b(?:docker group|sudo|chmod|usermod)\b/i },
  { match: /rate limit|403|toomanyrequests/i, hint: /\b(?:x-ratelimit|retry-after|token|secondary rate|login|limit)\b/i },
  { match: /429/i, hint: /\b(?:cooldown|retry-after|limit|sleep|3600)\b/i },
  { match: /Duplicate entry/i, hint: /\b(?:unique|index|primary key|insert|on duplicate)\b/i },
  { match: /Access denied/i, hint: /\b(?:grant|user|password|privilege|authentication)\b/i },
  { match: /server has gone away/i, hint: /\b(?:max_allowed_packet|timeout|connection|wait_timeout)\b/i },
  { match: /no space left/i, hint: /\b(?:disk|prune|space|df|cleanup|volume)\b/i },
  { match: /READONLY/i, hint: /\b(?:replica|replication|master|read-only|readonly)\b/i },
  { match: /NOAUTH/i, hint: /\b(?:requirepass|auth|password|acl)\b/i },
  { match: /413/i, hint: /\b(?:client_max_body_size|body|upload|size)\b/i },
  { match: /422/i, hint: /\b(?:validation|unprocessable|schema|field)\b/i },
];

const NUMERIC_QUESTION = /(?:端口|多少|几|qps|上限|价格|费用|price|port|how many|how much|limit|quota)/i;
const COMPARATIVE = /区别|对比|比较|差异|\bvs\.?\b|\bversus\b|\bdifference\b|\bcompare\b/i;
const COMPARISON_TERMS = new Set(['compare', 'comparison', 'difference', 'differences', 'versus']);

export function errorMarker(question) {
  const text = String(question || '');
  for (const pattern of ERROR_MARKERS) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

export function errorHint(question) {
  return ERROR_HINTS.find((entry) => entry.match.test(String(question || '')))?.hint || ACTION_SIGNALS;
}

function specificTerms(terms = []) {
  return [...terms]
    .map((term) => String(term).toLowerCase())
    .filter((term) => term.length >= 4 && /^[a-z0-9._-]+$/.test(term) && !GENERIC_TERMS.has(term) && !COMPARISON_TERMS.has(term));
}

/**
 * @param {{question:string, intent:string, evidence:Array, terms?:Iterable<string>}} input
 */
export function isAnswerable({ question, intent, evidence = [], terms = [] } = {}) {
  const passages = evidence.flatMap((entry) => entry.passages || []);
  const text = passages.map((passage) => passage.text || '').join('\n');
  if (!text.trim()) return false;

  if (intent === 'error') {
    const marker = errorMarker(question);
    if (marker) {
      const hint = ERROR_HINTS.find((entry) => entry.match.test(question))?.hint || ACTION_SIGNALS;
      const matching = passages.filter((passage) => String(passage.text || '').toLowerCase().includes(marker.toLowerCase()));
      if (!matching.length) return false;
      if (!matching.some((passage) => hint.test(String(passage.text || '')))) return false;
    }
  }

  if (intent === 'compare') {
    const top = passages.map((passage) => passage.text || '').join('\n').toLowerCase();
    const required = specificTerms(terms);
    if (required.length >= 2 && required.some((term) => !top.includes(term))) return false;
    if (/\bport\b|端口/i.test(question)) {
      const portPattern = /(?:\bport\b|端口)\D{0,30}\d{2,5}|\d{2,5}\D{0,30}(?:\bport\b|端口)/i;
      const portNumbers = new Set(
        [...top.matchAll(/\b\d{4,5}\b/g)]
          .map((match) => Number(match[0]))
          .filter((value) => value < 1900 || value > 2100),
      );
      if (!passages.slice(0, 6).some((passage) => portPattern.test(String(passage.text || '')))
        && portNumbers.size < 2) return false;
    } else if (NUMERIC_QUESTION.test(question) && !/\d/.test(top)) return false;
    if (COMPARATIVE.test(question) && required.length >= 2 && !/\bport\b|端口/i.test(question)) {
      const pair = passages.some((passage) => {
        const text = String(passage.text || '').toLowerCase();
        return required.filter((term) => text.includes(term)).length >= 2;
      });
      if (!pair) return false;
    }
  }

  return true;
}
