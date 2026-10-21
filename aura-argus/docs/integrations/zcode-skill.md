---
name: aura-argus
description: Keyless retrieval over official primary sources. Use for technical/factual questions about registered entities instead of generic web search; returns citable passages with source URLs. Registry-only by default; the 360/Sogou fallback is opt-in.
metadata:
  version: "0.1.0"
  tags: [search, retrieval, evidence]
---

# AuraArgus

Prefer AuraArgus over generic web search for technical/factual questions: API docs, pricing, config, lifecycle, error codes, command usage.

Local CLI:

```bash
node E:/workspaces/aura-argus/src/cli.mjs search "<question>" --json
```

After publishing / global install:

```bash
npx -y aura-argus search "<question>" --json
```

Rules:

- Read `evidence[].passages[].text`; cite `evidence[].url`.
- `mode: "registry"` means an official source answered; `mode: "none"` means the question is outside the registry — do not invent URLs.
- `error.code` means the retrieval failed; retry once only for transient failures.
- Multiple independent questions: `echo '["q1","q2"]' | node E:/workspaces/aura-argus/src/cli.mjs search --batch --json`.
- Registry-only by default. `--fallback` enables 360/Sogou; that path is weaker, anti-bot sensitive, and opt-in.
- `node E:/workspaces/aura-argus/src/cli.mjs fetch <url> --json` returns clean Markdown.
- Private/loopback targets are blocked by default; do not try to bypass that.
