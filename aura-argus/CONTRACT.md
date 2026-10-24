# AuraArgus result contract — schemaVersion 1

Status: **stable from 1.0.0**. New optional fields may be added in minor releases. Removing or
changing the meaning of a required field bumps `schemaVersion`.

## Search result

| Field | Type | Guarantee |
|---|---|---|
| `schemaVersion` | integer | `1` for this contract |
| `question` | string | trimmed input |
| `entity` | string \| null | primary entity id |
| `entities` | array | `{id, origin, version, confidence, facets}` per entity |
| `mode` | string | `registry`, `web-fallback`, `none`, or `error` |
| `evidence` | array | see Evidence |
| `facts` | array | typed facts extracted from cited passages; see Facts |
| `consensus` | object | cross-source agreement/conflict summary; see Consensus |
| `attempts` | array | per-source fetch outcome, including failures |
| `confidence` | object | `{score: 0–1, label: high\|medium\|low\|none}` |
| `facets` | object | `{terms, covered, missing, ratio}` |
| `timings` | object | `{routeMs, fetchMs, extractMs, selectMs, followMs, recursiveMs, indexMs, fallbackMs, totalMs}` |
| `version` | string \| null | resolved document version |
| `versionRequested` | string | explicit `docVersion`, when supplied |
| `next` | object | `{missingFacets?, hint}` when more retrieval is useful |
| `partial` | boolean | true when a wall-clock budget stopped retrieval early |
| `budget` | object | `{limitMs, usedMs, exhausted}` when `budgetMs` was supplied |
| `searchMode` | string | `fast`, `balanced`, or `deep` when a mode preset was used |
| `fallback` | object | `{provider, snippets, officialSources, webSources, augmented}` when web fallback contributed evidence |
| `error` | object | `{code, message, ...}` on failure |
| `note` | string | optional provenance marker, e.g. `fast-index` |
| `tookMs` | integer | wall time |
| `cached` | boolean | result-cache hit |
| `cache` | string | `none`, `result`, or `index` |
| `index` | object | fast-index metadata `{entities, stale, builtAt}` |

### Evidence

| Field | Type | Guarantee |
|---|---|---|
| `id` | string | stable 12-char source id derived from the final URL |
| `url` | string | final URL |
| `title` | string | page title or source title |
| `site` | string | hostname |
| `origin` | string | `registry`, `default`, `user`, `index`, `web-fallback`, or merged origin |
| `entity` | string | entity id when known |
| `version` | string | versioned-doc marker |
| `updated` | string \| null | `Last-Modified` or index build time |
| `via` | string | `link`, `discovery`, `recursive`, or `index` when applicable |
| `snippet` | boolean | true when only a search-result snippet was available |
| `depth` | integer | `0` primary, `1` followed link |
| `passages` | array | see Passage; ordered by relevance within the source |

### Passage

| Field | Type | Guarantee |
|---|---|---|
| `id` | string | stable 12-char id derived from source URL + heading path + text |
| `text` | string | selected excerpt |
| `score` | number | relevance score within the page |
| `kind` | string | `prose`, `code`, `list`, `table`, or `heading` |
| `heading` | string | nearest Markdown heading |
| `headingPath` | string | heading stack joined with ` > ` |
| `anchor` | string | heading slug for a URL fragment; empty when no heading |
| `anchorType` | string \| null | `heading-slug` when an anchor is present |
| `sourceId` | string | parent evidence `id` |
| `url` | string | final source URL |
| `citation` | string | `url#anchor` when an anchor exists, otherwise `url` |
| `lineStart` / `lineEnd` | integer \| null | offsets in the extracted Markdown (not original HTML) |

Anchors are derived from heading text. Sites with custom heading ids may not resolve the slug
exactly; `citation` is still a stable citable pointer and `heading` is authoritative.

### Facts

| Field | Type | Guarantee |
|---|---|---|
| `id` | string | stable 12-char id |
| `type` | string | `price`, `percent`, `version`, `date`, `limit`, or `status` |
| `value` | number \| string | numeric for price/percent/limit/status, string for version/date |
| `unit` | string | optional unit (`credit`, `requests`, `%`, …) |
| `currency` | string \| null | ISO code for price facts |
| `text` | string | matched context excerpt |
| `confidence` | number | extraction confidence (not a probability guarantee) |
| `passageId` / `sourceId` | string \| null | links back to the cited passage and source |
| `url` / `citation` | string \| null | source URL and anchor citation |

Facts are deterministic regex extractions, filtered by query intent: pricing returns
price/percent/limit, version returns version/date/limit, error returns status/limit/percent.
`facts` is empty when nothing matches; it is not a synthesized answer.

### Consensus

| Field | Type | Guarantee |
|---|---|---|
| `sourceCount` | integer | distinct evidence URLs considered |
| `comparable` | integer | groups with at least two sources |
| `agreementRatio` | number | agreements / comparable |
| `agreements` | array | `{type, value, unit?, currency?, sources[]}` |
| `conflicts` | array | `{type, unit?, currency?, values:[{value, sources[]}]}` |

Only `price`, `percent`, `limit`, and `status` facts with the same unit/currency are compared.
When one source lists several values for a group (for example a price table), the group is not
declared a conflict; values repeated by at least two sources are reported as agreements.
`consensus` is omitted for a single source or when no comparable group exists.

### Attempts

| Field | Type | Guarantee |
|---|---|---|
| `url` | string | requested source URL |
| `ok` | boolean | fetch + selection succeeded |
| `ms` | integer | elapsed |
| `passages` | integer | selected passage count |
| `tries` | integer | fetch attempts |
| `cache` | string | `memory`, `page`, `page-revalidated`, `miss`, or `bypass` |
| `error` | string | error code when `ok` is false |
| `status` | integer | HTTP status when available |
| `fallback` | boolean | source is a fallback source |
| `via` | string | `link` or `discovery` |

## Modes

- `registry`: an entity matched and official sources were used.
- `web-fallback`: explicit fallback/site scope produced evidence.
- `none`: no coverage or no evidence; this is not an error.
- `error`: the request failed; `error.code` is set.

## Cache semantics

- `cache: "result"` — exact search result cache hit (15 min default).
- `cache: "index"` — local section index hit; no network fetch for that query.
- `cached: true` is kept for backward compatibility with result cache hits.
- Page cache is keyed by URL and private/public scope; `ETag` / `Last-Modified` are revalidated.

## Error codes

`BAD_REQUEST`, `BAD_URL`, `TIMEOUT`, `FETCH_FAILED`, `HTTP_ERROR`, `UNSUPPORTED_CONTENT_TYPE`,
`TOO_LARGE`, `NO_ENTITY`, `NO_EVIDENCE`, `ALL_SOURCES_FAILED`, `PRIVATE_ADDRESS`,
`TOO_MANY_REDIRECTS`, `BATCH_BUDGET_EXCEEDED`, `ABORTED`.

## Options

`maxSources` (1–6), `site`, `sites`, `cache`, `multi`, `followLinks`,
`maxFollowLinks` (0–2), `fast`, `deepIndex`, `recursive`, `maxRecursivePages`, `maxRecursiveDepth`,
`docVersion`, `decompose`, `mode` (`fast`/`balanced`/`deep`), `fallback` (`true`/`auto`),
`budgetMs`, `signal` (AbortSignal), `timeoutMs`, `allowPrivate`, `sitesFile`.

`mode` sets defaults only; explicitly supplied options win. `fast` = 2 sources, no link
following, local index; `balanced` = 3 sources, 1 followed link; `deep` = 6 sources, 2 followed
links, decomposition for compound questions, early stop disabled.

`budgetMs` is a wall-clock budget for the whole search. When exhausted, retrieval stops starting
new fetches and the result carries the evidence gathered so far with `partial: true`; partial
results are not written to the result cache.

`deepIndex` reads a local index built by `aura-argus index --deep`. It returns index evidence
early only when the indexed evidence fully covers the query facets and confidence is high;
otherwise retrieval continues live. `recursive` enables bounded same-origin sitemap/link
expansion for how-to/list/compare questions; `maxRecursivePages` and `maxRecursiveDepth` cap it.

`fallback: true` uses the self-hosted/keyless web fallback when registry evidence is empty.
`fallback: "auto"` also uses it when confidence is below 0.6 or a critical facet is missing.
CLI/MCP/HTTP default to `auto`; the library default is off, so callers must pass it explicitly.
Web fallback prefers `AURA_ARGUS_SEARXNG_URL` (self-hosted) and then keyless Bing/360/DuckDuckGo
adapters; it fetches up to 4 result pages, keeps official evidence first, and marks web evidence
`origin: "web-fallback"`. `--no-fallback` / `fallback:false` disables it.

## MCP

Tools: `aura_argus_search`, `aura_argus_search_batch`, `aura_argus_fetch`, `aura_argus_sources`.
Canonical names only. Legacy aliases (`search`, `search_batch`, `fetch`, `sources`, bare `/search`, bare `/fetch`, bare `/sources`) were removed in 3.0.0; old HTTP routes return `410 ROUTE_REMOVED`.
Results include `structuredContent` alongside text JSON; tools carry read-only annotations and
`outputSchema`. `aura_argus_search_batch` emits `notifications/progress` when
`_meta.progressToken` is supplied. `notifications/cancelled` aborts the matching in-flight call;
cancelled calls send no response.

Resources: `argus://coverage` (merged entities and sources), `argus://health` (version and
counts), and the template `argus://entity/{id}`. `resources/list`,
`resources/templates/list`, and `resources/read` are supported.

JS client: `import { createClient } from 'aura-argus/client'` provides `health`, `sources`,
`search`, `searchBatch`, and `fetch` over the HTTP API, with bearer-token support, timeouts,
and `AbortSignal` cancellation.

## Non-goals

- AuraArgus returns evidence, not a synthesized answer.
- `evidence` is relevant, not exhaustive.
- Coverage is the registry + site packs; unregistered entities return `mode: "none"` unless a
  site scope or explicit fallback is used.

