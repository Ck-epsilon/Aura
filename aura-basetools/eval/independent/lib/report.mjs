// Report + machine-readable results generation. Everything here is derived from the
// case results collected by run.mjs; no figure is hand-copied.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function writeResults(evalDir, output) {
  const path = join(evalDir, 'results.json');
  writeFileSync(path, JSON.stringify(output, null, 2) + '\n', 'utf8');
  return path;
}

const pad = (s, n) => String(s).padEnd(n);
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function verdictLine(counts) {
  if (counts.failed === 0) return `全部通过（${counts.passed}/${counts.total}）`;
  return `${counts.failed} 个失败 / 共 ${counts.total}`;
}

function suiteOf(output, id) {
  return output.suites.find((s) => s.id === id);
}

function countsOf(output, ids) {
  const cases = output.suites.filter((s) => ids.includes(s.id)).flatMap((s) => s.cases);
  return { total: cases.length, passed: cases.filter((c) => c.pass).length, failed: cases.filter((c) => !c.pass).length, cases };
}

function firstFailingCommand(c) {
  const cmd = (c.commands ?? []).find((x) => x.code !== 0) ?? (c.commands ?? [])[c.commands.length - 1];
  return cmd ?? null;
}

export function buildReport(output) {
  const { meta, suites, failures } = output;
  const L = [];
  const bytes = countsOf(output, ['bytes']);
  const edit = countsOf(output, ['edit']);
  const stale = countsOf(output, ['stale']);
  const multi = countsOf(output, ['multi']);
  const tx = countsOf(output, ['tx']);
  const read = countsOf(output, ['read']);
  const mcp = countsOf(output, ['mcp']);
  const fuzz = countsOf(output, ['fuzz']);
  const baseline = countsOf(output, ['baseline']);
  const safety = countsOf(output, ['stale', 'multi', 'tx']);

  const fuzzCase = fuzz.cases[0] ?? null;
  const seed = meta.seed ?? fuzzCase?.data?.seed ?? null;
  const baselineCases = baseline.cases ?? [];
  const mcpCases = mcp.cases ?? [];
  const consistency = mcpCases.find((c) => c.id === 'mcp/cli-mcp-consistency')?.data ?? null;

  L.push('# aura-basetools@0.19.0 独立测评报告');
  L.push('');
  L.push(
    `> 被测物：npm 已发布包 \`${meta.subject}\`（从 ${meta.registryRequested} 安装）。` +
      `本仓库的 \`src/\`、\`dist/\`、任何测试/夹具/黄金集**未被读取，也未参与期望值计算**。`,
  );
  L.push('');
  L.push('## 摘要');
  L.push('');
  if (meta.subset) {
    L.push(`> 注意：本次只跑了子集 \`${meta.subset.join(', ')}\`，数字不是全量结果。全量请跑 \`node eval/independent/run.mjs\`。`);
    L.push('');
  }
  L.push(`- 用例总数 **${meta.totals.total}**，通过 **${meta.totals.passed}**，失败 **${meta.totals.failed}**。`);
  L.push(`- 字节保真：${verdictLine(bytes)}；编辑语义：${verdictLine(edit)}；读接口：${verdictLine(read)}。`);
  L.push(`- 安全性（陈旧闸 + 多目标原子性 + 跨调用事务）：${verdictLine(safety)}。`);
  L.push(`- MCP 面：${verdictLine(mcp)}；随机差分（固定 seed=${seed ?? 'n/a'}）：${verdictLine(fuzz)}。`);
  L.push(`- 朴素基线对照：${verdictLine(baseline)}（基线是本测评自己写的朴素实现，不是 DSH 内置工具）。`);
  L.push('');
  L.push('## 被测物与环境');
  L.push('');
  L.push('| 项 | 值 |');
  L.push('|---|---|');
  L.push(`| 包 | \`${cell(meta.packageJson.name)}@${cell(meta.packageJson.version)}\` |`);
  L.push(`| 安装来源 | ${meta.packageOrigin === 'npm-install' ? '`npm install --registry=' + meta.registryRequested + '`（临时 vendor 目录）' : '`' + cell(meta.packageOrigin) + '`'} |`);
  L.push(`| 包根目录 | \`${cell(meta.packageRoot)}\` |`);
  L.push(`| lockfile resolved | ${meta.provenance?.resolved ? '`' + cell(meta.provenance.resolved) + '`' : '（lockfile 中无记录）'} |`);
  L.push(`| lockfile integrity | ${meta.provenance?.integrity ? '`' + cell(meta.provenance.integrity) + '`' : '（无）'} |`);
  L.push(`| CLI 入口 sha256 | \`${cell(meta.artifacts?.binSha256 ?? 'n/a')}\`（\`${cell(meta.artifacts?.bin ?? 'bin/aura.mjs')}\`） |`);
  L.push(`| Node | \`${cell(meta.node)}\` |`);
  L.push(`| 平台 | \`${cell(meta.platform)}\` |`);
  L.push(`| 运行时依赖 | ${meta.packageJson.dependencies && Object.keys(meta.packageJson.dependencies).length ? '`' + JSON.stringify(meta.packageJson.dependencies) + '`' : '无（零依赖，与 README 一致）'} |`);
  L.push(`| 运行时间 | ${cell(meta.startedAt)} → ${cell(meta.finishedAt)}（${(meta.durationMs / 1000).toFixed(1)}s） |`);
  L.push(`| 工作区隔离 | 每个用例独立 workspace + 独立 \`AURA_CACHE_DIR\`（观测缓存/锁/事务日志互不串扰） |`);
  L.push('');
  L.push('## 方法');
  L.push('');
  L.push('1. **黑盒入口**：只用发布包的两个公开入口 —— CLI `aura basetools …` 与 MCP stdio（`initialize` / `tools/list` / `tools/call`）。CLI 用 `spawn` 传 argv 数组，不经 shell，避免引号改写输入。');
  L.push('2. **独立 oracle**：期望值全部由本测评自己的 Node `Buffer`/`fs`/字符串操作构造。字节级用例的 oracle 是「自行切分 BOM + 行内容 + 行尾，替换目标行内容后重新拼字节」，与产品实现无关；不拿被测工具的任何回执字段当期望。');
  L.push('3. **逐字节比较**：`Buffer.equals`；不等时给出首个差异偏移与前后 48 字节 hex。');
  L.push('4. **失败即事实**：用例失败不修改产品；记录 id / 目的 / 输入 / 期望 / 实际 / 最小复现 / 回执片段。');
  L.push('5. **随机差分**：自写 mulberry32 PRNG + 固定 seed，随机文本、随机行尾/BOM/尾换行组合、随机单行替换，逐字节比对 oracle。');
  L.push('6. **基线对照**：本测评自己实现「整文件读 → 精确字符串替换 → 整文件写」的朴素基线（**不是** DSH 原生工具，也不代表任何其他客户端），只用来定位 aura 的差异出现在哪。');
  L.push('7. **禁止面**：未读取 `src/**/test*`、`fixtures/`、`build/release-check.mjs`、`dist/` 中的测试/黄金集；未把仓库测试用例当作答案。');
  L.push('');
  L.push('## 覆盖矩阵');
  L.push('');
  L.push('| 套件 | 覆盖面 | 用例 | 通过 | 失败 |');
  L.push('|---|---|---:|---:|---:|');
  for (const s of suites) {
    L.push(`| \`${s.id}\` | ${cell(s.title)} | ${s.total} | ${s.passed} | ${s.failed} |`);
  }
  L.push(`| **合计** | | **${meta.totals.total}** | **${meta.totals.passed}** | **${meta.totals.failed}** |`);
  L.push('');

  if (failures.length) {
    L.push('## 失败明细');
    L.push('');
    for (const f of failures) {
      const c = suites.flatMap((s) => s.cases).find((x) => x.id === f.id);
      L.push(`### \`${f.id}\``);
      L.push('');
      L.push(`- 目的：${c?.purpose ?? ''}`);
      L.push(`- 输入：${c?.input ?? '（见用例实现）'}`);
      L.push(`- 期望：${c?.expected ?? ''}`);
      for (const chk of f.failedChecks) {
        L.push(`- 失败检查 \`${chk.name}\`：期望 \`${chk.expected}\`，实际 \`${chk.actual}\``);
      }
      if (f.repro) L.push(`- 最小复现：\n\n\`\`\`bash\n${f.repro}\n\`\`\``);
      const cmd = firstFailingCommand(c);
      if (cmd) {
        L.push(`- 回执片段（exit ${cmd.code}）：\n\n\`\`\`json\n${(cmd.stdout || cmd.stderr || '').slice(0, 1200)}\n\`\`\``);
      }
      if (c?.error) L.push(`- 异常：\n\n\`\`\`\n${String(c.error).slice(0, 800)}\n\`\`\``);
      L.push('');
    }
  } else {
    L.push('## 失败明细');
    L.push('');
    L.push('无。所有用例的独立 oracle 与磁盘字节一致。');
    L.push('');
  }

  L.push('## 随机差分');
  L.push('');
  if (fuzzCase) {
    L.push(`- 固定 seed：**${seed}**（mulberry32；报告与 \`results.json\` 都记录该 seed，重跑同 seed 得到同一批用例）。`);
    L.push(`- 用例数：${fuzz.total}；通过 ${fuzz.passed}，失败 ${fuzz.failed}。`);
    L.push('- 生成规则：每例随机行数 3–10、随机 BOM、随机行尾风格（全 LF / 全 CRLF / 混合）、随机有无尾换行；随机选一行做整行替换（`lines` 地址），或向随机行内插入一个**全文件唯一** token 再用 `old` 替换；替换文本可含 CJK/emoji，但不含换行（避免 eol 适配带来的歧义）。');
    L.push('- oracle：自行切分字节 → 替换目标行内容（保留该行原有行尾与 BOM）重新拼字节；`old` 变体用 `Buffer.indexOf` 做唯一子串字节拼接。');
    L.push('- 断言：进程 exit 0、回执 `ok:true`、磁盘字节与 oracle **逐字节相等**；行尾结构不变由字节相等隐式覆盖。');
    if (fuzz.failed) {
      L.push(`- 失败 id：${fuzz.cases.filter((c) => !c.pass).map((c) => '`' + c.id + '`').join('、')}`);
    }
  } else {
    L.push('随机差分未运行。');
  }
  L.push('');

  L.push('## 基线对照（自己写的朴素实现，非原生工具）');
  L.push('');
  L.push('基线标签：**' + '`whole-file readFileSync(utf8)` + 精确字符串替换 + `writeFileSync(utf8)`' + '**（本测评编写；不代表 DSH 内置 `dsh-tool-fs`，也不代表 ZCode/Cursor 等任何客户端）。');
  L.push('');
  if (baselineCases.length) {
    L.push('| 场景 | 朴素基线结果 | aura 结果 | 是否一致 | 结论 |');
    L.push('|---|---|---|---|---|');
    for (const c of baselineCases) {
      const d = c.data ?? {};
      L.push(
        `| ${cell(d.scenario ?? c.purpose)} | ${cell(d.baselineText ?? '')} | ${cell(d.auraText ?? '')} | ${d.same ? '一致' : '**不一致**'} | ${cell(d.note ?? '')} |`,
      );
    }
    L.push('');
    L.push(`基线组用例：${baseline.total}，通过 ${baseline.passed}，失败 ${baseline.failed}。这里「通过」指**该用例自身的断言成立**（多数断言是「基线在某方面确实会破坏字节 / aura 不会」），不是「两者一致」。`);
  } else {
    L.push('基线对照未运行。');
  }
  L.push('');
  if (consistency) {
    L.push('## MCP 与 CLI 一致性');
    L.push('');
    L.push(`同一份初始文件、同一处编辑，分别经 MCP \`tools/call\` 与 CLI 执行，磁盘结果字节比较：${consistency.same ? '**一致**' : '**不一致**'}。`);
    L.push('');
    L.push(`- CLI 结果：\`${cell(consistency.cliHex)}\``);
    L.push(`- MCP 结果：\`${cell(consistency.mcpHex)}\``);
    L.push('');
  }

  L.push('## 值得注意的观察（非失败，均为已测行为）');
  L.push('');
  L.push('| 观察 | 证据用例 | 对调用方的含义 |');
  L.push('|---|---|---|');
  L.push('| `old` 是**片段地址**：外部改了同一行但片段仍在时，编辑按片段命中继续，不做区域拒绝；回执 `after` 回填整行且标 `unverified_region: true` | `stale/old-fragment-still-matches` | 想按整行语义拒绝陈旧写，请用 `lines` / `handle`，不要用 `old` 片段 |');
  L.push('| `read --mode search` 无命中返回结构化 `READ_NOT_FOUND`（exit 2），不是 `matches: 0` 的 ok 回执 | `read/search-zero-hits` | 不要把 search 的失败当“文件里没有”；要看 `code` |');
  L.push('| 默认编辑允许未读（回执 `unverified_region: true`）；严格新鲜度需显式 `--require-observation`，整份覆写则默认严格 | `stale/no-read-allowed-but-marked`、`stale/require-observation-refused`、`stale/write-overwrite-never-read` | 不读就改会被放行但被标记；要“读后写”保证必须显式开闸 |');
  L.push('| `--eol lf` 只把**替换文本内部**的换行写成 LF，被寻址区域自身的行尾仍原样保留（结果文件可能因此是混合行尾） | `edit/eol-lf-forced` | `--eol` 不是“整文件行尾转换器” |');
  L.push('| `--tx` 的编辑在 `tx commit` 之前就已经落盘；commit 负责校验/三方合并/收口，`tx rollback` 才把字节恢复 | `tx/commit-happy`、`tx/rollback-restores-bytes` | 不要把事务当“延迟写入”；不要用它做未提交预演（用 `--dry-run`） |');
  L.push('');
  L.push('## 局限与未验证');
  L.push('');
  L.push('以下各项**未验证**，不宣称通过：');
  L.push('');
  L.push('- **并发写竞争**：只验证了「单写者 + 外部非重叠/重叠改动 + 三方合并」，没有用两个进程同时写同一文件去压锁；竞态窗口是否为零未测。');
  L.push('- **handle 寻址的完整面**：只覆盖 3 条（整段替换 / 区间内第 k 行 / 句柄失效拒绝）；`position: before|after` 边界插入、跨文件的句柄混用、>256 KiB 文件的句柄未验证。');
  L.push('- **大文件**：未覆盖 >256 KiB 的「仅令牌」观测分支与 512 MiB 文本上限。');
  L.push('- **POSIX 专属行为**：符号链接写穿、硬链接拒绝、文件 mode 保留在 Windows 上无法验证。');
  L.push('- **git 不可用分支**：`tx commit` 的三方合并依赖 `git merge-file`；「Git 不可用 ⇒ TX_CONFLICT」未验证（本机有 Git）。');
  L.push('- **真实 MCP 宿主**：只验证协议帧与工具行为，未接入 Codex/Cursor/DSH 做客户端兼容性验证。');
  L.push('- **编码转换/二进制编辑**：按公开边界不在范围内，仅验证「非法 UTF-8 给结构化拒绝」。');
  L.push('');

  L.push('## 最重要的 3 个结论');
  L.push('');
  const c1 = bytes.failed === 0 && fuzz.failed === 0;
  L.push(
    `1. **字节保真可复核地成立**：${bytes.passed}/${bytes.total} 条字节用例（BOM、CRLF、混合行尾、无尾换行、CJK/emoji、空文件、BOM-only、\`eol auto\` / \`eol preserve\`、整份写）与 ${fuzz.passed}/${fuzz.total} 条固定 seed 随机差分，磁盘字节与独立 oracle 逐字节相等${c1 ? '' : '——**但有失败，见失败明细**'}。行尾与 BOM 是被测试覆盖的事实，不是回执里的自述。`,
  );
  const c2 = safety.failed === 0;
  L.push(
    `2. **安全语义是行为而非文档**：陈旧闸（读后外部改被寻址区域 ⇒ 拒绝且磁盘字节不变，改其它位置则正常合并）、多目标「一个失败则零写入」、跨调用事务（commit/rollback/verify 失败回滚/非重叠外部改动三方合并/重叠 \`TX_CONFLICT\` 零写入）共 ${safety.passed}/${safety.total} 条用例${c2 ? '全部按公开承诺表现' : '，**存在与公开承诺不符的失败**'}。`,
  );
  const diverged = baselineCases.filter((c) => c.data && c.data.same === false).length;
  L.push(
    `3. **朴素基线的差异是真实且可定位的，但不是「处处更强」**：${baseline.total} 组对照中 ${diverged} 组出现字节差异；对「整文件读 + 精确字符串替换 + 整文件写」这种朴素做法，BOM/CRLF/无尾换行在**单行 ASCII 替换**下并不会被破坏（Node 的字符串往返本身就保这些字节）——差异出现在按行切分再 \`join('\\n')\`、替换文本含换行、以及缺少陈旧闸/多目标原子性时。MCP 与 CLI 的结果${consistency ? (consistency.same ? '字节一致' : '**不一致**') : '未比较'}。因此「aura 更强」的正确表述是：**它在这些破坏性写法上给了结构化的替代路径**，而不是「任何朴素写法都会坏」。`,
  );
  L.push('');

  if (meta.totals.failed) {
    L.push('## 失败 id 清单');
    L.push('');
    for (const f of failures) L.push(`- \`${f.id}\`（${f.suite}）`);
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('复跑：`node eval/independent/run.mjs`（首次会自动从 registry.npmjs.org 安装被测包到 `eval/independent/.vendor`）。机器可读结果见 `results.json`。');
  L.push('');
  return L.join('\n');
}
