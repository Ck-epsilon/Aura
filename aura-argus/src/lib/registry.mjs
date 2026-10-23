// 注册表：加载、实体匹配、查询词扩展、源排序；叠加默认/自定义站点包。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { ArgusError, CODES } from './errors.mjs';
import { loadSites } from './sites.mjs';

const file = new URL('../registry.json', import.meta.url);
const raw = fs.readFileSync(file, 'utf8');
const registry = JSON.parse(raw);

export const registryVersion = crypto.createHash('sha256').update(raw.replace(/\r\n/g, '\n')).digest('hex').slice(0, 12);

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'when', 'which', 'how', 'does', 'do',
  'is', 'are', 'was', 'were', 'of', 'to', 'in', 'on', 'at', 'by', 'or', 'an', 'a', 'be', 'as', 'it',
  'its', 'can', 'could', 'should', 'would', 'will', 'may', 'might', 'not', 'no', 'than', 'then',
  'there', 'their', 'they', 'you', 'your', 'much', 'many',
]);

const CN_EN = {
  价格: 'pricing price', 多少钱: 'pricing price', 费用: 'pricing', 计费: 'billing pricing',
  退役: 'retirement', 停服: 'shutdown retirement', 下线: 'shutdown', 关闭: 'shutdown closed',
  免费额度: 'free quota', 免费: 'free', 默认: 'default', 配置: 'settings configure configuration',
  设置: 'settings', 冷却: 'suspended timeout', 时间: 'time', 秒: 'seconds', 迁移: 'migration',
  替代: 'migration', 新客户: 'new customers', 客户: 'customers', 额度: 'quota',
  请求: 'requests', 上限: 'limit', 成功: 'successful', 每次: 'per', 格式: 'formats',
  输出: 'output', 安装: 'install', 创建服务器: 'createServer server', 创建: 'create',
  新建: 'create', 读文件: 'readFile file', 读取文件: 'readFile', 写文件: 'writeFile',
  写入文件: 'writeFile', 服务器: 'server', 文件: 'file', 模块: 'module',
  命令: 'command commands', 响应式: 'reactivity reactive', 怎么用: 'usage', 用法: 'usage',
  报错: 'error', 错误: 'error', 版本: 'version', 下载: 'download', 事务: 'transaction',
  隔离: 'isolation', 级别: 'level', 数据源: 'datasource', 分页: 'pagination',
  限流: 'rate limit', 配额: 'quota', 超时: 'timeout', 重试: 'retry', 缓存: 'cache',
  部署: 'deploy deployment', 依赖: 'dependency dependencies', 索引: 'index',
  权限: 'permission', 认证: 'authentication', 回调: 'callback', 异步: 'async asynchronous',
  并发: 'concurrency', 生命周期: 'lifecycle', 上传: 'upload', 数据库: 'database',
  容器: 'container', 镜像: 'image', 集群: 'cluster', 日志: 'log logging',
  测试: 'test testing', 构建: 'build', 删除: 'delete', 更新: 'update', 查询: 'query',
  插入: 'insert', 连接: 'connect connection', 端口: 'port',
  模型: 'model', 本地: 'local', 拉取: 'pull', 开启: 'enable', 模式: 'mode',
  漏洞: 'vulnerability', 域名: 'domain', 自定义域: 'custom domain', 页面: 'page widget scaffold',
  实例: 'instance', 规格: 'specification', 选型: 'selection choose',
};

// 中文意图短语作为一个整体参与选段；单独拆词会把 create table 这类信号打散。
const CN_PHRASES = {
  创建表: 'create table', 建表: 'create table',
  事务隔离级别: 'transaction isolation level', 隔离级别: 'isolation level',
  滚动更新: 'rolling update', 手机号: 'phone number',
  错误码: 'error code', 状态码: 'status code',
  环境变量: 'environment variable', 默认端口: 'default port', 免费额度: 'free quota',
  新特性: 'release notes', 什么时候退役: 'end of life', 停止支持: 'end of life',
  支持到什么时候: 'end of life', 还支持吗: 'end of life',
};

export function versionTokens(question) {
  const text = String(question || '');
  const tokens = new Set();
  for (const match of text.matchAll(/\b\d+\.\d+(?:\.\d+)?\b/g)) tokens.add(match[0]);
  for (const match of text.matchAll(/(?:版本|version|v)\s*(\d{1,3})\b/gi)) tokens.add(match[1]);
  return [...tokens];
}

export function expandTerms(question) {
  const terms = new Set();
  const low = question.toLowerCase();
  const content = (low.match(/[a-z][a-z0-9.+#_-]{1,}/g) || []).filter((word) => !STOP.has(word));
  for (const word of content) terms.add(word);
  // 英文相邻实词组成短语，让 "how to create a table" 也能命中 "create table"。
  for (let i = 0; i < content.length - 1; i++) terms.add(`${content[i]} ${content[i + 1]}`);
  for (const num of question.match(/\b\d{2,}\b/g) || []) terms.add(num);
  for (const token of versionTokens(question)) terms.add(token);
  for (const [cn, en] of Object.entries(CN_EN)) {
    if (!question.includes(cn)) continue;
    for (const word of en.split(/\s+/)) if (word) terms.add(word.toLowerCase());
  }
  for (const [cn, en] of Object.entries(CN_PHRASES)) {
    if (!question.includes(cn)) continue;
    terms.add(en);
    for (const word of en.split(/\s+/)) terms.add(word);
  }
  for (const run of question.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i < run.length - 1; i++) terms.add(run.slice(i, i + 2));
  }
  return terms;
}


function uniqueAliases(list) {
  const seen = new Set();
  return list.filter((alias) => {
    const key = alias.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const EMPTY_PACK = { sites: {}, version: 'disabled', files: { default: null, user: null } };

function mergeSources(base, extra) {
  const sources = base.map((source) => ({ ...source, origin: source.origin || 'registry' }));
  const index = new Map(sources.map((source, position) => [source.url, position]));
  for (const source of extra) {
    const existing = index.get(source.url);
    if (existing !== undefined) sources[existing] = { ...source };
    else { index.set(source.url, sources.length); sources.push({ ...source }); }
  }
  return sources;
}

function assertUniqueSources(entities) {
  const seen = new Map();
  for (const [id, entity] of Object.entries(entities)) {
    for (const source of entity.sources) {
      const owner = seen.get(source.url);
      if (owner && owner !== id) {
        throw new ArgusError(CODES.BAD_REQUEST, `duplicate source URL across ${owner} and ${id}: ${source.url}`, { url: source.url, entities: [owner, id] });
      }
      seen.set(source.url, id);
    }
  }
}

let coverageCache = null;

/**
 * 路由视图 = registry + 默认站点包 + 用户站点包。
 * `sites: false` 回到严格 registry；`sitesFile` 指定用户站点文件。
 */
export function getCoverage({ sitesFile, sites = true, env = process.env } = {}) {
  const pack = sites === false ? EMPTY_PACK : loadSites({ file: sitesFile, env });
  const key = `${registryVersion}|${pack.version}`;
  if (coverageCache?.key === key) return coverageCache.value;

  const entities = {};
  for (const [id, entity] of Object.entries(registry.entities)) {
    entities[id] = {
      ...entity,
      aliases: [...(entity.aliases || [])],
      sources: (entity.sources || []).map((source) => ({ ...source, origin: 'registry' })),
      origin: 'registry',
    };
  }

  for (const [id, site] of Object.entries(pack.sites)) {
    if (site.disabled) {
      delete entities[id];
      continue;
    }
    const base = entities[id];
    if (base) {
      entities[id] = {
        ...base,
        ...(site.discovery ? { discovery: site.discovery } : {}),
        ...(site.region ? { region: site.region } : {}),
        aliases: uniqueAliases([...(base.aliases || []), ...(site.aliases || [])]),
        sources: mergeSources(base.sources, site.sources),
        origin: `${base.origin}+${site.origin}`,
      };
    } else {
      entities[id] = {
        aliases: uniqueAliases([id, ...(site.aliases || [])]),
        sources: site.sources.map((source) => ({ ...source })),
        ...(site.discovery ? { discovery: site.discovery } : {}),
        ...(site.region ? { region: site.region } : {}),
        origin: site.origin,
      };
    }
  }

  assertUniqueSources(entities);
  const value = { entities, version: `${registryVersion}-${pack.version}`, sitesVersion: pack.version, files: pack.files };
  coverageCache = { key, value };
  return value;
}

export function coverageVersion(options = {}) {
  return getCoverage(options).version;
}

const hasAlias = (low, alias) => {
  const needle = alias.toLowerCase();
  if (!needle) return false;
  if (/^[a-z0-9.]+$/.test(needle) && needle.length <= 3) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(low);
  }
  return low.includes(needle);
};

export function matchEntity(question, coverage = getCoverage()) {
  const [first] = matchEntities(question, coverage, { limit: 1 });
  if (!first) return null;
  const { score, position, ...entity } = first;
  return entity;
}

/**
 * 返回所有命中的实体，按别名长度排序。只给多实体/对比问题用，
 * 普通问题仍走 matchEntity，保持首个命中语义不变。
 */
export function matchEntities(question, coverage = getCoverage(), { limit = 3 } = {}) {
  const low = question.toLowerCase();
  const scored = [];
  for (const [id, entity] of Object.entries(coverage.entities)) {
    let best = 0;
    let position = Infinity;
    for (const alias of entity.aliases || []) {
      if (!hasAlias(low, alias)) continue;
      const needle = alias.toLowerCase();
      const latin = /^[a-z0-9.]+$/.test(needle);
      const score = latin ? (needle.length <= 3 ? needle.length + 3 : needle.length) : needle.length + 2;
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const at = /^[a-z0-9.]+$/.test(needle) && needle.length <= 3
        ? (() => {
            const match = new RegExp(`(^|[^a-z0-9])${escaped}(?=[^a-z0-9]|$)`, 'i').exec(low);
            return match ? match.index + match[1].length : -1;
          })()
        : low.indexOf(needle);
      if (at < 0) continue;
      if (at < position || (at === position && score > best)) {
        position = at;
        best = score;
      }
    }
    if (best >= 3) scored.push({ id, ...entity, score: best, position });
  }
  return scored
    .sort((a, b) => a.position - b.position || b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, limit));
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

export function listEntities(options = {}) {
  const coverage = getCoverage(options);
  return Object.entries(coverage.entities).map(([id, entity]) => ({
    id,
    aliases: entity.aliases || [],
    sources: (entity.sources || []).map((source) => source.url),
    discovery: entity.discovery || null,
    origin: entity.origin,
    ...(entity.region ? { region: entity.region } : {}),
  }));
}

export function entityCount(options = {}) {
  return Object.keys(getCoverage(options).entities).length;
}

export function getEntity(id, options = {}) {
  const entity = getCoverage(options).entities[id];
  return entity ? { id, ...entity } : null;
}
