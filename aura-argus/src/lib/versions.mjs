// 版本文档路由：问题里的版本号（Node 20 / Python 3.11 / MySQL 8.0）把官方源重写到对应版本。
import fs from 'node:fs';

const raw = JSON.parse(fs.readFileSync(new URL('../versions.json', import.meta.url), 'utf8'));
const ENTITIES = raw.entities || {};

export function supportedVersions(entityId) {
  return [...(ENTITIES[entityId]?.allowed || [])];
}

export function resolveVersion(question, entity, requested = null) {
  const spec = ENTITIES[entity?.id];
  if (!spec) return null;
  let version = requested !== null && requested !== undefined && String(requested).trim()
    ? String(requested).trim()
    : null;
  if (!version) {
    const match = String(question || '').match(new RegExp(spec.pattern, 'i'));
    version = match?.[1] || null;
  }
  if (!version) return null;
  const supported = !Array.isArray(spec.allowed) || spec.allowed.includes(version);
  return { version, supported, rewrites: supported ? (spec.rewrites || []) : [] };
}

export function applyVersionRules(sources, resolved) {
  if (!resolved?.supported) return sources || [];
  return (sources || []).map((source) => {
    const rule = (resolved.rewrites || []).find((item) => source.url.startsWith(item.from));
    if (!rule) return source;
    const suffix = source.url.slice(rule.from.length);
    return {
      ...source,
      url: `${rule.to.replace('{version}', resolved.version)}${suffix}`,
      version: resolved.version,
    };
  });
}
