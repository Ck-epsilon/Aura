# Generic shell agent

Any agent that can execute a command can use AuraArgus without MCP.

## Commands

```bash
aura-argus aura_argus_search "<question>" --json
aura-argus aura_argus_search "<question>" --json --max-sources 3
echo '["q1","q2"]' | aura-argus aura_argus_search_batch --json --concurrency 3
aura-argus aura_argus_fetch "<url>" --json --max-chars 20000
aura-argus aura_argus_sources --json
```

Before publishing, replace `aura-argus` with `node E:/workspaces/aura-argus/src/cli.mjs` (or
`npx -y aura-argus`).

## Parse

- `evidence[]` — one entry per source: `url`, `title`, `site`, `passages[{text,score}]`.
- `mode` — `registry` (official source), `web-fallback` (official-first fallback), `none` (not covered).
- `attempts[]` — per-source `ok`, `ms`, `tries`, `status`, `error`.
- `error.code` — set when all sources failed (`ALL_SOURCES_FAILED`) or the request was invalid.
- `tookMs`, `cached` — latency and cache status.

Exit codes: `0` evidence, `2` no evidence, `3` bad args/blocked URL, `4` network/retrieval
failure, `130` interrupted.

## Prompt snippet

```text
For technical/factual questions, prefer:
  aura-argus aura_argus_search "<question>" --json
Read evidence[].passages[].text and cite evidence[].url.
mode:"none" means the registry has no coverage; do not invent URLs.
Official sources are tried first; fallback:auto is the default. Use --no-fallback for strict registry-only behavior.
```

## Notes

- Output is JSON on stdout; diagnostics go to stderr.
- Private/loopback targets are blocked by default (`PRIVATE_ADDRESS`). Use `--allow-private` only
  for a trusted local source.
- Web fallback prefers self-hosted SearXNG, then keyless Bing/360/DuckDuckGo; disable it with `--no-fallback`.
