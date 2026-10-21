# AuraArgus

给 agent 的检索层。两个能力，替代传统的 search 与 fetch：

- **search**：把问题路由到注册的官方源，抓回页面，返回**可引用的逐字段落**。
- **fetch**：取回一个 URL，转成干净的 Markdown 文本。

零 API key、零按次计费、默认只连官方页；Windows / macOS / Linux 同一份代码。

## 为什么不是搜索引擎聚合器

在大陆无代理的实测里，keyless SERP 的召回已经坏了：Bing 对无 cookie 请求返回首词/词典/导航式结果，百度约 30 次请求后跳验证码，DDG / Google 不可达。而**官方页本身可达，正文里就有答案**——失败的是 URL 发现，不是网络。

所以 AuraArgus 不聚合 SERP。它维护一份「实体 → 官方源」注册表，把问题路由到正确的官方页，再抽段、给出处。先看一组 6 题的对照实验：

| 方案 | 命中 |
|---|---|
| keyless 链接列表 | 3 / 12 |
| keyless + 本地选段 | 4 / 12 |
| 官方 Search API（付费） | 11 / 12 |
| **AuraArgus** | **13 / 13** |

覆盖评测（18 个实体、中英文、别名、未知实体）是 **31 题 / 141 项硬检查全部通过**；2 项 soft 兜底默认关闭（fallback 改为 opt-in），见 [RESULTS.md](RESULTS.md)。

细节见 [RESULTS.md](RESULTS.md) 与 [POSITIONING.md](POSITIONING.md)。

## 要求

- Node.js **≥ 20**（用到内置 `fetch` / `AbortSignal.timeout`）
- 零依赖，不需要 `npm install`
- Windows / macOS / Linux

## 安装

```bash
npm i -g aura-argus
aura-argus version
```

或者直接从源码跑：

```bash
git clone <repo> && cd aura-argus
node src/cli.mjs search "SearXNG 对 429 的冷却时间是多少秒？"
```

## 四种入口

### 1. CLI

```bash
# 检索：返回证据（JSON）
aura-argus search "SearXNG 对 429 的冷却时间是多少秒？"

# 人眼可读
aura-argus search "Tavily 一个 credit 多少钱？" --text

# 取回一页：干净 Markdown
aura-argus fetch https://docs.searxng.org/dev/search_api.html --max-chars 4000

# 注册表与健康检查
aura-argus sources
aura-argus doctor
```

退出码：`0` 成功、`2` 无证据、`3` 参数错误、`4` 抓取失败、`130` 中断。

### 2. 本地 HTTP（任何语言 / agent）

```bash
aura-argus serve --port 8787
# {"ok":true,"url":"http://127.0.0.1:8787"}
```

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 版本、源数量、uptime |
| GET | `/sources` | 注册表 |
| GET | `/search?q=&maxSources=` | 证据包 |
| POST | `/search` | `{ "question": "...", "maxSources": 3 }` |
| POST | `/search/batch` | `{ "questions": ["..."], "concurrency": 3 }` |
| GET | `/fetch?url=&maxChars=` | 页面文本 |
| POST | `/fetch` | `{ "url": "...", "maxChars": 20000 }` |

```bash
curl -s 'http://127.0.0.1:8787/search?q=SearXNG+429' | head -c 400
curl -s 'http://127.0.0.1:8787/fetch?url=https%3A%2F%2Fdocs.searxng.org%2Fdev%2Fsearch_api.html'
```

默认只绑 `127.0.0.1`；`--token <t>` 后要求 `Authorization: Bearer <t>`。

### 3. MCP stdio（任何 MCP 客户端）

```bash
aura-argus mcp
```

客户端配置（以 Claude Desktop / 任意 MCP host 为例）：

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

工具：`search(question, maxSources?)`、`search_batch(questions, concurrency?)`、`fetch(url, maxChars?)`、`sources()`。stdout 只写 JSON-RPC，不混日志。

### 4. DSH（DeepSeek Harness）

仓库自带 `adapters/dsh/index.mjs`。在 `~/.dsh/profiles/web/cordis.patch.yml` 里插入适配器，并把 web 的 provider 指过去：

```yaml
- insert:
    - id: web-argus
      name: 'E:/workspaces/aura-argus/adapters/dsh/index.mjs'   # 换成你的 checkout 路径
      config:
        maxSources: 3
        maxChars: 20000
        # marker: true   # 验证期打开：snippet 会以 [aura-argus] 开头

- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: aura-argus
    fetchProvider: aura-argus-http
```

重启 dsh web 后生效（运行中的进程不会热加载 patch）。验证：

```bash
dsh --profile web --dump-config | Select-String searchProvider   # 应显示 aura-argus
node eval/verify-dsh.mjs --live                                  # 9/9
aura-argus search "SearXNG 429" --json                           # 终端侧对照
```

服务端没有 `aura-argus` 时 DSH 会报 `WEB_PROVIDER_CONFIGURED_MISSING`，不会静默回落到计费路径。回滚：删掉 `web-argus` 段，把 `searchProvider` / `fetchProvider` 改回原值（如 `aura-keyless` / `http`），重启。

**这替换的是 provider，不是工具。** `web_search` / `web_fetch` 仍是 `tool-web`，受它的契约限制：最多 4 个 query、合并成一个 sources 列表（丢失逐 query 归属）、只给 snippet（我们的 passages 被压成一条）、没有 `search_batch`、fetch 有它的 SSRF/重定向/大小规则。

要拿回完整契约，把 AuraArgus 的 MCP server 挂进 DSH（profile patch 里已写入 `mcp-aura-argus`）：

- 工具：`mcp__aura-argus__search` / `search_batch` / `fetch` / `sources`
- 想强制走原生工具：给 `tool-web` 加 `disable: true`（先跑一轮确认 MCP 可用，再禁）
- 内置工具已并发处理 1–4 个 query；MCP 的增量是逐 query 结果、批量上限 20、passages 与出处完整保留
- MCP 的 `initialize.instructions` 会被 DSH 的 mcp-client 自动注入 systemPrompt（`mcp:aura-argus` 段），工具描述也会作为元数据进入模型——不需要再手写 AGENTS.md 规则

### 5. Node 库

```js
import { search, searchBatch, fetchDocument } from 'aura-argus';

const evidence = await search('SearXNG 对 429 的冷却时间是多少秒？');
const batch = await searchBatch(['q1', 'q2', 'q3'], { concurrency: 3 });
const page = await fetchDocument('https://docs.searxng.org/dev/search_api.html', { maxChars: 4000 });
```

## 契约

### search

```json
{
  "schemaVersion": 1,
  "question": "SearXNG 对 429 的冷却时间是多少秒？",
  "entity": "searxng",
  "mode": "registry",
  "evidence": [
    {
      "url": "https://docs.searxng.org/admin/settings/settings_search.html",
      "title": "search: - SearXNG Documentation",
      "site": "docs.searxng.org",
      "passages": [{ "text": "… suspended_times: … SearxEngineTooManyRequests: 3600 …", "score": 15 }]
    }
  ],
  "attempts": [{ "url": "…", "ok": true, "ms": 855, "passages": 6 }],
  "tookMs": 1011,
  "cached": false
}
```

`mode` 取值：`registry`（注册表命中）、`web-fallback`（仅 `--fallback` 时出现的 360/搜狗兜底）、`none`（无证据）。

### fetch

```json
{
  "schemaVersion": 1,
  "url": "https://docs.searxng.org/dev/search_api.html",
  "finalUrl": "https://docs.searxng.org/dev/search_api.html",
  "status": 200,
  "title": "Search API - SearXNG Documentation",
  "text": "# Search API\n\nSearXNG supports querying…",
  "chars": 4000,
  "truncated": true,
  "contentType": "text/html; charset=utf-8",
  "tookMs": 312
}
```

### 错误码

`BAD_URL`、`BAD_REQUEST`、`PRIVATE_ADDRESS`、`TOO_MANY_REDIRECTS`、`TIMEOUT`、`FETCH_FAILED`、`HTTP_ERROR`、`UNSUPPORTED_CONTENT_TYPE`、`TOO_LARGE`、`NO_ENTITY`、`NO_EVIDENCE`、`ALL_SOURCES_FAILED`。

## 源注册表

`src/registry.json`：**18 个实体 / 34 个源**，全部在 CN 直连下实测可达（`aura-argus doctor`）。

加一个实体：

```json
"实体": {
  "aliases": ["名字", "别名"],
  "sources": [{ "url": "https://官方页", "title": "…", "covers": ["关键词"] }],
  "discovery": { "type": "sitemap", "url": "https://…/sitemap.xml" }
}
```

- `covers` 只用于排序；命中实体后默认抓该实体的全部源（上限 `--max-sources`）。
- 所有源都失败时，若有 `discovery`（`sitemap` 或站点索引），再走一跳发现。
- 默认 **registry-only**：未注册实体返回 `mode: "none"`；显式 `--fallback`（CLI）/`fallback: true`（HTTP/库）才走 360/搜狗，只返回链接 + 摘要，标 `mode: "web-fallback"`。

## 跨平台

- 无原生依赖、无 shell 调用、无平台路径写死；只用 `node:` 内置模块。
- 缓存目录：Windows `%LOCALAPPDATA%\aura-argus\cache`，macOS/Linux `$XDG_CACHE_HOME/aura-argus` 或 `~/.cache/aura-argus`；可用 `AURA_ARGUS_CACHE_DIR` 覆盖。
- CI 矩阵：`ubuntu / macos / windows × node 20 / 22 / 24`，只跑离线测试与 `npm pack --dry-run`。

## 跨 agent

MCP stdio 与 CLI 都在本地跑，不绑定 DSH：

| agent | 接法 | 实测（2026-10-21） |
|---|---|---|
| Codex CLI 0.163 | `codex mcp add aura-argus -- node <abs>/cli.mjs mcp` | `mcp_tool_call` server=`aura-argus` tool=`search`，返回 3600 s + 官方 URL |
| Hermes 0.21.3 | `hermes mcp add aura-argus --command node --args <abs>/cli.mjs mcp` | 4 tools discovered（1937 ms）；`-z` 明确走 MCP，返回 3600 s + URL |
| ZCode（Electron） | `~/.zcode/cli/config.json` → `mcp.servers`（stdio） | 配置已加；当前 ZCode 进程早于配置，重启后才会拉起 MCP；CLI/skill 仍作兜底 |
| Claude Desktop / Cursor / Cline | 标准 stdio：`npx -y aura-argus mcp` | 发布后用 MCP Inspector + 各客户端补测 |

- Windows 下部分客户端要写 `cmd /c npx ...`；配置路径随客户端不同。
- 任何能跑 shell 的 agent：`aura-argus search "<q>" --json`。

## 失败与重试

- `fetchRaw`：每个源最多 3 次尝试（`retries=2`），只重试网络错误、超时、408/425/429/5xx；其余 4xx 立即失败。
- 退避：300 ms 起、指数 + 抖动，单次最多 3 s；尊重 `Retry-After`（上限 3 s）；总预算 `max(20 s, 2×timeout)`，到点即停。
- 一次检索里所有源都失败 → 结果带 `error.code = ALL_SOURCES_FAILED` 和逐源 `attempts`（含 `tries`、`status`）：
  - CLI 退出码 `4`；HTTP `/search` 返回 `502`；MCP `isError: true`；DSH provider 抛 `WEB_PROVIDER_ERROR`。
- 批量有 budget：MCP 35 s、HTTP 45 s（CLI `--budget`），超时项标 `BATCH_BUDGET_EXCEEDED`，避免重试把一次工具调用拖过客户端 60 s 超时。
- 不做跨源的二次重试、不做失败缓存/冷却；失败的下一次调用会重新尝试。

## 安全边界

- 默认拒绝 loopback / 私有网段 / link-local / 组播 / metadata：`127/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`::1`、`fc00::/7`、`fe80::/10` 等；DNS 解析后复查，重定向逐跳复检。
- 显式 opt-in：CLI `--allow-private`，库 `allowPrivate: true`，HTTP `serve --allow-private`，MCP 启动时 `AURA_ARGUS_ALLOW_PRIVATE=1`。
- 不绕登录/付费墙/验证码；无内置 key、无代理池、无遥测。
- `serve` 默认绑 `127.0.0.1`；对外暴露时加 `--token`。

## 边界

- **覆盖率 = 注册表**。没收录的实体默认返回无证据；显式开启 fallback 才走网页兜底。
- 不做 JS 渲染、不登登录墙、不绕验证码、不做代理池。
- 低频、单机、只读抓取；对目标站点友好是最低要求。
- 返回证据，不生成答案；答案由调用方的模型写。
- `web-fallback` 是 opt-in，依赖 360/搜狗，可能被反爬；失败时明确报 `mode: "none"`。

## 性能

`npm run bench`（30 题，无缓存冷启动）：

| 模式 | 总耗时 | 平均 |
|---|---|---|
| 串行 | 21.6 s | 721 ms/题 |
| 批量（concurrency=3，冷） | 6.9 s | 230 ms/题 |
| 批量（缓存填充） | 6.1 s | 202 ms/题 |
| 批量（缓存命中） | ~1 ms | — |

- **并发可调**：同一批 30 题，c=6 / c=8 实测约 3.5 s / 2.0 s（无空结果）；默认 3 是为了对官方站点礼貌，不是性能上限。
- **同题多源并行**：一个问题的 2–3 个官方源同时抓，不再串行等待。
- **页面缓存 + in-flight 去重**：批内同一 URL 只抓一次；TTL 10 min。
- **结果缓存**：同一 query 15 min 内直接命中（`--no-cache` 关闭）。

批量入口：

```bash
  echo '["q1","q2"]' | aura-argus search --batch [--concurrency 3] [--budget 45000]
curl -X POST localhost:8787/search/batch -d '{"questions":["q1","q2"]}'
```

## 测试与评测

```bash
npm test          # 离线：51 个测试（解析 / 选段 / 注册表 / 缓存 / 批量 / 重试 / 私网拦截 / HTTP / MCP / DSH 适配器）
npm run eval      # 联网：31 题 / 141 项硬检查（+2 项 soft 兜底默认关闭）
npm run verify    # 联网：34 个源的可用性
```

## 文件

| 路径 | 作用 |
|---|---|
| `src/cli.mjs` | CLI 入口 |
| `src/core.mjs` | 公共 API |
| `src/registry.json` | 实体 → 官方源（产品资产） |
| `src/lib/router.mjs` | 实体匹配 → 抓取 → 选段 → 兜底 |
| `src/lib/fetch.mjs` | URL 校验 / 限时 / 限大小 / 文档转换 |
| `src/lib/extract.mjs` | 打分 + 邻行窗口 + 表格/列表块合并 |
| `src/lib/server.mjs` | HTTP 服务 |
| `src/lib/mcp.mjs` | MCP stdio |
| `src/lib/cache.mjs` | 内存 + 磁盘缓存 |
| `eval/` | 金标准问题、评测脚本、注册表检查 |
| `test/` | 离线测试 |
| `docs/integrations/` | Codex / Hermes / ZCode / Claude / Cursor / CLI / HTTP 接法 |
| `schema/tools.json` | OpenAI / Anthropic function-calling 工具 schema |
| `openapi.json` | HTTP API 的 OpenAPI 3.1 |
| `SECURITY.md` | 安全模型、私网拦截、漏洞上报 |
| `adapters/dsh/` | DSH provider 适配器 |
| `POSITIONING.md` | 定位、市场对比、实验记录 |

## License

MIT
