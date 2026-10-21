# AuraArgus

**把技术问题路由到官方文档，返回可引用的原文段落。**

AuraArgus 是一个本地运行的检索工具，给 agent、脚本或你自己用。它不卖搜索 API，不需要 key，也不按次计费：你给一个问题，它找到对应的官方页面，抓回正文，挑出相关段落，连同出处 URL 一起返回。

它解决的不是“搜不到”，而是“搜到的是一堆二手摘要”。官方文档里本来就有答案，缺的是从问题到那页纸的路由。

---

## 它是什么

- **search**：问题 → 实体 → 注册的官方源 → 正文 → 选段 → 证据包
- **fetch**：一个 URL → 干净 Markdown（标题、长度、截断标记）
- 证据包里每条都带 `url`、`title`、`passages[].text`、`score`
- 零依赖，Node.js ≥ 20，Windows / macOS / Linux
- 不内置 key、不按次计费、无账号、无遥测

## 它不是什么

- 不是通用搜索引擎，也不是问答机器人；它返回**证据**，答案由调用方的模型写
- 不追求“全网覆盖”：覆盖率 = 注册表（目前 18 个实体 / 34 个官方源）
- 不做 JS 渲染、不登登录墙、不绕验证码、不做代理池
- 默认 **registry-only**：未注册的实体返回 `mode: "none"`，不会硬编一个答案
- 360/搜狗兜底是 opt-in（`--fallback`），可能被反爬，默认关闭

---

## 30 秒上手

### 从 zip 直接运行（不需要 npm install）

```bash
unzip aura-argus-0.1.2.zip
cd aura-argus-0.1.2

node src/cli.mjs search "SearXNG 对 429 的冷却时间是多少秒？" --json
```

零依赖，不需要 `npm install`。先确认 Node 版本：

```bash
node -v    # 需要 >= 20
```

### 安装成全局命令

```bash
npm i -g aura-argus
aura-argus version
aura-argus search "Node.js 怎么用 http 模块创建服务器？" --text
```

如果你的 npm 默认走镜像（比如 `registry.npmmirror.com`），刚发布的版本可能还没同步；可以显式指定：

```bash
npm i -g aura-argus --registry=https://registry.npmjs.org/
```

### 一个最小例子

```bash
aura-argus search "Tavily 一个 credit 多少钱？" --json
```

返回（截断）：

```json
{
  "schemaVersion": 1,
  "question": "Tavily 一个 credit 多少钱？",
  "entity": "tavily",
  "mode": "registry",
  "evidence": [
    {
      "url": "https://www.tavily.com/pricing",
      "title": "Pricing - Tavily",
      "passages": [{ "text": "… 1,000 credits … $0.008 per credit …", "score": 12 }]
    }
  ],
  "attempts": [{ "url": "…", "ok": true, "ms": 397, "passages": 4 }],
  "tookMs": 512,
  "cached": false
}
```

`mode` 三种值：

| mode | 含义 |
|---|---|
| `registry` | 命中注册表，抓的是官方源 |
| `web-fallback` | 只有显式 `--fallback` 才出现；360/搜狗兜底，较弱 |
| `none` | 注册表没有覆盖，或所有源都失败 |

失败时还会带 `error`：

```json
{ "error": { "code": "ALL_SOURCES_FAILED", "message": "all 2 sources failed", "attempts": 2 } }
```

CLI 退出码：`0` 有证据、`2` 无证据、`3` 参数/URL 错误、`4` 抓取失败、`130` 中断。

---

## 四种接法

### 1. CLI

```bash
aura-argus search "问题" --json          # 证据包（机器读）
aura-argus search "问题" --text          # 人眼可读
aura-argus search "问题" --max-sources 3
aura-argus fetch <url> --max-chars 4000  # 干净 Markdown
aura-argus sources                       # 注册表
aura-argus doctor                        # 源健康检查
```

批量（最多 50 题，逐题归属）：

```bash
echo '["q1","q2","q3"]' | aura-argus search --batch --concurrency 3 --json
```

默认 registry-only；要开网页兜底加 `--fallback`。默认拒绝本机/私网地址；确实要抓本地页面时加 `--allow-private`。

### 2. MCP（给 Claude Desktop / Cursor / Cline / Codex / Hermes / ZCode 等）

```bash
aura-argus mcp
```

客户端配置（以标准 stdio 为例）：

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

Windows 上如果客户端无法直接拉起 `npx`：

```json
{
  "mcpServers": {
    "aura-argus": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "aura-argus", "mcp"]
    }
  }
}
```

MCP 工具：

| 工具 | 作用 |
|---|---|
| `search` | 单题 → 证据包 |
| `search_batch` | 多题（≤20）→ 逐题结果 |
| `fetch` | URL → Markdown |
| `sources` | 注册表覆盖 |

### 3. 本地 HTTP

```bash
aura-argus serve --port 8787
```

默认只绑 `127.0.0.1`。对外暴露时加 token：

```bash
aura-argus serve --port 8787 --token my-secret
```

常用接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 版本、源数量、uptime |
| GET | `/sources` | 注册表 |
| GET | `/search?q=&maxSources=` | 证据包 |
| POST | `/search` | `{"question":"...","maxSources":3}` |
| POST | `/search/batch` | `{"questions":["..."],"concurrency":3}` |
| GET | `/fetch?url=&maxChars=` | 页面 Markdown |
| POST | `/fetch` | `{"url":"...","maxChars":20000}` |

```bash
curl -s 'http://127.0.0.1:8787/search?q=SearXNG+429' | head -c 400
```

### 4. Node 库

```js
import { search, searchBatch, fetchDocument } from 'aura-argus';

const evidence = await search('SearXNG 对 429 的冷却时间是多少秒？');
const batch = await searchBatch(['q1', 'q2'], { concurrency: 3 });
const page = await fetchDocument('https://docs.searxng.org/dev/search_api.html', { maxChars: 4000 });
```

---

## 覆盖范围

目前注册表：**18 个实体 / 34 个官方源**。

| 类别 | 实体 |
|---|---|
| LLM / 搜索 API | DeepSeek、Tavily、SearXNG、Google CSE、Bing |
| 语言与运行时 | Python、Node.js、Go、Rust、MDN（JavaScript） |
| 框架 | React、Vue |
| 基础设施 / 数据 | Docker、Kubernetes、nginx、PostgreSQL、Redis |
| 代码托管 | GitHub（REST / Actions） |

加一个源（`src/registry.json`）：

```json
"实体": {
  "aliases": ["名字", "别名"],
  "sources": [{ "url": "https://官方页", "title": "…", "covers": ["关键词"] }],
  "discovery": { "type": "sitemap", "url": "https://…/sitemap.xml" }
}
```

`covers` 只用于排序；命中实体后默认抓该实体的全部源（上限 `--max-sources`）。加完跑：

```bash
npm test
node eval/verify-registry.mjs   # 联网检查源是否可达
```

---

## 边界与安全

- **覆盖率 = 注册表**。没收录的实体默认没有证据；不要把它当通用搜索。
- **单实体路由**。一个问题命中一个实体；跨实体问题拆成多问。
- **不绕访问控制**：不登录、不绕付费墙、不破验证码、不做代理池。
- **默认拒绝私网**：loopback、RFC1918、link-local、metadata 地址、`::1`、`fc00::/7`、`fe80::/10` 等都会被拦；DNS 解析后复查，重定向逐跳复检。
- 确实要抓本机/内网页面时显式开：CLI `--allow-private`，库 `allowPrivate: true`，MCP 启动时 `AURA_ARGUS_ALLOW_PRIVATE=1`，HTTP `serve --allow-private`。
- **无 key、无遥测、无账号**。缓存只在本机（Windows `%LOCALAPPDATA%\aura-argus\cache`，macOS/Linux 在 XDG cache）。
- `serve` 默认绑 `127.0.0.1`；暴露到其他主机时务必设 `--token`。

---

## 常见问题

**为什么没有直接给我答案？**  
它给的是证据：原文段落 + 出处。答案由你的模型/脚本基于这些段落写，这样可核对、可引用。

**为什么某个网页 fetch 返回 403？**  
目标站点（比如 npmjs.com）有 Cloudflare/反爬，会拦非浏览器请求。这是站点的策略，不是工具坏了。读 npm 元数据请用 `https://registry.npmjs.org/<pkg>`，读页面请用浏览器。

**为什么 `npm i -g aura-argus` 装到旧版本？**  
你的 npm 可能默认走 `registry.npmmirror.com`，镜像同步有延迟。用 `--registry=https://registry.npmjs.org/`，或等几分钟再装。

**Windows 上 MCP 客户端拉不起 npx？**  
配置写成 `{"command":"cmd","args":["/c","npx","-y","aura-argus","mcp"]}`。

**公司网络/代理下抓不到？**  
Node 内置 fetch 默认不读 `HTTP_PROXY` / `HTTPS_PROXY`。需要的话设置 `NODE_EXTRA_CA_CERTS`，或让网络层走系统代理；这不是 AuraArgus 自己的代理池。

**`--fallback` 为什么经常没结果？**  
360/搜狗对自动请求会跳验证码/返回 403，兜底本来就不稳定，且默认关闭。优先用注册表；未覆盖的实体建议直接加源。

---

## zip 里有什么

```
aura-argus-0.1.2/
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
npm test          # 51 个离线测试
npm run verify    # 联网检查 34 个源（可选）
npm run eval      # 联网跑 31 题 / 141 项硬检查（可选，需要网络）
```

---

## 设计一句话

> 不做 SERP 聚合，做「实体 → 官方源 → 正文 → 选段 → 出处」的路由与证据编译。

如果某个问题没有覆盖，最有价值的动作不是换个搜索引擎，而是**给注册表加一个官方源**。

## License

MIT
