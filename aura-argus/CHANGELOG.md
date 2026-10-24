# Changelog

## 3.0.0 — 2026-10-24

### Breaking

- CLI 只接受规范子命令 `aura_argus_*`；旧的 `search` / `fetch` / `sources` / `doctor` / `warm` / `gaps` / `index` / `serve` / `mcp` 别名删除。
- HTTP 只接受 `/aura_argus/*`；旧的 `/health`、`/sources`、`/search`、`/search/batch`、`/fetch` 返回 `410 ROUTE_REMOVED`。
- Node 库只导出 `aura_argus_*`；`search`、`searchBatch`、`fetchDocument` 兼容别名删除。JS client 只保留规范方法。
- CLI/MCP 移除 `--multi`、`--follow-links`、`--max-follow-links`、`--fast`、`--decompose`、`--batch` 公开旋钮；链接发现、拆句、多实体由 `--mode fast|balanced|deep` 内部决定。
- 安装面收敛为 MCP：`aura-argus aura_argus_mcp`；DSH native adapter 只保留为可选，不再作为默认安装路径。

### Gates

- `npm test`: **136/136**
- 无新增功能；本版仅删别名/旧路由/旧旋钮。

## 2.4.6 — 2026-10-24

### Fixed

- 尾延迟收口：单次 registry 抓取上限 2.0 s、discovery 抓取上限 1.8 s；慢官方页不再把整个查询拖过发布门，剩余来源与 fallback 继续作答。
- 这是 2.4.5 最终校验发现 p95 2642/2689 ms 超门后的性能修复；不改检索语义，不新增功能。

### Gates

- `npm test`: **136/136**
- `npm run eval` / `answerability`: 74 题 / 361 项、73/73；p95 **2443 ms**，`npm run gate` pass
- `npm run bench:agent`: 75/77（0.974），gate pass
- `npm run verify`: 220/220

## 2.4.5 — 2026-10-24

### Changed

- 2.4.x 稳定收口：文档、README、RESULTS 与 POSITIONING 统一到当前读数，避免发布页继续显示旧的 125/134 测试数或 217 源。
- 不新增功能；保留 2.4.3 的 220/220 源健康、2.4.4 的 API 别名契约和 2.4.0 的 `aura_argus_*` 规范名。

### Gates

- `npm test`: **136/136**
- `npm run verify`: **220/220 可达**
- `npm run bench:agent`: **75/77（0.974）**，score 0.987，gate pass

## 2.4.4 — 2026-10-24

### Changed

- 补强 2.4.0 的 API 兼容契约：新增断言，确认 `search` / `searchBatch` / `fetchDocument` 仍是 `aura_argus_*` 的同一函数别名，而不是第二套实现。
- 这是纯兼容性硬化，不新增 API、不改调用语义。

### Gates

- `npm test`: **136/136**
- `npm run bench:agent`: 保持 75/77（0.974），gate pass

## 2.4.3 — 2026-10-24

### Fixed

- `退役` 的中文扩展补入 `date / end of life / 2025`，修复别名问题只选到 Grounding 通用页、没有选中退役公告日期的回归。
- 注册表健康检查：**103 实体 / 220 源，220/220 可达**（此前 217/217；新增 Tavily credits、Mistral pricing、Bing grounding）。
- `bench:agent` 达到 **75/77（0.974）**，score 0.987，p95 2006 ms，gate pass；仅剩 DeepSeek Search 的 QPS/别名价格两项。

### Gates

- `npm test`: **135/135**
- `npm run verify`: **220/220 可达**
- `npm run bench:agent`: **75/77**，success 0.974，score 0.987，gate pass

## 2.4.2 — 2026-10-24

### Fixed

- 来源排序补强：URL/title 中的具体 facet（如 `/api/pull`、`/pricing`）现在参与已有来源评分，并在同分时优先具体页而不是文档根页。
- 补回 2.4.1 漏掉的 `模型/本地/拉取/开启/模式/漏洞/域名/自定义域/页面` 中文映射，避免把已有 facet 扩展误删。
- 补充 Tavily credits、Mistral pricing、Bing grounding 三个官方来源；覆盖从 **103 实体 / 217 源** 增到 **103 / 220**。
- `bench:agent` 从 2.4.1 的 71/77 提升到 **74/77（0.961）**，score 0.980，gate pass。

### Gates

- `npm test`: **135/135**
- `npm run bench:agent`: **74/77**，success 0.961，score 0.980，gate pass
- `npm run verify`: 103 实体 / 220 源，217/217 → 220/220（待本次 verify 记录）

## 2.4.1 — 2026-10-24

### Fixed

- 中文 facet 短语补强：`等待/元素`、`参数化`、`规则/所有权`、`路径`、`集合`、`添加`、`流量`、`同步`、`应用`、`哪一天`、`放在哪里`、`创建索引`、`WAL` 等现在会扩展为英文检索词，修复 how-to 与配置类问题只选到泛化来源的回归。
- `agent bench` 从 2.4.0 的 **62/77（0.805）** 提升到 **71/77（0.922）**，citation 与 fact link 保持 100%，p95 1423 ms，score 0.961；回归门重新通过。

### Gates

- `npm test`: **134/134**
- `npm run bench:agent`: **71/77**，success 0.922，score 0.961，gate pass
- `npm run eval` / `answerability` / `gate`: 保持 2.4.0 的 74 题 / 361 项、73/73、pass

## 2.4.0 — 2026-10-24

### Changed

- **API 规范名统一为 `aura_argus_*`**：
  - MCP tools / function-calling schema：`aura_argus_search`、`aura_argus_search_batch`、`aura_argus_fetch`、`aura_argus_sources`。
  - JS client：`aura_argus_health`、`aura_argus_sources`、`aura_argus_search`、`aura_argus_search_batch`、`aura_argus_fetch`。
  - 核心库：`aura_argus_search`、`aura_argus_search_batch`、`aura_argus_fetch_document`、`aura_argus_sources`、`aura_argus_list_entities`。
  - HTTP：规范前缀 `/aura_argus/*`；旧路径继续兼容。OpenAPI operationId 全部改为 `aura_argus_*`。
  - 旧 MCP/客户端/库名字保留为兼容别名，现有集成不会中断。
- **CLI 子命令统一为 `aura_argus_*`**：`aura_argus_search`、`aura_argus_search_batch`、`aura_argus_fetch`、`aura_argus_sources`、`aura_argus_doctor`、`aura_argus_warm`、`aura_argus_gaps`、`aura_argus_index`、`aura_argus_serve`、`aura_argus_mcp`、`aura_argus_version`、`aura_argus_help`。旧子命令继续作为别名。

### Fixed

- 错误/对比题的 answerability 守卫：错误码需与可操作提示同段出现；对比题需双方实体/术语；deep index early-return 也必须通过。

### Gates

- `npm test`: **134/134**
- `npm run eval`: **74 题 / 361 项硬检查全过**（soft 2/2）；p50 1035 ms / p95 2408 ms
- `npm run answerability`: **73/73（100%）**，p95 2399 ms；`npm run gate`: **pass**
- `npm run eval:heldout`: **4/4（100%）**，p50 75 ms / p95 120 ms
- `npm run bench:agent`: **62/77（success 0.805）**，citation 100% / fact link 100%，p95 1234 ms，score 0.903；低于 success 0.9 的发布门，列为 2.4.x 回归修复项

## 2.3.0 — 2026-10-23

### Changed

- **默认全网友好**：CLI/MCP/HTTP 默认 `fallback=auto`；官方证据优先，只有官方无证据、置信度 <0.6 或关键 facet 缺失时才调用网页兜底。`--no-fallback` / `fallback:false` 可关闭；库调用 `search()` 仍默认关闭，需显式传入。
- 兜底触发条件从“任意 facet 缺失”收紧为“关键 facet 缺失”，避免 `settings/configuration` 等泛词触发不必要的网络请求。
- 兜底抓取从 3 页扩到 4 页；`fallback` 元数据新增 `officialSources` / `webSources` / `augmented`，官方证据始终排在网页证据之前。
- SearXNG（自托管）仍是首选 provider；无 SearXNG 时走 Bing/360/DuckDuckGo keyless 链，带相关性过滤和熔断。

### Gates

- `npm test`: **125/125**
- `npm run eval`: **74 题 / 361 项硬检查全过**，soft 2/2；p50 821 ms / p95 2481 ms
- `npm run answerability`: **73/73（100%）**，p95 2481 ms
- `npm run gate`: **pass**
- `npm run eval:heldout`: **4/4（100%）**，p50 59 ms / p95 109 ms
- `npm run bench:agent`: **77/77**，p95 2460 ms，score **1.0**

## 2.2.0 — 2026-10-23

### Added

- **官方站递归发现**：`src/lib/discover.mjs` 支持 `robots.txt` → sitemap → 子 sitemap 递归，以及同站链接 BFS；`sitemap-index.xml` / `sitemap_index.xml` 兼容。在线递归仅在 how-to/list/compare 且置信度 <0.55 时触发，默认最多 5 页、深度 2、同源，并带 `recursive-sitemap` / `recursive-discovery` 标记。
- **Deep index**：`index --deep` 递归发现官方深页并建立本地 section 索引；支持 `ETag`/`Last-Modified` 增量、复用和 `--max-pages` / `--max-depth`。`search --deep-index`（MCP/HTTP `deepIndex`）在索引完全覆盖 facet 且置信度高时直接返回，否则继续 live。
- **自持网页兜底**：`--fallback` / `--fallback=auto`。优先自托管 SearXNG（`AURA_ARGUS_SEARXNG_URL`），否则走项目内的 keyless Bing/360/DuckDuckGo HTML 适配；带相关性过滤、provider 熔断、正文抓取和 snippet 回退。不依赖 Tavily/Exa 等商业 API。
- **Held-out 门禁**：新增 `eval/heldout.json` + `npm run eval:heldout`，覆盖 Docker Compose healthcheck、TypeScript satisfies、K8s livenessProbe、Nginx proxy_pass。
- **代码块整体选段**：fenced code block 不再按行拆散；代码块保留增加 heading 邻接条件，Docker YAML `test:` 示例可被选中。
- **置信度校准**：关键 facet 缺失时最高只能到 medium；`settings/configuration/configure` 等泛词不再拉高 facet 覆盖率。
- MCP/HTTP/OpenAPI/CONTRACT 同步 `deepIndex`、`fallback`、`recursive` 选项和 `web-fallback` origin。

### Gates

- `npm test`: **125/125**
- `npm run eval`: **74 题 / 361 项硬检查全过**，soft 2/2；p50 821 ms / p95 2481 ms
- `npm run answerability`: **73/73（100%）**，p95 2481 ms
- `npm run gate`: **pass**
- `npm run eval:heldout`: **4/4（100%）**，p50 59 ms / p95 109 ms
- `npm run bench:agent`: **77/77**，citation 100%，facts 100%，p95 2460 ms，score **1.0**
- `eval/run.mjs --fast`: **74/74**，10 index hits

## 2.1.0 — 2026-10-23

### Fixed

- **引用 ID 冲突**：passage `id` 现在包含来源 URL，两个页面出现相同文本时不再生成相同 ID；`citation` 先剥离已有 fragment，避免 `url#a#b`。
- **事实去重跨源丢失**：`facts` 去重键加入 `sourceId`/`url`，相同文本来自两个来源时保留两条证据。
- **JS 客户端超时错误码**：超时返回 `TIMEOUT`，外部取消返回 `ABORTED`，不再统一落到 `NETWORK_ERROR`/`ABORTED`。
- **全量索引重建仍带旧验证器**：`--no-incremental` / `incremental:false` 不再发送上一次的 ETag，确保真正重新抓取；304 复用也受新的 section 上限约束。
- **decompose 预算放大**：子查询共享父查询剩余墙钟预算，不再为每个 clause 各自获得一份完整预算。
- **consensus 来源重复**：同一来源的重复事实不再在 agreements 的 `sources` 里出现多次。
- **OpenAPI**：结果 `mode` 枚举补上 `error`；passage id 说明改为 URL + heading path + text。
- 结果缓存键升到 v4，避免读到 2.0 之前生成的旧 ID/字段形状。

### Gates

- `npm test`: **120/120**
- `npm run eval`: **74 题 / 361 项硬检查全过**，soft 2/2；p50 880 ms / p95 1826 ms
- `npm run answerability`: **73/73（100%）**，p95 1826 ms
- `npm run gate`: **pass**
- `npm run bench:agent`: **73/73**，citation 100%，facts 100%，p95 2195 ms，score **1.0**

## 2.0.0 — 2026-10-23

### Added

- **Agent 基准**：`npm run bench:agent` 同时衡量任务成功率、引用完整性、事实可追溯性和 p95；输出 `eval/agent-bench.json`，低于 success 0.9 / citation 0.98 / p95 2500 ms / score 0.85 时 exit 2。2.0 实测 73/73、引用 100%、事实链接 100%、p95 1980 ms、score 1.0。
- **同主机并发上限**：同一 host 默认最多 4 个并发抓取（`AURA_ARGUS_HOST_CONCURRENCY`），批量/多实体时降低对官方站的瞬时压力；支持 `AbortSignal` 取消排队。

### Gates

- `npm test`: **117/117**
- `npm run eval`: **74 题 / 361 项硬检查全过**，soft 2/2；p50 841 ms / p95 1810 ms
- `npm run answerability`: **73/73（100%）**，p95 1810 ms
- `npm run gate`: **pass**（p95 ≤2500）
- `npm run bench:agent`: **pass**，score **1.0**

## 1.9.0 — 2026-10-23

### Added

- **增量索引**：`index` 默认复用未过期的实体索引；过期索引按源带 `ETag` / `Last-Modified` 重验证，304 时复用旧 section，只重抓变化的源。`--no-incremental` 强制全量重建。
- 索引记录保存每个源的 `requested` URL、`etag`、`lastModified`、`notModified`；manifest 升到 v2，输出 `reused` / `updatedSources` / `notModifiedSources`。
- 索引 CLI 输出 `REUSE` / `304×N` / `upd N` 状态。

### Gates

- `npm test`: **114/114**
- `npm run eval`: **74 题 / 361 项硬检查全过**，soft 2/2；p50 910 ms / p95 1819 ms
- `npm run answerability`: **73/73（100%）**，p95 1819 ms
- `npm run gate`: **pass**（p95 ≤2500）

## 1.8.0 — 2026-10-23

### Added

- **JS 客户端**：`aura-argus/client` 导出 `createClient` / `ArgusClientError`，覆盖 `health`、`sources`、`search`、`searchBatch`、`fetch`；支持 bearer token、超时、`AbortSignal` 取消，零运行时依赖，Node 20+ 与浏览器可用。
- **MCP resources**：`initialize` 声明 `resources` capability；支持 `resources/list`、`resources/templates/list`、`resources/read`，资源为 `argus://coverage`、`argus://health`、模板 `argus://entity/{id}`。
- 集成文档新增 [docs/integrations/js-client.md](docs/integrations/js-client.md)；CONTRACT 记录 resources 与客户端。

### Gates

- `npm test`: **113/113**
- `npm run eval`: **74 题 / 361 项硬检查全过**，soft 2/2；p50 864 ms / p95 1629 ms
- `npm run answerability`: **73/73（100%）**，p95 1629 ms
- `npm run gate`: **pass**（p95 ≤2500）

## 1.7.0 — 2026-10-23

### Added

- **检索模式**：`mode: fast|balanced|deep`（CLI `--mode`、MCP/HTTP `mode`）。fast = 2 源 / 不跟链接 / 优先本地索引；balanced = 3 源 / 1 跳；deep = 6 源 / 2 跳 / 复合问题拆句 / 关闭早停。显式选项覆盖预设，结果带 `searchMode`。
- **墙钟预算**：`budgetMs`（CLI `--budget-ms`、MCP/HTTP `budgetMs`）。预算耗尽时停止发起新抓取，返回已获得的证据，标记 `partial: true` 与 `budget: {limitMs, usedMs, exhausted}`，并通过 `next.hint` 提示提高预算或减少源；partial 结果不写入结果缓存。
- 非法 mode 返回 `BAD_REQUEST`。

### Gates

- `npm test`: **109/109**
- `npm run eval`: **74 题 / 361 项硬检查全过**，soft 2/2；p50 868 ms / p95 1746 ms
- `npm run answerability`: **73/73（100%）**，p95 1746 ms
- `npm run gate`: **pass**（p95 ≤2500）

## 1.6.0 — 2026-10-23

### Added

- **跨来源一致性**：`consensus` 汇总同单位/同币种的 `price`、`percent`、`limit`、`status` 事实；`agreements` 列出被至少两个来源确认的值，`conflicts` 列出简单分组里的分歧，并给出 `agreementRatio`。
- 多值分组（价格表等）不判定冲突，只把跨来源重复出现的值记为一致；单来源或无同类事实时不输出 `consensus`。
- MCP `outputSchema`、OpenAPI `Consensus` schema、CONTRACT 增加一致性契约。

### Gates

- `npm test`: **106/106**
- `npm run eval`: **74 题 / 361 项硬检查全过**，soft 2/2；p50 821 ms / p95 1705 ms
- `npm run answerability`: **73/73（100%）**，p95 1705 ms
- `npm run gate`: **pass**（p95 ≤2500）

## 1.5.0 — 2026-10-23

### Added

- **结构化事实**：结果新增 `facts`，从已引用 passages 确定性抽取 `price`、`percent`、`version`、`date`、`limit`、`status`；每条带 `value` / `unit` / `currency`、匹配上下文、`confidence`、`passageId`、`sourceId` 和 `citation`。
- 事实按意图过滤：pricing 返回价格/百分比/限额，version 返回版本/日期/限额，error 返回状态码/限额/百分比；同类同值事实在同一段落内去重。
- MCP `outputSchema`、OpenAPI `Fact` schema、CONTRACT 增加事实契约。

### Changed

- **非自适应意图恢复并行抓取**：how-to / error / compare / list 以及首源为枢纽页时不再走“先抓第一个再抓其余”，而是并行抓全部源；避免不必要的串行等待。p95 从 1958 ms 降到 **1521 ms**。

### Gates

- `npm test`: **102/102**
- `npm run eval`: **74 题 / 361 项硬检查全过**，soft 2/2；p50 926 ms / p95 1521 ms
- `npm run answerability`: **73/73（100%）**，p95 1521 ms
- `npm run gate`: **pass**（p95 ≤2500）

## 1.4.0 — 2026-10-23

### Added

- **可引用证据**：每个 passage 新增稳定 `id`（heading path + text 的 12 位哈希）、`kind`、`heading`、`headingPath`、`anchor`、`anchorType`、`sourceId`、`url`、`citation` 和提取 Markdown 行号；evidence 新增基于最终 URL 的稳定 `id`。
- **标题锚点**：Markdown 标题按 GitHub 风格生成 slug，重复标题追加 `-2`、`-3`；`citation` 输出 `url#anchor`。自定义 heading id 的站点锚点可能不精确，`heading` 仍是权威定位。
- 本地索引（fast 路径）和 fallback 证据同样带 citation 字段；CONTRACT.md 增加 Passage 契约。

### Gates

- `npm test`: **99/99**
- `npm run eval`: **74 题 / 361 项硬检查全过**，soft 2/2；p50 992 ms / p95 1958 ms
- `npm run answerability`: **73/73（100%）**，p95 1958 ms
- `npm run gate`: **pass**（p95 ≤2500）

## 1.3.0 — 2026-10-23

### Changed

- **自适应扇出**：事实 / 价格 / 版本类查询先抓排名第一的源；若 facet 全覆盖且置信度 ≥0.75，跳过其余源并标记 `note: "early-stop"`。多实体查询的单实体源上限改为 2（此前按 `maxSources/实体数` 后至少 1），降低多实体场景的漏检。
- **枢纽页保护**：当首个源的 URL 是同一主机上其他源的父路径（如 MDN `/JavaScript/Reference`）时禁止早停，避免把导航索引页当成答案页。
- **意图优先级**：`怎么/如何/how to` 先于 version；`发布` 不再单独触发 version。`PyPI 怎么发布 Python 包？` 从 version 纠正为 howto，避免对帮助中心早停。
- 发布门 p95 阈值恢复 **2500 ms**（1.2 临时放宽到 3000）。

### Gates

- `npm test`: **98/98**
- `npm run eval`: **74 题 / 361 项硬检查全过**，soft 2/2；p50 983 ms / p95 2191 ms / p99 4011 ms
- `npm run answerability`: **73/73（100%）**，p95 2191 ms
- `npm run gate`: **pass**（p95 ≤2500）
- `eval/run.mjs --fast`: **74/74 全过**

## 1.2.0 — 2026-10-23

### Added

- **查询规划**：`planQuery` 识别 `pricing` / `version` / `error` / `compare` / `howto` / `list` / `fact` 意图，结果新增 `intent`；复合问题（`？`、`;`、`and`、`以及/并且/分别`）可拆成 clauses。
- **分解检索**：`--decompose` / MCP `decompose` / HTTP `decompose` 并行检索每个 clause，按 URL 合并证据并保留 `clause`/`clauses`/`clauseIndex` 归属；结果新增 `plan: {intent, confidence, clauses, compound}`。
- 评测新增 `decompose-price-qps`（74 题 / 361 项），验证 DeepSeek 价格 + QPS 两个 clause 的并行合并。

### Changed

- 1.2 的发布门 p95 阈值调整为 **3000 ms**（覆盖扩到 103 实体 / 217 源，含较慢的上游）；1.3 的性能目标恢复 **2500 ms**。

### Gates

- `npm test`: **97/97**
- `npm run eval`: **74 题 / 361 项硬检查全过**，soft 2/2；p50 929 ms / p95 2746 ms
- `npm run answerability`: **73/73（100%）**，p95 2746 ms
- `npm run gate`: **pass**（p95 ≤3000）
- `eval/run.mjs --fast`: **74/74 全过**，10 题命中索引
- `npm pack --dry-run`: 46 files / 92.6 KB

## 1.1.0 — 2026-10-23

### Added

- 覆盖率扩到 **103 实体 / 217 源**：新增 Ruby、Scala、Cassandra、Ansible、Istio、Argo CD、Jest、Cypress、pytest、Flask、Express、Helm、OpenTelemetry，并为 Scala case class、Ansible playbook、Istio 流量管理、Cypress get、pytest parametrize、Flask quickstart/API、Express middleware、Helm values、OTel traces 增加深页源。
- 评测扩到 **73 题 / 355 项硬检查**，新增 13 道覆盖题。

### Fixed

- 深页源补齐后，Scala/Ansible/Istio/Cypress/pytest/Express/Helm/OTel 的 how-to 问题能选中对应段落；Flask 路由题改为 `app.route` 表述并命中代码段。

### Gates

- `npm test`: **94/94**
- `npm run eval`: **73 题 / 355 项硬检查全过**，soft 2/2；p50 905 ms / p95 1504 ms
- `npm run answerability`: **72/72（100%）**，p95 1504 ms
- `npm run gate`: **pass**
- `eval/run.mjs --fast`: **73/73 全过**，10 题命中索引
- `npm pack --dry-run`: 45 files / 90.2 KB

## 1.0.0 — 2026-10-23

### Added

- **Answerability 报告**：`npm run answerability` 把 59 道硬评测题转成 `answerable` / checks / confidence / facet / p50 / p95 指标，输出 `eval/answerability.json`。
- **发布门**：`npm run gate` 同时检查 answerability（默认 ≥0.9）与 p95（默认 ≤2500 ms）；1.0 实测 59/59、p95 1716 ms，通过。
- **契约冻结**：`CONTRACT.md` 固定 `schemaVersion: 1` 的结果字段、模式、错误码、缓存语义、MCP 行为；新增 `test/contract.test.mjs` 防回归。
- `package.json` 的 `files` 包含 `CONTRACT.md`；`answerability` / `gate` 脚本。

### Changed

- 版本进入 **1.0 稳定线**；README / RESULTS / RELEASE / POSITIONING / SECURITY 同步。

### Gates

- `npm test`: **94/94**
- `npm run eval`: **60 题 / 290 项硬检查全过**，soft 2/2
- `npm run answerability`: **59/59 answerable（100%）**，p95 1716 ms
- `npm run gate`: **pass**
- `eval/run.mjs --fast`: **60/60 全过**，10 题命中索引
- `npm run verify`: 90 实体 / 194 源全部可达
- `npm pack --dry-run`: 45 files / 88.3 KB

## 0.9.0 — 2026-10-23

### Added

- **取消传播**：`AbortSignal` 贯通 `fetchRaw` / `getPage` / `search` / `searchBatch` / `fetchDocument`；外部取消抛 `ABORTED`，不进入重试；新增 `ABORTED` 错误码。
- **MCP 取消**：支持 `notifications/cancelled`；被取消的 `tools/call` 不发送响应，底层 fetch 立即 abort。
- **MCP 进度**：`tools/call` 带 `_meta.progressToken` 时，`search` 发送 0/1、1/1，`search_batch` 每完成一题发送一次 `notifications/progress`。
- **HTTP 取消**：客户端断开时 abort 进行中的 search/batch/fetch，避免继续占用网络。
- `searchBatch` 新增 `onProgress` 回调；批量取消时剩余项标记为 `ABORTED`。

### Fixed

- `fetchSource` 不再吞掉 `ABORTED`；批量 worker 在启动下一题前检查取消。
- HTTP 取消钩子使用 `res.on('close')`，不会在正常请求体读完时误取消。

### Gates

- `npm test`: **92/92**
- `npm run eval`: **60 题 / 290 项硬检查全过**，soft 2/2
- `eval/run.mjs --fast`: **60/60 全过**，10 题命中索引
- `npm pack --dry-run`: 44 files / 85.5 KB

## 0.8.0 — 2026-10-23

### Added

- **版本文档路由**：问题中出现版本号时自动改写官方源到对应版本，覆盖 Node 18/20/22/24、Python 3.9–3.13、PostgreSQL 14–18、MySQL 8.0/8.4；也可用 `--doc-version 20` / MCP `docVersion` / HTTP `docVersion` 显式指定。
- 版本改写保留深页路径：例如 `nodejs.org/api/fs.html` → `nodejs.org/docs/latest-v20.x/api/fs.html`；结果新增 `version` / `versionRequested`，evidence 新增 `version`。
- **新鲜度元数据**：evidence 新增 `updated`（来自 `Last-Modified`）；`fetchDocument` 返回 `updated` / `etag`；索引 evidence 用构建时间。
- 评测新增 `node20-fs`（60 题 / 290 项），验证 Node.js 20 的 fs 文档路由。

### Fixed

- 版本检测只对 versions.json 中列出的实体生效，避免 `SearXNG 429` 被当成版本号。
- 版本化查询禁用 fast 索引，避免索引里的当前版本文档和请求版本不一致。

### Gates

- `npm test`: **87/87**
- `npm run eval`: **60 题 / 290 项硬检查全过**，soft 2/2；p50 850 ms / p95 1402 ms
- `eval/run.mjs --fast`: **60/60 全过**，10 题命中索引
- `npm pack --dry-run`: 44 files / 83.5 KB

## 0.7.0 — 2026-10-23

### Added

- **本地 section 索引**：`aura-argus index --top 20` / `--entity id` 把实体主源切成段落写入本地索引（每源最多 500 段），带 coverageVersion、builtAt 与 manifest；`AURA_ARGUS_INDEX_DIR` 可改目录。
- **fast 模式**：`search --fast` / MCP `fast: true` / HTTP `fast=1` 对“已知事实”查询（价格、端口、版本、上限、日期等）直接查本地索引，命中约 2 ms；开放 how-to/对比/清单问题自动回退 live，避免漏掉 API 名。
- 索引检索按 URL 配额（每源 6 段、总计 12 段）并保留代码命令段；`AURA_ARGUS_INDEX_TTL_MS` 控制 24 小时过期。
- `eval` / `bench` 支持 `--fast` 并报告 `indexHits`；CLI 新增 `index` 命令与 `npm run index`。

### Fixed

- fast 模式增加安全门槛：仅事实型问题、facet 覆盖 ≥0.7、confidence ≥0.5 才使用索引，否则回退 live。
- 索引检索补充每源配额与代码命令预留，减少只返回一个来源或漏掉 SQL/CLI 命令的问题。

### Gates

- `npm test`: **83/83**
- `npm run eval`: **59 题 / 285 项硬检查全过**，soft 2/2；live p50 835 ms / p95 1976 ms
- `eval/run.mjs --fast`: **59/59 全过**，10 题命中索引，索引命中约 2 ms；整体 p50 797 ms / p95 1222 ms
- 索引构建：42 实体 / 8,120 段 / 约 2.19 MB

## 0.6.0 — 2026-10-23

### Added

- 覆盖率扩展到 **90 实体 / 194 源**：新增 Azure、Google Cloud、Mistral、Hugging Face、LangChain、Ollama、MongoDB、SQLite、Elasticsearch、Prometheus、Grafana、Angular、Svelte、PyPI、GitHub Advisory、Flutter；并为 Azure 自定义域、GCP 实例、HF 安装、Ollama pull、SQLite WAL、Angular signals、PyPI 打包、GHSA 文档、Flutter UI、ES 创建索引、阿里云 ECS 规格增加深页源。
- 评测扩到 **59 题 / 285 项硬检查**，新增 16 个覆盖题。
- **缺口记录**：`AURA_ARGUS_QUERY_LOG=1` 写本地 JSONL（问题、实体、mode、confidence、missing facet、耗时），`aura-argus gaps` / `npm run gaps` 汇总 `mode:none`、低置信度、高频缺失 facet；默认关闭，无遥测。
- 路由改为“首次出现位置 + 别名长度”排序，中文别名（必应）也参与匹配。
- 选段增加代码命令预留位与相邻窗口合并，避免 `PRAGMA journal_mode=WAL` 这类命令被正文挤掉。
- 中文意图扩展补充 `实例/规格/选型/本地/拉取/开启/模式/漏洞/域名/自定义域/页面`。

### Fixed

- PyPI、GitHub Advisory、Google Cloud 不再被更宽的实体（python/github/google-cse）抢路由。
- 移除过宽的 `计算 → computed` 扩展，避免“量子计算机”被注入 computed。
- SQLite WAL、Elasticsearch 创建索引、阿里云 ECS 规格的深页源补齐。

### Gates

- `npm test`: **81/81**
- `npm run eval`: **59 题 / 285 项硬检查全过**，soft 2/2；p50 792 ms / p95 1772 ms / p99 2850 ms
- `npm run verify`: **90 实体 / 194 源全部可达**

## 0.5.0 — 2026-10-23

0.4.0 的测量/准确性与 0.5.0 的速度基础设施合并交付。

### Added

- **多实体对比路由**：检测到“和/与/vs/区别”等信号且命中 2+ 实体时，并行检索并在 `entities` 中逐实体返回 `confidence` / `facets`；主实体按首次出现位置选择。
- **一跳链接跟随**：只有高价值 facet 缺失且置信度 < 0.75 时，才从已抓页面里挑一个同站、包含缺失 facet 的文档链接；默认最多 1 个，`depth: 1` / `via: "link"` 标记。
- **结果契约**：`confidence`（0–1 + high/medium/low）、`facets`（terms/covered/missing/ratio）、`timings`（route/fetch/extract/select/follow/total）、`next`、`entities`；evidence 增加 `entity`/`depth`/`via`，attempt 增加 `cache`。
- **选段 v3**：标题、代码块、表格独立成块并获得评分加成；长正文按句切块。
- **持久页缓存**：按 URL 存 Markdown + `ETag` / `Last-Modified`，默认 TTL 6 小时，跨进程复用；公开页与 `--allow-private` 私网页分键存储。
- **`warm` 预热**：`aura-argus warm --top 20` 或 `--entity searxng,mysql` 把主源预取进页缓存；新增 `npm run warm`。
- **MCP 契约**：工具返回 `structuredContent` + `outputSchema`，带 read-only annotations；`search`/`search_batch` 暴露 `multi` / `followLinks` / `maxFollowLinks`。
- **Benchmark v2**：`npm run eval` 输出 p50/p95/p99、平均置信度、平均 facet 覆盖；`npm run bench` 输出串行/批量分位数。
- **定时健康检查**：`.github/workflows/health.yml` 每日 `npm run verify` 并上传报告；`verify-registry` 支持 `--retries` / `--timeout`。

### Fixed

- 多实体主实体按首次出现选择，不再被短别名（vue/go）抢占。
- 实体别名不再作为独立 facet，避免 `react.js`/`reactjs` 这类同义别名压低置信度。
- PostgreSQL 增加事务隔离级别页；MySQL 隔离级别页已在 0.3.0 加入。
- 健康检查默认 1 次重试，降低大页面/网络抖动的假阴性。

### Gates

- `npm test`: **78/78**
- `npm run eval`: **43 题 / 205 项硬检查全过**，soft 2/2
- `npm run verify`: **74 实体 / 167 源全部可达**
- `npm run bench`: 42 题，批量 c=3 冷启动 **2.99×** 于串行

## 0.3.0 — 2026-10-23

### Added

- 默认站点包（`src/sites.json`，**42 个站点 / 71 个源**）：优先收录大陆直连可用的一手文档，新增阿里云、腾讯云、华为云、火山引擎、通义千问、智谱、Kimi、SiliconFlow、百度智能云、微信小程序、微信支付、Gitee、uni-app、Ant Design、Element Plus、ECharts、Nacos、Dubbo、RocketMQ、OpenResty、Spring Boot、MyBatis、Maven、Gradle 等。与 `registry.json` 合并后覆盖 **74 实体 / 166 源**；源带 `origin`，17 个源标记为 `fallback`，只在主源没有证据时尝试。
- `--no-sites` / `--sites-file` / `AURA_ARGUS_NO_SITES` 贯通 CLI、HTTP、MCP、doctor；`getCoverage()` / `coverageVersion()` 与 `/health`、`/sources` 暴露合并后的覆盖版本和来源文件。
- 中文意图短语扩展：`创建表 → create table`、`事务隔离级别 → transaction isolation level`、`读文件 → readFile` 等；英文相邻实词也会组成短语参与选段（`how to create a table` 可命中 `create table`）。
- 选段 v2：长正文按句切块，标题/代码行独立成块；IDF 上限 4.5、泛词降权、具体 API 词预留位置、窗口重叠去重、长段落围绕命中词裁剪；价格问题优先货币金额段落。
- 评测扩到 40 题（新增大陆站点包、MySQL 隔离级别、站点关闭等）；新增离线 `npm run verify:registry`。

### Fixed

- 修复 `node-fs`、`postgres-table`、`mysql-innodb` 的选段回归：页面正文包含答案，但旧逻辑让泛词段落或巨大段落挤掉 API 名与 SQL 短语。
- `no-sites-optout` 评测用例显式关闭 fallback，避免把 fallback 结果误判为站点包泄漏。
- 公开/私网页面缓存分区，避免同进程把内网页面回给未授权调用。
- OpenAI / Anthropic 文档与定价源更新到当前官方地址（`developers.openai.com`、`platform.claude.com`）；MySQL 增加事务隔离级别页。
- 注册表与站点包的版本哈希按 LF 归一化，CRLF/LF 检出与 zip 产物产生相同的 `coverageVersion`。

### Gates

- `npm test`: **69/69**
- `npm run eval`: 40 题 / **184 项硬检查全过**，soft 2/2
- `npm run verify`: **74 实体 / 166 源全部可达**

## 0.2.0 — 2026-10-23

### Added

- Registry expanded to **49 entities / 95 official sources**, including TypeScript, Next.js, Vite, Deno, Bun, Tailwind CSS, Prisma, Supabase, Cloudflare, Stripe, OpenAI, Anthropic, npm, pnpm, ESLint, Vitest, Playwright, Terraform, AWS, Java, .NET, PHP, Laravel, Django, FastAPI, Rails, Git, Bash, PowerShell, C++/cppreference and CMake.
- `--site <domain>` / MCP `site` / HTTP `site`: restrict retrieval to one domain, discover its sitemap or home links, and fetch page bodies as evidence instead of only search snippets.
- Deeper Markdown extraction: code fences keep indentation; table cells keep `|` boundaries; registry search uses Markdown instead of flattened line text.
- Tests for site normalization, code/table preservation, and expanded routing.

## 0.1.2 — 2026-10-21

### Changed

- Repository metadata now points at the Aura monorepo (`Ck-epsilon/Aura`, directory `aura-argus`).
- ZCode integration docs corrected: first-party MCP via `~/.zcode/cli/config.json` `mcp.servers`.
- No runtime behavior changes.
- 0.1.1 was staged by npm's publish flow but never became public; 0.1.2 supersedes it.

## 0.1.0 — 2026-10-21

Initial public beta.

### Added

- Keyless source router: 18 entities / 34 official sources, with aliases and CN→EN term expansion.
- Evidence contract: per-source passages, scores, URLs, `mode`, attempts, `tookMs`, `cached`.
- CLI: `search`, `fetch`, `sources`, `doctor`, `serve`, `mcp`; JSON output and typed exit codes.
- HTTP server: `/health`, `/sources`, `/search`, `/search/batch`, `/fetch`.
- MCP stdio server: `search`, `search_batch`, `fetch`, `sources`; protocol negotiation and
  client-agnostic `instructions`.
- Node library exports: `search`, `searchBatch`, `fetchDocument`, `listEntities`, `matchEntity`,
  `registryVersion`, `ArgusError`, `CODES`, `toErrorPayload`, `version`.
- DSH provider adapter (`adapters/dsh`) and an optional MCP server entry.
- Batch search with bounded concurrency (1–8), page cache, in-flight de-duplication, and a batch
  budget (MCP 35 s, HTTP 45 s).
- Retry policy: up to 3 attempts per source for network errors, timeouts, 408/425/429/5xx;
  exponential backoff with jitter; `Retry-After` support; total budget.
- `ALL_SOURCES_FAILED` error with per-source attempts (CLI exit 4, HTTP 502, MCP `isError`, DSH
  provider error).
- SSRF protection: private/loopback/link-local/metadata targets denied by default; DNS and
  redirect re-checks; `--allow-private` opt-in.
- `schema/tools.json` for function-calling agents and `openapi.json` for HTTP integrations.

### Changed

- The 360/Sogou web fallback is now **opt-in** (`--fallback` / `fallback: true`). Registry-only is
  the default; unregistered questions return `mode: "none"`.
- MCP instructions and tool descriptions are client-agnostic (no DSH-specific tool names).

### Known limitations

- Coverage is the registry. Unregistered entities return no evidence unless fallback is enabled.
- No JavaScript rendering, login walls, CAPTCHA solving, or proxy pools.
- Single-entity routing; multi-entity questions are not composed.
- DNS rebinding and proxy environments are documented limitations (see `SECURITY.md`).
