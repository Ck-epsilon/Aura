# Generic shell agent

Any agent that can execute a command can use AuraArgus without MCP.

## Commands

```bash
aura-argus search "<question>" --json
aura-argus search "<question>" --json --max-sources 3
echo '["q1","q2"]' | aura-argus search --batch --json --concurrency 3
aura-argus fetch "<url>" --json --max-chars 20000
aura-argus sources --json
```

Before publishing, replace `aura-argus` with `node E:/workspaces/aura-argus/src/cli.mjs` (or
`npx -y aura-argus`).

## Parse

- `evidence[]` — one entry per source: `url`, `title`, `site`, `passages[{text,score}]`.
- `mode` — `registry` (official source), `web-fallback` (opt-in), `none` (not covered).
- `attempts[]` — per-source `ok`, `ms`, `tries`, `status`, `error`.
- `error.code` — set when all sources failed (`ALL_SOURCES_FAILED`) or the request was invalid.
- `tookMs`, `cached` — latency and cache status.

Exit codes: `0` evidence, `2` no evidence, `3` bad args/blocked URL, `4` network/retrieval
failure, `130` interrupted.

## Prompt snippet

```text
For technical/factual questions, prefer:
  aura-argus search "<question>" --json
Read evidence[].passages[].text and cite evidence[].url.
mode:"none" means the registry has no coverage; do not invent URLs.
Registry-only by default; do not pass --fallback unless the user accepts weaker web results.
```

## Notes

- Output is JSON on stdout; diagnostics go to stderr.
- Private/loopback targets are blocked by default (`PRIVATE_ADDRESS`). Use `--allow-private` only
  for a trusted local source.
- The 360/Sogou fallback is opt-in (`--fallback`), weaker, and anti-bot sensitive.
