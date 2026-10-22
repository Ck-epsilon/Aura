# aura 工具 0.2.1 —— 默认走 Aura，三件套只留"真做不到"的兜底

**日期**：2026-09-22 ｜ **包**：`dsh-tool-aura-read@0.2.1` · `dsh-tool-patch@0.2.1`
**改动面**：只改两段注入给模型的指导（`tool:aura-read` / `tool:aura-edit`）。**行为、接口、回执一律不变**，11 个套件重跑全绿。

## 改了什么

- 开头从 `Use the aura_read tool — not read — to inspect text files.` 改成
  **`… for every text-file read: it is the default, and it shows structure instead of raw bytes.`**
  （编辑侧同理：`… for every change to an existing UTF-8 text file: it is the default.`）
- 兜底**收窄到真做不到的两件事**，且只在段末出现：
  - 读侧：`The built-in read remains only for what aura_read cannot do: a raw window larger than one reply, or a file aura_read refuses.`
  - 写侧：`The built-in write remains for what aura_edit deliberately does not do — replacing a whole file, or writing one whose line endings it refuses to touch; read_image is still the only way to read an image.`
- **刻意不把内置 `edit` 写进兜底**：同样场景它会丢 BOM、把混合行尾整份归一（0.2.0 的两侧实测），它不是等价替代。

**为什么收窄**：上一版在开头写了"built-in `read`/`edit` stays available as a fallback"，实测**等于发许可证**——一个中性小任务直接选了内置 `read`+`edit`（推理原文：*I'll use the edit function since I've already read the file content*）。加兜底说明本意是好的，但放在开头就成了平级选项。

## 实测（headless 会话，中性任务，不点名任何工具）

| 任务 | 收紧前 | 收紧后 |
|---|---|---|
| 读一行 + 改一行（3 行文件） | 内置 `read`+`edit` | `aura_edit` **3/3**；`aura_read` 2/3 |
| 在 800 行文件里定位某函数的行范围 | 未测 | `aura_read` **2/2**（并答对 `595-972`） |

小任务上偶尔仍走内置 `read`，读那一行本身也不吃亏；在**结构、字节保真、陈旧区域**这些 Aura 真正强的地方，推荐是生效的。

## 结构性限制（诚实）

内置 `read`/`write`/`edit` 各自的提示段是**已发布包里的硬编码**（`dsh-tool-fs/lib/index.js:326` / `:591` / `:736`），而它的 `Config` 只有四个 read 上限参数（`readLimit` / `readMaxLineLength` / `readMaxBytes` / `readStreamMinSize`）⇒ **没有开关能让它们闭嘴**。我们不修改别人的包（与 BOM 那次同一条纪律）。所以"最强推荐"只能靠措辞与兜底收窄达成——上面的数字就是它的实际效果。

若还要更强，可用的杠杆（按代价）：① 给两个工具的 `description` 开头加一句 `Prefer this over the built-in read/edit`（另一个面，schema 测试未钉描述文本）；② 目标工作区 `AGENTS.md` 加一句（按工作区生效）；③ 停用 `tool-fs` —— **不要**，会连 `read_image` 一起失去（Aura 侧无替代）。

## 生效范围

- **headless**：立刻生效（新进程按当前文件 import）。
- **web / GUI**：需**重启宿主**——插件代码在会话启动时 import，改代码不影响已运行的会话。
