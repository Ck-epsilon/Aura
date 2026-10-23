# AuraArgus · 定位与差异

> 一句话：市面上卖的是「路」——索引、机房、实例；我们能卖的只有**本地选路 + 路况报告**。
>
> 依据：[AuraArgus-0.1-交接单.md](AuraArgus-0.1-交接单.md) + 2026-10-20 本机实测（§4.1，脚本 `.tmp/probe2.mjs`，读数会随网络状态变化）。
>
> 读法：§0 是判断；§1–2 是与市面的距离；§3–4 是两个约束推出的形态；§5 是交接单要修正的地方；§6–7 是决策与反方。

---

## 0. 五条判断

1. **这不是新品类。** 至少五类玩家在做「给程序拿搜索结果」，其中自托管元搜索（SearXNG）和单引擎抓取库（ddgs 一类）与我们功能重叠。
2. **两个约束把产品挤到一个很窄但真实的位置。** 不做服务端 ⇒ 不能集中修解析、不能有遥测、不能统一出口；效果依赖本地环境 ⇒ 质量是 `f(环境)` 而不是常数。于是能承诺的只有一句：**给定你的网络，把此刻能走通的通道用到最好，并把走不通的原因说清。**
3. **能站住的差异只有三条**：进程形态（库 / CLI / stdio，无常驻）、环境感知（探测 + 四态 + 归因）、结果契约（直链 + attempts + 本地缓存）。质量、时延、稳定性三条都不能吹。
4. **最危险的替代不是 Tavily，是 agent 内置搜索和 SearXNG。** 前者免费、零配置、默认在场；后者免费、引擎更多、有社区维护。我们争的是它们覆盖不到的剩余：不想按次付费、查询不能经过第三方、需要可复现、要嵌进本地流水线。
5. **市场窗口是真的，但上游不是消失，是换人。** Bing Search API 于 2025-08-11 退役，Google CSE 已对新客关闭、2027-01-01 停服；与此同时境内长出了新的第一方供给——DeepSeek 的 Search/Fetch API 已按 $0.75 / 1,000 次成功请求计价（境内直连，2026-11-01 起对 DSH 等收费）。所以卖点不能是「稀缺」，只能是「供应商独立」。

---

## 1. 市场按「谁承担环境差异」分五类

| 类别 | 代表 | 怎么付 | 质量由谁决定 | 失败长什么样 | 形态 | 与我们的关系 |
|---|---|---|---|---|---|---|
| 托管搜索 API | Tavily、Exa、Brave、SerpAPI、Parallel | 按次 / 预付（Tavily $0.008/credit；Brave 每月最高 $20 免费额度） | 对方机房 + 索引 | HTTP 4xx/5xx、空结果、配额 | 远端 HTTP | 替代品；「环境归一化」的样板 |
| 官方搜索 API | Bing Search、Google CSE | 按次 | 平台 | **退役 / 关停** | 远端 HTTP | 正在消失的中间层 → 窗口 |
| 境内第一方搜索 API | DeepSeek Search/Fetch（$0.75/1k）、博查 | 按次 | 厂商索引 | HTTP 错误 / 配额 | 远端 HTTP（境内可达） | CN 格子里最强的替代；BYOK 首选 |
| 自托管元搜索 | SearXNG、OpenSERP、Whoogle、4get | 免费（人力成本） | 运维者的出口 IP | 实例 5xx、`unresponsive_engines` | 常驻服务 | 最接近的替代品 |
| 单引擎抓取库 | ddgs、duck-duck-scrape、各家 MCP | 免费 | 单引擎当日状态 | **静默空结果 / 异常** | 进程内库 | 功能子集 |
| Agent 内置 / 浏览器代理 | 主流客户端、browser-use、Playwright MCP | 订阅内含或按次 | 厂商 | 厂商不可用 | 远端 / 重 | 默认选项，争剩余市场 |

这张表只需要读出一句：**五类里没有一类把「本地环境」当产品。** 付费 API 把差异吸进自己的机房；SearXNG 转嫁给运维者；抓取库假装它不存在。空出来的那一格就是我们的位置。

---

## 2. 和最近的三类逐条拆

### 2.1 vs 付费 API：他们卖的是「环境归一化」

你付的 $8/1k 买的不是索引，是「你的网络不影响结果」。反过来，他们必须维持机房、代理、反爬预算和索引——这正是我们做不了的。

注意：这个价差只在境外成立。境内第一方 API 已经把价格打到 $0.75/1k（≈¥5.4 / 千次），所以「便宜」不再是护城河，只剩「零成本 + 不经过第三方」还站得住。

| 维度 | 他们 | 我们 |
|---|---|---|
| 质量 | 恒定（由机房决定） | 条件函数（由用户网络决定） |
| 成本 | 线性（按次） | 零边际 |
| 查询路径 | 经过第三方 | 只到搜索引擎本身 |
| 供给风险 | 厂商可退役 / 关停（Bing 已发生） | 引擎可换，接口不变 |
| 集成成本 | 注册 + key + SDK | 一条命令 |

所以和他们比「结果好不好」必输，也不该比。正确的对比口径是：**同一网络位置下，谁能在一次调用里拿到可直接引用的链接，并在拿不到时给出可行动的原因。**

### 2.2 vs SearXNG：同样的功能，不同的进程形态

必须承认 SearXNG 已经证明这条路可行：多引擎、免 key、自托管、有引擎冷却（`suspended_times`）、有 JSON 输出（默认关，要在 `formats` 里打开）。所以差异不在「聚合」这件事上，只在三件更小的事：

1. **形态**：SearXNG 是你要运维的常驻服务（Python / 容器 / 反代 / limiter / 配置）；我们是进程内库 + CLI + stdio MCP。对个人和 agent，「装一个依赖」比「跑一个实例」低一个数量级；也不会出现「忘了启动 / 端口被占」。
2. **网络位置**：SearXNG 假设实例的出口固定且可信，没有启动探测、没有按可达性排序，只有事后 suspend。它会在每次查询里重试注定失败的引擎，然后把空结果交给你。
3. **失败语义**：它有 `unresponsive_engines` 和错误类型，但结果本身不携带「这次为什么空 / 为什么少」；调用方拿到的仍是一个列表，不是一次带归因的尝试记录。而「够不着 / 够得着但被挑战 / 够得着但页面要 JS / 解析了但没结果」这四种，调用方的处置完全不同。

另外，**它的 70+ 引擎路线我们不该学**：无服务端、无遥测，维护 70 个解析器等于给自己判死刑。我们的路线应该是「少而稳」。

### 2.3 vs 单引擎抓取库：我们是编排 + 契约

`ddgs` 这类库把单引擎抓取做得比我们聚焦。我们的增量是回退、冷却、去重、直链、缓存、结构化失败——全是**集成成本**，不是算法优势。价值成立的前提是：用户确实需要「多引擎 + 可解释失败」，而不是「能搜就行」。

---

## 3. 由「不做服务端」推出的硬约束

| 约束 | 推论 | 对 0.1 的要求 |
|---|---|---|
| 无集中解析更新 | 只能靠发版传播修复 | 引擎定义数据化、一引擎一文件、fixture 进 CI；解析器变更走 minor 版本 |
| 无遥测 | 只能靠用户贴日志 | `--explain` 产出可以直接贴 issue 的诊断块；错误码稳定不漂移 |
| 无统一出口 | 不能做对抗 | 串行 + 最小间隔 + 尊重 429；不做代理池、不打验证码 |
| 无后端渲染 | JS 页面直接判死 | Google / Startpage 不进引擎表，不引浏览器依赖 |
| 无账号体系 | 不能给用户限流 | 默认限速就是产品诚实的一部分，写进 README |

最重要的一条推论：**发布频率就是可靠性。** 这个产品的维护模型和 SearXNG 相反——不是不断加引擎，是删掉坏引擎、快速修好能修的引擎。因此「引擎可插拔」不是扩展性洁癖，是唯一的维护通道，0.1 就要把接口定死，不能留到 M3。

顺带一个不客气的评估：这个工具**技术护城河接近于零**——三个解析器加一层编排，熟手一周能复刻。真正的资产只有三样：引擎失败的知识库（fixture + 归因规则）、集成面（DSH / MCP / CLI）、发版节奏。所以它更像「长期维护的基础设施」，而不是「产品」；定位和排期都该按前者来。

---

## 4. 由「效果依赖本地环境」推出的形态

### 4.1 本地环境到底影响了什么（本轮实测）

2026-10-20 23:25–23:26（+08），本机 node 进程直连、未设 `HTTPS_PROXY`：

| 观测项 | 读数 | 说明 |
|---|---|---|
| 出口 | `38.244.0.3`，US，NetLab Global | 时区/语言都是中文，出口却在境外——**「本机」不是一个稳定坐标** |
| DuckDuckGo lite | 23:25:36 → **202 挑战页**；23:26:13 → **200 + 10 条** | 同一 URL、同样请求头，37 秒后自行恢复 |
| Sogou | 302 → `/antispider/`，5,586 字节 | 交接单记的「5.4 KB 壳」量级吻合，**最可能是同一类反爬，不是页面结构** |
| Google | 200、92,689 字节、`enablejs`、**0 条结果** | 可达但不可解析 |
| Bing RSS | 200，10 个 `<item>`，带 `pubDate` | 目前最稳的机器可读端点 |
| Bing HTML | 200，10 个 `b_algo`，跳转带 `mkt=zh-CN` | 区域偏好是运行时变量 |
| Baidu | 200，889 KB，60 处 `baidu.com/link?url=` | 直链必须解跳转 |
| 360 | 200，7 个 `res-list` | 可用，解析器未写（M3） |

三条推论：

- 静态层标签（`direct-cn` / `direct-global` / `proxied`）只能当**初始猜测**，不能当引擎属性。Baidu 从境外出口照样 200；Sogou 从境外出口被反爬。
- 「挑战」是**时序状态**，不是引擎状态。37 秒就能自愈，统一 10 分钟冷却会误伤。
- 「可达」和「可用」是两件事。Google 可达、也能解析出 HTML，但结果为零——现有三态（reachable / challenged / unreachable）不够。

### 4.2 探测要用真实查询，不是 HEAD

建议 `argus probe` 的判据从「HEAD 通不通」改成「**一次真实查询 + 真实解析器**」，输出四态：

```
{ reachable, parseable, usable, results, reason }
```

这是本地工具才付得起的成本：一次金丝雀查询比十次 HEAD 有用得多，输出就是「此刻能不能搜」。这是这份备忘里唯一算产品点子的东西——SearXNG 和付费 API 都做不了（前者没有出口概念，后者不需要）。

### 4.3 结果带环境指纹

同一 query 在不同机器上结果不同，现在无法解释。建议 `SearchResult` 增加：

```
env: { at, enginesUsed, egress? }
```

默认只含引擎集与时间，出口信息只在 `--explain` 显示。这样「结果不可复现」就变成「结果可归因」——这是本地工具唯一能提供的可复现性，也是付费 API 永远给不了的（它们故意把环境抹掉）。

### 4.4 验收标准必须条件化

交接单 §10 的 1/2 条（≥3 条结果）在没有可用引擎的网络里必然红。改成条件式：

- probe 有 usable 引擎 → `sources ≥ 3`、全部 `http(s)`、不含 `baidu.com/link?`
- probe 全灭 → exit 4 + 完整 `attempts`
- 缓存、退出码、零依赖、无计费回归照旧

否则 CI 会随网络漂移而红，测试就不再是契约。

---

## 5. 交接单里需要修正的三处

1. **Sogou 判死依据不成立，且已实证。** 交接单的「5.4 KB 壳」来自境外出口（US 出口复测到 302 → `/antispider/`、5,586 字节）；大陆直连实测 200 / 11 条 / 0.95 s。M3 应把 Sogou 列回可用引擎，而不是判死。
2. **「DDG 必须先取 vqd」过强。** lite 端点不带 vqd、不带 cookie 实测能拿 10 条。正确顺序是：先直取 lite → 遇 202 再走 vqd + cookie + Referer。
3. **统一 10 分钟冷却过粗。** 202/429 应在 60–120 秒后重试（实测 37 秒自愈）；403/验证码才值得 10–30 分钟；parse-empty 走 10 分钟并留 fixture。

---

## 6. 需要拍板的四件事

| # | 决定 | 建议 | 理由 |
|---|---|---|---|
| 1 | `argus serve` 留不留 | **留，但降为可选**；主形态是 CLI + stdio MCP | 本地工具最常见的故障是「没启动 / 端口被占」，这正是 SearXNG 的负担 |
| 2 | 要不要支持用户自带 key | **要**，插件形式、默认关闭；第一适配器 DeepSeek Search/Fetch，第二博查 | keyless 是默认不是教条；反爬一收紧，BYOK 是唯一续命通道 |
| 3 | 引擎数量路线 | **3–5 个稳的**，不追 SearXNG | 无服务端无法维护长尾解析器 |
| 4 | 环境指纹含不含出口国 | 默认不含，`--explain` 可选 | 隐私默认最小化 |

> 关于「不做服务端」的理解：这里按「不做托管后端」处理——本地 `argus serve` 是否算「服务端」，属于决定 1。

---

## 7. 反方：什么情况下这产品不该做

- 目标用户主要是「偶尔搜一下」→ 内置搜索够用，装我们是负收益。
- 用户愿意按次付费 → 直接包 Tavily（境内用户则直接包 DeepSeek Search API，$0.75/1k），集成成本更低、质量更好。
- 真实用户集中在「大陆 + 无代理」→ 只剩 Bing RSS + Baidu + 360，DDG 的质量收益拿不到，产品退化成「百度去广告 + 必应 RSS」。**这是最可能的现实，也是最该先验证的假设。**（这个格子的三条替代路线见 §9）
- 引擎侧在 CDN 层封禁抓取 UA → 只能靠 BYOK 续命。

所以 0.1 的成功标准不是「三个引擎都能用」，而是：**任何一层可用时都能给出可用结果；全灭时给出可行动的原因。** 前者是功能，后者才是差异。

---

## 8. 一句话定位（可直接进 README）

> AuraArgus 不聚合搜索结果。它把问题路由到官方源，抓回页面，交出能回答问题的逐字段落和出处。
>
> 零 key、零按次计费、只向官方页发请求。覆盖范围等于注册表；不在表里的问题返回 `entity: null` 和退出码 2，不猜。

---

## 9. 大陆 + 无代理：更优解不是「更多引擎」

先把问题说准：这个格子的瓶颈不是引擎数量，是**英文/技术覆盖**和**中文 SEO 噪音**。加引擎解决不了这两件事——百度、360、Bing CN 共用同一批被 SEO 优化的中文页面，相关性高、增量小。

### 9.1 境内第一方搜索 API（最被低估的一条）

[DeepSeek Search & Fetch API](https://api-docs.deepseek.com/guides/search)：$0.75 / 1,000 次成功请求（≈¥5.4 / 千次），`api.deepseek.com` 境内直连，QPS 100，支持 `site:` / `lang:` / `after:` / `before:`，返回 `title / url / snippet / summary / date / authority / rerank_score`，空结果不计费；Fetch 同价，直接给 Markdown。

这是目前 CN 无代理格子里**质量、稳定性、维护成本三项同时占优**的方案。对轻度用户，1,000 次/月 ≈ ¥5.4——「零账号」的收益已经很小。

**但用户明确不付费，所以它默认不启用**：只作为可选的逃生口（配了 key 才走），不作为产品主路径。

代价也明确：要 key、要余额、查询经过第三方、供应方可以改价或停服（Bing 已演示过一次）。所以它不是替代品，是 **BYOK 的第一适配器**：有 key 的用户自动升级，没 key 的用户走默认层。

境内实测 `api.deepseek.com` 不带 key 返回 401 只用了 130 ms，比任何抓取路径都快——BYOK 在境内不只是质量最优，也是时延最优。

### 9.2 结构化源：不比引擎多，比引擎准

对 agent 的查询，很大一部分是「事实 / 代码 / 文档 / 论文」，答案在结构化端点上，不在 SERP 里。大陆直连实测可用：GitHub API 818 ms、npm registry 1.4 s、PyPI 465 ms、arXiv 882 ms、Stack Exchange 1.1 s；维基百科 API 9 s 超时（不可达）。

这条路的收益是**精度与速度**，维护成本远低于解析 SERP；代价是覆盖不了泛网页查询。它应该作为「按意图路由」的第一档，而不是搜索引擎的补充。

### 9.3 keyless 国内引擎：默认层，不是上限

大陆直连实测（2026-10-20 23:43，陕西联通 `123.139.251.154`，Clash 关闭）：

| 源 | 读数 | 说明 |
|---|---|---|
| Baidu | 200 / 20 / 1.1 s | 资讯 `tn=news`：200 / 15 / 0.7 s |
| Bing CN RSS | 200 / 10 / 116–411 ms | `www.bing.com` 自动跳 `cn.bing.com` |
| 360 | 200 / 7 / 0.38 s | |
| **Sogou** | **200 / 11 / 0.95 s** | 交接单判死是错的 |
| 头条 | 200 / 11 / 1.8 s | 重，但可解析 |
| Bing News RSS | 0 / 260 ms | 302 回 `cn.bing.com` 首页，不可用 |
| DDG / Google / Brave | 9 s 超时 | 不可达 |
| Yandex | 验证码 | 不可用 |
| 神马 / 中国搜索 | 有响应，未匹配结构 | 待定 |

**keyless 在境内可用集是 5 家**：Baidu、Bing CN、360、Sogou、头条——不是 3 家。

`mkt` 开关无效：`mkt=zh-CN`、`mkt=en-US`、`mkt=en-US&setlang=en` 三组返回同一批结果与域名（`nvidia.cn` / `nvidia.com` / `nvidia.com.tw` / `baike.baidu.com`），标题中文占比都是 0.26。**英文覆盖没有这个开关可拉**。

同一批结果还暴露了另一件事：查 `nvidia earnings` 时 Bing CN 前三条全是 nvidia 官网首页——导航式结果压过信息型结果。这正是「加引擎解决不了」的那类问题，本地重排的必要性又高一档。

> 另：公共 SearXNG 实例的 JSON 基本关着（`searx.be` 实测 0 条），所以「找个公共实例」不算方案。

这一层保证「零配置可用」，但它的质量天花板就是中文 SEO 生态的天花板。

**更严重的退化（2026-10-21）**：Bing 对无 cookie 的自动请求返回首词/导航式结果——`how to enable json format in searxng settings.yml` → 词典里的 “enable”，`custom search json api closed…` → 词典里的 “custom”，`python asyncio gather example` → python.org 首页，`Bing Search API retirement` → bing.com 首页。百度在约 30 次请求后跳 `wappass` 图形验证码；360/搜狗对中文查询仍正常。交接单里「Bing 偏官网首页」的观察，实际是查询解析退化，不是排序偏好。

### 9.4 性价比最高的一招：本地重排

CN 格子里真正拉开体感差距的不是「又接了一个引擎」，而是**把百度/必应前十条里的广告、聚合站、洗稿站清掉**。纯本地可做：

- 域名信任表（gov.cn / edu.cn / 官方文档 / 原始媒体 / GitHub …）
- 黑名单（内容农场、聚合转载、下载站）
- 时间衰减 + 跨引擎去重 + 同站限流

这张表是可版本化的数据资产，不需要服务端，也不随引擎改版失效——它比多接两个引擎更能提高「看起来的对」。这也是 Aura 系列最容易做出辨识度的地方：**一份持续维护的中文域名质量表**。

### 9.5 成本分区（决定 target user）

| 月搜索量 | 境内 API 成本 | keyless 的优势 |
|---|---|---|
| 1,000 | ≈ ¥5.4 | 可忽略（零账号仍有意义） |
| 10,000 | ≈ ¥54 | 开始明显 |
| 50,000 | ≈ ¥270 | 显著 |

结论：**keyless 的价值随用量线性放大**。轻度用户没有理由不用 API；keyless 的真实用户画像是「重度 + 零账号 + 查询不能过第三方」。这不是巧合，是这个产品的天然边界。

### 9.6 所以产品该怎么改

1. 默认仍是 keyless 三件套（Baidu / Bing CN / 360），保证零配置可用。
2. 加「结构化源」作为第一档路由（按查询意图：代码 / 论文 / 新闻 / 事实）。
3. 加 BYOK 适配器（DeepSeek 第一，博查第二），`argus doctor` 检测到 key 就提示「可升级」。
4. 把「本地重排」当成 0.1 的一等功能，不是后期优化。
5. README 不要再写「省钱」，写「不被任何一家供应商卡住」——省钱这件事已经被境内 API 打到 ¥5 / 千次了。

---

### 9.7 最小验证：召回压倒表示（2026-10-21）

6 个英文技术问题，12 条金标准事实（按提问计）：

| 路 | 材料 | 命中 |
|---|---|---|
| A | 10 条链接 + 摘要（keyless） | 3 / 12 |
| B | 逐字段落 + 出处（keyless 召回 + 本地抽取） | 4 / 12 |
| C | 官方 Search API（`deepseek-search-api`） | **11 / 12** |

**中途撤回一次**：第一次跑 C 时 `web.searchProvider` 被钉在 `aura-keyless`，三路同源，C 只拿到 2/12；那轮不是「官方 vs 我们」，已作废。

**结论**：

1. **召回是命门。** 官方 11/12，keyless 3–4/12；表示层（链接→段落）只把 3 拉到 4，在召回失败面前没有意义。
2. **keyless 在 CN 无代理下的真实形状**：Bing 对无 cookie 请求返回首词/导航式结果（`how to enable json format...` → 词典 “enable”）；百度约 30 次后跳 `wappass` 验证码；DDG/Google 不可达；360/搜狗只有中文。
3. **官方也不是完人**：C 把 QPS 答成 5（第三方站），官方文档写的是 100。这暴露了下一层价值——**权威源优先级 + 逐字段落**，而不是再多接几个引擎。

**产品含义**：官方索引强，但用户明确不付费，所以它不是默认路径。免费路径见 §9.8。

---

### 9.8 免费路径：不经过 SERP，直接抓源

用户明确不付费，所以 §9.1 的官方 API 只能当可选逃生口。问题变成：不交钱，还能不能拿到这些事实？实测（CN 直连，Clash 关闭）：

| 源 | 直连结果 | 含金标准事实 |
|---|---|---|
| api-docs.deepseek.com | 200 / 26 KB | 0.75 |
| learn.microsoft.com | 200 / 47 KB | 2025、Grounding with Bing |
| tavily.com | 200 / 78 KB | 0.008、1,000 |
| docs.searxng.org | 200 / 50 KB | formats、3600 |
| developers.google.com | 连接超时 | — |
| developers.google.cn（镜像） | 200 / 63 KB | 2027、100 |

发现路径也验证了：

- DeepSeek sitemap：200 / 54 个 URL；Tavily sitemap：200 / 136 个 URL
- SearXNG 文档索引页：1 跳就能找到 `settings_search.html`（锚文本 “search:”）
- MS Learn `/sitemap.xml` 404（需按站内索引或 URL 模式）

**结论**：这些页面在 CN 直连可达且含答案；失败的不是网络，是 URL 发现。所以免费路径不是「更多引擎」，而是 **source router**：

1. 实体 → 官方域名注册表（少量、可维护）
2. 发现：sitemap → 站点索引 1 跳 → URL 模式
3. 抓取 → 抽正文 → 选段 → 带出处
4. 兜底：中文网页走 360/搜狗（0.1 起改为 opt-in；实测反爬不稳定）；英文泛查询承认覆盖不足

这正好回答「是不是陷进 SERP 聚合」：是。聚合的边际信息接近 0，而**每多一个官方源，回答能力是跳变的**（DeepSeek 文档、微软生命周期、SearXNG 设置页，各自独立）。

**MVP 实测（`eval/run.mjs`）**：6 题对照实验 **13/13**；扩展覆盖评测 **31 题 / 141 项全过**（18 个实体、中英文、别名、未知实体），总耗时 27.8 s、证据 77,646 字符；无 key、无 SERP、无代理。

**0.1 交付（2026-10-21）**：`aura-argus` 提供 CLI / HTTP / MCP stdio / Node 库 / DSH 适配器五种入口；注册表 **18 个实体 / 34 个源**；`npm test` **51/51**；`npm run eval` **31 题 / 141 项硬检查全过**（soft 兜底改为 opt-in）；批量（c=3）比串行快 **3.14×**；`npm run verify-dsh` **8/8**（`--live` 9/9）；`npm pack` 约 22 KB、零依赖。DSH 侧同时提供 provider 适配器与 MCP server：前者替换引擎（仍受 `tool-web` 契约），后者暴露原生工具（完整 passages / batch / 逐 query 归属），并通过 `initialize.instructions` 自动注入 systemPrompt。跨 agent 实测：Codex CLI、Hermes 走 MCP；ZCode 走 CLI/skill。安全：默认拒绝私网，`--allow-private` opt-in；fallback 默认关闭。

**0.3 交付（2026-10-23）**：默认站点包（**42 站点 / 71 源**）+ 选段 v2；合并覆盖 **74 实体 / 166 源**；`npm test` **69/69**；`npm run eval` **40 题 / 184 项硬检查全过**（soft 2/2）；`npm run verify` **166/166 可达**；批量冷启动 **2.79×**；`--no-sites` / `--sites-file` 贯通 CLI / HTTP / MCP。中国开发者常用的一手文档（阿里云、腾讯云、微信小程序、通义千问、Kimi、Spring Boot、MySQL 等）进入默认路由。

**0.5 交付（2026-10-23）**：多实体对比路由 + 一跳链接跟随 + confidence/facet 契约 + 持久页缓存/ETag + `warm`；合并覆盖 **74 实体 / 167 源**；`npm test` **78/78**；`npm run eval` **43 题 / 205 项硬检查全过**（soft 2/2；p50 785 ms / p95 1236 ms）；`npm run verify` **167/167 可达**；批量冷启动 **2.99×**。MCP 返回 structuredContent + outputSchema。

**0.6 交付（2026-10-23）**：覆盖率扩到 **90 实体 / 194 源**（新增 Azure、GCP、Mistral、Hugging Face、LangChain、Ollama、MongoDB、SQLite、Elasticsearch、Prometheus、Grafana、Angular、Svelte、PyPI、GitHub Advisory、Flutter）；`npm test` **81/81**；`npm run eval` **59 题 / 285 项硬检查全过**（soft 2/2；p50 792 ms / p95 1772 ms）；`npm run verify` **194/194 可达**；新增 opt-in 本地缺口日志与 `gaps` 命令。

**0.7 交付（2026-10-23）**：本地 section 索引 + **fast 模式**（事实型查询约 2 ms 命中，开放问题回退 live）；`npm test` **83/83**；`npm run eval` **59 题 / 285 项硬检查全过**（soft 2/2；p50 835 ms / p95 1976 ms）；`eval --fast` **59/59 全过**，10 题命中索引；`npm run verify` **194/194 可达**；索引 42 实体 / 8,120 段 / 2.19 MB。

**0.8 交付（2026-10-23）**：版本文档路由（Node 18–24 / Python 3.9–3.13 / PostgreSQL 14–18 / MySQL 8.0/8.4）+ 新鲜度元数据（`updated` / `etag`）；`npm test` **87/87**；`npm run eval` **60 题 / 290 项硬检查全过**（soft 2/2；p50 850 ms / p95 1402 ms）；`eval --fast` **60/60 全过**，10 题命中索引；`npm run verify` **194/194 可达**。

**0.9 交付（2026-10-23）**：取消传播（`AbortSignal` / MCP `notifications/cancelled` / HTTP 断连）+ MCP 批量进度通知；`npm test` **92/92**；`npm run eval` **60 题 / 290 项硬检查全过**（soft 2/2；p50 863 ms / p95 1675 ms）；`eval --fast` **60/60 全过**，10 题命中索引；`npm run verify` **194/194 可达**。

**1.0 交付（2026-10-23）**：稳定线；`schemaVersion: 1` 契约冻结（CONTRACT.md）+ answerability 发布门；`npm test` **94/94**；`npm run eval` **60 题 / 290 项硬检查全过**（soft 2/2）；`npm run answerability` **59/59（100%）**，p95 1716 ms；`npm run gate` **pass**；`eval --fast` **60/60 全过**，10 题命中索引；`npm run verify` **194/194 可达**。

**1.1 交付（2026-10-23）**：覆盖率 **103 实体 / 217 源**（新增 Ruby、Scala、Cassandra、Ansible、Istio、Argo CD、Jest、Cypress、pytest、Flask、Express、Helm、OTel）；`npm test` **94/94**；`npm run eval` **73 题 / 355 项硬检查全过**（p50 905 ms / p95 1504 ms）；`npm run answerability` **72/72（100%）**；`npm run gate` pass。

**1.2 交付（2026-10-23）**：查询意图识别 + `--decompose` 复合问题拆句并行检索（按 URL 合并证据、保留 clause 归属）；`npm test` **97/97**；`npm run eval` **74 题 / 361 项硬检查全过**（p50 929 ms / p95 2746 ms）；`npm run answerability` **73/73（100%）**；`npm run gate` pass（1.2 阈值 3000 ms，1.3 恢复 2500）。

**1.3 交付（2026-10-23）**：自适应扇出 + 枢纽页保护（事实/价格/版本类在 facet 全覆盖且置信度 ≥0.75 时早停；父路径源禁止早停）；修正 howto/version 意图优先级与 `发布` 误判；多实体单实体源上限改为 2；**p95 从 2746 ms 降到 2191 ms**，发布门恢复 2500 ms；`npm test` **98/98**；`npm run eval` **74 题 / 361 项硬检查全过**；`npm run answerability` **73/73（100%）**。

**1.4 交付（2026-10-23）**：可引用证据（稳定 passage/source `id`、`headingPath`、`anchor`、`citation`、提取 Markdown 行号）；fast 索引与 fallback 证据同样带 citation；CONTRACT 增加 Passage 契约；**p95 1958 ms**；`npm test` **99/99**；`npm run eval` **74 题 / 361 项硬检查全过**；`npm run answerability` **73/73（100%）**。

**1.5 交付（2026-10-23）**：结构化事实抽取（price/percent/version/date/limit/status，按意图过滤，链接回 passage/citation）；非自适应意图恢复并行抓源，**p95 1958 → 1521 ms**；MCP/OpenAPI/CONTRACT 增加 facts 契约；`npm test` **102/102**；`npm run eval` **74 题 / 361 项硬检查全过**；`npm run answerability` **73/73（100%）**。

**1.6 交付（2026-10-23）**：跨来源 `consensus`（一致值、冲突值、`agreementRatio`；多值价格表不判冲突），MCP/OpenAPI/CONTRACT 增加一致性契约；`npm test` **106/106**；`npm run eval` **74 题 / 361 项硬检查全过**（p50 821 ms / p95 1705 ms）；`npm run answerability` **73/73（100%）**。

**1.7 交付（2026-10-23）**：`mode: fast|balanced|deep` 检索预设 + `budgetMs` 墙钟预算，预算耗尽返回 `partial` 证据与 `budget` 元数据；CLI/MCP/HTTP/OpenAPI/CONTRACT 同步；`npm test` **109/109**；`npm run eval` **74 题 / 361 项硬检查全过**（p50 868 ms / p95 1746 ms）；`npm run answerability` **73/73（100%）**。

**1.8 交付（2026-10-23）**：零依赖 JS 客户端 `aura-argus/client`（health/sources/search/searchBatch/fetch，token/超时/取消）+ MCP resources（coverage/health/entity 模板）；`npm test` **113/113**；`npm run eval` **74 题 / 361 项硬检查全过**（p50 864 ms / p95 1629 ms）；`npm run answerability` **73/73（100%）**。

**1.9 交付（2026-10-23）**：增量索引（新鲜实体直接复用，过期按源 ETag/Last-Modified 重验证，304 复用 section；manifest v2）；`npm test` **114/114**；`npm run eval` **74 题 / 361 项硬检查全过**（p50 910 ms / p95 1819 ms）；`npm run answerability` **73/73（100%）**。

**2.0 交付（2026-10-23）**：Agent 基准（成功率/引用完整性/事实链接/p95，发布门）+ 同主机并发上限（默认 4，`AURA_ARGUS_HOST_CONCURRENCY`）；`npm test` **117/117**；`npm run eval` **74 题 / 361 项硬检查全过**（p50 841 ms / p95 1810 ms）；`npm run answerability` **73/73（100%）**；`npm run bench:agent` **73/73，score 1.0**。

**2.1 交付（2026-10-23）**：缺陷修复版（引用 ID 跨源冲突、facts 跨源去重、客户端超时错误码、全量索引旧 ETag、decompose 预算放大、consensus 来源重复、OpenAPI mode 枚举；缓存键 v4）；`npm test` **120/120**；`npm run eval` **74 题 / 361 项硬检查全过**（p50 880 ms / p95 1826 ms）；`npm run answerability` **73/73（100%）**；`npm run bench:agent` **73/73，score 1.0**。

**2.2 交付（2026-10-23）**：官方站递归发现 + `index --deep` 深索引 + `--deep-index` 查询；自持网页兜底（SearXNG 优先、Bing/360/DDG keyless 适配，不依赖商业搜索 API）；代码块整体选段与置信度校准；held-out 4/4（p50 59 ms / p95 109 ms）；`npm test` **125/125**；`npm run eval` **74 题 / 361 项硬检查全过**（p50 821 ms / p95 2481 ms）；`npm run answerability` **73/73（100%）**；`npm run bench:agent` **77/77，score 1.0**。

**2.3 交付（2026-10-23）**：CLI/MCP/HTTP 默认 `fallback=auto`，官方证据优先，官方不足才触发 SearXNG/keyless 网页兜底；兜底扩到 4 页并记录 officialSources/webSources；`--no-fallback` 可关闭；`npm test` **125/125**；held-out **4/4**；`npm run bench:agent` **77/77，score 1.0**。

**2.4 交付（2026-10-24）**：公开 API/CLI 统一到 `aura_argus_*`，旧名保留兼容别名；deep index 覆盖全部实体；版本/错误排名与 answerability 守卫补强；`npm test` **134/134**；`npm run eval` **74 题 / 361 项硬检查全过**（p50 1035 ms / p95 2408 ms）；answerability **73/73（100%）**，gate pass；held-out **4/4**；`bench:agent` 当前 **62/77（0.805）**，作为 2.4.x 回归修复项，不把它写成已达到旧版 77/77。

---

## 附：证据与复跑

| 证据 | 位置 / 命令 |
|---|---|
| Bing Search APIs 于 2025-08-11 退役 | [Microsoft 生命周期公告](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement) |
| Google CSE 对新客关闭、2027-01-01 停服、$5/1k、100 次/天免费 | [Custom Search JSON API 文档](https://developers.google.com/custom-search/v1/overview)（页面更新 2026-02-18） |
| SearXNG `formats` 默认仅 html、引擎冷却时间表 | [SearXNG search settings](https://docs.searxng.org/admin/settings/settings_search.html) |
| Tavily 价格（$0.008/credit，1,000 credits/月免费） | [Tavily pricing](https://www.tavily.com/pricing) |
| Brave 每月最高 $20 免费额度、预付制 | [Brave Search API](https://brave.com/search/api/) |
| OpenSERP（自托管、开源、6 引擎） | [openserp.org](https://openserp.org/) |
| DeepSeek Search/Fetch 定价与契约 | [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)、[Search & Fetch 指南](https://api-docs.deepseek.com/guides/search)（2026-10-20 抓取） |
| 本轮网络实测（引擎） | `node .tmp/probe2.mjs`（临时脚本，未入库；输出会随网络状态变化） |
| 本轮补充源实测（结构化 / 国内引擎） | `node .tmp/probe3.mjs`（同上） |
| 大陆直连快照（Clash 关闭） | `node .tmp/cn-matrix.mjs` → `.tmp/cn-matrix-*.json`；Bing `mkt` 对照 `node .tmp/bing-mkt.mjs` |
| 最小验证 A/B/C | `.tmp/exp/PROTOCOL.md`、`run-retrieval.mjs`、`artifacts-*.txt`；Bing 退化对照 `query-lang.mjs` / `bing-html.mjs` / `neutral.mjs` |
