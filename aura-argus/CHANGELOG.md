# Changelog

## 0.1.1 — 2026-10-21

### Changed

- Repository metadata now points at the Aura monorepo (`Ck-epsilon/Aura`, directory `aura-argus`).
- ZCode integration docs corrected: first-party MCP via `~/.zcode/cli/config.json` `mcp.servers`.
- No runtime behavior changes.

## 0.1.0 — 2026-10-21

Initial public beta.

### Added

- Keyless source router: 18 entities / 34 official sources, with aliases and CN→EN term expansion.
- Evidence contract: per-source passages, scores, URLs, `mode`, attempts, `tookMs`, `cached`.
- CLI: `search`, `fetch`, `sources`, `doctor`, `serve`, `mcp`; JSON output and typed exit codes.
- HTTP server: `/health`, `/sources`, `/search`, `/search/batch`, `/fetch`.
- MCP stdio server: `search`, `search_batch`, `fetch`, `sources`; protocol negotiation and
  client-agnostic `instructions`.
- Node library exports: `search`, `searchBatch`, `fetchDocument`, `listEntities`, `matchEntity`,
  `registryVersion`, `ArgusError`, `CODES`, `toErrorPayload`, `version`.
- DSH provider adapter (`adapters/dsh`) and an optional MCP server entry.
- Batch search with bounded concurrency (1–8), page cache, in-flight de-duplication, and a batch
  budget (MCP 35 s, HTTP 45 s).
- Retry policy: up to 3 attempts per source for network errors, timeouts, 408/425/429/5xx;
  exponential backoff with jitter; `Retry-After` support; total budget.
- `ALL_SOURCES_FAILED` error with per-source attempts (CLI exit 4, HTTP 502, MCP `isError`, DSH
  provider error).
- SSRF protection: private/loopback/link-local/metadata targets denied by default; DNS and
  redirect re-checks; `--allow-private` opt-in.
- `schema/tools.json` for function-calling agents and `openapi.json` for HTTP integrations.

### Changed

- The 360/Sogou web fallback is now **opt-in** (`--fallback` / `fallback: true`). Registry-only is
  the default; unregistered questions return `mode: "none"`.
- MCP instructions and tool descriptions are client-agnostic (no DSH-specific tool names).

### Known limitations

- Coverage is the registry. Unregistered entities return no evidence unless fallback is enabled.
- No JavaScript rendering, login walls, CAPTCHA solving, or proxy pools.
- Single-entity routing; multi-entity questions are not composed.
- DNS rebinding and proxy environments are documented limitations (see `SECURITY.md`).
