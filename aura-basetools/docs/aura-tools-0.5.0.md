# aura-tools 0.5.0 —— 服务化升级 + 语言表扩容（含一处未完成的诚实话）

**这一版两条主线**：① 升级也服务化了（可升级、可回滚、原子、默认不联网、装完自检、失败自动回滚）；
② 语言表从 44 种扩到 **62 种**——21 种目标格式里 **18 种已登记**（15 种符号表与 `target=` 可用）。
③ 三套靶场与一条发布闸变成**常设验收**。④ 一次真实事故的处置与余留不确定性，写在最后一节。

---

## 一、服务化升级（P0 完成）

### 命令

| 命令 | 行为 | 退出码 |
| --- | --- | --- |
| `--check [--manifest <本地文件\|URL>] [--channel stable\|beta]` | 只比版本；**没给清单就不联网**并明说；`--check-url` 是唯一显式联网开关 | 0 |
| `--upgrade --from <目录\|.tgz\|.zip\|URL> [--manifest …]` | staging → 预检 → 版本比对 → 备份 → **原子换名** → 终检 → 失败**自动回滚** → 写状态 | 0 / 2 / 1 |
| `--rollback` | 从 `previous/` 换回上一版；先预检，**坏的那份不让它上位** | 0 / 2 |
| `--version` / `--doctor` | 版本 + **构建戳 + 整树哈希** + 三面版本；doctor 还报 MCP 握手版本、journal 残局与下一步命令 | 0 / 2 |
| `--dry-run` | 以上任何动作可预演，零落盘 | 0 |

### 安全属性（每条都有验收，不是声明）

- **预检先于任何写入**：坏包被拒时现网**一个字节都没变**（含 mtime 指纹）；
- **原子换名**：中断（含**真 SIGKILL**）后磁盘只能是"完整旧版 / 完整新版 / 唯一的 after-clear 窗口"；
- **终检失败自动回滚**：换名后终检不过 → 回滚到 `previous/`，回执 `UPGRADE_FINAL_CHECK_FAILED_ROLLED_BACK` + `rolledBackTo`；
- **崩溃自愈**：`.upgrade-journal` + `--doctor` 能识别"上次停在哪"，`--rollback` / 重跑 `--upgrade` 都能收尾；
- **校验**：zip 解包**全部条目 CRC 通过后才落盘**；清单给了 `sha256` 就比对（不符 → `UPGRADE_SHA256_MISMATCH`）；
- **同版不同字节**：版本号相同但树哈希不同 → `UPGRADE_SAME_VERSION_DIFFERENT_BYTES`（0.4.2 那条"同版本号两份字节"的教训已落成代码）；
- **默认不联网**：测试用 `NODE_OPTIONS` 注入 fetch 哨兵，真发请求就失败；
- **退出码契约**：0 成功 / 2 结构化拒绝 / 1 用法错；拒绝回执平铺 `code`/`stage`/`from`/`to`/`liveUntouched`/`reason`。

### `install.json` 新增字段

`treeHash`（整树哈希）、`buildStamp`（`版本+树哈希前12位`）、`previousVersion`、`upgradedAt`/`rolledBackAt`、`surfaces{cli,mcp,dsh}`、`lastFailure`。

### 测试缝

`AURA_UPGRADE_FAULT=<阶段>`：`after-staging` / `after-precheck` / `after-backup` / `after-clear` / `after-swap` /
`final-check`（**不中止**，故意弄坏刚换上的那份让终检真失败）/ `after-rollback-swap`；
`AURA_UPGRADE_FAULT_DELAY_MS` 让它在阶段处停住，供测试从外面真 SIGKILL。

### 验收

| 套件 | 归属 | 结果 |
| --- | --- | --- |
| `build/upgrade-test.mjs` | 实现者 | **94/94** |
| `build/audit-upgrade-probe.mjs` | **审计方独立写** | **31/31**（含坏 zip 翻 bit、清单 sha256 不符、同版不同字节、真实 home 守卫） |
| `build/install-test.mjs` | 审计方 | 33/33 |

---

## 二、语言表：44 → 62 种（21 种目标格式里 18 种已登记）

**已可用（符号表 + `target=` 往返实测通过，15 种）**：`sql` `graphql` `gql` `tf` `vue` `svelte` `astro`
（批 1）；`r` `ex` `exs` `clj` `cljs` `el` `vim` `cython` `ml`（批 2）。

**已登记但符号不可用（3 种，如实列出）**：
- `erl`：只出 `module:alpha`，函数子句 `beta(A) -> …` 提不出来（`->` 判定未过）；
- `hs`：跨度不完整，且会把形参 `a` 报成假符号（`$param*` 贪心）；**因此 Haskell 目前不能用于 `target=`**；
- `nl`/`ml` 已可用，`hs` 不可用——三种里 `ml` 是好的。

**未登记、明确算覆盖缺口（3 种）**：`hrl` `nim` `zig`。根因已单步实测到**引擎匹配原语**层面：
1. `hrl` `-define(ALPHA, 1).`：模式到 `('$name'` 都能匹配，**加上 `')'` 就 null** —— `$param*`/`$ident*`
   都吃不下 `, 1` 这种"逗号 + 字面量"段；
2. `nim` `proc alpha(a: int): int =`：`$mods*` 与字面量 `proc` 互相抢 token；
3. `zig` `fn alpha(a: i32) i32 {`：`$ident*` 出现在模式**末尾**时会退化成"跳一个可选括号组"，
   吃不下裸标识符返回类型。

> 这三条**没有靠"给夹具补内容"掩盖**：靶场元数据按实测翻回 `indexed: false`，靶场因此全绿，
> 而缺口写在这里、根因留在审计档，等下一轮从**匹配原语**层面解（不是再叠 language 配置）。

其它如实说明：`tf` 捕的是 HCL **第一个标签**（`resource "aws_instance" "web"` → 符号名 `aws_instance`）；
`vue`/`svelte` 关掉了正则字面量（代价：JS 正则里的引号会被误当字符串）；
Elixir 一行式 `def beta(a), do: a + 1` 刻意不给跨度（`do:` 不是块引导词）⇒ `target=` 会 fail-closed 拒绝。

---

## 三、常设验收（新增资产）

| 资产 | 作用 | 当前 |
| --- | --- | --- |
| `src/locator-lab/range-formats-test.mjs` | 把**扩展名当自变量**：80 个夹具 × 读/写/边界 | **3306/3306** |
| `src/aura-standalone/test/range-bytes-test.mjs` | 字节层：BOM×4、7 种行尾、单 `\r`、二进制、Unicode、尺寸阈值、陈旧闸门 | **217/217** |
| `src/locator-lab/range-args-test.mjs` | 参数形状与原子性：三面 × 各种写法 + 拒绝码 | **76/76** |
| `src/locator-lab/lang-coverage-test.mjs` | 每个新语言的符号/跨度/`target=`/负向 | **195/195** |
| `build/release-check.mjs` | **发布前全量闸**：18 套既有 + 3 靶场 + 包内 + 安装器 + 升级（两层）+ `src↔dist` + 版本 + DSH 就绪 | 见发布记录 |
| `build/audit-upgrade-probe.mjs` | 审计方独立写的升级对抗检查 | **31/31** |

> 靶场抓到过的真问题（含本轮）：Kotlin 跨度回归（改共享逻辑时把 `(` 当块开符）、Clojure `defn` 符号
> 消失的回归、`hrl/nim/zig` 零符号、`hs` 假符号、以及一次**删夹具**的红线事件（已恢复）。

### 发布闸抓到的一件事（记下来供以后避免）：测试里**写死版本号**
版本从 0.4.2 升到 0.5.0 后，发布闸第一次跑就红了 31 条：两个升级套件把 `'0.4.2'`/`'0.5.0'`
当“当前版/下一版”写死，而升版后现网恰好就是 0.5.0 → 安装器**正确地**报了
`UPGRADE_SAME_VERSION_DIFFERENT_BYTES`（同版不同字节），断言因此连锁失败。
修法：基准版本从**包体**读（`BASE_VERSION` / `NEXT_VERSION`），标签改成与版本无关的说法，
`--version` 的断言改成匹配任意语义化版本。
**教训：测试里凡版本都从产物取，不写死** —— 否则每次发布都会自己撞自己。

---

## 四、事故：真实 `$HOME` 被写（处置与余留不确定性）

**原因（已确证）**：子代理在 PowerShell 里写 `$home = Join-Path $demo "home"` —— `$home` 是 PowerShell 的
**只读自动变量**（`$HOME`），赋值静默失败，后续命令实际用 `C:\Users\cxk` 当 `--home`；更重的是演示里那句
给"假 HOME"播种的 `Set-Content ...\.codex\config.toml` **覆盖了真实配置**（10,447 B → 41 B）。

**处置（已核实）**：用事故前最新完整备份整体还原 → **10,458 B**；我**独立核对**：与我的备份逐行比较
**只差 2 行**（`[mcp_servers.aura]` 的 args 指向现存路径，属必要更新），`python tomllib` 解析通过
（19 段；`mcp_servers` = aura, aurabridge, cua_repl, node_repl, tavily, vesta；`model_providers.deepseek` 在）；
照该条命令握手 `serverInfo {name: aura-tools, version: 0.4.2}` + 两个工具都在；stray `~/.aura/pkg` 已清，
`~/.aura` 只剩合法的 `observations.json`。

**余留不确定性（不粉饰）**：23:41 → 00:28 之间若真实配置另有改动，无法证明已逐字节复原；
该文件是**活的**（核查期间宿主自己重写过它）。**建议你在宿主重启后再核一遍。**
**双边守卫**：实现者的升级测试有"整个套件没往真实 $HOME 写东西（含 mtime）"断言（正是它抓到这次事故）；
我的独立探针也补了同款两条（`~/.aura` 清单 + `~/.codex/config.toml` 哈希）。

---

## 五、已知边界（累计）

`"lines": 412, 500` 这类**非法 JSON** 只能由宿主拒（工具拿不到参数）；DSH 工具面**需重启宿主**才生效
（MCP/CLI 立即生效）；`--check` 不强制 `minNode`（只如实报要求，强制点在 `--upgrade`）；
加密 zip 条目会被报成"包体损坏"（不专门说"这是加密的"）；`after-clear` 那一瞬现网目录会缺席
（文件系统没有"原子对调目录"，靠 journal + `--doctor` + `--rollback` 自愈）；
远程清单的相对 url 只做了代码级修正（本机无网络，未动态验证）；macOS/Linux 未在本机验证；
单 `\r` 行尾、二进制、>256 KiB 不进观测缓存（与 0.4.x 相同）。

---

## 六、升级到本版

```bash
node <安装目录>/install.mjs --upgrade --from ./aura-tools-0.5.0.tgz   # 或 --from <目录|.zip>
node <安装目录>/install.mjs --doctor                                  # 体检（含三面版本）
node <安装目录>/install.mjs --rollback                                # 后悔了退回上一版
```
