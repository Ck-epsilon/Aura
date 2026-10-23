# Security

## Supported versions

`1.2.x` is the current stable line. Security fixes land on the latest `1.2.x`; `1.1.x` receives critical fixes.

## Reporting

Use GitHub private vulnerability reporting (Security → Report a vulnerability) at
<https://github.com/Ck-epsilon/aura-argus/security/advisories/new>. If that is unavailable,
open an issue that describes the impact without including a working exploit or secrets.

Please include: affected version, command/tool, expected vs actual behavior, and whether the
target is local, private-network, or public. We aim to acknowledge within 7 days.

## Security model

AuraArgus is a local, read-only retrieval tool. It does not host a service, does not require an
API key, and does not send telemetry.

- **Network egress is user-initiated.** `search` only fetches URLs from the local registry (or an
  explicitly discovered source); `fetch` accepts a URL from the caller.
- **Private targets are denied by default.** Loopback, RFC1918, CGNAT, link-local, multicast,
  documentation ranges, cloud metadata addresses, `localhost`, `fc00::/7`, `fe80::/10`, `::1`,
  and IPv4-mapped private addresses are rejected. DNS is resolved before the request and every
  redirect hop is re-checked.
- **Opt-in escape hatch.** `--allow-private` / `allowPrivate: true` / `AURA_ARGUS_ALLOW_PRIVATE=1`
  disables the private-target check. Only use it for a trusted local source; prompt injection can
  abuse it if it is enabled by default.
- **No bypass of access controls.** The tool does not log in, solve CAPTCHAs, bypass paywalls, or
  rotate proxies. Users are responsible for complying with the target site's terms and robots
  policy.
- **HTTP server is local by default.** `serve` binds `127.0.0.1`. When binding to another host,
  always set `--token`; the token is a bearer secret, not a substitute for network isolation.
- **Cache is local.** Search results and pages are cached under the user cache directory; the page cache stores fetched text with `ETag` / `Last-Modified` and separates public/private entries. The optional section index (`aura-argus index`) stores fetched sections under the local cache, with the same public/private separation. Use `--no-cache` to bypass.
- **Query log is opt-in and local.** `AURA_ARGUS_QUERY_LOG=1` writes question text and evidence metadata to a local JSONL file; nothing is sent anywhere. Unset it to stop logging. `aura-argus gaps` only reads that local file.

## Known limitations

- DNS rebinding is mitigated by pre-resolution checks but not fully eliminated; a hostile DNS
  server could change answers between the check and the request.
- Node's built-in `fetch` does not honor `HTTP_PROXY` / `HTTPS_PROXY` automatically. Corporate
  networks may need `NODE_EXTRA_CA_CERTS` or a custom dispatcher.
- The 360/Sogou fallback is opt-in and scrapes public result pages; it is subject to anti-bot
  blocking and may violate a target site's terms if used at scale.
- `--allow-private` deliberately weakens SSRF protection; it should never be the default in a
  multi-user deployment.
