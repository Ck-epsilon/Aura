# aura-tools 0.5.2 —— 新原语 `$rest`：Erlang 头文件（`.hrl`）修好；`hs` 按安全优先摘除

## 新增原语：`$rest`（跳到当前括号组收尾）

**为什么需要它**：`.hrl` 的常见形态是 `-define(ALPHA, 1).` / `-record(alpha, {beta = 1}).`，
名字与 `)` 之间夹着「**逗号 + 字面量**」。既有四个原语都跳不过它：
`$ident*` 只吃标识符、`$param`/`$param*` 只跳**完整的**括号组、`$mods*` 只吃修饰词表。
两种旧写法都实测失败（加 `')'` 匹配不上、不加则拿不到符号）。

**做法**：配对表 `pairs`（open→close 下标）里找**包含当前位置的最内层**组，跳到它的收尾 token，
让模式里接下来的字面量 `)` 对上去。实现在 `skipToGroupClose`，注释写在原语表里。

```js
{ kind: 'module',  pattern: ['-', 'module',  '(', '$name', '$rest', ')'] },
{ kind: 'record',  pattern: ['-', 'record',  '(', '$name', '$rest', ')'] },
{ kind: 'variable', pattern: ['-', 'define', '(', '$name', '$rest', ')'] },
```

**实测**：`-define(ALPHA, 1).` → `ALPHA@1-1`；`-record(alpha, {beta = 1}).` → `alpha@2-2`；
`-module(alpha).` → `alpha@1-1`；三者 `target=` 均成功。`.hrl` 因此**登记并可用**。
新原语对既有语言**零回归**：`lang 21/21`、`struct 28/28`、`corpus 287 文件 0 坏`、`span-fidelity 95/95`、
`read 33/33`、`read2 59/59`、`layers 29/29`、`regex-lex 51/51`、`policy-arg 12/12`。

## `hs`（Haskell）摘除登记 —— 安全优先

实测它的规则会给出**假符号**：`['$nameNotKeyword','$param','=']` 匹配不了 `beta a = a + 1`
（Haskell 的参数是裸标识符、不是括号组），而 `['$nameNotKeyword','=']` 会把函数体里的 `a = a + 1`
当成顶层绑定 —— 符号表里因此出现 `a@4-4`。**假符号比没符号危险**：`target=a` 会改到参数身上。
同时 `beta :: Int → Int` 与 `beta a = a + 1` 同名 → `STRUCT_AMBIGUOUS`。

→ 摘掉登记，让 Haskell 文件回到"**这个格式不认识**"的明确失败（而不是"认了但会改错"）。
正确修法（属规则层）已写进代码：① 用 **layout（第一列）守卫**区分顶层绑定与函数体内绑定；
② 类型签名与实现**合并成一个符号**（或只取实现那条）。`HASKELL` 定义保留作修法依据。

## 覆盖现状（21 种目标格式）

- **已登记 20/21**（只差按安全优先摘除的 `hs`）；
- **符号表 + `target=` 实测可用 19 种**；
- `erl` 可用但只出 `-module` 属性（函数子句 `f(0) -> 1;` 仍未提取，如实记录）；
- 语言表扩展名总数 **64**（与 0.5.1 相同：`hrl` +1、`hs` −1）；包内 README 的数字由引擎语言表**动态渲染**。

## 验收

`node build/release-check.mjs` → **全量测试通过，exit 0**：
19 套既有 + 三套靶场（格式 **3297/3297** · 字节 217/217 · 参数 76/76）+ 包内 54/54 +
安装器 33/33 + 升级 94/94 + 独立审计探针 31/31 + `src↔dist` 15 文件逐字节一致 +
版本三处均 0.5.2 + DSH 就绪。交付物：`aura-tools-0.5.2-交付包.zip`（322.0 KB / 23 项）、`aura-tools-0.5.2.tgz`。
