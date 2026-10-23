# JS client (Node 20+ / browser)

The client is a thin wrapper over the HTTP API. It has no runtime dependencies and uses
standard `fetch`.

```js
import { createClient, ArgusClientError } from 'aura-argus/client';

const argus = createClient({
  baseUrl: 'http://127.0.0.1:8787',
  token: process.env.AURA_ARGUS_TOKEN, // omit when the server has no token
  timeoutMs: 30_000,
});

const result = await argus.aura_argus_search('Node.js 20 的 fs.readFile 怎么用？', {
  mode: 'balanced',
  budgetMs: 5000,
});
console.log(result.evidence[0].passages[0].citation);

const batch = await argus.aura_argus_search_batch(['Redis 默认端口', 'PostgreSQL 默认端口'], {
  concurrency: 2,
});
const doc = await argus.aura_argus_fetch('https://nodejs.org/api/fs.html', { maxChars: 8000 });
const coverage = await argus.aura_argus_sources();
```

Methods:

| Method | HTTP | Notes |
|---|---|---|
| `aura_argus_health()` | `GET /aura_argus/health` | no auth required |
| `aura_argus_sources()` | `GET /aura_argus/sources` | coverage |
| `aura_argus_search(question, options)` | `POST /aura_argus/search` | all search options, including `mode` / `budgetMs` |
| `aura_argus_search_batch(questions, options)` | `POST /aura_argus/search/batch` | per-question results |
| `aura_argus_fetch(url, options)` | `POST /aura_argus/fetch` | clean Markdown |

The unprefixed methods (`health`, `sources`, `search`, `searchBatch`, `fetch`) remain aliases.
Legacy HTTP routes without the `/aura_argus` prefix are also still accepted.

Pass `{ signal }` in any options object to cancel. Errors are `ArgusClientError` with
`code`, `status`, and the raw `payload`; codes mirror the server (`UNAUTHORIZED`,
`BAD_REQUEST`, `ABORTED`, …).

The module is exported as `aura-argus/client`; the browser can import
`node_modules/aura-argus/src/client.mjs` directly or bundle it.
