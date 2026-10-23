# aura-basetools 0.6.19 — 写入边界

这一版只收紧文件系统边界，不改变寻址、选择与回执语义。

## 变更

- 原子替换保留现有文件的 mode（POSIX）；Windows 的 mode 只承载可写位。ACL / xattr 仍不在保全范围。
- 符号链接写穿到 realpath，链接本身保留；悬空符号链接拒绝（`FS_SYMLINK_BROKEN`）。
- 硬链接（`nlink > 1`）拒绝（`FS_HARDLINK_UNSUPPORTED`）：rename 会换 inode，另一个名字会看到旧内容。
- `stat()` 只读头尾 4 KiB 做指纹；`readByteRange()` 只读请求区间，不再整份读。
- 文本读/写默认上限 512 MiB；`AURA_MAX_FILE_BYTES` 可覆盖。`readByteRange` 不受该上限阻断。
- 版本指纹纳入 ctime；rename 前再校验一次目标版本，缩小 check-then-act 窗口。
- 观测缓存目录 `0700`、文件 `0600`（POSIX）；`AURA_NO_OBSERVATION_CACHE=1` 关闭落盘缓存。
- 临时文件写后尽力 fsync，再 rename。
- 删除外部 AuraPolaris 差分测试；它不属于文件工具的发布门，也不再依赖用户级 hook 路径。
- 新增写事务：原始字节 journal、`aura undo`、`--id`/`--force`、多目标部分失败回滚。
- 新增 workspace 锁：`~/.aura/locks`；`AURA_NO_LOCK=1` 可关闭。
- MCP 新增 `aura_undo` / `aura_transactions`；CLI 新增 `aura undo` / `aura transactions`。
- 新增 Windows/macOS CI（Node 22）。

## 验收

```bash
node src/aura-standalone/test/standalone-test.mjs   # 独立面 + N1–N6
node src/locator-lab/write-verify-test.mjs
node src/locator-lab/byte-fidelity-test.mjs
node src/locator-lab/stale-gate-test.mjs
```

## 已知边界

- ACL、xattr、硬链接/符号链接以外的特殊文件语义不保全。
- `writeText` 的版本检查与 rename 之间仍是 check-then-act；并发写者仍可能最后写入者赢。
- 完整 `release-check` 不再包含外部 AuraPolaris hook 测试；它不属于本包功能。
