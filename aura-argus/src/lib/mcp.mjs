// MCP stdio server：换行分隔的 JSON-RPC 2.0。stdout 只写协议消息。
import readline from 'node:readline';
import { aura_argus_search as search, aura_argus_search_batch as searchBatch, aura_argus_fetch_document as fetchDocument, version } from '../core.mjs';
import { getCoverage, listEntities } from './registry.mjs';
import { API_NAMES } from './api-names.mjs';

const PROTOCOL_FALLBACK = '2025-06-18';
const BATCH_LIMIT = 20;

// Clients may surface this as a system-prompt section; keep tool names client-agnostic.
const SERVER_INSTRUCTIONS = `AuraArgus is a keyless retrieval layer over primary sources.
- Prefer the ${API_NAMES.search} tool (your client may prefix it with this server) over a generic web search for technical or factual questions about a covered entity; it returns citable passages with source URLs.
- Coverage is registry.json plus a default mainland-direct site pack plus an optional user sites.json. Use ${API_NAMES.sources} to inspect coverage and origins.
- Use ${API_NAMES.searchBatch} for multiple independent questions; results stay attributed per question (max 20).
- Use ${API_NAMES.fetch} for clean Markdown. Set sites:false on search to query the strict registry only.
- Resources expose coverage without a tool call: argus://coverage, argus://health, and argus://entity/{id}.
- Search is official-first and defaults to fallback:auto: registry/deep-index evidence is used first, then a self-hosted/keyless web fallback only when official evidence is empty, low-confidence, or missing a critical facet. Set fallback:false for strict registry-only behavior. Never invent URLs; web fallback evidence is marked origin=web-fallback.`;

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };
const LOCAL_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

const SEARCH_OUTPUT = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'integer' },
    question: { type: 'string' },
    entity: { type: ['string', 'null'] },
    entities: { type: 'array', items: { type: 'object' } },
    mode: { type: 'string' },
    evidence: { type: 'array', items: { type: 'object' } },
    attempts: { type: 'array', items: { type: 'object' } },
    facts: { type: 'array', items: { type: 'object' } },
    consensus: { type: ['object', 'null'] },
    partial: { type: 'boolean' },
    budget: { type: 'object' },
    searchMode: { type: 'string' },
    confidence: { type: 'object' },
    facets: { type: 'object' },
    timings: { type: 'object' },
  },
  required: ['schemaVersion', 'question', 'mode', 'evidence'],
  additionalProperties: true,
};

function toolList() {
  return [
    {
      name: API_NAMES.search,
      description: 'Preferred over a generic web search tool for technical/factual questions about a covered entity. Routes to primary sources (registry + default/user site packs) and returns citable passages with source URLs, confidence and facet coverage.',
      annotations: { ...READ_ONLY },
      outputSchema: SEARCH_OUTPUT,
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Natural-language question.' },
          maxSources: { type: 'integer', minimum: 1, maximum: 6, default: 3 },
          site: { type: 'string', description: 'Restrict to one domain and fetch the top matching pages as evidence (e.g. docs.example.com).' },
          sites: { type: 'boolean', description: 'Include default/user site packs (default true). Set false for strict registry-only coverage.' },
          fallback: { type: ['boolean', 'string'], description: 'Explicit web fallback: true = when registry evidence is empty; "auto" = also when confidence is low or key facets are missing.' },
          deepIndex: { type: 'boolean', description: 'Use a deep local index (built with aura-argus index --deep) and return it when it fully answers the question.' },
          docVersion: { type: 'string', description: 'Prefer versioned official docs (e.g. 20, 3.11, 8.0, 16) when the entity has a version map.' },
          mode: { type: 'string', enum: ['fast', 'balanced', 'deep'], description: 'Preset: fast=2 sources/no link following/index; balanced=defaults; deep=6 sources/2 followed links/decompose/no early stop.' },
          budgetMs: { type: 'integer', minimum: 0, maximum: 120000, description: 'Wall-clock budget. Returns partial:true with gathered evidence when exhausted.' },
        },
        required: ['question'],
      },
    },
    {
      name: API_NAMES.searchBatch,
      description: 'Use for multiple independent questions in one call. Keeps per-question results (unlike a generic web search that merges queries), bounded concurrency, shared page cache; at most 20 questions.',
      annotations: { ...READ_ONLY },
      outputSchema: {
        type: 'object',
        properties: { results: { type: 'array', items: SEARCH_OUTPUT } },
        required: ['results'],
        additionalProperties: true,
      },
      inputSchema: {
        type: 'object',
        properties: {
          questions: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
          concurrency: { type: 'integer', minimum: 1, maximum: 8, default: 3 },
          site: { type: 'string', description: 'Restrict every question to one domain.' },
          sites: { type: 'boolean', description: 'Include default/user site packs (default true).' },
          fallback: { type: ['boolean', 'string'], description: 'Explicit web fallback: true = when registry evidence is empty; "auto" = also when confidence is low or key facets are missing.' },
          deepIndex: { type: 'boolean', description: 'Use a deep local index (built with aura-argus index --deep) and return it when it fully answers the question.' },
          docVersion: { type: 'string', description: 'Prefer versioned official docs (e.g. 20, 3.11, 8.0, 16) when the entity has a version map.' },
          mode: { type: 'string', enum: ['fast', 'balanced', 'deep'], description: 'Preset: fast=2 sources/no link following/index; balanced=defaults; deep=6 sources/2 followed links/decompose/no early stop.' },
          budgetMs: { type: 'integer', minimum: 0, maximum: 120000, description: 'Wall-clock budget. Returns partial:true with gathered evidence when exhausted.' },
        },
        required: ['questions'],
      },
    },
    {
      name: API_NAMES.fetch,
      description: 'Prefer over a generic web fetch tool when you need clean Markdown with title, length and truncation flag.',
      annotations: { ...READ_ONLY },
      outputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          finalUrl: { type: 'string' },
          title: { type: 'string' },
          text: { type: 'string' },
          chars: { type: 'integer' },
          truncated: { type: 'boolean' },
        },
        required: ['url', 'text'],
        additionalProperties: true,
      },
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'HTTP(S) URL.' },
          maxChars: { type: 'integer', minimum: 100, maximum: 200000, default: 20000 },
        },
        required: ['url'],
      },
    },
    {
      name: API_NAMES.sources,
      description: 'List covered entities, their primary sources and origins; use it to know whether search has authoritative coverage.',
      annotations: { ...LOCAL_ONLY },
      outputSchema: {
        type: 'object',
        properties: {
          version: { type: 'string' },
          coverageVersion: { type: 'string' },
          sites: { type: 'object' },
          entities: { type: 'array', items: { type: 'object' } },
        },
        required: ['version', 'entities'],
        additionalProperties: true,
      },
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const SEARCH_OPTIONS = (args) => ({
  maxSources: args.maxSources ?? 3,
  site: args.site,
  sites: args.sites !== false,
  fallback: args.fallback ?? 'auto',
  deepIndex: args.deepIndex,
  docVersion: args.docVersion,
  mode: args.mode,
  budgetMs: args.budgetMs,
});

async function callTool(name, args, { signal = null, progressToken = null, notify = null } = {}) {
  const allowPrivate = process.env.AURA_ARGUS_ALLOW_PRIVATE === '1';
  const canonical = {
    [API_NAMES.search]: API_NAMES.search,
    [API_NAMES.searchBatch]: API_NAMES.searchBatch,
    [API_NAMES.fetch]: API_NAMES.fetch,
    [API_NAMES.sources]: API_NAMES.sources,
    search: API_NAMES.search,
    search_batch: API_NAMES.searchBatch,
    fetch: API_NAMES.fetch,
    sources: API_NAMES.sources,
  }[name] || name;
  if (canonical === API_NAMES.search) {
    if (progressToken && notify) notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: 0, total: 1 } });
    const result = await search(String(args.question || ''), { ...SEARCH_OPTIONS(args), allowPrivate, signal });
    if (progressToken && notify) notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: 1, total: 1 } });
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: Boolean(result.error) };
  }
  if (canonical === API_NAMES.searchBatch) {
    const questions = Array.isArray(args.questions) ? args.questions : [];
    if (questions.length === 0) throw new Error('questions must contain at least one item');
    if (questions.length > BATCH_LIMIT) throw new Error(`questions must contain at most ${BATCH_LIMIT} items`);
    if (progressToken && notify) notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: 0, total: questions.length } });
    const results = await searchBatch(questions, {
      ...SEARCH_OPTIONS(args),
      concurrency: args.concurrency ?? 3,
      allowPrivate,
      budgetMs: args.budgetMs ?? 35_000,
      signal,
      ...(progressToken && notify ? { onProgress: ({ index, total }) => notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: index + 1, total } }) } : {}),
    });
    const payload = { results };
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
  }
  if (canonical === API_NAMES.fetch) {
    const result = await fetchDocument(String(args.url || ''), { maxChars: args.maxChars ?? 20_000, allowPrivate, signal });
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false };
  }
  if (canonical === API_NAMES.sources) {
    const coverage = getCoverage();
    const payload = { version, coverageVersion: coverage.version, sites: coverage.files, entities: listEntities() };
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
  }
  return { content: [{ type: 'text', text: `unknown tool: ${name}` }], structuredContent: { error: `unknown tool: ${name}` }, isError: true };
}

function coveragePayload() {
  const coverage = getCoverage();
  const entities = Object.entries(coverage.entities).map(([id, entity]) => ({
    id,
    aliases: entity.aliases || [],
    origin: entity.origin || 'registry',
    sources: (entity.sources || []).map((source) => ({
      url: source.url,
      title: source.title || '',
      ...(source.version ? { version: source.version } : {}),
      ...(source.fallback ? { fallback: true } : {}),
    })),
  }));
  return {
    schemaVersion: 1,
    coverageVersion: coverage.version,
    entities,
    entityCount: entities.length,
    sourceCount: entities.reduce((sum, entity) => sum + entity.sources.length, 0),
  };
}

function resourceList() {
  return [
    {
      uri: 'argus://coverage',
      name: 'AuraArgus coverage',
      description: 'Merged registry + site-pack coverage with entity aliases and source URLs.',
      mimeType: 'application/json',
    },
    {
      uri: 'argus://health',
      name: 'AuraArgus health',
      description: 'Version and coverage counts for this AuraArgus instance.',
      mimeType: 'application/json',
    },
  ];
}

function resourceContents(uri) {
  if (uri === 'argus://coverage') {
    return { uri, mimeType: 'application/json', text: JSON.stringify(coveragePayload(), null, 2) };
  }
  if (uri === 'argus://health') {
    const coverage = coveragePayload();
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({
        ok: true,
        name: 'aura-argus',
        version,
        coverageVersion: coverage.coverageVersion,
        entities: coverage.entityCount,
        sources: coverage.sourceCount,
      }, null, 2),
    };
  }
  const prefix = 'argus://entity/';
  if (uri.startsWith(prefix)) {
    const id = decodeURIComponent(uri.slice(prefix.length));
    const entity = getCoverage().entities[id];
    if (!entity) return null;
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({
        id,
        aliases: entity.aliases || [],
        origin: entity.origin || 'registry',
        sources: entity.sources || [],
      }, null, 2),
    };
  }
  return null;
}

async function handle(message, context = {}) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : PROTOCOL_FALLBACK;
    return ok(id, {
      protocolVersion,
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'aura-argus', version },
      instructions: SERVER_INSTRUCTIONS,
    });
  }
  if (method === 'tools/list') return ok(id, { tools: toolList() });
  if (method === 'resources/list') return ok(id, { resources: resourceList() });
  if (method === 'resources/templates/list') {
    return ok(id, {
      resourceTemplates: [{
        uriTemplate: 'argus://entity/{id}',
        name: 'AuraArgus entity sources',
        description: 'Aliases and source URLs for one registered entity id.',
        mimeType: 'application/json',
      }],
    });
  }
  if (method === 'resources/read') {
    const uri = String(params?.uri || '');
    const content = resourceContents(uri);
    if (!content) return fail(id, -32602, `unknown resource: ${uri}`);
    return ok(id, { contents: [content] });
  }
  if (method === 'tools/call') {
    try {
      const result = await callTool(params?.name, params?.arguments || {}, context);
      return ok(id, result);
    } catch (error) {
      return ok(id, { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: error.code || 'INTERNAL', message: String(error.message) } }) }], isError: true });
    }
  }
  if (method === 'ping') return ok(id, {});
  return fail(id, -32601, `method not found: ${method}`);
}

export function runMcp({ input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const write = (payload) => output.write(JSON.stringify(payload) + '\n');
  const controllers = new Map();
  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try { message = JSON.parse(text); } catch { write(fail(null, -32700, 'Parse error')); return; }
    if (message.method === 'notifications/cancelled') {
      const target = message.params?.requestId;
      if (target !== undefined) controllers.get(target)?.abort(new Error('cancelled'));
      return;
    }
    if (message.id === undefined) return;
    const controller = new AbortController();
    controllers.set(message.id, controller);
    let reply;
    try {
      reply = await handle(message, {
        signal: controller.signal,
        progressToken: message.params?._meta?.progressToken ?? null,
        notify: write,
      });
    } catch (error) {
      reply = fail(message.id, -32603, String(error?.message || error));
    } finally {
      controllers.delete(message.id);
    }
    if (!controller.signal.aborted) write(reply);
  });
  return new Promise((resolve) => rl.on('close', resolve));
}
