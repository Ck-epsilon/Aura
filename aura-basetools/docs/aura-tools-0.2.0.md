# aura 读写工具 0.2.0 —— 保真、闸门与回读校验

**日期**：2026-09-22 ｜ **包**：`dsh-tool-aura-read@0.2.0`（原 0.1.0）· `dsh-tool-patch@0.2.0`（原 0.1.0，即 `aura_edit`）
**范围**：C9–C14 六轮施工。每一轮都经主代理**亲手复核**（11 个套件重跑 + 全仓哈希改动面 + 补丁审计 + 变异反证）并在宿主重启后跑过真机重放；审计件在 `.polaris/snapshots/20260921-*`～`20260922-*`。

## 一句话

读侧不再给"只有签名行"的跨度，写侧不再静默改写你没寻址的字节，**每一次落盘都会被读回来验一遍**；没断言过的编辑若其区域被第三方动过，会**结构化拒绝**而不是静默覆盖。

## 修掉的六个静默失效（全部是实测出来的，不是推断）

| # | 现象 | 实测证据 | 现在 |
|---|---|---|---|
| 1 | 缩进语言（py/rb/scala/sh/cython/batch 六个配置）符号跨度只覆盖签名行；`target=<函数>` 只换签名、旧函数体残留，`py_compile` 仍返回 0 | 10 语言 fixture：py `2-2`、rb `1-1`（函数体到第 5 行）；`struct-core.mjs:351-352` 注释明写"不追进函数体" | 跨度覆盖整段；判不出来的语言 **fail-closed**（`LOCATOR_SPAN_INCOMPLETE`，消息给 `lines=` 替代） |
| 2 | 编辑带 BOM 的文件会**永久丢掉 BOM**，且版本令牌分辨不出只差 BOM 的两个文件 | 20→17 字节；两文件同令牌 `360f9e98:11` | BOM 个数进令牌、写回按个数补齐（只补不删）；真机矩阵实测保留 |
| 3 | 双/三 BOM 文件编辑后**少一个 BOM**（"已经有了就不加"的布尔幂等守卫误判） | 23→22 字节 | 从字节数出**个数**再补齐，窗口按需翻倍、无固定上限 |
| 4 | 混合行尾文件只改一行，**整份**被按多数派归一 | 改第 4 行 ⇒ 第 2 行 `\r\n`→`\n`（24→23 字节）；根因在提供方 `editText`（`dsh-fs-local:566,569-572,582-583,848`） | 写回改走 `writeText + {kind:'replaceIfVersion'}`（逐字节落盘 + 提供方级版本 CAS）；后端无 `writeText` 且文件混合行尾 ⇒ **拒绝**，不降级去走会改坏字节的路 |
| 5 | 陈旧的 `lines=` 寻址**静默覆盖**第三方改动，或**静默改到别的行** | 真机：`"line three CHANGED BY B" → "line three (A overwrote)"`；顶部插两行后 `"alpha" → "CHARLIE (A meant charlie)"` | **区域级新鲜度闸门**：未带 `expect` 的 hunk 若其区域在"上次观测"之后变了 ⇒ 拒绝 `PATCH_STALE_REGION` + 最小重读范围；**改别处不误杀**（判据只看被寻址区域的文本） |
| 6 | 提供方若改写了落盘内容，工具自己一声不吭 | 第 2、4 条当初都是**外面拿探针量出来的** | 落盘后**整份逐字节回读**：不符即 `WRITE_VERIFY_FAILED`（不回滚、不假装成功），错误对象带两边字节数 / 首个差异偏移 / BOM 有无 / 行尾普查（crlf·lf·cr） |

## 与内置 `read` / `write` / `edit` 的对比（2026-09-22，两边都当场实测）

| 能力 | 内置 `read`/`write`/`edit` | `aura_read`/`aura_edit` | 证据 |
|---|---|---|---|
| 编辑带 BOM 的文件后 BOM | ❌ **静默丢失**（20→17 字节，首字节变 `97,108,112`） | ✅ 保留（真机 15 形态矩阵 12/12） | 今天实测 |
| 编辑混合行尾文件 | ❌ **整份归一到多数派**（24→23 字节，被寻址行之外也改） | ✅ 只改被寻址行，其余字节与行尾逐字节不变 | 今天实测 |
| 整文件覆写 | ✅ `write`（全量替换） | ❌ 刻意不支持（覆盖必须走寻址 + `expect` 那条路） | M10 |
| 定位方式 | 唯一字面量（对不上就失败） | 四层：`target` 符号 / `lines` 行区间 / `line_cue` 唯一词 / `anchor` 记忆文本（五级降级匹配） | README §接口 |
| 陈旧行号寻址 | 不适用（没有行号寻址） | ✅ 区域级新鲜度闸门，拒绝并给最小重读范围 | 今天实测 |
| 多 hunk 原子性 | ❌ 一次一 hunk | ✅ 任一失败则磁盘完全不变 | `load-test` |
| 落盘前预演 | ❌ | ✅ `dry_run`（只定位不落盘） | `load-test` |
| 落盘后自检 | ❌ | ✅ 整份逐字节回读（`write_verify`） | `write-verify-test 42/42` |
| 写前必须先读 | ✅ 强制（`FS_NOT_OBSERVED`） | ✅ 自己读全文并 `emit fs/observed` | 两侧同契约 |
| 版本陈旧 | ✅ `FS_STALE_VERSION` | ✅ 提供方级 `replaceIfVersion` + 区域级闸门（两层） | `write-verify` 段F |
| 结构导航 | ❌（先 grep 再整读） | ✅ `map`/`digest`/`around`/`search`/`changed` | `read` 侧 50/50 |
| 二进制文件 | ❌ 拒绝（`FS_NOT_TEXT`） | ❌ 拒绝（同码） | 两侧一致 |
| 删除 / 改名文件 | ❌ | ❌（两侧都没有，需 shell） | — |

**一句话结论**：`write` 仍是整文件覆写的唯一手段（aura 侧刻意没有这条路）；除它之外，本版 `aura_read`/`aura_edit` 在**字节保真**与**写前写后自检**上已经超过内置三件套，且这些差距不是设计声明而是**当天实测的数字**。

## 验收与守卫

- **11 个套件全绿**：`write-verify 42/42` · `stale-gate 49/49` · `byte-fidelity 94/94` · `encoding 32/32` · `span-fidelity 95/95` · `policy-arg 12/12` · `aura-read 50/50` · `aura-edit 41/41` · `struct 28/28` · `align 12/12` · `corpus 44 扩展名`。
- **变异反证**（守卫必须有守卫，主代理亲手打的）：判据恒 false ⇒ 9 条红；整体回退引擎 ⇒ 新测试必红；消费端塞回 BOM 前缀 ⇒ `stale-gate` 段K 四条红；去掉版本守 ⇒ `policy-arg` 11/12 且 `byte-fidelity` 段F 红；回读降级为文本级 ⇒ `write-verify` 段A/B 红。
- **真机重放**（宿主重启后）：f1/f3 陈旧寻址 ⇒ **拒绝且磁盘保持第三方内容**；BOM 接缝（带 BOM + `changed` 读 + 无 `expect` 改第 1 行）⇒ 成功；15 形态往返矩阵 ⇒ **12/12** 除目标行外逐字节不变。

## 已知边界（诚实列出）

- **单 `\r`（老 Mac）行尾不支持**：行号是跨层共享判据（符号表那层只按 `\n` 数行），只在一侧按 `\r` 断行会让 `target=` 静默指错。拒绝消息给出 `lines=[1,1]` / `line_cue` / `anchor` 三条替代。
- **降级路径**：后端无 `readByteRange` ⇒ 回读退化为文本级（回执 `level:'text'` 如实写明看不见 BOM/行尾）；后端无 `writeText` ⇒ 混合行尾文件直接拒绝。当前部署（`dsh-fs-local` / `dsh-fs-sandbox`）两者都有。
- **观测缓存是进程内的、上限 8 条**：换进程或被淘汰后退化为"未观测"（回执带 `unverified_region`），只可能少拦，不会误拒。
- **回读窗口内的第三方插入**会被报成 `WRITE_VERIFY_FAILED`（保守方向：宁可误报也不静默）。
- **不判断"是谁改的"**：`others[].by` 恒为 `unknown-writer`（注册表层尚未建）。
- `aura-edit/package.json` 的 `name` 仍是历史的 `dsh-tool-patch`，与目录名/插件 id `dsh-tool-aura-edit` 不一致——**本版未动**（装载走路径，不影响运行）。

## 升级注意（面向调用方）

- **回执新增字段**：`unverified_region`（成功路径）、`write_verify {level, bytes|chars}`（成功路径）——均已在 `output.schema` 声明。
- **新增错误码**：`LOCATOR_SPAN_INCOMPLETE`、`PATCH_STALE_REGION`、`PATCH_NO_BYTE_EXACT_WRITE`、`WRITE_VERIFY_FAILED`；错误对象保留提供方原始错误码（`FS_STALE_VERSION` / `FS_EDIT_NOT_FOUND` 可区分）。
- **行为变化**：`changed` 对"文本没变、只差 BOM"会**显式点名**（不再说"没变"）；`a\nb` 删末行现在得 `a\n`（改前 `a`，即静默丢掉一个未被寻址的字节）；写回从 `editText` 换成 `writeText + replaceIfVersion`（沙箱策略仍照第 5 参传，权限语义不变）。
