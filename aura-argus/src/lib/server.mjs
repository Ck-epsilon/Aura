// 本地 HTTP 服务：任何语言/agent 都能调用。默认只绑 127.0.0.1。
import http from 'node:http';
import { aura_argus_search, aura_argus_search_batch, aura_argus_fetch_document, version } from '../core.mjs';
import { getCoverage, listEntities } from './registry.mjs';
import { toErrorPayload, ArgusError, CODES } from './errors.mjs';

const MAX_BODY = 1_000_000;

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ArgusError(CODES.BAD_REQUEST, 'request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ArgusError(CODES.BAD_REQUEST, 'invalid JSON body'); }
}

function authorized(req, token) {
  if (!token) return true;
  const header = req.headers.authorization || '';
  return header === `Bearer ${token}`;
}

export function createRequestHandler({ token = null, allowPrivate = false, sites = true, sitesFile } = {}) {
  const baseOptions = { allowPrivate, sites, ...(sitesFile ? { sitesFile } : {}) };
  return async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type, authorization',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }

    const url = new URL(req.url || '/', 'http://localhost');
    // Canonical surface only: /aura_argus/*. Old bare routes are gone.
    const prefix = '/aura_argus';
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
      const legacy = new Set(['/health', '/sources', '/search', '/search/batch', '/fetch']);
      if (legacy.has(url.pathname)) {
        send(res, 410, { ok: false, error: { code: 'ROUTE_REMOVED', message: `use ${prefix}${url.pathname}` } });
      } else {
        send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `no route for ${url.pathname}` } });
      }
      return;
    }
    const route = url.pathname.slice(prefix.length) || '/';
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(new Error('client disconnected')); });
    if (route === '/health') {
      const coverage = getCoverage(baseOptions);
      const sources = Object.values(coverage.entities).reduce((sum, entity) => sum + entity.sources.length, 0);
      send(res, 200, {
        ok: true,
        name: 'aura-argus',
        version,
        coverageVersion: coverage.version,
        entities: Object.keys(coverage.entities).length,
        sources,
        uptimeMs: Math.round(process.uptime() * 1000),
      });
      return;
    }

    if (!authorized(req, token)) {
      send(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'missing or invalid bearer token' } });
      return;
    }

    try {
      if (route === '/' || route === '/help') {
        send(res, 200, {
          name: 'aura-argus',
          version,
          endpoints: {
            'GET /aura_argus/health': 'health + version',
            'GET /aura_argus/sources': 'registered entities',
            'GET /aura_argus/search?q=&maxSources=': 'evidence bundle (add sites=0 for registry-only)',
            'POST /aura_argus/search': '{ "question": "...", "maxSources": 3, "site": "docs.example.com", "sites": true }',
            'POST /aura_argus/search/batch': '{ "questions": ["..."], "concurrency": 3, "site": "docs.example.com", "sites": true }',
            'GET /aura_argus/fetch?url=&maxChars=': 'clean page text',
            'POST /aura_argus/fetch': '{ "url": "...", "maxChars": 20000 }',
          },
        });
        return;
      }

      if (route === '/sources') {
        const coverage = getCoverage(baseOptions);
        send(res, 200, { ok: true, version, coverageVersion: coverage.version, sites: coverage.files, entities: listEntities(baseOptions) });
        return;
      }

      if (route === '/search/batch') {
        if (req.method !== 'POST') { send(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'use POST /aura_argus/search/batch' } }); return; }
        const body = await readBody(req);
        if (!Array.isArray(body.questions) || body.questions.length === 0) throw new ArgusError(CODES.BAD_REQUEST, 'questions[] is required');
        if (body.questions.length > 50) throw new ArgusError(CODES.BAD_REQUEST, 'at most 50 questions per batch');
        const results = await aura_argus_search_batch(body.questions, {
          concurrency: Number(body.concurrency ?? 3),
          maxSources: Number(body.maxSources ?? 3),
          cache: body.cache !== false,
          fallback: body.fallback === false ? false : body.fallback === true ? true : 'auto',
          site: typeof body.site === 'string' ? body.site : undefined,
          deepIndex: body.deepIndex,
          docVersion: body.docVersion,
          mode: body.mode,
          signal: abort.signal,
          budgetMs: Number(body.budgetMs ?? 45_000),
          ...baseOptions,
          ...(body.sites === false ? { sites: false } : {}),
        });
        send(res, 200, { ok: true, results });
        return;
      }

      if (route === '/search') {
        const body = req.method === 'POST' ? await readBody(req) : {};
        const question = String(body.question ?? url.searchParams.get('q') ?? '').trim();
        if (!question) throw new ArgusError(CODES.BAD_REQUEST, 'question (or q) is required');
        const maxSources = Number(body.maxSources ?? url.searchParams.get('maxSources') ?? 3);
        const fallbackParam = url.searchParams.get('fallback');
        const fallbackOff = body.fallback === false || ['0', 'false', 'off'].includes(String(fallbackParam || '').toLowerCase());
        const fallback = fallbackOff
          ? false
          : body.fallback === 'auto' || fallbackParam === 'auto'
            ? 'auto'
            : body.fallback === true || fallbackParam === '1' || fallbackParam === 'true'
              ? true
              : 'auto';
        const site = typeof body.site === 'string' ? body.site : (url.searchParams.get('site') ?? undefined);
        const sitesOff = body.sites === false || url.searchParams.get('sites') === '0';
        const deepIndex = body.deepIndex === true || url.searchParams.get('deepIndex') === '1';
        const docVersion = body.docVersion ?? url.searchParams.get('docVersion') ?? undefined;
        const mode = body.mode ?? url.searchParams.get('mode') ?? undefined;
        const budgetMs = body.budgetMs ?? url.searchParams.get('budgetMs') ?? undefined;
        const result = await aura_argus_search(question, {
          maxSources,
          cache: body.cache !== false,
          fallback,
          site,
          deepIndex,
          docVersion,
          mode,
          budgetMs: budgetMs === undefined ? undefined : Number(budgetMs),
          signal: abort.signal,
          ...baseOptions,
          ...(sitesOff ? { sites: false } : {}),
        });
        send(res, result.error ? 502 : 200, { ok: !result.error, ...result });
        return;
      }

      if (route === '/fetch') {
        const body = req.method === 'POST' ? await readBody(req) : {};
        const target = String(body.url ?? url.searchParams.get('url') ?? '').trim();
        if (!target) throw new ArgusError(CODES.BAD_REQUEST, 'url is required');
        const maxChars = Number(body.maxChars ?? url.searchParams.get('maxChars') ?? 20_000);
        const result = await aura_argus_fetch_document(target, { maxChars, allowPrivate, signal: abort.signal });
        send(res, 200, { ok: true, ...result });
        return;
      }

      send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `no route for ${url.pathname}` } });
    } catch (error) {
      const payload = toErrorPayload(error);
      const status = error instanceof ArgusError && (error.code === CODES.BAD_REQUEST || error.code === CODES.BAD_URL) ? 400 : 502;
      send(res, status, payload);
    }
  };
}

export function startServer({ port = 8787, host = '127.0.0.1', token = null, allowPrivate = false, sites = true, sitesFile } = {}) {
    const server = http.createServer(createRequestHandler({ token, allowPrivate, sites, sitesFile }));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actual = typeof address === 'object' && address ? address.port : port;
      resolve({ server, host, port: actual, url: `http://${host}:${actual}` });
    });
  });
}
