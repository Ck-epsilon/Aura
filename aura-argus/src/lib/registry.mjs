// 注册表：加载、实体匹配、查询词扩展、源排序。
import fs from 'node:fs';
import crypto from 'node:crypto';

const file = new URL('../registry.json', import.meta.url);
const raw = fs.readFileSync(file, 'utf8');
const registry = JSON.parse(raw);

export const registryVersion = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'when', 'which', 'how', 'does', 'do',
  'is', 'are', 'was', 'were', 'of', 'to', 'in', 'on', 'at', 'by', 'or', 'an', 'a', 'be', 'as', 'it',
  'its', 'can', 'could', 'should', 'would', 'will', 'may', 'might', 'not', 'no', 'than', 'then',
  'there', 'their', 'they', 'you', 'your', 'much', 'many',
]);

const CN_EN = {
  价格: 'pricing price', 多少钱: 'pricing price', 费用: 'pricing', 计费: 'billing pricing',
  退役: 'retirement', 停服: 'shutdown retirement', 下线: 'shutdown', 关闭: 'shutdown closed',
  免费额度: 'free quota', 免费: 'free', 默认: 'default', 配置: 'settings', 设置: 'settings',
  冷却: 'suspended timeout', 时间: 'time', 秒: 'seconds', 迁移: 'migration', 替代: 'migration',
  新客户: 'new customers', 客户: 'customers', 额度: 'quota', 请求: 'requests', 上限: 'limit',
  成功: 'successful', 每次: 'per', 格式: 'formats', 输出: 'output', 安装: 'install',
  创建服务器: 'createServer server', 读文件: 'readFile file', 读取文件: 'readFile',
  服务器: 'server', 文件: 'file', 模块: 'module', 命令: 'command commands',
  响应式: 'reactivity reactive', 怎么用: 'usage',
  用法: 'usage', 报错: 'error', 错误: 'error', 版本: 'version', 下载: 'download',
};

export function expandTerms(question) {
  const terms = new Set();
  const low = question.toLowerCase();
  for (const word of low.match(/[a-z][a-z0-9.+#_-]{1,}/g) || []) {
    if (!STOP.has(word)) terms.add(word);
  }
  for (const num of question.match(/\b\d{2,}\b/g) || []) terms.add(num);
  for (const [cn, en] of Object.entries(CN_EN)) {
    if (question.includes(cn)) for (const word of en.split(/\s+/)) if (word) terms.add(word.toLowerCase());
  }
  for (const run of question.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i < run.length - 1; i++) terms.add(run.slice(i, i + 2));
  }
  return terms;
}

export function matchEntity(question) {
  const low = question.toLowerCase();
  const hit = (alias) => {
    const needle = alias.toLowerCase();
    if (/^[a-z0-9.]+$/.test(needle) && needle.length <= 3) {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(low);
    }
    return low.includes(needle);
  };
  for (const [id, entity] of Object.entries(registry.entities)) {
    if ((entity.aliases || []).some(hit)) return { id, ...entity };
  }
  return null;
}

export function scoreSource(source, terms) {
  let score = 0;
  for (const cover of source.covers || []) {
    if (terms.has(cover)) { score += 3; continue; }
    for (const term of terms) {
      if (term.length >= 2 && (term.includes(cover) || cover.includes(term))) { score += 1; break; }
    }
  }
  return score;
}

export function rankSources(entity, terms) {
  return (entity.sources || [])
    .map((source) => ({ ...source, score: scoreSource(source, terms) }))
    .sort((a, b) => b.score - a.score);
}

export function listEntities() {
  return Object.entries(registry.entities).map(([id, entity]) => ({
    id,
    aliases: entity.aliases || [],
    sources: (entity.sources || []).map((s) => s.url),
    discovery: entity.discovery || null,
  }));
}

export function entityCount() {
  return Object.keys(registry.entities).length;
}

export function getEntity(id) {
  return registry.entities[id] || null;
}
