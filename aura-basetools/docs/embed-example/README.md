# 只接入 locator-lab（不用 dsh）

如果你只是想**在 dsh 里用 `aura_read` / `aura_edit`**，那你不需要做任何事——它们已经装在
`~/.dsh/profiles/web/cordis.patch.yml` 的进程组合层里，任何新会话开箱即用。本目录解决的是另一个问题：
**把引擎拿走，接到自己的程序/别的 agent 框架上。**

## 一次实测（不是设计意图，是跑出来的）

在一台机器上的验证过程与结果，全部可复现：

```bash
mkdir /tmp/lab
cp <repo>/src/locator-lab/{read-core,locator-api,struct-core,anchor-core,write-path,args,repo-map,handle-core,doc-structure}.mjs /tmp/lab/
cp demo.mjs /tmp/lab/ && cd /tmp/lab && node demo.mjs
```

`/tmp/lab` 里**没有 package.json、没有 node_modules、什么都没装**。输出：

```
读：mode=full  10 行  version=5b6124b0:106
1: export function alpha() {
2:   const n = 1
3:   return n
4: }

定位 target=beta ⇒ 第 6-9 行，tier=symbol
定位 target=n（两处重名）⇒ ok=false code=STRUCT_AMBIGUOUS
  回执："n" matched 2 symbols and near did not disambiguate; candidates:
        line 2 = "variable in alpha" (target=n#1), line 7 = "variable in beta" (target=n#2) …

写：applied=[{"line":7,"tier":"lines","actual":"  const n = 2","replaced":"  return 42"}]
    write_verify={"level":"bytes","bytes":104}
磁盘第 7 行现在 = "  return 42"

位移后仍用旧行号 ⇒ PATCH_STALE_REGION
  磁盘是否被动过：没动 ✓

仓库地图：1 个模块
all 1 module is directly in this directory (no subdirectories)
```

## 为什么能这么搬（三条硬约束，都可核对）

1. **零外部依赖**：8 个引擎文件的 import 全部是同目录内的相对引用，没有任何 npm 包。
2. **零 `node:fs` / 零 `process.platform`**：文件读写全部由调用方注入。实测 8 个文件里一处都没有。
3. **打包时强制**：`build/make-bundle.mjs` 对引擎档有守卫，命中 `node:fs` 或 `process.platform` 就拒绝打包 ——
   所以这条约束不是自觉，破坏它会让 `release-check` 红。

## 接入面：一个契约，五个方法（第 5 个可选）

| 方法 | 签名 | 谁需要 |
|---|---|---|
| `stat` | `(target) -> { type, version, size } \| undefined` | 全部 |
| `readText` | `(target) -> string`（fatal 解码 + 默认 ignoreBOM） | 全部 |
| `readByteRange` | `(target, {offset, length}) -> Uint8Array` | 写路径（BOM 计数）、仓库地图（读文件头） |
| `writeText` | `(target, content, expected) -> { version }`，`expected.kind='replaceIfVersion'` 时是 CAS | 写路径 |
| `listDir` | `(target) -> {name, type, size?, target?}[]` | 只有仓库地图（传目录时） |

四个调用面就这五个方法的差别：DSH 壳用 `ctx.fs`、独立 CLI 用 `node:fs`、MCP 同样、你自己的程序接什么都行。

## 三个必须同形的地方（不同形会静默出错）

1. **`readText` 的解码方式**：必须 `new TextDecoder('utf-8', { fatal: true })`，且**不要**设 `ignoreBOM: true`。
   第一个 BOM 不进字符串是契约；不同形会让 BOM 文件的版本令牌对不上，
   表现为"本来核对过"被报成"没核对过"（本仓真踩过：`range-bytes-test` 段B 五条断言变红）。
2. **`writeText` 要逐字节**，不要顺手做行尾归一。混合行尾的文件里，归一会改掉**没被寻址**的那些行的行尾
   （本仓量过：改第 4 行导致第 2 行的 `\r\n` 变 `\n`，24 → 23 字节）。
3. **`stat().version` 必须真的能区分两次不同的内容**。示例里用 `size:mtimeMs` 只是为了短；
   生产环境请用内容指纹或真版本号——同尺寸同刻改写会让 CAS 静默失效。

## 不需要接的部分

别自己重做"读 → 规划 → 改 → 写"这套流程。`applyEditToProvider` 已经把它做成**一次不可分割的写回**：

```
读内容 → planHunks（定位 + expect 核对 + 重叠检查）
       → 区域级新鲜度闸门（拒绝时磁盘一字不落）
       → writeText + replaceIfVersion（CAS）
       → 回读校验（落盘内容与预期逐字节比）
       → 刷新观测账本
```

拆开做会丢掉闸门与回读校验，而这两样正是"不把改动写到错地方"的保证。
