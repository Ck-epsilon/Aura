# 结果（2026-10-21）

环境：大陆直连、Clash 关闭（出口 `123.139.x`）。全部请求只到官方页；无 key、无 SERP、无代理、无按次计费。

## 评测

### 覆盖评测（31 题 / 141 项）

`npm run eval`：**141 / 141 项硬检查全部通过**（另 2 项 soft：网页兜底）。覆盖 18 个实体、中英文、别名、未知实体；总耗时 **27.8 s**（无缓存、串行），证据 77,646 字符；单题最长 2.8 s。fallback 改为 opt-in 后，soft 的 2 项默认关闭；实测 360 跳 captcha、搜狗 403，0/2 不计入发布 gate。

| 类别 | 题数 | 结果 |
|---|---|---|
| 注册实体事实（18 个实体） | 24 | 全过 |
| 别名（深度求索 / nodejs / golang / k8s / 必应） | 5 | 全过 |
| 未知实体（fallback off） | 1 | `entity:null` / `mode:none` |
| 网页兜底（soft） | 1 | opt-in；本次 0/2（360 跳 captcha、搜狗 403） |

### 对照实验（6 题，A/B/C/D）

| 方案 | 材料 | 命中 |
|---|---|---|
| A · keyless 链接 | 10 条标题 + 摘要 | 3 / 12 |
| B · keyless + 本地选段 | 逐字段落 | 4 / 12 |
| C · 官方 Search API | 官方结果 | 11 / 12 |
| **D · AuraArgus** | 官方源逐字段落 | **13 / 13** |

## 失败与重试（2026-10-21）

- `fetchRaw`：最多 3 次尝试；重试网络错误、超时、408/425/429/5xx，其余 4xx 不重试。
- 退避 300 ms 起、指数 + 抖动；尊重 `Retry-After`（上限 3 s）；总预算 `max(20 s, 2×timeout)`。
- 所有源失败：`error.code = ALL_SOURCES_FAILED` + 逐源 `attempts`（`tries` / `status`）；CLI 退出 4、HTTP 502、MCP `isError`、DSH provider 抛 `WEB_PROVIDER_ERROR`。
- 一次全失败测试（mock fetch）：2 个源各 3 次尝试，结果正确标记，耗时约 1.6 s。
- 批量 budget：MCP 35 s、HTTP 45 s；超时项标 `BATCH_BUDGET_EXCEEDED`，防止重试把一次工具调用拖过客户端 60 s 超时。

## 安全边界（2026-10-21）

- 默认拒绝 loopback / 私有网段 / link-local / 组播 / metadata；DNS 解析后复查，重定向逐跳复检。
- opt-in：CLI `--allow-private`、HTTP `serve --allow-private`、库 `allowPrivate: true`、MCP `AURA_ARGUS_ALLOW_PRIVATE=1`。
- 不绕登录/付费墙/验证码；无 key、无代理池、无遥测。
- `serve` 默认绑 `127.0.0.1`，对外暴露需 `--token`。

## 性能（`npm run bench`，30 题）

| 模式 | 总耗时 | 平均 |
|---|---|---|
| 串行（冷） | 21.62 s | 721 ms/题 |
| 批量 c=3（冷） | **6.89 s** | 230 ms/题 |
| 批量 c=3（缓存填充） | 6.05 s | 202 ms/题 |
| 批量 c=3（缓存命中） | ~1 ms | — |

冷启动批量 **3.14×**；命中结果缓存后 <10 ms。证据数量在三种模式下一致（49 条来源），说明并行/缓存没有改变结果。

并发上限 8：同一批 30 题在 **c=6 / c=8 下约 3.5 s / 2.0 s**（单独实测，仍无空结果）；默认 c=3 是礼貌值，不是性能上限。

## 注册表

`npm run verify`：**18 个实体 / 34 个源**，全部 200。

覆盖：DeepSeek、SearXNG、Tavily、Google CSE、Bing、Python、Node.js（http/fs）、GitHub（REST/Actions）、MDN、React、Vue、Rust、Go、Docker、PostgreSQL、nginx、Kubernetes、Redis。

## 测试

`npm test`：**51 / 51** 通过（解析、块合并、选段、URL 校验、注册表结构、别名、缓存 TTL/磁盘往返、批量、重试/全失败、私网拦截/重定向复检、HTTP 服务、MCP 握手/协议协商/解析错误、DSH 适配器映射）。

`npm run verify-dsh`：静态 **8/8**；`--live` **9/9**（含真检索）。DSH patch 已指向 `aura-argus` / `aura-argus-http`。

## 打包与安装（2026-10-21）

- `npm pack`：**34 files / 41.6 KB compressed / 126.6 KB unpacked**；含 `docs/integrations/`、`schema/tools.json`、`openapi.json`、`SECURITY.md`、`CHANGELOG.md`。
- tarball 安装到临时 prefix：`aura-argus version` → `0.1.0`；MCP initialize/tools-list → 4 tools + `instructions`。
- 安装目录清理后无进程/端口残留（仅按需 `serve`）。

## 跨 agent（2026-10-21）

| agent | 版本 | 接法 | 实测 |
|---|---|---|---|
| Codex CLI | 0.163.0-alpha.10.2 | `codex mcp add aura-argus -- node .../cli.mjs mcp` | `mcp_tool_call` server=`aura-argus` tool=`search`，返回 3600 s + 官方 URL |
| Hermes | 0.21.3 | `hermes mcp add aura-argus --command node --args .../cli.mjs mcp` | 4 tools discovered（首测 1937 ms；新代码复测 3656 ms，通用描述）；`hermes -z` 走 MCP，返回 3600 s + URL |
| ZCode | Electron | `~/.zcode/cli/config.json` → `mcp.servers`（stdio，`type:"stdio"`） | 配置已加；当前进程早于配置，重启后验证；CLI/skill 兜底 |

## DSH 运行态（2026-10-21 重启后）

- `dsh --profile web --dump-config` → `searchProvider: aura-argus` / `fetchProvider: aura-argus-http`
- `web_search "SearXNG 对 429 的冷却时间是多少秒？"` → 来源 `docs.searxng.org`，snippet 是 600 字符的逐字段落（含 `formats : - html`），不是普通 SERP 摘要
- `web_fetch https://docs.searxng.org/dev/search_api.html` → Markdown（`# Search API`，无导航条）
- `node eval/verify-dsh.mjs --live` → 9/9（含 MCP server 插入检查）
- MCP server 的 `initialize.instructions` 会被 `dsh-mcp-client` 注入 systemPrompt（`mcp:aura-argus`），工具描述也会作为元数据进入模型；`search_batch` 上限 20

> 注：上面的 DSH 运行态是 20:41 那次重启的结果。22:xx 之后又改了 SSRF 默认拒绝、fallback 默认 opt-in、MCP 通用工具描述；**当前 DSH 进程仍是旧代码**，下次重启才加载。Codex/Hermes 每次调用重新拉起 MCP，已用新代码复测（Codex 无异常；Hermes 3656 ms / 4 tools）。

## 发布（2026-10-21）

- npm：`aura-argus@0.1.0` 已发布；`0.1.2` 修复 repository 元数据并指向 Aura monorepo（0.1.1 被 npm staged 流程挂起，未公开）。registry `latest` 以 npm 为准；tarball `https://registry.npmjs.org/aura-argus/-/aura-argus-0.1.2.tgz`。
- GitHub：`Ck-epsilon/Aura` 已创建（public，main，"Aura source monorepo"）；源码在 `aura-argus/` 子目录（commit `aba2f5f` 起）。
- 发布用 7 天 granular token（bypass 2FA）；发布后应吊销，后续改用 trusted publishing。

## 交付形态

| 入口 | 命令 / 用法 |
|---|---|
| CLI | `aura-argus search …` / `fetch` / `sources` / `doctor` / `serve` / `mcp` |
| HTTP | `aura-argus serve --port 8787`（`/health` `/sources` `/search` `/search/batch` `/fetch`；`openapi.json`） |
| MCP stdio | `aura-argus mcp`（tools: search / search_batch / fetch / sources） |
| Node 库 | `import { search, searchBatch, fetchDocument } from 'aura-argus'` |
| DSH | `adapters/dsh/index.mjs` + profile patch（`searchProvider: aura-argus` / `fetchProvider: aura-argus-http`） |

## 这张表不能读出的四件事

1. **覆盖率是天花板。** 31 题覆盖 18 个实体；没收录的实体默认返回无证据，显式 `--fallback` 才走 360/搜狗。
2. **检查的是「事实是否出现在证据里」**，不是「agent 答得对」。C 的 QPS 错误（把 100 答成 5）说明官方索引也会选错源；证据段落 + 出处让调用方能核对。
3. **registry 是手工资产。** 价值在数据（实体 → 官方源），不在算法；维护成本和覆盖范围是后续工程。
4. **Google 走了 `.cn` 镜像。** 不是所有被墙的官方源都有镜像。

## 复跑

```bash
npm test
npm run eval
npm run verify
```
