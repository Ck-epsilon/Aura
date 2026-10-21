// 本地 HTTP 服务：任何语言/agent 都能调用。默认只绑 127.0.0.1。
import http from 'node:http';
import { search, searchBatch, fetchDocument, listEntities, version } from '../core.mjs';
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

export function createRequestHandler({ token = null, allowPrivate = false } = {}) {
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
    if (url.pathname === '/health') {
      send(res, 200, { ok: true, name: 'aura-argus', version, sources: listEntities().length, uptimeMs: Math.round(process.uptime() * 1000) });
      return;
    }

    if (!authorized(req, token)) {
      send(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'missing or invalid bearer token' } });
      return;
    }

    try {
      if (url.pathname === '/' || url.pathname === '/help') {
        send(res, 200, {
          name: 'aura-argus',
          version,
          endpoints: {
            'GET /health': 'health + version',
            'GET /sources': 'registered entities',
            'GET /search?q=&maxSources=': 'evidence bundle',
            'POST /search': '{ "question": "...", "maxSources": 3 }',
            'POST /search/batch': '{ "questions": ["..."], "concurrency": 3 }',
            'GET /fetch?url=&maxChars=': 'clean page text',
            'POST /fetch': '{ "url": "...", "maxChars": 20000 }',
          },
        });
        return;
      }

      if (url.pathname === '/sources') {
        send(res, 200, { ok: true, version, entities: listEntities() });
        return;
      }

      if (url.pathname === '/search/batch') {
        if (req.method !== 'POST') { send(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'use POST /search/batch' } }); return; }
        const body = await readBody(req);
        if (!Array.isArray(body.questions) || body.questions.length === 0) throw new ArgusError(CODES.BAD_REQUEST, 'questions[] is required');
        if (body.questions.length > 50) throw new ArgusError(CODES.BAD_REQUEST, 'at most 50 questions per batch');
        const results = await searchBatch(body.questions, {
          concurrency: Number(body.concurrency ?? 3),
          maxSources: Number(body.maxSources ?? 3),
          cache: body.cache !== false,
          fallback: body.fallback === true,
          budgetMs: Number(body.budgetMs ?? 45_000),
        });
        send(res, 200, { ok: true, results });
        return;
      }

      if (url.pathname === '/search') {
        const body = req.method === 'POST' ? await readBody(req) : {};
        const question = String(body.question ?? url.searchParams.get('q') ?? '').trim();
        if (!question) throw new ArgusError(CODES.BAD_REQUEST, 'question (or q) is required');
        const maxSources = Number(body.maxSources ?? url.searchParams.get('maxSources') ?? 3);
        const fallbackParam = url.searchParams.get('fallback');
        const fallback = body.fallback === true || fallbackParam === '1' || fallbackParam === 'true';
        const result = await search(question, { maxSources, cache: body.cache !== false, fallback });
        send(res, result.error ? 502 : 200, { ok: !result.error, ...result });
        return;
      }

      if (url.pathname === '/fetch') {
        const body = req.method === 'POST' ? await readBody(req) : {};
        const target = String(body.url ?? url.searchParams.get('url') ?? '').trim();
        if (!target) throw new ArgusError(CODES.BAD_REQUEST, 'url is required');
        const maxChars = Number(body.maxChars ?? url.searchParams.get('maxChars') ?? 20_000);
        const result = await fetchDocument(target, { maxChars, allowPrivate });
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

export function startServer({ port = 8787, host = '127.0.0.1', token = null, allowPrivate = false } = {}) {
    const server = http.createServer(createRequestHandler({ token, allowPrivate }));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actual = typeof address === 'object' && address ? address.port : port;
      resolve({ server, host, port: actual, url: `http://${host}:${actual}` });
    });
  });
}
