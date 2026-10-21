# Generic HTTP agent

Run the local server:

```bash
aura-argus serve --port 8787            # binds 127.0.0.1
aura-argus serve --port 8787 --token secret
```

The OpenAPI 3.1 document is [`openapi.json`](../../openapi.json).

## Endpoints

```bash
curl "http://127.0.0.1:8787/health"
curl "http://127.0.0.1:8787/sources"
curl "http://127.0.0.1:8787/search?q=Node.js%20http%20server&maxSources=3"
curl -X POST "http://127.0.0.1:8787/search" \
  -H "content-type: application/json" \
  -d '{"question":"SearXNG 429 冷却时间","maxSources":3}'
curl -X POST "http://127.0.0.1:8787/search/batch" \
  -H "content-type: application/json" \
  -d '{"questions":["q1","q2"],"concurrency":3}'
curl -X POST "http://127.0.0.1:8787/fetch" \
  -H "content-type: application/json" \
  -d '{"url":"https://docs.searxng.org/dev/search_api.html","maxChars":4000}'
```

With a token, add `-H "authorization: Bearer secret"`.

## Behavior

- `/search` returns 200 with the evidence bundle, or 502 when every registered source failed.
- `/search/batch` returns 200 with per-question results (up to 50); the default budget is 45 s.
- `/fetch` returns clean Markdown; private/loopback targets are blocked unless the server was
  started with `--allow-private`.
- `fallback: true` opts into 360/Sogou; it is off by default.
- Do not expose the server publicly without a token and network isolation.
