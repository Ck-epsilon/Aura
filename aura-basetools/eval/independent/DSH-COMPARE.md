# aura-basetools@0.19.0 vs DSH 默认 Read/Write/Edit 背后的 provider

- 被测 aura：`E:\workspaces\Aura\aura-basetools\eval\independent\.vendor\node_modules\aura-basetools\bin\aura.mjs`（npm 0.19.0）
- DSH：`@deepseek-ai/dsh-fs-local@0.2.1-rc.2`，入口 `LocalFileSystem.readText/writeText/editText`
- 平台：win32 x64，Node v24.15.0
- 结果：10 组，逐字节相同 3 组，不同 7 组

> 直接调用 DSH 默认 Read/Write/Edit 背后的 provider；模型面工具只做参数解析/格式渲染/观测策略，写盘语义在这里。涉及“读后写”时传入读到的 version token，等价于默认 observation policy 的守卫。

| 用例 | 原生结果 | aura 结果 | 是否逐字节相同 |
|---|---|---|---|
| edit-bom-crlf-token | `6f6e650d0a54574f0d0a74687265650d0a` | `efbbbf6f6e650d0a54574f0d0a74687265650d0a` | **不同** |
| edit-bom-crlf-line | `4f4e450d0a74776f0d0a74687265650d0a` | `efbbbf4f4e450d0a74776f0d0a74687265650d0a` | **不同** |
| edit-crlf-multiline | `70310d0a5032610d0a5032620d0a70330d0a` | `70310d0a5032610d0a5032620d0a70330d0a` | 相同 |
| edit-no-final-newline | `780a59` | `780a59` | 相同 |
| edit-mixed-eol | `610a620a430a640a` | `610a620d0a430a640a` | **不同** |
| overwrite-bom-preserved | `6f6e650d0a74776f0d0a` | `efbbbf6f6e650d0a74776f0d0a` | **不同** |
| overwrite-crlf-with-lf | `610a620a` | `610d0a620d0a` | **不同** |
| stale-other-line | `6f6e650a74776f0a45585445524e414c0a` | `4f4e450a74776f0a45585445524e414c0a` | **不同** |
| stale-same-line | `6f6e650a74776f2d45585445524e414c0a74687265650a` | `6f6e650a74776f2d45585445524e414c0a74687265650a` | 相同 |
| multi-target-partial | `41390a61320a` | `41310a61320a` | **不同** |

## 状态码（stale / multi）

- `stale-other-line`：原生 `FS_STALE_VERSION`（整文件 version 挡住非重叠修改）；aura `ok`（区域未变，允许）。
- `stale-same-line`：原生 `FS_STALE_VERSION`；aura `PATCH_STALE_REGION`。两者都拒绝，磁盘都保持外部内容。
- `multi-target-partial`：原生第二个目标是目录 ⇒ `FS_NOT_REGULAR_FILE`，但第一个已写入（`A9`）；aura 整批零写入（`A1` 保留）。

## 关键差异

- **BOM**：DSH `readText` 用 `TextDecoder` 默认剥掉 BOM；`editText`/`writeText` 不会再补回。aura 的字节路径保留 BOM。
- **混合行尾**：DSH `editText` 按检测到的行尾风格统一 `restoreLineEndings`；aura 保留逐行行尾。
- **BOM 覆写**：从 DSH 读出的文本写回，BOM 已经不在字符串里；aura 的整份写保留已有 BOM。
- **整文件写行尾**：DSH `writeText` 按 content 原样写；aura 覆写默认把 content 的新行适配成文件已有风格。
- **陈旧闸粒度**：DSH 的 version 是整文件版本；外部改了别的行，按旧 version 的 edit 会拒绝。aura 的 `lines` 区域闸允许非重叠修改。
- **多目标原子性**：DSH 没有多目标 API；顺序调用会在第二个目标失败时留下第一个写入。aura `--targets` 全量规划，失败零写入。

## 这些差异不都是“aura 更好”

- BOM/混合行尾/覆写行尾是**语义选择**：DSH 是文本层工具，读出来就是解码后的文本；aura 选择按字节保真。
- 整文件写时，DSH 按 content 原样写；aura 默认把换行适配成文件已有风格——对“我就要写 LF”的调用方，DSH 更直接。
- 陈旧粒度：aura 允许非重叠修改（更少阻塞），代价是调用方必须理解“区域不变”而不是“整文件不变”；需要整文件 CAS 时用 `expect`/整份写。

## 局限

- 这是 **provider 层** 对比；真实 DSH 宿主还会加沙箱、观察策略、格式渲染。
- 只测了单进程；没有测 DSH 的并发锁/观察策略在不同宿主配置下的差异。
- 原生侧用 `LocalFileSystem` 直接调用；没有启动完整 DSH agent。
- 读接口没有做逐字节对照：原生 `read` 返回格式化文本，aura 返回结构化取景，二者不是同一形状；本表只比较写回语义。