// 查询规划：意图识别 + 复合问题拆句。确定性规则，不调用模型。
const INTENTS = [
  {
    id: 'pricing',
    re: /price|pricing|cost|billing|free tier|quota|\bqps\b|价格|多少钱|费用|计费|免费额度|配额|上限/i,
  },
  {
    id: 'version',
    re: /\bversion\b|\brelease\b|\bretired?\b|\bdeprecated\b|版本|退役|停服|下线|支持到/i,
  },
  {
    id: 'error',
    re: /\berror\b|\bexception\b|status code|timeout|retry|\b4\d\d\b|\b5\d\d\b|报错|错误|异常|状态码|超时|重试/i,
  },
  {
    id: 'compare',
    re: /\bvs\.?\b|\bversus\b|\bcompare\b|\bdifference\b|区别|对比|比较|差异|分别|两者/i,
  },
  {
    id: 'howto',
    re: /怎么|如何|怎样|how\s+(?:do|to|can|does)|\bsteps?\b|配置|创建|安装|部署|使用|实现/i,
  },
  {
    id: 'list',
    re: /哪些|列出|list\s+of|what\s+are/i,
  },
];

const SPLIT = /[；;\n]+|\s+and\s+|(?<=[？?])\s*|，?\s*(?:以及|并且|另外|同时|分别)\s*/i;
const COMPARE = /\bvs\.?\b|\bversus\b|\bcompare\b|\bdifference\b|区别|对比|比较|差异|分别|两者/i;

export function detectIntent(question) {
  const text = String(question || '');
  for (const intent of INTENTS) {
    if (intent.re.test(text)) return { intent: intent.id, confidence: 0.8 };
  }
  return { intent: 'fact', confidence: 0.5 };
}

export function splitClauses(question) {
  const text = String(question || '').trim();
  if (!text) return [];
  if (COMPARE.test(text)) return [text];
  const parts = text
    .split(SPLIT)
    .map((part) => part.trim().replace(/[？?]+$/, '').trim())
    .filter(Boolean);
  if (parts.length < 2) return [text];
  if (parts.some((part) => part.length < 6)) return [text];
  return parts;
}

export function planQuery(question) {
  const intent = detectIntent(question);
  const clauses = splitClauses(question);
  return { ...intent, clauses, compound: clauses.length > 1 };
}
