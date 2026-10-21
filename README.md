# Aura

[![aura-argus on npm](https://img.shields.io/npm/v/aura-argus?label=aura-argus&color=2f81f7)](https://www.npmjs.com/package/aura-argus)
[![aura-cardea on npm](https://img.shields.io/npm/v/aura-cardea?label=aura-cardea&color=2f81f7)](https://www.npmjs.com/package/aura-cardea)
[![license: MIT](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)
[![node: >=20](https://img.shields.io/badge/node-%E2%89%A520-339933)](https://nodejs.org/)

[中文](README.zh.md)

Aura is a monorepo for independently installable tools. It is a distribution and maintenance boundary, not a shared runtime: each package has its own manifest, version, tests, and release cadence.

The shared constraints are deliberate:

- **Local-first.** No mandatory cloud account; data stays on the machine unless a tool explicitly retrieves a source.
- **Keyless where possible.** AuraArgus and AuraCardea require no API key.
- **Agent-callable.** CLI, HTTP, MCP, and library surfaces are provided where they make sense.
- **MIT.** The code is readable, modifiable, and self-hostable.

---

## Projects

### AuraArgus — source-routed retrieval

AuraArgus routes a technical question to a registered official source, retrieves the page, extracts relevant passages, and returns an evidence bundle with URLs and scores. It also converts a URL into clean Markdown.

- 18 entities / 34 official sources currently registered.
- No API key, no per-call billing, zero runtime dependencies.
- Node.js ≥ 20; Windows, macOS, and Linux.
- CLI, HTTP, MCP stdio, and Node library surfaces.
- npm: [`aura-argus`](https://www.npmjs.com/package/aura-argus)
- Source: [`aura-argus/`](aura-argus/README.md)

![Actual AuraArgus CLI output](docs/assets/aura-argus-output.svg)

*Actual output from v0.1.2, trimmed for display. The command and the retrieved passage are unmodified.*

```bash
npm i -g aura-argus
aura-argus search "SearXNG 对 429 的冷却时间是多少秒？" --json
aura-argus fetch https://docs.searxng.org/dev/search_api.html --max-chars 4000
```

MCP client configuration:

```json
{
  "mcpServers": {
    "aura-argus": {
      "command": "npx",
      "args": ["-y", "aura-argus", "mcp"]
    }
  }
}
```

**Scope.** AuraArgus is a registry-bound retrieval layer, not a general-purpose search engine. Unregistered entities return no evidence by default. Web fallback is opt-in and can be blocked by anti-bot pages. It does not log in, bypass CAPTCHAs, or generate an answer; the caller's model writes the answer from the returned passages.

### AuraCardea — DSH chat fold

AuraCardea is a web client plugin for DeepSeek Harness. It replaces the `conversation.chat.node` `turn-process` renderer and folds the intermediate rows of a turn — tool calls, reasoning, context injections, retries — into one row per kind. Category rows show success/failure counts and total duration; expanding a category reveals individual calls, parameters, output, exit codes, and image thumbnails.

- DSH 0.2.x web profile; Node.js ≥ 20.
- npm: [`aura-cardea`](https://www.npmjs.com/package/aura-cardea)
- Source: [`aura-cardea/`](aura-cardea/README.md)
- Package shape: `dsh.bundle` with `cordis.patch.yml`, plus `dsh.client` for the browser half.

```bash
dsh plugin --profile web add aura-cardea
```

Then add the mount row to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: client-aura-cardea
      name: 'aura-cardea'
```

Restart `dsh web`. When the package is installed as a bundle through a configured plugin market, the bundle patch performs the mount automatically.

**Scope.** AuraCardea is DSH-specific. It does not add retrieval tools, alter model output, or provide a portable chat UI. It depends on DSH's chat DOM contracts, which can change between DSH versions; `tools/check-kinds.mjs` is included to detect new node kinds.

---

## Verification

Last verified: **2026-10-22**. Network-dependent checks are not part of CI. The evaluation is a fixed internal regression set, not a public benchmark.

| Package | Check | Result |
|---|---|---|
| AuraArgus `0.1.2` | `npm test` | 51 / 51 |
| | `node eval/run.mjs` | 31 questions; 141 / 141 hard checks |
| | `node eval/verify.mjs` | 34 / 34 registered sources reachable |
| | Public npm install (`npm i -g aura-argus@0.1.2`) | 4 tools; `initialize` and `tools/list` verified; CLI `version` and `search` verified |
| AuraCardea `1.1.0` | `node tools/check-kinds.mjs` | 19 / 19 discovered kinds have a rule |
| | `npm pack` | 7 files; 23.7 kB packed |
| | Host import, client syntax, `npm install` | verified |
| | Public profile install (`dsh plugin ... aura-cardea@1.1.0`) | package resolves as `aura-cardea`; bundle metadata present |
| | DSH UI after restart | pending manual restart of the running `dsh web` |

Two AuraArgus soft checks are intentionally disabled because web fallback is opt-in; they are reported separately from the hard suite and are not counted as passes.

The public packages were installed from the npm registry on 2026-10-22. The running `dsh web` process predates the configuration change; the public AuraCardea bundle and the public AuraArgus adapter take effect after a restart. No automated DSH UI test is included.

Reproduction:

```bash
cd aura-argus
npm test
node eval/run.mjs
node eval/verify.mjs

cd ../aura-cardea
npm pack
node tools/check-kinds.mjs <dsh-node-modules>/@deepseek-ai
```

---

## How it compares

### AuraArgus: scope comparison, not a benchmark

| Dimension | AuraArgus | General search API | Keyless SERP | Documentation chatbot |
|---|---|---|---|---|
| Coverage | Registered entities: 18 / 34 sources | Broad web | Broad web | A selected documentation corpus |
| Credentials | None | API key | None | Usually an account or key |
| Billing | None | Per request | None | Varies |
| Output | Passages with URL and score | Snippets with URL | Links and snippets | Generated prose |
| Strength | Traceable official-source evidence | Recall and freshness | No key | Fluent synthesis |
| Main limitation | Not a general web index | Cost, key management | Stability and anti-bot blocking | Provenance is indirect |

AuraArgus is not positioned as a replacement for general web search. It is appropriate when the question belongs to a registered entity and the caller needs citable passages from the official source. For open-web recall, a general search API remains the appropriate tool.

### AuraCardea: presentation layer, not a chat platform

| Dimension | AuraCardea | DSH default chat rendering |
|---|---|---|
| Scope | DSH 0.2.x web | DSH web |
| Intermediate rows | Folded by kind with counts, timings, and inline details | Shown as individual rows |
| Portability | DSH-only | DSH-only |
| Model behavior | Unchanged | Unchanged |
| Telemetry | None added | Not applicable |

AuraCardea does not claim to improve model quality. It changes the density and scanability of an existing turn, at the cost of coupling to DSH's chat DOM.

---

## Repository access

Installing a package does not require cloning this repository. For source inspection:

### Sparse checkout

```bash
git clone --filter=blob:none --sparse https://github.com/Ck-epsilon/Aura.git
cd Aura
git sparse-checkout set aura-cardea
```

Replace `aura-cardea` with `aura-argus` for the other package.

### degit

```bash
npx degit Ck-epsilon/Aura/aura-cardea aura-cardea
```

### Package managers

```bash
npm i -g aura-argus
npm i aura-cardea
```

---

## Repository layout

```text
Aura/
  README.md
  README.zh.md
  LICENSE
  docs/assets/
  aura-argus/          # retrieval: CLI / HTTP / MCP / Node library
  aura-cardea/         # DSH web client plugin
```

Each package is independently publishable. Its manifest points back to this repository:

```json
"repository": {
  "type": "git",
  "url": "https://github.com/Ck-epsilon/Aura",
  "directory": "aura-cardea"
}
```

---

## Conventions

- **npm name:** `aura-<product>` (`aura-argus`, `aura-cardea`).
- **Product name:** `AuraXxx` in prose and UI.
- **Versioning:** independent semver per package; recommended tags are `aura-cardea-v1.1.0`.
- **DSH packages:** declare both `dsh.bundle` and `dsh.client`; use `engines.dsh` for the supported DSH range.
- **No shared runtime:** packages do not depend on each other. A small amount of duplication is preferred to a premature shared abstraction.
- **No mandatory root workspace:** each package can be tested and released on its own.

---

## Status

| Package | Version | Runtime | Notes |
|---|---|---|---|
| AuraArgus | `0.1.2` | Node.js ≥ 20 | Registry-only by default; web fallback is opt-in |
| AuraCardea | `1.1.0` | DSH 0.2.x web | Bundle + client; manual or market installation |

No additional packages are published from this repository at this time.

---

## License and third-party notices

Original code in this repository is released under the MIT License; see [`LICENSE`](LICENSE) and each package's `LICENSE` file.

Third-party names, trademarks, and works referenced by a package remain the property of their respective owners. The MIT license covers original code only and does not grant any license to third-party intellectual property.
