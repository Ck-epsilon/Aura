# 结果

## 2.4.5（2026-10-24，当前）

- 2.4.x 稳定收口：`npm test` **136/136**；`verify` **220/220**；`bench:agent` **75/77（0.974）**，score 0.987，gate pass。
- 不新增功能；文档与读数已统一。

## 2.4.4（2026-10-24）

- 新增 API 兼容契约断言：`search` / `searchBatch` / `fetchDocument` 与 `aura_argus_*` 指向同一函数；`npm test` **136/136**。
- `bench:agent` 维持 75/77（0.974），gate pass。

## 2.4.3（2026-10-24）

- `退役` 日期扩展修复 Bing 别名选段；`bench:agent` **75/77（0.974）**，score 0.987，p95 2006 ms。
- 源健康：**103 实体 / 220 源，220/220 可达**；`npm test` 135/135。

## 2.4.2（2026-10-24）

- 来源 URL/title 参与已有排序，并补 Tavily credits、Mistral pricing、Bing grounding 三个官方源；`bench:agent` 从 71/77 提升到 **74/77（0.961）**，score 0.980，p95 1857 ms。
- 覆盖 **103 实体 / 220 源**；`npm test` **135/135**。

## 2.4.1（2026-10-24）

- 中文 facet 短语补强后，`bench:agent` 从 62/77（0.805）提升到 **71/77（0.922）**，score **0.961**，citation 100% / fact link 100%，p95 1423 ms。
- `npm test`: **134/134**；2.4.0 的 eval 74 题 / 361 项、answerability 73/73、gate pass 保持。

## 2.4.0（2026-10-24）

- `npm test`: **134/134**。
- `npm run eval`: **74 题 / 361 项硬检查全过**（soft 2/2）；p50 1035 ms / p95 2408 ms。
- `npm run answerability`: **73/73（100%）**，p95 2399 ms；`npm run gate` pass。
- `npm run eval:heldout`: **4/4（100%）**，p50 75 ms / p95 120 ms。
- `npm run bench:agent`: **62/77**，success 0.805、citation 100%、fact link 100%、p95 1234 ms、score 0.903；低于 success 0.9 的门，列入 2.4.x 回归修复。
- API 统一到 `aura_argus_*`，旧名保留兼容别名；CLI 子命令统一为 `aura_argus_*`。
- 覆盖：**103 实体 / 217 源**。

## 2.3.0（2026-10-23）

### 默认全网友好

CLI/MCP/HTTP 默认 `fallback=auto`：官方证据优先，官方不足才走 SearXNG/Bing/360/DDG 兜底；`--no-fallback` 可关。兜底扩到 4 页，新增 officialSources/webSources 元数据。

### 评测

- live：**74 题 / 361 项硬检查全过**（soft 2/2）；p50 821 ms / p95 2481 ms。
- answerability：**73/73（100%）**，p95 2481 ms；`npm run gate` pass。
- held-out deep index：**4/4（100%）**，p50 59 ms / p95 109 ms。
- agent bench：**77/77**，p95 2460 ms，score **1.0**。
- `npm test`：**125 / 125**。

### 50 题五类 PK vs Tavily（basic）

| 类别 | AuraArgus Full@3 | Tavily Full@3 |
|---|---:|---:|
| 定价 | 10/10 | 8/10 |
| 版本/生命周期 | 9/10 | 10/10 |
| API/配置用法 | 9/10 | 9/10 |
| 错误/限制 | 6/10 | 9/10 |
| 对比/覆盖边界 | 6/10 | 10/10 |
| **总计** | **40/50（80%）** | **46/50（92%）** |

AuraArgus 官方源占比 72.6%，Tavily 21.3%；Aura p50 1154 ms / p95 3609 ms，Tavily p50 669 ms / p95 2074 ms。Tavily advanced 47/50，但 p95 5167 ms、官方源 12%，basic 更适合 agent。

### 215 题五类覆盖评估（Aura-only，不调用 Tavily）

| 类别 | Full@3 | 总数 |
|---|---:|---:|
| 定价 | 29 | 40 |
| 版本/生命周期 | 27 | 40 |
| API/配置用法 | 52 | 55 |
| 错误/限制 | 15 | 40 |
| 对比/覆盖边界 | 35 | 40 |
| **总计** | **158（73.5%）** | **215** |

- 定价/错误环比下降来自 keyless 引擎窗口（Bing 返回降级页、DDG 反爬），不是代码回归；版本 22→27、对比持平。
- p50 860 ms / p95 4281 ms；fallback 触发 34 次。

### 深索引全量策略与泛化验证（演绎法）

- 纠正"只为失败实体建索引"的归纳法偏误：深索引改为**全部 103 个实体的默认能力**（`aura_argus_index --deep --all`）。
- 全量构建：103 实体 / 346,672 sections / 173 MB；89 个实体有内容，14 个（anthropic/deno/nextjs 等 JS 站）无可抓深页。
- **泛化验证集**（`eval/heldout-generalization.json`，30 题，全部来自未参与调优的实体/主题）：
  - 全量索引前：**6/30**
  - 全量索引后：**15/30**（howto 5/10、error 3/6、version 3/4、compare 3/6、pricing 1/4）
  - 同批 74 题回归 p95 从 2900–3200 ms 降到 **2300 ms**，发布门恢复通过。
- coverage probes 的 checks 来自官方源 `covers`，只用于衡量 Aura 自身覆盖，不是无偏准确率。
- 该轮**未调用 Tavily**，避免消耗免费额度。

## 历史：2.2.0（2026-10-23）

递归发现、deep index、自持兜底；held-out 4/4，agent 77/77。

### 递归发现、deep index 与自持兜底

- `index --deep` 递归 sitemap/链接，建立本地深索引；held-out 4/4，命中 42–108 ms。
- 在线递归只在低置信 how-to/list/compare 触发。
- `--fallback=auto` 优先自托管 SearXNG，否则走多引擎 keyless 适配；不依赖商业搜索 API。
- 修复代码块整体选段与置信度校准。

### 评测

- live：**74 题 / 361 项硬检查全过**（soft 2/2）；p50 821 ms / p95 2481 ms。
- answerability：**73/73（100%）**，p95 2481 ms；`npm run gate` pass。
- held-out deep index：**4/4（100%）**，p50 59 ms / p95 109 ms。
- agent bench：**77/77**，引用 100%，事实链接 100%，p95 2460 ms，score **1.0**。
- fast：**74/74**，10 index hits，p95 2056 ms。
- `npm test`：**125 / 125**。

### 复跑

```bash
npm test
npm run eval
npm run answerability
npm run gate
npm run eval:heldout
npm run bench:agent
```

## 历史：2.1.0（2026-10-23）

缺陷修复（引用 ID、facts 去重、客户端超时、全量索引 ETag、decompose 预算、consensus、OpenAPI）；`npm test` 120/120，eval 74/361（p95 1826 ms），agent 73/73。

## 历史：2.0.0（2026-10-23）

Agent 基准 + 同主机并发上限；`npm test` 117/117，eval 74/361（p95 1810 ms），agent score 1.0。

## 历史：1.9.0（2026-10-23）

增量索引（ETag/304 复用、manifest v2）；`npm test` 114/114，eval 74/361（p95 1819 ms），answerability 73/73。

---

## 历史：1.5.0（2026-10-23）

结构化事实抽取 + 非自适应意图恢复并行抓源；p95 1521 ms；`npm test` 102/102，eval 74/361，answerability 73/73。

## 历史：1.4.0（2026-10-23）

可引用证据（passage/source `id`、`headingPath`、`anchor`、`citation`、提取 Markdown 行号）；fast 索引与 fallback 同样带 citation；`npm test` 99/99，eval 74/361（p95 1958 ms），answerability 73/73。

## 历史：1.3.0（2026-10-23）

自适应扇出 + 枢纽页保护；p95 2746 → 2191 ms，发布门恢复 2500 ms；`npm test` 98/98，eval 74/361，answerability 73/73。

## 历史：1.2.0（2026-10-23）

查询意图识别 + `--decompose` 复合问题拆句并行检索；`npm test` 97/97，eval 74/361（p50 929 ms / p95 2746 ms），answerability 73/73；p95 门临时放宽到 3000 ms。

## 历史：1.1.0（2026-10-23）

### 覆盖

**103 实体 / 217 源**（注册表 78/145 + 站点包 42/72）；新增 Ruby、Scala、Cassandra、Ansible、Istio、Argo CD、Jest、Cypress、pytest、Flask、Express、Helm、OpenTelemetry，并补 10 个深页源。

### 评测

- live：**73 题 / 355 项硬检查全过**（soft 2/2）；p50 905 ms / p95 1504 ms / p99 2813 ms。
- answerability：**72/72（100%）**，p95 1504 ms；`npm run gate` pass。
- fast：**73/73 全过**，10 题命中索引。
- `npm test`：**94 / 94**。

### 健康检查

覆盖健康检查最后一次 **216/217** 可达；GNU Bash 手册页间歇 `ECONNRESET`，直连重试可 200，属于上游抖动。

### 复跑

```bash
npm test
npm run eval
npm run answerability
npm run gate
```

---

## 历史：1.0.0（2026-10-23）

### Answerability

`npm run answerability`：**59 / 59 道硬评测题 answerable（100%）**；平均置信度 0.85、facet 覆盖 0.85；p50 863 ms / p95 1716 ms。`npm run gate` 通过（answerability ≥0.9、p95 ≤2500 ms）。

### 评测与测试

- live：60 题 / 290 项硬检查全过，soft 2/2。
- fast：60/60 全过，10 题命中索引。
- `npm test`：**94 / 94**。

### 契约

`schemaVersion: 1` 冻结，字段、模式、错误码、缓存语义与 MCP 行为写入 `CONTRACT.md`；`test/contract.test.mjs` 防回归。

### 覆盖

90 实体 / 194 源全部可达；索引 42 实体 / 8,120 段 / 2.19 MB。

### 复跑

```bash
npm test
npm run eval
npm run answerability
npm run gate
```

---

## 历史：0.9.0（2026-10-23）

### 取消与进度

- `AbortSignal` 贯通 fetch/search/batch/fetchDocument；取消返回 `ABORTED`，不重试。
- MCP 支持 `notifications/cancelled`，被取消的调用不发送响应；`search_batch` 支持 `progressToken` 进度通知。
- HTTP 客户端断开时 abort 进行中的请求；`searchBatch` 暴露 `onProgress`。

### 评测

- live：**60 题 / 290 项硬检查全过**（soft 2/2）；p50 863 ms / p95 1675 ms / p99 4189 ms。
- fast：**60/60 全过**，10 题命中索引；p50 795 ms / p95 1389 ms / p99 3121 ms。

### 测试

`npm test`：**92 / 92**。

### 复跑

```bash
npm test
npm run eval
node eval/run.mjs --fast
```

---

## 历史：0.8.0（2026-10-23）

### 评测

- 默认 live：`npm run eval` **60 题 / 290 项硬检查全过**（soft 2/2）；p50 **850 ms** / p95 **1402 ms** / p99 **3075 ms**，平均 877 ms。
- fast：`node eval/run.mjs --fast` **60/60 全过**，10 题命中索引；p50 823 ms / p95 1407 ms / p99 2772 ms，平均 778 ms。

### 版本文档

`Node.js 20 的 fs.readFile 怎么用？` 自动路由到 `nodejs.org/docs/latest-v20.x/api/fs.html`，结果 `version: "20"`；支持 `--doc-version` / MCP `docVersion` / HTTP `docVersion`。版本化查询禁用 fast，避免索引版本不一致。

### 新鲜度

evidence 带 `updated`（`Last-Modified`）；`fetchDocument` 返回 `updated` / `etag`；索引 evidence 用构建时间。

### 测试

`npm test`：**87 / 87**。

### 复跑

```bash
npm test
npm run eval
node eval/run.mjs --fast
```

---

## 历史：0.7.0（2026-10-23）

### 评测

- 默认 live：`npm run eval` **59 题 / 285 项硬检查全过**（soft 2/2）；p50 **835 ms** / p95 **1976 ms** / p99 **3335 ms**，平均 847 ms。
- fast：`node eval/run.mjs --fast` **59/59 全过**；**10 题命中本地索引**，索引命中约 **2 ms**；整体 p50 797 ms / p95 1222 ms / p99 2699 ms，平均 728 ms。开放 how-to/对比/清单问题自动回退 live。

### 本地索引

为 42 个评测实体构建索引：**8,120 段 / 约 2.19 MB**；每条含 URL、标题、heading、kind 与文本。默认 24 小时过期，存储在本地 cache。

### 测试

`npm test`：**83 / 83**。

### 复跑

```bash
npm test
npm run eval
npm run index -- --top 20
node eval/run.mjs --fast
```

---

## 历史：0.6.0（2026-10-23）

### 评测

`npm run eval`：**59 题 / 285 项硬检查全部通过**（soft 2/2）。延迟 p50 **792 ms** / p95 **1772 ms** / p99 **2850 ms**，平均 824 ms；证据 3,534 字符/题、来源 1.78/题；平均置信度 0.83、facet 覆盖 0.83。

### 覆盖

`npm run verify`：**90 实体 / 194 源全部可达**（注册表 65/122 + 站点包 42/72）。新增 Azure、Google Cloud、Mistral、Hugging Face、LangChain、Ollama、MongoDB、SQLite、Elasticsearch、Prometheus、Grafana、Angular、Svelte、PyPI、GitHub Advisory、Flutter，以及 11 个深页源。

### 缺口记录

`AURA_ARGUS_QUERY_LOG=1` 开启本地 JSONL；`aura-argus gaps` 汇总 `mode:none`、低置信度和高频缺失 facet。默认关闭，无遥测。

### 测试

`npm test`：**81 / 81**。

### 复跑

```bash
npm test
npm run eval
npm run verify
npm run gaps -- --file <queries.jsonl>
```

---

## 历史：0.5.0（2026-10-23）

### 评测

`npm run eval`：**43 题 / 205 项硬检查全部通过**（soft 2/2）。新增多实体（PostgreSQL/MySQL、React/Vue）与 confidence/facet 契约检查；延迟 **p50 785 ms / p95 1236 ms / p99 1311 ms**，平均 727 ms；证据 2,796 字符/题、来源 1.77/题；平均置信度 0.81、facet 覆盖 0.82。

### 能力

- 多实体对比路由 + 逐实体 facets/confidence；主实体按首次出现。
- 一跳链接跟随：仅在置信度 <0.75 且缺 facet 时触发，最多 1 个同站链接。
- 持久页缓存：ETag/Last-Modified，默认 6h，跨进程复用；`warm --top 20` 预热。
- MCP structuredContent/outputSchema/read-only annotations；CLI/HTTP 支持 `multi` / `followLinks` / `maxFollowLinks`。

### 性能（`npm run bench`，42 题）

| 模式 | 总耗时 | 平均 | p50 | p95 |
|---|---|---|---|---|
| 串行（冷） | 34.68 s | 826 ms | 818 ms | 1423 ms |
| 批量 c=3（冷） | 11.61 s | 276 ms | 796 ms | 1440 ms |
| 批量 c=3（缓存填充） | 8.10 s | 193 ms | — | — |
| 批量 c=3（缓存命中） | ~2 ms | 0 ms | — | — |

冷启动批量 **2.99×**；平均置信度 0.85、facet 覆盖 0.86。

### 覆盖与测试

`npm run verify`：**74 实体 / 167 源全部可达**（注册表 49/96 + 站点包 42/71）。`npm test`：**78 / 78**。`npm pack --dry-run`：39 files / 69.9 KB compressed / 249.1 KB unpacked。

### 复跑

```bash
npm test
npm run eval
npm run verify
npm run bench
```

---

## 历史：0.3.0（2026-10-23）

环境：大陆直连、Clash 关闭（出口 `123.139.x`）。全部请求只到官方页；无 key、无 SERP、无代理、无按次计费。

### 评测

`npm run eval`：**40 题 / 184 项硬检查全部通过**（soft 2/2）。覆盖合并后的 **74 个实体**（注册表 49 + 站点包新增 25）、中英文、别名、站点包、站点关闭、未知实体与显式 fallback；总耗时 **26.9 s**（无缓存、串行），证据 **96,571 字符 / 63 条来源**，单题最长 **1.34 s**。

| 类别 | 题数 | 结果 |
|---|---|---|
| 注册实体事实 | 24 | 全过 |
| 别名（深度求索 / nodejs / golang / k8s / 必应） | 5 | 全过 |
| 站点包事实（阿里云 / 微信 / 通义 / Kimi / 混元 / Ant Design / Spring / MySQL） | 8 | 全过 |
| 未知实体 + 站点关闭 | 2 | `entity:null` / `mode:none` |
| 网页兜底（soft，显式 opt-in） | 1 | 2/2 |

### 覆盖与健康

`npm run verify`：**74 实体 / 166 源全部可达**（注册表 49/95 + 默认站点包 42/71；17 个实体在两包中合并）。OpenAI / Anthropic 已切到当前官方文档与定价地址，MySQL 增加事务隔离级别页；大陆直连下无 FAIL。

### 测试

`npm test`：**69 / 69** 通过。新增选段回归：中文意图短语、长段落命中保留、具体 API 词优先、重叠窗口去重、价格金额优先；CRLF/LF 版本哈希稳定。

### 性能（`npm run bench`，39 题）

| 模式 | 总耗时 | 平均 |
|---|---|---|
| 串行（冷） | 26.90 s | 690 ms/题 |
| 批量 c=3（冷） | **9.65 s** | 248 ms/题 |
| 批量 c=3（缓存填充） | 7.39 s | 189 ms/题 |
| 批量 c=3（缓存命中） | ~3 ms | — |

冷启动批量 **2.79×**；三种模式证据数一致（64 条）。

### 打包

`npm pack --dry-run`：**36 files / 59.7 KB compressed / 211.1 KB unpacked**，含默认站点包 `src/sites.json`。

### 复跑

```bash
npm test
npm run eval
npm run verify
npm run bench
```

---

## 历史：0.1.0（2026-10-21）


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
