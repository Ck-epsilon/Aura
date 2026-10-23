// 站点包：内置的大陆直连默认站点 + 用户自定义 sites.json。
// 站点是「实体 → 一手源」的扩展层，不改变 registry 的官方源语义。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ArgusError, CODES } from './errors.mjs';
import { defaultSitesFile, expandHome } from './paths.mjs';

const BUILTIN_URL = new URL('../sites.json', import.meta.url);
const BUILTIN_PATH = fileURLToPath(BUILTIN_URL);
const builtinRaw = fs.readFileSync(BUILTIN_URL, 'utf8');
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function fail(label, message, details = {}) {
  throw new ArgusError(CODES.BAD_REQUEST, `${label}: ${message}`, { file: label, ...details });
}

function parseHttpUrl(value, label, id) {
  let url;
  try { url = new URL(String(value)); } catch { fail(label, `site "${id}" has an invalid URL: ${value}`, { site: id }); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail(label, `site "${id}" only supports http(s) URLs: ${value}`, { site: id });
  }
  if (url.username || url.password) fail(label, `site "${id}" URL must not contain credentials`, { site: id });
  return url;
}

function normalizeSource(source, label, id) {
  if (!source || typeof source !== 'object') fail(label, `site "${id}" sources must be objects`, { site: id });
  const url = parseHttpUrl(source.url, label, id).href;
  const covers = Array.isArray(source.covers)
    ? [...new Set(source.covers.map((cover) => String(cover).trim().toLowerCase()).filter(Boolean))]
    : [];
  return {
    url,
    ...(typeof source.title === 'string' && source.title.trim() ? { title: source.title.trim() } : {}),
    ...(covers.length ? { covers } : {}),
    ...(source.fallback === true ? { fallback: true } : {}),
    ...(typeof source.lang === 'string' && source.lang.trim() ? { lang: source.lang.trim().toLowerCase() } : {}),
  };
}

function normalizeDiscovery(discovery, label, id) {
  if (!discovery || typeof discovery !== 'object') fail(label, `site "${id}" discovery must be an object`, { site: id });
  const type = discovery.type ?? 'sitemap';
  if (type !== 'sitemap' && type !== 'index') fail(label, `site "${id}" discovery.type must be sitemap or index`, { site: id });
  return { type, url: parseHttpUrl(discovery.url, label, id).href };
}

function normalizeSite(id, value, label, origin) {
  if (!ID_RE.test(id)) fail(label, `invalid site id: ${id}`, { site: id });
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label, `site "${id}" must be an object`, { site: id });
  const aliases = Array.isArray(value.aliases)
    ? [...new Set(value.aliases.map((alias) => String(alias).trim()).filter(Boolean))]
    : [];
  const sources = Array.isArray(value.sources)
    ? value.sources.map((source) => ({ ...normalizeSource(source, label, id), origin }))
    : [];
  if (value.disabled !== true && sources.length === 0) {
    fail(label, `site "${id}" must contain at least one source`, { site: id });
  }
  return {
    id,
    aliases,
    sources,
    ...(value.discovery ? { discovery: normalizeDiscovery(value.discovery, label, id) } : {}),
    ...(typeof value.region === 'string' && value.region.trim() ? { region: value.region.trim().toLowerCase() } : {}),
    ...(value.disabled === true ? { disabled: true } : {}),
    origin,
  };
}

function parsePack(raw, label, origin) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch (error) { fail(label, `invalid JSON: ${error.message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(label, 'root must be a JSON object');
  const rawSites = parsed.sites ?? parsed.entities ?? {};
  if (!rawSites || typeof rawSites !== 'object' || Array.isArray(rawSites)) {
    fail(label, '"sites" must be an object');
  }
  const sites = {};
  const seenUrls = new Map();
  for (const [id, value] of Object.entries(rawSites)) {
    const site = normalizeSite(id, value, label, origin);
    for (const source of site.sources) {
      if (seenUrls.has(source.url)) {
        fail(label, `duplicate source URL in ${id} and ${seenUrls.get(source.url)}: ${source.url}`, { site: id, url: source.url });
      }
      seenUrls.set(source.url, id);
    }
    sites[id] = site;
  }
  return sites;
}

const builtinSites = parsePack(builtinRaw, 'built-in sites', 'default');

function mergeSite(base, extra) {
  const sources = [...base.sources];
  const index = new Map(sources.map((source) => [source.url, sources.indexOf(source)]));
  for (const source of extra.sources) {
    if (index.has(source.url)) sources[index.get(source.url)] = source;
    else { index.set(source.url, sources.length); sources.push(source); }
  }
  return {
    ...base,
    ...extra,
    aliases: [...new Set([...(base.aliases || []), ...(extra.aliases || [])])],
    sources,
    ...(base.discovery || extra.discovery ? { discovery: extra.discovery || base.discovery } : {}),
    ...(base.region || extra.region ? { region: extra.region || base.region } : {}),
    ...(extra.disabled === true || base.disabled === true ? { disabled: true } : {}),
    origin: base.origin === extra.origin ? base.origin : `${base.origin}+${extra.origin}`,
  };
}

function resolveUserFile(file, env) {
  if (typeof file === 'string' && file.trim()) {
    return { path: path.resolve(expandHome(file.trim())), explicit: true };
  }
  if (env.AURA_ARGUS_SITES) {
    return { path: path.resolve(expandHome(env.AURA_ARGUS_SITES)), explicit: true };
  }
  return { path: defaultSitesFile(env), explicit: false };
}

let cache = null;

/**
 * 读取内置站点包与用户站点包。用户文件按 id 合并：aliases/sources 追加，
 * disabled:true 移除该实体；显式指定但不存在的文件会报 BAD_REQUEST。
 */
export function loadSites({ file, env = process.env } = {}) {
  const disabled = env.AURA_ARGUS_NO_SITES === '1';
  const user = resolveUserFile(file, env);
  const stat = !disabled && fs.existsSync(user.path) ? fs.statSync(user.path) : null;
  const key = JSON.stringify([disabled, user.path, user.explicit, stat?.mtimeMs ?? null, stat?.size ?? null, stat?.ctimeMs ?? null]);
  if (cache?.key === key) return cache.value;

  if (disabled) {
    const value = { sites: {}, version: 'disabled', files: { default: BUILTIN_PATH, user: null } };
    cache = { key, value };
    return value;
  }

  const sites = { ...builtinSites };
  let userRaw = '';
  if (stat) {
    userRaw = fs.readFileSync(user.path, 'utf8');
    const parsed = parsePack(userRaw, user.path, 'user');
    for (const [id, site] of Object.entries(parsed)) {
      sites[id] = sites[id] ? mergeSite(sites[id], site) : site;
    }
  } else if (user.explicit) {
    throw new ArgusError(CODES.BAD_REQUEST, `sites file not found: ${user.path}`, { file: user.path });
  }

  const version = crypto.createHash('sha256')
    .update(builtinRaw.replace(/\r\n/g, '\n'))
    .update('\n')
    .update(userRaw.replace(/\r\n/g, '\n'))
    .digest('hex').slice(0, 12);
  const value = {
    sites,
    version,
    files: { default: BUILTIN_PATH, user: stat ? user.path : null },
  };
  cache = { key, value };
  return value;
}

export function resetSitesCache() {
  cache = null;
}
