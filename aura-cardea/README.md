# AuraCardea

把一轮对话里**与回答正文无关的中间态**按类折叠的浏览器 UI 插件。

名字取自罗马的门轴女神 **Cardea**：*cardo* 是铰链、枢轴（英文字 "cardinal" 同源），开与合
只是同一个铰链的两面——这正是插件在做的：把过程折起来，需要时展开。

它只接管 `conversation.chat.node` 里 `turn-process` 一个渲染位，不动任何内置插件、不改
DSH 安装产物；被折叠的行仍然挂载在 React 树里，靠一张按行 key 作用域的样式表隐藏。

## 效果

一轮结束后（或运行中）在轮次开头显示：

```
● 正在运行 mcp__gui__gui_shot · 27 次工具调用        ✓25  ✗1   ›
   › 思考 ×10
   › cordis_define ×5            ✓5
   › pwsh ×5                     ✓5                  Σ 7.5s
   › 上下文注入 ×5
   › mcp__gui__gui_find ×3       ✓2  ✗1  Error: {...}  Σ 11.5s
   › mcp__gui__gui_shot ×5       ✓4  正在运行          Σ 5.3s
```

- **按类聚合**：同名工具聚成一行（`×N`），思考、上下文注入、重试各自一类
- **统计**：每类 `✓成功 / ✗失败` + 失败摘要；`Σ` 是该类总耗时；汇总行给全轮合计
- **展开就地**：点类别 → 该类每次调用的条目直接列在下面（状态符、参数摘要、耗时），
  再点条目 → 完整参数 + 输出（超 4000 字符截断）
- **图片**：`read_image` 之类结果里的图片直接出缩略图，双击放大，点空白/双击图/✕ 关闭
- **失败原因聚合**：类别行汇总该类所有失败原因——全相同时写 `exit 1`；混合时写
  `exit 1×6, +1 种`（最多的那个 + 种类数），悬停该文本用 title 给出完整分解
  （`exit 1×6 / exit 2×2`）；条目行各自保留自己的 `exit 1` / `exit 2`
- **退出码**：shell 命令的失败是「结果数据」而不是 `isError`，所以另外从输出尾部读
  `[exit code: N]` / `[killed by signal: X]`：非零退出计入 ✗，并在条目上直接标
  `exit 2` / `signal SIGKILL`，类别行的失败摘要也用它
- **时序**：每条调用左侧带本地时钟 `22:44:12`（右边是耗时或「已运行 X」），类别行的 `Σ`
  悬停显示该类起止时间 `22:40:12 → 22:44:39`；按类聚合不会打乱时间——条目仍按时间升序
- **运行中动效**：类别行与条目行共用同一组三个「琴键」
  一轮，透明度 0.3→0.85），一眼看出在动，但扫读时不抢注意力；`prefers-reduced-motion`
  下退化为静态竖条
- **运行中高亮随时间加深**：「注意」而非「警告」——始终在同一品牌色相里加强度，不借用
  警告/错误色。左侧 2px 色条 + 底色，按已运行时长分三档：<2 分钟 蓝 12%/条 55%、
  2–10 分钟 蓝 18–20%/条 80%、>10 分钟 蓝 24–26%/条 95%（类别行按该类最老的
  在跑调用取档）；组件在有运行时每 15s 自刷一次，所以没有新事件时「已运行 5m16s」
  与强度也会自己前进
- **运行中底色**：正在跑的类别行与条目行都带浅蓝底色（圆角 5px），
  叠加原有的呼吸点与「正在运行」文字
- **运行中**：正在跑的那一类标「正在运行」；汇总行写「正在运行 X · N 次工具调用」，
  并行时写 `×N`；单个条目显示「已运行 2m14s」，结算后换成精确耗时

## 安装

AuraCardea 同时声明了 `dsh.bundle` 和 `dsh.client`：bundle 负责把行挂进 DSH，client 负责浏览器半。

> 当前 DSH 0.2.x 没有官方插件市场；`dsh.bundle` 让本包可以被任意配置的插件市场索引列出。

**方式 A（插件市场 / Discover）**：在「插件 → 发现」添加包含 `aura-cardea` 的索引源并安装；bundle 的 `cordis.patch.yml` 会自动插入挂载行，不需要手改 patch。

**方式 B（命令行 + 手动挂载）**：`dsh plugin --profile web add aura-cardea`，然后按下面挂载。

挂在 `~/.dsh/profiles/web/cordis.patch.yml` 的末段：

```yaml
- insert:
    - id: client-aura-cardea
      name: 'aura-cardea'
```

宿主半（`lib/index.js`）是空插件，唯一作用是让 Loader 有这一行可挂载——`dsh.client`
清单被发现后，浏览器半 `lib/client.js` 才会被登记进启动图并从 `/plugins` 提供。
浏览器模块 id 必须等于包名（`aura-cardea`）。

> 只对 DSH 0.2.x 的 web profile 有效；升级 DSH 后先跑 `check-kinds`。
> 如果从旧版绝对路径迁移，删掉旧的 `client-aura-cardea` 段，再按上面任一种方式挂载，不要同时保留两行。

## 关闭 / 回滚

- 临时关闭：在那一行加 `disable: true`，或者在插件页停用它
- 彻底移除：删掉 `insert` 段，重启 `dsh web`
- 回滚整份补丁：恢复 `cordis.patch.yml.bak-auracardea-<时间戳>`

## 依赖的 DOM 契约（改版时最需要先看这里）

| 契约 | 用途 | 缺失后果 |
|---|---|---|
| 座位外层 `data-chat-anchor-key` | 按行 key 隐藏被折叠的行 | 折叠失效，全部行照常显示 |
| **行 key 的 `groupPart` 形态** | 0.2.1 起一条节点按部分渲染：`response`/无部分用节点 key，其余（含 `reasoning`）用 `JSON.stringify([key, "reasoning"])` | 思考行隐藏不掉（**工具行仍会隐藏，看起来像"只漏了思考"**） |
| `data-chat-flow-kind="turn-process"` | 把被 seat 隐藏的控件行强制显示 | 运行中没有汇总行 |
| 思考行 `data-variant="think"` | 内联思考的兜底隐藏 | 少量内联思考露出 |
| shell 输出的 `[exit code: N]` / `[killed by signal: X]` 尾部标记 | 把命令失败算进 ✗ 并显示退出码 | 失败命令被计为成功（输出被 spill 截断时也会如此，因为没有标记可读） |
| `turn-process` 节点数据 `turn / processStartSeq / toolCallCount / messageCount / subagentCount` | 类别归属与汇总文案 | 数字不对或类别为空 |

别名键和 `groupPart` 两种形态都会发出去，所以 0.1.5（无 groupPart）与 0.2.1 都能用。

## kind 清单与版本漂移

节点 kind 是合并扩展的（`ChatNodeDataMap` 的键），随版本增长。当前 0.2.1 共 19 个：

- **永不折叠**：`system-prompt` `user` `steering` `turn-process` `turn-error` `turn-max-tokens` `turn-tail` `question-reply`
- **折叠**：`tool-call` `context` `model-retry`，以及按类别聚合的 `turn-trigger`（→「触发」）、`compaction`（→「上下文压缩」）、`command` / `command-input`（→「命令」）、`workflow-run`（→「工作流」）、`assistant-step`（思考并入口「思考」；无正文无思考的壳行直接折叠）

升级后跑一条命令自查：

```powershell
node ~/.dsh/profiles/web/node_modules/aura-cardea/tools/check-kinds.mjs C:\path\to\node_modules\@deepseek-ai
```

它扫描已安装的 client bundle，取出所有 `conversation.chat.node` 的 key 与 key 域，与插件规则表做 diff；
exit 0 = 全部有规则，1 = 有新增 kind（需决定收不收），2 = 没扫到任何包。
运维时未知 kind 也会在控制台 `warn` 一次，不会静默混进别的类别。

## 已知边界

- 折叠状态按轮次保存在组件内存里，切走会话再回来会收起
- 被隐藏的文本是 `display:none`，浏览器 Ctrl+F 搜不到（有意的取舍）
- 「系统提示词」行与轮次尾部（用量/用时）属于独立行，不参与折叠
- 子智能体的内部步骤不在父会话里（设计如此），父会话只有 `subagent ×N` 一行与条目详情
- 子智能体视图一次只挂一个对话，所以按轮次号作用域的思考兜底规则不会串到别的会话

## License

MIT
