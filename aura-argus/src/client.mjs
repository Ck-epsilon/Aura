// 零依赖 JS 客户端：Node 20+ / 浏览器均可，只依赖标准 fetch。
export class ArgusClientError extends Error {
  constructor(message, { code = 'CLIENT_ERROR', status = 0, payload = null } = {}) {
    super(message);
    this.name = 'ArgusClientError';
    this.code = code;
    this.status = status;
    this.payload = payload;
  }
}

/**
 * @param {{baseUrl?: string, token?: string, fetch?: Function, timeoutMs?: number, headers?: object}} [options]
 */
export function createClient({
  baseUrl = 'http://127.0.0.1:8787',
  token = null,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
  headers = {},
} = {}) {
  if (typeof fetchImpl !== 'function') throw new ArgusClientError('fetch is not available; pass a fetch implementation');
  const base = String(baseUrl).replace(/\/+$/, '');

  async function request(path, { method = 'GET', body, signal = null, query = null } = {}) {
    const url = new URL(`${base}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => { timedOut = true; controller.abort(new Error('request timeout')); }, timeoutMs)
      : null;
    const onAbort = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      if (!response.ok) {
        const error = data?.error || {};
        throw new ArgusClientError(error.message || `HTTP ${response.status}`, {
          code: error.code || 'HTTP_ERROR',
          status: response.status,
          payload: data,
        });
      }
      return data;
    } catch (error) {
      if (error instanceof ArgusClientError) throw error;
      if (timedOut) throw new ArgusClientError('request timeout', { code: 'TIMEOUT' });
      if (signal?.aborted) throw new ArgusClientError('request aborted', { code: 'ABORTED' });
      if (error?.name === 'AbortError') throw new ArgusClientError('request aborted', { code: 'ABORTED' });
      throw new ArgusClientError(String(error?.message || error), { code: error?.code || 'NETWORK_ERROR' });
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  const client = {
    baseUrl: base,
    health: () => request('/health'),
    sources: () => request('/sources'),
    search: (question, options = {}) => {
      const { signal, ...body } = options;
      return request('/search', { method: 'POST', body: { question, ...body }, signal });
    },
    searchBatch: (questions, options = {}) => {
      const { signal, ...body } = options;
      return request('/search/batch', { method: 'POST', body: { questions, ...body }, signal });
    },
    fetch: (target, options = {}) => {
      const { signal, ...body } = options;
      return request('/fetch', { method: 'POST', body: { url: target, ...body }, signal });
    },
  };
  return {
    ...client,
    aura_argus_health: client.health,
    aura_argus_sources: client.sources,
    aura_argus_search: client.search,
    aura_argus_search_batch: client.searchBatch,
    aura_argus_fetch: client.fetch,
  };
}

export default createClient;
