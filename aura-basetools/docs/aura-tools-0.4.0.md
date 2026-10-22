# aura-tools 0.4.0 —— 一键安装（人双击 / agent 一条命令）

**为什么发这一版**：0.3.0 的把工具做成了"包"，但交付形态还是"发个 .tgz，让对方自己 npm i -g 再改配置"——
对不写命令行的人、对 mac 用户、对"把文件夹丢给 agent 让它自己装"这三种场景都不成立。
0.4.0 把安装这件事本身做成了交付物：**一个 zip，解压后双击，或一句话交给 agent**。

## 新增

- **`install.mjs`（一键安装器，进包，随包一起发）**
  - 装到 `~/.aura/pkg/node_modules/aura-tools`，生成 `aura` / `aura-mcp` 两个命令（sh 壳 + `.cmd` 壳）；
  - **自带 tar 解包**：给的是 .tgz 也能装，**全程不需要 npm**（只要 Node ≥18）；
  - 注册 MCP 到**检测到的** agent：Codex `~/.codex/config.toml`、Claude Code `~/.claude.json`、
    Cursor `~/.cursor/mcp.json`；一个都没检测到就打印可直接粘贴的 JSON 片段；
  - **装完真自检**：CLI 取景 + MCP 握手，两个工具都在才算过，退出码 0/1/2；
  - `--dry-run`（只打印计划）、`--uninstall`（只撤它自己加的东西）、`--json`（给 agent 用）、
    `--home`（把"用户主目录"指到别处，本机验收就是这么跑的，不碰真实配置）、
    `--dsh-profile`（可选，只往空 patch 里代写，已有别的补丁内容时拒绝并打印该加的行）；
  - 每个被改的配置文件先备份成 `<文件>.bak-aura-<时间戳>`。
- **交付包 `aura-tools-<版本>-交付包.zip`**：解压好的包体 + .tgz + 一页说明 + 两个双击壳。
  `.command` 在 zip 里带 **0755 模式位**（Windows 的压缩工具不写模式位，那样 mac 双击会说"不可执行"，
  所以自己写了 zip 容器：deflate + UTF-8 文件名标志 + 外部属性带模式）。
- **双击壳**：`一键安装.cmd`（Windows）/ `一键安装.command`（macOS）。参数透传，双击即 `--yes`。
- 打包改动：`.tgz` 打到 `dist/`（不再落在包目录里，免得被当成运行时文件装进去）。

## 修复（都是本轮验收抓出来的真问题）

1. **卸载会留下 Codex 的 `[mcp_servers.aura]` 表**：删除区间起点往前挪到注释行后，终点仍从"挪过的起点"
   往下扫，于是把表本身留在了文件里。→ 终点固定从**表头**往下扫（`unregisterCodex`）。
2. **装两次再卸载，什么都不撤**：状态文件记的是最后一次的 `action`（第二次是"已存在"），卸载按
   `action === 'added'` 过滤就被跳过了。→ 区分三态：`added`（本次写入）/`present`（已存在且内容就是
   本安装器那份，卸载该删）/`foreign`（别人写的同名项，**卸载不许碰**），并加了对应用例。
3. 打包汇总打印 `NaN KB`（`copied.reduce` 少了调用）。
4. 说明文档错字（拒绍 → 拒绝）。
5. **MCP 面遇到坏参数会把客户端挂死**（交付前抓到的最重一条）：`aura_read` 的参数名写成 `file`
   （MCP 里叫 `file_path`）时，provider 抛 `TypeError`，而 `readEnvelope` 没有兑底、MCP 分发层
   也不回包 —— 结果**只往 stderr 写一行，回包永还不来**，客户端只能等到自己的超时（对 agent
   就是“卡住且无解释”）。证据：同一份脚本 6 条请求只回来 5 条，stderr 一行 `ERR_INVALID_ARG_TYPE`。
   修法三层：① `readEnvelope` 与 `editEnvelope` 对称地把抛出变成结构化回包；
   ② MCP 的 `tools/call` 加兑底，任何漏网抛出都变成 `isError` 回包；③ 参数名错先说人话（`BAD_ARGS`）。
6. 两个 bin 里的版本号写死（包已到 0.4.0，服务对外仍报 0.2.1）→ 改成读包清单，测试钉住。

## 证据（本轮实际跑过的命令与结果）

| 验收 | 结果 |
| --- | --- |
| `node tools/install-test.mjs`（假 HOME 里真装真卸） | **28/28 通过** |
| 包内自带验收 `dist/aura-tools/test/standalone-test.mjs` | **42 通过 / 0 失败**（新增 G 段：MCP 六种坏输入全部回包 + 服务存活 + 版本号跟包一致） |
| MCP 坏参数矩阵（参数名错 / mode 错 / 文件不存在 / hunks 不是数组 / 未知工具 / 之后仍可用） | 6/6 回包，`stderr` 空 |
| 独立解压（PowerShell `Expand-Archive`，不是自己读自己） | 结构、中文文件名正确 |
| 独立读中央目录（.NET `ZipArchive.ExternalAttributes`） | `一键安装.command` 模式 = `755` |
| 从**解压目录**直接装着走（不给 `--from`） | ok，CLI/MCP 自检都过 |
| 双击壳真跑（`cmd /c 一键安装.cmd --home … --dry-run`） | 退出码 0，中文输出正常 |
| 交付包里的 .tgz 与 dist 的 .tgz | sha256 一致 |
| `npm i --prefix <临时> dist/aura-tools-0.4.0.tgz` | 装得上，`aura read` 正常 |

安装器自身用例覆盖九件事：装 / 幂等（重装配置逐字节不变、不重复备份）/ 写入内容 / 卸载复原 /
**别人写的同名项不许动** / .tgz 路线与目录路线逐文件一致 / `--json` 可用 / `--dry-run` 不落盘 / 卸载可重入。

## 已知边界

- `一键安装.command` 的**外壳**没在真 macOS 上跑过（本机没有 sh）：它调用的那条命令
  （`cd 目录 && node aura-tools/install.mjs --yes`）与文件内容都验过，逻辑是 10 行标准 sh。
  Gatekeeper 首次会拦，右键 → 打开即可；说明书里也给了终端一行命令作为替代。
- 安装器**默认不动 DSH 配置**：要 DSH 面就 `--dsh-profile <名字>`，或按 README 用 `dsh plugin add`。
- 单 `\r`（老 Mac）行尾、二进制文件、>256 KiB 不进观测缓存：与 0.3.0 相同，未变。
