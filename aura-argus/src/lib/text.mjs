// HTML → 行文本 / Markdown / 链接 / 标题；实体解码。零依赖。

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  thinsp: ' ', middot: '·', hellip: '…', mdash: '—', ndash: '–',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', times: '×', deg: '°', euro: '€', pound: '£',
};

export function decodeEntities(input) {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    }
    return NAMED[body.toLowerCase()] ?? ' ';
  });
}

export const collapse = (s) => s.replace(/[\s\u00a0]+/g, ' ').trim();
const stripTags = (s) => s.replace(/<[^>]*>/g, ' ');

export function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? collapse(decodeEntities(stripTags(m[1]))) : '';
}

export function htmlToLines(html) {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre|dt|dd|td)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s.split(/\n+/).map((x) => x.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean);
}

export function htmlToMarkdown(html) {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<div[^>]*(?:class|id)="[^"]*(?:sphinxsidebar|sidebar|related|breadcrumb|navigation|footer|header|menu)[^"]*"[^>]*>[\s\S]*?<\/div>/gi, ' ');
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (match, level, inner) => `\n${'#'.repeat(Number(level))} ${collapse(stripTags(inner))}\n`);
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (match, inner) => `\n- ${collapse(stripTags(inner))}\n`);
  s = s.replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (match, href, inner) => {
    const text = collapse(stripTags(inner));
    if (!text || /^(#|javascript:)/i.test(href)) return text;
    return `[${text}](${href.replace(/&amp;/g, '&')})`;
  });
  s = s.replace(/<\/(p|div|section|article|tr|blockquote|pre|dt|dd|td)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  const chrome = /^(menu|expand|light mode|dark mode|back to top|skip to content|search syntax|configured engines|about searxng|why use a private instance|previous|next|from here you can search these documents)$/i;
  return s
    .split('\n')
    .map((x) => x.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line) => !chrome.test(line.trim()) && !/^(auto light\/dark|view this page|edit this page|\[view this page\]|\[edit this page\]|©|copyright)/i.test(line.trim()))
    .map((line) => line.replace(/\s*¶\s*$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractLinks(html, base) {
  const out = [];
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let href = m[1].replace(/&amp;/g, '&');
    if (/^(#|javascript:|mailto:)/i.test(href)) continue;
    try { href = new URL(href, base).href; } catch { continue; }
    out.push({ href, text: collapse(decodeEntities(stripTags(m[2]))) });
  }
  return out;
}

export const extractXmlLocs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
