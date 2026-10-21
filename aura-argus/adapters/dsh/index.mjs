// DSH 适配器：把 AuraArgus 注册成 ctx.web 的 search / fetch provider。
// 不依赖 DSH 的源码：只用到 ctx.web.registerSearchProvider / registerFetchProvider。
import { search, fetchDocument, version } from '../../src/core.mjs';

export const name = 'aura-argus-dsh';
export const inject = ['web'];
export const SEARCH_ID = 'aura-argus';
export const FETCH_ID = 'aura-argus-http';

function providerError(message, code = 'WEB_PROVIDER_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 构建两个 provider。注入 searchImpl/fetchImpl 便于离线测试。
 */
export function createProviders({ searchImpl = search, fetchImpl = fetchDocument, config = {} } = {}) {
  const maxSources = Math.max(1, Math.min(6, Number(config.maxSources ?? 3)));
  const maxChars = Math.max(100, Number(config.maxChars ?? 20_000));
  const marker = config.marker === true;
  const allowPrivate = config.allowPrivate === true;

  const searchProvider = {
    id: SEARCH_ID,
    available() { return true; },
    async search(request, signal) {
      if (signal?.aborted) throw providerError('search aborted', 'WEB_ABORTED');
      const limit = Math.max(1, Math.min(maxSources, Number(request?.maxResults ?? maxSources)));
      try {
        const result = await searchImpl(request.query, { maxSources: limit, cache: config.cache !== false, fallback: config.fallback === true });
        if (result.error) throw providerError(`aura-argus search failed: ${result.error.code} (${result.error.attempts ?? 0} sources)`);
        const sources = (result.evidence || []).map((entry) => {
          const raw = entry.passages?.[0]?.text || '';
          const snippet = marker && raw ? `[aura-argus] ${raw}` : raw;
          return {
            url: entry.url,
            ...(entry.title ? { title: entry.title } : {}),
            ...(snippet ? { snippet: snippet.slice(0, 600) } : {}),
          };
        });
        return { sources, truncated: false };
      } catch (error) {
        throw providerError(`aura-argus search failed: ${error?.message || error}`);
      }
    },
  };

  const fetchProvider = {
    id: FETCH_ID,
    available() { return true; },
    async fetch(request, signal) {
      if (signal?.aborted) throw providerError('fetch aborted', 'WEB_ABORTED');
      try {
        const doc = await fetchImpl(request.url, { maxChars, allowPrivate });
        return {
          url: doc.finalUrl || doc.url,
          statusCode: doc.status,
          body: { kind: 'text', content: doc.text },
          truncated: Boolean(doc.truncated),
        };
      } catch (error) {
        // 与 DSH 的约定一致：非 2xx 是结果，不是异常。
        if (error?.code === 'HTTP_ERROR' && error?.details?.status) {
          return { url: request.url, statusCode: error.details.status, body: { kind: 'text', content: '' }, truncated: false };
        }
        throw providerError(`aura-argus fetch failed: ${error?.message || error}`);
      }
    },
  };

  return { searchProvider, fetchProvider };
}

export function apply(ctx, config = {}) {
  const { searchProvider, fetchProvider } = createProviders({ config });
  ctx.web.registerSearchProvider(searchProvider);
  ctx.web.registerFetchProvider(fetchProvider);
  if (config.debug) {
    process.stderr.write(`[aura-argus] registered ${SEARCH_ID} + ${FETCH_ID} (v${version})\n`);
  }
}
