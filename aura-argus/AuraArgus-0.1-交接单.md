# AuraArgus · 0.1 交接单

> **一句话**：把「网页搜索/取回」做成一件事——无 key、无账号、无按次计费、不绑 agent、不绑操作系统，按当前网络可达性自动选路。
>
> **这份文档的用途**：在新工作目录里从零起仓时，不需要回读上一轮会话。第 2 节是可直接搬的资产，第 5–7 节是契约与坑，第 9–10 节是排期与验收。
>
> 生成时间：2026-10-20（本机实测数据均为此日期）
> 交接方：上一轮会话（DSH web profile 内完成原型与验证）

---

## 0. 先读这段

三条硬约束，后面所有设计都由它们推出：

1. **与 agent 无关**——核心不 import `@deepseek-ai/*`、不依赖 Cordis、不假设调用方是 LLM。DSH 只是众多适配器之一。
2. **与操作系统无关**——核心不出现 Windows 路径、PowerShell、注册表；配置文件用 XDG/`%APPDATA%` 抽象，或显式 `--state-dir`。
3. **网络环境是变量，不是前提**——「有代理」是加速项，「没代理」是默认场景。任何一层全灭，必须还有另一层可用。

现状一句话：原型是 `~/.dsh/plugins/aura-search`（DSH 插件形态），核心解析与编排已经跑通并验证；拆出去主要是**换壳 + 补网络分层**，不是重写。

---

## 1. 目标与非目标

**目标**

- G1 一条命令可用：`argus search "查询" --json`，无 key、无配置。
- G2 一份 HTTP 服务：`argus serve`，任何语言/任何 agent 都能 `GET /search`。
- G3 网络自适应：启动探测 + 健康缓存 + 每查询按可达性排序；代理存在就用，不存在不报错。
- G4 三引擎起步（DuckDuckGo / Bing RSS / Baidu），可插拔；引擎失败自动回退、冷却、限速。
- G5 结果可引用：URL 必须是直链（DDG 跳转、Baidu `/link?` 都要解开），带标题/摘要/时间。

**非目标（本期明确不做）**

- N1 不做翻墙/代理池/绕过审查——只复用用户已有的 `HTTPS_PROXY`，没有就退化到国内层。
- N2 不做爬虫框架、不批量抓站、不绕付费墙/登录墙。
- N3 不做生成式摘要（`content` 字段留空），只给结构化来源；要答案让调用方自己的模型去写。
- N4 不做多语言全文检索/向量库。
- N5 不内置任何 API key，也不做 key 托管。

---

## 2. 已验证的可复用资产

源目录：`C:\Users\cxk\.dsh\plugins\aura-search\`

| 文件 | 行数 | 状态 | 处理 |
|---|---:|---|---|
| `lib/html.js` | 123 | 零依赖，实体解码 / 去标签 / URL 归一 | **原样搬** |
| `lib/engines.js` | 336 | 零依赖，三引擎的 `prepare/parse/resolve` | **搬入 core**，删掉死代码 |
| `lib/index.js` | 346 | 编排（缓存/限速/冷却/排序）+ Cordis 注册，混在一起 | **拆分**：编排进 core，注册进 adapter |
| `test/parse.test.mjs` | 96 | 242 项断言，离线 fixture | 搬，改 `node:test` |
| `test/live.test.mjs` | 43 | 联网冒烟：中英查询 + 取消 + 缓存键 | 搬，补 probe/CLI 用例 |
| `test/fixtures/ddg-lite-{zh,en}.html` | 667 ×2 | 有效 | 搬 |
| `test/fixtures/bing-rss.xml` | 1（5 KB） | 有效 | 搬 |
| `test/fixtures/baidu-zh.html` | 9 164（1.0 MB） | 有效 | 搬，可裁剪 |
| `test/fixtures/bing-{zh,en}.html` | 123 / 116 | **死资源**：Bing 已改 RSS，测试不再引用 | **删** |

已验证证据（2026-10-20）：

- `node test/parse.test.mjs` → `242 checks passed`
- `node test/live.test.mjs` → 中文 6 条 / 英文 6 条，1.1–2.4 s；取消路径拒绝；缓存键按 `maxResults` 区分
- 真实 harness boot（headless + 同一份配置）→ `engine duckduckgo status 200 results 8`（中英各 4 条合并），最终 `N=8 FIRST=https://www.futunn.com/stock/NVDA-US/earnings`
- 配置层证据：`dsh --profile web --dump-config` 显示 `searchProvider: aura-keyless` / `fetchProvider: http`

---

## 3. 为什么必须拆出 DSH

`lib/index.js` 现在做两件事：**搜索编排**（与框架无关）和 **`ctx.web.registerSearchProvider()`**（DSH 专属）。前者是产品，后者是入口。

具体耦合只有三处：

1. 注册：`apply(ctx, config)` + `inject: ['web']`。
2. 错误：抛出的 Error 带 `code = 'WEB_PROVIDER_ERROR'`，靠 DSH 的 `HarnessError` 语义透出。
3. 配置：profile patch 里的 YAML 段。

拆法：编排抽成 `core/search.js`（纯函数 + 类，无全局单例），错误改成自有 `ArgusError`（带 `code`），DSH 侧写一个 ≤80 行的 adapter 做「注册 + 错误码映射 + 配置转换」。

> 结论：拆的是壳，不是逻辑。`html.js` / `engines.js` 一行都不用改。

---

## 4. 目标形态

```
aura-argus/
  package.json            # type: module, bin: argus, exports: ./core
  src/
    core/
      html.js             # 搬
      engines/
        index.js          # 注册表 + 排序 + 冷却
        duckduckgo.js     # prepare(vqd) + parse
        bing.js           # RSS parse
        baidu.js          # parse + resolve(redirect manual)
      search.js           # 编排：缓存 / gate / cooldown / attempts
      fetch.js            # 本地 HTTP 取回 + HTML→text（可选 readability）
      probe.js            # 可达性探测 + 健康缓存
      errors.js           # ArgusError + 错误码
    cli/
      main.js             # search / fetch / probe / serve / engines
    server/
      http.js             # /health /search /fetch /engines
  test/
    parse.test.mjs
    live.test.mjs
    fixtures/
  adapters/
    dsh/index.js          # 薄适配器（可选装）
    mcp/index.js          # 可选
  README.md
  AGENTS.md               # 建议从 ~/aura-lite 复制规范
```

**三个入口，一个核心**：

| 入口 | 用途 | 依赖 |
|---|---|---|
| `argus` CLI | 人/脚本直接用 | Node ≥20（若选单二进制则无） |
| `argus serve` | 本地 HTTP，给任意 agent | 同上 |
| `adapters/dsh` | DSH 插件形态 | `@deepseek-ai/*`（仅此目录） |

---

## 5. 契约

### 5.1 core 类型

```ts
interface SearchRequest { query: string; limit?: number; engines?: string[]; signal?: AbortSignal; cache?: boolean }
interface Source { url: string; title?: string; snippet?: string; publishedAt?: string; engine: string; rank: number }
interface Attempt { engine: string; status: number | 'timeout' | 'error'; results: number; ms: number; error?: string }
interface SearchResult {
  schemaVersion: 1
  query: string; engine: string; sources: Source[]
  truncated: boolean; tookMs: number; cached: boolean; attempts: Attempt[]
}
interface Engine {
  id: string; label: string; layer: 'direct-cn' | 'direct-global' | 'proxied'
  buildUrl?(q: string): string                 // 静态 URL 的引擎用
  prepare?(q: string, ctx): Promise<Request>   // 需要 token 的引擎用（DDG）
  parse(body: string, limit: number): RawHit[]
  resolve?(hits: RawHit[], ctx): Promise<RawHit[]>  // 需要解跳转的引擎用（Baidu）
}
```

### 5.2 CLI

```
argus search <query...> [--limit 8] [--engine ddg,bing] [--json] [--no-cache] [--explain] [--offline]
argus fetch <url> [--json] [--max-chars 20000]
argus probe [--json]            # 每个引擎：可达性 / 层 / 延迟
argus engines                   # 列表 + 当前健康
argus serve [--port 8787] [--host 127.0.0.1] [--token <t>]
```

### 5.3 HTTP

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, version, engines:[{id, layer, reachable, lastCheck}]}` |
| GET | `/search?q=&limit=&engines=&cache=` | 返回 `SearchResult` |
| POST | `/fetch` `{url}` | `{url, status, title, text, truncated}` |
| GET | `/engines` | 引擎与层信息 |

默认只绑 `127.0.0.1`；`--token` 时要求 `Authorization: Bearer`。无遥测、无出站外呼（除引擎本身）。

### 5.4 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功（含「查询成功但 0 结果」时用 0 + `sources: []`，便于脚本） |
| 2 | 所有引擎失败 |
| 3 | 参数错误 |
| 4 | 探测/网络层不可用（`probe` 全灭） |
| 130 | 被 SIGINT 取消 |

### 5.5 错误码（`ArgusError.code`）

`ALL_ENGINES_FAILED` / `ENGINE_TIMEOUT` / `ENGINE_HTTP_<status>` / `ENGINE_COOLDOWN` / `PARSE_EMPTY` / `BAD_URL` / `FETCH_TOO_LARGE` / `UNSUPPORTED_SCHEME`。

---

## 6. 网络模型

**层**（每个引擎静态标注，可被探测结果覆盖）：

| 层 | 含义 | 例子 |
|---|---|---|
| `direct-cn` | 大陆直连可用 | Baidu、360、Sogou、Bing CN |
| `direct-global` | 无代理也可能可用（视运营商） | Bing、DuckDuckGo |
| `proxied` | 仅在有代理时尝试 | DDG / Brave 的代理路径 |

**探测**（`argus probe` / 启动时）：

1. 每引擎发一次轻量请求（`HEAD` 或 1 字节 `GET`），4 s 超时，失败重试 1 次。
2. 判定：`2xx/3xx → reachable`；`202/403/429 → challenged`；超时/TLS 错误 → `unreachable`。
3. 结果写健康缓存（默认 `~/.cache/argus/health.json`，Windows 用 `%LOCALAPPDATA%\argus\health.json`；可用 `--state-dir` 覆盖），TTL 10 min。
4. **代理只影响 `proxied` 层**：检测到 `HTTPS_PROXY`/`HTTP_PROXY` 才启用；没有就跳过，不报错。

**排序**：`reachable` 且 `direct` 优先 → `proxied` → `challenged`（跳过）→ `unreachable`（跳过）。同层按实测延迟升序。

**冷却**：某引擎返回 202/403/429 或解析为空 → 冷却 10 min（与现有实现一致），期间直接跳过，不浪费一次超时。

**限速**：同引擎请求串行 + 最小间隔 700 ms（可配）。多查询并发时按引擎排队。

---

## 7. 引擎矩阵与已知坑（本机实测 2026-10-20）

| id | 层 | 端点 | 实测 | 坑 |
|---|---|---|---|---|
| `duckduckgo` | direct-global | `duckduckgo.com/?q=` → `lite.duckduckgo.com/lite/?q=&vqd=` | 不带 vqd：**202 挑战页**；带 vqd+cookie：200，10 条 | 必须先取 `vqd`（三种正则兜底），并回传首页 `Set-Cookie` + `Referer`；质量最好，中英文都准 |
| `bing` | direct-global / cn | `www.bing.com/search?q=&format=rss&count=10` | 200，5 KB，10 条，带 `pubDate` | RSS 比 HTML 稳；但排名有时偏官网首页（"nvidia earnings date" 全是 nvidia.com） |
| `baidu` | direct-cn | `www.baidu.com/s?wd=&rn=10&ie=utf-8` | 200，1 MB，9 条 | 链接是 `www.baidu.com/link?url=` token；用 `redirect:'manual'` 读 `Location`（实测单条 226 ms），**不要**跟随下载目标页；过滤 `chat./ai./www.baidu.com/s` 内部链接 |
| `360` | direct-cn | `www.so.com/s?q=` | 200，382 KB，11 个 `res-list` | 常混入 `ai.so.com/search/...` 内部 AI 页与 `/link?` 跳转；需解析 + 过滤 + 解跳转；**解析器未写**（M3） |
| `sogou` | direct-cn | `www.sogou.com/web?query=` | 200 但仅 5.4 KB 壳 | 目前不可用，M3 判定 |
| `brave` | proxied | `search.brave.com/search?q=` | 一次 200，随后 429 | 不可作为 keyless 主引擎 |
| `mojeek` / `ecosia` / `searx.be` | — | — | 200 挑战页 / 403 / 挑战页 | 不可用 |
| `qwant` | — | `api.qwant.com/v3/search/web` | 403 `error_code:50` | 需要网页端 token，不可用 |
| `startpage` | — | `startpage.com/sp/search` | 200 但 HTML 里无结果（JS 渲染） | 不可用 |

> 结论：keyless 可用的就 **DDG + Bing + Baidu**；360 是唯一值得再投入的国内增量，Sogou 先判死。

---

## 8. 迁移清单

```powershell
# 在新目录里执行（源路径固定，目标按你的新仓路径改）
$src = "C:\Users\cxk\.dsh\plugins\aura-search"
New-Item -ItemType Directory -Force .\src\core, .\test\fixtures | Out-Null
Copy-Item "$src\lib\html.js"            .\src\core\html.js
Copy-Item "$src\lib\engines.js"         .\src\core\engines\index.js
Copy-Item "$src\test\parse.test.mjs"    .\test\
Copy-Item "$src\test\live.test.mjs"     .\test\
Copy-Item "$src\test\fixtures\ddg-lite-zh.html" .\test\fixtures\
Copy-Item "$src\test\fixtures\ddg-lite-en.html" .\test\fixtures\
Copy-Item "$src\test\fixtures\bing-rss.xml"     .\test\fixtures\
Copy-Item "$src\test\fixtures\baidu-zh.html"    .\test\fixtures\
```

然后：

1. `engines/index.js` 里把三个引擎拆成三个文件（`duckduckgo.js` / `bing.js` / `baidu.js`），注册表保留。
2. 从 `lib/index.js` 抄出 `orderFor / gated / fetchSerp / cacheGet / cacheSet / isCooling / coolDown` 到 `core/search.js`，把 `apply(ctx)` 去掉，改成 `export function search(request)`。
3. `lib/index.js` 的 `apply` 部分改写成 `adapters/dsh/index.js`（≈40 行：注册 + 错误码映射）。
4. 删掉 `bing-zh.html` / `bing-en.html` 两个死 fixture。
5. 把 `lib/index.js` 顶部注释里的「为什么」搬进 README，别丢。

**不要搬**：`package.json`（新写）、`README.md`（重写为公开项目说明）、profile patch（那是使用者侧配置）。

---

## 9. 里程碑与完成判据

| 里程碑 | 内容 | 完成判据 | 估时 |
|---|---|---|---|
| M0 抽取 | core 四件套 + 测试绿 | `node test/parse.test.mjs` 全绿；`argus search "deepseek v4"` 出 JSON | 半天 |
| M1 CLI + probe | 分层探测、健康缓存、`--explain` | `argus probe --json` 给出每引擎层与延迟；断网时 exit 4 | 1 天 |
| M2 serve | HTTP 四个端点 | `curl 'localhost:8787/search?q=test'` 返回 `schemaVersion:1` | 半天 |
| M3 引擎补齐 | 360 解析；Sogou 判定；Bing CN 变体 | 中文查询在「只有 direct-cn」时 ≥3 条直链 | 1–2 天 |
| M4 适配器 + 发布 | DSH adapter、README、0.1.0 | DSH headless 回归通过；`npm pack` 内容干净 | 半天 |

---

## 10. 验收标准

必须同时满足（可脚本化）：

1. **happy（中）**：`argus search "英伟达 财报 日期" --json` → `sources ≥ 3`，全部 `http(s)`，且不含 `baidu.com/link?`。
2. **happy（英）**：`argus search "nvidia earnings date 2026" --json` → 同上。
3. **negative（全灭）**：`argus search "x" --offline`（M1 必须实现的测试开关：所有引擎视为不可达）→ exit 2，JSON 含 `error.code = ALL_ENGINES_FAILED` 与 `attempts`。
4. **boundary（缓存）**：同一 query 连续两次，第二次 `cached:true` 且 `< 50 ms`；`--limit` 不同不得命中同一缓存项。
5. **boundary（取消）**：查询中 Ctrl+C → exit 130，无残留 socket（`--timeout` 生效）。
6. **无计费回归**：任何模式下不出现对 `api.deepseek.com` 的请求（`--explain` 日志 + `grep` 断言）。
7. **核心零依赖**：`npm ls --omit=dev` 为空；core 可在无网络单测下运行。
8. **DSH 回归**：adapter 接入后，headless boot 仍返回 8 条来源（命令见 §14）。

---

## 11. 风险与未知

| 风险 | 影响 | 缓解 |
|---|---|---|
| 抓取结构漂移 | 引擎解析突然 0 结果 | 每个引擎单独 fixture 测试；失败自动回退；`probe` 可诊断 |
| 反爬（202/429/验证码） | 某个引擎短期不可用 | 冷却 + 分层 + 回退；不做对抗性绕过 |
| ToS | 公开分发有合规争议 | README 明示「网页抓取，非授权 API」；限速；个人/低频率定位 |
| 国内索引质量 | 中文结果不如 DDG | 360/Baidu 兜底；把「引擎可插拔」写进 README，方便接有 key 的 provider |
| 无代理用户环境差异 | 层判定误判 | 探测 + TTL；探测失败不缓存为永久不可达 |
| 单二进制 vs Node | 分发形态未定 | 见 §13 第 1 题，先做 Node 版，解析层与运行时无关 |

---

## 12. 边界与停止条件

- 预算：M0–M4 合计 ≤ 4 个工作日；超时先交 M0–M2（可用 CLI+HTTP），引擎补齐延后。
- 同一引擎连续 3 次解析失败 → 停，写根因（fixture 对比），换引擎优先级，不在同一层硬试。
- 若 360 解析 1 天内无法稳定 → 放弃 360，只留 3 引擎发布 0.1.0。
- 若 DDG 在本机持续挑战 → `direct-global` 层降级为 Bing，不阻塞发布（现有实现已如此）。
- 不做：代理池、验证码破解、批量抓站、任何形式的 key 收集。

---

## 13. 待拍板的 5 个问题

1. **运行时**：Node ≥20（复用 90% 代码，最快）还是 Go/Rust 单二进制（分发好，解析要重写）？建议先 Node 出 0.1，解析层保持纯函数以便将来移植。
2. **发行形态**：只发 npm，还是同时出 `pkg`/`bun build --compile` 单文件？
3. **fetch 的深度**：只回 HTML→text，还是要 readability 正文提取（多一个依赖）？
4. **要不要 MCP server**：`adapters/mcp` 能让任何 MCP 客户端直接用，成本约半天。
5. **License 与 scope**：MIT？npm 包名 `aura-argus`（已确认空闲），二进制 `argus`（注意与 npm 上已有的 `argus` 参数解析器重名，全局安装会冲突，必要时用 `aura-argus` 作 bin）。

---

## 14. 证据指针

| 证据 | 位置 / 命令 |
|---|---|
| 计费事实 | https://api-docs.deepseek.com/quick_start/pricing（2026-10-20 抓取：$0.75/1000 次，2026-11-01 00:00 起） |
| 原型源码 | `C:\Users\cxk\.dsh\plugins\aura-search\` |
| 解析测试 | `node test/parse.test.mjs` → `242 checks passed` |
| 联网冒烟 | `node test/live.test.mjs` → 中英各 6 条 |
| harness 集成 | `dsh --profile headless --patch <overlay.yml> --json "…"`，日志 `engine duckduckgo status 200 results 8` |
| 配置证据 | `dsh --profile web --dump-config` → `searchProvider: aura-keyless` |
| DSH 侧接入 | `C:\Users\cxk\.dsh\profiles\web\cordis.patch.yml` 里 `web-search-aura` + `web` 两段 |

> harness 集成需要模型 key（`DEEPSEEK_API_KEY`）。上一轮从 `~/.dsh/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY` 取出注入环境变量，**不要把 key 写进任何文件或日志**。
