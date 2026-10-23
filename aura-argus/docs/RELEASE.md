# Release checklist — 2.3.0

Status: **2.3.0 prepared locally; 0.2.0 is the current npm `latest`. Publish and human sign-off pending.**

## Published

- npm: `aura-argus@0.2.0` (2026-10-23); 0.1.2 and earlier staged builds are superseded.
- GitHub: `Ck-epsilon/Aura` (public, main, "Aura source monorepo"); source under `aura-argus/`.

## Credentials / accounts needed

- npm account with 2FA and **trusted publishing** configured for this repository and the `release` workflow. No long-lived token.

## Gates

| Gate | Command | Status |
|---|---|---|
| Unit/integration | `npm test` | 125/125 pass |
| Live eval (hard) | `npm run eval` | 74 questions / 361 checks pass; soft 2/2 |
| Answerability | `npm run answerability` | 73/73 (100%); p95 2481 ms |
| Release gate | `npm run gate` | pass (p95 ≤2500 for 2.3) |
| Held-out deep index | `npm run eval:heldout` | 4/4 (100%); p50 59 ms / p95 109 ms |
| Agent benchmark | `npm run bench:agent` | 77/77 success; citation 100%; facts 100%; p95 2460 ms; score 1.0 |
| Fast eval | `node eval/run.mjs --fast` | 74/74 pass; 10 index hits |
| Coverage health | `npm run verify` | 103 entities / 217 sources; 216/217 at last check (Anthropic read timeout) |
| Registry-only health | `npm run verify:registry` | 78/145 |
| Pack audit | `npm pack --dry-run` | 53 files / 123.3 KB; no secrets |
| Install/uninstall | tarball → temp prefix → `aura-argus aura_argus_version` + MCP handshake | pass (2.3 tarball: 2.3.0, tools/list OK) |
| Zip artifact | `git archive … → dist/aura-argus-2.3.0.zip` | build after the release commit |
| npm publish | `npm publish` | pending (0.2.0 is live) |
| Human sign-off | owner | pending |

## Publish commands

```bash
npm ci
npm test
npm run eval
npm run answerability
npm run gate
node eval/run.mjs --fast
npm run verify
npm pack --dry-run
npm pack

npm i -g ./aura-argus-2.3.0.tgz --prefix .tmp/prefix
node .tmp/prefix/node_modules/aura-argus/src/cli.mjs aura_argus_version
```

After trusted publishing is confirmed:

```bash
git tag v2.3.0
git push origin v2.3.0
```

Post-publish verification:

```bash
npm view aura-argus version
npx -y aura-argus@2.3.0 version
npx -y aura-argus@2.3.0 mcp   # initialize + tools/list smoke
```

## Rollback

1. `npm deprecate aura-argus@2.3.0 "broken: <reason>; use <next>"`.
2. Publish a patch with the fix.
3. Unpublish only within npm's 72-hour window and only for a security/legal emergency; otherwise deprecate + patch is the rollback.
4. GitHub: revert the release tag or mark the release as pre-release.

## Open blockers

- npm trusted publishing configuration for future releases.
- Install/MCP Inspector client-side smoke tests for 1.3.
- GNU Bash manual intermittent ECONNRESET (upstream).
- Human sign-off.