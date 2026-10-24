# AuraArgus

**把技术问题路由到官方文档，返回可引用的原文段落。**

AuraArgus 是一个本地运行的检索工具，给 agent、脚本或你自己用。它不卖搜索 API，不需要 key，也不按次计费：你给一个问题，它找到对应的官方页面，抓回正文，挑出相关段落，连同出处 URL 一起返回。

它解决的不是“搜不到”，而是“搜到的是一堆二手摘要”。官方文档里本来就有答案，缺的是从问题到那页纸的路由。

当前版本 **1.0**：结果契约冻结为 `schemaVersion: 1`，见 [CONTRACT.md](CONTRACT.md)。

---

## 它是什么

- **search**：问题 → 实体 → 注册的官方源 → 正文 → 选段 → 证据包
- **fetch**：一个 URL → 干净 Markdown（标题、长度、截断标记）
- 证据包里每条都带 `url`、`title`、`passages[].text`、`score`；每段还有稳定 `id`、`heading`、`headingPath`、`anchor` 与可直接引用的 `citation`
- `facts` 从证据段落里抽价格、百分比、版本、日期、限额、状态码，带 `passageId` 与 `citation`，按查询意图过滤
- 多来源时 `consensus` 汇总一致值与冲突值（只比较同单位的 price/percent/limit/status），并给出 `agreementRatio`
- 零依赖，Node.js ≥ 20，Windows / macOS / Linux
- 不内置 key、不按次计费、无账号、无遥测

## 它不是什么

- 不是通用搜索引擎，也不是问答机器人；它返回**证据**，答案由调用方的模型写
- 不追求“全网覆盖”：默认覆盖 = 注册表 + 内置站点包（**78 实体 / 145 源** + **42 站点 / 72 源**，合并 **103 实体 / 220 源**）；`--no-sites` 回到严格注册表，`--site <domain>` 把边界限定到指定站点
- 不做 JS 渲染、不登登录墙、不绕验证码、不做代理池
- 未命中覆盖时返回 `mode: "none"`，不会硬编一个答案；`--no-sites` 可关闭默认站点包
- `--no-fallback` 可关闭默认网页兜底；CLI/MCP/HTTP 默认 `fallback=auto`，库调用需显式传入；360/搜狗可能被反爬，站内 `--site` 还会尝试官方 sitemap 发现并抓正文

---

## 30 秒上手

### 从 zip 直接运行（不需要 npm install）

```bash
unzip aura-argus-3.0.0.zip
cd aura-argus-3.0.0

node src/cli.mjs aura_argus_search "SearXNG 对 429 的冷却时间是多少秒？" --json
```

零依赖，不需要 `npm install`。先确认 Node 版本：

```bash
node -v    # 需要 >= 20
```

### 安装成全局命令

```bash
npm i -g aura-argus
aura-argus aura_argus_version
aura-argus aura_argus_search "Node.js 怎么用 http 模块创建服务器？" --text
```

如果你的 npm 默认走镜像（比如 `registry.npmmirror.com`），刚发布的版本可能还没同步；可以显式指定：

```bash
npm i -g aura-argus --registry=https://registry.npmjs.org/
```

### 一个最小例子

```bash
aura-argus aura_argus_search "Tavily 一个 credit 多少钱？" --json
```

返回（截断）：

```json
{
  "schemaVersion": 1,
  "question": "Tavily 一个 credit 多少钱？",
  "entity": "tavily",
  "entities": [
    { "id": "tavily", "origin": "registry", "confidence": { "score": 0.9, "label": "high" } }
  ],
  "mode": "registry",
  "evidence": [
    {
      "id": "a1b2c3d4e5f6",
      "url": "https://www.tavily.com/pricing",
      "title": "Pricing - Tavily",
      "passages": [{
        "id": "9f8e7d6c5b4a",
        "text": "… 1,000 credits … $0.008 per credit …",
        "score": 12,
        "kind": "prose",
        "heading": "Pay as you go",
        "headingPath": "Pricing > Pay as you go",
        "anchor": "pay-as-you-go",
        "citation": "https://www.tavily.com/pricing#pay-as-you-go"
      }]
    }
  ],
  "attempts": [{ "url": "…", "ok": true, "ms": 397, "passages": 4, "cache": "page" }],
  "facts": [{
    "id": "7c6b5a493827",
    "type": "price",
    "value": 0.008,
    "currency": "USD",
    "unit": "credit",
    "text": "… $0.008 per credit …",
    "confidence": 0.9,
    "passageId": "9f8e7d6c5b4a",
    "citation": "https://www.tavily.com/pricing#pay-as-you-go"
  }],
  "confidence": { "score": 0.9, "label": "high" },
  "facets": {
    "terms": ["tavily", "credit", "pricing"],
    "covered": ["tavily", "credit", "pricing"],
    "missing": [],
    "ratio": 1
  },
  "timings": { "routeMs": 0, "fetchMs": 380, "extractMs": 4, "selectMs": 6, "followMs": 0, "totalMs": 512 },
  "tookMs": 512,
  "cached": false
}
```

`mode` 三种值：

| mode | 含义 |
|---|---|
| `registry` | 命中注册表，抓的是官方源 |
| `web-fallback` | 官方证据不足后启用网页兜底；默认 auto，`--no-fallback` 可关；`--site` 会优先抓该域 sitemap/正文 |
| `none` | 注册表没有覆盖，或所有源都失败 |

| 字段 | 用途 |
|---|---|
| `confidence` | 0–1 + `high/medium/low`；agent 据此决定是否重试 |
| `facets` | 查询 facet 的 covered/missing/ratio |
| `entities` | 多实体时每个实体的 id/origin/置信度/facet |
| `intent` | `pricing` / `version` / `error` / `compare` / `howto` / `list` / `fact` |
| `plan` | 分解检索时的 `{intent, confidence, clauses, compound}` |
| `timings` | route / fetch / extract / select / follow / index / decompose / total |
| `next` | 缺 facet 时给下一步提示 |
| `attempts[].cache` | `memory` / `page` / `page-revalidated` / `miss` |
| `cache` | `none` / `result` / `index`；`index` 表示本地索引命中 |
| `version` | 已解析的文档版本（Node 20 / Python 3.11 / MySQL 8.0 等） |
| `evidence[].updated` | `Last-Modified` 或索引构建时间 |

字段的稳定契约见 [CONTRACT.md](CONTRACT.md)；1.0 起 `schemaVersion` 固定为 1。

失败时还会带 `error`：

```json
{ "error": { "code": "ALL_SOURCES_FAILED", "message": "all 2 sources failed", "attempts": 2 } }
```

CLI 退出码：`0` 有证据、`2` 无证据、`3` 参数/URL 错误、`4` 抓取失败、`130` 中断。

---

## 四种接法

### 1. CLI

```bash
aura-argus aura_argus_search "问题" --json          # 证据包（机器读）
aura-argus aura_argus_search "问题" --text          # 人眼可读
aura-argus aura_argus_search "问题" --max-sources 3
aura-argus aura_argus_search "问题" --mode fast     # 快速：少源、本地索引优先
aura-argus aura_argus_search "问题" --deep-index    # 使用 index --deep 建的深索引
aura-argus aura_argus_search "问题" --mode deep      # fast / balanced / deep 预设
aura-argus aura_argus_search "问题" --budget-ms 5000 # 墙钟预算；超时返回 partial 证据
aura-argus aura_argus_search "问题" --fallback=auto  # 低置信/缺 facet 时走自持网页兜底
aura-argus aura_argus_search "问题" --doc-version 20 # 指定版本文档（Node 20 / Python 3.11 等）
aura-argus aura_argus_search "问题" --site docs.example.com  # 站内检索：只信这个域，抓正文作证据
aura-argus aura_argus_fetch <url> --max-chars 4000  # 干净 Markdown
aura-argus aura_argus_sources                       # 注册表
aura-argus aura_argus_doctor                        # 源健康检查
aura-argus aura_argus_warm --top 20                 # 预热常用实体
aura-argus aura_argus_index --top 20                # 建本地 section 索引
aura-argus aura_argus_index --deep --entity docker,nginx --max-pages 80  # 递归发现官方深页并建索引
aura-argus aura_argus_gaps                          # 缺口汇总（需 AURA_ARGUS_QUERY_LOG）
```

批量（最多 50 题，逐题归属）：

```bash
echo '["q1","q2","q3"]' | aura-argus aura_argus_search_batch --concurrency 3 --json
```

默认覆盖 = 注册表 + 内置站点包；要回到严格注册表加 `--no-sites`；CLI/MCP/HTTP 默认 `fallback=auto`（官方不足才走网页），`--no-fallback` 关闭，把范围钉到一个域用 `--site`。默认拒绝本机/私网地址；确实要抓本地页面时加 `--allow-private`。

深度文档：`fetch` 和站内检索会保留标题、代码围栏（含缩进）与表格单元格边界，而不是把整页压成一行。

### 速度与缓存（0.7）

- 搜索结果磁盘缓存 15 分钟；页面持久缓存默认 6 小时，带 `ETag` / `Last-Modified`，跨进程复用。
- `warm` 把常用实体主源预取进页缓存：首次查询仍然冷，后续查询直接命中。
- **fast 模式**：`aura-argus aura_argus_index --top 20` 建本地 section 索引；`--mode fast` 对“已知事实”查询（价格、端口、版本、上限、日期等）本地命中（约 2 ms），开放 how-to/对比/清单问题自动回退 live，避免漏掉 API 名。
- 索引默认 24 小时过期（`AURA_ARGUS_INDEX_TTL_MS`），存于本地 cache；`AURA_ARGUS_INDEX_DIR` 可改目录。
- `index` 默认增量：新鲜索引直接复用；过期索引带 `ETag` / `Last-Modified` 只重抓变化的源，304 时复用旧 section。`--no-incremental` 强制全量重建。
- 多问题用 `aura_argus_search_batch` / MCP `aura_argus_search_batch`；42 题冷启动批量比串行快 **2.99×**。
- 公开页与 `--allow-private` 私网页分缓存键，不会互相复用。
- 同一主机的并发抓取默认上限 4（`AURA_ARGUS_HOST_CONCURRENCY`），批量/多实体时降低对官方站的瞬时压力。
- `AURA_ARGUS_NO_CACHE=1` 关闭缓存；`AURA_ARGUS_PAGE_TTL_MS` 调整页缓存 TTL。

### 模式与预算（1.7）

- `--mode fast`：2 个源、不跟链接、优先本地索引；`balanced`：默认（3 源、1 跳）；`deep`：6 源、2 跳、复合问题拆句、关闭早停。
- 显式的 `--max-sources` 仍可覆盖预设；链接发现、拆句与多实体由模式内部决定。
- `--budget-ms` 是整次检索的墙钟预算；预算耗尽时返回已抓到的证据并标记 `partial: true`、`budget.exhausted: true`，不会把整次调用抛成超时。
- MCP `mode` / `budgetMs`，HTTP `mode` / `budgetMs` 与 CLI 等价。

### 递归发现与 deep index（2.2）

- `index --deep --entity <id> --max-pages 80 --max-depth 2`：从官方种子页出发，递归 `robots.txt`/`sitemap.xml`/`sitemap-index.xml`/子 sitemap，并用同站链接 BFS 补没有 sitemap 的站点；抓到的页面建成可检索的 section 索引。
- `search --deep-index`（MCP/HTTP `deepIndex`）：深索引完全覆盖 facet 且置信度高时直接返回，通常在 **几十毫秒**；否则继续 live/递归，不会用半答案冒充完整答案。
- 在线递归只在 `howto/list/compare` 且置信度低于 0.55 时触发；默认最多 5 页、深度 2、同源、有墙钟预算。命中后会带 `recursive-sitemap` / `recursive-discovery` 标记。
- deep index 与普通索引共用 `ETag`/`Last-Modified` 增量复用；深索引的 `settings` 变化会触发重建。
- 实测：Docker/TypeScript/Kubernetes/Nginx 四个实体各 80–150 页、约 3.6 万 section；held-out 4/4，命中时 42–108 ms。单个大实体深索引约 3–7 MB，按实体分片，不会一次加载全部。

### 自持网页兜底（2.2）

- **CLI/MCP/HTTP 默认 `fallback: auto`**：先查注册表/官方深页；只有官方证据为空、置信度低于 0.6 或关键 facet 缺失时才走网页兜底。显式 `--no-fallback` 关闭；库调用 `search()` 仍默认关闭，需要显式传 `fallback:'auto'`。
- `--fallback`：仅当注册表证据为空时启用的网页兜底。
- `--fallback=auto`：低置信（<0.6）或关键 facet 缺失时也启用；适合 agent 的“先查一手源，答不出再全网”。
- 官方证据不会被丢弃：兜底只在官方证据之后追加；结果带 `fallback: {provider, officialSources, webSources, augmented}`，`evidence` 中官方来源保持在前。
- 优先使用自托管 **SearXNG**：`AURA_ARGUS_SEARXNG_URL=http://127.0.0.1:8080`；没有配置时走本项目的 keyless HTML 适配（Bing → 360 → DuckDuckGo，按查询语言调整顺序）。不依赖 Tavily/Exa 等商业 API。
- 引擎结果先做相关性过滤和 provider 失败熔断，再抓前 4 页正文；页面抓不到时退回摘要并标记 `snippet: true`。证据 `origin` 为 `web-fallback`，并带 `provider`。
- **隐私**：默认开启 auto 意味着低置信问题可能被发送到外部搜索引擎。隐私敏感场景用 `--no-fallback`；自托管 SearXNG 也会把查询发给其上游引擎。
- `AURA_ARGUS_WEB_PROVIDERS=searxng,bing,so360,duckduckgo` 可固定 provider 顺序。

### 版本文档（0.8）
- 问题里出现版本号时自动路由到对应版本文档：Node 18/20/22/24、Python 3.9–3.13、PostgreSQL 14–18、MySQL 8.0/8.4。
- 显式指定用 `--doc-version 20` / MCP `docVersion` / HTTP `docVersion`；只对 `src/versions.json` 里列出的实体生效。
- 版本化查询不使用 fast 索引（索引是当前版本），会走 live。
- evidence 的 `updated` 来自 `Last-Modified`；索引结果用索引构建时间。

### 缺口记录（0.6）

默认不记录。需要按真实查询补源时，显式开启本地日志：

```bash
AURA_ARGUS_QUERY_LOG=1 aura-argus aura_argus_search "问题" --json
aura-argus aura_argus_gaps --json          # 汇总 mode:none / 低置信度 / 高频缺失 facet
```

日志只写本机 JSONL（默认 `${cache}/queries.jsonl`），不发送任何数据；包含问题原文，注意隐私。

### 2. MCP（给 Claude Desktop / Cursor / Cline / Codex / Hermes / ZCode 等）

```bash
aura-argus aura_argus_mcp
```

客户端配置（以标准 stdio 为例）：

```json
{
  "mcpServers": {
    "aura-argus": {
      "command": "npx",
      "args": ["-y", "aura-argus", "aura_argus_mcp"]
    }
  }
}
```

Windows 上如果客户端无法直接拉起 `npx`：

```json
{
  "mcpServers": {
    "aura-argus": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "aura-argus", "aura_argus_mcp"]
    }
  }
}
```

MCP 工具：

| 工具 | 作用 |
|---|---|
| `aura_argus_search` | 单题 → 证据包 |
| `aura_argus_search_batch` | 多题（≤20）→ 逐题结果 |
| `aura_argus_fetch` | URL → Markdown |
| `aura_argus_sources` | 注册表覆盖 |

所有工具返回 `structuredContent` + `outputSchema`，并带 read-only annotations；`aura_argus_search` 结果里的 `confidence` / `facets` / `timings` 可直接用于 agent 决策。`aura_argus_search` 还支持 `multi` / `followLinks` / `fast` / `deepIndex` / `decompose` / `mode` / `budgetMs` / `fallback`；`fast` 需先用 `aura-argus aura_argus_index` 建本地索引。MCP 支持 `notifications/cancelled` 取消进行中的调用；带 `_meta.progressToken` 时 `aura_argus_search_batch` 会发 `notifications/progress`。旧名 `search` / `search_batch` / `fetch` / `sources` 仍作为兼容别名。

MCP 资源（不需要工具调用）：`argus://coverage`、`argus://health`、模板 `argus://entity/{id}`。

### 3. 本地 HTTP

```bash
aura-argus aura_argus_serve --port 8787
```

默认只绑 `127.0.0.1`。对外暴露时加 token：

```bash
aura-argus aura_argus_serve --port 8787 --token my-secret
```

常用接口（`/aura_argus` 前缀是规范名，旧路径继续兼容）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/aura_argus/health` | 版本、源数量、uptime |
| GET | `/aura_argus/sources` | 注册表 |
| GET | `/aura_argus/search?q=&maxSources=` | 证据包 |
| POST | `/aura_argus/search` | `{"question":"...","maxSources":3}` |
| POST | `/aura_argus/search/batch` | `{"questions":["..."],"concurrency":3}` |
| GET | `/aura_argus/fetch?url=&maxChars=` | 页面 Markdown |
| POST | `/aura_argus/fetch` | `{"url":"...","maxChars":20000}` |

```bash
curl -s 'http://127.0.0.1:8787/aura_argus/search?q=SearXNG+429' | head -c 400
```

### 4. JS 客户端

```js
import { createClient } from 'aura-argus/client';

const argus = createClient({ baseUrl: 'http://127.0.0.1:8787' });
const result = await argus.aura_argus_search('Node.js 20 的 fs.readFile 怎么用？', { mode: 'balanced' });
const batch = await argus.aura_argus_search_batch(['q1', 'q2'], { concurrency: 2 });
```

规范方法名是 `aura_argus_search` / `aura_argus_search_batch` / `aura_argus_fetch` / `aura_argus_sources` / `aura_argus_health`；`search` 等旧方法保留为别名。支持 token、超时、`AbortSignal` 取消；错误为 `ArgusClientError`（带 `code` / `status`）。详见 [docs/integrations/js-client.md](docs/integrations/js-client.md)。

### 5. Node 库

```js
import { aura_argus_search, aura_argus_search_batch, aura_argus_fetch_document } from 'aura-argus';

const evidence = await aura_argus_search('SearXNG 对 429 的冷却时间是多少秒？');
const batch = await aura_argus_search_batch(['q1', 'q2'], { concurrency: 3 });
const page = await aura_argus_fetch_document('https://docs.searxng.org/dev/search_api.html', { maxChars: 4000 });
```

旧的 `search` / `searchBatch` / `fetchDocument` 导出继续保留。

---

## 覆盖范围

目前默认覆盖：注册表 **78 个实体 / 145 个官方源**，叠加内置大陆直连站点包 **42 个站点 / 72 个源**，合并后 **103 个实体 / 217 个源**。站点包中有 17 个源标为 `fallback`，只在主源没有证据时尝试；`--no-sites` 回到严格注册表，`--sites-file` 可叠加用户站点包。

站点包补充：阿里云、腾讯云、华为云、火山引擎、通义千问、智谱、Kimi、SiliconFlow、百度智能云、微信小程序、微信支付、Gitee、uni-app、Ant Design、Element Plus、ECharts、Nacos、Dubbo、RocketMQ、OpenResty、MySQL、Spring Boot、MyBatis、Maven、Gradle 等 42 个站点。

| 类别 | 实体 |
|---|---|
| LLM / 搜索 API | DeepSeek、Tavily、SearXNG、Google CSE、Bing、Mistral、Hugging Face、LangChain、Ollama |
| 语言与运行时 | Python、Node.js、Go、Rust、Ruby、Scala、MDN、TypeScript、Deno、Bun、Java、.NET、PHP、Bash、PowerShell、C++（cppreference） |
| 框架 / 测试 | React、Vue、Next.js、Vite、Tailwind CSS、Django、FastAPI、Flask、Laravel、Rails、Express、Angular、Svelte、Jest、Cypress、pytest、ESLint、Vitest、Playwright、CMake |
| 数据 / 基础设施 | Docker、Kubernetes、nginx、PostgreSQL、Redis、MongoDB、SQLite、Cassandra、Elasticsearch、Prometheus、Grafana、Ansible、Istio、Argo CD、Helm、OpenTelemetry、Terraform、AWS、Azure、Google Cloud、Prisma、Supabase、Cloudflare |
| API / 商业服务 | GitHub、GitHub Advisory、npm、pnpm、PyPI、Stripe、OpenAI、Anthropic、Flutter |
| 其他 | Git |

加一个源（`src/registry.json`）：

```json
"实体": {
  "aliases": ["名字", "别名"],
  "sources": [{ "url": "https://官方页", "title": "…", "covers": ["关键词"] }],
  "discovery": { "type": "sitemap", "url": "https://…/sitemap.xml" }
}
```

`covers` 只用于排序；`fallback: true` 的源只在主源没有证据时尝试；命中实体后默认抓该实体的全部源（上限 `--max-sources`）。长尾/区域站点放 `src/sites.json`，用户站点包用 `--sites-file`。加完跑：

```bash
npm test
node eval/verify-registry.mjs   # 联网检查源是否可达
```

---

## 边界与安全

- **默认覆盖 = 注册表 + 内置站点包**。没收录的实体仍返回 `mode:none`；不要把它当通用全网搜索。
- **站内边界**：`--site <domain>` 只查该域，并优先用官方 sitemap/正文；不是任意全网搜索。
- **多实体对比**：检测到“和/与/vs/区别”等信号且命中 2+ 实体时，会并行检索并在 `entities` 里逐实体给证据与置信度；`--no-multi` 可关闭。
- **不绕访问控制**：不登录、不绕付费墙、不破验证码、不做代理池。
- **默认拒绝私网**：loopback、RFC1918、link-local、metadata 地址、`::1`、`fc00::/7`、`fe80::/10` 等都会被拦；DNS 解析后复查，重定向逐跳复检。
- 确实要抓本机/内网页面时显式开：CLI `--allow-private`，库 `allowPrivate: true`，MCP 启动时 `AURA_ARGUS_ALLOW_PRIVATE=1`，HTTP `serve --allow-private`。
- **无 key、无遥测、无账号**。缓存只在本机（Windows `%LOCALAPPDATA%\aura-argus\cache`，macOS/Linux 在 XDG cache）；页面持久缓存会保存抓到的正文，公开页与 `--allow-private` 私网页分键存储，默认 6 小时过期。
- **缓存可关闭**：`--no-cache` / `AURA_ARGUS_NO_CACHE=1`；页缓存 TTL 用 `AURA_ARGUS_PAGE_TTL_MS`。
- **取消**：HTTP 客户端断开时中止进行中的抓取；MCP 收到 `notifications/cancelled` 时中止对应请求，不会继续消耗带宽。
- `serve` 默认绑 `127.0.0.1`；暴露到其他主机时务必设 `--token`。

---

## 常见问题

**为什么没有直接给我答案？**<br>
它给的是证据：原文段落 + 出处。答案由你的模型/脚本基于这些段落写，这样可核对、可引用。

**为什么第二次问同一个页面快很多？**<br>
搜索结果缓存 15 分钟；页面持久缓存默认 6 小时（ETag/Last-Modified 条件请求），跨进程复用。想强制冷启动用 `--no-cache`，或 `AURA_ARGUS_NO_CACHE=1`。

**多实体/对比问题怎么问？**<br>
直接问“PostgreSQL 和 MySQL 的隔离级别有什么区别”；检测到对比信号时会并行查两个实体，并在 `entities` 里分别给 confidence/facets。想强制单实体用 `--no-multi`。
直接问“PostgreSQL 和 MySQL 的隔离级别有什么区别”；检测到对比信号时会并行查两个实体，并在 `entities` 里分别给 confidence/facets。想强制单实体用 `--no-multi`。

**为什么某个网页 fetch 返回 403？**  
目标站点（比如 npmjs.com）有 Cloudflare/反爬，会拦非浏览器请求。这是站点的策略，不是工具坏了。读 npm 元数据请用 `https://registry.npmjs.org/<pkg>`，读页面请用浏览器。

**为什么 `npm i -g aura-argus` 装到旧版本？**  
你的 npm 可能默认走 `registry.npmmirror.com`，镜像同步有延迟。用 `--registry=https://registry.npmjs.org/`，或等几分钟再装。

**Windows 上 MCP 客户端拉不起 npx？**  
配置写成 `{"command":"cmd","args":["/c","npx","-y","aura-argus","aura_argus_mcp"]}`。

**公司网络/代理下抓不到？**  
Node 内置 fetch 默认不读 `HTTP_PROXY` / `HTTPS_PROXY`。需要的话设置 `NODE_EXTRA_CA_CERTS`，或让网络层走系统代理；这不是 AuraArgus 自己的代理池。

**`--fallback` 为什么经常没结果？**
网页引擎对自动请求会跳验证码/返回 403/返回无关结果；兜底本来就是最后一道保险。当前 provider 链是 SearXNG（若配置）→ 按语言选择 Bing/360 → DuckDuckGo，并有相关性过滤和失败熔断。最稳的做法是自托管 SearXNG，或对未覆盖实体 `--site <domain>` 用官方 sitemap/正文；隐私敏感场景用 `--no-fallback` 关闭默认兜底。

---

## zip 里有什么

```
aura-argus-3.0.0/
  README.md              ← 你正在看的这份
  LICENSE                MIT
  src/                   运行时代码 + registry.json
  adapters/dsh/          可选：DSH provider 适配器
  docs/integrations/     Codex / Hermes / ZCode / Claude / Cursor / CLI / HTTP 接法
  schema/tools.json      OpenAI / Anthropic function-calling schema
  openapi.json           HTTP API 的 OpenAPI 3.1
  test/                  离线测试
  eval/                  金标准问题与评测脚本（可选）
  CHANGELOG.md
  SECURITY.md
  package.json
```

不需要 `node_modules`。验证：

```bash
npm test          # 136 个离线测试
npm run verify    # 联网检查 103 实体 / 220 源（可选）
npm run eval      # 联网跑 74 题 / 361 项硬检查（可选，需要网络）
npm run answerability # answerable / confidence / facet / p95 报告
npm run gate      # answerability + p95 发布门
npm run eval:heldout # deep index held-out 4 题门禁（需先建深索引）
npm run bench:agent # agent 基准：成功率 / 引用完整性 / 事实链接 / p95
npm run bench:pk50  # 50 题五类 PK（需要 TAVILY_API_KEY）
npm run bench:pk215 # 215 题五类覆盖评估（只跑 Aura，不调用 Tavily）
```

---

## 设计一句话

> 不做 SERP 聚合，做「实体 → 官方源 → 正文 → 选段 → 出处」的路由与证据编译。

如果某个问题没有覆盖，最有价值的动作不是换个搜索引擎，而是**给注册表加一个官方源**。

## License

MIT





