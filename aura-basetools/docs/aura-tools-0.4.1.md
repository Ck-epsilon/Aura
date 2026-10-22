# aura-tools 0.4.1 —— 参数形状容错（针对"老是看到 invalid arguments"那条报错）

**起因**：真实会话里反复出现

```
工具调用  Error: invalid arguments: "arguments" must be an object
输入      {"file_path": "bridge.py", "lines": 412, 500, "mode": "lines"}
```

注意 `"lines": 412, 500` —— 这**不是合法 JSON**（数组要写 `[412, 500]`）。这句报错的出处是**宿主**
（`@deepseek-ai/dsh-tools` 的 JSON Schema 校验，`lib/index.js:816` / `types/schema.json-schema.js:253`，
code `INVALID_ARGS`）：模型写坏了参数 JSON，宿主在参数**进工具之前**就拒了，工具根本没有机会介入。
所以这一版能做的不是"接住它"，而是**让这种写法不再必要，并把能容的形状都容下来**。

## 新增

- **`start_line` + `end_line`**：`aura_read` 与 `aura_edit`（hunk 级）都加了这两个整数字段。
  行区间从此不必写数组语法——两个普通整数，没有括号可写错。工具描述与常驻提示词都把这条写成首选。
- **行区间宽容解析**（新引擎文件 `locator-lab/args.mjs`，DSH 工具壳 / CLI / MCP 三面共用同一套判据）：
  以下写法现在全部可用（原先只有第一种）：
  | 写法 | 之前 | 现在 |
  | --- | --- | --- |
  | `lines: [412, 500]` | ✅ | ✅ |
  | `lines: "412,500"` / `"412-500"` / `"412 500"` | ❌ `READ_NO_RANGE` | ✅ |
  | `lines: 412`（单行） | ❌ | ✅ |
  | `lines: {start, end}`（也认 `from/to`、`first/last`） | ❌ 宿主就拒 | ✅ |
  | `start_line` + `end_line` | ❌ 宿主就拒 | ✅ |
- **模式推断**：给了行区间就不必再写 `mode: "lines"`（`around`/`search`/`since`/`kind` 同理；
  显式写了 `mode` 一律听显式的）。少一个字段就少一个写错的机会。
- **写坏要说清怎么改**：行区间解不出来时返回
  `lines 解析不出来：接受 start_line + end_line（推荐）、lines: [412, 500]、lines: "412,500"、lines: 412`，
  而不是静默退回 `auto`（那会让人以为是别的问题）。
- **MCP 的 `arguments` 宽容**：有的客户端会把参数当**字符串**传；能 `JSON.parse` 就直接用，
  解不开则回一条结构化 `BAD_ARGS`（绝不让它变成 provider 内部 TypeError 而让客户端一直等）。

## 修复（这一轮顺手抓出来的）

1. **`aura read --lines 1,2` 一直是坏的**（既有 bug，不是这版引入）：CLI 与 MCP 都传 `{start, end}`，
   而读侧引擎 `read-core.renderLines` 只认**数组** `[start, end]` → 必然 `READ_NO_RANGE`。
   收敛层统一产出 `{start,end}`，到边界按各自的契约转换（读侧数组、写侧 `locate` 的对象）。
   证据：未重建的旧包里 `aura read --file x --lines 1,2` → `ok=false code=READ_NO_RANGE`；重建后 → `ok=true mode=lines`。
2. **`lines: {start,end}` 在宿主参数层就被拒**（`must match exactly one oneOf branch`）：
   声明的 `oneOf` 少写了 `object` 分支。
3. **`{type:'object'}` 分支必须显式声明 `additionalProperties`**，否则整个工具在注册时报
   `UNSUPPORTED_SCHEMA`（实测：一次改动让 11 个套件全崩在工具定义处）。两条规则都是宿主当场教的，
   已写进注释，免得下次再犯。
4. **越界行号不能被收敛层吃掉**：`0`、负数、`start > end` 一律原样传给引擎，让引擎回它自己的
   `READ_BAD_RANGE` 一类结构化错误；在收敛层把它们当成"没给行号"会让错误码从"区间不合法"变成
   "缺参数"（实测：11 个用越界行号验结构化拒绝的套件变红）。

## 证据

| 验收 | 结果 |
| --- | --- |
| 18 个既有套件（dev 树） | **全绿**（byte-fidelity 94 · span 95 · stale-gate 49 · write-verify 42 · schema **65**（新增 9 项参数形状）· read 33/59 · load 50/41 …） |
| 包内自带验收（含新增 H 段参数形状、I 段 hunk 形状） | **54 通过 / 0 失败** |
| 一键安装器验收 | 28/28 |
| MCP 宽容度实测 | `start_line/end_line`、`"2,3"`、`2`、`{start,end}`、`arguments` 为 JSON 字符串 → 全部 `ok`；`arguments` 解不开 → `BAD_ARGS`（不挂死） |
| CLI 既有 bug | 旧包 `READ_NO_RANGE` → 新包 `ok=true mode=lines` |

顺带把 `start_line/end_line` 加进了两个 load-test 的参数清单守卫断言（schema 一改就红，正是它该干的）。

## 生效范围（实测过）

| 面 | 何时生效 |
| --- | --- |
| **MCP / CLI**（Codex、Claude Code、Cursor、`aura` 命令行） | **立即**——用的就是磁盘上这份包，已实测五种写法全部 `ok` |
| **DSH 工具**（`aura_read` / `aura_edit`） | **重启 dsh 之后**：宿主在启动时导入模块，改 `.js` 不会热更新。实测：在跑的会话里传 `start_line`，旧模块直接忽略它并退回 `auto`（不报错、也不崩，只是没有新能力） |

所以：想让 DSH 侧也用上 `start_line`/`end_line` 与宽容解析，下次重启 dsh 即可；在那之前一切照旧。

## 已知边界（没变）

`"lines": 412, 500` 这种**非法 JSON** 仍然只能由宿主拒——工具拿不到参数，无法救。
能做的两件事这版都做了：把正确写法变得更容易（`start_line`/`end_line`），以及把"合法 JSON 但形状不对"
的全部接住。遇到那个报错时，最快的处理是重发一次并把区间写成 `start_line` + `end_line`。
