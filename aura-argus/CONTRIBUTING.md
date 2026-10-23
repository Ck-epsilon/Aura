# Contributing

## Requirements

- Node.js **20+** (CI runs 20, 22, 24).
- No runtime dependencies; keep it that way unless there is a strong reason.
- Windows, macOS, and Linux are supported.

## Local development

```bash
npm test            # offline: 51 tests
npm run eval        # live: 31 questions / 141 hard checks (network)
npm run verify      # live: 34 sources reachable
npm run bench       # optional: sequential vs batch benchmark
```

`npm run eval` and `npm run verify` hit the public internet; they are release/nightly checks, not
per-PR checks. `npm test` must stay deterministic and offline.

## Adding a source

1. Add the entity (or source) to `src/registry.json`:

```json
"entity-id": {
  "aliases": ["name", "别名"],
  "sources": [{ "url": "https://official/page", "title": "…", "covers": ["keyword"] }]
}
```

2. Use a deep official page, not a landing page. Landing pages produce nav/TOC passages.
3. Run `node eval/verify-registry.mjs` to confirm the source is reachable.
4. Add a question to `eval/questions.json` with at least one factual regex check.
5. Run `npm test` and `npm run eval`; update `RESULTS.md` if numbers move.

## Pull request checklist

- [ ] `npm test` passes (94/94).
- [ ] New behavior has a happy path and a negative/boundary test.
- [ ] No secrets, tokens, or personal paths in code, tests, or fixtures.
- [ ] No new runtime dependency without a written reason.
- [ ] Public behavior/API changes update `README.md` and `CHANGELOG.md`.
- [ ] Network-facing changes consider SSRF, redirects, timeouts, and ToS.

## Code style

- ESM only, `node:` built-ins first.
- Small modules with explicit contracts; no framework.
- Errors use `ArgusError` + `CODES`; never swallow failures silently.
- Keep `src/lib/mcp.mjs` stdout protocol-only (no logs).
